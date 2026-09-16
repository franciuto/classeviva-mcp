/**
 * ClasseViva MCP server on Cloudflare Workers.
 *
 * Cloudflare Access (OIDC) provides identity; `ALLOWED_EMAILS` decides who gets in;
 * the ClasseViva credentials are Worker secrets the caller never sees.
 *
 * OAuth rather than a static token because the custom-connector UI on claude.ai,
 * Desktop, Cowork and mobile takes OAuth only — a bearer token would restrict this
 * server to Claude Code.
 *
 * The gate is enforced in two places: `access-handler` refuses to issue a token to
 * an identity outside the allowlist, and `buildServer` registers zero tools if a
 * token somehow arrives for one anyway.
 */

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { Hono } from "hono";
import { handleAccessRequest } from "./access-handler";
import { registerAttachmentRoute } from "./attachments";
import { buildServer } from "./server";
import type { Props } from "./workers-oauth-utils";

/**
 * `McpRequestContext` carries neither `env` nor the props, so the handler is built
 * per request around a closure. OAuthProvider puts the decrypted grant props on
 * `ctx.props` of the ExecutionContext it hands to the API handler.
 */
/**
 * The MCP endpoint's path. Configurable via the `MCP_ROUTE` var so a fork can
 * rename it; falls back to `/classeviva` when unset.
 *
 * OAuthProvider matches `apiHandlers` keys with `startsWith`, not an exact
 * comparison, so anything under this prefix is swallowed by the MCP handler and
 * put behind the OAuth token. That is why `/attachment/...` stays at the root:
 * moving it under this prefix would break browser links, which carry an HMAC
 * signature rather than a token.
 */
function resolveMcpRoute(env: Env): string {
	return env.MCP_ROUTE || "/classeviva";
}

function buildMcpApiHandler(route: string) {
	return {
		fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
			const origin = new URL(request.url).origin;
			const handler = createMcpHandler(() => buildServer(env, origin, ctx.props), {
				route,
				// Host-header validation. localhost and *.workers.dev are allowed by
				// default, so a fresh deploy needs no configuration; a custom domain is
				// not, and must be named in PUBLIC_HOSTNAME or every request is rejected.
				// Left undefined when the var is unset, so the defaults still apply.
				allowedHostnames: env.PUBLIC_HOSTNAME
					? [env.PUBLIC_HOSTNAME, "localhost", "127.0.0.1"]
					: undefined,
			});
			return handler(request, env, ctx);
		},
	};
}

/**
 * Everything that is not the MCP route: the OAuth endpoints, plus the attachment
 * proxy. Built once at module scope because, unlike the MCP handler below,
 * nothing here needs `env` at construction time — `registerAttachmentRoute` and
 * `handleAccessRequest` both read `c.env` per request already.
 *
 * Attachments sit here rather than behind the OAuth token because a browser
 * following a link sends no Authorization header. They carry their own proof — an
 * HMAC over the path with an expiry, minted by an authenticated tool call.
 */
const app = new Hono<{ Bindings: Env }>();
registerAttachmentRoute(app);
app.all("*", (c) =>
	handleAccessRequest(c.req.raw, c.env as never, c.executionCtx as ExecutionContext),
);

/**
 * `OAuthProvider` needs the resolved MCP route at construction time, but Workers
 * gives no `env` at module scope — so, unlike when the route was a literal
 * constant, it cannot be built once here.
 *
 * Building it fresh per request is fine: the constructor
 * (`@cloudflare/workers-oauth-provider`) only validates its options
 * synchronously and does no I/O — the same reasoning that already has
 * `buildServer`/`attachments.ts` build a fresh `ClasseVivaClient` per request
 * instead of caching one at module scope.
 */
export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const route = resolveMcpRoute(env);
		const provider = new OAuthProvider({
			apiHandlers: {
				[route]: buildMcpApiHandler(route) as never,
			},
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			defaultHandler: app as never,
		});
		return provider.fetch(request, env, ctx);
	},
};

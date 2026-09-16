/**
 * Secrets are not declared in `wrangler.jsonc`, so `wrangler types` cannot see
 * them. Declaring them here keeps the env types honest without depending on
 * whatever happens to sit in a local `.env`/`.dev.vars` when types were generated.
 *
 * Both shapes need augmenting: `import { env } from "cloudflare:workers"` yields
 * `Cloudflare.Env`, while a handler's `c.env` yields the global `Env`.
 */

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

interface Secrets {
	/** Cloudflare Access for SaaS (OIDC) application. */
	ACCESS_CLIENT_ID: string;
	ACCESS_CLIENT_SECRET: string;
	ACCESS_AUTHORIZATION_URL: string;
	ACCESS_TOKEN_URL: string;
	ACCESS_JWKS_URL: string;
	/** Encrypts approval cookies and OAuth state. */
	COOKIE_ENCRYPTION_KEY: string;
	/** Signs attachment links so a browser can fetch a file without a token. */
	LINK_SIGNING_KEY: string;
	/** ClasseViva login. Declared here too so types never depend on a local file. */
	CLASSEVIVA_ID: string;
	CLASSEVIVA_PASSWORD: string;
}

/**
 * `wrangler types` emits each `vars` entry as a *literal* string type, and
 * omits the key entirely (not `string | undefined`) when it is absent from
 * `wrangler.jsonc`. Both vars here are meant to be optional with a runtime
 * fallback, so they are declared here as `?: string` too — this keeps
 * `env.MCP_ROUTE`/`env.PUBLIC_HOSTNAME` type-checking regardless of whether
 * `worker-configuration.d.ts` has been regenerated against the current
 * `wrangler.jsonc`, and regardless of whether the key is present at all (the
 * README instructs dropping `PUBLIC_HOSTNAME` for *.workers.dev deploys).
 */
interface Vars {
	/** MCP endpoint path. Optional — falls back to "/classeviva" when unset. */
	MCP_ROUTE?: string;
	/** Custom domain for Host-header validation. Optional — see README. */
	PUBLIC_HOSTNAME?: string;
}

declare global {
	interface Env extends Secrets, Vars {
		/** Injected by OAuthProvider into the default handler's bindings. */
		OAUTH_PROVIDER: OAuthHelpers;
	}

	namespace Cloudflare {
		interface Env extends Secrets, Vars {}
	}
}

export {};

/**
 * Attachment proxy with signed links.
 *
 * Notice attachments are real PDFs — the one sampled during design was 200 KB,
 * which is ~270 KB once base64-encoded. Returning them through MCP would dump that
 * into the model's context, so `noticeboard` returns links here instead and the
 * bytes stream straight to the browser.
 *
 * A browser following a link carries no Authorization header, so the route cannot sit
 * behind the MCP bearer token. Instead each link is HMAC-signed with an expiry by the
 * already-authenticated tool call, and the route verifies the signature. An
 * unsigned or stale URL gets nothing.
 */

import type { Hono } from "hono";
import { ClasseVivaClient, ClasseVivaError } from "./classeviva/client";
import { url } from "./classeviva/endpoints";

/**
 * Fetches an attachment, opening the notice first if ClasseViva insists.
 *
 * The API refuses to serve an attachment for a notice that has never been opened:
 * `404 … item must first be read`. That mirrors the web app, where you cannot get
 * at a file without opening the notice that carries it — so the only way to make
 * attachments work is to do the same.
 *
 * The consequence is real and worth stating: fetching an attachment marks its
 * notice as read on the register, and that cannot be undone. It does not sign
 * anything; `needSign` is a separate action this code never performs.
 */
async function fetchAttachment(
	client: ClasseVivaClient,
	evtCode: string,
	pubId: number,
	attachNum: number,
): Promise<Response> {
	// `attachNum` comes from `attachments[].attachNum`. The Python wrapper
	// hardcoded 101 here, which returns 404.
	const attach = (id: string) => url.noticeboardAttach(id, evtCode, pubId, attachNum);

	try {
		return await client.getRaw(attach);
	} catch (error) {
		const mustRead =
			error instanceof ClasseVivaError && /item must first be read/i.test(error.message);
		if (!mustRead) throw error;

		await client.post((id) => url.noticeboardRead(id, evtCode, pubId));
		return await client.getRaw(attach);
	}
}

type App = Hono<{ Bindings: Env }>;

/** How long an attachment link stays valid. Long enough to click, short enough to matter. */
const LINK_TTL_SECONDS = 60 * 60;

function base64url(bytes: ArrayBuffer): string {
	return btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

async function sign(secret: string, payload: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return base64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
}

/** Constant-time comparison, so a wrong signature leaks nothing through timing. */
function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export type AttachmentLinker = (
	evtCode: string,
	pubId: number,
	attachNum: number,
) => Promise<string>;

/** Builds the signer the noticeboard tool uses to mint links. */
export function createAttachmentLinker(secret: string, origin: string): AttachmentLinker {
	return async (evtCode, pubId, attachNum) => {
		const expires = Math.floor(Date.now() / 1000) + LINK_TTL_SECONDS;
		const path = `${evtCode}/${pubId}/${attachNum}`;
		const signature = await sign(secret, `${path}:${expires}`);
		return `${origin}/attachment/${path}?exp=${expires}&sig=${signature}`;
	};
}

export function registerAttachmentRoute(app: App): void {
	app.get("/attachment/:evtCode/:pubId/:attachNum", async (c) => {
		const { evtCode, pubId, attachNum } = c.req.param();
		const expires = Number(c.req.query("exp"));
		const signature = c.req.query("sig") ?? "";

		const pub = Number(pubId);
		const num = Number(attachNum);
		if (!Number.isInteger(pub) || !Number.isInteger(num) || !Number.isInteger(expires)) {
			return c.text("Malformed link", 400);
		}
		if (expires < Math.floor(Date.now() / 1000)) {
			return c.text("This attachment link has expired. Ask for the notice again.", 410);
		}

		const path = `${evtCode}/${pub}/${num}`;
		const expected = await sign(c.env.LINK_SIGNING_KEY, `${path}:${expires}`);
		if (!safeEqual(signature, expected)) {
			return c.text("Invalid link signature", 403);
		}

		const client = new ClasseVivaClient(c.env.CLASSEVIVA_ID, c.env.CLASSEVIVA_PASSWORD);

		try {
			const upstream = await fetchAttachment(client, evtCode, pub, num);

			const headers = new Headers();
			headers.set(
				"Content-Type",
				upstream.headers.get("content-type") ?? "application/octet-stream",
			);
			const disposition = upstream.headers.get("content-disposition");
			if (disposition) headers.set("Content-Disposition", disposition);
			// Personal school documents: never let a shared cache hold them.
			headers.set("Cache-Control", "private, no-store");

			return new Response(upstream.body, { status: 200, headers });
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			return c.text(`Could not fetch the attachment: ${message}`, 502);
		}
	});
}

/**
 * Turns an attachment into text the model can actually read.
 *
 * A signed link is the right answer when a human wants the file, but it is useless
 * when the question is "what does this notice say" — a model cannot read PDF bytes,
 * and shipping 200 KB of base64 into the context would be both unreadable and
 * ruinous. Workers AI `toMarkdown` extracts the text server-side, so what reaches
 * the model is a few KB of markdown instead.
 */
export type AttachmentReader = (
	evtCode: string,
	pubId: number,
	attachNum: number,
	fileName: string,
) => Promise<{ text: string; truncated: boolean; bytes: number }>;

/** Markdown longer than this is cut: a notice that big is not worth a context window. */
const MAX_MARKDOWN_CHARS = 20_000;

export function createAttachmentReader(env: Env): AttachmentReader {
	return async (evtCode, pubId, attachNum, fileName) => {
		const client = new ClasseVivaClient(env.CLASSEVIVA_ID, env.CLASSEVIVA_PASSWORD);
		const upstream = await fetchAttachment(client, evtCode, pubId, attachNum);
		const bytes = await upstream.arrayBuffer();

		const [result] = await env.AI.toMarkdown([
			{
				name: fileName || `${evtCode}-${pubId}-${attachNum}`,
				blob: new Blob([bytes], {
					type: upstream.headers.get("content-type") ?? "application/octet-stream",
				}),
			},
		]);

		// `toMarkdown` reports per-document failures in the result rather than throwing,
		// so an unconvertible file arrives here as a `format: "error"` entry.
		if (!result) {
			throw new Error("Workers AI returned no conversion result for this attachment");
		}
		if (result.format === "error") {
			throw new Error(`Could not convert this attachment to text: ${result.error}`);
		}

		const text = result.data ?? "";
		return {
			text: text.slice(0, MAX_MARKDOWN_CHARS),
			truncated: text.length > MAX_MARKDOWN_CHARS,
			bytes: bytes.byteLength,
		};
	};
}

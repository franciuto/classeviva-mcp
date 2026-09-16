/**
 * The access gate.
 *
 * Cloudflare Access proves *who* is knocking; this decides whether that person
 * gets in. `ALLOWED_EMAILS` is the only thing between a public URL and a student's
 * school register, so it lives in its own module and fails closed: an empty or
 * unset allowlist denies everyone rather than admitting every Access identity.
 *
 * Enforced twice — once in the OAuth callback, so an unauthorised identity never
 * receives a token, and once when building the server, so a token that somehow
 * exists still yields no tools.
 */

export function allowedEmails(env: Env): Set<string> {
	return new Set(
		(env.ALLOWED_EMAILS ?? "")
			.split(",")
			.map((e) => e.trim().toLowerCase())
			.filter(Boolean),
	);
}

export function isAllowed(env: Env, email: string | undefined): boolean {
	if (!email) return false;
	const allowed = allowedEmails(env);
	// A misconfigured deploy must fail closed, not turn into an open proxy.
	if (allowed.size === 0) return false;
	return allowed.has(email.toLowerCase());
}

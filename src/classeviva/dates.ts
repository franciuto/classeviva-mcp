/**
 * School-year date helpers.
 *
 * Every function here returns `YYYY-MM-DD`. The Python wrapper mixed the two
 * formats — its defaults produced `YYYYMMDD` and fed them to a validator that
 * required dashes, so calling `panoramica_da_a()` with no arguments always threw.
 * Conversion to the API's dashless form happens once, in `toApiDate`.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export function isoDate(d: Date): string {
	return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function today(): string {
	return isoDate(new Date());
}

/**
 * Calendar year the current school year started in: September or later means it
 * started this year, otherwise last year.
 */
export function schoolYearStartYear(now = new Date()): number {
	return now.getUTCMonth() + 1 >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

export function schoolYearStart(now = new Date()): string {
	return `${schoolYearStartYear(now)}-09-01`;
}

export function schoolYearEnd(now = new Date()): string {
	return `${schoolYearStartYear(now) + 1}-06-30`;
}

/** End of the school year, or today if the year is still running. */
export function schoolYearEndOrToday(now = new Date()): string {
	const end = schoolYearEnd(now);
	const nowIso = isoDate(now);
	return nowIso < end ? nowIso : end;
}

export function addDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return isoDate(d);
}

/**
 * Resolves an optional range to a concrete one.
 *
 * Unlike the Python wrapper, a missing bound is filled independently of the other,
 * so `{from: "2026-10-01"}` no longer silently collapses to the whole year.
 */
export function resolveRange(
	from: string | undefined,
	to: string | undefined,
	fallback: { from: string; to: string } = { from: schoolYearStart(), to: schoolYearEnd() },
): { from: string; to: string } {
	return { from: from ?? fallback.from, to: to ?? fallback.to };
}

/**
 * isoDate.ts — canonical, timezone-safe date-only handling.
 *
 * ONE representation for a calendar date: the ISO date-only string
 * `YYYY-MM-DD`. It is timezone-free by construction, sorts chronologically as
 * a plain string, and matches how the rest of the codebase already persists and
 * compares dates (`String(value).slice(0, 10)`, the `assessment_date` column,
 * `assertFinancialPeriodOpen`).
 *
 * Why this module exists (Phase 2 correctness):
 *  - Documents used to hand a *display* string (`en-GB` `DD/MM/YYYY`) from the
 *    builder to the renderer, which re-parsed it with `new Date()`. Under an
 *    en-GB browser that silently swapped day/month (1 Jun 2027 → `06/01/2027`),
 *    a value such as `30/04/2027` failed to parse and fell back to raw text,
 *    and the cross-month sort was lexicographic rather than chronological.
 *  - Full ISO instants were rendered in the LOCAL timezone, so an assessment
 *    stored as `2027-06-01T00:00:00Z` printed as `31/05/2027` west of UTC.
 *
 * Formatting therefore happens exactly once, at the render boundary, from the
 * canonical value — never by re-parsing a formatted string, and never by
 * substituting the current date for a missing or invalid one.
 */

/** Leading ISO calendar date of an ISO date or ISO instant string. */
const ISO_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;
/**
 * Legacy display format the schedule builder used to emit (`toDisplayDateOrEmpty`
 * → `Date#toLocaleDateString('en-GB')`). Day-first and unambiguous, so it can be
 * read back positionally instead of through the locale-dependent `Date` parser.
 */
const DISPLAY_DATE_DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
/**
 * Looks like an ISO date but is not the canonical zero-padded form
 * (`2027-6-1`, `2027-6-01`, `2027-06-1`). These are EXPLICITLY REJECTED rather
 * than handed to `Date`, whose lenient parser would accept them and then apply
 * local-timezone semantics to a string the user meant as a calendar date.
 */
const ISO_LIKE = /^\d{4}-\d/;

const MONTHS_SHORT = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

const daysInMonth = (year: number, month: number): number => {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
};

const isValidYmd = (year: number, month: number, day: number): boolean =>
  Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
  && month >= 1 && month <= 12
  && day >= 1 && day <= daysInMonth(year, month);

const pad2 = (value: number): string => String(value).padStart(2, '0');

const toYmd = (year: number, month: number, day: number): string =>
  `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;

/**
 * Canonicalise any stored date value to the ISO date-only string `YYYY-MM-DD`.
 *
 * - `YYYY-MM-DD` (or a full ISO instant, which shares the same leading date)
 *   is validated and returned as-is. The leading date is taken verbatim rather
 *   than converted through `Date`, so no local-timezone shift can occur.
 * - The legacy `DD/MM/YYYY` display string is read back positionally (the only
 *   format the schedule builder emitted), so historical rows stay correct.
 * - An unpadded ISO date (`2027-6-1`) is REJECTED (`undefined`): it is close
 *   enough to ISO to be a mistake, and reinterpreting it through `Date` would
 *   silently apply local-timezone semantics.
 * - Any other string is rejected (`undefined`) rather than passed to the
 *   timezone-sensitive `Date` parser.
 * - Missing, blank and impossible values (`2026-02-30`) return `undefined` —
 *   they are never replaced with today's date.
 */
export function toIsoDateOnly(value?: unknown): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) return undefined;

  const iso = ISO_DATE_PREFIX.exec(raw);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return isValidYmd(year, month, day) ? toYmd(year, month, day) : undefined;
  }

  const dmy = DISPLAY_DATE_DMY.exec(raw);
  if (dmy) {
    const [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    return isValidYmd(year, month, day) ? toYmd(year, month, day) : undefined;
  }

  // Anything ISO-shaped but not the canonical padded form is a malformed date,
  // not a different notation: refuse it instead of guessing through `Date`.
  if (ISO_LIKE.test(raw)) return undefined;

  // No timezone-sensitive fallback: an unrecognised format is left uncanonical
  // (the caller renders it verbatim) rather than shifted by the local zone.
  return undefined;
}

/** Canonical ISO date-only, or `''` — never the current date. */
export const toIsoDateOnlyOrEmpty = (value?: unknown): string => toIsoDateOnly(value) ?? '';

/**
 * Render a stored date value for print/display as `DD MMM YYYY`
 * (e.g. `01 Jun 2027`). Locale-independent and timezone-safe.
 *
 * A blank value renders as `''`; a value that cannot be canonicalised is
 * returned verbatim so nothing is silently hidden or substituted.
 */
export function formatIsoDate(value?: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const iso = toIsoDateOnly(raw);
  if (!iso) return raw;
  const [year, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS_SHORT[Number(month) - 1]} ${year}`;
}

/** Short `DD MMM` label (no year) — for compact same-year ranges. */
export function formatIsoDateShort(value?: unknown): string {
  const iso = toIsoDateOnly(value);
  if (!iso) return formatIsoDate(value);
  const [, month, day] = iso.split('-');
  return `${Number(day)} ${MONTHS_SHORT[Number(month) - 1]}`;
}

/**
 * Chronological comparison of two optional ISO date-only values.
 * Undated values always sort last; ties fall back to `tieBreak` (name).
 */
export function compareIsoDateOnly(a?: unknown, b?: unknown, tieBreak?: () => number): number {
  const left = toIsoDateOnly(a);
  const right = toIsoDateOnly(b);
  if (left === right) return tieBreak ? tieBreak() : 0;
  if (!left) return 1;
  if (!right) return -1;
  // `YYYY-MM-DD` compares lexicographically in true chronological order.
  return left < right ? -1 : 1;
}

/** True when `date` falls inside `[start, end]` (both optional, inclusive). */
export function isIsoDateWithin(
  date?: unknown,
  start?: unknown,
  end?: unknown,
): boolean | undefined {
  const target = toIsoDateOnly(date);
  if (!target) return undefined;
  const from = toIsoDateOnly(start);
  const to = toIsoDateOnly(end);
  if (!from && !to) return undefined;
  if (from && target < from) return false;
  if (to && target > to) return false;
  return true;
}

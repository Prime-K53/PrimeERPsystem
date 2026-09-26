/**
 * dateScope.ts — Natural-language date understanding for the Copilot query layer.
 *
 * Reuses date-fns (the ERP's existing date utility) and the ERP's existing
 * timezone convention (company local time; companyConfig.timezone defaults to
 * Africa/Blantyre for display). No parallel timezone implementation.
 *
 * Supported phrases: today, yesterday, this week, last week, this month,
 * last month, this year, last year, this quarter, last quarter, since
 * <month>, between <date> and <date>, from <date> to <date>, named months
 * ("invoices from September", "September 1 to September 20"), last N
 * days/weeks/months.
 */

import {
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
  subDays,
  subWeeks,
  subMonths,
  subQuarters,
  subYears,
} from 'date-fns';
import { ErpQueryError, type DateScope } from './erpQueryTypes';

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

function iso(d: Date): string {
  return d.toISOString();
}

function scope(start: Date | null, end: Date | null, label: string, dateField: string): DateScope {
  return {
    start: start ? iso(startOfDaySafe(start)) : null,
    end: end ? iso(endOfDaySafe(end)) : null,
    label,
    dateField,
  };
}

function startOfDaySafe(d: Date): Date {
  return startOfDay(d);
}
function endOfDaySafe(d: Date): Date {
  return endOfDay(d);
}

function namedMonthRange(monthName: string, year: number, dateField: string): DateScope {
  const m = MONTHS[monthName.toLowerCase()];
  if (m === undefined) throw new ErpQueryError('invalid_date_range', `Unknown month "${monthName}".`);
  const start = new Date(year, m, 1);
  return scope(start, endOfMonth(start), `${capitalize(monthName)} ${year}`, dateField);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Parse "September 1", "Sep 1", "1 September", "2026-09-05", "09/05/2026" best-effort. */
export function parseLooseDate(text: string, fallbackYear: number): Date | null {
  const t = text.trim();
  // ISO first
  const isoTry = new Date(t);
  if (!Number.isNaN(isoTry.getTime()) && /\d{4}-\d{2}-\d{2}/.test(t)) return isoTry;
  // "September 20" / "Sep 20" / "September 1, 2026"
  const m1 = t.match(/([a-zA-Z]+)\s+(\d{1,2})(?:\s*,?\s*(\d{4}))?/);
  if (m1) {
    const month = MONTHS[m1[1].toLowerCase()];
    if (month !== undefined) {
      const day = parseInt(m1[2], 10);
      const year = m1[3] ? parseInt(m1[3], 10) : fallbackYear;
      const d = new Date(year, month, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  // "20 September" / "20 September 2026"
  const m2 = t.match(/(\d{1,2})\s+([a-zA-Z]+)(?:\s+(\d{4}))?/);
  if (m2) {
    const month = MONTHS[m2[2].toLowerCase()];
    if (month !== undefined) {
      const day = parseInt(m2[1], 10);
      const year = m2[3] ? parseInt(m2[3], 10) : fallbackYear;
      const d = new Date(year, month, day);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  // MM/DD/YYYY or DD/MM/YYYY with 4-digit year — interpret via Date as last resort
  const m3 = t.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (m3) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * Resolve natural-language date phrases in `question` to an absolute DateScope.
 * Returns null when the question carries no date constraint.
 * Throws ErpQueryError('invalid_date_range') for unparseable explicit ranges.
 */
export function resolveDateScope(question: string, dateField: string, now = new Date()): DateScope | null {
  const lower = question.toLowerCase();
  const year = now.getFullYear();

  // Explicit ranges first: "between X and Y", "from X to Y", "X to Y" with dates
  const betweenMatch = lower.match(/between\s+(.+?)\s+and\s+(.+?)(?:[?.,;]|$)/);
  if (betweenMatch) {
    const a = parseLooseDate(betweenMatch[1], year);
    const b = parseLooseDate(betweenMatch[2], year);
    if (!a || !b) throw new ErpQueryError('invalid_date_range', `Could not parse the date range "${betweenMatch[0].trim()}". Try "from September 1 to September 20".`);
    const [s, e] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
    return scope(s, e, `${s.toLocaleDateString()} to ${e.toLocaleDateString()}`, dateField);
  }
  const fromToMatch = lower.match(/from\s+(.+?)\s+to\s+(.+?)(?:[?.,;]|$)/);
  if (fromToMatch) {
    const a = parseLooseDate(fromToMatch[1], year);
    const b = parseLooseDate(fromToMatch[2], year);
    if (!a || !b) throw new ErpQueryError('invalid_date_range', `Could not parse the date range "${fromToMatch[0].trim()}".`);
    const [s, e] = a.getTime() <= b.getTime() ? [a, b] : [b, a];
    return scope(s, e, `${s.toLocaleDateString()} to ${e.toLocaleDateString()}`, dateField);
  }

  // "since January" / "since March 2026"
  const sinceMatch = lower.match(/since\s+([a-zA-Z]+)(?:\s+(\d{4}))?/);
  if (sinceMatch && MONTHS[sinceMatch[1].toLowerCase()] !== undefined) {
    const m = MONTHS[sinceMatch[1].toLowerCase()];
    const y = sinceMatch[2] ? parseInt(sinceMatch[2], 10) : year;
    const start = new Date(y, m, 1);
    return scope(start, now, `since ${capitalize(sinceMatch[1])}${sinceMatch[2] ? ` ${y}` : ''}`, dateField);
  }

  // "last N days/weeks/months/years"
  const lastN = lower.match(/last\s+(\d+)\s+(days?|weeks?|months?|years?|quarters?)/);
  if (lastN) {
    const n = Math.max(1, Math.min(60, parseInt(lastN[1], 10)));
    const unit = lastN[2];
    let start: Date;
    if (unit.startsWith('day')) start = subDays(now, n);
    else if (unit.startsWith('week')) start = subWeeks(now, n);
    else if (unit.startsWith('quarter')) start = subQuarters(now, n);
    else if (unit.startsWith('year')) start = subYears(now, n);
    else start = subMonths(now, n);
    return scope(start, now, `last ${n} ${unit}`, dateField);
  }

  if (/\byesterday\b/.test(lower)) {
    const d = subDays(now, 1);
    return scope(d, d, 'yesterday', dateField);
  }
  if (/\btoday\b/.test(lower)) {
    return scope(now, now, 'today', dateField);
  }
  if (/last\s+week/.test(lower)) {
    const ref = subWeeks(now, 1);
    return scope(startOfWeek(ref, { weekStartsOn: 1 }), endOfWeek(ref, { weekStartsOn: 1 }), 'last week', dateField);
  }
  if (/this\s+week/.test(lower)) {
    return scope(startOfWeek(now, { weekStartsOn: 1 }), endOfWeek(now, { weekStartsOn: 1 }), 'this week', dateField);
  }
  if (/last\s+month/.test(lower)) {
    const ref = subMonths(now, 1);
    return scope(startOfMonth(ref), endOfMonth(ref), 'last month', dateField);
  }
  if (/this\s+month/.test(lower)) {
    return scope(startOfMonth(now), endOfMonth(now), 'this month', dateField);
  }
  if (/last\s+quarter/.test(lower)) {
    const ref = subQuarters(now, 1);
    return scope(startOfQuarter(ref), endOfQuarter(ref), 'last quarter', dateField);
  }
  if (/this\s+quarter/.test(lower)) {
    return scope(startOfQuarter(now), endOfQuarter(now), 'this quarter', dateField);
  }
  if (/last\s+year/.test(lower)) {
    const ref = subYears(now, 1);
    return scope(startOfYear(ref), endOfYear(ref), 'last year', dateField);
  }
  if (/this\s+year/.test(lower)) {
    return scope(startOfYear(now), endOfYear(now), 'this year', dateField);
  }

  // Named month: "invoices from September", "show September sales", "September 2026"
  const monthMatch = lower.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b(?:\s+(\d{4}))?/);
  if (monthMatch && /(from|in|during|for)\s+[a-z]{3,9}|[a-z]{3,9}\s+sales|[a-z]{3,9}\s+invoices|[a-z]{3,9}\s+payments|[a-z]{3,9}\s+orders|in\s+[a-z]{3,9}/.test(lower)) {
    const y = monthMatch[2] ? parseInt(monthMatch[2], 10) : year;
    return namedMonthRange(monthMatch[1], y, dateField);
  }

  return null;
}

/** Build the previous-period counterpart for `compare` operations. */
export function previousPeriod(current: DateScope, dateField: string): DateScope {
  if (!current.start || !current.end) {
    throw new ErpQueryError('invalid_date_range', 'Cannot compare open-ended periods. Ask about "this month vs last month" with a bounded period.');
  }
  const s = new Date(current.start).getTime();
  const e = new Date(current.end).getTime();
  const lengthMs = e - s;
  const prevEnd = new Date(s - 1);
  const prevStart = new Date(prevEnd.getTime() - lengthMs);
  return {
    start: iso(startOfDaySafe(prevStart)),
    end: iso(endOfDaySafe(prevEnd)),
    label: `previous period (${prevStart.toLocaleDateString()} to ${prevEnd.toLocaleDateString()})`,
    dateField,
  };
}

/** True when ISO date `value` falls inside `scopeRange` (inclusive). */
export function isInScope(value: unknown, scopeRange: DateScope | null): boolean {
  if (!scopeRange) return true;
  if (value === null || value === undefined || value === '') return false;
  const t = new Date(String(value)).getTime();
  if (Number.isNaN(t)) return false;
  if (scopeRange.start && t < new Date(scopeRange.start).getTime()) return false;
  if (scopeRange.end && t > new Date(scopeRange.end).getTime()) return false;
  return true;
}

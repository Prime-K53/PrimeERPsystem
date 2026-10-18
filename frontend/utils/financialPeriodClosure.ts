/**
 * Financial-period closure.
 *
 * A closed financial period is a date range (inclusive) within
 * which financial events may no longer be created. Contract
 * creation, activation, assessment scheduling, assessment
 * consumption and amendment approval all refuse to start when
 * their effective date falls inside a closed period.
 *
 * Storage: the `settings` store (IndexedDB, mirrored to
 * localStorage) under a single key, so the closure list
 * persists across sessions and syncs with the rest of the
 * company data. There is no separate financial subsystem —
 * this is a guard over the existing contract operations.
 *
 * Periods are stored as a plain array; the guard is a pure
 * date-range check so it stays deterministic and testable.
 */

import { dbService } from '../services/db';

export interface ClosedFinancialPeriod {
  id: string;
  /** Inclusive start, ISO date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end, ISO date (YYYY-MM-DD). */
  to: string;
  reason?: string;
  closedAt: string;
  closedBy: string;
}

const SETTING_KEY = 'financial_closed_periods';

export const loadClosedPeriods = async (): Promise<ClosedFinancialPeriod[]> => {
  try {
    const raw = await dbService.getSetting<ClosedFinancialPeriod[]>(SETTING_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
};

export const saveClosedPeriods = async (
  periods: ClosedFinancialPeriod[],
): Promise<void> => {
  await dbService.saveSetting(SETTING_KEY, periods);
};

const toDateOnly = (iso: string | undefined): string =>
  String(iso || '').slice(0, 10);

/**
 * Pure check: which closed period (if any) covers `dateIso`?
 * String comparison on ISO dates is safe because YYYY-MM-DD
 * sorts chronologically.
 */
export const findClosedPeriodFor = (
  dateIso: string | undefined,
  periods: ClosedFinancialPeriod[] | null | undefined,
): ClosedFinancialPeriod | null => {
  const d = toDateOnly(dateIso);
  if (!d) return null;
  for (const p of periods || []) {
    const from = toDateOnly(p.from);
    const to = toDateOnly(p.to);
    if (from && to && d >= from && d <= to) return p;
  }
  return null;
};

export const isFinancialPeriodClosed = async (
  dateIso: string | undefined,
): Promise<ClosedFinancialPeriod | null> => {
  const periods = await loadClosedPeriods();
  return findClosedPeriodFor(dateIso, periods);
};

/**
 * Fail-closed guard: throws when `dateIso` falls inside a
 * closed period. `action` is the human operation being
 * attempted, used verbatim in the error message.
 */
export const assertFinancialPeriodOpen = async (
  dateIso: string | undefined,
  action: string,
): Promise<void> => {
  const conflict = await isFinancialPeriodClosed(dateIso);
  assertFinancialPeriodOpenForPeriods(dateIso, action, conflict ? [conflict] : []);
};

export const assertFinancialPeriodOpenForPeriods = (
  dateIso: string | undefined,
  action: string,
  periods: ClosedFinancialPeriod[] | null | undefined,
): void => {
  const conflict = findClosedPeriodFor(dateIso, periods);
  if (conflict) {
    throw new Error(
      `Financial period ${toDateOnly(conflict.from)} → ${toDateOnly(conflict.to)} is closed${conflict.reason ? ` (${conflict.reason})` : ''}. ${action} is not permitted within a closed financial period.`,
    );
  }
};

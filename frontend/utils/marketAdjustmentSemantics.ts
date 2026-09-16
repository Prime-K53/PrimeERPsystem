import type { MarketAdjustment } from '../types';

/**
 * Canonical market-adjustment semantics (Phase 3 / B4+B5+B6).
 *
 * Single source of truth for:
 *  - type normalization: only 'PERCENTAGE' | 'FIXED' on write;
 *    'PERCENT'/'percentage' (any case) read as PERCENTAGE.
 *  - active checks: `active ?? is_active ?? isActive`, tolerant of
 *    boolean | 0/1 | "1"/"true"/"yes"/"on", missing flag => ACTIVE
 *    (matches DB default 1 and backend COALESCE(...,1)=1).
 *  - ordering: `sort_order ?? sortOrder ?? 0`, then name.
 *  - application: ADDITIVE on the original base, percentages as
 *    base*(pct/100), FIXED as a flat amount in the priced unit
 *    (per line / per class / per run — never silently multiplied
 *    by pages/learners; per-learner and per-page scalings live
 *    explicitly at their call sites, e.g. examinationJobService).
 */

export type CanonicalAdjustmentType = 'PERCENTAGE' | 'FIXED';

export const normalizeMarketAdjustmentType = (value: unknown): CanonicalAdjustmentType =>
  String(value ?? '').trim().toUpperCase() === 'FIXED' ? 'FIXED' : 'PERCENTAGE';

export const isPercentageAdjustment = (value: unknown): boolean =>
  normalizeMarketAdjustmentType(value) === 'PERCENTAGE';

type Flaggable = Partial<MarketAdjustment> & Record<string, unknown>;

const toBool = (value: unknown, defaultIfNull: boolean): boolean => {
  if (value === undefined || value === null || value === '') return defaultIfNull;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(s)) return false;
  return defaultIfNull;
};

export const isMarketAdjustmentActive = (adjustment: Flaggable | null | undefined): boolean => {
  // Matches the long-standing marketAdjustmentUtils contract: a missing
  // record/flag means ACTIVE (DB default 1, backend COALESCE(...,1)=1).
  if (adjustment === null || adjustment === undefined) return true;
  const raw =
    (adjustment as Flaggable).active ??
    (adjustment as Flaggable).is_active ??
    (adjustment as Flaggable).isActive;
  return toBool(raw, true);
};

export const getAdjustmentSortKey = (adjustment: Flaggable | null | undefined): number => {
  const raw =
    (adjustment as Flaggable)?.sort_order ?? (adjustment as Flaggable)?.sortOrder ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

export const sortMarketAdjustments = <T extends Flaggable>(list: T[]): T[] =>
  [...(list || [])].sort((a, b) => {
    const order = getAdjustmentSortKey(a) - getAdjustmentSortKey(b);
    if (order !== 0) return order;
    return String((a as Flaggable)?.name || '').localeCompare(String((b as Flaggable)?.name || ''));
  });

export const getAdjustmentPercent = (adjustment: Flaggable | null | undefined): number => {
  const n = Number(
    (adjustment as Flaggable)?.percentage ?? (adjustment as Flaggable)?.value ?? 0
  );
  return Number.isFinite(n) ? n : 0;
};

export const getAdjustmentFlatAmount = (adjustment: Flaggable | null | undefined): number => {
  const n = Number((adjustment as Flaggable)?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

export interface AppliedAdjustmentRow {
  id: string;
  name: string;
  type: CanonicalAdjustmentType;
  value: number;
  amount: number;
}

const round2 = (value: number): number =>
  Math.round((Number(value) + Number.EPSILON) * 100) / 100;

/**
 * Additive application: every percentage applies to the ORIGINAL base
 * (order-independent given sort), every FIXED adds its flat amount.
 */
export const applyAdjustmentsAdditive = (
  baseCost: number,
  adjustments: Flaggable[] = []
): { total: number; rows: AppliedAdjustmentRow[] } => {
  const safeBase = Number.isFinite(Number(baseCost)) ? Math.max(0, Number(baseCost)) : 0;
  const rows = sortMarketAdjustments((adjustments || []).filter(isMarketAdjustmentActive)).map(
    (adj, index) => {
      const type = normalizeMarketAdjustmentType((adj as Flaggable)?.type);
      const amount =
        type === 'FIXED'
          ? Math.max(0, getAdjustmentFlatAmount(adj))
          : Math.max(0, round2((safeBase * getAdjustmentPercent(adj)) / 100));
      return {
        id: String((adj as Flaggable)?.id || `adjustment-${index + 1}`),
        name: String(
          (adj as Flaggable)?.displayName ||
            (adj as Flaggable)?.display_name ||
            (adj as Flaggable)?.name ||
            `Adjustment ${index + 1}`
        ),
        type,
        value: type === 'FIXED' ? getAdjustmentFlatAmount(adj) : getAdjustmentPercent(adj),
        amount: round2(amount),
      };
    }
  );
  return { total: round2(rows.reduce((sum, row) => sum + row.amount, 0)), rows };
};

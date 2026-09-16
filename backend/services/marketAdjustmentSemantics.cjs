/**
 * marketAdjustmentSemantics.cjs (Phase 3 / B4+B5+B6)
 *
 * Backend mirror of frontend/utils/marketAdjustmentSemantics.ts.
 * Canonical rules:
 *  - type: only 'PERCENTAGE' | 'FIXED' on write; 'PERCENT'/any case reads as PERCENTAGE.
 *  - active: `active ?? is_active ?? isActive`, tolerant of boolean/0/1/strings,
 *    missing flag => ACTIVE (matches COALESCE(...,1)=1 and DB default 1).
 *  - order: `sort_order ?? sortOrder ?? 0`, then name.
 *  - application: ADDITIVE on the original base (order-independent);
 *    FIXED is a flat amount in the priced unit (never * pages/learners here —
 *    per-learner/per-page scalings live explicitly at their call sites).
 */

const normalizeMarketAdjustmentType = (value) =>
  String(value ?? '').trim().toUpperCase() === 'FIXED' ? 'FIXED' : 'PERCENTAGE';

const toBool = (value, defaultIfNull) => {
  if (value === undefined || value === null || value === '') return defaultIfNull;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 't', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'f', 'no', 'n', 'off'].includes(s)) return false;
  return defaultIfNull;
};

const isMarketAdjustmentActive = (adjustment) => {
  // Matches the long-standing frontend contract: a missing record/flag
  // means ACTIVE (DB default 1, COALESCE(...,1)=1).
  if (adjustment === null || adjustment === undefined) return true;
  const raw = adjustment.active ?? adjustment.is_active ?? adjustment.isActive;
  return toBool(raw, true);
};

const getAdjustmentSortKey = (adjustment) => {
  const raw = adjustment?.sort_order ?? adjustment?.sortOrder ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
};

const sortMarketAdjustments = (list = []) =>
  [...(list || [])].sort((a, b) => {
    const order = getAdjustmentSortKey(a) - getAdjustmentSortKey(b);
    if (order !== 0) return order;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });

const getAdjustmentPercent = (adjustment) => {
  const n = Number(adjustment?.percentage ?? adjustment?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const getAdjustmentFlatAmount = (adjustment) => {
  const n = Number(adjustment?.value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const applyAdjustmentsAdditive = (baseCost, adjustments = []) => {
  const safeBase = Number.isFinite(Number(baseCost)) ? Math.max(0, Number(baseCost)) : 0;
  const rows = sortMarketAdjustments((adjustments || []).filter(isMarketAdjustmentActive)).map(
    (adj, index) => {
      const type = normalizeMarketAdjustmentType(adj?.type);
      const amount =
        type === 'FIXED'
          ? Math.max(0, getAdjustmentFlatAmount(adj))
          : Math.max(0, round2((safeBase * getAdjustmentPercent(adj)) / 100));
      return {
        id: String(adj?.id || `adjustment-${index + 1}`),
        name: String(adj?.display_name || adj?.displayName || adj?.name || `Adjustment ${index + 1}`),
        type,
        value: type === 'FIXED' ? getAdjustmentFlatAmount(adj) : getAdjustmentPercent(adj),
        amount: round2(amount),
      };
    }
  );
  return { total: round2(rows.reduce((sum, row) => sum + row.amount, 0)), rows };
};

module.exports = {
  normalizeMarketAdjustmentType,
  isMarketAdjustmentActive,
  getAdjustmentSortKey,
  sortMarketAdjustments,
  getAdjustmentPercent,
  getAdjustmentFlatAmount,
  applyAdjustmentsAdditive,
};

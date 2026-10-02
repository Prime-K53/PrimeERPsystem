/**
 * transportBudgetPolicy.cjs — Phase 5A backend policy resolver.
 *
 * CJS port of frontend/utils/transportBudgetPolicy.ts (Phase 3 + 3A
 * semantics) so the backend producer resolves the SAME CompanyConfig
 * policy the SAME way without importing frontend TS (no build coupling).
 *
 * Validation + normalization + date-based resolution for the internal
 * Transport Budget allocation policy (`CompanyConfig.transportBudgetPolicy`).
 *
 * Frozen Phase 2 contract:
 *   allocationAmount = roundMoney(eligibleBase x allocationRatePercent / 100)
 *   0 <= allocationRatePercent <= 100, max 4 decimal places.
 *   0% (or a missing policy/rate) = valid disabled state.
 *   Negative / >100 / non-finite / NaN = invalid configuration.
 *   Invalid values fail validation — they are never silently clamped.
 *   Historical allocations are never recalculated when the rate changes.
 *
 * Phase 3A: the policy may carry scheduledChanges; resolution is purely
 * date-ordered over date-only (YYYY-MM-DD) strings — no timezone
 * conversion, no sync/replay/server timestamps.
 *
 * Pure configuration behavior ONLY. No allocation, no journals, no I/O.
 */

const TRANSPORT_BUDGET_RATE_MIN = 0;
const TRANSPORT_BUDGET_RATE_MAX = 100;
const TRANSPORT_BUDGET_RATE_MAX_DECIMALS = 4;

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value) {
  if (!DATE_ONLY_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * True when a finite number carries at most 4 decimal places.
 * Epsilon-tolerant so binary float dust (e.g. 2.755 stored as
 * 2.7549999999999999) is not mistaken for a 5th decimal place, while a
 * genuine 5-decimal value still fails. Never rounds, never clamps.
 */
function hasAllowedRatePrecision(rate) {
  if (!Number.isFinite(rate)) return false;
  const scaled = Math.abs(rate) * Math.pow(10, TRANSPORT_BUDGET_RATE_MAX_DECIMALS);
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function validateRate(rate, path, issues) {
  if (typeof rate !== 'number') {
    issues.push({ path, message: 'Allocation rate must be a number.' });
    return;
  }
  if (Number.isNaN(rate)) {
    issues.push({ path, message: 'Allocation rate must not be NaN.' });
    return;
  }
  if (!Number.isFinite(rate)) {
    issues.push({ path, message: 'Allocation rate must be finite.' });
    return;
  }
  if (rate < TRANSPORT_BUDGET_RATE_MIN) {
    issues.push({ path, message: 'Allocation rate must not be negative.' });
    return;
  }
  if (rate > TRANSPORT_BUDGET_RATE_MAX) {
    issues.push({ path, message: 'Allocation rate must not exceed 100.' });
    return;
  }
  if (!hasAllowedRatePrecision(rate)) {
    issues.push({
      path,
      message: 'Allocation rate must have at most 4 decimal places.',
    });
  }
}

function validateEffectiveFrom(value, issues) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    issues.push({
      path: 'transportBudgetPolicy.effectiveFrom',
      message: 'Effective date must be a calendar date in YYYY-MM-DD format.',
    });
  }
}

/**
 * Validate the scheduled-changes list. Each entry needs its own valid rate
 * and a required valid date; duplicate effective dates — against each other
 * or against the base policy date — are rejected rather than silently
 * ordered (resolution must never depend on array position).
 */
function validateScheduledChanges(value, baseEffectiveFrom, issues) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({
      path: 'transportBudgetPolicy.scheduledChanges',
      message: 'Scheduled changes must be a list.',
    });
    return;
  }
  const seen = new Set();
  const duplicates = new Set();
  if (typeof baseEffectiveFrom === 'string' && baseEffectiveFrom !== '') {
    seen.add(baseEffectiveFrom);
  }
  value.forEach((entry, index) => {
    const base = `transportBudgetPolicy.scheduledChanges.${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ path: base, message: 'Scheduled change must be an object.' });
      return;
    }
    validateRate(entry.allocationRatePercent, `${base}.allocationRatePercent`, issues);
    if (typeof entry.effectiveFrom !== 'string' || !isCalendarDate(entry.effectiveFrom)) {
      issues.push({
        path: `${base}.effectiveFrom`,
        message: 'Scheduled change requires a calendar date in YYYY-MM-DD format.',
      });
    } else {
      if (seen.has(entry.effectiveFrom)) duplicates.add(entry.effectiveFrom);
      seen.add(entry.effectiveFrom);
    }
  });
  for (const date of duplicates) {
    issues.push({
      path: 'transportBudgetPolicy.scheduledChanges',
      message: `Duplicate scheduled effective date: ${date}. Keep one entry per date.`,
    });
  }
}

/**
 * Validate a transport budget policy value. `undefined` (absent policy) is
 * valid — it means allocation is disabled. Never coerces or clamps.
 */
function validateTransportBudgetPolicy(policy) {
  if (policy === undefined) return { valid: true, errors: [] };
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return {
      valid: false,
      errors: [
        {
          path: 'transportBudgetPolicy',
          message: 'Transport budget policy must be an object.',
        },
      ],
    };
  }
  const errors = [];
  validateRate(
    policy.allocationRatePercent,
    'transportBudgetPolicy.allocationRatePercent',
    errors,
  );
  validateEffectiveFrom(policy.effectiveFrom, errors);
  validateScheduledChanges(policy.scheduledChanges, policy.effectiveFrom, errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Tri-state reader: distinguishes valid-disabled, valid-enabled, invalid,
 * and missing so the producer can tell "disabled" apart from
 * "misconfigured". Reflects the base policy only (no business date);
 * date-based resolution uses resolveTransportBudgetRate below.
 */
function getTransportBudgetPolicyState(config) {
  const policy = config ? config.transportBudgetPolicy : undefined;
  if (policy === undefined) return 'missing';
  const result = validateTransportBudgetPolicy(policy);
  if (!result.valid) return 'invalid';
  return policy.allocationRatePercent === 0 ? 'disabled' : 'enabled';
}

/**
 * Pure configuration resolution: for a document with business date D
 * (date-only YYYY-MM-DD), return the latest policy entry — base policy plus
 * scheduled changes — whose effective date is <= D. A base policy with no
 * effectiveFrom is immediately effective (applies to every D).
 *
 * Matches frontend resolveTransportBudgetRate exactly:
 *   missing policy -> { status: 'missing' }
 *   invalid policy or invalid businessDate -> { status: 'invalid' }
 *   winner rate 0 -> { status: 'disabled', rate: 0, ... }
 *   otherwise -> { status: 'enabled', rate, ... }
 *
 * Never mutates configuration, creates no events, posts no accounting,
 * and performs no I/O.
 */
function resolveTransportBudgetRate(policy, businessDate) {
  if (typeof businessDate !== 'string' || !isCalendarDate(businessDate)) {
    return { status: 'invalid' };
  }
  if (policy === undefined) return { status: 'missing' };
  if (validateTransportBudgetPolicy(policy).valid === false) {
    return { status: 'invalid' };
  }
  // Candidate entries: base policy (undated = always applicable) plus each
  // scheduled change. Sorted by date; undated base sorts before all dates.
  // Validation guarantees unique dates, so ordering is fully deterministic
  // and never depends on array insertion order.
  const entries = [
    { rate: policy.allocationRatePercent, effectiveFrom: policy.effectiveFrom },
  ];
  for (const change of policy.scheduledChanges || []) {
    entries.push({
      rate: change.allocationRatePercent,
      effectiveFrom: change.effectiveFrom,
    });
  }
  entries.sort((a, b) => ((a.effectiveFrom ?? '') < (b.effectiveFrom ?? '') ? -1 : 1));
  let winner;
  for (const entry of entries) {
    if (entry.effectiveFrom === undefined || entry.effectiveFrom <= businessDate) {
      winner = entry;
    } else {
      break;
    }
  }
  if (!winner) return { status: 'missing' };
  if (winner.rate === 0) {
    return winner.effectiveFrom === undefined
      ? { status: 'disabled', rate: 0 }
      : { status: 'disabled', rate: 0, effectiveFrom: winner.effectiveFrom };
  }
  return winner.effectiveFrom === undefined
    ? { status: 'enabled', rate: winner.rate }
    : { status: 'enabled', rate: winner.rate, effectiveFrom: winner.effectiveFrom };
}

module.exports = {
  TRANSPORT_BUDGET_RATE_MIN,
  TRANSPORT_BUDGET_RATE_MAX,
  TRANSPORT_BUDGET_RATE_MAX_DECIMALS,
  hasAllowedRatePrecision,
  isCalendarDate,
  validateTransportBudgetPolicy,
  getTransportBudgetPolicyState,
  resolveTransportBudgetRate,
};

import type { TransportBudgetPolicy, TransportBudgetScheduledChange } from '../types';

/**
 * transportBudgetPolicy.ts (Phase 3 + 3A — configuration only)
 *
 * Validation + normalization + date-based resolution for the internal
 * Transport Budget allocation policy (`CompanyConfig.transportBudgetPolicy`).
 *
 * Phase 2 contract (frozen):
 *   allocationAmount = roundMoney(eligibleBase x allocationRatePercent / 100)
 *   0 <= allocationRatePercent <= 100, max 4 decimal places.
 *   0% (or a missing policy/rate) = valid disabled state.
 *   Negative / >100 / non-finite / NaN = invalid configuration.
 *   Invalid values fail validation — they are never silently clamped.
 *   Historical allocations are never recalculated when the rate changes.
 *
 * Phase 3A correction: the policy may carry `scheduledChanges` so a
 * future-dated rate never overwrites the currently applicable rate.
 * Resolution is purely date-ordered over date-only (YYYY-MM-DD) strings —
 * no timezone conversion, no sync/replay/browser timestamps.
 *
 * This module implements configuration behavior ONLY. It performs no
 * allocation, posts no journals, and touches no sales/ledger/customer
 * state. It performs no I/O (no database, no network, no storage).
 */

export const TRANSPORT_BUDGET_RATE_MIN = 0;
export const TRANSPORT_BUDGET_RATE_MAX = 100;
export const TRANSPORT_BUDGET_RATE_MAX_DECIMALS = 4;

export interface TransportBudgetPolicyIssue {
  path: string;
  message: string;
}

export interface TransportBudgetPolicyValidation {
  valid: boolean;
  errors: TransportBudgetPolicyIssue[];
}

export type TransportBudgetPolicyState =
  | 'missing'
  | 'disabled'
  | 'enabled'
  | 'invalid';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value: string): boolean {
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
 * Uses an epsilon-tolerant check so binary float dust (e.g. 2.755 stored
 * as 2.7549999999999999) is not mistaken for a 5th decimal place, while a
 * genuine 5-decimal value (diff >= ~5e-5 after scaling) still fails.
 */
export function hasAllowedRatePrecision(rate: number): boolean {
  if (!Number.isFinite(rate)) return false;
  const scaled = Math.abs(rate) * 10000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function validateRate(rate: unknown, path: string): TransportBudgetPolicyIssue[] {
  if (typeof rate !== 'number') {
    return [{ path, message: 'Allocation rate must be a number.' }];
  }
  if (Number.isNaN(rate)) {
    return [{ path, message: 'Allocation rate must not be NaN.' }];
  }
  if (!Number.isFinite(rate)) {
    return [{ path, message: 'Allocation rate must be finite.' }];
  }
  if (rate < TRANSPORT_BUDGET_RATE_MIN) {
    return [{ path, message: 'Allocation rate must not be negative.' }];
  }
  if (rate > TRANSPORT_BUDGET_RATE_MAX) {
    return [{ path, message: 'Allocation rate must not exceed 100.' }];
  }
  if (!hasAllowedRatePrecision(rate)) {
    return [{ path, message: 'Allocation rate must have at most 4 decimal places.' }];
  }
  return [];
}

function validateEffectiveFrom(value: unknown): TransportBudgetPolicyIssue[] {
  if (value === undefined) return [];
  if (typeof value !== 'string' || !isCalendarDate(value)) {
    return [
      {
        path: 'transportBudgetPolicy.effectiveFrom',
        message: 'Effective date must be a calendar date in YYYY-MM-DD format.',
      },
    ];
  }
  return [];
}

/**
 * Validate the scheduled-changes list. Each entry needs its own valid rate
 * and a required valid date; duplicate effective dates — against each other
 * or against the base policy date — are rejected rather than silently
 * ordered (resolution must never depend on array position).
 */
function validateScheduledChanges(
  value: unknown,
  baseEffectiveFrom: unknown
): TransportBudgetPolicyIssue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return [
      {
        path: 'transportBudgetPolicy.scheduledChanges',
        message: 'Scheduled changes must be a list.',
      },
    ];
  }
  const issues: TransportBudgetPolicyIssue[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  if (typeof baseEffectiveFrom === 'string' && baseEffectiveFrom !== '') {
    seen.add(baseEffectiveFrom);
  }
  value.forEach((entry, index) => {
    const base = `transportBudgetPolicy.scheduledChanges.${index}`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      issues.push({ path: base, message: 'Scheduled change must be an object.' });
      return;
    }
    const record = entry as Record<string, unknown>;
    for (const issue of validateRate(record.allocationRatePercent, `${base}.allocationRatePercent`)) {
      issues.push(issue);
    }
    if (typeof record.effectiveFrom !== 'string' || !isCalendarDate(record.effectiveFrom)) {
      issues.push({
        path: `${base}.effectiveFrom`,
        message: 'Scheduled change requires a calendar date in YYYY-MM-DD format.',
      });
    } else {
      if (seen.has(record.effectiveFrom)) duplicates.add(record.effectiveFrom);
      seen.add(record.effectiveFrom);
    }
  });
  for (const date of duplicates) {
    issues.push({
      path: 'transportBudgetPolicy.scheduledChanges',
      message: `Duplicate scheduled effective date: ${date}. Keep one entry per date.`,
    });
  }
  return issues;
}

/**
 * Validate a transport budget policy value. `undefined` (absent policy) is
 * valid — it means allocation is disabled. Never coerces or clamps.
 */
export function validateTransportBudgetPolicy(
  policy: unknown
): TransportBudgetPolicyValidation {
  if (policy === undefined) return { valid: true, errors: [] };
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    return {
      valid: false,
      errors: [
        { path: 'transportBudgetPolicy', message: 'Transport budget policy must be an object.' },
      ],
    };
  }
  const record = policy as Record<string, unknown>;
  const errors = [
    ...validateRate(
      record.allocationRatePercent,
      'transportBudgetPolicy.allocationRatePercent'
    ),
    ...validateEffectiveFrom(record.effectiveFrom),
    ...validateScheduledChanges(record.scheduledChanges, record.effectiveFrom),
  ];
  return { valid: errors.length === 0, errors };
}

/**
 * Validator class mirroring the PricingSettingsValidator convention so the
 * Settings save path can validate consistently.
 */
export class TransportBudgetPolicyValidator {
  static validate(policy: unknown): TransportBudgetPolicyValidation {
    return validateTransportBudgetPolicy(policy);
  }
}

/**
 * Normalize a stored policy value. Returns a clean policy for valid input
 * (rates preserved exactly, no rounding; scheduled entries sorted by date)
 * and `undefined` for missing OR invalid input — malformed stored values can
 * never silently produce an enabled rate, they fall back to the disabled
 * state. Within a stored schedule, individually invalid entries are dropped
 * and every entry sharing a duplicated effective date is dropped together
 * (fail-closed: an ambiguous date never resolves to a guessed rate).
 * Never throws.
 */
export function normalizeTransportBudgetPolicy(
  raw: unknown
): TransportBudgetPolicy | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const candidate: TransportBudgetPolicy = {
    allocationRatePercent: record.allocationRatePercent as number,
  };
  if (typeof record.effectiveFrom === 'string' && record.effectiveFrom !== '') {
    candidate.effectiveFrom = record.effectiveFrom;
  }
  if (Array.isArray(record.scheduledChanges)) {
    const normalizedEntries: TransportBudgetScheduledChange[] = [];
    for (const entry of record.scheduledChanges) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const entryRecord = entry as Record<string, unknown>;
      const normalizedEntry: TransportBudgetScheduledChange = {
        allocationRatePercent: entryRecord.allocationRatePercent as number,
        effectiveFrom:
          typeof entryRecord.effectiveFrom === 'string' ? entryRecord.effectiveFrom : '',
      };
      const entryIssues = [
        ...validateRate(
          normalizedEntry.allocationRatePercent,
          'transportBudgetPolicy.scheduledChanges.allocationRatePercent'
        ),
        ...(isCalendarDate(normalizedEntry.effectiveFrom)
          ? []
          : [
              {
                path: 'transportBudgetPolicy.scheduledChanges.effectiveFrom',
                message: 'Scheduled change requires a calendar date in YYYY-MM-DD format.',
              },
            ]),
      ];
      if (entryIssues.length === 0) normalizedEntries.push(normalizedEntry);
    }
    // Fail-closed on ambiguity: drop every entry sharing a duplicated date
    // (including a collision with the base policy date — the base wins).
    const counts = new Map<string, number>();
    for (const entry of normalizedEntries) {
      counts.set(entry.effectiveFrom, (counts.get(entry.effectiveFrom) ?? 0) + 1);
    }
    const baseDate =
      typeof candidate.effectiveFrom === 'string' ? candidate.effectiveFrom : undefined;
    const deduped = normalizedEntries.filter(
      (entry) => counts.get(entry.effectiveFrom) === 1 && entry.effectiveFrom !== baseDate
    );
    deduped.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    if (deduped.length > 0) candidate.scheduledChanges = deduped;
  }
  const result = validateTransportBudgetPolicy(candidate);
  if (!result.valid) return undefined;
  return candidate;
}

/**
 * Parse raw text input (e.g. from a Settings field) into a rate without
 * silent coercion. Empty/blank input means "cleared" (policy removed).
 */
export function parseTransportBudgetRateInput(input: string): {
  cleared: boolean;
  value?: number;
  error?: string;
} {
  const text = input.trim().replace('%', '').trim();
  if (text === '') return { cleared: true };
  if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(text)) {
    return { cleared: false, error: 'Enter a numeric percentage (e.g. 3 or 2.755).' };
  }
  const value = Number(text);
  const issues = validateRate(value, 'transportBudgetPolicy.allocationRatePercent');
  if (issues.length > 0) {
    return { cleared: false, error: issues[0].message };
  }
  return { cleared: false, value };
}

/**
 * Tri-state reader for the future allocator (configuration level only):
 * distinguishes valid-disabled, valid-enabled, invalid, and missing so the
 * allocator can tell "disabled" apart from "misconfigured". Reflects the
 * base policy only (no business date); date-based resolution uses
 * resolveTransportBudgetRate below. Performs no allocation.
 */
export function getTransportBudgetPolicyState(
  config: { transportBudgetPolicy?: unknown } | null | undefined
): TransportBudgetPolicyState {
  const policy = config?.transportBudgetPolicy;
  if (policy === undefined) return 'missing';
  const result = validateTransportBudgetPolicy(policy);
  if (!result.valid) return 'invalid';
  const rate = (policy as TransportBudgetPolicy).allocationRatePercent;
  return rate === 0 ? 'disabled' : 'enabled';
}

export interface TransportBudgetRateResolution {
  status: 'missing' | 'disabled' | 'enabled' | 'invalid';
  /** Applicable rate when status is enabled/disabled; absent otherwise. */
  rate?: number;
  /**
   * Effective date of the winning entry; absent when the winner is a base
   * policy with no effective date (immediately effective).
   */
  effectiveFrom?: string;
}

/**
 * Pure configuration resolution: for a sale with business date D
 * (date-only YYYY-MM-DD), return the latest policy entry — base policy plus
 * scheduled changes — whose effective date is <= D. A base policy with no
 * effectiveFrom is immediately effective (applies to every D).
 *
 * Never mutates configuration, creates no events, posts no accounting, and
 * performs no I/O. It computes no allocation amount and references no sales
 * records — the future allocator supplies D from the sale's business date.
 */
export function resolveTransportBudgetRate(
  policy: unknown,
  businessDate: string
): TransportBudgetRateResolution {
  if (typeof businessDate !== 'string' || !isCalendarDate(businessDate)) {
    return { status: 'invalid' };
  }
  if (policy === undefined) return { status: 'missing' };
  if (validateTransportBudgetPolicy(policy).valid === false) return { status: 'invalid' };
  const record = policy as TransportBudgetPolicy;
  // Candidate entries: base policy (undated = always applicable) plus each
  // scheduled change. Sorted by date; undated base sorts before all dates.
  // Validation guarantees unique dates, so ordering is fully deterministic
  // and never depends on array insertion order.
  const entries: Array<{ rate: number; effectiveFrom?: string }> = [
    { rate: record.allocationRatePercent, effectiveFrom: record.effectiveFrom },
  ];
  for (const change of record.scheduledChanges ?? []) {
    entries.push({ rate: change.allocationRatePercent, effectiveFrom: change.effectiveFrom });
  }
  entries.sort((a, b) => (a.effectiveFrom ?? '') < (b.effectiveFrom ?? '') ? -1 : 1);
  let winner: { rate: number; effectiveFrom?: string } | undefined;
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

/**
 * One scheduled-change row from the Settings form (raw text, unparsed).
 */
export interface TransportBudgetScheduledDraft {
  rate: string;
  effectiveFrom: string;
}

/**
 * Resolve Settings-form drafts into a persistable policy (or field errors).
 * Used by the Settings save path so the draft rules are unit-testable:
 * blank rate = cleared (policy removed) unless an effective date is set —
 * a date without a rate is rejected rather than stored. Scheduled rows are
 * parsed strictly: a row must be completed or removed, never half-filled.
 */
export function resolveTransportBudgetPolicyDraft(
  rateText: string,
  effectiveText: string,
  scheduledDrafts?: TransportBudgetScheduledDraft[]
): { policy?: TransportBudgetPolicy; errors: Record<string, string> } {
  const effective = effectiveText.trim();
  const parsed = parseTransportBudgetRateInput(rateText);
  if (parsed.error) {
    return {
      errors: { 'transportBudgetPolicy.allocationRatePercent': parsed.error },
    };
  }
  if (parsed.cleared && effective !== '') {
    const message =
      'An effective date requires an allocation rate. Clear the date or enter a rate.';
    return { errors: { 'transportBudgetPolicy.effectiveFrom': message } };
  }
  const errors: Record<string, string> = {};
  const scheduledChanges: TransportBudgetScheduledChange[] = [];
  (scheduledDrafts ?? []).forEach((draft, index) => {
    const base = `transportBudgetPolicy.scheduledChanges.${index}`;
    const rowRate = parseTransportBudgetRateInput(draft.rate);
    const rowDate = draft.effectiveFrom.trim();
    if (rowRate.cleared && rowDate === '') {
      errors[`${base}.allocationRatePercent`] =
        'Enter a rate and effective date, or remove this scheduled change.';
      return;
    }
    if (rowRate.error) {
      errors[`${base}.allocationRatePercent`] = rowRate.error;
      return;
    }
    if (rowRate.cleared) {
      errors[`${base}.allocationRatePercent`] =
        'A scheduled effective date requires a rate. Enter a rate or remove this row.';
      return;
    }
    if (rowDate === '' || !isCalendarDate(rowDate)) {
      errors[`${base}.effectiveFrom`] =
        'Scheduled change requires a calendar date in YYYY-MM-DD format.';
      return;
    }
    scheduledChanges.push({
      allocationRatePercent: rowRate.value as number,
      effectiveFrom: rowDate,
    });
  });
  if (Object.keys(errors).length > 0) return { errors };
  if (parsed.cleared) {
    if (scheduledChanges.length > 0) {
      return {
        errors: {
          'transportBudgetPolicy.allocationRatePercent':
            'Scheduled changes require a current rate. Enter a rate or remove the scheduled rows.',
        },
      };
    }
    return { policy: undefined, errors: {} };
  }
  const candidate: TransportBudgetPolicy =
    scheduledChanges.length === 0
      ? effective === ''
        ? { allocationRatePercent: parsed.value as number }
        : {
            allocationRatePercent: parsed.value as number,
            effectiveFrom: effective,
          }
      : {
          allocationRatePercent: parsed.value as number,
          ...(effective === '' ? {} : { effectiveFrom: effective }),
          scheduledChanges,
        };
  const check = validateTransportBudgetPolicy(candidate);
  if (!check.valid) {
    const candidateErrors: Record<string, string> = {};
    for (const issue of check.errors) candidateErrors[issue.path] = issue.message;
    return { errors: candidateErrors };
  }
  return { policy: candidate, errors: {} };
}

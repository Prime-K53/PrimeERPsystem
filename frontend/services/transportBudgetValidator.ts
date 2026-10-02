/**
 * transportBudgetValidator.ts — Phase 4: pure Transport Budget event validator.
 *
 * FAIL-CLOSED shape validation only. It verifies that an event is
 * well-formed (kind, identity, amount, sign, rate shape, business date,
 * reversal-link shape, required/optional fields, accounting quarantine) and
 * normalizes it into its canonical persisted form.
 *
 * It explicitly does NOT:
 *   - calculate allocations (no eligibleBase x rate math),
 *   - create allocation amounts (the producer-supplied amount is authoritative),
 *   - read CompanyConfig,
 *   - access the database,
 *   - post accounting,
 *   - mutate customer data.
 *
 * Pure modulo the injectable `nowIso` clock (defaults to the current time;
 * tests inject a fixed value for determinism).
 */

import { roundMoney } from '../utils/roundingUtils';
import type {
  NewTransportBudgetEventInput,
  TransportBudgetEvent,
  TransportBudgetEventKind,
  TransportBudgetValidationCode,
  TransportBudgetValidationIssue,
} from '../types/transportBudget';
import { TRANSPORT_BUDGET_EVENT_KINDS } from '../types/transportBudget';

export class TransportBudgetValidationError extends Error {
  readonly issues: TransportBudgetValidationIssue[];

  constructor(issues: TransportBudgetValidationIssue[]) {
    super(
      `Invalid transport budget event: ${issues.map((i) => `${i.field} (${i.code})`).join('; ')}`,
    );
    this.name = 'TransportBudgetValidationError';
    this.issues = issues;
  }
}

/** Absolute bound for any stored money value (currency units, 2dp). */
export const TRANSPORT_BUDGET_MAX_AMOUNT = 999999999999.99;

/**
 * Maximum decimal places for a stored allocation rate (percent).
 * Frozen configuration contract: 0..100 with at most 4 decimals.
 * Money precision (2dp via `roundMoney`) is a SEPARATE concept and is
 * untouched by this rule.
 */
export const TRANSPORT_BUDGET_RATE_MAX_DECIMALS = 4;

/**
 * True when a finite rate carries at most 4 decimal places.
 * Epsilon-tolerant so binary float dust (e.g. 2.755 stored as
 * 2.7549999999999999) is not mistaken for a 5th decimal place, while a
 * genuine 5-decimal value still fails. Never rounds, never clamps.
 */
export function hasAllowedRatePrecision(rate: number): boolean {
  if (!Number.isFinite(rate)) return false;
  const scaled =
    Math.abs(rate) * Math.pow(10, TRANSPORT_BUDGET_RATE_MAX_DECIMALS);
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Generic identity charset (also enforced by the database CHECKs). */
const IDENTITY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;
/** Future method tags: short uppercase/underscore tokens. */
const METHOD_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
/** Business-date shape; calendar validity is checked separately (no TZ use). */
const BUSINESS_DATE_PATTERN =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

export function isTransportBudgetEventKind(
  value: unknown,
): value is TransportBudgetEventKind {
  return (
    typeof value === 'string' &&
    (TRANSPORT_BUDGET_EVENT_KINDS as readonly string[]).includes(value)
  );
}

const isValidCalendarDate = (value: string): boolean => {
  if (!BUSINESS_DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  // UTC round-trip avoids any local-timezone shift for date-only values.
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
};

const isValidIsoDateTime = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
};

const toNullableTrimmed = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

export interface TransportBudgetValidationSuccess {
  ok: true;
  event: TransportBudgetEvent;
}

export interface TransportBudgetValidationFailure {
  ok: false;
  issues: TransportBudgetValidationIssue[];
}

const issue = (
  issues: TransportBudgetValidationIssue[],
  code: TransportBudgetValidationCode,
  field: string,
  message: string,
): void => {
  issues.push({ code, field, message });
};

/**
 * Validate + normalize a candidate event. Returns the canonical event on
 * success (money rounded to 2dp via `roundMoney`; the allocation rate is
 * preserved EXACTLY as supplied and never rounded or recalculated).
 */
export function validateTransportBudgetEvent(
  input: unknown,
  nowIso: string = new Date().toISOString(),
): TransportBudgetValidationSuccess | TransportBudgetValidationFailure {
  const issues: TransportBudgetValidationIssue[] = [];

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      issues: [
        {
          code: 'INVALID_KIND',
          field: 'kind',
          message: 'Event must be an object.',
        },
      ],
    };
  }

  const candidate = input as Record<string, unknown>;

  // --- kind (exact match, no case coercion) -------------------------------
  const rawKind =
    typeof candidate.kind === 'string' ? candidate.kind.trim() : candidate.kind;
  if (!isTransportBudgetEventKind(rawKind)) {
    issue(
      issues,
      'INVALID_KIND',
      'kind',
      `kind must be one of ${TRANSPORT_BUDGET_EVENT_KINDS.join(' | ')}.`,
    );
  }
  const kind = (isTransportBudgetEventKind(rawKind) ? rawKind : null) as
    | TransportBudgetEventKind
    | null;

  // --- id (client-generated before persistence; repo fills when absent) ----
  const id = toNullableTrimmed(candidate.id);
  if (id === null || !IDENTITY_PATTERN.test(id)) {
    issue(
      issues,
      'INVALID_ID',
      'id',
      'id must be a non-empty client-generated identifier (max 200 chars: A-Z a-z 0-9 : _ - . /).',
    );
  }

  // --- idempotencyKey (immutable economic identity) ------------------------
  const idempotencyKey = toNullableTrimmed(candidate.idempotencyKey);
  if (idempotencyKey === null || !IDENTITY_PATTERN.test(idempotencyKey)) {
    issue(
      issues,
      'INVALID_IDEMPOTENCY_KEY',
      'idempotencyKey',
      'idempotencyKey must be a non-empty unique economic key (max 200 chars: A-Z a-z 0-9 : _ - . /).',
    );
  }

  // --- amount (authoritative signed movement, stored as supplied) ----------
  let amount: number | null = null;
  if (typeof candidate.amount !== 'number' || !Number.isFinite(candidate.amount)) {
    issue(
      issues,
      'INVALID_AMOUNT',
      'amount',
      'amount must be a finite number (currency units); strings are rejected.',
    );
  } else {
    amount = roundMoney(candidate.amount);
    if (amount === 0) {
      issue(issues, 'INVALID_AMOUNT', 'amount', 'amount must not be zero.');
    } else if (Math.abs(amount) > TRANSPORT_BUDGET_MAX_AMOUNT) {
      issue(
        issues,
        'INVALID_AMOUNT',
        'amount',
        `|amount| must not exceed ${TRANSPORT_BUDGET_MAX_AMOUNT}.`,
      );
    } else if (kind !== null) {
      // Sign is VALIDATED here but STORED as supplied (never inferred).
      if (kind === 'SALES_ALLOCATION' && !(amount > 0)) {
        issue(
          issues,
          'INVALID_SIGN',
          'amount',
          'SALES_ALLOCATION amount must be positive.',
        );
      } else if (kind !== 'SALES_ALLOCATION' && !(amount < 0)) {
        issue(
          issues,
          'INVALID_SIGN',
          'amount',
          `${kind} amount must be negative.`,
        );
      }
    }
  }

  // --- sourceEventId (generic source identity) -----------------------------
  const sourceEventId = toNullableTrimmed(candidate.sourceEventId);
  if (
    candidate.sourceEventId !== null &&
    candidate.sourceEventId !== undefined &&
    typeof candidate.sourceEventId !== 'string'
  ) {
    issue(
      issues,
      'INVALID_SOURCE_EVENT_ID',
      'sourceEventId',
      'sourceEventId must be a string or null.',
    );
  } else if (sourceEventId !== null && !IDENTITY_PATTERN.test(sourceEventId)) {
    issue(
      issues,
      'INVALID_SOURCE_EVENT_ID',
      'sourceEventId',
      'sourceEventId must match the identity charset (max 200 chars).',
    );
  }

  // --- sourceAmount (snapshot, 2dp; never used to recompute amount) --------
  let sourceAmount: number | null = null;
  if (
    candidate.sourceAmount !== null &&
    candidate.sourceAmount !== undefined
  ) {
    if (
      typeof candidate.sourceAmount !== 'number' ||
      !Number.isFinite(candidate.sourceAmount)
    ) {
      issue(
        issues,
        'INVALID_SOURCE_AMOUNT',
        'sourceAmount',
        'sourceAmount must be a finite number or null.',
      );
    } else {
      sourceAmount = roundMoney(candidate.sourceAmount);
      if (
        sourceAmount < 0 ||
        sourceAmount > TRANSPORT_BUDGET_MAX_AMOUNT
      ) {
        issue(
          issues,
          'INVALID_SOURCE_AMOUNT',
          'sourceAmount',
          `sourceAmount must be within 0..${TRANSPORT_BUDGET_MAX_AMOUNT}.`,
        );
      }
    }
  }

  // --- allocationRatePercent (validated, NEVER calculated or rounded) ------
  let allocationRatePercent: number | null = null;
  if (
    candidate.allocationRatePercent !== null &&
    candidate.allocationRatePercent !== undefined
  ) {
    if (
      typeof candidate.allocationRatePercent !== 'number' ||
      !Number.isFinite(candidate.allocationRatePercent)
    ) {
      issue(
        issues,
        'INVALID_RATE',
        'allocationRatePercent',
        'allocationRatePercent must be a finite number or null.',
      );
    } else if (
      candidate.allocationRatePercent < 0 ||
      candidate.allocationRatePercent > 100
    ) {
      issue(
        issues,
        'INVALID_RATE',
        'allocationRatePercent',
        'allocationRatePercent must be within 0..100.',
      );
    } else if (!hasAllowedRatePrecision(candidate.allocationRatePercent)) {
      // Structural precision boundary only (max 4 decimals). The value is
      // rejected as-is — never rounded or clamped into validity — and no
      // configuration is consulted.
      issue(
        issues,
        'INVALID_RATE',
        'allocationRatePercent',
        'allocationRatePercent must have at most 4 decimal places.',
      );
    } else {
      // Preserved EXACTLY (e.g. 2.755 stays 2.755) — historical data.
      allocationRatePercent = candidate.allocationRatePercent;
    }
  }

  // --- businessDate (date-only, no timezone conversion) -------------------
  const businessDate = toNullableTrimmed(candidate.businessDate);
  if (businessDate === null || !isValidCalendarDate(businessDate)) {
    issue(
      issues,
      'INVALID_BUSINESS_DATE',
      'businessDate',
      'businessDate must be a valid calendar date in YYYY-MM-DD form.',
    );
  }

  // --- occurredAt -----------------------------------------------------------
  const occurredAt = toNullableTrimmed(candidate.occurredAt);
  if (occurredAt === null || !isValidIsoDateTime(occurredAt)) {
    issue(
      issues,
      'INVALID_OCCURRED_AT',
      'occurredAt',
      'occurredAt must be a valid ISO-8601 timestamp.',
    );
  }

  // --- method / providerId (generic, optional, never interpreted) ----------
  // Empty strings normalize to null, consistent with every other optional
  // identity field; non-string or badly-shaped values are rejected.
  const methodRaw = candidate.method;
  let method: string | null = null;
  if (
    methodRaw === null ||
    methodRaw === undefined ||
    (typeof methodRaw === 'string' && methodRaw.trim() === '')
  ) {
    method = null;
  } else if (
    typeof methodRaw !== 'string' ||
    !METHOD_PATTERN.test(methodRaw.trim())
  ) {
    issue(
      issues,
      'INVALID_METHOD',
      'method',
      'method must be a 1..64 char token (A-Z a-z 0-9 _) or null.',
    );
  } else {
    method = methodRaw.trim();
  }
  const providerRaw = candidate.providerId;
  let providerId: string | null = null;
  if (
    providerRaw === null ||
    providerRaw === undefined ||
    (typeof providerRaw === 'string' && providerRaw.trim() === '')
  ) {
    providerId = null;
  } else if (
    typeof providerRaw !== 'string' ||
    !IDENTITY_PATTERN.test(providerRaw.trim())
  ) {
    issue(
      issues,
      'INVALID_PROVIDER_ID',
      'providerId',
      'providerId must match the identity charset (max 200 chars) or null.',
    );
  } else {
    providerId = providerRaw.trim();
  }

  // --- accounting quarantine (Phase 4 populates nothing here) --------------
  const journalIds = candidate.journalIds;
  const accountSplits = candidate.accountSplits;
  const journalIdsEmpty =
    journalIds === null ||
    journalIds === undefined ||
    (Array.isArray(journalIds) && journalIds.length === 0);
  const accountSplitsEmpty =
    accountSplits === null ||
    accountSplits === undefined ||
    (Array.isArray(accountSplits) && accountSplits.length === 0);
  if (!journalIdsEmpty || !accountSplitsEmpty) {
    issue(
      issues,
      'ACCOUNTING_FIELDS_FORBIDDEN',
      !journalIdsEmpty ? 'journalIds' : 'accountSplits',
      'The Transport Budget ledger is not accounting: journalIds/accountSplits must remain empty in Phase 4.',
    );
  }

  // --- reversesEventId (structural shape; existence/cap enforced at append) -
  const reversesEventId = toNullableTrimmed(candidate.reversesEventId);
  if (
    candidate.reversesEventId !== null &&
    candidate.reversesEventId !== undefined &&
    typeof candidate.reversesEventId !== 'string'
  ) {
    issue(
      issues,
      'MISSING_REVERSAL_LINK',
      'reversesEventId',
      'reversesEventId must be a string or null.',
    );
  } else if (reversesEventId !== null && !IDENTITY_PATTERN.test(reversesEventId)) {
    issue(
      issues,
      'MISSING_REVERSAL_LINK',
      'reversesEventId',
      'reversesEventId must match the identity charset (max 200 chars).',
    );
  } else if (kind !== null) {
    if (kind === 'REVERSAL' && reversesEventId === null) {
      issue(
        issues,
        'MISSING_REVERSAL_LINK',
        'reversesEventId',
        'REVERSAL events must reference the reversed event.',
      );
    }
    if (kind !== 'REVERSAL' && reversesEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_REVERSAL_LINK',
        'reversesEventId',
        `Only REVERSAL events may carry reversesEventId (kind is ${kind}).`,
      );
    }
    if (
      kind === 'REVERSAL' &&
      reversesEventId !== null &&
      id !== null &&
      reversesEventId === id
    ) {
      issue(
        issues,
        'FORBIDDEN_REVERSAL_LINK',
        'reversesEventId',
        'A reversal cannot reference itself.',
      );
    }
  }

  // --- per-kind field matrix -------------------------------------------------
  if (kind === 'SALES_ALLOCATION') {
    if (sourceEventId === null) {
      issue(
        issues,
        'INVALID_SOURCE_EVENT_ID',
        'sourceEventId',
        'SALES_ALLOCATION requires sourceEventId.',
      );
    }
    if (sourceAmount === null) {
      issue(
        issues,
        'INVALID_SOURCE_AMOUNT',
        'sourceAmount',
        'SALES_ALLOCATION requires sourceAmount.',
      );
    } else if (!(sourceAmount > 0)) {
      issue(
        issues,
        'INVALID_SOURCE_AMOUNT',
        'sourceAmount',
        'SALES_ALLOCATION requires sourceAmount > 0.',
      );
    }
    if (allocationRatePercent === null) {
      issue(
        issues,
        'MISSING_ALLOCATION_FIELDS',
        'allocationRatePercent',
        'SALES_ALLOCATION requires allocationRatePercent.',
      );
    }
  }
  if (kind === 'REVERSAL') {
    if (sourceEventId !== null || sourceAmount !== null || allocationRatePercent !== null) {
      issue(
        issues,
        'FORBIDDEN_SOURCE_FIELDS',
        'sourceEventId',
        'REVERSAL must not carry sourceEventId/sourceAmount/allocationRatePercent (its economics derive from the reversed event).',
      );
    }
  }
  if (kind === 'INBOUND_CONSUMPTION' || kind === 'OUTBOUND_CONSUMPTION') {
    if (allocationRatePercent !== null) {
      issue(
        issues,
        'FORBIDDEN_RATE',
        'allocationRatePercent',
        `${kind} must not carry allocationRatePercent.`,
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const createdAtRaw = toNullableTrimmed(candidate.createdAt);
  const createdAt =
    createdAtRaw !== null && isValidIsoDateTime(createdAtRaw)
      ? createdAtRaw
      : nowIso;

  return {
    ok: true,
    event: {
      id: id as string,
      kind: kind as TransportBudgetEventKind,
      idempotencyKey: idempotencyKey as string,
      sourceEventId,
      sourceAmount,
      allocationRatePercent,
      amount: amount as number,
      method,
      providerId,
      accountSplits: null,
      journalIds: null,
      reversesEventId,
      businessDate: businessDate as string,
      occurredAt: occurredAt as string,
      createdAt,
    },
  };
}

/** Throwing wrapper for call sites that treat invalid input as fatal. */
export function assertValidTransportBudgetEvent(
  input: unknown,
  nowIso?: string,
): TransportBudgetEvent {
  const result = validateTransportBudgetEvent(input, nowIso);
  if (result.ok === false) {
    throw new TransportBudgetValidationError(result.issues);
  }
  return result.event;
}

/**
 * Economic-payload equality (creation metadata excluded): used to tell a
 * true retry (same id, same economics -> deduplicate) from a conflicting
 * reuse of an event id (same id, different economics -> reject).
 */
export function sameEconomicPayload(
  a: TransportBudgetEvent,
  b: TransportBudgetEvent,
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.idempotencyKey === b.idempotencyKey &&
    (a.sourceEventId ?? null) === (b.sourceEventId ?? null) &&
    (a.sourceAmount ?? null) === (b.sourceAmount ?? null) &&
    (a.allocationRatePercent ?? null) === (b.allocationRatePercent ?? null) &&
    a.amount === b.amount &&
    (a.method ?? null) === (b.method ?? null) &&
    (a.providerId ?? null) === (b.providerId ?? null) &&
    (a.reversesEventId ?? null) === (b.reversesEventId ?? null) &&
    a.businessDate === b.businessDate &&
    a.occurredAt === b.occurredAt
  );
}

export type { NewTransportBudgetEventInput };

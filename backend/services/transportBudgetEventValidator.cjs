/**
 * transportBudgetEventValidator.cjs — Phase 4 validator, CJS port.
 *
 * Port of frontend/services/transportBudgetValidator.ts (identical codes,
 * patterns, rounding and per-kind matrix) so the backend producer submits
 * events that satisfy the SAME fail-closed shape contract before they ever
 * reach the Phase 4 database trigger.
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
 * Pure modulo the injectable `nowIso` clock (tests inject a fixed value).
 */

/** Absolute bound for any stored money value (currency units, 2dp). */
const TRANSPORT_BUDGET_MAX_AMOUNT = 999999999999.99;
const TRANSPORT_BUDGET_RATE_MAX_DECIMALS = 4;

const TRANSPORT_BUDGET_EVENT_KINDS = Object.freeze([
  'SALES_ALLOCATION',
  'REVERSAL',
  'INBOUND_CONSUMPTION',
  'OUTBOUND_CONSUMPTION',
  'CONSUMPTION_CORRECTION',
]);

/** Generic identity charset (also enforced by the database CHECKs). */
const IDENTITY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;
/** Future method tags: short uppercase/underscore tokens. */
const METHOD_PATTERN = /^[A-Za-z0-9_]{1,64}$/;
/** Business-date shape; calendar validity is checked separately (no TZ use). */
const BUSINESS_DATE_PATTERN =
  /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

/**
 * True when a finite rate carries at most 4 decimal places.
 * Epsilon-tolerant so binary float dust (e.g. 2.755 stored as
 * 2.7549999999999999) is not mistaken for a 5th decimal place, while a
 * genuine 5-decimal value still fails. Never rounds, never clamps.
 * (Same function as frontend/services/transportBudgetValidator.ts and
 * frontend/utils/transportBudgetPolicy.ts — ported, not imported.)
 */
const hasAllowedRatePrecision = (rate) => {
  if (!Number.isFinite(rate)) return false;
  const scaled =
    Math.abs(rate) * Math.pow(10, TRANSPORT_BUDGET_RATE_MAX_DECIMALS);
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
};

const isTransportBudgetEventKind = (value) =>
  typeof value === 'string' &&
  TRANSPORT_BUDGET_EVENT_KINDS.includes(value);

const isValidCalendarDate = (value) => {
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

const isValidIsoDateTime = (value) => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
};

const toNullableTrimmed = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * Canonical money rounding — same semantics as the frontend
 * `roundMoney` (frontend/utils/roundingUtils.ts): 2dp,
 * Number.EPSILON drift compensation, non-finite input -> 0.
 */
const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

class TransportBudgetValidationError extends Error {
  constructor(issues) {
    super(
      `Invalid transport budget event: ${issues
        .map((i) => `${i.field} (${i.code})`)
        .join('; ')}`,
    );
    this.name = 'TransportBudgetValidationError';
    this.issues = issues;
  }
}

const issue = (issues, code, field, message) => {
  issues.push({ code, field, message });
};

/**
 * Validate + normalize a candidate event. Returns the canonical event on
 * success (money rounded to 2dp via roundMoney; the allocation rate is
 * preserved EXACTLY as supplied and never rounded or recalculated).
 */
function validateTransportBudgetEvent(input, nowIso = new Date().toISOString()) {
  const issues = [];

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

  const candidate = input;

  // --- kind (exact match, no case coercion) -------------------------------
  const rawKind = typeof candidate.kind === 'string' ? candidate.kind.trim() : candidate.kind;
  if (!isTransportBudgetEventKind(rawKind)) {
    issue(
      issues,
      'INVALID_KIND',
      'kind',
      `kind must be one of ${TRANSPORT_BUDGET_EVENT_KINDS.join(' | ')}.`,
    );
  }
  const kind = isTransportBudgetEventKind(rawKind) ? rawKind : null;

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
  let amount = null;
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
      // Phase 7E: SALES_ALLOCATION and CONSUMPTION_CORRECTION generate /
      // restore budget (> 0); every other kind consumes it (< 0). Global
      // overdraft is ALLOWED, so no balance floor is checked here.
      if (
        (kind === 'SALES_ALLOCATION' || kind === 'CONSUMPTION_CORRECTION') &&
        !(amount > 0)
      ) {
        issue(
          issues,
          'INVALID_SIGN',
          'amount',
          `${kind} amount must be positive.`,
        );
      } else if (
        kind !== 'SALES_ALLOCATION' &&
        kind !== 'CONSUMPTION_CORRECTION' &&
        !(amount < 0)
      ) {
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
  let sourceAmount = null;
  if (candidate.sourceAmount !== null && candidate.sourceAmount !== undefined) {
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
      if (sourceAmount < 0 || sourceAmount > TRANSPORT_BUDGET_MAX_AMOUNT) {
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
  let allocationRatePercent = null;
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

  // --- businessDate (date-only, no timezone conversion) --------------------
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
  const methodRaw = candidate.method;
  let method = null;
  if (
    methodRaw === null ||
    methodRaw === undefined ||
    (typeof methodRaw === 'string' && methodRaw.trim() === '')
  ) {
    method = null;
  } else if (typeof methodRaw !== 'string' || !METHOD_PATTERN.test(methodRaw.trim())) {
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
  let providerId = null;
  if (
    providerRaw === null ||
    providerRaw === undefined ||
    (typeof providerRaw === 'string' && providerRaw.trim() === '')
  ) {
    providerId = null;
  } else if (typeof providerRaw !== 'string' || !IDENTITY_PATTERN.test(providerRaw.trim())) {
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
    if (kind === 'REVERSAL' && reversesEventId !== null && id !== null && reversesEventId === id) {
      issue(
        issues,
        'FORBIDDEN_REVERSAL_LINK',
        'reversesEventId',
        'A reversal cannot reference itself.',
      );
    }
  }

  // --- correctsEventId (structural shape; target/cap enforced at append) --
  // Phase 7E: present if and only if kind === 'CONSUMPTION_CORRECTION'.
  // reversesEventId remains exclusively associated with REVERSAL.
  const correctsEventId = toNullableTrimmed(candidate.correctsEventId);
  if (
    candidate.correctsEventId !== null &&
    candidate.correctsEventId !== undefined &&
    typeof candidate.correctsEventId !== 'string'
  ) {
    issue(
      issues,
      'MISSING_CORRECTION_LINK',
      'correctsEventId',
      'correctsEventId must be a string or null.',
    );
  } else if (correctsEventId !== null && !IDENTITY_PATTERN.test(correctsEventId)) {
    issue(
      issues,
      'MISSING_CORRECTION_LINK',
      'correctsEventId',
      'correctsEventId must match the identity charset (max 200 chars).',
    );
  } else if (kind !== null) {
    if (kind === 'CONSUMPTION_CORRECTION' && correctsEventId === null) {
      issue(
        issues,
        'MISSING_CORRECTION_LINK',
        'correctsEventId',
        'CONSUMPTION_CORRECTION events must reference the corrected consumption.',
      );
    }
    if (kind !== 'CONSUMPTION_CORRECTION' && correctsEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_CORRECTION_LINK',
        'correctsEventId',
        `Only CONSUMPTION_CORRECTION events may carry correctsEventId (kind is ${kind}).`,
      );
    }
    if (kind === 'CONSUMPTION_CORRECTION' && correctsEventId !== null && id !== null && correctsEventId === id) {
      issue(
        issues,
        'FORBIDDEN_CORRECTION_LINK',
        'correctsEventId',
        'A correction cannot reference itself.',
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
    if (correctsEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_CORRECTION_LINK',
        'correctsEventId',
        'REVERSAL must not carry correctsEventId (corrections link via CONSUMPTION_CORRECTION only).',
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
    if (correctsEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_CORRECTION_LINK',
        'correctsEventId',
        `Only CONSUMPTION_CORRECTION events may carry correctsEventId (kind is ${kind}).`,
      );
    }
  }
  if (kind === 'SALES_ALLOCATION') {
    if (correctsEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_CORRECTION_LINK',
        'correctsEventId',
        'SALES_ALLOCATION must not carry correctsEventId.',
      );
    }
  }
  if (kind === 'CONSUMPTION_CORRECTION') {
    // Frozen Phase 7D-2 contract: deliberate duplicate-field rule —
    // sourceEventId MUST equal correctsEventId (both carry the original
    // INBOUND_CONSUMPTION event ID); snapshots are frozen copies.
    if (sourceEventId === null) {
      issue(
        issues,
        'INVALID_SOURCE_EVENT_ID',
        'sourceEventId',
        'CONSUMPTION_CORRECTION requires sourceEventId (= correctsEventId).',
      );
    } else if (sourceEventId !== correctsEventId) {
      issue(
        issues,
        'MISSING_CORRECTION_LINK',
        'sourceEventId',
        'CONSUMPTION_CORRECTION requires sourceEventId = correctsEventId.',
      );
    }
    if (sourceAmount === null) {
      issue(
        issues,
        'INVALID_SOURCE_AMOUNT',
        'sourceAmount',
        'CONSUMPTION_CORRECTION requires sourceAmount (= abs(original consumption amount)).',
      );
    } else if (!(sourceAmount > 0)) {
      issue(
        issues,
        'INVALID_SOURCE_AMOUNT',
        'sourceAmount',
        'CONSUMPTION_CORRECTION requires sourceAmount > 0.',
      );
    }
    if (method === null) {
      issue(
        issues,
        'INVALID_METHOD',
        'method',
        'CONSUMPTION_CORRECTION requires method (= LANDING_COST_FREIGHT).',
      );
    } else if (method !== 'LANDING_COST_FREIGHT') {
      issue(
        issues,
        'INVALID_METHOD',
        'method',
        'CONSUMPTION_CORRECTION method must be LANDING_COST_FREIGHT.',
      );
    }
    if (providerId === null) {
      issue(
        issues,
        'INVALID_PROVIDER_ID',
        'providerId',
        'CONSUMPTION_CORRECTION requires providerId (original provider snapshot).',
      );
    }
    if (allocationRatePercent !== null) {
      issue(
        issues,
        'FORBIDDEN_RATE',
        'allocationRatePercent',
        'CONSUMPTION_CORRECTION must not carry allocationRatePercent.',
      );
    }
    if (reversesEventId !== null) {
      issue(
        issues,
        'FORBIDDEN_REVERSAL_LINK',
        'reversesEventId',
        'CONSUMPTION_CORRECTION must not carry reversesEventId.',
      );
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const createdAtRaw = toNullableTrimmed(candidate.createdAt);
  const createdAt =
    createdAtRaw !== null && isValidIsoDateTime(createdAtRaw) ? createdAtRaw : nowIso;

  return {
    ok: true,
    event: {
      id,
      kind,
      idempotencyKey,
      sourceEventId,
      sourceAmount,
      allocationRatePercent,
      amount,
      method,
      providerId,
      accountSplits: null,
      journalIds: null,
      reversesEventId,
      correctsEventId,
      businessDate,
      occurredAt,
      createdAt,
    },
  };
}

/** Throwing wrapper for call sites that treat invalid input as fatal. */
function assertValidTransportBudgetEvent(input, nowIso) {
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
function sameEconomicPayload(a, b) {
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
    (a.correctsEventId ?? null) === (b.correctsEventId ?? null) &&
    a.businessDate === b.businessDate &&
    a.occurredAt === b.occurredAt
  );
}

module.exports = {
  TRANSPORT_BUDGET_MAX_AMOUNT,
  TRANSPORT_BUDGET_RATE_MAX_DECIMALS,
  TRANSPORT_BUDGET_EVENT_KINDS,
  IDENTITY_PATTERN,
  roundMoney,
  isTransportBudgetEventKind,
  isValidCalendarDate,
  TransportBudgetValidationError,
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
  sameEconomicPayload,
};

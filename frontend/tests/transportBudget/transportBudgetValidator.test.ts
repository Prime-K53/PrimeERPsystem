import { describe, it, expect } from 'vitest';
import {
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
  TransportBudgetValidationError,
  sameEconomicPayload,
  hasAllowedRatePrecision,
} from '../../services/transportBudgetValidator';

const NOW = '2026-10-01T00:00:00.000Z';

const baseAllocation = {
  id: 'evt-alloc-001',
  kind: 'SALES_ALLOCATION',
  idempotencyKey: 'SALES_ALLOCATION:INV-0001',
  sourceEventId: 'INV-0001',
  sourceAmount: 500000,
  allocationRatePercent: 3,
  amount: 15000,
  method: null,
  providerId: null,
  accountSplits: null,
  journalIds: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T10:00:00.000Z',
};

const validReversal = {
  id: 'evt-rev-001',
  kind: 'REVERSAL',
  idempotencyKey: 'REVERSAL:evt-alloc-001:1',
  sourceEventId: null,
  sourceAmount: null,
  allocationRatePercent: null,
  amount: -15000,
  method: null,
  providerId: null,
  accountSplits: null,
  journalIds: null,
  reversesEventId: 'evt-alloc-001',
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T12:00:00.000Z',
};

const validInbound = {
  id: 'evt-in-001',
  kind: 'INBOUND_CONSUMPTION',
  idempotencyKey: 'INBOUND:LC-EVT-001',
  sourceEventId: 'LC-EVT-001',
  sourceAmount: null,
  allocationRatePercent: null,
  amount: -5000,
  method: null,
  providerId: null,
  accountSplits: null,
  journalIds: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T13:00:00.000Z',
};

const validOutbound = {
  id: 'evt-out-001',
  kind: 'OUTBOUND_CONSUMPTION',
  idempotencyKey: 'OUTBOUND:DLV-EVT-001',
  sourceEventId: null,
  sourceAmount: null,
  allocationRatePercent: null,
  amount: -3000,
  method: null,
  providerId: null,
  accountSplits: null,
  journalIds: null,
  reversesEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T14:00:00.000Z',
};

describe('transportBudgetValidator — schema/model', () => {
  it('accepts a valid SALES_ALLOCATION', () => {
    const result = validateTransportBudgetEvent(baseAllocation, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.amount).toBe(15000);
      expect(result.event.kind).toBe('SALES_ALLOCATION');
      expect(result.event.createdAt).toBe(NOW);
    }
  });

  it('accepts a valid REVERSAL', () => {
    const result = validateTransportBudgetEvent(validReversal, NOW);
    expect(result.ok).toBe(true);
  });

  it('accepts a valid INBOUND_CONSUMPTION', () => {
    const result = validateTransportBudgetEvent(validInbound, NOW);
    expect(result.ok).toBe(true);
  });

  it('accepts a valid OUTBOUND_CONSUMPTION', () => {
    const result = validateTransportBudgetEvent(validOutbound, NOW);
    expect(result.ok).toBe(true);
  });

  it('rejects missing required fields', () => {
    for (const patch of [
      { kind: undefined },
      { idempotencyKey: undefined },
      { amount: undefined },
      { businessDate: undefined },
      { occurredAt: undefined },
      { id: undefined },
    ]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, ...patch },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
    // SALES_ALLOCATION without its source matrix is rejected.
    for (const patch of [
      { sourceEventId: null },
      { sourceAmount: null },
      { allocationRatePercent: null },
    ]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, ...patch },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
    // REVERSAL without a link is rejected.
    expect(
      validateTransportBudgetEvent(
        { ...validReversal, reversesEventId: null },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('rejects malformed kind (including case variants and speculation)', () => {
    for (const kind of [
      'sales_allocation',
      'Sales_Allocation',
      'ALLOCATION',
      'CONSUMPTION',
      'SALES_REFUND',
      '',
      null,
      42,
    ]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, kind },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects malformed amount', () => {
    for (const amount of ['15000', null, undefined, NaN, Infinity, 0]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, amount },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('enforces sign rules per kind', () => {
    // SALES_ALLOCATION must be positive.
    expect(
      validateTransportBudgetEvent({ ...baseAllocation, amount: -15000 }, NOW)
        .ok,
    ).toBe(false);
    // REVERSAL must be negative.
    expect(
      validateTransportBudgetEvent({ ...validReversal, amount: 15000 }, NOW).ok,
    ).toBe(false);
    // INBOUND_CONSUMPTION must be negative.
    expect(
      validateTransportBudgetEvent({ ...validInbound, amount: 5000 }, NOW).ok,
    ).toBe(false);
    // OUTBOUND_CONSUMPTION must be negative.
    expect(
      validateTransportBudgetEvent({ ...validOutbound, amount: 3000 }, NOW).ok,
    ).toBe(false);
  });

  it('rejects invalid business dates without timezone tricks', () => {
    for (const businessDate of [
      '2026-13-01',
      '2026-02-30',
      '2026-9-30',
      '30-09-2026',
      '2026/09/30',
      '2026-09-30T10:00:00Z',
      '',
      null,
    ]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, businessDate },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects invalid rates (and never calculates them)', () => {
    for (const allocationRatePercent of [-1, 100.01, NaN, Infinity, '3']) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, allocationRatePercent },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
    // Boundary rates are preserved exactly — 2.755 stays 2.755 (no rounding).
    const exact = validateTransportBudgetEvent(
      { ...baseAllocation, allocationRatePercent: 2.755 },
      NOW,
    );
    expect(exact.ok).toBe(true);
    if (exact.ok) expect(exact.event.allocationRatePercent).toBe(2.755);
    const zero = validateTransportBudgetEvent(
      { ...baseAllocation, allocationRatePercent: 0 },
      NOW,
    );
    expect(zero.ok).toBe(true);
  });

  it('rejects invalid idempotency keys', () => {
    for (const idempotencyKey of [
      '',
      '   ',
      'has space',
      'semi;colon',
      null,
      undefined,
      'x'.repeat(201),
    ]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, idempotencyKey },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('rejects invalid ids', () => {
    for (const id of ['', '   ', 'has space', null, undefined]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, id },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('forbids reversesEventId on non-reversals and self-references', () => {
    expect(
      validateTransportBudgetEvent(
        { ...baseAllocation, reversesEventId: 'evt-alloc-001' },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...validInbound, reversesEventId: 'evt-alloc-001' },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        {
          ...validReversal,
          id: 'evt-same',
          reversesEventId: 'evt-same',
        },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('forbids source fields and rate on REVERSAL', () => {
    expect(
      validateTransportBudgetEvent(
        { ...validReversal, sourceEventId: 'INV-1' },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...validReversal, sourceAmount: 100 },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...validReversal, allocationRatePercent: 3 },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('forbids allocation rate on consumptions', () => {
    expect(
      validateTransportBudgetEvent(
        { ...validInbound, allocationRatePercent: 3 },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...validOutbound, allocationRatePercent: 3 },
        NOW,
      ).ok,
    ).toBe(false);
  });

  it('quarantines accounting metadata (journalIds/accountSplits)', () => {
    expect(
      validateTransportBudgetEvent(
        { ...baseAllocation, journalIds: ['J-1'] },
        NOW,
      ).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...baseAllocation, accountSplits: [{ account: '41100' }] },
        NOW,
      ).ok,
    ).toBe(false);
    // Empty/omitted is the only accepted shape in Phase 4.
    expect(
      validateTransportBudgetEvent(
        { ...baseAllocation, journalIds: [], accountSplits: [] },
        NOW,
      ).ok,
    ).toBe(true);
  });

  it('rejects malformed method/provider values', () => {
    expect(
      validateTransportBudgetEvent({ ...baseAllocation, method: '' }, NOW).ok,
    ).toBe(true); // empty normalizes to null
    expect(
      validateTransportBudgetEvent({ ...baseAllocation, method: 'SALES_ALLOCATION' }, NOW)
        .ok,
    ).toBe(true);
    expect(
      validateTransportBudgetEvent({ ...baseAllocation, method: 'has space' }, NOW)
        .ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent(
        { ...baseAllocation, providerId: 'has space' },
        NOW,
      ).ok,
    ).toBe(false);
  });
});

describe('transportBudgetValidator — normalization', () => {
  it('rounds money to 2dp but preserves the rate exactly', () => {
    const result = validateTransportBudgetEvent(
      {
        ...baseAllocation,
        amount: 15000.005,
        sourceAmount: 500000.004,
        allocationRatePercent: 2.755,
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.amount).toBe(15000.01);
      expect(result.event.sourceAmount).toBe(500000);
      expect(result.event.allocationRatePercent).toBe(2.755);
    }
  });

  it('trims string identities', () => {
    const result = validateTransportBudgetEvent(
      {
        ...baseAllocation,
        id: '  evt-alloc-001  ',
        idempotencyKey: '  SALES_ALLOCATION:INV-0001  ',
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.id).toBe('evt-alloc-001');
      expect(result.event.idempotencyKey).toBe('SALES_ALLOCATION:INV-0001');
    }
  });

  it('assertValidTransportBudgetEvent throws a typed error', () => {
    expect(() =>
      assertValidTransportBudgetEvent({ ...baseAllocation, amount: -1 }, NOW),
    ).toThrow(TransportBudgetValidationError);
    try {
      assertValidTransportBudgetEvent({ ...baseAllocation, amount: -1 }, NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TransportBudgetValidationError);
      expect(
        (err as TransportBudgetValidationError).issues.length,
      ).toBeGreaterThan(0);
    }
  });

  it('sameEconomicPayload distinguishes retries from conflicts', () => {
    const a = assertValidTransportBudgetEvent(baseAllocation, NOW);
    const b = assertValidTransportBudgetEvent(
      { ...baseAllocation, createdAt: '2026-10-02T00:00:00.000Z' },
      NOW,
    );
    // Creation metadata is excluded: a true retry compares equal.
    expect(sameEconomicPayload(a, b)).toBe(true);
    expect(
      sameEconomicPayload(
        a,
        assertValidTransportBudgetEvent(
          { ...baseAllocation, amount: 15001 },
          NOW,
        ),
      ),
    ).toBe(false);
  });
});

describe('transportBudgetValidator — allocation-rate precision (Phase 4A)', () => {
  // Structural boundary only: 0..100 with at most 4 decimals. The ledger
  // never rounds, clamps, or consults configuration.
  it.each([0, 0.5, 1.25, 2.755, 2.7550, 100, 100.0000])(
    'accepts rate %s',
    (allocationRatePercent) => {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, allocationRatePercent },
        NOW,
      );
      expect(result.ok).toBe(true);
    },
  );

  it.each([-0.0001, 100.0001, 2.75501, 12.34567, NaN, Infinity, -Infinity])(
    'rejects rate %s without rounding it into validity',
    (allocationRatePercent) => {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, allocationRatePercent },
        NOW,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some((issue) => issue.code === 'INVALID_RATE'),
        ).toBe(true);
      }
    },
  );

  it('rejects non-numeric rates', () => {
    for (const allocationRatePercent of ['3', null, undefined, {}, []]) {
      const result = validateTransportBudgetEvent(
        { ...baseAllocation, allocationRatePercent },
        NOW,
      );
      expect(result.ok).toBe(false);
    }
  });

  it('preserves accepted rates exactly (no rounding, no clamping)', () => {
    const accepted = validateTransportBudgetEvent(
      { ...baseAllocation, allocationRatePercent: 2.755 },
      NOW,
    );
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.event.allocationRatePercent).toBe(2.755);
    }
  });

  it('does not apply the precision rule to money fields', () => {
    // 2.75501 as an AMOUNT is fine (rounded to 2dp); as a RATE it is not.
    const amountResult = validateTransportBudgetEvent(
      { ...baseAllocation, amount: 2.75501 },
      NOW,
    );
    expect(amountResult.ok).toBe(true);
    if (amountResult.ok) {
      expect(amountResult.event.amount).toBe(2.76);
    }
    expect(hasAllowedRatePrecision(2.755)).toBe(true);
    expect(hasAllowedRatePrecision(2.75501)).toBe(false);
    expect(hasAllowedRatePrecision(NaN)).toBe(false);
    expect(hasAllowedRatePrecision(Infinity)).toBe(false);
  });
});

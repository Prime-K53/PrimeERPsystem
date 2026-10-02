/**
 * Phase 5A — backend Transport Budget policy resolver parity tests.
 *
 * Proves the CJS resolver matches the Phase 3A frontend semantics
 * (frontend/utils/transportBudgetPolicy.ts): validation bounds/precision,
 * scheduled resolution by business date, and fail-closed invalid handling.
 * No current system date is used anywhere — all dates are fixed literals.
 */

const {
  hasAllowedRatePrecision,
  validateTransportBudgetPolicy,
  getTransportBudgetPolicyState,
  resolveTransportBudgetRate,
} = require('../services/transportBudgetPolicy.cjs');

describe('Phase 5A: transport budget policy parity (Phase 3A semantics)', () => {
  describe('rate precision gate (max 4 decimals)', () => {
    test('accepts 3%, 3.5%, 2.755%, 2.7550%', () => {
      expect(hasAllowedRatePrecision(3)).toBe(true);
      expect(hasAllowedRatePrecision(3.5)).toBe(true);
      expect(hasAllowedRatePrecision(2.755)).toBe(true);
      expect(hasAllowedRatePrecision(2.755)).toBe(true); // 2.7550 == 2.755
    });

    test('rejects 2.75501, 100.0001, -0.01, NaN, Infinity', () => {
      expect(hasAllowedRatePrecision(2.75501)).toBe(false);
      expect(100.0001).toBeGreaterThan(100); // bounds check below
      expect(hasAllowedRatePrecision(Number.NaN)).toBe(false);
      expect(hasAllowedRatePrecision(Infinity)).toBe(false);
      // -0.01 is finite with <=4dp: rejected by the RANGE gate, not precision.
      const negative = validateTransportBudgetPolicy({ allocationRatePercent: -0.01 });
      expect(negative.valid).toBe(false);
      expect(negative.errors.some((e) => /negative/.test(e.message))).toBe(true);
    });

    test('validateTransportBudgetPolicy rejects out-of-range/malformed rates without clamping', () => {
      for (const bad of [2.75501, 100.0001, -0.01, Number.NaN, Infinity, '3', null]) {
        const result = validateTransportBudgetPolicy({ allocationRatePercent: bad });
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      }
    });

    test('validateTransportBudgetPolicy accepts valid zero and positive rates', () => {
      expect(validateTransportBudgetPolicy({ allocationRatePercent: 0 }).valid).toBe(true);
      expect(validateTransportBudgetPolicy({ allocationRatePercent: 3 }).valid).toBe(true);
      expect(validateTransportBudgetPolicy({ allocationRatePercent: 2.755 }).valid).toBe(true);
      expect(validateTransportBudgetPolicy({ allocationRatePercent: 100 }).valid).toBe(true);
    });

    test('missing policy is valid-absent; non-object policy is invalid', () => {
      expect(validateTransportBudgetPolicy(undefined).valid).toBe(true);
      expect(validateTransportBudgetPolicy(null).valid).toBe(false);
      expect(validateTransportBudgetPolicy('3%').valid).toBe(false);
      expect(validateTransportBudgetPolicy([3]).valid).toBe(false);
    });

    test('duplicate scheduled effective dates are rejected (fail-closed ambiguity)', () => {
      const result = validateTransportBudgetPolicy({
        allocationRatePercent: 3,
        effectiveFrom: '2026-10-01',
        scheduledChanges: [
          { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
          { allocationRatePercent: 4, effectiveFrom: '2026-10-15' },
        ],
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('policy state (tri-state reader)', () => {
    test('missing / disabled / enabled / invalid', () => {
      expect(getTransportBudgetPolicyState(undefined)).toBe('missing');
      expect(getTransportBudgetPolicyState({})).toBe('missing');
      expect(getTransportBudgetPolicyState({ transportBudgetPolicy: { allocationRatePercent: 0 } })).toBe('disabled');
      expect(getTransportBudgetPolicyState({ transportBudgetPolicy: { allocationRatePercent: 3 } })).toBe('enabled');
      expect(getTransportBudgetPolicyState({ transportBudgetPolicy: { allocationRatePercent: 300 } })).toBe('invalid');
    });
  });

  describe('scheduled resolution (date-ordered, never future, never today)', () => {
    const schedule = {
      allocationRatePercent: 3,
      effectiveFrom: '2026-10-01',
      scheduledChanges: [
        { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
      ],
    };

    test('document dated 2026-10-10 resolves to 3%', () => {
      const r = resolveTransportBudgetRate(schedule, '2026-10-10');
      expect(r.status).toBe('enabled');
      expect(r.rate).toBe(3);
    });

    test('document dated 2026-10-20 resolves to 5%', () => {
      const r = resolveTransportBudgetRate(schedule, '2026-10-20');
      expect(r.status).toBe('enabled');
      expect(r.rate).toBe(5);
    });

    test('document dated 2026-11-01 resolves to 2.5%', () => {
      const r = resolveTransportBudgetRate(schedule, '2026-11-01');
      expect(r.status).toBe('enabled');
      expect(r.rate).toBe(2.5);
    });

    test('document before the first effective date has no applicable entry (missing)', () => {
      const r = resolveTransportBudgetRate(schedule, '2026-09-30');
      expect(r.status).toBe('missing');
    });

    test('a future rate is never used for an earlier document', () => {
      // 2026-10-14 is one day before the 5% change takes effect.
      const r = resolveTransportBudgetRate(schedule, '2026-10-14');
      expect(r.rate).toBe(3);
    });

    test('resolution is deterministic regardless of scheduled array order', () => {
      const shuffled = {
        allocationRatePercent: 3,
        effectiveFrom: '2026-10-01',
        scheduledChanges: [
          { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
          { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        ],
      };
      expect(resolveTransportBudgetRate(shuffled, '2026-10-20').rate).toBe(5);
      expect(resolveTransportBudgetRate(shuffled, '2026-10-20').rate)
        .toBe(resolveTransportBudgetRate(schedule, '2026-10-20').rate);
    });

    test('undated base policy applies to every business date', () => {
      const undated = { allocationRatePercent: 2.755 };
      expect(resolveTransportBudgetRate(undated, '2020-01-01').rate).toBe(2.755);
      expect(resolveTransportBudgetRate(undated, '2030-12-31').rate).toBe(2.755);
    });

    test('0% winner is the disabled state (valid, not an error)', () => {
      const r = resolveTransportBudgetRate(
        {
          allocationRatePercent: 3,
          effectiveFrom: '2026-10-01',
          scheduledChanges: [{ allocationRatePercent: 0, effectiveFrom: '2026-10-15' }],
        },
        '2026-10-16',
      );
      expect(r.status).toBe('disabled');
      expect(r.rate).toBe(0);
    });

    test('invalid policy and invalid business date fail closed as invalid', () => {
      expect(resolveTransportBudgetRate({ allocationRatePercent: 300 }, '2026-10-01').status).toBe('invalid');
      expect(resolveTransportBudgetRate(schedule, '2026-10-1').status).toBe('invalid');
      expect(resolveTransportBudgetRate(schedule, 'not-a-date').status).toBe('invalid');
      expect(resolveTransportBudgetRate(undefined, '2026-10-01').status).toBe('missing');
    });
  });
});

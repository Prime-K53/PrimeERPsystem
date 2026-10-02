import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock('../../../services/db', () => ({
  dbService: {
    getSetting: mocks.getSetting,
    saveSetting: mocks.saveSetting,
  },
}));

vi.mock('../../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    enqueue: vi.fn().mockResolvedValue({ id: 'q-1' }),
  },
}));

vi.mock('../../../services/backgroundSyncService', () => ({
  backgroundSyncService: {
    trigger: vi.fn().mockResolvedValue(null),
  },
}));

import {
  COMPANY_CONFIG_SETTINGS_KEY,
  normalizeStoredCompanyConfig,
  loadStoredCompanyConfig,
  persistCompanyConfig,
} from '../../../utils/companyConfigSync';
import {
  TransportBudgetPolicyValidator,
  getTransportBudgetPolicyState,
  hasAllowedRatePrecision,
  normalizeTransportBudgetPolicy,
  parseTransportBudgetRateInput,
  resolveTransportBudgetPolicyDraft,
  resolveTransportBudgetRate,
  validateTransportBudgetPolicy,
} from '../../../utils/transportBudgetPolicy';

const defaults: any = {
  companyName: 'Prime Company',
  transactionSettings: { numbering: { shared: { prefix: 'INV', padding: 4 } } },
  vat: { enabled: false, rate: 0 },
  pricingSettings: { roundingMethod: 'Nearest', defaultMarkup: 25 },
};

let storageBacking: Record<string, unknown>;

beforeEach(() => {
  mocks.getSetting.mockReset();
  mocks.saveSetting.mockReset();
  storageBacking = {};
  mocks.getSetting.mockImplementation(async (key: string) => storageBacking[key]);
  mocks.saveSetting.mockImplementation(async (key: string, value: unknown) => {
    storageBacking[key] = value;
  });
});

describe('transport budget policy — validation boundaries', () => {
  it('1. missing policy is valid (disabled, not an error)', () => {
    expect(validateTransportBudgetPolicy(undefined).valid).toBe(true);
    expect(getTransportBudgetPolicyState({})).toBe('missing');
    expect(getTransportBudgetPolicyState(null)).toBe('missing');
  });

  it('2. 0% policy is valid and reads as disabled', () => {
    const policy = { allocationRatePercent: 0 };
    expect(validateTransportBudgetPolicy(policy).valid).toBe(true);
    expect(getTransportBudgetPolicyState({ transportBudgetPolicy: policy })).toBe('disabled');
  });

  it('3. valid integer rate is accepted and enabled', () => {
    const policy = { allocationRatePercent: 3 };
    expect(validateTransportBudgetPolicy(policy).valid).toBe(true);
    expect(getTransportBudgetPolicyState({ transportBudgetPolicy: policy })).toBe('enabled');
    expect(TransportBudgetPolicyValidator.validate(policy).valid).toBe(true);
  });

  it('4. valid decimal rates are accepted exactly', () => {
    for (const rate of [0.5, 1.25, 2.755, 3.0, 3.0000, 100, 100.0, 100.0000]) {
      expect(validateTransportBudgetPolicy({ allocationRatePercent: rate }).valid).toBe(true);
    }
  });

  it('5. maximum 100% is accepted', () => {
    expect(validateTransportBudgetPolicy({ allocationRatePercent: 100 }).valid).toBe(true);
  });

  it('6. negative rate is rejected (never coerced to 0)', () => {
    for (const rate of [-1, -0.0001, -100]) {
      const result = validateTransportBudgetPolicy({ allocationRatePercent: rate });
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe('transportBudgetPolicy.allocationRatePercent');
    }
  });

  it('7. rate above 100 is rejected (never clamped to 100)', () => {
    for (const rate of [100.0001, 101, 1000]) {
      expect(validateTransportBudgetPolicy({ allocationRatePercent: rate }).valid).toBe(false);
    }
  });

  it('8. NaN is rejected', () => {
    expect(validateTransportBudgetPolicy({ allocationRatePercent: NaN }).valid).toBe(false);
  });

  it('9. Infinity is rejected', () => {
    expect(validateTransportBudgetPolicy({ allocationRatePercent: Infinity }).valid).toBe(false);
    expect(validateTransportBudgetPolicy({ allocationRatePercent: -Infinity }).valid).toBe(false);
  });

  it('10. precision boundary: 4 decimals valid, 5 decimals invalid, stored rate never rounded', () => {
    expect(hasAllowedRatePrecision(2.755)).toBe(true);
    expect(hasAllowedRatePrecision(2.7550)).toBe(true);
    expect(hasAllowedRatePrecision(0.0001)).toBe(true);
    expect(hasAllowedRatePrecision(12.34567)).toBe(false);
    expect(validateTransportBudgetPolicy({ allocationRatePercent: 2.755 }).valid).toBe(true);
    expect(validateTransportBudgetPolicy({ allocationRatePercent: 2.75555 }).valid).toBe(false);
    // Normalization preserves the exact rate — no rounding down for storage.
    expect(normalizeTransportBudgetPolicy({ allocationRatePercent: 2.755 })).toEqual({
      allocationRatePercent: 2.755,
    });
    // Malformed input types are rejected, not parsed.
    expect(validateTransportBudgetPolicy({ allocationRatePercent: '3' }).valid).toBe(false);
    expect(validateTransportBudgetPolicy(null).valid).toBe(false);
    expect(validateTransportBudgetPolicy([]).valid).toBe(false);
  });
});

describe('transport budget policy — persistence and normalization', () => {
  it('11. CompanyConfig round-trip preserves the policy exactly', async () => {
    const stored = {
      companyName: 'Acme',
      transportBudgetPolicy: { allocationRatePercent: 2.755, effectiveFrom: '2026-10-01' },
    };
    await persistCompanyConfig(stored as any);
    expect(mocks.saveSetting).toHaveBeenCalledTimes(1);
    expect(mocks.saveSetting).toHaveBeenCalledWith(COMPANY_CONFIG_SETTINGS_KEY, stored);
    // Single settings key — no parallel transport key or table.
    for (const call of mocks.saveSetting.mock.calls) {
      expect(String(call[0])).toBe(COMPANY_CONFIG_SETTINGS_KEY);
    }
    const loaded = await loadStoredCompanyConfig(defaults);
    expect(loaded?.transportBudgetPolicy).toEqual({
      allocationRatePercent: 2.755,
      effectiveFrom: '2026-10-01',
    });
  });

  it('12. old CompanyConfig without transport policy stays valid and gains no key', () => {
    const legacy = { companyName: 'Legacy Co', vat: { enabled: false, rate: 0 } };
    const merged = normalizeStoredCompanyConfig(legacy, defaults)!;
    expect(merged.companyName).toBe('Legacy Co');
    expect('transportBudgetPolicy' in merged).toBe(false);
    expect(getTransportBudgetPolicyState(merged)).toBe('missing');
  });

  it('13. unrelated CompanyConfig fields are preserved when policy is set', () => {
    const merged = normalizeStoredCompanyConfig(
      {
        companyName: 'Acme',
        monthlyRevenueTarget: 50000,
        vat: { enabled: false, rate: 0 },
        transportBudgetPolicy: { allocationRatePercent: 3 },
      },
      defaults
    )!;
    expect(merged.companyName).toBe('Acme');
    expect((merged as any).monthlyRevenueTarget).toBe(50000);
    expect(merged.transportBudgetPolicy).toEqual({ allocationRatePercent: 3 });
  });

  it('14. offline-first persistence uses the existing settings path only', async () => {
    // persistCompanyConfig writes through dbService.saveSetting (IndexedDB +
    // localStorage mirror + durable sync queue in the real implementation).
    await persistCompanyConfig({
      companyName: 'Offline Co',
      transportBudgetPolicy: { allocationRatePercent: 3 },
    } as any);
    const saved = storageBacking[COMPANY_CONFIG_SETTINGS_KEY] as any;
    expect(saved.transportBudgetPolicy).toEqual({ allocationRatePercent: 3 });
    // Load path reads the same key back with no network involved.
    const loaded = await loadStoredCompanyConfig(defaults);
    expect(loaded?.transportBudgetPolicy).toEqual({ allocationRatePercent: 3 });
  });

  it('15. synchronization compatibility: policy rides inside companyConfig, no new store', async () => {
    await persistCompanyConfig({
      companyName: 'Sync Co',
      transportBudgetPolicy: { allocationRatePercent: 1.25 },
    } as any);
    // Exactly one settings-key write; the policy is nested metadata, so the
    // existing companyConfig sync row carries it to other devices unchanged.
    expect(mocks.saveSetting).toHaveBeenCalledTimes(1);
    const [key, value] = mocks.saveSetting.mock.calls[0] as [string, any];
    expect(key).toBe('companyConfig');
    expect(value.transportBudgetPolicy).toEqual({ allocationRatePercent: 1.25 });
    expect(Object.keys(storageBacking)).toEqual([COMPANY_CONFIG_SETTINGS_KEY]);
  });

  it('malformed stored policy can never silently enable a rate', () => {
    for (const bad of [
      { allocationRatePercent: -1 },
      { allocationRatePercent: 101 },
      { allocationRatePercent: NaN },
      { allocationRatePercent: '3' },
      'policy-string',
      42,
    ]) {
      const merged = normalizeStoredCompanyConfig(
        { companyName: 'Acme', transportBudgetPolicy: bad },
        defaults
      )!;
      expect('transportBudgetPolicy' in merged).toBe(false);
      expect(getTransportBudgetPolicyState(merged)).toBe('missing');
    }
  });
});

describe('transport budget policy — effectiveFrom', () => {
  it('16. effectiveFrom accepts calendar YYYY-MM-DD and rejects ambiguous values', () => {
    expect(
      validateTransportBudgetPolicy({ allocationRatePercent: 3, effectiveFrom: '2026-10-01' }).valid
    ).toBe(true);
    for (const bad of ['10/01/2026', '2026-13-01', '2026-02-30', 'tomorrow', '2026-1-1', 20261001]) {
      expect(
        validateTransportBudgetPolicy({ allocationRatePercent: 3, effectiveFrom: bad }).valid
      ).toBe(false);
    }
    // Absent date stays absent (applies immediately); empty string normalizes away.
    expect(normalizeTransportBudgetPolicy({ allocationRatePercent: 3 })).toEqual({
      allocationRatePercent: 3,
    });
  });

  it('draft resolution: cleared rate removes policy, date-without-rate is rejected', () => {
    expect(resolveTransportBudgetPolicyDraft('', '')).toEqual({ policy: undefined, errors: {} });
    expect(resolveTransportBudgetPolicyDraft('   ', '')).toEqual({ policy: undefined, errors: {} });
    expect(resolveTransportBudgetPolicyDraft('3', '')).toEqual({
      policy: { allocationRatePercent: 3 },
      errors: {},
    });
    expect(resolveTransportBudgetPolicyDraft('2.755', '2026-10-01')).toEqual({
      policy: { allocationRatePercent: 2.755, effectiveFrom: '2026-10-01' },
      errors: {},
    });
    const dateOnly = resolveTransportBudgetPolicyDraft('', '2026-10-01');
    expect(dateOnly.policy).toBeUndefined();
    expect(dateOnly.errors['transportBudgetPolicy.effectiveFrom']).toBeTruthy();
    const badRate = resolveTransportBudgetPolicyDraft('-1', '');
    expect(badRate.policy).toBeUndefined();
    expect(badRate.errors['transportBudgetPolicy.allocationRatePercent']).toBeTruthy();
  });

  it('rate text parsing never coerces malformed input', () => {
    expect(parseTransportBudgetRateInput('abc').error).toBeTruthy();
    expect(parseTransportBudgetRateInput('--3').error).toBeTruthy();
    expect(parseTransportBudgetRateInput('').cleared).toBe(true);
    expect(parseTransportBudgetRateInput('3').value).toBe(3);
    expect(parseTransportBudgetRateInput(' 2.755 ').value).toBe(2.755);
    expect(parseTransportBudgetRateInput('101').error).toBeTruthy();
  });
});

describe('transport budget policy — Phase 3A scheduling', () => {
  const scheduled = {
    allocationRatePercent: 3,
    effectiveFrom: '2026-10-01',
    scheduledChanges: [
      { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
      { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
    ],
  };

  it('legacy Phase 3 shapes remain valid (no migration required)', () => {
    expect(validateTransportBudgetPolicy({ allocationRatePercent: 3 }).valid).toBe(true);
    expect(
      validateTransportBudgetPolicy({ allocationRatePercent: 3, effectiveFrom: '2026-10-01' }).valid
    ).toBe(true);
    expect(normalizeTransportBudgetPolicy({ allocationRatePercent: 3 })).toEqual({
      allocationRatePercent: 3,
    });
    // Legacy resolution: undated base applies to every business date.
    expect(resolveTransportBudgetRate({ allocationRatePercent: 3 }, '2026-10-10')).toEqual({
      status: 'enabled',
      rate: 3,
    });
    expect(
      resolveTransportBudgetRate(
        { allocationRatePercent: 3, effectiveFrom: '2026-10-01' },
        '2026-09-30'
      )
    ).toEqual({ status: 'missing' });
  });

  it('date validation: leap years, invalid days, timezone-like values', () => {
    expect(
      validateTransportBudgetPolicy({ allocationRatePercent: 3, effectiveFrom: '2024-02-29' }).valid
    ).toBe(true);
    for (const bad of [
      '2026-02-29',
      '2026-04-31',
      '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00Z',
      '2026-10-01 00:00',
      '10/01/2026',
      '2026-1-1',
      'not-a-date',
    ]) {
      expect(
        validateTransportBudgetPolicy({ allocationRatePercent: 3, effectiveFrom: bad }).valid
      ).toBe(false);
    }
    expect(
      validateTransportBudgetPolicy({
        allocationRatePercent: 3,
        scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-15T00:00Z' }],
      }).valid
    ).toBe(false);
  });

  it('resolution follows the frozen business-date table', () => {
    expect(resolveTransportBudgetRate(scheduled, '2026-09-30')).toEqual({ status: 'missing' });
    expect(resolveTransportBudgetRate(scheduled, '2026-10-01')).toEqual({
      status: 'enabled',
      rate: 3,
      effectiveFrom: '2026-10-01',
    });
    expect(resolveTransportBudgetRate(scheduled, '2026-10-10')).toEqual({
      status: 'enabled',
      rate: 3,
      effectiveFrom: '2026-10-01',
    });
    expect(resolveTransportBudgetRate(scheduled, '2026-10-15')).toEqual({
      status: 'enabled',
      rate: 5,
      effectiveFrom: '2026-10-15',
    });
    expect(resolveTransportBudgetRate(scheduled, '2026-10-31')).toEqual({
      status: 'enabled',
      rate: 5,
      effectiveFrom: '2026-10-15',
    });
    expect(resolveTransportBudgetRate(scheduled, '2026-11-01')).toEqual({
      status: 'enabled',
      rate: 2.5,
      effectiveFrom: '2026-11-01',
    });
    expect(resolveTransportBudgetRate(scheduled, '2027-05-20')).toEqual({
      status: 'enabled',
      rate: 2.5,
      effectiveFrom: '2026-11-01',
    });
  });

  it('multiple future changes resolve independently of array order', () => {
    const shuffled = {
      ...scheduled,
      scheduledChanges: [...scheduled.scheduledChanges].reverse(),
    };
    // Validation accepts any order (uniqueness is what matters)…
    expect(validateTransportBudgetPolicy(shuffled).valid).toBe(true);
    // …and normalization sorts deterministically.
    expect(normalizeTransportBudgetPolicy(shuffled)).toEqual(scheduled);
    // Resolution never depends on insertion order.
    expect(resolveTransportBudgetRate(shuffled, '2026-10-20')).toEqual({
      status: 'enabled',
      rate: 5,
      effectiveFrom: '2026-10-15',
    });
  });

  it('duplicate effective dates are rejected, never silently ordered', () => {
    const dupes = {
      allocationRatePercent: 3,
      scheduledChanges: [
        { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        { allocationRatePercent: 4, effectiveFrom: '2026-10-15' },
      ],
    };
    const result = validateTransportBudgetPolicy(dupes);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
    // A duplicate against the base effective date is rejected too.
    expect(
      validateTransportBudgetPolicy({
        allocationRatePercent: 3,
        effectiveFrom: '2026-10-15',
        scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-15' }],
      }).valid
    ).toBe(false);
    // Normalization fails closed: the ambiguous date is dropped entirely.
    expect(normalizeTransportBudgetPolicy(dupes)).toEqual({ allocationRatePercent: 3 });
    // Draft resolution surfaces the duplicate as a field error.
    const draft = resolveTransportBudgetPolicyDraft('3', '', [
      { rate: '5', effectiveFrom: '2026-10-15' },
      { rate: '4', effectiveFrom: '2026-10-15' },
    ]);
    expect(draft.policy).toBeUndefined();
    expect(Object.keys(draft.errors).length).toBeGreaterThan(0);
  });

  it('scheduled 0% disables from its date without touching earlier rates', () => {
    const policy = {
      allocationRatePercent: 3,
      effectiveFrom: '2026-10-01',
      scheduledChanges: [{ allocationRatePercent: 0, effectiveFrom: '2026-11-01' }],
    };
    expect(validateTransportBudgetPolicy(policy).valid).toBe(true);
    expect(resolveTransportBudgetRate(policy, '2026-10-20')).toEqual({
      status: 'enabled',
      rate: 3,
      effectiveFrom: '2026-10-01',
    });
    expect(resolveTransportBudgetRate(policy, '2026-11-01')).toEqual({
      status: 'disabled',
      rate: 0,
      effectiveFrom: '2026-11-01',
    });
  });

  it('malformed business dates and policies resolve to invalid, never a rate', () => {
    expect(resolveTransportBudgetRate(scheduled, 'not-a-date')).toEqual({ status: 'invalid' });
    expect(resolveTransportBudgetRate(scheduled, '2026-10-01T00:00Z')).toEqual({ status: 'invalid' });
    expect(resolveTransportBudgetRate(undefined, 'not-a-date')).toEqual({ status: 'invalid' });
    expect(resolveTransportBudgetRate(undefined, '2026-10-10')).toEqual({ status: 'missing' });
    expect(
      resolveTransportBudgetRate({ allocationRatePercent: -1 }, '2026-10-10')
    ).toEqual({ status: 'invalid' });
  });

  it('draft resolution supports scheduled rows strictly', () => {
    expect(
      resolveTransportBudgetPolicyDraft('3', '', [
        { rate: '5', effectiveFrom: '2026-10-15' },
        { rate: '2.5', effectiveFrom: '2026-11-01' },
      ])
    ).toEqual({
      policy: {
        allocationRatePercent: 3,
        scheduledChanges: [
          { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
          { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
        ],
      },
      errors: {},
    });
    // Half-filled rows are rejected, never silently dropped.
    const half = resolveTransportBudgetPolicyDraft('3', '', [{ rate: '', effectiveFrom: '' }]);
    expect(half.policy).toBeUndefined();
    // Scheduled rows without a current rate are rejected.
    const orphan = resolveTransportBudgetPolicyDraft('', '', [
      { rate: '5', effectiveFrom: '2026-10-15' },
    ]);
    expect(orphan.policy).toBeUndefined();
    expect(orphan.errors['transportBudgetPolicy.allocationRatePercent']).toBeTruthy();
    // Invalid scheduled rate is rejected at its indexed path.
    const badRate = resolveTransportBudgetPolicyDraft('3', '', [
      { rate: '-1', effectiveFrom: '2026-10-15' },
    ]);
    expect(badRate.policy).toBeUndefined();
    expect(
      badRate.errors['transportBudgetPolicy.scheduledChanges.0.allocationRatePercent']
    ).toBeTruthy();
  });
});

describe('transport budget policy — Phase 3A persistence and side-effect guard', () => {
  it('scheduled policy round-trips through save/normalize/reload deterministically', async () => {
    const stored = {
      companyName: 'Schedule Co',
      transportBudgetPolicy: {
        allocationRatePercent: 3,
        effectiveFrom: '2026-10-01',
        // Deliberately unsorted: normalization must sort by date.
        scheduledChanges: [
          { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
          { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        ],
      },
    };
    await persistCompanyConfig(stored as any);
    const loaded = await loadStoredCompanyConfig(defaults);
    expect(loaded?.transportBudgetPolicy).toEqual({
      allocationRatePercent: 3,
      effectiveFrom: '2026-10-01',
      scheduledChanges: [
        { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        { allocationRatePercent: 2.5, effectiveFrom: '2026-11-01' },
      ],
    });
    // The earlier rate survived scheduling: resolution still finds 3% for Oct 10.
    expect(resolveTransportBudgetRate(loaded?.transportBudgetPolicy, '2026-10-10')).toEqual({
      status: 'enabled',
      rate: 3,
      effectiveFrom: '2026-10-01',
    });
  });

  it('unrelated CompanyConfig fields survive scheduled policy updates', () => {
    const merged = normalizeStoredCompanyConfig(
      {
        companyName: 'Acme',
        monthlyRevenueTarget: 50000,
        vat: { enabled: false, rate: 0 },
        transportBudgetPolicy: {
          allocationRatePercent: 3,
          scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-15' }],
        },
      },
      defaults
    )!;
    expect((merged as any).monthlyRevenueTarget).toBe(50000);
    expect(merged.transportBudgetPolicy?.scheduledChanges).toEqual([
      { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
    ]);
  });

  it('nested schedule stays usable offline and inside the single settings key', async () => {
    await persistCompanyConfig({
      companyName: 'Offline Co',
      transportBudgetPolicy: {
        allocationRatePercent: 3,
        scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-15' }],
      },
    } as any);
    expect(Object.keys(storageBacking)).toEqual([COMPANY_CONFIG_SETTINGS_KEY]);
    const loaded = await loadStoredCompanyConfig(defaults);
    expect(
      resolveTransportBudgetRate(loaded?.transportBudgetPolicy, '2026-10-20')
    ).toEqual({ status: 'enabled', rate: 5, effectiveFrom: '2026-10-15' });
  });

  it('resolution and scheduling create no allocation, ledger, or customer side effects', () => {
    mocks.saveSetting.mockClear();
    const before = { ...storageBacking };
    const policy = {
      allocationRatePercent: 3,
      effectiveFrom: '2026-10-01',
      scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-15' }],
    };
    const resolution = resolveTransportBudgetRate(policy, '2026-10-20');
    const normalized = normalizeTransportBudgetPolicy(policy);
    const draft = resolveTransportBudgetPolicyDraft('3', '2026-10-01', [
      { rate: '5', effectiveFrom: '2026-10-15' },
    ]);
    // Pure reads: no persistence calls, no stored-state mutation.
    expect(mocks.saveSetting).not.toHaveBeenCalled();
    expect(storageBacking).toEqual(before);
    // No allocation amount, journal, ledger, invoice, or customer payload.
    for (const value of [resolution, normalized, draft.policy]) {
      expect(value).toBeDefined();
      const keys = Object.keys(value as Record<string, unknown>);
      for (const forbidden of [
        'allocationAmount',
        'journalId',
        'journalIds',
        'ledgerEntries',
        'invoice',
        'customer',
        'debitAccountId',
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
    expect(resolution).toEqual({ status: 'enabled', rate: 5, effectiveFrom: '2026-10-15' });
  });
});

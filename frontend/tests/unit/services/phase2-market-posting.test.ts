import { describe, it, expect } from 'vitest';
import { decideMarketPosting } from '../../../services/marketPosting';
import {
  isAssetAccount,
  isIncomeAccount,
  isLiabilityAccount,
  normalizeAccountType,
} from '../../../utils/accountType';

describe('Phase 2 — decideMarketPosting (B2)', () => {
  const ok = (id: string) => id;

  it('splits when market mode is on and the account resolves', () => {
    expect(
      decideMarketPosting({
        isMarketMode: true,
        adjustmentTotal: 200,
        configuredAccountId: 'mkt-1',
        resolveAccount: ok,
      })
    ).toEqual({ marketAmount: 200, marketAccountId: 'mkt-1', unpostedAmount: 0 });
  });

  it('keeps the full amount in revenue when the account is unset', () => {
    expect(
      decideMarketPosting({
        isMarketMode: true,
        adjustmentTotal: 200,
        configuredAccountId: '',
        resolveAccount: ok,
      })
    ).toEqual({ marketAmount: 0, marketAccountId: null, unpostedAmount: 200 });
  });

  it('keeps the full amount in revenue when the account does not resolve', () => {
    expect(
      decideMarketPosting({
        isMarketMode: true,
        adjustmentTotal: 200,
        configuredAccountId: 'mkt-1',
        resolveAccount: () => null,
      })
    ).toEqual({ marketAmount: 0, marketAccountId: null, unpostedAmount: 200 });
  });

  it('never splits outside market mode or for non-positive amounts', () => {
    expect(
      decideMarketPosting({ isMarketMode: false, adjustmentTotal: 200, configuredAccountId: 'mkt-1', resolveAccount: ok })
    ).toEqual({ marketAmount: 0, marketAccountId: null, unpostedAmount: 0 });
    expect(
      decideMarketPosting({ isMarketMode: true, adjustmentTotal: 0, configuredAccountId: 'mkt-1', resolveAccount: ok })
    ).toEqual({ marketAmount: 0, marketAccountId: null, unpostedAmount: 0 });
  });

  it('uses the original sale account for refunds (snapshot over current config)', () => {
    // Refund path passes the snapshot id as configuredAccountId.
    const decision = decideMarketPosting({
      isMarketMode: true,
      adjustmentTotal: 50,
      configuredAccountId: 'snapshot-acct',
      resolveAccount: (id) => (id === 'snapshot-acct' ? id : null),
    });
    expect(decision.marketAccountId).toBe('snapshot-acct');
  });
});

describe('Phase 2 — account-type filters (A8)', () => {
  it('treats canonical INCOME and legacy Revenue as income', () => {
    expect(normalizeAccountType({ account_type: 'INCOME' })).toBe('INCOME');
    expect(normalizeAccountType({ type: 'Revenue' })).toBe('REVENUE');
    expect(isIncomeAccount({ account_type: 'INCOME', type: 'Asset' })).toBe(true);
    expect(isIncomeAccount({ type: 'Revenue' })).toBe(true);
    expect(isIncomeAccount({ account_type: 'ASSET', type: 'Asset' })).toBe(false);
  });

  it('matches VatSettings filters case-insensitively', () => {
    expect(isLiabilityAccount({ account_type: 'LIABILITY' })).toBe(true);
    expect(isLiabilityAccount({ type: 'Liability' })).toBe(true);
    expect(isAssetAccount({ account_type: 'ASSET' })).toBe(true);
    expect(isAssetAccount({ type: 'Asset' })).toBe(true);
  });
});

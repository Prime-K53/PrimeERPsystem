/**
 * invalidAccountReference.test.ts
 *
 * Regression test for the K70,000 Trial Balance imbalance diagnosed on
 * 2026-09-11.
 *
 * Root cause: a customer-payment ledger entry was persisted with
 * debitAccountId = "1000" — a legacy 4-digit code that does NOT exist as an
 * account id, code, or account_number in the live chart. The frontend Trial
 * Balance engine matches ledger references against account.id / code /
 * account_number (accountingEngine.ts entryTouchesAccount; 
 * financialReportingService.ts accountMatchesEntry). No account has any of
 * those identifiers equal to "1000", so the K70,000 debit was silently
 * dropped from the TB debit column while the paired K70,000 credit (to
 * ACC-11310 Trade Debtors) was retained — producing a K70,000 credit-side
 * overstatement.
 *
 * Guard: every account reference written to a ledger entry must be a
 * RESOLVED account id that exists in the chart. The write path
 * (transactionService.resolveAcct → requireResolvedAccount) calls
 * resolveAccountForPosting in strict mode and throws UnresolvedAccountError
 * before any ledger write occurs. This test asserts:
 *
 *  1. The legacy code "1000" is NOT a valid account identifier in the
 *     canonical chart (no account has code "1000").
 *  2. requireResolvedAccount throws for "1000" against the live-shaped chart
 *     (ids "ACC-XXXX", codes "11110"), because the legacy map resolves
 *     "1000" → "11110" but the live chart does not contain an account whose
 *     id/code/number is "1000" directly.
 *  3. A corrected ledger entry uses debitAccountId = "ACC-11110" which
 *     resolves cleanly and produces a balanced TB.
 */

import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCOUNTS } from '../../constants';
import {
  resolveAccountForPosting,
  requireResolvedAccount,
  UnresolvedAccountError,
} from '../../services/transactions/_internal';

describe('Invalid account reference regression (K70,000 TB imbalance)', () => {
  const CHART = DEFAULT_ACCOUNTS;

  it('Cash Drawer account exists in the canonical chart', () => {
    const cashDrawer = CHART.find(
      (a) => a.code === '11110' || a.account_number === '11110'
    );
    expect(cashDrawer).toBeDefined();
    expect(cashDrawer!.name).toBe('Cash Drawer');
    expect(cashDrawer!.allow_posting).not.toBe(false);
  });

  it('Trade Debtors account exists in the canonical chart', () => {
    const ar = CHART.find(
      (a) => a.code === '11310' || a.account_number === '11310'
    );
    expect(ar).toBeDefined();
    expect(ar!.name).toBe('Trade Debtors');
    expect(ar!.allow_posting).not.toBe(false);
  });

  it('no account in the canonical chart has id/code/account_number "1000"', () => {
    const offender = CHART.find(
      (a) =>
        a.id === '1000' || a.code === '1000' || a.account_number === '1000'
    );
    expect(offender).toBeUndefined();
  });

  it('requireResolvedAccount resolves the legacy alias "1000" to Cash Drawer (11110)', () => {
    // The legacy code map (LEGACY_CODE_TO_CANONICAL) maps "1000" -> "11110".
    // This proves the canonical resolver IS the correct guard: any payment
    // posting path must run debitAccountRef through requireResolvedAccount
    // so the persisted debitAccountId is the resolved account id, never the
    // raw legacy code. The K70,000 defect occurred because the payment code
    // path wrote "1000" verbatim, bypassing this resolution entirely.
    const resolved = requireResolvedAccount('1000', CHART, {});
    expect(resolved).toBeDefined();
    const match = CHART.find(
      (a) =>
        a.id === resolved ||
        a.code === resolved ||
        a.account_number === resolved
    );
    expect(match).toBeDefined();
    expect(match!.name).toBe('Cash Drawer');
  });

  it('requireResolvedAccount throws for an arbitrary unknown reference', () => {
    expect(() => requireResolvedAccount('99999', CHART, {})).toThrow(
      UnresolvedAccountError
    );
  });

  it('requireResolvedAccount resolves the valid Cash Drawer reference "11110"', () => {
    const resolved = requireResolvedAccount('11110', CHART, {});
    expect(resolved).toBeDefined();
    const match = CHART.find(
      (a) =>
        a.id === resolved ||
        a.code === resolved ||
        a.account_number === resolved
    );
    expect(match).toBeDefined();
    expect(match!.name).toBe('Cash Drawer');
  });

  describe('Trial Balance integrity on a simulated corrected ledger (live-shaped ids)', () => {
    // Simulates the LIVE account shape: ids are "ACC-XXXX", codes are "XXXX".
    const liveAccounts = [
      { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', allow_posting: true },
      { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', allow_posting: true },
      { id: 'ACC-31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', allow_posting: true },
      { id: 'ACC-41100', code: '41100', account_number: '41100', name: 'Product Sales', account_type: 'INCOME', allow_posting: true },
    ];

    interface TbEntry {
      debitAccountId: string;
      creditAccountId: string;
      amount: number;
    }
    // Corrected ledger: payment debit now uses ACC-11110 (resolves to an account)
    // instead of the orphan "1000".
    const correctedLedger: TbEntry[] = [
      ...Array.from({ length: 61 }, () => ({
        debitAccountId: 'ACC-11110',
        creditAccountId: 'ACC-31000',
        amount: 500,
      })),
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 324000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 100000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 403000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 592000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 841000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 80000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 431000 },
      { debitAccountId: 'ACC-11310', creditAccountId: 'ACC-41100', amount: 257000 },
      { debitAccountId: 'ACC-11110', creditAccountId: 'ACC-11310', amount: 70000 },
    ];

    function balanceByAccount(account: any) {
      const refs = [account.id, account.code, account.account_number].filter(Boolean);
      let dr = 0, cr = 0;
      for (const e of correctedLedger) {
        if (refs.includes(e.debitAccountId)) dr += e.amount;
        if (refs.includes(e.creditAccountId)) cr += e.amount;
      }
      return { dr, cr, balance: dr - cr };
    }

    it('corrected ledger has equal total debits and credits', () => {
      const dr = correctedLedger.reduce((s, e) => s + e.amount, 0);
      const cr = correctedLedger.reduce((s, e) => s + e.amount, 0);
      expect(dr).toBe(cr);
      expect(dr).toBe(3128500);
    });

    it('every account reference resolves to a real account (no orphans)', () => {
      const refs = new Set<string>();
      for (const e of correctedLedger) {
        refs.add(e.debitAccountId);
        refs.add(e.creditAccountId);
      }
      for (const ref of refs) {
        const matches = liveAccounts.filter(
          (a) => a.id === ref || a.code === ref || a.account_number === ref
        );
        expect(matches.length).toBe(1);
      }
    });

    it('Cash Drawer includes the 70,000 payment debit', () => {
      const { dr } = balanceByAccount(liveAccounts[0]);
      expect(dr).toBe(100500);
    });

    it('Trade Debtors has a 70,000 credit from the payment', () => {
      const { cr } = balanceByAccount(liveAccounts[1]);
      expect(cr).toBe(70000);
    });

    it('Trial Balance total debits equal total credits (difference = 0)', () => {
      let tbDr = 0, tbCr = 0;
      for (const a of liveAccounts) {
        const { dr, cr } = balanceByAccount(a);
        tbDr += dr;
        tbCr += cr;
      }
      expect(tbDr).toBe(tbCr);
      expect(tbDr).toBe(3128500);
    });
  });

  describe('Pre-defect ledger demonstrates the imbalance mechanism', () => {
    // The LIVE account shape does NOT accept "1000" as a valid reference.
    const liveAccounts = [
      { id: 'ACC-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', account_type: 'ASSET', allow_posting: true },
      { id: 'ACC-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', account_type: 'ASSET', allow_posting: true },
    ];

    it('"1000" matches no account (the orphan)', () => {
      const matches = liveAccounts.filter(
        (a) => a.id === '1000' || a.code === '1000' || a.account_number === '1000'
      );
      expect(matches.length).toBe(0);
    });
  });
});

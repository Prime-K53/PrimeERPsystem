/**
 * customerAccountScope.parity.test.ts — FRONTEND half of the shared parity
 * fixture `tests/fixtures/branchScopeParity.json`.
 *
 * The BACKEND half lives in `backend/tests/customerAccountScope.test.cjs` and
 * runs the exact same fixture through `backend/services/customerAccountScope.cjs`.
 * If the two scope helpers (and the two ledger implementations) ever diverge,
 * one of the two suites fails. The fixture is the single source of truth.
 *
 * Run: cd frontend && npx vitest run tests/customerAccountScope.parity.test.ts
 */
import { describe, it, expect } from 'vitest';
import fixture from './fixtures/branchScopeParity.json';
import {
  resolveAccountScope,
  recordMatchesScope,
  collectAmbiguousScopeRecords,
  assertSameAccountOwnership,
} from '../services/customerAccountScope';
import { buildLedgerFromRecords } from '../services/customerLedger';

type AnyRec = Record<string, any>;
const customers = fixture.customers as Record<string, AnyRec>;
const pick = (key: string | null | undefined) => (key ? customers[key] : null);

const sorted = (values: string[]) => [...values].sort();

describe('parity fixture — integrity', () => {
  it('is versioned and covers every section', () => {
    expect(fixture.fixtureVersion).toBe('2026-10-18.1');
    expect(fixture.scopeCases.length).toBeGreaterThanOrEqual(8);
    expect(fixture.matchCases.length).toBeGreaterThanOrEqual(4);
    expect(fixture.ownershipCases.length).toBeGreaterThanOrEqual(7);
    expect(fixture.ledgerCases.length).toBeGreaterThanOrEqual(3);
  });
});

describe('parity — scope resolution', () => {
  for (const c of fixture.scopeCases) {
    it(c.id, () => {
      const scope = resolveAccountScope(c.customerId, c.branch as any, pick(c.customer));
      expect(scope.branchKey).toBe(c.expect.branchKey);
      expect(scope.branchId).toBe(c.expect.branchId);
      expect(Boolean(scope.isMain)).toBe(c.expect.isMain);
      expect(Boolean(scope.ambiguous)).toBe(c.expect.ambiguous);
      expect(scope.branchLabel).toBe(c.expect.branchLabel);
    });
  }
});

describe('parity — record/scope matching and ambiguity flagging', () => {
  for (const c of fixture.matchCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      const scope = resolveAccountScope(c.scope.customerId, c.scope.branch as any, customer);
      const matched = (c.records as AnyRec[])
        .filter((r) => recordMatchesScope(r, scope, customer))
        .map((r) => String(r.id));
      expect(sorted(matched)).toEqual(sorted(c.expectMatched));

      const flagged = collectAmbiguousScopeRecords(c.records as AnyRec[], scope, customer)
        .map((r) => r.id);
      expect(sorted(flagged)).toEqual(sorted((c.expectAmbiguous as string[]) || []));
    });
  }
});

describe('parity — authoritative allocation ownership', () => {
  for (const c of fixture.ownershipCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      let code = 'ok';
      try {
        assertSameAccountOwnership(c.payment, c.invoice, customer);
      } catch (err: any) {
        code = err?.code || 'unknown';
      }
      expect(code).toBe(c.expect);
    });
  }
});

describe('parity — scoped ledger', () => {
  for (const c of fixture.ledgerCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      const scope = resolveAccountScope(c.customerId, c.branch as any, customer);
      const ledger = buildLedgerFromRecords({
        customerId: c.customerId,
        invoices: c.invoices as AnyRec[],
        payments: c.payments as AnyRec[],
        scope,
        customer,
      });
      expect(sorted(ledger.transactions.map((t) => String(t.reference))))
        .toEqual(sorted(c.expectReferences));
      expect(ledger.outstandingBalance).toBe(c.expectOutstanding);
      const ambiguous = (ledger as any).ambiguousScopeRecords
        ? (ledger as any).ambiguousScopeRecords.map((r: AnyRec) => String(r.id))
        : [];
      expect(sorted(ambiguous)).toEqual(sorted(((c as any).expectAmbiguous as string[]) || []));
    });
  }
});

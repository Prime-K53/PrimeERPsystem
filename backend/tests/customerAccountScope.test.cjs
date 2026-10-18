/**
 * customerAccountScope.test.cjs — BACKEND half of the shared account-scope
 * parity fixture.
 *
 * The fixture (`frontend/tests/fixtures/branchScopeParity.json`) is the single
 * source of truth and is consumed by BOTH:
 *   - backend/services/customerAccountScope.cjs   (this file)
 *   - frontend/services/customerAccountScope.ts   (tests/customerAccountScope.parity.test.ts)
 *   - backend/services/customerLedger.cjs         (ledgerCases below)
 *
 * Any divergence between the frontend and backend scope/ledger helpers fails
 * one of the two suites.
 *
 * Run: cd backend && node --test tests/customerAccountScope.test.cjs
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const scopeHelper = require('../services/customerAccountScope.cjs');
const ledger = require('../services/customerLedger.cjs');

const FIXTURE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend', 'tests', 'fixtures', 'branchScopeParity.json'),
  'utf8'
));

const customers = FIXTURE.customers;
const pick = (key) => (key ? customers[key] : null);
const sorted = (values) => [...values].sort();
const noUndefined = (v) => (v === undefined ? null : v);

describe('parity fixture integrity', () => {
  it('is versioned and covers every section', () => {
    assert.equal(FIXTURE.fixtureVersion, '2026-10-18.1');
    assert.ok(FIXTURE.scopeCases.length >= 8, 'scopeCases');
    assert.ok(FIXTURE.matchCases.length >= 4, 'matchCases');
    assert.ok(FIXTURE.ownershipCases.length >= 7, 'ownershipCases');
    assert.ok(FIXTURE.ledgerCases.length >= 3, 'ledgerCases');
  });
});

describe('parity — scope resolution', () => {
  for (const c of FIXTURE.scopeCases) {
    it(c.id, () => {
      const scope = scopeHelper.resolveAccountScope(c.customerId, c.branch, pick(c.customer));
      assert.equal(scope.branchKey, c.expect.branchKey);
      assert.equal(noUndefined(scope.branchId), c.expect.branchId);
      assert.equal(Boolean(scope.isMain), c.expect.isMain);
      assert.equal(Boolean(scope.ambiguous), c.expect.ambiguous);
      assert.equal(scope.branchLabel, c.expect.branchLabel);
    });
  }
});

describe('parity — record/scope matching and ambiguity flagging', () => {
  for (const c of FIXTURE.matchCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      const scope = scopeHelper.resolveAccountScope(c.scope.customerId, c.scope.branch, customer);
      const matched = c.records
        .filter((r) => scopeHelper.recordMatchesScope(r, scope, customer))
        .map((r) => String(r.id));
      assert.deepEqual(sorted(matched), sorted(c.expectMatched));

      const flagged = scopeHelper
        .collectAmbiguousScopeRecords(c.records, scope, customer)
        .map((r) => r.id);
      assert.deepEqual(sorted(flagged), sorted(c.expectAmbiguous || []));
    });
  }
});

describe('parity — authoritative allocation ownership', () => {
  for (const c of FIXTURE.ownershipCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      let code = 'ok';
      try {
        scopeHelper.assertSameAccountOwnership(c.payment, c.invoice, customer);
      } catch (err) {
        code = (err && err.code) || 'unknown';
      }
      assert.equal(code, c.expect);
    });
  }
});

describe('parity — scoped ledger', () => {
  for (const c of FIXTURE.ledgerCases) {
    it(c.id, () => {
      const customer = pick(c.customer);
      const scope = scopeHelper.resolveAccountScope(c.customerId, c.branch, customer);
      const result = ledger.buildLedgerFromRecords({
        customerId: c.customerId,
        invoices: c.invoices,
        payments: c.payments,
        scope,
        customer,
      });
      assert.deepEqual(
        sorted(result.transactions.map((t) => String(t.reference))),
        sorted(c.expectReferences)
      );
      assert.equal(result.outstandingBalance, c.expectOutstanding);
      const ambiguous = (result.ambiguousScopeRecords || []).map((r) => String(r.id));
      assert.deepEqual(sorted(ambiguous), sorted(c.expectAmbiguous || []));
    });
  }
});

describe('backend scope helper — additional guards', () => {
  it('a legacy snapshot-style untagged row is Main, never a wildcard', () => {
    assert.deepEqual(scopeHelper.recordBranchKeys({}), ['main']);
    assert.deepEqual(scopeHelper.recordBranchKeys({ subAccountName: 'Main' }), ['main']);
  });

  it('an id-tagged row with a blank name is a branch, not Main', () => {
    assert.deepEqual(scopeHelper.recordBranchKeys({ subAccountId: 'SUB-A', subAccountName: '' }), ['id:SUB-A']);
  });

  it('an empty-customer scope matches nothing (fails closed)', () => {
    const empty = scopeHelper.mainAccountScope('');
    assert.deepEqual(scopeHelper.filterRecordsByScope([{ id: 'X', customerId: '' }], empty, null), []);
  });

  it('validateAccountScope refuses a branch scope without the parent customer', () => {
    const scope = scopeHelper.resolveAccountScope('CUST-SHARED', 'SUB-A', customers['CUST-SHARED']);
    const v = scopeHelper.validateAccountScope(scope, null);
    assert.equal(v.ok, false);
  });

  it('validateAccountScope accepts an owned branch whose display name is shared', () => {
    const scope = scopeHelper.resolveAccountScope('CUST-SHARED', 'SUB-A', customers['CUST-SHARED']);
    const v = scopeHelper.validateAccountScope(scope, customers['CUST-SHARED']);
    assert.equal(v.ok, true);
    assert.equal(v.ambiguous, true);
  });
});

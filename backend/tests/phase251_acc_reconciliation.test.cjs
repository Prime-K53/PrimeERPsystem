/**
 * Phase 2.5.1 — ACC- Legacy Ledger Reconciliation Tests
 *
 * Validates handling of the 16 remaining ACC- entries after the main
 * legacy ledger migration.
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const repo = require('../services/supabaseRepository.cjs');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
};

const PREFIX = 'PH251-TEST-';
let pass = 0;
let fail = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  PASS: ${msg}`);
    pass++;
  } else {
    console.error(`  FAIL: ${msg}`);
    fail++;
  }
}

async function getAllLedgerEntries() {
  let offset = 0;
  const limit = 1000;
  const entries = [];
  while (true) {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/ledger_entries`, {
      params: { select: 'id,data', limit, offset },
      headers: HEADERS,
      timeout: 30000,
    });
    const rows = r.data || [];
    if (rows.length === 0) break;
    for (const row of rows) {
      entries.push({ id: row.id, ...(row.data || {}) });
    }
    if (rows.length < limit) break;
    offset += limit;
  }
  return entries;
}

async function runTests() {
  console.log('=== PHASE 2.5.1 — ACC- RECONCILIATION TESTS ===\n');

  const allEntries = await getAllLedgerEntries();
  console.log(`Total ledger entries scanned: ${allEntries.length}`);

  const accEntries = allEntries.filter(
    (e) => e.debitAccountId && e.creditAccountId &&
      (String(e.debitAccountId).startsWith('ACC-') || String(e.creditAccountId).startsWith('ACC-'))
  );
  console.log(`ACC- entries found: ${accEntries.length}`);

  const canonicalEntries = allEntries.filter((e) => e.account_id && e.entry_type);
  console.log(`Canonical entries found: ${canonicalEntries.length}`);

  // ========================================================================
  // TEST 1: Exactly 16 ACC- entries remain as old-format
  // ========================================================================
  console.log('\n--- TEST 1: ACC- entries remain old-format ---');
  assert(accEntries.length === 16, `Expected 16 ACC- entries, found ${accEntries.length}`);
  for (const e of accEntries) {
    assert(!e.account_id, `ACC- entry ${e.id} has no canonical account_id`);
    assert(!e.entry_type, `ACC- entry ${e.id} has no canonical entry_type`);
  }

  // ========================================================================
  // TEST 2: No canonical entry uses ACC- as account_id
  // ========================================================================
  console.log('\n--- TEST 2: No canonical entry uses ACC- as account_id ---');
  const accInAccountId = canonicalEntries.filter((e) => String(e.account_id).startsWith('ACC-'));
  assert(accInAccountId.length === 0, `Zero canonical entries with ACC- account_id (found ${accInAccountId.length})`);

  // ========================================================================
  // TEST 3: ACC- entries do not affect trial balance
  // ========================================================================
  console.log('\n--- TEST 3: ACC- entries excluded from trial balance ---');
  const tb = {};
  for (const e of canonicalEntries) {
    const key = e.account_id;
    if (!tb[key]) tb[key] = { debit: 0, credit: 0 };
    if (e.entry_type === 'debit') tb[key].debit += Number(e.amount) || 0;
    else tb[key].credit += Number(e.amount) || 0;
  }
  let totalDebits = 0;
  let totalCredits = 0;
  for (const key of Object.keys(tb)) {
    totalDebits += tb[key].debit;
    totalCredits += tb[key].credit;
  }
  assert(Math.abs(totalDebits - totalCredits) < 0.01,
    `Trial Balance from canonical entries balanced (Dr=${totalDebits}, Cr=${totalCredits})`);

  // ========================================================================
  // TEST 4: Migration idempotency
  // ========================================================================
  console.log('\n--- TEST 4: Migration idempotency ---');
  const migrBefore = allEntries.filter((e) => String(e.id).startsWith('MIGR-')).length;

  const { execSync } = require('child_process');
  try {
    const output = execSync('node scripts/migrateLegacyLedger.cjs --dry-run', {
      cwd: require('path').join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000,
    });
    const match = output.match(/Would change: (\d+)/);
    const wouldChange = match ? parseInt(match[1], 10) : -1;
    assert(wouldChange === 0, `Dry-run reports 0 changes after migration (got ${wouldChange})`);
  } catch (e) {
    assert(false, `Dry-run execution failed: ${e.message}`);
  }

  const afterDryRun = await getAllLedgerEntries();
  const migrAfter = afterDryRun.filter((e) => String(e.id).startsWith('MIGR-')).length;
  assert(migrAfter === migrBefore, `MIGR- count unchanged after dry-run (before=${migrBefore}, after=${migrAfter})`);

  // ========================================================================
  // TEST 5: All 16 ACC- entries trace to real invoices
  // ========================================================================
  console.log('\n--- TEST 5: ACC- entries trace to real invoices ---');
  let traceable = 0;
  for (const e of accEntries) {
    const refId = e.referenceId || e.reference_id;
    if (refId && String(refId).startsWith('INV-P726/')) {
      traceable++;
    }
  }
  assert(traceable === 16, `All 16 ACC- entries trace to invoices (found ${traceable})`);

  // ========================================================================
  // TEST 6: Customer/supplier IDs are never stored as GL account_id
  // ========================================================================
  console.log('\n--- TEST 6: Customer/supplier IDs not stored as GL account_id ---');
  const customerIds = new Set();
  for (const e of accEntries) {
    if (e.customerId) customerIds.add(e.customerId);
  }
  let customerAsAccount = 0;
  for (const e of canonicalEntries) {
    if (customerIds.has(e.account_id)) {
      customerAsAccount++;
    }
  }
  assert(customerAsAccount === 0, `Zero customer IDs stored as GL account_id (found ${customerAsAccount})`);

  // ========================================================================
  // TEST 7: No duplicate accounting for ACC- invoice references
  // ========================================================================
  console.log('\n--- TEST 7: No duplicate accounting for ACC- invoices ---');
  const accRefs = new Set();
  for (const e of accEntries) {
    const refId = e.referenceId || e.reference_id;
    if (refId) accRefs.add(refId);
  }
  let duplicateRefs = 0;
  for (const refId of accRefs) {
    const canonicalForRef = canonicalEntries.filter(
      (e) => e.reference_id === refId || e.referenceId === refId
    );
    if (canonicalForRef.length > 0) {
      duplicateRefs++;
    }
  }
  assert(duplicateRefs === 0, `Zero ACC- invoice references duplicated in canonical entries (found ${duplicateRefs})`);

  // ========================================================================
  // Print Summary
  // ========================================================================
  console.log('\n=== PHASE 2.5.1 RESULTS ===');
  console.log(`Passed: ${pass}`);
  console.log(`Failed: ${fail}`);
  console.log(`Total:  ${pass + fail}`);

  if (fail > 0) {
    console.log('\nPhase 2.5.1: SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('\nPhase 2.5.1: ALL TESTS PASSED');
  }
}

runTests().catch((e) => {
  console.error('Test runner error:', e);
  process.exit(1);
});

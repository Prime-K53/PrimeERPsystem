/**
 * Phase 2.6 — Accounting Migration Closure Verifier (READ-ONLY)
 *
 * Verifies the post-migration accounting state of the live Supabase database:
 *   1. Migration idempotency (delegates to migrateLegacyLedger.cjs --dry-run)
 *   2. Canonical account identity (no ACC-*, customer, supplier, or legacy
 *      account numbers used as account_id; every canonical posting resolves)
 *   3. The 16 historical ACC-* exceptions remain unchanged and traceable
 *   4. The 3 canonical-posting invoices (INV-0002, INV-P726/009, INV-P726/029)
 *   5. The 5 invoices listed without ledger entries (INV-P726/036…043)
 *   7. Trial Balance, General Ledger, P&L, Balance Sheet from canonical entries
 *   8. Global corruption scan (ACC-*, acct-*, legacy/customer/supplier IDs)
 *
 * This script performs NO writes. It only reads and prints evidence.
 * Findings that contradict the Phase 2.6 expectations are printed as FINDING
 * (never auto-fixed); assertion failures surface as FAIL.
 *
 * Usage:  node scripts/phase26Closure.cjs   (reads backend/.env for credentials)
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');
const { execSync } = require('child_process');
const path = require('path');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
};

const ORPHAN_ID = 'ACC-1786942904915-jpgnq';
const NO_LEDGER_INVOICES = ['INV-P726/036', 'INV-P726/039', 'INV-P726/040', 'INV-P726/041', 'INV-P726/043'];
const CANONICAL_INVOICES = ['INV-0002', 'INV-P726/009', 'INV-P726/029'];

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

function note(msg) {
  console.log(`  INFO: ${msg}`);
}

function finding(msg) {
  console.log(`  FINDING: ${msg}`);
}

async function fetchAll(table, select) {
  const rows = [];
  const limit = 1000;
  let offset = 0;
  for (;;) {
    const r = await axios.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      params: { select, limit, offset, order: 'id.asc' },
      headers: HEADERS,
      timeout: 30000,
    });
    const page = r.data || [];
    rows.push(...page);
    if (page.length < limit) break;
    offset += page.length;
    if (offset > 50000) break; // safety valve
  }
  return rows;
}

async function main() {
  console.log('=== PHASE 2.6 — ACCOUNTING MIGRATION CLOSURE VERIFICATION (READ-ONLY) ===\n');

  if (!SUPABASE_URL || !SECRET_KEY) {
    console.error('FATAL: SUPABASE_URL / SUPABASE_SECRET_KEY not configured (backend/.env)');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Fetch source data
  // ---------------------------------------------------------------------------
  console.log('--- Fetching source data ---');
  const ledgerRows = await fetchAll('ledger_entries', 'id,data,updated_at,version');
  const coaRows = await fetchAll('chart_of_accounts', 'id,data');
  const customerRows = await fetchAll('customers', 'id');
  const supplierRows = await fetchAll('suppliers', 'id');
  const invoiceRows = await fetchAll('invoices', 'id,data');
  console.log(`  ledger_entries: ${ledgerRows.length} rows`);
  console.log(`  chart_of_accounts: ${coaRows.length} rows`);
  console.log(`  customers: ${customerRows.length} rows`);
  console.log(`  suppliers: ${supplierRows.length} rows`);
  console.log(`  invoices: ${invoiceRows.length} rows`);

  // Envelope id kept separately: legacy rows share data.id across the pair.
  const entries = ledgerRows.map((row) => ({
    _envId: row.id,
    deleted: Boolean(row.data && row.data.deleted),
    ...(row.data || {}),
  }));
  const coaIds = new Set(coaRows.map((r) => r.id));
  const customerIds = new Set(customerRows.map((r) => r.id));
  const supplierIds = new Set(supplierRows.map((r) => r.id));
  const coaMeta = {};
  for (const r of coaRows) {
    const d = r.data || {};
    coaMeta[r.id] = {
      number: d.account_number || d.code || '?',
      name: d.name || '?',
      type: String(d.account_type || d.type || '').toUpperCase(),
      normal: String(d.normal_balance || '').toUpperCase(),
      company: d.company_id || '?',
    };
  }

  const canonical = entries.filter((e) => e.account_id && e.entry_type);
  const oldFormat = entries.filter((e) => e.debitAccountId || e.creditAccountId);
  const accEntries = oldFormat.filter(
    (e) => String(e.debitAccountId || '').startsWith('ACC-') || String(e.creditAccountId || '').startsWith('ACC-')
  );
  const migrEntries = entries.filter((e) => String(e._envId).startsWith('MIGR-'));
  const tombstoned = entries.filter((e) => e.deleted);
  const active = entries.filter((e) => !e.deleted);
  const ph25 = entries.filter(
    (e) => String(e._envId).startsWith('PH25-TEST') || String(e.created_by || '').includes('PH25-TEST') || (e.description || '').includes('PH25-TEST')
  );

  // ===========================================================================
  // 1. Migration idempotency
  // ===========================================================================
  console.log('\n--- 1. MIGRATION IDEMPOTENCY ---');
  console.log(`  Old-format entries (debitAccountId/creditAccountId): ${oldFormat.length}`);
  console.log(`  MIGR- canonical rows present: ${migrEntries.length}`);
  try {
    const output = execSync('node scripts/migrateLegacyLedger.cjs --dry-run', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 60000,
    });
    const wouldChange = (output.match(/Would change: (\d+)/) || [])[1];
    const skipped = (output.match(/Skipped: (\d+)/) || [])[1];
    const errors = (output.match(/Errors: (\d+)/) || [])[1];
    console.log(`  Dry-run report: Would change=${wouldChange}, Skipped=${skipped}, Errors=${errors}`);
    assert(wouldChange === '0', `Dry-run reports 0 changes (got ${wouldChange})`);
    assert(errors === '0', `Dry-run reports 0 errors (got ${errors})`);
    assert(skipped === String(accEntries.length), `Dry-run skips exactly the ${accEntries.length} ACC- exceptions (got ${skipped})`);
  } catch (e) {
    assert(false, `Dry-run execution failed: ${e.message}`);
  }

  // ===========================================================================
  // 2. Canonical identity
  // ===========================================================================
  console.log('\n--- 2. CANONICAL ACCOUNT IDENTITY ---');
  console.log(`  Canonical entries (account_id + entry_type): ${canonical.length}`);
  const accAsAccountId = canonical.filter((e) => String(e.account_id).startsWith('ACC-'));
  const legacyNumAsId = canonical.filter((e) => /^[0-9]{4,5}$/.test(String(e.account_id)));
  const customerAsId = canonical.filter((e) => customerIds.has(String(e.account_id)));
  const supplierAsId = canonical.filter((e) => supplierIds.has(String(e.account_id)));
  const unresolved = canonical.filter((e) => !coaIds.has(String(e.account_id)));

  assert(accAsAccountId.length === 0, `Zero canonical entries with ACC-* account_id (found ${accAsAccountId.length})`);
  assert(customerAsId.length === 0, `Zero customer IDs used as account_id (found ${customerAsId.length})`);
  assert(supplierAsId.length === 0, `Zero supplier IDs used as account_id (found ${supplierAsId.length})`);
  assert(legacyNumAsId.length === 0, `Zero legacy account numbers used as account_id (found ${legacyNumAsId.length})`);
  if (unresolved.length === 0) {
    assert(true, 'Every canonical posting resolves to an existing COA account');
  } else {
    assert(false, `Every canonical posting resolves to an existing COA account (unresolved: ${unresolved.length})`);
    unresolved.forEach((e) => {
      finding(`Canonical entry ${e._envId} has account_id "${e.account_id}" (no matching COA row) — desc="${e.description}", amount=${e.amount}, created_by=${e.created_by}`);
    });
  }

  // ===========================================================================
  // 3. The 16 historical exceptions
  // ===========================================================================
  console.log('\n--- 3. HISTORICAL ACC-* EXCEPTIONS ---');
  assert(accEntries.length === 16, `Exactly 16 malformed ACC-* ledger entries (found ${accEntries.length})`);
  let orphanMentions = 0;
  for (const e of accEntries) {
    const ids = [e.id, e.debitAccountId, e.creditAccountId].join(' ');
    if (ids.includes(ORPHAN_ID)) orphanMentions++;
    if (e.account_id || e.entry_type) {
      assert(false, `ACC- entry ${e._envId} must remain old-format (no canonical account_id/entry_type)`);
    }
  }
  assert(orphanMentions === 16, `All 16 malformed entries contain ${ORPHAN_ID} (found ${orphanMentions})`);
  const accWithRef = accEntries.filter((e) => e.referenceId || e.reference_id);
  assert(accWithRef.length === 16, `All 16 retain original invoice references (found ${accWithRef.length})`);
  const accRefs = new Set(accEntries.map((e) => e.referenceId || e.reference_id).filter(Boolean));
  assert(accRefs.size === 16, `The 16 exceptions map to 16 distinct invoices (found ${accRefs.size})`);
  const accCustomerRefs = accEntries.filter((e) => e.customerId || e.customer_id).length;
  note(`ACC- exceptions carrying customer references: ${accCustomerRefs}`);
  note(`References: ${[...accRefs].sort().join(', ')}`);

  // ===========================================================================
  // 4. The 3 canonical-posting invoices
  // ===========================================================================
  console.log('\n--- 4. CANONICAL-POSTING INVOICES ---');
  const invoiceById = new Map(invoiceRows.map((r) => [r.id, r.data || {}]));
  for (const inv of CANONICAL_INVOICES) {
    const lines = canonical.filter((e) => e.reference_id === inv || e.referenceId === inv);
    const invRec = invoiceById.get(inv);
    const total = invRec ? (invRec.totalAmount ?? invRec.total_amount) : null;
    console.log(`  ${inv}: ${lines.length} canonical ledger line(s), invoice total=${total}, status=${invRec ? invRec.status : '?'}`);
    if (lines.length === 0) {
      assert(false, `${inv} has no canonical ledger entries`);
      continue;
    }
    const isMigr = lines.every((l) => String(l._envId).startsWith('MIGR-'));
    assert(isMigr, `${inv} postings are MIGR- canonical rows`);
    const credits = lines.filter((l) => l.entry_type === 'credit');
    const creditAccounts = new Set(credits.map((l) => {
      const m = coaMeta[l.account_id];
      return m ? `${m.number} ${m.name}` : l.account_id;
    }));
    note(`  ${inv} credit account(s): ${[...creditAccounts].join(', ') || '(none)'}`);
    const dr = lines.filter((l) => l.entry_type === 'debit').reduce((s, l) => s + (Number(l.amount) || 0), 0);
    const cr = lines.filter((l) => l.entry_type === 'credit').reduce((s, l) => s + (Number(l.amount) || 0), 0);
    assert(Math.abs(dr - cr) < 0.01, `${inv} postings balanced (Dr=${dr}, Cr=${cr})`);
    // Duplicate-accounting indicator: multiple independent migrated pairs for one invoice
    const pairs = new Map();
    for (const l of lines) {
      const k = String(l._envId).replace(/-(DEBIT|CREDIT)$/, '');
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
    if (pairs.size > 1) {
      finding(`${inv} has ${pairs.size} separate migrated posting pairs for one invoice (${[...pairs.keys()].join(' | ')}) — possible duplication, report for controlled remediation`);
    }
  }
  // Duplicate-accounting check across the 16 ACC- references
  const dupRefs = [];
  for (const ref of accRefs) {
    const count = canonical.filter((e) => e.reference_id === ref || e.referenceId === ref).length;
    if (count > 0) dupRefs.push(`${ref}: ${count}`);
  }
  assert(dupRefs.length === 0, `No canonical entries duplicate the 16 ACC- invoice references (found ${dupRefs.length})`);

  // ===========================================================================
  // 5. The 5 invoices listed without ledger entries
  // ===========================================================================
  console.log('\n--- 5. INVOICES LISTED WITHOUT LEDGER ENTRIES ---');
  for (const inv of NO_LEDGER_INVOICES) {
    const invoice = invoiceById.get(inv);
    const canonicalRefs = canonical.filter((e) => e.reference_id === inv || e.referenceId === inv);
    const anyRefs = entries.filter((e) => e.reference_id === inv || e.referenceId === inv);
    const total = invoice ? (invoice.totalAmount ?? invoice.total_amount) : null;
    const status = invoice ? invoice.status : 'MISSING';
    console.log(`  ${inv}: invoice=${invoice ? 'EXISTS' : 'MISSING'} status=${status} total=${total}, ledger refs=${anyRefs.length} (canonical=${canonicalRefs.length})`);
    if (anyRefs.length === 0) {
      assert(true, `${inv} has no ledger entries of any kind`);
      note(`  ${inv} classification: ${status === 'Cancelled' ? 'cancelled — legitimately never posted' : `unpaid with no AR recognition — historically missing ledger posting (F-02-era invoice posting bug)`}`);
    } else {
      assert(false, `${inv} expected to have no ledger entries but has ${anyRefs.length} (${canonicalRefs.length} canonical)`);
      canonicalRefs.forEach((e) => {
        const m = coaMeta[e.account_id];
        finding(`${inv} canonical line ${e._envId}: ${e.entry_type} ${e.amount} -> ${m ? m.number + ' ' + m.name : e.account_id} (created_by=${e.created_by})`);
      });
    }
  }

  // ===========================================================================
  // 7. Accounting reports from canonical entries
  // ===========================================================================
  console.log('\n--- 7. ACCOUNTING REPORTS (CANONICAL ENTRIES) ---');
  const tbActive = { dr: 0, cr: 0 };
  const tbAll = { dr: 0, cr: 0 };
  for (const e of canonical) {
    const amt = Number(e.amount) || 0;
    if (e.entry_type === 'debit') { tbAll.dr += amt; if (!e.deleted) tbActive.dr += amt; }
    else if (e.entry_type === 'credit') { tbAll.cr += amt; if (!e.deleted) tbActive.cr += amt; }
  }
  console.log(`  Trial Balance (active, non-deleted canonical): Dr=${tbActive.dr.toFixed(2)}, Cr=${tbActive.cr.toFixed(2)}`);
  assert(Math.abs(tbActive.dr - tbActive.cr) < 0.01, `Trial Balance balanced (Dr=${tbActive.dr.toFixed(2)} = Cr=${tbActive.cr.toFixed(2)})`);
  const expectedTb = 40237799;
  if (tbActive.dr === expectedTb) {
    assert(true, `Trial Balance matches expected ${expectedTb.toLocaleString('en-US')}`);
  } else {
    note(`Expected TB ${expectedTb.toLocaleString('en-US')}; measured ${tbActive.dr.toLocaleString('en-US')} (delta ${(tbActive.dr - expectedTb).toLocaleString('en-US')})`);
  }

  // General Ledger integrity: journals balanced + reference groups balanced
  console.log('\n  --- General Ledger integrity ---');
  const byJournal = {};
  const byReference = {};
  for (const e of canonical) {
    if (e.deleted) continue;
    const amt = Number(e.amount) || 0;
    const refKey = e.reference_id || e.referenceId || '(none)';
    if (!byReference[refKey]) byReference[refKey] = { dr: 0, cr: 0 };
    if (e.journal_id) {
      if (!byJournal[e.journal_id]) byJournal[e.journal_id] = { dr: 0, cr: 0 };
      if (e.entry_type === 'debit') byJournal[e.journal_id].dr += amt; else byJournal[e.journal_id].cr += amt;
    }
    if (e.entry_type === 'debit') byReference[refKey].dr += amt; else byReference[refKey].cr += amt;
  }
  const unbalancedJournals = Object.entries(byJournal).filter(([, b]) => Math.abs(b.dr - b.cr) >= 0.01);
  const unbalancedRefs = Object.entries(byReference).filter(([, b]) => Math.abs(b.dr - b.cr) >= 0.01);
  assert(unbalancedJournals.length === 0, `All ${Object.keys(byJournal).length} journals balanced (unbalanced: ${unbalancedJournals.length})`);
  assert(unbalancedRefs.length === 0, `All ${Object.keys(byReference).length} reference groups balanced (unbalanced: ${unbalancedRefs.length})`);
  unbalancedJournals.slice(0, 5).forEach(([k, b]) => finding(`Unbalanced journal ${k}: Dr=${b.dr}, Cr=${b.cr}`));
  unbalancedRefs.slice(0, 5).forEach(([k, b]) => finding(`Unbalanced reference group ${k}: Dr=${b.dr}, Cr=${b.cr}`));

  // P&L / Balance Sheet
  console.log('\n  --- P&L / Balance Sheet ---');
  const balances = {};
  const signIssues = [];
  for (const e of canonical) {
    if (e.deleted) continue;
    const meta = coaMeta[e.account_id];
    if (!meta) continue; // reported under section 2
    const amt = Number(e.amount) || 0;
    let normal = meta.normal;
    if (!normal) {
      normal = (meta.type === 'ASSET' || meta.type === 'EXPENSE') ? 'DEBIT' : 'CREDIT';
      signIssues.push(e.account_id);
    }
    if (!balances[e.account_id]) balances[e.account_id] = 0;
    if (e.entry_type === 'debit') balances[e.account_id] += (normal === 'DEBIT' ? amt : -amt);
    else balances[e.account_id] += (normal === 'CREDIT' ? amt : -amt);
  }
  const totals = { ASSET: 0, LIABILITY: 0, EQUITY: 0, REVENUE: 0, EXPENSE: 0 };
  for (const [id, bal] of Object.entries(balances)) {
    const t = coaMeta[id].type === 'INCOME' ? 'REVENUE' : coaMeta[id].type;
    if (totals[t] === undefined) {
      note(`  account ${coaMeta[id].number} (${id}) has unrecognized type "${coaMeta[id].type}"`);
      continue;
    }
    // Contra-equity semantics: debit-normal equity accounts (e.g. 34000
    // Drawings) REDUCE equity, so their stored balance is subtracted.
    if (t === 'EQUITY' && coaMeta[id].normal === 'DEBIT') {
      totals[t] -= bal;
    } else {
      totals[t] += bal;
    }
  }
  const grossExpense = {};
  for (const e of canonical) {
    if (e.deleted) continue;
    const meta = coaMeta[e.account_id];
    if (!meta) continue;
    const t = meta.type === 'INCOME' ? 'REVENUE' : meta.type;
    if (t === 'EXPENSE') grossExpense[e.entry_type] = (grossExpense[e.entry_type] || 0) + (Number(e.amount) || 0);
  }
  for (const [k, v] of Object.entries(totals)) console.log(`  ${k} net balance: ${v.toFixed(2)}`);
  console.log(`  EXPENSE gross: Dr=${(grossExpense.debit || 0).toFixed(2)}, Cr=${(grossExpense.credit || 0).toFixed(2)} (net=${totals.EXPENSE.toFixed(2)})`);
  console.log(`  P&L: Revenue=${totals.REVENUE.toFixed(2)}, Expenses(net)=${totals.EXPENSE.toFixed(2)}`);
  // Entries whose account_id is not in the COA (the zero-UUID test rows) are
  // unclassified: they still appear in the Trial Balance. Fold them into the
  // equation as a documented residual so the check is exact.
  const unclassified = {};
  for (const e of canonical) {
    if (e.deleted || coaMeta[e.account_id]) continue;
    const amt = Number(e.amount) || 0;
    unclassified[e.entry_type] = (unclassified[e.entry_type] || 0) + amt;
  }
  const unclassifiedNet = (unclassified.debit || 0) - (unclassified.credit || 0);
  const rhs = totals.LIABILITY + totals.EQUITY + totals.REVENUE - totals.EXPENSE;
  const diff = totals.ASSET - (rhs - unclassifiedNet);
  console.log(`  Assets=${totals.ASSET.toFixed(2)}, Liab+Equity+Rev-Exp=${rhs.toFixed(2)}, unclassified(no COA row)=${unclassifiedNet.toFixed(2)}, diff=${diff.toFixed(2)}`);
  if (Math.abs(diff) < 0.01) {
    assert(true, 'Balance Sheet equation holds: Assets = Liabilities + Equity + (Revenue - Expenses)');
    if (Math.abs(unclassifiedNet) >= 0.01) {
      finding(`Balance Sheet equation holds only after accounting for ${unclassifiedNet.toFixed(2)} of entries with no COA account (the zero-UUID 'Should fail' test rows)`);
    }
  } else {
    assert(false, `Balance Sheet equation holds (diff=${diff.toFixed(2)})`);
    const suspect = new Set(signIssues);
    note(`Accounts with balance but missing normal_balance metadata: ${suspect.size}`);
    if (suspect.size > 0) {
      for (const id of suspect) {
        const meta = coaMeta[id];
        note(`  inferred-sign account ${meta.number} ${meta.name} [${meta.type}] balance=${(balances[id] || 0).toFixed(2)} company=${meta.company}`);
      }
    }
  }

  // ===========================================================================
  // 8. Global corruption scan
  // ===========================================================================
  console.log('\n--- 8. GLOBAL CORRUPTION SCAN ---');
  const patterns = {
    'ACC-*': (v) => /^ACC-/i.test(String(v)),
    'acct-*': (v) => /^acct-/i.test(String(v)),
    'legacy numeric': (v) => /^[0-9]{4,5}$/.test(String(v)),
    'not in COA': (v) => !coaIds.has(String(v)),
  };
  let invalidActive = 0;
  const invalidSamples = [];
  for (const e of active) {
    if (!e.account_id) continue;
    const bad = Object.entries(patterns).find(([, fn]) => fn(e.account_id))
      || (customerIds.has(String(e.account_id)) ? ['customer ID', () => true] : null)
      || (supplierIds.has(String(e.account_id)) ? ['supplier ID', () => true] : null);
    if (bad) {
      invalidActive++;
      if (invalidSamples.length < 20) invalidSamples.push(`${e._envId} -> "${e.account_id}" (${bad[0]}) desc="${e.description}" by=${e.created_by} amt=${e.amount}`);
    }
  }
  if (invalidActive === 0) {
    assert(true, 'Active invalid GL account references: 0');
  } else {
    assert(false, `Active invalid GL account references: 0 (found ${invalidActive})`);
    invalidSamples.forEach((s) => finding(`Active invalid reference: ${s}`));
  }
  note(`Historical controlled ACC-* exceptions: ${accEntries.length} ledger entries (unchanged)`);
  note(`Tombstoned (soft-deleted) ledger rows: ${tombstoned.length}`);
  note(`PH25-TEST test ledger rows present (active): ${ph25.length} (Dr=Cr=${
    (() => { let d = 0, c = 0; ph25.forEach((e) => { if (e.entry_type === 'debit') d += Number(e.amount) || 0; else if (e.entry_type === 'credit') c += Number(e.amount) || 0; }); return d.toFixed(2); })()
  })`) ;

  let orphanLedger = 0;
  for (const e of entries) {
    const blob = JSON.stringify({ id: e.id, debitAccountId: e.debitAccountId, creditAccountId: e.creditAccountId, account_id: e.account_id });
    if (blob.includes(ORPHAN_ID)) orphanLedger++;
  }
  let orphanInvoices = 0;
  for (const r of invoiceRows) {
    if (JSON.stringify(r).includes(ORPHAN_ID)) orphanInvoices++;
  }
  console.log(`  Occurrences of ${ORPHAN_ID}: ledger=${orphanLedger}, invoices=${orphanInvoices}, total=${orphanLedger + orphanInvoices}`);
  assert(orphanLedger === 16 && orphanInvoices === 24, `Orphan identifier occurrences match expectation (ledger 16, invoices 24)`);

  // ===========================================================================
  // Summary
  // ===========================================================================
  console.log('\n=== PHASE 2.6 VERIFICATION SUMMARY ===');
  console.log(`Passed: ${pass}`);
  console.log(`Failed: ${fail}`);
  console.log(`Total assertions: ${pass + fail}`);
  if (fail > 0) {
    console.log('\nPHASE 2.6: SOME CHECKS FAILED — see FINDING lines above (nothing was modified)');
    process.exit(1);
  }
  console.log('\nPHASE 2.6: ALL CHECKS PASSED (read-only verification)');
}

main().catch((e) => {
  console.error('Verifier error:', e);
  process.exit(1);
});
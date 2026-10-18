#!/usr/bin/env node
/**
 * reportAmbiguousBranchRecords.cjs — READ-ONLY ambiguity report.
 *
 * Purpose (Customer Branch Financial Isolation, item F):
 *   Legacy financial rows may be tagged with a branch NAME only (or not at
 *   all). Where two branches of the same customer share that name, the row
 *   CANNOT be attributed to one branch safely. The ledger already refuses to
 *   attribute such a row (fail safe + flag); this script produces the separate
 *   read-only list the business needs in order to tag those rows with their
 *   stable branch id.
 *
 * GUARANTEES
 *   - READ ONLY. This script never inserts, updates, deletes, reverse or
 *     reallocates anything. It only SELECTs and prints.
 *   - It never reclassifies historical transactions. It only reports them.
 *   - Safe to run against a live database: no writes, no migrations, no repairs.
 *
 * Usage:
 *   node backend/scripts/reportAmbiguousBranchRecords.cjs [--json] [--table=invoices|payments|sales|all]
 *
 * Exit codes:
 *   0 — report produced (even if ambiguous rows were found)
 *   3 — could not read the data (never reported as "nothing ambiguous")
 */

const repo = require('../services/supabaseRepository.cjs');
const scopeHelper = require('../services/customerAccountScope.cjs');

const TABLES = {
  invoices: { table: 'invoices', label: 'invoice' },
  payments: { table: 'customer_payments', label: 'payment' },
  sales: { table: 'sales', label: 'sale' },
};

function parseArgs(argv) {
  const args = { json: false, table: 'all' };
  for (const a of argv.slice(2)) {
    if (a === '--json') args.json = true;
    else if (a.startsWith('--table=')) args.table = a.slice('--table='.length);
  }
  return args;
}

function flat(row) {
  if (!row || typeof row !== 'object') return {};
  return (row.data && typeof row.data === 'object') ? { ...row, ...row.data } : row;
}

async function readAll(table) {
  // Strict: a read failure must NEVER be reported as "nothing ambiguous".
  const rows = await repo.getAllStrict(table, {});
  return (rows || []).map(flat);
}

async function main() {
  const args = parseArgs(process.argv);
  const wanted = args.table === 'all' ? Object.keys(TABLES) : [args.table];
  const bad = wanted.filter((t) => !TABLES[t]);
  if (bad.length) {
    console.error(`Unknown --table value(s): ${bad.join(', ')}. Use invoices|payments|sales|all.`);
    process.exit(2);
  }

  if (!repo.isConfigured()) {
    console.error('Supabase is not configured; cannot read financial rows. Nothing was changed.');
    process.exit(3);
  }

  let customers = [];
  try {
    customers = (await repo.getAllStrict('customers', {})).map(flat);
  } catch (err) {
    console.error(`Failed to read customers: ${err.message}. Nothing was changed.`);
    process.exit(3);
  }
  const customerById = new Map(customers.map((c) => [String(c.id), c]));

  const report = [];
  for (const key of wanted) {
    const { table, label } = TABLES[key];
    let rows;
    try {
      rows = await readAll(table);
    } catch (err) {
      console.error(`Failed to read ${key}: ${err.message}. Nothing was changed.`);
      process.exit(3);
    }

    for (const row of rows) {
      const proj = scopeHelper.scopeRecord(row);
      if (!proj.customerId) continue;
      const customer = customerById.get(String(proj.customerId));
      if (!customer) continue;

      const hasId = Boolean(String(proj.subAccountId ?? '').trim());
      const hasName = !scopeHelper.isMainBranchValue(proj.subAccountName);
      // Untagged (no id, no branch name) rows are Main by design — not ambiguous.
      if (!hasId && !hasName) continue;
      if (hasId) continue; // stable id => attributable

      const slug = scopeHelper.slugBranchName(proj.subAccountName);
      if (!slug) continue;
      const matches = scopeHelper.subAccountEntries(customer)
        .filter((sa) => scopeHelper.slugBranchName(sa.name ?? sa.label) === slug);
      const sharedBySeveral = matches.length > 1;
      const matchesNoBranch = matches.length === 0;

      if (!sharedBySeveral && !matchesNoBranch) continue;

      report.push({
        table: key,
        recordType: label,
        id: String(row.id ?? ''),
        customerId: String(proj.customerId),
        customerName: String(customer.name || ''),
        branchName: String(proj.subAccountName ?? ''),
        reason: sharedBySeveral
          ? `branch name shared by ${matches.length} branches of this customer`
          : 'branch name does not match any branch of this customer',
        candidateBranchIds: matches.map((m) => String(m.id ?? '')).filter(Boolean),
        suggestedAction: sharedBySeveral
          ? 'Tag this record with the correct stable branch id (subAccountId) after business confirmation.'
          : 'Confirm the intended branch, then tag the record with its stable branch id (subAccountId).',
      });
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({ generatedAt: new Date().toISOString(), count: report.length, records: report }, null, 2));
  } else {
    console.log(`\nAmbiguous branch-tagged financial records: ${report.length}`);
    console.log('(READ-ONLY report — no records were modified)\n');
    if (report.length === 0) {
      console.log('None. Every branch-tagged record carries a resolvable stable branch id.');
    } else {
      for (const r of report) {
        console.log(`- [${r.recordType}] ${r.id}  customer=${r.customerId} (${r.customerName})  branch="${r.branchName}"`);
        console.log(`    reason: ${r.reason}`);
        if (r.candidateBranchIds.length) console.log(`    candidate branch ids: ${r.candidateBranchIds.join(', ')}`);
        console.log(`    action: ${r.suggestedAction}`);
      }
      console.log('\nThese records are EXCLUDED from branch statements (they cannot be attributed');
      console.log('safely) and are reported here for review. No automatic reclassification was performed.');
    }
  }
}

main().catch((err) => {
  console.error(`Unexpected failure: ${err && err.message ? err.message : err}. Nothing was changed.`);
  process.exit(3);
});

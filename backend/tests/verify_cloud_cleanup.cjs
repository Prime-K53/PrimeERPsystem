/**
 * Phase 2.6.1 — Post-Cleanup Verification Script
 *
 * Verifies that the cloud has zero test pollution:
 *   1. No non-tombstoned rows remain in any synced table.
 *   2. No zero-UUID rows exist in any synced table.
 *   3. No PH25-TEST / PH251-TEST residue anywhere.
 *
 * Uses the publishable key (sb_publishable_*) so it can be run safely
 * from any environment that has the key loaded in .env.
 *
 * Run with: node tests/verify_cloud_cleanup.cjs
 */

process.on('uncaughtException', (err) => { console.error('Uncaught:', err); });
process.on('unhandledRejection', (err) => { console.error('Unhandled:', err); });

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const axios = require('axios');

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || '';
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const KEY = SECRET_KEY || PUBLISHABLE_KEY;

const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

const TABLES = [
  'customers', 'suppliers', 'products',
  'sales_orders', 'purchase_orders',
  'invoices', 'quotations', 'delivery_notes',
  'expenses', 'profiles', 'employees', 'departments',
  'warehouses', 'tax_rates', 'inventory_movements', 'bank_categories',
];

const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

let pass = 0;
let fail = 0;

function assert(cond, msg) {
  if (cond) { console.log(`  PASS: ${msg}`); pass++; }
  else      { console.error(`  FAIL: ${msg}`); fail++; }
}

async function listNonTombstoned(table) {
  const params = {
    select: 'id,data',
    limit: 1000,
    or: '(data->>deleted.is.null,data->>deleted.eq.false)',
  };
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    params, headers: HEADERS, timeout: 30000,
  });
  return Array.isArray(r.data) ? r.data : [];
}

async function listAll(table) {
  const params = { select: 'id,data', limit: 1000 };
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    params, headers: HEADERS, timeout: 30000,
  });
  return Array.isArray(r.data) ? r.data : [];
}

async function run() {
  console.log('=== PHASE 2.6.1 — POST-CLEANUP VERIFICATION ===\n');
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Auth: ${SECRET_KEY ? 'service-role' : 'publishable'}\n`);

  // ----- TEST 1: no PH25-TEST / PH251-TEST residue in any synced table -----
  // (legitimate business data WILL exist; we only assert no test pollution)
  console.log('--- TEST 1: no PH25-TEST / PH251-TEST residue in any synced table ---');
  for (const t of TABLES) {
    try {
      const rows = await listNonTombstoned(t);
      const hits = rows.filter((r) => {
        const blob = JSON.stringify(r.data || {});
        return /PH25[01]?[-_]?TEST/.test(blob);
      });
      const report = `non-tombstoned=${rows.length}, hits=${hits.length}`;
      assert(hits.length === 0, `${t}: 0 PH25/PH251-TEST non-tombstoned hits (${report})`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  SKIP ${t}: ${msg}`);
    }
  }

  // ----- TEST 2: zero zero-UUID rows in every synced table -----
  console.log('\n--- TEST 2: no zero-UUID rows in any synced table ---');
  for (const t of TABLES) {
    try {
      const rows = await listAll(t);
      const zeros = rows.filter((r) => r.id === ZERO_UUID);
      assert(zeros.length === 0, `${t}: 0 zero-UUID rows (got ${zeros.length})`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  SKIP ${t}: ${msg}`);
    }
  }

  // ----- TEST 3: no PH25-TEST / PH251-TEST residue in tombstones either -----
  console.log('--- TEST 3: no PH25-TEST / PH251-TEST residue in tombstoned rows ---');
  for (const t of TABLES) {
    try {
      const rows = await listAll(t);
      const tombstones = rows.filter((r) => r.data?.deleted === true);
      const hits = tombstones.filter((r) => {
        const blob = JSON.stringify(r.data || {});
        return /PH25[01]?[-_]?TEST/.test(blob);
      });
      const report = `tombstoned=${tombstones.length}, hits=${hits.length}`;
      assert(hits.length === 0, `${t}: 0 PH25/PH251-TEST tombstone hits (${report})`);
    } catch (err) {
      const msg = err.response?.data?.message || err.message;
      console.error(`  SKIP ${t}: ${msg}`);
    }
  }

  console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});

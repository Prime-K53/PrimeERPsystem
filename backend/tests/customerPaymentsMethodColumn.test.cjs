/**
 * customerPaymentsMethodColumn.test.cjs — ACCEPTANCE for the legacy
 * `POST /api/customer-payments` / `GET /api/customer-payments` column mismatch.
 *
 * PROVEN defect (read-only inspection of the live legacy SQLite store):
 *   * `customer_payments` had ONLY a `method` column (0 rows),
 *   * `customerPaymentQuery.js` filters `WHERE payment_method = ?` → SQLITE_ERROR,
 *   * `POST /api/customer-payments` inserts `payment_method`          → SQLITE_ERROR,
 *   * the sibling `invoices` / `sales` tables already use `payment_method`.
 *
 * This suite runs the REAL migration (`db.cjs → migrateCustomerPaymentMethodColumn`)
 * and the REAL SQL from `index.cjs` / `customerPaymentQuery.cjs` against an
 * ISOLATED in-memory SQLite database. The live `backend/storage/database.db` is
 * never opened (this file requires only the exported helper, never `initDb` /
 * `getDatabase`).
 *
 * Run: cd backend && node --test tests/customerPaymentsMethodColumn.test.cjs
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const sqlite3 = require('sqlite3');

const { migrateCustomerPaymentMethodColumn } = require('../db.cjs');

/** The table exactly as the PRE-FIX `db.cjs` created it. */
const LEGACY_DDL = `CREATE TABLE customer_payments (
  id TEXT PRIMARY KEY,
  customer_id TEXT,
  customer_name TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  method TEXT DEFAULT 'Cash',
  account_id TEXT,
  reference TEXT,
  allocations_json TEXT,
  excess_amount REAL DEFAULT 0,
  excess_handling TEXT,
  notes TEXT,
  status TEXT DEFAULT 'Cleared',
  reconciled INTEGER DEFAULT 0,
  sub_account_name TEXT,
  sub_account_id TEXT,
  created_by TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`;

/** The exact INSERT from `POST /api/customer-payments` (index.cjs). */
const ROUTE_INSERT =
  `INSERT INTO customer_payments (id, date, customer_id, customer_name, amount, payment_method, account_id, reference, notes, status, sub_account_name, sub_account_id, created_by)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const ROUTE_INSERT_PARAMS = [
  'PAY-ROUTE-1', '2026-05-04', 'CUST-ACME', 'Acme Schools', 500, 'Bank Transfer',
  '11110', 'INV-1', '', 'Cleared', 'Main', '', null,
];

/** The exact method filter from `customerPaymentQuery.js`. */
const QUERY_METHOD_FILTER = 'SELECT * FROM customer_payments WHERE payment_method = ?';

const open = (sql) => new Promise((resolve) => {
  const db = new sqlite3.Database(':memory:', (err) => {
    if (err) { resolve({ db, error: err }); return; }
    db.exec(sql, (execErr) => resolve({ db, error: execErr }));
  });
});
const run = (db, sql, params = []) => new Promise((resolve) => db.run(sql, params, function (err) {
  resolve({ err, message: this && this.message });
}));
const all = (db, sql, params = []) => new Promise((resolve) => db.all(sql, params, (err, rows) => resolve({ err, rows: rows || [] })));
const close = (db) => new Promise((resolve) => db.close(() => resolve()));
const columns = async (db) => new Set((await all(db, 'PRAGMA table_info(customer_payments)')).rows.map((r) => r.name));

describe('customer_payments payment-method column', () => {
  let legacy;
  before(async () => {
    const opened = await open(`${LEGACY_DDL};\nINSERT INTO customer_payments (id, customer_name, amount, date, method) VALUES ('PAY-LEGACY-1','Old School',250,'2026-01-02','Mobile Money');`);
    assert.equal(opened.error, null, opened.error && opened.error.message);
    legacy = opened.db;
  });

  it('BEFORE the migration the route INSERT fails with "no such column"', async () => {
    assert.ok((await columns(legacy)).has('method'), 'fixture must reproduce the legacy shape');
    const { err } = await run(legacy, ROUTE_INSERT, ROUTE_INSERT_PARAMS);
    assert.ok(err, 'expected the route INSERT to fail on the legacy schema');
    assert.match(err.message, /no such column: payment_method|no column named payment_method/);
  });

  it('BEFORE the migration the method filter also fails', async () => {
    const { err } = await all(legacy, QUERY_METHOD_FILTER, ['Cash']);
    assert.ok(err);
    assert.match(err.message, /no such column: payment_method|no column named payment_method/);
  });

  it('the migration renames the column and preserves every stored value', async () => {
    const outcome = await migrateCustomerPaymentMethodColumn(legacy, { log() {}, error() {} });
    assert.equal(outcome, 'renamed');

    const names = await columns(legacy);
    assert.ok(names.has('payment_method'), 'payment_method must exist after the migration');
    assert.ok(!names.has('method'), 'the ambiguous `method` column must be gone (no second source of truth)');

    const kept = await all(legacy, 'SELECT id, payment_method FROM customer_payments ORDER BY id');
    assert.equal(kept.err, null);
    assert.deepEqual(kept.rows, [{ id: 'PAY-LEGACY-1', payment_method: 'Mobile Money' }]);
  });

  it('the migration is idempotent (a second run changes nothing and keeps the data)', async () => {
    assert.equal(await migrateCustomerPaymentMethodColumn(legacy, { log() {}, error() {} }), 'already-correct');
    const kept = await all(legacy, 'SELECT COUNT(*) AS n FROM customer_payments');
    assert.equal(kept.rows[0].n, 1);
  });

  it('AFTER the migration the route INSERT succeeds', async () => {
    const { err } = await run(legacy, ROUTE_INSERT, ROUTE_INSERT_PARAMS);
    assert.equal(err, null, err && err.message);
    const written = await all(legacy, 'SELECT id, payment_method, sub_account_name FROM customer_payments WHERE id = ?', ['PAY-ROUTE-1']);
    assert.deepEqual(written.rows, [{ id: 'PAY-ROUTE-1', payment_method: 'Bank Transfer', sub_account_name: 'Main' }]);
  });

  it('AFTER the migration the method filter works', async () => {
    const filtered = await all(legacy, QUERY_METHOD_FILTER, ['Mobile Money']);
    assert.equal(filtered.err, null, filtered.err && filtered.err.message);
    assert.deepEqual(filtered.rows.map((r) => r.id), ['PAY-LEGACY-1']);
  });

  it('a database with no customer_payments table is skipped safely', async () => {
    const empty = await open('CREATE TABLE unrelated (id TEXT)');
    assert.equal(await migrateCustomerPaymentMethodColumn(empty.db, { log() {}, error() {} }), 'skipped');
    await close(empty.db);
  });

  it('a missing db handle is skipped safely', async () => {
    assert.equal(await migrateCustomerPaymentMethodColumn(null), 'skipped');
  });
});
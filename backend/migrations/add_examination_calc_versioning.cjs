/**
 * Adds calculation versioning + immutable pricing snapshots to
 * examination_batches (EXAM-2026.1 hardening).
 *
 * - calculation_version: bumped on every successful recalculation.
 * - pricing_engine_version: engine that produced the calculation.
 * - pricing_snapshot_json: immutable inputs+result snapshot (WHY the amount).
 * - approved_calculation_version: version pinned at approval; invoicing
 *   consumes that snapshot and never reprices.
 *
 * Run with: node backend/migrations/add_examination_calc_versioning.cjs
 * Idempotent: ADD COLUMN is skipped when the column already exists.
 */
const path = require('path');

const COLUMNS = [
  ['calculation_version', 'INTEGER DEFAULT 0'],
  ['pricing_engine_version', 'TEXT'],
  ['pricing_snapshot_json', 'TEXT'],
  ['approved_calculation_version', 'INTEGER'],
  ['invoiced_calculation_version', 'INTEGER'],
];

async function runMigration() {
  const { db } = require('../db.cjs');
  const runRun = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });

  for (const [column, definition] of COLUMNS) {
    try {
      await runRun(`ALTER TABLE examination_batches ADD COLUMN ${column} ${definition}`);
      console.log(`[exam-calc-versioning] added examination_batches.${column}`);
    } catch (error) {
      if (String(error?.message || '').toLowerCase().includes('duplicate column name')) {
        console.log(`[exam-calc-versioning] examination_batches.${column} already exists — skipping`);
      } else {
        throw error;
      }
    }
  }
  console.log('[exam-calc-versioning] done');
}

if (require.main === module) {
  runMigration().catch((error) => {
    console.error('[exam-calc-versioning] FAILED:', error?.message || error);
    process.exit(1);
  });
}

module.exports = { runMigration };

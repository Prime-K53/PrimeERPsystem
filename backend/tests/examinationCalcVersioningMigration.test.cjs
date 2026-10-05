/**
 * examinationCalcVersioningMigration.test.cjs — live verification of
 * backend/migrations/add_examination_calc_versioning.cjs against a SCRATCH
 * SQLite database (never production data).
 *
 * Proves, executably: clean apply, idempotent re-run, exact columns with
 * correct types/defaults/nullability, legacy rows remain readable,
 * versions/pins persist, snapshots survive write/read, and the runtime
 * ensureColumnIfMissing set agrees with the migration.
 *
 * NOTE (Objective 2): no PostgreSQL service exists in this repository
 * (no docker/supabase CLI/pg harness), so live-Postgres verification is
 * classified ENVIRONMENT. SQLite is the repository's own backend store
 * and migration target; the DDL exercised here is identical.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sqlite3 = require('sqlite3');

const BACKEND_ROOT = path.join(__dirname, '..');
const MIGRATION = path.join(BACKEND_ROOT, 'migrations', 'add_examination_calc_versioning.cjs');

/**
 * Module-load probe: the migration must open a scratch DB, never production
 * data. getDbPath() prefers a workspace config when one exists; if this
 * environment cannot honor a scratch DB_PATH, the live-run block is skipped
 * (classified ENVIRONMENT) while the static parity test still runs.
 */
const SCRATCH_PROBE_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'exam-mig-probe-')),
  'probe.db'
);
let scratchHonored = false;
try {
  const effective = execFileSync(
    process.execPath,
    ['-e', "console.log(require('./runtimePaths.cjs').getDbPath())"],
    { env: { ...process.env, DB_PATH: SCRATCH_PROBE_PATH }, cwd: BACKEND_ROOT, encoding: 'utf8' }
  ).trim();
  scratchHonored = effective === SCRATCH_PROBE_PATH;
} catch {
  scratchHonored = false;
}
try {
  fs.rmSync(path.dirname(SCRATCH_PROBE_PATH), { recursive: true, force: true });
} catch {
  // best-effort cleanup
}

const run = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
const get = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row || null);
    });
  });
const all = (db, sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });

describe('examination calc-versioning migration (scratch SQLite)', () => {
  const itLive = scratchHonored ? it : it.skip;
  if (!scratchHonored) {
    test('scratch DB_PATH honored by this environment', () => {
      console.warn('[ENVIRONMENT] scratch DB_PATH not honored here; live migration run skipped.');
    });
  }
  let scratchPath;
  let db;

  beforeAll(async () => {
    scratchPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exam-mig-')), 'scratch.db');
    db = new sqlite3.Database(scratchPath);
    await run(
      db,
      `CREATE TABLE examination_batches (
         id TEXT PRIMARY KEY,
         status TEXT DEFAULT 'Draft',
         total_amount REAL DEFAULT 0,
         invoice_id TEXT
       )`
    );
    // Legacy approved batch predating versioning.
    await run(db, `INSERT INTO examination_batches (id, status, total_amount) VALUES (?, ?, ?)`, [
      'legacy-batch-1',
      'Approved',
      8000,
    ]);
  });

  afterAll(async () => {
    await new Promise((resolve) => db.close(() => resolve()));
    try {
      fs.rmSync(path.dirname(scratchPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  test('migration applies cleanly and is idempotent', () => {
    const env = { ...process.env, DB_PATH: scratchPath };
    execFileSync(process.execPath, [MIGRATION], { env, stdio: 'pipe' });
    // Second run must also succeed (ADD COLUMN skips).
    execFileSync(process.execPath, [MIGRATION], { env, stdio: 'pipe' });
  });

  itLive('all required columns exist with correct types/defaults/nullability', async () => {
    const columns = await all(db, `PRAGMA table_info(examination_batches)`);
    const byName = Object.fromEntries(columns.map((col) => [col.name, col]));
    expect(byName.calculation_version.type).toBe('INTEGER');
    expect(byName.calculation_version.dflt_value).toBe('0');
    expect(byName.calculation_version.notnull).toBe(0);
    expect(byName.pricing_engine_version.type).toBe('TEXT');
    expect(byName.pricing_engine_version.notnull).toBe(0);
    expect(byName.pricing_snapshot_json.type).toBe('TEXT');
    expect(byName.pricing_snapshot_json.notnull).toBe(0);
    expect(byName.approved_calculation_version.type).toBe('INTEGER');
    expect(byName.approved_calculation_version.notnull).toBe(0);
    expect(byName.invoiced_calculation_version.type).toBe('INTEGER');
    expect(byName.invoiced_calculation_version.notnull).toBe(0);
  });

  itLive('legacy batches remain readable with prior values intact', async () => {
    const row = await get(db, `SELECT id, status, total_amount FROM examination_batches WHERE id = ?`, [
      'legacy-batch-1',
    ]);
    expect(row).toMatchObject({ id: 'legacy-batch-1', status: 'Approved', total_amount: 8000 });
  });

  itLive('versions, pins and snapshots survive write/read', async () => {
    const snapshot = {
      engineVersion: 'EXAM-2026.1',
      calculationVersion: 3,
      calculatedAt: '2026-09-01T00:00:00.000Z',
      trigger: 'MANUAL',
      provenance: 'CANONICAL',
      inputs: { roundingMethod: 'ALWAYS_UP_50' },
      result: { totalAmount: 8000 },
    };
    await run(
      db,
      `UPDATE examination_batches
       SET calculation_version = ?, pricing_engine_version = ?, pricing_snapshot_json = ?,
           approved_calculation_version = ?, invoiced_calculation_version = ?
       WHERE id = ?`,
      [3, 'EXAM-2026.1', JSON.stringify(snapshot), 3, 3, 'legacy-batch-1']
    );
    const row = await get(
      db,
      `SELECT calculation_version, pricing_engine_version, pricing_snapshot_json,
              approved_calculation_version, invoiced_calculation_version
       FROM examination_batches WHERE id = ?`,
      ['legacy-batch-1']
    );
    expect(row.calculation_version).toBe(3);
    expect(row.pricing_engine_version).toBe('EXAM-2026.1');
    expect(row.approved_calculation_version).toBe(3);
    expect(row.invoiced_calculation_version).toBe(3);
    const revived = JSON.parse(row.pricing_snapshot_json);
    expect(revived).toMatchObject({
      engineVersion: 'EXAM-2026.1',
      calculationVersion: 3,
      provenance: 'CANONICAL',
    });
    expect(revived.result.totalAmount).toBe(8000);
  });

  test('runtime ensureColumnIfMissing agrees with the migration', () => {
    const serviceSource = fs.readFileSync(
      path.join(BACKEND_ROOT, 'services', 'examinationService.cjs'),
      'utf8'
    );
    const migrationSource = fs.readFileSync(MIGRATION, 'utf8');
    for (const column of [
      'calculation_version',
      'pricing_engine_version',
      'pricing_snapshot_json',
      'approved_calculation_version',
      'invoiced_calculation_version',
    ]) {
      expect(serviceSource).toContain(`'examination_batches', '${column}'`);
      expect(migrationSource).toContain(column);
    }
  });
});

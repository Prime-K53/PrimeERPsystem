/**
 * Phase 7J — authoritative courier/transport expense source: static contract.
 *
 * Verifies without a database:
 *  1. Migration 0034 creates the COA account, envelope table, checks,
 *     immutability trigger, unique backstops, and RLS posture.
 *  2. Frontend constants + backend COA seed carry the dedicated 52610
 *     account without corrupting 52600/Printing or 51300 semantics.
 *  3. Sync registration carries the new table (frontend maps + gateway
 *     allow-list) without touching the transport-budget allow-list shape.
 *  4. No OUTBOUND_CONSUMPTION producer exists anywhere.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const migrationSource = read(
  'supabase/migrations/0034_courier_expense_source.sql',
);
const constantsSource = read('frontend/constants.ts');
const financeSeedSource = read('backend/services/financeService.cjs');
const syncSource = read('backend/routes/sync.cjs');

describe('Phase 7J: migration 0034 static contract', () => {
  test('creates the dedicated 52610 COA account idempotently', () => {
    expect(migrationSource).toContain("'52610'");
    expect(migrationSource).toContain('Courier & Delivery Transport');
    expect(migrationSource).toContain('WHERE NOT EXISTS');
    expect(migrationSource).toContain("'allow_posting', true");
    expect(migrationSource).toContain("'normal_balance', 'DEBIT'");
  });

  test('creates the transport_expenses envelope table with lifecycle CHECKs', () => {
    expect(migrationSource).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.transport_expenses \(/,
    );
    expect(migrationSource).toContain('chk_transport_expenses_status');
    expect(migrationSource).toContain('chk_transport_expenses_key');
    expect(migrationSource).toContain('chk_transport_expenses_business_date');
    expect(migrationSource).toContain('chk_transport_expenses_reversal_shape');
  });

  test('adds idempotency + single-reversal unique backstops', () => {
    expect(migrationSource).toContain('uq_transport_expenses_idempotency_key');
    expect(migrationSource).toContain('uq_transport_expenses_reversal');
  });

  test('trigger enforces status machine, snapshots, caps, and immutability', () => {
    expect(migrationSource).toContain('transport_expenses_validate_write');
    expect(migrationSource).toContain('OUTBOUND_TRANSPORT');
    expect(migrationSource).toContain('NON_TRANSPORT');
    expect(migrationSource).toContain('was already reversed');
    expect(migrationSource).toContain('immutable');
    expect(migrationSource).toContain('was already reversed');
    expect(migrationSource).toContain('POSTED→VOIDED');
    expect(migrationSource).toContain('pg_advisory_xact_lock');
  });

  test('RLS posture follows the envelope allow_all convention', () => {
    expect(migrationSource).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(migrationSource).toContain('allow_all_transport_expenses');
  });

  test('migration is additive, single-company, tenant-free', () => {
    expect(migrationSource).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
    const ddl = migrationSource
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toContain('tenant_id');
    expect(ddl).not.toContain('organization_id');
    expect(ddl).not.toContain('company_id');
    expect(migrationSource).not.toMatch(/UPDATE public\.transport_expenses SET/i);
  });

  test('does not touch the transport-budget ledger contract', () => {
    expect(migrationSource).not.toMatch(/transport_budget_events/);
    expect(migrationSource).not.toContain('CONSUMPTION_CORRECTION');
    expect(migrationSource).not.toContain('INBOUND_CONSUMPTION');
  });
});

describe('Phase 7J: COA selection without semantic corruption', () => {
  test('frontend constants carry postable 52610 under Transport', () => {
    expect(constantsSource).toContain("'52610'");
    expect(constantsSource).toContain('Courier & Delivery Transport');
    expect(constantsSource).toMatch(/TRANSPORT_EXPENSE:\s*'52610'/);
  });

  test('backend COA seed carries 52610 as postable opex', () => {
    expect(financeSeedSource).toContain("'52610'");
    expect(financeSeedSource).toContain('Courier & Delivery Transport');
  });

  test('51300 remains inbound COGS-role and 52600 keeps its meaning', () => {
    expect(constantsSource).toContain("'51300'");
    expect(financeSeedSource).toContain('Freight & Carriage');
    expect(constantsSource).toMatch(/TRANSPORT:\s*'52600'/);
  });
});

describe('Phase 7J: sync registration without budget-producer surface', () => {
  test('gateway allow-list carries transport_expenses exactly once', () => {
    const matches = syncSource.match(/'transport_expenses'/g) || [];
    expect(matches).toHaveLength(1);
  });

  test('no OUTBOUND_CONSUMPTION producer exists', () => {
    for (const rel of [
      'backend/routes/sync.cjs',
      'backend/index.cjs',
      'backend/services/financeService.cjs',
    ]) {
      const src = read(rel);
      expect(src).not.toContain('OUTBOUND_CONSUMPTION');
      expect(src).not.toContain('produceOutbound');
      expect(src).not.toContain('consumeTransport');
    }
  });
});

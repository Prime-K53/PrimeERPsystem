/**
 * Phase 5 — Migration file repairs (A6 + A7).
 *
 * 0014: boolean/numeric backfills must be source-driven. The columns are
 * added WITH defaults (FALSE/TRUE/0), so `WHERE <col> IS NULL` matches zero
 * rows on a fresh apply and silently keeps the defaults.
 *
 * 0016: ledger_entries is a JSONB envelope (id, data, created_at,
 * updated_at, version) with one data->>'account_id' per row — there are NO
 * top-level debit_account_id/credit_account_id columns, and expressions are
 * illegal in ADD CONSTRAINT UNIQUE.
 */
const { describe, it, expect } = require('@jest/globals');
const fs = require('node:fs');
const path = require('node:path');

const readMigration = (name) =>
  fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'migrations', name), 'utf8');

describe('0014 backfills converge (A6)', () => {
  const src = readMigration('0014_coa_new_columns.sql');

  it('drives boolean/numeric backfills off the JSONB source, not IS NULL', () => {
    expect(src).not.toMatch(/WHERE is_system_account IS NULL/);
    expect(src).not.toMatch(/WHERE allow_posting IS NULL/);
    expect(src).not.toMatch(/WHERE opening_balance IS NULL/);
    expect(src).toMatch(/WHERE data->>'is_system_account' IS NOT NULL/);
    expect(src).toMatch(/WHERE TRUE/);
    expect(src).toMatch(/WHERE data->>'opening_balance' IS NOT NULL/);
  });

  it('tolerates string-encoded flags', () => {
    expect(src).toMatch(/IN \('1', 'true', 't', 'yes', 'on'\)/);
  });
});

describe('0016 matches the envelope model (A7)', () => {
  const src = readMigration('0016_accounting_coa_migration.sql');

  it('remaps account references inside data, not phantom columns', () => {
    expect(src).not.toMatch(/SET debit_account_id/);
    expect(src).not.toMatch(/ledger_entries \(debit_account_id\)/);
    expect(src).toMatch(/data->>'account_id'/);
  });

  it('enforces uniqueness with an expression index, not ADD CONSTRAINT', () => {
    expect(src).not.toMatch(/ADD CONSTRAINT IF NOT EXISTS/);
    expect(src).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_number_unique/);
  });
});

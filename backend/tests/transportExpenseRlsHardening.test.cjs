/**
 * Phase 9B Blocker B — transport_expenses RLS hardening.
 *
 * Migration 0038 replaces the 0034 allow-all policy
 * (FOR ALL TO authenticated) with SELECT-only, mirroring the 0030
 * ledger precedent. All frontend mutations already flow
 * IndexedDB -> durable queue -> POST /api/sync/ops (Admin-gated) ->
 * service-role gateway, so no legitimate direct-write path exists.
 *
 * Static-contract tests pin the migration text (established hermetic
 * backend-test architecture: no live Supabase).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const migrationSource = read(
  'supabase/migrations/0038_transport_expenses_rls_hardening.sql',
);
const previousSource = read(
  'supabase/migrations/0034_courier_expense_source.sql',
);

describe('Phase 9B: transport_expenses RLS hardening (Blocker B)', () => {
  test('drops the allow-all policy', () => {
    expect(migrationSource).toContain(
      'DROP POLICY IF EXISTS "allow_all_transport_expenses"',
    );
  });

  test('recreates SELECT-only for authenticated (0030 ledger precedent)', () => {
    expect(migrationSource).toContain(
      'CREATE POLICY "allow_select_transport_expenses"',
    );
    expect(migrationSource).toMatch(/FOR SELECT\s+TO authenticated/);
    // No INSERT/UPDATE/DELETE/ALL grant is created anywhere in the file
    // outside the verification block's pg_policies reads.
    const ddl = migrationSource
      .split('2. VERIFICATION BLOCK')[0]
      .replace(/--[^\n]*/g, '');
    expect(ddl).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
  });

  test('verification pins exactly one policy and the surviving trigger', () => {
    expect(migrationSource).toContain('trg_transport_expenses_validate_write');
    expect(migrationSource).toMatch(
      /expected exactly 1 transport_expenses policy/,
    );
    expect(migrationSource).toMatch(/retains a write policy/);
  });

  test('0034 trigger chain is untouched (validate_write still governs)', () => {
    expect(previousSource).toContain(
      'CREATE OR REPLACE FUNCTION public.transport_expenses_validate_write()',
    );
    expect(migrationSource).not.toMatch(
      /CREATE OR REPLACE FUNCTION public\.transport_expenses_validate_write/,
    );
    expect(migrationSource).not.toMatch(/ALTER TABLE public\.transport_expenses/);
  });
});

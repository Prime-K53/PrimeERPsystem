/**
 * Examination invoice RLS hardening (no tenancy — single-company ERP).
 *
 * Migration 0040 replaces the 0001 allow-all policies
 * (FOR ALL TO authenticated USING (true) WITH CHECK (true)) on invoices,
 * examination_batches, examination_classes, examination_subjects and
 * documents with SELECT-only, mirroring the 0030/0038 ledger precedent.
 * All frontend mutations already flow IndexedDB -> durable queue ->
 * POST /api/sync/ops (Admin-gated) -> service-role gateway, so no
 * legitimate direct-write path exists (verified by repository-wide scan:
 * no supabase.from('<table>').insert/update/upsert/delete in
 * frontend/{services,utils,views,components,stores,context,hooks}).
 *
 * Static-contract tests pin the migration text (established hermetic
 * backend-test architecture: no live Supabase).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const migrationSource = read(
  'supabase/migrations/0040_examination_invoice_rls_hardening.sql',
);

const TARGET_TABLES = [
  'invoices',
  'examination_batches',
  'examination_classes',
  'examination_subjects',
  'documents',
];

describe('examination invoice RLS hardening (0040)', () => {
  test.each(TARGET_TABLES)('drops the allow-all policy on %s', (table) => {
    expect(migrationSource).toContain(`DROP POLICY IF EXISTS "allow_all_${table}"`);
  });

  test.each(TARGET_TABLES)('recreates SELECT-only for authenticated on %s', (table) => {
    expect(migrationSource).toContain(`CREATE POLICY "allow_select_${table}"`);
  });

  test('grants SELECT to authenticated and no write commands anywhere in the DDL', () => {
    expect(migrationSource).toMatch(/FOR SELECT\s+TO authenticated/);
    // No INSERT/UPDATE/DELETE/ALL grant is created anywhere in the file
    // outside the verification block's pg_policies reads.
    const ddl = migrationSource
      .split('2. VERIFICATION BLOCK')[0]
      .replace(/--[^\n]*/g, '');
    expect(ddl).not.toMatch(/FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(ddl).not.toMatch(/WITH CHECK/);
  });

  test('verification block pins exactly one policy and no write policy per table', () => {
    for (const table of TARGET_TABLES) {
      expect(migrationSource).toContain(table);
    }
    expect(migrationSource).toMatch(/expected exactly 1 % policy/);
    expect(migrationSource).toMatch(/retains a write policy/);
  });

  test('migration is policy-only (no tenancy, no schema changes)', () => {
    const ddl = migrationSource
      .split('2. VERIFICATION BLOCK')[0]
      .replace(/--[^\n]*/g, '');
    expect(ddl).not.toMatch(/ALTER TABLE/);
    expect(ddl).not.toMatch(/tenant_id|organization_id|company_id/);
  });
});

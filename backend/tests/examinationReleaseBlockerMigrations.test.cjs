/**
 * Static contracts for the Examination release-blocker migrations 0057-0060.
 *
 * These are intentionally source-level tests: the project's backend suite is
 * hermetic (no live Supabase), and a migration that looks safe but omits a
 * REVOKE or writes financial history is exactly the class of defect this pins.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const m0057 = read('supabase/migrations/0057_examination_rpc_acl_hardening.sql');
const m0058 = read('supabase/migrations/0058_examination_rls_write_lockdown.sql');
const m0059 = read('supabase/migrations/0059_examination_integrity_and_token_hardening.sql');
const m0060 = read('supabase/migrations/0060_examination_orphan_reconciliation.sql');
const report = read('supabase/ops/report_examination_orphans.sql');

const stripComments = (sql) => sql
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n');

const executable = (sql) => stripComments(sql);

describe('0057 — authoritative posting RPC ACLs', () => {
  it('revokes every client role from post, void and assert', () => {
    const functions = [
      'post_examination_invoice_atomic',
      'void_examination_invoice_atomic',
      'assert_examination_invoice_number_unique',
    ];

    for (const fn of functions) {
      expect(m0057).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(m0057).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}`);
    }

    expect(m0057).toMatch(/FROM PUBLIC, anon, authenticated/);
    expect(m0057).toContain('TO service_role');
  });

  it('verifies that no client grant survives and the claim RPC stays closed', () => {
    expect(m0057).toContain("has_function_privilege('anon'");
    expect(m0057).toContain("has_function_privilege('authenticated'");
    expect(m0057).toMatch(/has_function_privilege\(\s*'service_role'/);
    expect(m0057).toContain('claim_next_examination_invoice_number');
  });
});

describe('0058 — Examination and ledger RLS write lockdown', () => {
  const tables = [
    'examination_batch_notifications',
    'examination_bom_calculations',
    'examination_class_adjustments',
    'examination_inventory_deductions',
    'examination_invoice_groups',
    'examination_job_subjects',
    'examination_jobs',
    'examination_papers',
    'examination_pricing_audit',
    'examination_printing_batches',
    'examination_recurring_profiles',
    'examinations',
    'ledger_entries',
  ];

  it('covers all twelve examination tables plus the authoritative ledger', () => {
    for (const table of tables) {
      expect(m0058).toContain(`'${table}'`);
    }
  });

  it('replaces allow-all with SELECT-only for authenticated', () => {
    expect(m0058).toContain("DROP POLICY IF EXISTS %I ON public.%I', 'allow_all_' || v_table");
    expect(m0058).toContain("FOR SELECT TO authenticated USING (true)");
    expect(m0058).not.toMatch(/FOR ALL TO authenticated/i);
  });

  it('fails the migration if a write policy survives', () => {
    expect(m0058).toContain("cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')");
    expect(m0058).toContain("v_policy_count <> 1");
    expect(m0058).toContain('relrowsecurity');
  });
});

describe('0059 — reference-aware integrity and token hardening', () => {
  it('reads the real ledger lineage (referenceId) with legacy fallbacks', () => {
    expect(m0059).toContain("data->>'referenceId'");
    expect(m0059).toContain("data->>'reference_id'");
    expect(m0059).toContain("data->>'invoiceNumber'");
    expect(m0059).toContain('referenceId%');
  });

  it('reports orphan AR impact and no longer returns zero findings', () => {
    expect(m0059).toContain('orphan_ledger_exam_invoice');
    expect(m0059).toContain('net_amount');
    expect(m0059).toContain('debitAccountId');
    expect(m0059).toContain('creditAccountId');
    expect(m0059).toContain('duplicate_verification_token');
    expect(m0059).toContain('invoice_without_verification_token');
  });

  it('backfills only missing tokens and never regenerates an existing one', () => {
    const update = executable(m0059).match(
      /UPDATE public\.invoices[\s\S]*?;/i
    );
    expect(update).not.toBeNull();
    expect(update[0]).toContain("gen_random_bytes(32)");
    expect(update[0]).toContain("data->>'verificationToken'");
    expect(update[0]).toContain('IS NULL');
  });

  it('adds a unique index scoped to live tokened rows', () => {
    expect(m0059).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_verification_token_unique');
    expect(m0059).toContain("WHERE nullif(btrim(coalesce(data->>'verificationToken', '')), '') IS NOT NULL");
  });

  it('does not repair or destroy financial history', () => {
    const sql = executable(m0059).toUpperCase();
    expect(sql).not.toContain('DELETE FROM PUBLIC.LEDGER_ENTRIES');
    expect(sql).not.toContain('UPDATE PUBLIC.LEDGER_ENTRIES');
  });
});

describe('0060 — non-destructive orphan reconciliation', () => {
  it('records decisions append-only', () => {
    expect(m0060).toContain('CREATE TABLE IF NOT EXISTS public.examination_reconciliation_decisions');
    expect(m0060).toContain('examination_reconciliation_decision_immutable');
    expect(m0060).toContain('BEFORE UPDATE OR DELETE');
    expect(m0060).toContain("decision IN ('WRITE_OFF', 'LINK_TO_INVOICE', 'RETAIN_AS_HISTORY', 'IGNORE')");
  });

  it('computes AR impact from the AR account and keeps the ledger untouched', () => {
    expect(m0060).toContain("= '11310'");
    expect(m0060).toContain('net_ar_impact');
    expect(m0060).toContain('examination_orphan_ledger_reconciliation');

    const sql = executable(m0060).toUpperCase();
    expect(sql).not.toContain('DELETE FROM PUBLIC.LEDGER_ENTRIES');
    expect(sql).not.toContain('UPDATE PUBLIC.LEDGER_ENTRIES');
    expect(sql).not.toContain('INSERT INTO PUBLIC.LEDGER_ENTRIES');
  });

  it('exposes the decision RPC to service_role only', () => {
    expect(m0060).toContain('record_examination_reconciliation_decision');
    expect(m0060).toMatch(
      /REVOKE ALL ON FUNCTION public\.record_examination_reconciliation_decision\([\s\S]*?FROM PUBLIC, anon, authenticated/
    );
    expect(m0060).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.record_examination_reconciliation_decision\([\s\S]*?TO service_role/
    );
  });
});

describe('operator report is read-only', () => {
  it('contains SELECT statements only', () => {
    const statements = report
      .split('\n')
      .filter((line) => !line.trim().startsWith('--') && !line.trim().startsWith('\\'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);

    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      expect(statement.toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });
});

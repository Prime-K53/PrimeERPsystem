-- ============================================================================
-- 0058_examination_rls_write_lockdown.sql
--
-- Close the remaining FOR ALL policies that let any authenticated client
-- INSERT/UPDATE/DELETE authoritative Examination and ledger rows directly
-- through PostgREST.
--
-- Frozen defect (verified against live project rdtuzuzehfbwvfdzqliw):
--   13 tables still carry an `allow_all_*` policy for `authenticated`
--   (`FOR ALL USING (true) WITH CHECK (true)`):
--     examination_batch_notifications
--     examination_bom_calculations
--     examination_class_adjustments
--     examination_inventory_deductions
--     examination_invoice_groups
--     examination_job_subjects
--     examination_jobs
--     examination_papers
--     examination_pricing_audit
--     examination_printing_batches
--     examination_recurring_profiles
--     examinations
--     ledger_entries
--
-- The first twelve bypass the Examination pricing/approval/stock workflow.
-- ledger_entries is worse: it is the authoritative financial journal, so a
-- direct client write can create or alter AR/revenue history underneath every
-- accounting invariant in the application.
--
-- Access-model evidence (verified before writing this migration):
--   - Frontend reads via the anon-key client with the user JWT: generic pull
--     SELECT + realtime (frontend/services/syncService.ts). SELECT for
--     authenticated is REQUIRED.
--   - Frontend never writes these tables through PostgREST. Every create/
--     post/void flows IndexedDB -> durable queue -> POST /api/sync/ops
--     (Admin-gated) -> service-role gateway. The repository guard
--     frontend/tests/services/supabaseWritePathGuard.test.ts already pins
--     that rule for `ledger_entries` and the Examination tables.
--   - The sync gateway writes with the service-role key (RLS bypass); these
--     policies do not affect it.
--   - Public document verification is served through the backend proxy with
--     the service-role key and never reads through these client policies.
--
-- This mirrors the SELECT-only precedent of 0030/0038/0040.
--
-- SCOPE: RLS policies only. No trigger/column/index/producer/accounting/UI
-- changes. No tenancy fields (single-company ERP by design).
-- ============================================================================

BEGIN;

-- ─── 1. Replace every allow-all policy with SELECT-only ─────────────────────
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
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
    'ledger_entries'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    IF to_regclass(format('public.%I', v_table)) IS NULL THEN
      RAISE EXCEPTION '0058 pre-flight failed: table public.% does not exist', v_table;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'allow_all_' || v_table, v_table);
    -- Idempotency: a re-run must replace, not collide with, the policy this
    -- migration created on the previous attempt.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'allow_select_' || v_table, v_table);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (true)',
      'allow_select_' || v_table,
      v_table
    );
  END LOOP;
END $$;

-- ─── 2. Verification: exactly one SELECT policy, no write policy ────────────
DO $$
DECLARE
  v_table TEXT;
  v_tables TEXT[] := ARRAY[
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
    'ledger_entries'
  ];
  v_rls BOOLEAN;
  v_policy_count INTEGER;
  v_write_policy_count INTEGER;
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    SELECT relrowsecurity INTO v_rls
    FROM pg_class
    WHERE oid = format('public.%I', v_table)::regclass;

    IF v_rls IS NOT TRUE THEN
      RAISE EXCEPTION '0058 verification failed: RLS is not enabled on %', v_table;
    END IF;

    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = v_table;

    IF v_policy_count <> 1 THEN
      RAISE EXCEPTION
        '0058 verification failed: expected exactly 1 % policy, found %',
        v_table, v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_write_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = v_table
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL');

    IF v_write_policy_count <> 0 THEN
      RAISE EXCEPTION
        '0058 verification failed: % retains a write policy', v_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = v_table
        AND policyname = 'allow_select_' || v_table
        AND cmd = 'SELECT'
        AND roles = ARRAY['authenticated']::name[]
    ) THEN
      RAISE EXCEPTION
        '0058 verification failed: % does not have its SELECT-only policy',
        v_table;
    END IF;
  END LOOP;
END $$;

COMMIT;

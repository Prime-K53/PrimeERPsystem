-- ============================================================================
-- 0040_examination_invoice_rls_hardening.sql
--
-- Prime ERP — Examination invoice RLS hardening (no tenancy).
--
-- Frozen defect: 0001 created allow_all_* policies
-- (FOR ALL TO authenticated USING (true) WITH CHECK (true)) on invoices,
-- examination_batches, examination_classes, examination_subjects and
-- documents, so any authenticated client could directly INSERT/UPDATE/DELETE
-- authoritative financial rows via PostgREST — underneath the Admin-gated
-- sync gateway, the canonical pricing engine, idempotency/collision
-- handling, and verification-token issuance that are supposed to govern
-- every examination financial write.
--
-- Access-model evidence (verified before writing this migration):
--   - Frontend reads via anon-key client with user JWT: generic pull
--     SELECT + realtime (syncService.ts). SELECT for authenticated is
--     REQUIRED (offline pull, realtime, portal reads that go through the
--     same policies).
--   - Frontend NEVER writes these tables via PostgREST: every create/post/
--     void flows IndexedDB -> durable queue -> POST /api/sync/ops
--     (Admin-gated, table allow-list, per-table validators) ->
--     service-role cloudSyncStore. No supabase.from('<table>')
--     insert/update/delete/upsert exists in frontend/{services,utils,views,
--     components,stores,context,hooks} (only the legacy idempotency_keys
--     probe, a different table, and generic pull SELECTs remain).
--   - Backend gateway uses the service-role key (RLS bypass) for all
--     writes; service-role is unaffected by these policies.
--   - Public verification is served by the backend proxy with the
--     service-role key and never reads through these client policies.
--
-- This migration narrows each policy to the 0030/0038 ledger precedent:
--   FOR SELECT TO authenticated USING (true); nothing else.
-- Direct authenticated INSERT/UPDATE/DELETE is rejected by RLS; the
-- service-role gateway path is unaffected.
--
-- SCOPE: RLS policy only. No trigger/column/index/producer/accounting/
-- sync/UI changes. No tenancy fields (single-company ERP by design).
-- ============================================================================


-- ============================================================================
-- 1. Replace the allow-all policies with SELECT-only (mirrors 0030/0038)
-- ============================================================================

DROP POLICY IF EXISTS "allow_all_invoices"
    ON public.invoices;
CREATE POLICY "allow_select_invoices"
    ON public.invoices
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "allow_all_examination_batches"
    ON public.examination_batches;
CREATE POLICY "allow_select_examination_batches"
    ON public.examination_batches
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "allow_all_examination_classes"
    ON public.examination_classes;
CREATE POLICY "allow_select_examination_classes"
    ON public.examination_classes
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "allow_all_examination_subjects"
    ON public.examination_subjects;
CREATE POLICY "allow_select_examination_subjects"
    ON public.examination_subjects
    FOR SELECT
    TO authenticated
    USING (true);

DROP POLICY IF EXISTS "allow_all_documents"
    ON public.documents;
CREATE POLICY "allow_select_documents"
    ON public.documents
    FOR SELECT
    TO authenticated
    USING (true);


-- ============================================================================
-- 2. VERIFICATION BLOCK
-- ============================================================================

DO $$
DECLARE
    v_table TEXT;
    v_policy_count INTEGER;
    v_write_policy_count INTEGER;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'invoices',
        'examination_batches',
        'examination_classes',
        'examination_subjects',
        'documents'
    ] LOOP
        -- Exactly one policy survives per table, and it is the SELECT policy.
        SELECT COUNT(*) INTO v_policy_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table;
        IF v_policy_count <> 1 THEN
            RAISE EXCEPTION
                '0040 verification failed: expected exactly 1 % policy, found %',
                v_table, v_policy_count;
        END IF;

        SELECT COUNT(*) INTO v_write_policy_count
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = v_table
          AND (cmd = 'INSERT' OR cmd = 'ALL'
               OR cmd = 'UPDATE' OR cmd = 'DELETE');
        IF v_write_policy_count <> 0 THEN
            RAISE EXCEPTION
                '0040 verification failed: % retains a write policy', v_table;
        END IF;
    END LOOP;
END $$;

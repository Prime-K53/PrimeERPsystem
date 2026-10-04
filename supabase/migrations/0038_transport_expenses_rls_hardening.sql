-- ============================================================================
-- 0038_transport_expenses_rls_hardening.sql
--
-- Prime ERP — Phase 9B Blocker B: harden transport_expenses RLS.
--
-- Frozen defect: 0034 created policy "allow_all_transport_expenses"
-- (FOR ALL TO authenticated USING (true) WITH CHECK (true)), so any
-- authenticated client could directly INSERT/UPDATE/DELETE authoritative
-- outbound transport source rows via PostgREST — underneath the Transport
-- Budget ledger that trusts posted transport-expense data.
--
-- Access-model evidence (verified before writing this migration):
--   - Frontend reads via anon-key client with user JWT: generic pull
--     SELECT + realtime (syncService.ts). SELECT for authenticated is
--     REQUIRED.
--   - Frontend NEVER writes via PostgREST: every create/post/void flows
--     IndexedDB -> durable queue -> POST /api/sync/ops (Admin-gated) ->
--     service-role cloudSyncStore. No supabase.from('transport_expenses')
--     insert/update/delete/rpc exists outside the generic pull SELECT.
--   - Backend gateway uses the service-role key (RLS bypass) for all
--     writes; the 0034 validate_write trigger still governs legality.
--
-- This migration narrows the policy to the exact 0030 ledger precedent:
--   FOR SELECT TO authenticated USING (true); nothing else.
-- Direct authenticated INSERT/UPDATE/DELETE is rejected by RLS; the
-- service-role gateway path (and its trigger validation) is unaffected.
--
-- SCOPE: RLS policy only. No trigger/column/index/producer/accounting/
-- sync/UI changes.
-- ============================================================================


-- ============================================================================
-- 1. Replace the allow-all policy with SELECT-only (mirrors 0030)
-- ============================================================================

DROP POLICY IF EXISTS "allow_all_transport_expenses"
    ON public.transport_expenses;

CREATE POLICY "allow_select_transport_expenses"
    ON public.transport_expenses
    FOR SELECT
    TO authenticated
    USING (true);


-- ============================================================================
-- 2. VERIFICATION BLOCK
-- ============================================================================

DO $$
DECLARE
    v_policy_count INTEGER;
    v_insert_policy_count INTEGER;
    v_trigger_count INTEGER;
BEGIN
    -- Exactly one policy survives, and it is the SELECT policy.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_expenses';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION
            '0038 verification failed: expected exactly 1 transport_expenses policy, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_insert_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_expenses'
      AND (cmd = 'INSERT' OR cmd = 'ALL'
           OR cmd = 'UPDATE' OR cmd = 'DELETE');
    IF v_insert_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0038 verification failed: transport_expenses retains a write policy';
    END IF;

    -- The 0034 write-validation trigger still governs the service-role path.
    SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger
    WHERE tgrelid = 'public.transport_expenses'::regclass
      AND tgname = 'trg_transport_expenses_validate_write';
    IF v_trigger_count <> 1 THEN
        RAISE EXCEPTION
            '0038 verification failed: transport_expenses write-validation trigger missing';
    END IF;
END $$;

-- ============================================================================
-- 0030_transport_budget_ledger_hardening.sql
--
-- Prime ERP — Phase 4A: Transport Budget Event Ledger hardening.
--
-- Narrowly scoped, non-destructive follow-up to 0029. Modifies ONLY the
-- `transport_budget_events` ledger and its own function/policies.
-- No other table is touched. No tenant/company partitioning is introduced
-- (single-company system: NO tenant_id / organization_id / company_id).
--
-- 1. RATE PRECISION (structural contract enforcement)
--    The frozen configuration contract permits allocation rates of
--    0..100 with at most 4 decimal places. 0029 enforced the range but not
--    the precision boundary. The CHECK below enforces both, without rounding
--    or converting the supplied value. Money fields (2dp via `roundMoney`)
--    are a separate concept and are untouched.
--
-- 2. AUTHORIZATION (Pattern A — service-role/backend mutation)
--    Audit finding: 0029 granted authenticated clients both direct table
--    INSERT (WITH CHECK (true)) and EXECUTE on the invoker-rights append
--    RPC, while the trigger layer performs shape validation only. Any
--    authenticated client could therefore manufacture a valid-looking
--    economic event (e.g. SALES_ALLOCATION +100000 @ 3%) without going
--    through an authorized producer.
--    The established ERP architecture already centralizes ALL business-data
--    writes in the Admin-gated sync gateway (POST /api/sync/ops, service
--    role; direct frontend writes to business tables do not exist — the
--    only direct Supabase writes are storage uploads and best-effort
--    idempotency-key records). This migration aligns the ledger with that
--    architecture: authenticated clients keep SELECT (pull/realtime);
--    appends flow through the gateway as service-role. The offline-first
--    flow is unaffected: events are still calculated locally, persisted
--    locally with stable ids, queued, and synchronized later — the gateway
--    authorizes the append (Admin role), it never requires the original
--    sales transaction to be present server-side.
-- ============================================================================


-- ============================================================================
-- 1. RATE PRECISION: 0..100 with at most 4 decimal places (no rounding)
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_rate;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_rate CHECK (
        COALESCE(data->>'allocationRatePercent', '') = ''
        OR (
            (data->>'allocationRatePercent') ~ '^[0-9]+(\.[0-9]{1,4})?$'
            AND (data->>'allocationRatePercent')::numeric BETWEEN 0 AND 100
        )
    );


-- ============================================================================
-- 2. DENY DIRECT AUTHENTICATED APPENDS (reads stay permitted)
--
-- After this statement the table carries exactly one policy (SELECT for
-- authenticated). Direct PostgREST INSERT/UPDATE/DELETE are denied for anon
-- and authenticated roles. The service-role sync gateway bypasses RLS and
-- remains the single cloud append path, guarded by its existing Admin-only
-- authentication.
-- ============================================================================

DROP POLICY IF EXISTS "allow_insert_transport_budget_events"
    ON public.transport_budget_events;


-- ============================================================================
-- 3. RESTRICT THE APPEND RPC TO THE SERVICE ROLE
--
-- The function keeps invoker rights (no SECURITY DEFINER escalation): with
-- the INSERT policy gone, any residual authenticated call would fail on RLS
-- anyway. Revoking PUBLIC + authenticated EXECUTE closes the RPC as an
-- append vector entirely; service-role retains it for admin tooling and
-- future authorized server-side producers.
-- ============================================================================

REVOKE ALL ON FUNCTION public.append_transport_budget_event(JSONB)
    FROM PUBLIC, authenticated;

GRANT EXECUTE ON FUNCTION public.append_transport_budget_event(JSONB)
    TO service_role;


-- ============================================================================
-- 4. POST-MIGRATION VERIFICATION (read-only checks)
-- ============================================================================

DO $$
DECLARE
    v_policy_count INTEGER;
    v_insert_policy_count INTEGER;
    v_rate_check_def TEXT;
    v_auth_can_execute BOOLEAN;
    v_service_can_execute BOOLEAN;
    v_tenant_cols INTEGER;
BEGIN
    -- Exactly one policy remains: the authenticated SELECT policy.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION
            '0030 verification failed: expected 1 RLS policy, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_insert_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND cmd = 'INSERT';
    IF v_insert_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0030 verification failed: authenticated INSERT policy still present';
    END IF;

    -- Rate constraint enforces the 4-decimal structural boundary.
    SELECT pg_get_constraintdef(oid) INTO v_rate_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_rate';
    IF v_rate_check_def IS NULL
       OR v_rate_check_def NOT LIKE '%{1,4}%' THEN
        RAISE EXCEPTION
            '0030 verification failed: rate precision constraint missing or stale';
    END IF;

    -- RPC is executable by service_role but NOT by authenticated.
    SELECT has_function_privilege(
        'authenticated',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_auth_can_execute;
    IF COALESCE(v_auth_can_execute, TRUE) IS NOT FALSE THEN
        RAISE EXCEPTION
            '0030 verification failed: authenticated can still EXECUTE the append RPC';
    END IF;

    SELECT has_function_privilege(
        'service_role',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_service_can_execute;
    IF COALESCE(v_service_can_execute, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0030 verification failed: service_role lost EXECUTE on the append RPC';
    END IF;

    -- Single-company guard (unchanged): no multi-tenant columns, ever.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_budget_events'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION
            '0030 verification failed: unexpected tenant partitioning columns (%)',
            v_tenant_cols;
    END IF;

    RAISE NOTICE
        '0030 verification PASSED: 4dp rate boundary enforced, append restricted to service-role path';
END $$;


-- ============================================================================
-- End of 0030
-- ============================================================================

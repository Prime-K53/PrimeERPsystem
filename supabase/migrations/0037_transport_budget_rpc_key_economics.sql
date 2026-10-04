-- ============================================================================
-- 0037_transport_budget_rpc_key_economics.sql
--
-- Prime ERP — Phase 9B Blocker A: same-key economic conflict in the append RPC.
--
-- Frozen defect: append_transport_budget_event() resolved an existing row by
-- idempotencyKey and returned it WITHOUT comparing economics, so same key +
-- different economics silently resolved to a stale event (the frontend
-- repository rejects this with TransportBudgetIdempotencyConflictError).
--
-- This migration is additive and surgical:
--   - same id + identical payload        -> existing row (unchanged)
--   - same id + different payload        -> exception (unchanged)
--   - same key + same economics          -> existing row (unchanged)
--   - same key + different economics     -> NEW deterministic exception
--   - same-key concurrent calls          -> serialized on a key-scoped
--     transaction advisory lock (no global lock; distinct keys never
--     contend), so the second caller deterministically observes the
--     winner's row instead of racing past the checks.
--
-- Economics comparison covers the persisted semantic payload:
--   kind, amount, sourceEventId, sourceAmount, allocationRatePercent,
--   method, providerId, reversesEventId, correctsEventId, businessDate.
-- Volatile transport fields are deliberately EXCLUDED (id, createdAt,
-- occurredAt): wall-clock timing is not economics, and excluding it keeps
-- legitimate retries convergent. NULL-safe comparison throughout
-- (IS NOT DISTINCT FROM).
--
-- SCOPE: replaces ONLY the RPC body. No CHECK/index/trigger/RLS/grant
-- changes. No producer, accounting, sync, or UI changes. Signature and
-- privileges are unchanged (CREATE OR REPLACE preserves grants; the
-- 0030 service-role-only posture is re-asserted below idempotently).
-- ============================================================================


-- ============================================================================
-- 1. RPC: same-key economic conflict (replaces 0029 body verbatim otherwise)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.append_transport_budget_event(p_event JSONB)
RETURNS JSONB AS $$
DECLARE
    v_id TEXT;
    v_key TEXT;
    v_row public.transport_budget_events%ROWTYPE;
BEGIN
    v_id := NULLIF(p_event->>'id', '');
    v_key := NULLIF(p_event->>'idempotencyKey', '');

    IF v_id IS NULL THEN
        RAISE EXCEPTION
            'transport_budget_events: append requires a client-generated id';
    END IF;
    IF v_key IS NULL THEN
        RAISE EXCEPTION
            'transport_budget_events: append requires idempotencyKey';
    END IF;

    -- Serialize concurrent appends sharing one economic key. Transaction-
    -- scoped and key-scoped: distinct keys never contend, so there is no
    -- global lock and no balance/cap semantics change.
    PERFORM pg_advisory_xact_lock(hashtext('tbe-key:' || v_key));

    -- Physical retry: same id, identical payload -> the same row.
    SELECT * INTO v_row
    FROM public.transport_budget_events
    WHERE id = v_id;
    IF FOUND THEN
        IF v_row.data = (p_event - 'id') THEN
            RETURN row_to_json(v_row)::JSONB;
        END IF;
        RAISE EXCEPTION
            'transport_budget_events: id % already exists with a different payload',
            v_id;
    END IF;

    -- Economic retry: same idempotency key -> the same economic event.
    -- A conflicting reuse (same key, different economics) is rejected
    -- loudly instead of silently resolving to stale economics.
    SELECT * INTO v_row
    FROM public.transport_budget_events
    WHERE (data->>'idempotencyKey') = v_key;
    IF FOUND THEN
        IF (v_row.data->>'kind') IS NOT DISTINCT FROM (p_event->>'kind')
           AND (v_row.data->>'amount') IS NOT DISTINCT FROM (p_event->>'amount')
           AND (v_row.data->>'sourceEventId') IS NOT DISTINCT FROM (p_event->>'sourceEventId')
           AND (v_row.data->>'sourceAmount') IS NOT DISTINCT FROM (p_event->>'sourceAmount')
           AND (v_row.data->>'allocationRatePercent') IS NOT DISTINCT FROM (p_event->>'allocationRatePercent')
           AND (v_row.data->>'method') IS NOT DISTINCT FROM (p_event->>'method')
           AND (v_row.data->>'providerId') IS NOT DISTINCT FROM (p_event->>'providerId')
           AND (v_row.data->>'reversesEventId') IS NOT DISTINCT FROM (p_event->>'reversesEventId')
           AND (v_row.data->>'correctsEventId') IS NOT DISTINCT FROM (p_event->>'correctsEventId')
           AND (v_row.data->>'businessDate') IS NOT DISTINCT FROM (p_event->>'businessDate') THEN
            RETURN row_to_json(v_row)::JSONB;
        END IF;
        RAISE EXCEPTION
            'transport_budget_events: idempotencyKey % already exists with different economics (stored as id %)',
            v_key, v_row.id;
    END IF;

    INSERT INTO public.transport_budget_events (id, data)
    VALUES (v_id, (p_event - 'id'))
    RETURNING * INTO v_row;
    RETURN row_to_json(v_row)::JSONB;
END;
$$ LANGUAGE plpgsql;

-- Fixed search_path hygiene (re-asserted idempotently; preserved by replace).
ALTER FUNCTION public.append_transport_budget_event(JSONB)
    SET search_path = public, pg_temp;

-- 0030 service-role-only posture re-asserted (no-op when already applied).
REVOKE ALL ON FUNCTION public.append_transport_budget_event(JSONB)
    FROM PUBLIC, authenticated;
GRANT EXECUTE ON FUNCTION public.append_transport_budget_event(JSONB)
    TO service_role;


-- ============================================================================
-- 2. BEHAVIORAL SELF-TEST (transactional, auto-cleaned)
--
-- Exercises the new branch against the REAL trigger chain, then rolls every
-- fixture row back. A failure aborts the migration loudly by design.
-- ============================================================================

SAVEPOINT sp_0037_rpc_selftest;

-- 2a. Fixture: minimal valid SALES_ALLOCATION (fires the real trigger).
SELECT public.append_transport_budget_event('{
    "id": "tbe-0037-selftest-alloc",
    "kind": "SALES_ALLOCATION",
    "idempotencyKey": "SALES_ALLOCATION:TBE-0037-SELFTEST",
    "sourceEventId": "TBE-0037-SELFTEST",
    "sourceAmount": 15000,
    "allocationRatePercent": 100,
    "amount": 15000,
    "method": null,
    "providerId": null,
    "reversesEventId": null,
    "correctsEventId": null,
    "businessDate": "2026-10-02",
    "occurredAt": "2026-10-02T10:00:00.000Z"
}'::JSONB);

-- 2b. Same key + same economics (different physical id) -> dedupes to fixture.
DO $$
DECLARE
    v_ret JSONB;
BEGIN
    SELECT public.append_transport_budget_event('{
        "id": "tbe-0037-selftest-retry",
        "kind": "SALES_ALLOCATION",
        "idempotencyKey": "SALES_ALLOCATION:TBE-0037-SELFTEST",
        "sourceEventId": "TBE-0037-SELFTEST",
        "sourceAmount": 15000,
        "allocationRatePercent": 100,
        "amount": 15000,
        "method": null,
        "providerId": null,
        "reversesEventId": null,
        "correctsEventId": null,
        "businessDate": "2026-10-02",
        "occurredAt": "2026-10-02T10:00:01.000Z"
    }'::JSONB) INTO v_ret;
    IF v_ret->>'id' <> 'tbe-0037-selftest-alloc' THEN
        RAISE EXCEPTION
            '0037 self-test failed: same-key same-economics did not dedupe to the fixture row';
    END IF;
END $$;

-- 2c. Same key + different amount -> deterministic conflict (never silent).
DO $$
BEGIN
    PERFORM public.append_transport_budget_event('{
        "id": "tbe-0037-selftest-conflict",
        "kind": "SALES_ALLOCATION",
        "idempotencyKey": "SALES_ALLOCATION:TBE-0037-SELFTEST",
        "sourceEventId": "TBE-0037-SELFTEST",
        "sourceAmount": 15000,
        "allocationRatePercent": 100,
        "amount": 9999,
        "method": null,
        "providerId": null,
        "reversesEventId": null,
        "correctsEventId": null,
        "businessDate": "2026-10-02",
        "occurredAt": "2026-10-02T10:00:02.000Z"
    }'::JSONB);
    RAISE EXCEPTION
        '0037 self-test failed: same-key different-amount was silently accepted';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%different economics%' THEN
            RAISE;
        END IF;
END $$;

-- 2d. Same key + different kind (valid REVERSAL shape) -> conflict, not
-- a cross-kind row. The conflict branch returns before INSERT, so no
-- target-existence check runs here; the kind mismatch alone must reject.
DO $$
BEGIN
    PERFORM public.append_transport_budget_event('{
        "id": "tbe-0037-selftest-xkind",
        "kind": "REVERSAL",
        "idempotencyKey": "SALES_ALLOCATION:TBE-0037-SELFTEST",
        "sourceEventId": null,
        "sourceAmount": null,
        "allocationRatePercent": null,
        "amount": -15000,
        "method": null,
        "providerId": null,
        "reversesEventId": "tbe-0037-selftest-alloc",
        "correctsEventId": null,
        "businessDate": "2026-10-02",
        "occurredAt": "2026-10-02T10:00:03.000Z"
    }'::JSONB);
    RAISE EXCEPTION
        '0037 self-test failed: same-key different-kind was silently accepted';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%different economics%' THEN
            RAISE;
        END IF;
END $$;

-- 2e. Same key + different source fields -> conflict.
DO $$
BEGIN
    PERFORM public.append_transport_budget_event('{
        "id": "tbe-0037-selftest-xsrc",
        "kind": "SALES_ALLOCATION",
        "idempotencyKey": "SALES_ALLOCATION:TBE-0037-SELFTEST",
        "sourceEventId": "TBE-0037-OTHER",
        "sourceAmount": 15000,
        "allocationRatePercent": 100,
        "amount": 15000,
        "method": null,
        "providerId": null,
        "reversesEventId": null,
        "correctsEventId": null,
        "businessDate": "2026-10-02",
        "occurredAt": "2026-10-02T10:00:04.000Z"
    }'::JSONB);
    RAISE EXCEPTION
        '0037 self-test failed: same-key different-source was silently accepted';
EXCEPTION
    WHEN OTHERS THEN
        IF SQLERRM NOT LIKE '%different economics%' THEN
            RAISE;
        END IF;
END $$;

ROLLBACK TO SAVEPOINT sp_0037_rpc_selftest;


-- ============================================================================
-- 3. VERIFICATION BLOCK (chain-consistent static checks)
-- ============================================================================

DO $$
DECLARE
    v_fn_def TEXT;
BEGIN
    SELECT pg_get_functiondef(oid) INTO v_fn_def
    FROM pg_proc
    WHERE proname = 'append_transport_budget_event';

    IF v_fn_def IS NULL
       OR v_fn_def NOT LIKE '%different economics%' THEN
        RAISE EXCEPTION
            '0037 verification failed: RPC missing same-key economic conflict';
    END IF;
    IF v_fn_def NOT LIKE '%pg_advisory_xact_lock%' THEN
        RAISE EXCEPTION
            '0037 verification failed: RPC missing same-key serialization lock';
    END IF;
    IF v_fn_def NOT LIKE '%reversesEventId%'
       OR v_fn_def NOT LIKE '%correctsEventId%'
       OR v_fn_def NOT LIKE '%allocationRatePercent%' THEN
        RAISE EXCEPTION
            '0037 verification failed: RPC economics comparison is incomplete';
    END IF;

    -- Privilege posture unchanged: service_role only.
    IF EXISTS (
        SELECT 1 FROM information_schema.routine_privileges
        WHERE routine_schema = 'public'
          AND routine_name = 'append_transport_budget_event'
          AND grantee = 'authenticated'
    ) THEN
        RAISE EXCEPTION
            '0037 verification failed: RPC executable by authenticated';
    END IF;
END $$;

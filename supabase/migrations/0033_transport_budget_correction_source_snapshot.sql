-- ============================================================================
-- 0033_transport_budget_correction_source_snapshot.sql
--
-- Prime ERP — Phase 7G-1: Transport Budget correction snapshot amendment.
--
-- LOCKED BUSINESS DECISION (Phase 7G gate, Option A):
--   CONSUMPTION_CORRECTION.sourceAmount must copy the original Transport
--   INBOUND_CONSUMPTION.sourceAmount (the authoritative source/capitalizable
--   ceiling snapshot), NOT abs(original amount).
--
--   Example (partial consumption):
--     original inbound:  amount = -30,000 / sourceAmount = 100,000
--     correction:        amount = +30,000 / sourceAmount = 100,000   (VALID)
--     correction:        amount = +30,000 / sourceAmount = 30,000    (REJECTED)
--
-- SCOPE: this migration changes EXACTLY ONE trigger predicate (the
-- correction snapshot-equality check) inside
-- public.transport_budget_events_validate_insert(). Every other branch,
-- message, lock, cap, index, policy, grant, and verification from 0029 /
-- 0030 / 0032 is preserved verbatim:
--   - target lookup, target-kind restriction (INBOUND_CONSUMPTION only),
--     self-link rejection: UNCHANGED
--   - method/provider snapshot checks: UNCHANGED
--   - single-correction rule + partial unique index: UNCHANGED
--   - correction amount cap (0 < amount <= abs(original)): UNCHANGED
--   - posting-date ordering: UNCHANGED
--   - INBOUND source-cap (consumption-magnitude arithmetic): UNCHANGED
--   - advisory locking, append-only triggers, RLS, RPC grants: UNCHANGED
--   - No global-balance check is introduced (overdraft stays ALLOWED).
--
-- Migration 0032 itself is NOT edited. No historical rows are rewritten.
-- No correction rows can predate this rule in production: the
-- CONSUMPTION_CORRECTION kind was introduced by 0032 and no producer has
-- shipped, so the only existing rows (if any) are test fixtures carrying
-- full-consumption snapshots, for which both rules coincide.
-- ============================================================================


-- ============================================================================
-- 1. AMENDED VALIDATE-INSERT FUNCTION (single-predicate change)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transport_budget_events_validate_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_kind TEXT;
    v_reverses TEXT;
    v_corrects TEXT;
    v_source TEXT;
    v_new_amount NUMERIC;
    v_target_kind TEXT;
    v_target_amount NUMERIC;
    v_target_provider TEXT;
    v_target_business_date TEXT;
    v_target_source TEXT;
    v_target_source_amount NUMERIC;
    v_reversed_total NUMERIC;
    v_existing_corrections INTEGER;
    v_prior_consumed NUMERIC;
    v_prior_corrected NUMERIC;
    v_source_cap NUMERIC;
    v_business_date TEXT;
    v_y INTEGER;
    v_m INTEGER;
    v_d INTEGER;
BEGIN
    v_kind := COALESCE(NEW.data->>'kind', '');
    v_business_date := COALESCE(NEW.data->>'businessDate', '');

    -- Strict calendar validity (the CHECK above only constrains the shape).
    BEGIN
        v_y := SUBSTRING(v_business_date FROM 1 FOR 4)::INTEGER;
        v_m := SUBSTRING(v_business_date FROM 6 FOR 2)::INTEGER;
        v_d := SUBSTRING(v_business_date FROM 9 FOR 2)::INTEGER;
        PERFORM make_date(v_y, v_m, v_d);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION
            'transport_budget_events: invalid businessDate %', v_business_date;
    END;

    -- Phase 4 quarantine: the ledger is NOT accounting, so accounting
    -- metadata must never be populated (nullable future-compatible only).
    IF (NEW.data ? 'journalIds')
       AND COALESCE((NEW.data->'journalIds')::text, '[]') NOT IN ('[]', 'null') THEN
        RAISE EXCEPTION
            'transport_budget_events: journalIds must remain empty in Phase 4';
    END IF;
    IF (NEW.data ? 'accountSplits')
       AND COALESCE((NEW.data->'accountSplits')::text, '[]') NOT IN ('[]', 'null') THEN
        RAISE EXCEPTION
            'transport_budget_events: accountSplits must remain empty in Phase 4';
    END IF;

    IF v_kind = 'SALES_ALLOCATION' THEN
        -- An allocation is defined by its source: identity + amount + rate.
        IF COALESCE(NEW.data->>'sourceEventId', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: SALES_ALLOCATION requires sourceEventId';
        END IF;
        IF COALESCE(NEW.data->>'sourceAmount', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: SALES_ALLOCATION requires sourceAmount';
        END IF;
        IF (NEW.data->>'sourceAmount')::numeric <= 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: SALES_ALLOCATION requires sourceAmount > 0';
        END IF;
        IF COALESCE(NEW.data->>'allocationRatePercent', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: SALES_ALLOCATION requires allocationRatePercent';
        END IF;

    ELSIF v_kind = 'REVERSAL' THEN
        -- A reversal carries only its signed amount and its link. Its
        -- economics derive from the referenced allocation.
        v_reverses := NULLIF(NEW.data->>'reversesEventId', '');
        IF v_reverses IS NULL THEN
            RAISE EXCEPTION
                'transport_budget_events: REVERSAL requires reversesEventId';
        END IF;
        IF v_reverses = NEW.id THEN
            RAISE EXCEPTION
                'transport_budget_events: reversal cannot reference itself';
        END IF;
        IF COALESCE(NEW.data->>'sourceEventId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: REVERSAL must not carry sourceEventId';
        END IF;
        IF COALESCE(NEW.data->>'sourceAmount', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: REVERSAL must not carry sourceAmount';
        END IF;
        IF COALESCE(NEW.data->>'allocationRatePercent', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: REVERSAL must not carry allocationRatePercent';
        END IF;

        -- Lock the target allocation row FIRST so concurrent reversals of the
        -- same allocation serialize here instead of racing past the cap.
        PERFORM 1
        FROM public.transport_budget_events
        WHERE id = v_reverses
        FOR UPDATE;

        SELECT (data->>'kind'), (data->>'amount')::numeric
        INTO v_target_kind, v_target_amount
        FROM public.transport_budget_events
        WHERE id = v_reverses;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'transport_budget_events: reversal target % does not exist',
                v_reverses;
        END IF;
        IF v_target_kind <> 'SALES_ALLOCATION' THEN
            RAISE EXCEPTION
                'transport_budget_events: only SALES_ALLOCATION events are reversible (target % is %)',
                v_reverses, v_target_kind;
        END IF;

        -- Cumulative cap: existing reversals (negative) + this reversal
        -- (negative) must never exceed the original allocation (positive).
        SELECT COALESCE(SUM((data->>'amount')::numeric), 0)
        INTO v_reversed_total
        FROM public.transport_budget_events
        WHERE (data->>'kind') = 'REVERSAL'
          AND (data->>'reversesEventId') = v_reverses;

        v_new_amount := (NEW.data->>'amount')::numeric;
        IF v_target_amount + v_reversed_total + v_new_amount < 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: cumulative reversals (%) would exceed allocation % for target %',
                (ABS(v_reversed_total) + ABS(v_new_amount)),
                v_target_amount,
                v_reverses;
        END IF;

    ELSIF v_kind = 'CONSUMPTION_CORRECTION' THEN
        -- Phase 7E: dedicated positive delta against one INBOUND_CONSUMPTION.
        -- REVERSAL is never reused; INBOUND_CONSUMPTION is never positive;
        -- the original event is never mutated (append-only).
        v_corrects := NULLIF(NEW.data->>'correctsEventId', '');
        v_source := NULLIF(NEW.data->>'sourceEventId', '');
        IF v_corrects IS NULL THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires correctsEventId';
        END IF;
        IF v_corrects = NEW.id THEN
            RAISE EXCEPTION
                'transport_budget_events: correction cannot reference itself';
        END IF;
        IF v_source IS NULL THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires sourceEventId';
        END IF;
        IF v_source <> v_corrects THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires sourceEventId = correctsEventId (%)',
                v_corrects;
        END IF;
        IF COALESCE(NEW.data->>'sourceAmount', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires sourceAmount';
        END IF;
        IF (NEW.data->>'sourceAmount')::numeric <= 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires sourceAmount > 0';
        END IF;
        IF COALESCE(NEW.data->>'method', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires method';
        END IF;
        IF (NEW.data->>'method') <> 'LANDING_COST_FREIGHT' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION method must be LANDING_COST_FREIGHT';
        END IF;
        IF COALESCE(NEW.data->>'providerId', '') = '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION requires providerId';
        END IF;
        IF COALESCE(NEW.data->>'allocationRatePercent', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION must not carry allocationRatePercent';
        END IF;
        IF COALESCE(NEW.data->>'reversesEventId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION must not carry reversesEventId';
        END IF;

        -- Lock the target consumption row FIRST so concurrent corrections of
        -- the same original serialize here (SINGLE-cardinality backstop).
        PERFORM 1
        FROM public.transport_budget_events
        WHERE id = v_corrects
        FOR UPDATE;

        SELECT (data->>'kind'), (data->>'amount')::numeric,
               (data->>'providerId'), (data->>'businessDate'),
               (data->>'sourceEventId'),
               NULLIF(data->>'sourceAmount', '')::numeric
        INTO v_target_kind, v_target_amount, v_target_provider,
             v_target_business_date, v_target_source,
             v_target_source_amount
        FROM public.transport_budget_events
        WHERE id = v_corrects;

        IF NOT FOUND THEN
            RAISE EXCEPTION
                'transport_budget_events: correction target % does not exist',
                v_corrects;
        END IF;
        IF v_target_kind <> 'INBOUND_CONSUMPTION' THEN
            RAISE EXCEPTION
                'transport_budget_events: only INBOUND_CONSUMPTION events are correctible (target % is %)',
                v_corrects, v_target_kind;
        END IF;

        -- Snapshot discipline (Phase 7G-1): the correction carries the
        -- original inbound source snapshot (the authoritative source /
        -- capitalizable ceiling), NOT abs(original amount). The correction
        -- amount cap below is a separate check against abs(original amount).
        IF v_target_source_amount IS NULL OR v_target_source_amount <= 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: correction target % carries no source snapshot',
                v_corrects;
        END IF;
        IF (NEW.data->>'sourceAmount')::numeric <> v_target_source_amount THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION sourceAmount (%) must equal the original inbound sourceAmount (%) for target %',
                (NEW.data->>'sourceAmount')::numeric,
                v_target_source_amount,
                v_corrects;
        END IF;
        IF COALESCE(v_target_provider, '') = ''
           OR COALESCE(NEW.data->>'providerId', '') <> v_target_provider THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION providerId must match the original consumption provider for target %',
                v_corrects;
        END IF;

        -- Posting-date rule: the correction period must not precede the
        -- original consumption period (lexicographic compare is chronological
        -- for strict YYYY-MM-DD values).
        IF (NEW.data->>'businessDate') < v_target_business_date THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION businessDate (%) must not precede the original consumption businessDate (%) for target %',
                NEW.data->>'businessDate',
                v_target_business_date,
                v_corrects;
        END IF;

        -- Single-correction rule (domain error; the partial unique index
        -- below is the cross-process backstop).
        SELECT COUNT(*)
        INTO v_existing_corrections
        FROM public.transport_budget_events
        WHERE (data->>'kind') = 'CONSUMPTION_CORRECTION'
          AND (data->>'correctsEventId') = v_corrects;
        IF v_existing_corrections > 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: consumption % was already corrected (ALREADY_CORRECTED)',
                v_corrects;
        END IF;

        -- Correction cap: 0 < amount <= abs(original). Full equality is
        -- valid (net 0). Zero/negative amounts additionally violate the
        -- sign CHECK; this message names the cap.
        v_new_amount := (NEW.data->>'amount')::numeric;
        IF v_new_amount > ABS(v_target_amount) THEN
            RAISE EXCEPTION
                'transport_budget_events: correction (%) would exceed original consumption % for target %',
                v_new_amount,
                ABS(v_target_amount),
                v_corrects;
        END IF;

        -- Serialize against concurrent INBOUND cap evaluations on the same
        -- Landing scope (see the INBOUND branch below).
        IF COALESCE(v_target_source, '') <> '' THEN
            PERFORM pg_advisory_xact_lock(hashtext('tbe-src:' || v_target_source));
        END IF;

    ELSE
        -- INBOUND_CONSUMPTION / OUTBOUND_CONSUMPTION: terminal budget use.
        -- Source identity is optional future linkage (Landing Cost /
        -- delivery / expense producers arrive later); a rate is meaningless.
        IF COALESCE(NEW.data->>'allocationRatePercent', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: % must not carry allocationRatePercent',
                v_kind;
        END IF;

        -- Phase 7E source-cap (INBOUND only). Evaluated only when the row
        -- carries snapshots, so the database can decide without reading
        -- Landing tables; snapshot-less rows predate hardening and bypass
        -- this check (their validity contract is unchanged).
        -- No global-balance check exists here by design: negative Available
        -- is legal (global overdraft ALLOWED).
        IF v_kind = 'INBOUND_CONSUMPTION'
           AND COALESCE(NEW.data->>'sourceEventId', '') <> ''
           AND COALESCE(NEW.data->>'sourceAmount', '') <> ''
           AND (NEW.data->>'sourceAmount')::numeric > 0 THEN
            v_source := NEW.data->>'sourceEventId';
            PERFORM pg_advisory_xact_lock(hashtext('tbe-src:' || v_source));

            SELECT COALESCE(SUM(ABS((data->>'amount')::numeric)), 0)
            INTO v_prior_consumed
            FROM public.transport_budget_events
            WHERE (data->>'kind') = 'INBOUND_CONSUMPTION'
              AND (data->>'sourceEventId') = v_source;

            SELECT COALESCE(SUM((data->>'amount')::numeric), 0)
            INTO v_prior_corrected
            FROM public.transport_budget_events
            WHERE (data->>'kind') = 'CONSUMPTION_CORRECTION'
              AND (data->>'correctsEventId') IN (
                  SELECT id
                  FROM public.transport_budget_events
                  WHERE (data->>'kind') = 'INBOUND_CONSUMPTION'
                    AND (data->>'sourceEventId') = v_source
              );

            SELECT GREATEST(
                (NEW.data->>'sourceAmount')::numeric,
                COALESCE(MAX((data->>'sourceAmount')::numeric), 0)
            )
            INTO v_source_cap
            FROM public.transport_budget_events
            WHERE (data->>'kind') = 'INBOUND_CONSUMPTION'
              AND (data->>'sourceEventId') = v_source
              AND COALESCE(data->>'sourceAmount', '') <> '';

            v_new_amount := ABS((NEW.data->>'amount')::numeric);
            IF v_prior_consumed - v_prior_corrected + v_new_amount > v_source_cap THEN
                RAISE EXCEPTION
                    'transport_budget_events: inbound consumption (%) would exceed source cap % for source % (already consumed %, corrected %)',
                    v_new_amount,
                    v_source_cap,
                    v_source,
                    v_prior_consumed,
                    v_prior_corrected;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The BEFORE INSERT trigger binding is unchanged (same name, same timing).
DROP TRIGGER IF EXISTS trg_transport_budget_events_validate_insert
    ON public.transport_budget_events;
CREATE TRIGGER trg_transport_budget_events_validate_insert
    BEFORE INSERT ON public.transport_budget_events
    FOR EACH ROW
    EXECUTE FUNCTION public.transport_budget_events_validate_insert();


-- ============================================================================
-- 2. POST-MIGRATION VERIFICATION (read-only checks)
-- ============================================================================

DO $$
DECLARE
    v_fn_def TEXT;
    v_policy_count INTEGER;
    v_insert_policy_count INTEGER;
    v_auth_can_execute BOOLEAN;
    v_service_can_execute BOOLEAN;
    v_tenant_cols INTEGER;
    v_trigger_count INTEGER;
    v_corrects_uniq_count INTEGER;
BEGIN
    -- The amended snapshot rule is present (and the old abs() rule is gone).
    SELECT pg_get_functiondef(oid) INTO v_fn_def
    FROM pg_proc
    WHERE proname = 'transport_budget_events_validate_insert';
    IF v_fn_def IS NULL
       OR v_fn_def NOT LIKE '%must equal the original inbound sourceAmount%' THEN
        RAISE EXCEPTION
            '0033 verification failed: amended correction snapshot rule missing';
    END IF;
    IF v_fn_def LIKE '%must equal abs(original consumption amount)%' THEN
        RAISE EXCEPTION
            '0033 verification failed: stale abs() snapshot rule still present';
    END IF;

    -- Unrelated invariants preserved: correction cap, single-correction,
    -- target-kind gate, advisory serialization.
    IF v_fn_def NOT LIKE '%would exceed original consumption%' THEN
        RAISE EXCEPTION
            '0033 verification failed: correction amount cap missing';
    END IF;
    IF v_fn_def NOT LIKE '%ALREADY_CORRECTED%' THEN
        RAISE EXCEPTION
            '0033 verification failed: single-correction rule missing';
    END IF;
    IF v_fn_def NOT LIKE '%only INBOUND_CONSUMPTION events are correctible%' THEN
        RAISE EXCEPTION
            '0033 verification failed: target-kind gate missing';
    END IF;
    IF v_fn_def NOT LIKE '%pg_advisory_xact_lock%' THEN
        RAISE EXCEPTION
            '0033 verification failed: source serialization missing';
    END IF;
    IF v_fn_def NOT LIKE '%cumulative reversals (%) would exceed allocation%' THEN
        RAISE EXCEPTION
            '0033 verification failed: reversal cap missing';
    END IF;

    -- Single-correction uniqueness backstop still present.
    SELECT COUNT(*) INTO v_corrects_uniq_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND indexname = 'uq_transport_budget_events_corrects';
    IF v_corrects_uniq_count <> 1 THEN
        RAISE EXCEPTION
            '0033 verification failed: single-correction unique index missing';
    END IF;

    -- RLS posture unchanged: exactly the authenticated SELECT policy.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION
            '0033 verification failed: expected 1 RLS policy, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_insert_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND cmd = 'INSERT';
    IF v_insert_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0033 verification failed: INSERT policy reappeared';
    END IF;

    -- RPC posture unchanged: service-role only.
    SELECT has_function_privilege(
        'authenticated',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_auth_can_execute;
    IF COALESCE(v_auth_can_execute, TRUE) IS NOT FALSE THEN
        RAISE EXCEPTION
            '0033 verification failed: authenticated can EXECUTE the append RPC';
    END IF;

    SELECT has_function_privilege(
        'service_role',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_service_can_execute;
    IF COALESCE(v_service_can_execute, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0033 verification failed: service_role lost EXECUTE on the append RPC';
    END IF;

    -- Single-company guard (unchanged): no multi-tenant columns, ever.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_budget_events'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION
            '0033 verification failed: unexpected tenant partitioning columns (%)',
            v_tenant_cols;
    END IF;

    -- Integrity triggers still bound (same three names).
    SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'transport_budget_events'
      AND t.tgname IN (
          'trg_transport_budget_events_validate_insert',
          'trg_transport_budget_events_block_update',
          'trg_transport_budget_events_block_delete'
      );
    IF v_trigger_count <> 3 THEN
        RAISE EXCEPTION
            '0033 verification failed: expected 3 integrity triggers, found %',
            v_trigger_count;
    END IF;

    RAISE NOTICE
        '0033 verification PASSED: correction source-snapshot amendment ready (single-company, append-only, service-role path)';
END $$;


-- ============================================================================
-- End of 0033 (no historical data rewrite; all pre-existing events valid)
-- ============================================================================

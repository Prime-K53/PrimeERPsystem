-- ============================================================================
-- 0032_transport_budget_consumption_correction.sql
--
-- Prime ERP — Phase 7E: Transport Budget consumption-correction ledger
-- hardening (implementation of the frozen Phase 7D-2 business contract).
--
-- FROZEN BUSINESS CONTRACT (do not substitute alternative semantics):
--   - Global overdraft: ALLOWED (no global balance check, no wallet lock,
--     no overdraft rejection, no global FOR UPDATE mechanism).
--   - Correction business date: POSTING DATE (never the original GRN date).
--   - Correction cardinality: SINGLE (UNIQUE(correctsEventId)).
--   - Partial correction: ALLOWED (0 < amount <= abs(original)).
--   - Over-correction: REJECTED (amount > abs(original) always fails).
--   - Correction-of-correction: NOT ALLOWED (target must be INBOUND only).
--   - Correction sourceEventId = original INBOUND_CONSUMPTION event ID, and
--     MUST equal correctsEventId (intentional duplicate-field rule).
--   - Correction sourceAmount/method/providerId: REQUIRED snapshots.
--   - Correction idempotency key:
--       CONSUMPTION_CORRECTION:{originalTransportConsumptionEventId}
--   - Source cap: DB ENFORCED per (grnId, landingCostId) scope, resolved
--     through the original INBOUND_CONSUMPTION event.
--   - Full release (net 0): ALLOWED.
--   - Outbound: BLOCKED / NO PRODUCER (no outbound logic in this migration).
--
-- FROZEN ARCHITECTURE (unchanged):
--   - Single company. NO tenant_id. NO organization_id. NO company_id.
--   - Internal management ledger only. NOT GL / AR / AP / inventory / COGS /
--     tax / cash / customer charge. Customer-invisible. No GL effects.
--   - Sign contract:
--       SALES_ALLOCATION       amount > 0
--       CONSUMPTION_CORRECTION amount > 0
--       REVERSAL               amount < 0
--       INBOUND_CONSUMPTION    amount < 0
--       OUTBOUND_CONSUMPTION   amount < 0
--   - Available = SUM(all signed amounts). Negative Available is legal.
--   - Append-only is absolute (UPDATE/DELETE rejected on every path).
--   - RLS is unchanged by this migration (SELECT-only for authenticated;
--     service-role sync gateway remains the single cloud append path).
--   - The generic append RPC is unchanged; the BEFORE INSERT trigger below
--     remains the authority on every write path (no new RPC is required
--     because the trigger + transaction-scoped advisory locks enforce the
--     source-cap atomically inside PostgreSQL).
--
-- SCOPE: additive only. This migration touches ONLY the
-- `transport_budget_events` ledger (constraints, indexes, the existing
-- validate-insert function). No other table is touched. No data is
-- rewritten. All pre-existing events remain valid.
-- ============================================================================


-- ============================================================================
-- 1. EVENT KIND: add CONSUMPTION_CORRECTION (was exactly four kinds)
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_kind;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_kind CHECK (
        COALESCE(data->>'kind', '') IN (
            'SALES_ALLOCATION',
            'REVERSAL',
            'INBOUND_CONSUMPTION',
            'OUTBOUND_CONSUMPTION',
            'CONSUMPTION_CORRECTION'
        )
    );


-- ============================================================================
-- 2. SIGN: SALES_ALLOCATION and CONSUMPTION_CORRECTION are positive;
--    every other kind is negative. Consumption stays strictly negative —
--    this change does NOT weaken the existing consumption rule.
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_sign;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_sign CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'SALES_ALLOCATION' THEN (data->>'amount')::numeric > 0
            WHEN 'CONSUMPTION_CORRECTION' THEN (data->>'amount')::numeric > 0
            ELSE (data->>'amount')::numeric < 0
        END
    );


-- ============================================================================
-- 3. CORRECTION LINKAGE SHAPE
--    - correctsEventId present IFF kind = CONSUMPTION_CORRECTION.
--    - For corrections, sourceEventId MUST equal correctsEventId
--      (intentional duplicate-field rule from Phase 7D-2: both carry the
--      original INBOUND_CONSUMPTION event ID; the Landing (grnId,
--      landingCostId) scope is resolved by following
--      correction -> correctsEventId -> original -> sourceEventId).
--    - reversesEventId remains exclusively associated with REVERSAL.
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_correction_shape;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_correction_shape CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'CONSUMPTION_CORRECTION'
                THEN COALESCE(data->>'correctsEventId', '') <> ''
            ELSE COALESCE(data->>'correctsEventId', '') = ''
        END
    );

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_correction_identity;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_correction_identity CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'CONSUMPTION_CORRECTION'
                THEN COALESCE(data->>'sourceEventId', '')
                     = COALESCE(data->>'correctsEventId', '')
                 AND COALESCE(data->>'sourceEventId', '') <> ''
            ELSE TRUE
        END
    );


-- ============================================================================
-- 4. SINGLE-CORRECTION RULE: at most one correction per original event.
--    Partial unique index (only non-empty correction links participate).
--    The trigger below raises the domain ALREADY_CORRECTED error first;
--    this index is the cross-process backstop that elects one winner when
--    two identical corrections race.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_budget_events_corrects
    ON public.transport_budget_events ((data->>'correctsEventId'))
    WHERE COALESCE(data->>'correctsEventId', '') <> '';

-- Deterministic correction lookup (target existence + single-correction
-- checks resolve through this index).
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_corrects
    ON public.transport_budget_events ((data->>'correctsEventId'))
    WHERE COALESCE(data->>'correctsEventId', '') <> '';


-- ============================================================================
-- 5. INSERT VALIDATION + CORRECTION INTEGRITY TRIGGER (authoritative)
--
-- Full replacement of the 0029 function. Every pre-existing branch is
-- preserved verbatim (messages, quarantine, reversal target lock + kind
-- gate + cumulative cap); the CONSUMPTION_CORRECTION branch and the
-- conditional INBOUND source-cap are added.
--
-- Concurrency model (no global lock, no frontend-mutex reliance):
--   - Corrections lock the parent consumption row FOR UPDATE (same pattern
--     as the reversal cap), so two corrections of one original serialize.
--   - Source-cap evaluation takes a transaction-scoped advisory lock on
--     hash('tbe-src:' || sourceEventId). pg_advisory_xact_lock is released
--     automatically at transaction end, so pooled connections (Supabase
--     transaction mode) are safe. Frontend mutexes remain best-effort only.
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
               (data->>'sourceEventId')
        INTO v_target_kind, v_target_amount, v_target_provider,
             v_target_business_date, v_target_source
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

        -- Snapshot discipline: frozen copies of the original consumption.
        -- sourceAmount carries abs(original amount) per the frozen contract.
        IF (NEW.data->>'sourceAmount')::numeric <> ABS(v_target_amount) THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_CORRECTION sourceAmount (%) must equal abs(original consumption amount %) for target %',
                (NEW.data->>'sourceAmount')::numeric,
                ABS(v_target_amount),
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
-- 6. POST-MIGRATION VERIFICATION (read-only checks)
-- ============================================================================

DO $$
DECLARE
    v_kind_check_def TEXT;
    v_sign_check_def TEXT;
    v_correction_shape_count INTEGER;
    v_corrects_uniq_count INTEGER;
    v_policy_count INTEGER;
    v_insert_policy_count INTEGER;
    v_auth_can_execute BOOLEAN;
    v_service_can_execute BOOLEAN;
    v_tenant_cols INTEGER;
    v_trigger_count INTEGER;
BEGIN
    -- New kind literal is present in the kind CHECK.
    SELECT pg_get_constraintdef(oid) INTO v_kind_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_kind';
    IF v_kind_check_def IS NULL
       OR v_kind_check_def NOT LIKE '%CONSUMPTION_CORRECTION%' THEN
        RAISE EXCEPTION
            '0032 verification failed: kind constraint missing CONSUMPTION_CORRECTION';
    END IF;

    -- Sign CHECK carries the positive-correction branch.
    SELECT pg_get_constraintdef(oid) INTO v_sign_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_sign';
    IF v_sign_check_def IS NULL
       OR v_sign_check_def NOT LIKE '%CONSUMPTION_CORRECTION%' THEN
        RAISE EXCEPTION
            '0032 verification failed: sign constraint missing positive-correction branch';
    END IF;

    -- Correction-linkage shape CHECKs exist.
    SELECT COUNT(*) INTO v_correction_shape_count
    FROM pg_constraint
    WHERE conname IN (
        'chk_transport_budget_events_correction_shape',
        'chk_transport_budget_events_correction_identity'
    );
    IF v_correction_shape_count <> 2 THEN
        RAISE EXCEPTION
            '0032 verification failed: correction shape constraints missing (found %)',
            v_correction_shape_count;
    END IF;

    -- Single-correction uniqueness backstop exists.
    SELECT COUNT(*) INTO v_corrects_uniq_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND indexname = 'uq_transport_budget_events_corrects';
    IF v_corrects_uniq_count <> 1 THEN
        RAISE EXCEPTION
            '0032 verification failed: single-correction unique index missing';
    END IF;

    -- RLS posture unchanged: exactly the authenticated SELECT policy.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION
            '0032 verification failed: expected 1 RLS policy, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_insert_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND cmd = 'INSERT';
    IF v_insert_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0032 verification failed: INSERT policy reappeared';
    END IF;

    -- RPC posture unchanged: service-role only.
    SELECT has_function_privilege(
        'authenticated',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_auth_can_execute;
    IF COALESCE(v_auth_can_execute, TRUE) IS NOT FALSE THEN
        RAISE EXCEPTION
            '0032 verification failed: authenticated can EXECUTE the append RPC';
    END IF;

    SELECT has_function_privilege(
        'service_role',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_service_can_execute;
    IF COALESCE(v_service_can_execute, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0032 verification failed: service_role lost EXECUTE on the append RPC';
    END IF;

    -- Single-company guard (unchanged): no multi-tenant columns, ever.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_budget_events'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION
            '0032 verification failed: unexpected tenant partitioning columns (%)',
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
            '0032 verification failed: expected 3 integrity triggers, found %',
            v_trigger_count;
    END IF;

    RAISE NOTICE
        '0032 verification PASSED: CONSUMPTION_CORRECTION ledger hardening ready (single-company, append-only, service-role path)';
END $$;


-- ============================================================================
-- End of 0032 (no historical data rewrite; all pre-existing events valid)
-- ============================================================================

-- ============================================================================
-- 0035_transport_budget_consumption_reversal.sql
--
-- Prime ERP — Phase 8D: Transport Budget CONSUMPTION_REVERSAL ledger
-- contract (implementation of the frozen Phase 8C diagnostic).
--
-- FROZEN BUSINESS CONTRACT (do not substitute alternative semantics):
--   - New event kind: CONSUMPTION_REVERSAL, amount > 0.
--   - reversesEventId = original OUTBOUND_CONSUMPTION.id (dedicated link;
--     REVERSAL stays allocation-only, corrections stay INBOUND-only).
--   - Target must be OUTBOUND_CONSUMPTION (nothing else is reversible here).
--   - Exactly one FULL reversal per target:
--     reversal.amount === abs(original.amount). Partial reversal is NOT
--     supported (no partial-void source lifecycle exists).
--   - Correction-of-reversal and reversal-of-reversal are NOT supported.
--   - Null snapshot hygiene (REVERSAL precedent): sourceEventId, sourceAmount,
--     method, providerId, allocationRatePercent, correctsEventId are all
--     forbidden; economics derive from the immutable target event.
--   - businessDate = original OUTBOUND_CONSUMPTION.businessDate;
--     occurredAt = actual reversal posting timestamp.
--   - Global overdraft stays ALLOWED: no global-balance check or lock.
--   - No source-cap logic for outbound. No accounting fields. No
--     tenant/company dimensions (single-company ERP).
--
-- SCOPE: additive only. This migration touches ONLY the
-- `transport_budget_events` ledger (kind + sign + linkage CHECKs, one new
-- trigger branch, one partial unique index + lookup index). Every
-- pre-existing branch, message, lock, cap, policy, and grant is preserved
-- verbatim. No historical rows are rewritten. No producer is created.
-- ============================================================================


-- ============================================================================
-- 1. EVENT KIND: add CONSUMPTION_REVERSAL (was exactly five kinds)
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
            'CONSUMPTION_CORRECTION',
            'CONSUMPTION_REVERSAL'
        )
    );


-- ============================================================================
-- 2. SIGN: explicit kind-controlled polarity (never a generic rule).
--    SALES_ALLOCATION, CONSUMPTION_CORRECTION and CONSUMPTION_REVERSAL are
--    positive; every other kind is negative. Consumption stays strictly
--    negative — this change does NOT weaken any existing rule.
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_sign;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_sign CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'SALES_ALLOCATION' THEN (data->>'amount')::numeric > 0
            WHEN 'CONSUMPTION_CORRECTION' THEN (data->>'amount')::numeric > 0
            WHEN 'CONSUMPTION_REVERSAL' THEN (data->>'amount')::numeric > 0
            ELSE (data->>'amount')::numeric < 0
        END
    );


-- ============================================================================
-- 3. REVERSAL LINKAGE SHAPE
--    - reversesEventId present IFF kind IN (REVERSAL, CONSUMPTION_REVERSAL).
--    - correctsEventId present IFF kind = CONSUMPTION_CORRECTION
--      (unchanged; the new kind must not carry it — enforced in the
--      trigger branch below).
--    - reversesEventId remains forbidden on every other kind.
-- ============================================================================

ALTER TABLE public.transport_budget_events
    DROP CONSTRAINT IF EXISTS chk_transport_budget_events_reversal_shape;

ALTER TABLE public.transport_budget_events
    ADD CONSTRAINT chk_transport_budget_events_reversal_shape CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'REVERSAL' THEN COALESCE(data->>'reversesEventId', '') <> ''
            WHEN 'CONSUMPTION_REVERSAL' THEN COALESCE(data->>'reversesEventId', '') <> ''
            ELSE COALESCE(data->>'reversesEventId', '') = ''
        END
    );


-- ============================================================================
-- 4. SINGLE-REVERSAL RULE: at most one consumption reversal per original.
--    Dedicated partial unique index scoped to the new kind (only non-empty
--    reversal links participate). The existing uq_corrects index and the
--    non-unique reverses lookup index are untouched; no broad polymorphic
--    unique index is introduced.
--    The trigger below raises the domain ALREADY_REVERSED error first;
--    this index is the cross-process backstop that elects one winner when
--    two identical reversals race.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_budget_events_consumption_reversal
    ON public.transport_budget_events ((data->>'reversesEventId'))
    WHERE COALESCE(data->>'kind', '') = 'CONSUMPTION_REVERSAL'
      AND COALESCE(data->>'reversesEventId', '') <> '';

-- Deterministic consumption-reversal lookup (target existence +
-- single-reversal checks resolve through this index).
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_consumption_reversal
    ON public.transport_budget_events ((data->>'reversesEventId'))
    WHERE COALESCE(data->>'kind', '') = 'CONSUMPTION_REVERSAL'
      AND COALESCE(data->>'reversesEventId', '') <> '';


-- ============================================================================
-- 5. INSERT VALIDATION + CONSUMPTION-REVERSAL INTEGRITY TRIGGER
--    (authoritative)
--
-- Full replacement of the 0033 function. Every pre-existing branch is
-- preserved verbatim (messages, quarantine, reversal target lock + kind
-- gate + cumulative cap, correction linkage + snapshot + cap + date rules,
-- INBOUND source-cap); the CONSUMPTION_REVERSAL branch is added.
--
-- Concurrency model (no global lock, no frontend-mutex reliance):
--   - Reversals lock the target consumption row FOR UPDATE (same pattern
--     as the allocation-reversal and correction caps), so two reversals
--     of one original serialize instead of racing past the checks.
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
    v_existing_reversals INTEGER;
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

    ELSIF v_kind = 'CONSUMPTION_REVERSAL' THEN
        -- Phase 8D: dedicated positive reversal against one
        -- OUTBOUND_CONSUMPTION. REVERSAL stays allocation-only;
        -- INBOUND_CONSUMPTION stays correction-only (via
        -- CONSUMPTION_CORRECTION); the original event is never
        -- mutated (append-only). Full reversal only.
        v_reverses := NULLIF(NEW.data->>'reversesEventId', '');
        IF v_reverses IS NULL THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL requires reversesEventId';
        END IF;
        IF v_reverses = NEW.id THEN
            RAISE EXCEPTION
                'transport_budget_events: consumption reversal cannot reference itself';
        END IF;
        IF COALESCE(NEW.data->>'sourceEventId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry sourceEventId';
        END IF;
        IF COALESCE(NEW.data->>'sourceAmount', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry sourceAmount';
        END IF;
        IF COALESCE(NEW.data->>'method', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry method';
        END IF;
        IF COALESCE(NEW.data->>'providerId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry providerId';
        END IF;
        IF COALESCE(NEW.data->>'allocationRatePercent', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry allocationRatePercent';
        END IF;
        IF COALESCE(NEW.data->>'correctsEventId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: CONSUMPTION_REVERSAL must not carry correctsEventId';
        END IF;

        -- Lock the target consumption row FIRST so concurrent reversals of
        -- the same original serialize here (SINGLE-reversal backstop).
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
                'transport_budget_events: consumption reversal target % does not exist',
                v_reverses;
        END IF;
        IF v_target_kind <> 'OUTBOUND_CONSUMPTION' THEN
            RAISE EXCEPTION
                'transport_budget_events: only OUTBOUND_CONSUMPTION events are consumption-reversible (target % is %)',
                v_reverses, v_target_kind;
        END IF;

        -- Single-reversal rule (domain error; the partial unique index
        -- below is the cross-process backstop).
        SELECT COUNT(*)
        INTO v_existing_reversals
        FROM public.transport_budget_events
        WHERE (data->>'kind') = 'CONSUMPTION_REVERSAL'
          AND (data->>'reversesEventId') = v_reverses;
        IF v_existing_reversals > 0 THEN
            RAISE EXCEPTION
                'transport_budget_events: consumption % was already reversed (ALREADY_REVERSED)',
                v_reverses;
        END IF;

        -- Full-reversal rule: amount must equal abs(original). Partial
        -- reversals are not supported (no partial-void source lifecycle).
        -- Zero/negative amounts additionally violate the sign CHECK; this
        -- message names the rule.
        v_new_amount := (NEW.data->>'amount')::numeric;
        IF v_new_amount <> ABS(v_target_amount) THEN
            RAISE EXCEPTION
                'transport_budget_events: consumption reversal (%) must equal original consumption % for target %',
                v_new_amount,
                ABS(v_target_amount),
                v_reverses;
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
    v_shape_check_def TEXT;
    v_fn_def TEXT;
    v_policy_count INTEGER;
    v_insert_policy_count INTEGER;
    v_auth_can_execute BOOLEAN;
    v_service_can_execute BOOLEAN;
    v_tenant_cols INTEGER;
    v_trigger_count INTEGER;
    v_reversal_uniq_count INTEGER;
BEGIN
    -- New kind literal is present in the kind CHECK.
    SELECT pg_get_constraintdef(oid) INTO v_kind_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_kind';
    IF v_kind_check_def IS NULL
       OR v_kind_check_def NOT LIKE '%CONSUMPTION_REVERSAL%' THEN
        RAISE EXCEPTION
            '0035 verification failed: kind constraint missing CONSUMPTION_REVERSAL';
    END IF;

    -- Sign CHECK carries the explicit positive-reversal branch (never a
    -- generic positive rule).
    SELECT pg_get_constraintdef(oid) INTO v_sign_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_sign';
    IF v_sign_check_def IS NULL
       OR v_sign_check_def NOT LIKE '%CONSUMPTION_REVERSAL%' THEN
        RAISE EXCEPTION
            '0035 verification failed: sign constraint missing positive-reversal branch';
    END IF;
    -- OUTBOUND_CONSUMPTION remains negative: it falls under the explicit
    -- negative ELSE branch (no generic positive rule was introduced).
    IF v_sign_check_def NOT LIKE '%ELSE%numeric < 0%' THEN
        RAISE EXCEPTION
            '0035 verification failed: OUTBOUND_CONSUMPTION must remain negative (sign ELSE branch)';
    END IF;

    -- Linkage CHECK carries reversesEventId for the new kind.
    SELECT pg_get_constraintdef(oid) INTO v_shape_check_def
    FROM pg_constraint
    WHERE conname = 'chk_transport_budget_events_reversal_shape';
    IF v_shape_check_def IS NULL
       OR v_shape_check_def NOT LIKE '%CONSUMPTION_REVERSAL%' THEN
        RAISE EXCEPTION
            '0035 verification failed: reversal-shape constraint missing new kind';
    END IF;

    -- New trigger branch present with target gate, single rule, full rule.
    SELECT pg_get_functiondef(oid) INTO v_fn_def
    FROM pg_proc
    WHERE proname = 'transport_budget_events_validate_insert';
    IF v_fn_def IS NULL
       OR v_fn_def NOT LIKE '%only OUTBOUND_CONSUMPTION events are consumption-reversible%' THEN
        RAISE EXCEPTION
            '0035 verification failed: consumption-reversal target gate missing';
    END IF;
    IF v_fn_def NOT LIKE '%was already reversed (ALREADY_REVERSED)%' THEN
        RAISE EXCEPTION
            '0035 verification failed: single-reversal rule missing';
    END IF;
    IF v_fn_def NOT LIKE '%must equal original consumption%' THEN
        RAISE EXCEPTION
            '0035 verification failed: full-reversal amount rule missing';
    END IF;

    -- Pre-existing invariants preserved verbatim.
    IF v_fn_def NOT LIKE '%only SALES_ALLOCATION events are reversible%' THEN
        RAISE EXCEPTION
            '0035 verification failed: allocation reversal gate changed';
    END IF;
    IF v_fn_def NOT LIKE '%cumulative reversals (%) would exceed allocation%' THEN
        RAISE EXCEPTION
            '0035 verification failed: allocation reversal cap changed';
    END IF;
    IF v_fn_def NOT LIKE '%only INBOUND_CONSUMPTION events are correctible%' THEN
        RAISE EXCEPTION
            '0035 verification failed: correction target gate changed';
    END IF;
    IF v_fn_def NOT LIKE '%ALREADY_CORRECTED%' THEN
        RAISE EXCEPTION
            '0035 verification failed: single-correction rule changed';
    END IF;
    IF v_fn_def NOT LIKE '%pg_advisory_xact_lock%' THEN
        RAISE EXCEPTION
            '0035 verification failed: source serialization changed';
    END IF;
    -- No global-balance gate introduced.
    IF v_fn_def ILIKE '%global%balance%check%' OR v_fn_def ILIKE '%minimum%available%balance%' THEN
        RAISE EXCEPTION
            '0035 verification failed: unexpected global-balance gate';
    END IF;

    -- Single-reversal uniqueness backstop exists and is kind-scoped.
    SELECT COUNT(*) INTO v_reversal_uniq_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND indexname = 'uq_transport_budget_events_consumption_reversal';
    IF v_reversal_uniq_count <> 1 THEN
        RAISE EXCEPTION
            '0035 verification failed: single-reversal unique index missing';
    END IF;

    -- RLS posture unchanged: exactly the authenticated SELECT policy.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION
            '0035 verification failed: expected 1 RLS policy, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_insert_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND cmd = 'INSERT';
    IF v_insert_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0035 verification failed: INSERT policy reappeared';
    END IF;

    -- RPC posture unchanged: service-role only.
    SELECT has_function_privilege(
        'authenticated',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_auth_can_execute;
    IF COALESCE(v_auth_can_execute, TRUE) IS NOT FALSE THEN
        RAISE EXCEPTION
            '0035 verification failed: authenticated can EXECUTE the append RPC';
    END IF;

    SELECT has_function_privilege(
        'service_role',
        'public.append_transport_budget_event(jsonb)',
        'EXECUTE'
    ) INTO v_service_can_execute;
    IF COALESCE(v_service_can_execute, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0035 verification failed: service_role lost EXECUTE on the append RPC';
    END IF;

    -- Single-company guard (unchanged): no multi-tenant columns, ever.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_budget_events'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION
            '0035 verification failed: unexpected tenant partitioning columns (%)',
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
            '0035 verification failed: expected 3 integrity triggers, found %',
            v_trigger_count;
    END IF;

    RAISE NOTICE
        '0035 verification PASSED: CONSUMPTION_REVERSAL ledger contract ready (single-company, append-only, service-role path)';
END $$;


-- ============================================================================
-- End of 0035 (no historical data rewrite; all pre-existing events valid)
-- ============================================================================

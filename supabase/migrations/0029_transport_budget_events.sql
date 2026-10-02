-- ============================================================================
-- 0029_transport_budget_events.sql
--
-- Prime ERP — Phase 4: Transport Budget Event Ledger (infrastructure only)
--
-- An isolated, append-only internal management-budget event store. It records
-- the BUDGET EFFECT of already-calculated, already-authorized transport
-- events (future: sales allocations, reversals, inbound/outbound consumption).
--
-- FROZEN ARCHITECTURE:
--   - This is NOT General Ledger / AR / inventory / COGS / cash / tax.
--   - It is completely separate from `ledger_entries`.
--   - Phase 4 provides the event store + integrity primitives ONLY.
--   - There are intentionally NO producers in this migration and no
--     integration with sales, invoices, POS, orders, Landing Cost, deliveries,
--     expenses, COA, GL posting, reports, Portal, or statements.
--
-- ARCHITECTURE:
--   - Single company. NO tenant_id. NO organization_id. NO company_id.
--   - Standard sync envelope (id TEXT PK, data JSONB, created_at,
--     updated_at, version) so the existing offline-first pipeline
--     (IndexedDB -> durable queue -> POST /api/sync/ops -> Supabase)
--     carries events unchanged: the domain payload lives in `data`, the
--     client-generated stable `id` is the primary key, and the economic
--     idempotency key lives in `data.idempotencyKey`.
--   - Money is stored as JSON numbers in currency units rounded to 2dp by
--     the business layer (`roundMoney`), consistent with every other
--     envelope table. The stored amount is authoritative and is never
--     recalculated. No tax fields. No FX fields.
--
-- INTEGRITY MODEL (all enforced in the database, not only in the client):
--   - kind CHECK: exactly SALES_ALLOCATION | REVERSAL |
--     INBOUND_CONSUMPTION | OUTBOUND_CONSUMPTION.
--   - amount CHECK: present, numeric, non-zero, max 2dp, bounded, and signed
--     per kind (SALES_ALLOCATION > 0; all others < 0). The sign is STORED,
--     never inferred at read time.
--   - idempotency uniqueness: partial UNIQUE index on data.idempotencyKey.
--   - reversal shape CHECK: reversesEventId present IFF kind = REVERSAL.
--   - BEFORE INSERT trigger: strict calendar businessDate, per-kind
--     required/forbidden fields, accounting-metadata quarantine
--     (journalIds/accountSplits must stay empty in Phase 4), reversal target
--     existence + reversibility (SALES_ALLOCATION only), self-link guard,
--     and the cumulative reversal cap (SUM(reversals) + new <= allocation).
--     The target row is locked (FOR UPDATE) so concurrent reversals of the
--     same allocation serialize instead of racing past the cap.
--   - BEFORE UPDATE / BEFORE DELETE triggers: append-only is absolute, also
--     on the service-role path. Corrections happen via new events.
--   - RLS: authenticated SELECT + INSERT only (same role/grantee shape as the
--     baseline allow_all pattern, narrowed to append-only). No UPDATE/DELETE
--     policies. Service-role (sync gateway) bypasses RLS as usual.
-- ============================================================================


-- ============================================================================
-- 1. TABLE (standard sync envelope + structural CHECKs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.transport_budget_events (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,

    -- Exactly the four canonical event kinds. No speculative types.
    CONSTRAINT chk_transport_budget_events_kind CHECK (
        COALESCE(data->>'kind', '') IN (
            'SALES_ALLOCATION',
            'REVERSAL',
            'INBOUND_CONSUMPTION',
            'OUTBOUND_CONSUMPTION'
        )
    ),

    -- Economic idempotency key: immutable, unique (see partial unique index
    -- below), preserved offline and through sync. Generic shape so future
    -- producers can use e.g. SALES_ALLOCATION:{convertedInvoiceId ?? saleId}.
    CONSTRAINT chk_transport_budget_events_key CHECK (
        (data->>'idempotencyKey') ~ '^[A-Za-z0-9:_\-./]{1,200}$'
    ),

    -- Signed budget movement in currency units: numeric, non-zero, at most
    -- 2 decimal places, bounded. Stored exactly as supplied.
    CONSTRAINT chk_transport_budget_events_amount_shape CHECK (
        (data->>'amount') ~ '^-?[0-9]+(\.[0-9]{1,2})?$'
        AND (data->>'amount')::numeric <> 0
        AND ABS((data->>'amount')::numeric) <= 999999999999.99
    ),

    -- Sign convention per kind. SALES_ALLOCATION generates budget (> 0);
    -- REVERSAL / INBOUND_CONSUMPTION / OUTBOUND_CONSUMPTION consume it (< 0).
    CONSTRAINT chk_transport_budget_events_sign CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'SALES_ALLOCATION' THEN (data->>'amount')::numeric > 0
            ELSE (data->>'amount')::numeric < 0
        END
    ),

    -- Reversal link exists if and only if the event is a REVERSAL.
    CONSTRAINT chk_transport_budget_events_reversal_shape CHECK (
        CASE COALESCE(data->>'kind', '')
            WHEN 'REVERSAL' THEN COALESCE(data->>'reversesEventId', '') <> ''
            ELSE COALESCE(data->>'reversesEventId', '') = ''
        END
    ),

    -- Business date (reporting date, independent of sync timestamps).
    -- Format is enforced here; strict calendar validity is enforced by the
    -- BEFORE INSERT trigger below.
    CONSTRAINT chk_transport_budget_events_business_date CHECK (
        (data->>'businessDate') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    ),

    -- Historical allocation-rate snapshot (percent). Preserved exactly as
    -- supplied at creation; never re-resolved from CompanyConfig on read.
    -- Optional: only SALES_ALLOCATION is required to carry it.
    CONSTRAINT chk_transport_budget_events_rate CHECK (
        COALESCE(data->>'allocationRatePercent', '') = ''
        OR (
            (data->>'allocationRatePercent') ~ '^[0-9]+(\.[0-9]+)?$'
            AND (data->>'allocationRatePercent')::numeric BETWEEN 0 AND 100
        )
    ),

    -- Source-document amount snapshot (currency units, 2dp). Optional except
    -- where the per-kind matrix (trigger) requires it.
    CONSTRAINT chk_transport_budget_events_source_amount CHECK (
        COALESCE(data->>'sourceAmount', '') = ''
        OR (
            (data->>'sourceAmount') ~ '^[0-9]+(\.[0-9]{1,2})?$'
            AND (data->>'sourceAmount')::numeric BETWEEN 0 AND 999999999999.99
        )
    )
);


-- ============================================================================
-- 2. INSERT VALIDATION + REVERSAL INTEGRITY TRIGGER (authoritative)
--
-- The client repository performs the same checks as a fail-fast UX guard,
-- but this trigger is the authority: it fires on EVERY insert regardless of
-- the write path (sync gateway upsert, RPC, backfill).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transport_budget_events_validate_insert()
RETURNS TRIGGER AS $$
DECLARE
    v_kind TEXT;
    v_reverses TEXT;
    v_new_amount NUMERIC;
    v_target_kind TEXT;
    v_target_amount NUMERIC;
    v_reversed_total NUMERIC;
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

    ELSE
        -- INBOUND_CONSUMPTION / OUTBOUND_CONSUMPTION: terminal budget use.
        -- Source identity is optional future linkage (Landing Cost /
        -- delivery / expense producers arrive later); a rate is meaningless.
        IF COALESCE(NEW.data->>'allocationRatePercent', '') <> '' THEN
            RAISE EXCEPTION
                'transport_budget_events: % must not carry allocationRatePercent',
                v_kind;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transport_budget_events_validate_insert
    ON public.transport_budget_events;
CREATE TRIGGER trg_transport_budget_events_validate_insert
    BEFORE INSERT ON public.transport_budget_events
    FOR EACH ROW
    EXECUTE FUNCTION public.transport_budget_events_validate_insert();


-- ============================================================================
-- 3. APPEND-ONLY ENFORCEMENT (UPDATE / DELETE are always rejected)
--
-- Corrections happen by appending a new event, never by editing history.
-- The RLS policy set below already denies UPDATE/DELETE to anon and
-- authenticated roles; these triggers additionally close the service-role
-- path (sync gateway, backfills, manual SQL).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transport_budget_events_block_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'transport_budget_events is append-only: % is not permitted (append a new event instead)',
        TG_OP;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transport_budget_events_block_update
    ON public.transport_budget_events;
CREATE TRIGGER trg_transport_budget_events_block_update
    BEFORE UPDATE ON public.transport_budget_events
    FOR EACH ROW
    EXECUTE FUNCTION public.transport_budget_events_block_mutation();

DROP TRIGGER IF EXISTS trg_transport_budget_events_block_delete
    ON public.transport_budget_events;
CREATE TRIGGER trg_transport_budget_events_block_delete
    BEFORE DELETE ON public.transport_budget_events
    FOR EACH ROW
    EXECUTE FUNCTION public.transport_budget_events_block_mutation();

-- Standard envelope updated_at maintenance (kept for contract compatibility;
-- it can only ever fire if the block above is bypassed by a future
-- migration, in which case the block still raises first).
DROP TRIGGER IF EXISTS trg_transport_budget_events_update_updated_at
    ON public.transport_budget_events;
CREATE TRIGGER trg_transport_budget_events_update_updated_at
    BEFORE UPDATE ON public.transport_budget_events
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 4. NARROWLY-SCOPED ATOMIC APPEND RPC
--
-- Idempotent single-event append for future producers and admin tooling:
-- same id + identical payload -> existing row; same idempotencyKey ->
-- existing economic event; otherwise insert (triggers above still apply).
-- Contains NO sales / invoice / Landing Cost / delivery / accounting logic.
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
    SELECT * INTO v_row
    FROM public.transport_budget_events
    WHERE (data->>'idempotencyKey') = v_key;
    IF FOUND THEN
        RETURN row_to_json(v_row)::JSONB;
    END IF;

    INSERT INTO public.transport_budget_events (id, data)
    VALUES (v_id, (p_event - 'id'))
    RETURNING * INTO v_row;
    RETURN row_to_json(v_row)::JSONB;
END;
$$ LANGUAGE plpgsql;

-- Fixed search_path hygiene for the RPC.
ALTER FUNCTION public.append_transport_budget_event(JSONB)
    SET search_path = public, pg_temp;

GRANT EXECUTE ON FUNCTION public.append_transport_budget_event(JSONB)
    TO authenticated, service_role;


-- ============================================================================
-- 5. INDEXES
-- ============================================================================

-- Economic identity: at most one row per idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_budget_events_idempotency_key
    ON public.transport_budget_events ((data->>'idempotencyKey'))
    WHERE COALESCE(data->>'idempotencyKey', '') <> '';

-- Deterministic retrieval: by kind, by business-date range, by source.
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_kind
    ON public.transport_budget_events ((data->>'kind'));
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_business_date
    ON public.transport_budget_events ((data->>'businessDate'));
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_reverses
    ON public.transport_budget_events ((data->>'reversesEventId'))
    WHERE COALESCE(data->>'reversesEventId', '') <> '';
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_source
    ON public.transport_budget_events ((data->>'sourceEventId'))
    WHERE COALESCE(data->>'sourceEventId', '') <> '';

-- Incremental sync cursor (same convention as every envelope table).
CREATE INDEX IF NOT EXISTS idx_transport_budget_events_updated
    ON public.transport_budget_events (updated_at DESC);


-- ============================================================================
-- 6. ROW LEVEL SECURITY (append-only: SELECT + INSERT for authenticated)
--
-- Same role/grantee shape as the baseline allow_all pattern
-- (FOR ... TO authenticated USING (true) / WITH CHECK (true)), narrowed to
-- append-only: there are deliberately NO UPDATE and NO DELETE policies, so
-- direct PostgREST UPDATE/DELETE is denied for anon + authenticated roles.
-- The backend sync gateway uses the service-role key and bypasses RLS.
-- Transport budget events are internal and must never be exposed through
-- customer/public verification endpoints.
-- ============================================================================

ALTER TABLE public.transport_budget_events
    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_select_transport_budget_events"
    ON public.transport_budget_events;
CREATE POLICY "allow_select_transport_budget_events"
    ON public.transport_budget_events FOR SELECT TO authenticated
    USING (true);

DROP POLICY IF EXISTS "allow_insert_transport_budget_events"
    ON public.transport_budget_events;
CREATE POLICY "allow_insert_transport_budget_events"
    ON public.transport_budget_events FOR INSERT TO authenticated
    WITH CHECK (true);


-- ============================================================================
-- 7. REALTIME PUBLICATION (refresh infrastructure only; grants no access)
-- ============================================================================

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
    ) THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime
                ADD TABLE public.transport_budget_events;
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;
    END IF;
END $$;


-- ============================================================================
-- 8. POST-MIGRATION VERIFICATION (read-only checks)
-- ============================================================================

DO $$
DECLARE
    v_table_exists BOOLEAN;
    v_rls_enabled BOOLEAN;
    v_policy_count INTEGER;
    v_idx_count INTEGER;
    v_tenant_cols INTEGER;
    v_trigger_count INTEGER;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'transport_budget_events'
    ) INTO v_table_exists;
    IF NOT v_table_exists THEN
        RAISE EXCEPTION
            '0029 verification failed: transport_budget_events table missing';
    END IF;

    SELECT c.relrowsecurity INTO v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'transport_budget_events';
    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0029 verification failed: RLS is not enabled';
    END IF;

    -- Exactly SELECT + INSERT. UPDATE/DELETE must remain denied.
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events';
    IF v_policy_count <> 2 THEN
        RAISE EXCEPTION
            '0029 verification failed: expected 2 RLS policies, found %',
            v_policy_count;
    END IF;

    SELECT COUNT(*) INTO v_idx_count
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'transport_budget_events'
      AND indexname IN (
          'uq_transport_budget_events_idempotency_key',
          'idx_transport_budget_events_kind',
          'idx_transport_budget_events_business_date',
          'idx_transport_budget_events_reverses',
          'idx_transport_budget_events_source',
          'idx_transport_budget_events_updated'
      );
    IF v_idx_count <> 6 THEN
        RAISE EXCEPTION
            '0029 verification failed: expected 6 indexes, found %',
            v_idx_count;
    END IF;

    -- Single-company guard: no multi-tenant partitioning columns, ever.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_budget_events'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION
            '0029 verification failed: unexpected tenant partitioning columns (%)',
            v_tenant_cols;
    END IF;

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
            '0029 verification failed: expected 3 integrity triggers, found %',
            v_trigger_count;
    END IF;

    RAISE NOTICE
        '0029 verification PASSED: append-only transport budget ledger ready (single-company, no tenant columns)';
END $$;


-- ============================================================================
-- End of 0029
-- ============================================================================

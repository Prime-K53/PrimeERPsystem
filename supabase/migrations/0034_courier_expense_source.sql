-- ============================================================================
-- 0034_courier_expense_source.sql
--
-- Prime ERP — Phase 7J: authoritative outbound courier/transport expense
-- source (prerequisite for future OUTBOUND_CONSUMPTION; no Transport Budget
-- producer is created here).
--
-- Single-company app — NO tenant_id / company_id / organization_id column.
--
-- 1. COA: dedicated postable child 52610 'Courier & Delivery Transport'
--    (OPERATING_EXPENSE, parent 52000, DEBIT, allow_posting). Rationale:
--    52000 is a non-posting parent; 51300 is inbound COGS-role freight;
--    52600 'Transport' is postable but semantically shared with Printing
--    (printing default fallback), so reusing it would inherit ambiguity.
--    No historical rows reference 52610; existing Printing postings to 52600
--    are untouched; no account is renamed.
-- 2. transport_expenses envelope table (header + embedded lines[]):
--    machine classification per line (OUTBOUND_TRANSPORT | NON_TRANSPORT),
--    per-line supplier reference, status machine DRAFT → POSTED → VOIDED,
--    idempotency unique key, single-reversal unique link, conditional
--    immutability trigger (economic fields frozen once POSTED/VOIDED),
--    append-style reversal rows (separate records, never in-place edits).
-- ============================================================================


-- ============================================================================
-- 1. COA: dedicated courier/delivery transport expense account (idempotent)
-- ============================================================================

INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '52610', jsonb_build_object(
    'id', '52610', 'code', '52610', 'account_number', '52610',
    'name', 'Courier & Delivery Transport',
    'account_type', 'EXPENSE', 'type', 'Expense',
    'account_group', 'OPERATING_EXPENSE',
    'parent_account_id', '52600',
    'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '52610' OR data->>'account_number' = '52610');


-- ============================================================================
-- 2. transport_expenses envelope table
--
-- One row per courier/supplier transport document. Transport and
-- non-transport lines coexist on one document; only OUTBOUND_TRANSPORT
-- lines are ever eligible for future Transport Budget consumption.
-- Reversals are separate rows linked via reversesExpenseId (full void
-- only: reversal total must equal the original total).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.transport_expenses (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,

    -- Lifecycle state. DRAFT is editable; POSTED/VOIDED are frozen
    -- (see the immutability trigger below).
    CONSTRAINT chk_transport_expenses_status CHECK (
        COALESCE(data->>'status', '') IN ('DRAFT', 'POSTED', 'VOIDED')
    ),

    -- Deterministic business idempotency key (never random UUID/timestamp).
    CONSTRAINT chk_transport_expenses_key CHECK (
        (data->>'idempotencyKey') ~ '^[A-Za-z0-9:_\-./]{1,200}$'
    ),

    -- Business date shape; strict calendar validity in the trigger.
    CONSTRAINT chk_transport_expenses_business_date CHECK (
        (data->>'businessDate') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
    ),

    -- Reversal link exists if and only if the row is a reversal.
    CONSTRAINT chk_transport_expenses_reversal_shape CHECK (
        CASE COALESCE(data->>'isReversal', 'false')
            WHEN 'true' THEN COALESCE(data->>'reversesExpenseId', '') <> ''
            ELSE COALESCE(data->>'reversesExpenseId', '') = ''
        END
    )
);

-- Economic identity: at most one row per idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_expenses_idempotency_key
    ON public.transport_expenses ((data->>'idempotencyKey'))
    WHERE COALESCE(data->>'idempotencyKey', '') <> '';

-- Single-reversal rule: at most one reversal row per original expense.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transport_expenses_reversal
    ON public.transport_expenses ((data->>'reversesExpenseId'))
    WHERE COALESCE(data->>'reversesExpenseId', '') <> '';

CREATE INDEX IF NOT EXISTS idx_transport_expenses_status
    ON public.transport_expenses ((data->>'status'));
CREATE INDEX IF NOT EXISTS idx_transport_expenses_business_date
    ON public.transport_expenses ((data->>'businessDate'));
CREATE INDEX IF NOT EXISTS idx_transport_expenses_supplier
    ON public.transport_expenses ((data->>'supplierId'))
    WHERE COALESCE(data->>'supplierId', '') <> '';
CREATE INDEX IF NOT EXISTS idx_transport_expenses_updated
    ON public.transport_expenses (updated_at DESC);


-- ============================================================================
-- 3. WRITE VALIDATION + IMMUTABILITY TRIGGER (authoritative)
--
-- Fires on EVERY insert/update regardless of write path (local service,
-- sync gateway upsert, backfill). Application validation is fail-fast UX;
-- this trigger is the authority.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.transport_expenses_validate_write()
RETURNS TRIGGER AS $$
DECLARE
    v_status TEXT;
    v_old_status TEXT;
    v_is_reversal BOOLEAN;
    v_reverses TEXT;
    v_target_status TEXT;
    v_target_total NUMERIC;
    v_new_total NUMERIC;
    v_existing_reversals INTEGER;
    v_business_date TEXT;
    v_y INTEGER;
    v_m INTEGER;
    v_d INTEGER;
    v_line JSONB;
    v_line_amount NUMERIC;
    v_line_class TEXT;
    v_line_supplier TEXT;
    v_sum NUMERIC := 0;
    v_has_transport BOOLEAN := FALSE;
    v_frozen TEXT;
BEGIN
    v_status := COALESCE(NEW.data->>'status', '');
    v_is_reversal := COALESCE(NEW.data->>'isReversal', 'false') = 'true';
    v_reverses := NULLIF(NEW.data->>'reversesExpenseId', '');
    v_business_date := COALESCE(NEW.data->>'businessDate', '');

    -- Strict calendar validity.
    BEGIN
        v_y := SUBSTRING(v_business_date FROM 1 FOR 4)::INTEGER;
        v_m := SUBSTRING(v_business_date FROM 6 FOR 2)::INTEGER;
        v_d := SUBSTRING(v_business_date FROM 9 FOR 2)::INTEGER;
        PERFORM make_date(v_y, v_m, v_d);
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION
            'transport_expenses: invalid businessDate %', v_business_date;
    END;

    -- Line-level validation (both DRAFT shape and POSTED substance share the
    -- structural rules; POSTED additionally requires journalId, below).
    IF jsonb_typeof(COALESCE(NEW.data->'lines', '[]'::jsonb)) <> 'array'
       OR jsonb_array_length(COALESCE(NEW.data->'lines', '[]'::jsonb)) = 0 THEN
        RAISE EXCEPTION 'transport_expenses: at least one line is required';
    END IF;
    v_sum := 0;
    v_has_transport := FALSE;
    FOR v_line IN SELECT * FROM jsonb_array_elements(NEW.data->'lines')
    LOOP
        IF COALESCE(v_line->>'id', '') = '' THEN
            RAISE EXCEPTION 'transport_expenses: every line requires a stable id';
        END IF;
        v_line_class := COALESCE(v_line->>'classification', '');
        IF v_line_class NOT IN ('OUTBOUND_TRANSPORT', 'NON_TRANSPORT') THEN
            RAISE EXCEPTION
                'transport_expenses: line % has invalid classification % (expected OUTBOUND_TRANSPORT or NON_TRANSPORT)',
                COALESCE(v_line->>'id', '?'), v_line_class;
        END IF;
        IF (v_line->>'amount') IS NULL
           OR (v_line->>'amount') !~ '^[0-9]+(\.[0-9]{1,2})?$' THEN
            RAISE EXCEPTION
                'transport_expenses: line % amount must be a positive 2dp number',
                COALESCE(v_line->>'id', '?');
        END IF;
        v_line_amount := (v_line->>'amount')::numeric;
        IF v_line_amount <= 0 OR v_line_amount > 999999999999.99 THEN
            RAISE EXCEPTION
                'transport_expenses: line % amount out of range (0, 999999999999.99]',
                COALESCE(v_line->>'id', '?');
        END IF;
        IF COALESCE(v_line->>'supplierId', '') = '' THEN
            RAISE EXCEPTION
                'transport_expenses: line % requires supplierId',
                COALESCE(v_line->>'id', '?');
        END IF;
        IF v_line_class = 'OUTBOUND_TRANSPORT' THEN
            v_has_transport := TRUE;
        END IF;
        v_sum := v_sum + v_line_amount;
    END LOOP;
    -- Header total must equal the line sum (no document-total invention).
    IF ABS(COALESCE((NEW.data->>'totalAmount')::numeric, -1) - v_sum) > 0.000001 THEN
        RAISE EXCEPTION
            'transport_expenses: totalAmount must equal the sum of line amounts';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF v_status NOT IN ('DRAFT', 'POSTED') THEN
            RAISE EXCEPTION
                'transport_expenses: new rows must be DRAFT or POSTED, got %', v_status;
        END IF;
        IF v_is_reversal THEN
            -- Reversal rows are born POSTED and must fully mirror the target.
            IF v_status <> 'POSTED' THEN
                RAISE EXCEPTION 'transport_expenses: reversal rows must be POSTED';
            END IF;
            IF v_reverses IS NULL THEN
                RAISE EXCEPTION 'transport_expenses: reversal requires reversesExpenseId';
            END IF;
            IF v_reverses = NEW.id THEN
                RAISE EXCEPTION 'transport_expenses: reversal cannot reference itself';
            END IF;
            SELECT (data->>'status'), COALESCE((data->>'totalAmount')::numeric, 0)
            INTO v_target_status, v_target_total
            FROM public.transport_expenses
            WHERE id = v_reverses;
            IF NOT FOUND THEN
                RAISE EXCEPTION
                    'transport_expenses: reversal target % does not exist', v_reverses;
            END IF;
            IF v_target_status <> 'POSTED' THEN
                RAISE EXCEPTION
                    'transport_expenses: only POSTED expenses are reversible (target % is %)',
                    v_reverses, v_target_status;
            END IF;
            -- Serialize concurrent voids of the same expense (the partial
            -- unique index below is the cross-process backstop).
            PERFORM pg_advisory_xact_lock(hashtext('texp-void:' || v_reverses));
            -- Full-void rule: reversal total must equal the original total.
            v_new_total := COALESCE((NEW.data->>'totalAmount')::numeric, 0);
            IF ABS(v_new_total - v_target_total) > 0.000001 THEN
                RAISE EXCEPTION
                    'transport_expenses: reversal total (%) must equal original total (%) for target %',
                    v_new_total, v_target_total, v_reverses;
            END IF;
            SELECT COUNT(*)
            INTO v_existing_reversals
            FROM public.transport_expenses
            WHERE (data->>'reversesExpenseId') = v_reverses;
            IF v_existing_reversals > 0 THEN
                RAISE EXCEPTION
                    'transport_expenses: expense % was already reversed', v_reverses;
            END IF;
        ELSE
            IF v_status = 'POSTED' AND COALESCE(NEW.data->>'journalId', '') = '' THEN
                RAISE EXCEPTION 'transport_expenses: POSTED rows require journalId';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    -- UPDATE path: frozen economics once POSTED/VOIDED.
    v_old_status := COALESCE(OLD.data->>'status', '');
    IF v_old_status IN ('POSTED', 'VOIDED') THEN
        -- Only the POSTED → VOIDED transition is legal, and only when a
        -- reversal row already exists (reversal created first).
        IF NOT (v_old_status = 'POSTED' AND v_status = 'VOIDED'
                AND EXISTS (SELECT 1 FROM public.transport_expenses
                            WHERE (data->>'reversesExpenseId') = OLD.id)) THEN
            RAISE EXCEPTION
                'transport_expenses: % rows are immutable (only POSTED→VOIDED with a reversal present)',
                v_old_status;
        END IF;
        -- Even on the legal transition, economic fields must be unchanged.
        FOR v_frozen IN
            SELECT * FROM (VALUES ('lines'), ('totalAmount'), ('supplierId'),
                ('businessDate'), ('expenseAccountId'), ('settlementMode'),
                ('settlementAccountId'), ('idempotencyKey')) AS f(col)
        LOOP
            IF COALESCE((OLD.data->>v_frozen), '') IS DISTINCT FROM
               COALESCE((NEW.data->>v_frozen), '') THEN
                RAISE EXCEPTION
                    'transport_expenses: field % is frozen on % rows',
                    v_frozen, v_old_status;
            END IF;
        END LOOP;
        RETURN NEW;
    END IF;

    -- OLD.status = DRAFT: edits allowed, but the row may only move to POSTED
    -- (full validity, journalId present) — never directly to VOIDED, and
    -- reversal linkage/identity fields may not be introduced by edit.
    IF v_old_status = 'DRAFT' THEN
        IF v_status NOT IN ('DRAFT', 'POSTED') THEN
            RAISE EXCEPTION
                'transport_expenses: DRAFT rows may only move to POSTED, got %', v_status;
        END IF;
        IF v_status = 'POSTED' AND COALESCE(NEW.data->>'journalId', '') = '' THEN
            RAISE EXCEPTION 'transport_expenses: POSTED rows require journalId';
        END IF;
        IF COALESCE(NEW.data->>'reversesExpenseId', '') <> '' THEN
            RAISE EXCEPTION
                'transport_expenses: reversesExpenseId is set only on reversal rows at creation';
        END IF;
        RETURN NEW;
    END IF;

    -- Unknown OLD status: fail closed.
    RAISE EXCEPTION
        'transport_expenses: unknown existing status %', v_old_status;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_transport_expenses_validate_write
    ON public.transport_expenses;
CREATE TRIGGER trg_transport_expenses_validate_write
    BEFORE INSERT OR UPDATE ON public.transport_expenses
    FOR EACH ROW
    EXECUTE FUNCTION public.transport_expenses_validate_write();


-- ============================================================================
-- 4. SYNC / ACCESS POSTURE (same envelope conventions as other sub-ledgers)
-- ============================================================================

DROP TRIGGER IF EXISTS trg_transport_expenses_update_updated_at
    ON public.transport_expenses;
CREATE TRIGGER trg_transport_expenses_update_updated_at
    BEFORE UPDATE ON public.transport_expenses
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.transport_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_transport_expenses" ON public.transport_expenses;
CREATE POLICY "allow_all_transport_expenses" ON public.transport_expenses
    FOR ALL TO authenticated USING (true) WITH CHECK (true);


-- ============================================================================
-- 5. POST-MIGRATION VERIFICATION (read-only checks)
-- ============================================================================

DO $$
DECLARE
    v_coa_count INTEGER;
    v_policy_count INTEGER;
    v_idx_count INTEGER;
    v_tenant_cols INTEGER;
    v_trigger_count INTEGER;
BEGIN
    -- Dedicated COA account present and postable.
    SELECT COUNT(*) INTO v_coa_count
    FROM public.accounts
    WHERE id = '52610' AND (data->>'account_number') = '52610'
      AND (data->>'allow_posting')::boolean IS TRUE;
    IF v_coa_count <> 1 THEN
        RAISE EXCEPTION '0034 verification failed: 52610 Courier & Delivery Transport missing or not postable';
    END IF;

    -- Exactly one RLS policy (allow_all envelope convention).
    SELECT COUNT(*) INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'transport_expenses';
    IF v_policy_count <> 1 THEN
        RAISE EXCEPTION '0034 verification failed: expected 1 RLS policy, found %', v_policy_count;
    END IF;

    -- Indexes: idempotency unique, reversal unique, status/date/supplier/updated.
    SELECT COUNT(*) INTO v_idx_count
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'transport_expenses'
      AND indexname IN (
          'uq_transport_expenses_idempotency_key',
          'uq_transport_expenses_reversal',
          'idx_transport_expenses_status',
          'idx_transport_expenses_business_date',
          'idx_transport_expenses_supplier',
          'idx_transport_expenses_updated'
      );
    IF v_idx_count <> 6 THEN
        RAISE EXCEPTION '0034 verification failed: expected 6 indexes, found %', v_idx_count;
    END IF;

    -- Single-company guard: no tenant partitioning columns.
    SELECT COUNT(*) INTO v_tenant_cols
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transport_expenses'
      AND column_name IN ('tenant_id', 'organization_id', 'company_id');
    IF v_tenant_cols <> 0 THEN
        RAISE EXCEPTION '0034 verification failed: unexpected tenant columns (%)', v_tenant_cols;
    END IF;

    -- Integrity + maintenance triggers bound.
    SELECT COUNT(*) INTO v_trigger_count
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'transport_expenses'
      AND t.tgname IN (
          'trg_transport_expenses_validate_write',
          'trg_transport_expenses_update_updated_at'
      );
    IF v_trigger_count <> 2 THEN
        RAISE EXCEPTION '0034 verification failed: expected 2 triggers, found %', v_trigger_count;
    END IF;

    RAISE NOTICE '0034 verification PASSED: courier expense source ready (single-company envelope)';
END $$;


-- ============================================================================
-- End of 0034 (no historical data rewrite; greenfield table)
-- ============================================================================

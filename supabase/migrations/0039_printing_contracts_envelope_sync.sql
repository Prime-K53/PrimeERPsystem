-- ============================================================================
-- 0039_printing_contracts_envelope_sync.sql
--
-- Fix: printing contracts (the assessment_contracts family) never reached
-- Supabase through the sync gateway, so they were local-only and invisible
-- on every other device.
--
-- Root cause: migration 0006 created these tables with the legacy
-- top-column shape (company_id, contract_number, ... NOT NULL, no defaults),
-- while the entire sync architecture — the gateway (POST /api/sync/ops),
-- the legacy direct client, the incremental pull, realtime and document
-- verification — treats them as envelope tables: { id, data JSONB,
-- updated_at, version }. The gateway's envelope INSERT therefore violated
-- the NOT NULL constraints (PostgREST 400), the op was dead-lettered as
-- non-retryable, and no contract ever reached the cloud. Even if a row had
-- landed, the company-scoped RLS policy read the top-level company_id
-- column (left NULL by the envelope write) and hid the row from every
-- other device's pull.
--
-- This migration brings the three tables in line with the single-company
-- envelope convention used by the rest of the live schema (see the
-- allow_all_* policies in 0001_baseline_live_schema.sql):
--   1. Backfill the data JSONB from the top-level columns so legacy rows
--      (created via the 0006 RPC functions) keep their business data and
--      stay visible to verification (data->>contract_number) and to the
--      envelope-based pull.
--   2. Drop NOT NULL from the business columns so envelope writes succeed.
--      The columns are kept (not dropped) so the legacy 0006 RPC functions
--      keep working; they are simply no longer the system of record.
--   3. Replace the company-scoped RLS policies with allow_all_* policies
--      (single-company app — every authenticated staff member sees all
--      rows), matching sales/invoices/orders/customers/wallet_transactions.
--   4. Partial unique index on data->>'contract_number' (tombstones
--      excluded) so two devices can never mint the same contract number.
-- ============================================================================

BEGIN;

-- ─── 1. Backfill data JSONB from the top-level columns ──────────────────
-- Only rows with an empty data envelope are migrated: rows already written
-- through the gateway carry their business data in data and must not be
-- overwritten with (older) column values.

UPDATE public.assessment_contracts
SET data = jsonb_strip_nulls(jsonb_build_object(
    'company_id',               company_id,
    'customer_id',              customer_id,
    'school_id',                school_id,
    'contract_number',          contract_number,
    'title',                    title,
    'description',              description,
    'status',                   status,
    'prepaid_amount',           prepaid_amount,
    'consumed_amount',          consumed_amount,
    'reserved_amount',          reserved_amount,
    'starts_at',                starts_at,
    'ends_at',                  ends_at,
    'expires_at',               expires_at,
    'activated_at',             activated_at,
    'completed_at',             completed_at,
    'cancelled_at',             cancelled_at,
    'suspended_at',             suspended_at,
    'assessment_type',          assessment_type,
    'assessment_grade',         assessment_grade,
    'assessment_subject',       assessment_subject,
    'assessment_count',         assessment_count,
    'max_assessments',          max_assessments,
    'assessment_price',         assessment_price,
    'payment_id',               payment_id,
    'payment_status',           payment_status,
    'payment_verified_at',      payment_verified_at,
    'wallet_credit_applied_at', wallet_credit_applied_at,
    'notes',                    notes,
    'terms',                    terms,
    'created_by',               created_by
))
WHERE data IS NULL OR data = '{}'::jsonb;

UPDATE public.assessment_contract_items
SET data = jsonb_strip_nulls(jsonb_build_object(
    'contract_id',        contract_id,
    'company_id',         company_id,
    'customer_id',        customer_id,
    'school_id',          school_id,
    'assessment_type',    assessment_type,
    'assessment_grade',   assessment_grade,
    'assessment_subject', assessment_subject,
    'assessment_name',    assessment_name,
    'assessment_date',    assessment_date,
    'status',             status,
    'item_price',         item_price,
    'consumed_at',        consumed_at,
    'reserved_at',        reserved_at,
    'released_at',        released_at,
    'notes',              notes,
    'created_by',         created_by
))
WHERE data IS NULL OR data = '{}'::jsonb;

UPDATE public.contract_amendments
SET data = jsonb_strip_nulls(jsonb_build_object(
    'contract_id',                 contract_id,
    'company_id',                  company_id,
    'customer_id',                 customer_id,
    'amendment_type',              amendment_type,
    'description',                 description,
    'change_amount',               change_amount,
    'new_terms',                   new_terms,
    'requested_by',                requested_by,
    'approved_by',                 approved_by,
    'approved_at',                 approved_at,
    'status',                      status,
    'prepaid_amount_adjustment',   prepaid_amount_adjustment,
    'assessment_count_adjustment', assessment_count_adjustment,
    'assessment_price_adjustment', assessment_price_adjustment,
    'notes',                       notes
))
WHERE data IS NULL OR data = '{}'::jsonb;

-- ─── 2. Envelope writes must succeed: drop NOT NULL from business columns ─
-- Columns are retained (the legacy 0006 RPC functions still reference them);
-- they are simply no longer populated by the sync path. CHECK constraints
-- and the generated available_funds column tolerate NULLs (a CHECK passes
-- when its expression evaluates to NULL, and the numeric columns keep their
-- DEFAULT 0), so no constraint needs to change.

ALTER TABLE public.assessment_contracts
    ALTER COLUMN company_id      DROP NOT NULL,
    ALTER COLUMN customer_id     DROP NOT NULL,
    ALTER COLUMN school_id       DROP NOT NULL,
    ALTER COLUMN contract_number DROP NOT NULL,
    ALTER COLUMN title           DROP NOT NULL,
    ALTER COLUMN assessment_type DROP NOT NULL;

ALTER TABLE public.assessment_contract_items
    ALTER COLUMN contract_id     DROP NOT NULL,
    ALTER COLUMN company_id      DROP NOT NULL,
    ALTER COLUMN customer_id     DROP NOT NULL,
    ALTER COLUMN school_id       DROP NOT NULL,
    ALTER COLUMN assessment_type DROP NOT NULL,
    ALTER COLUMN assessment_name DROP NOT NULL,
    ALTER COLUMN item_price      DROP NOT NULL;

ALTER TABLE public.contract_amendments
    ALTER COLUMN contract_id    DROP NOT NULL,
    ALTER COLUMN company_id     DROP NOT NULL,
    ALTER COLUMN customer_id    DROP NOT NULL,
    ALTER COLUMN amendment_type DROP NOT NULL,
    ALTER COLUMN description    DROP NOT NULL;

-- ─── 3. Single-company RLS: allow_all_* (matches the rest of the live schema) ─

DROP POLICY IF EXISTS "Assessment contracts company access" ON public.assessment_contracts;
CREATE POLICY "allow_all_assessment_contracts"
    ON public.assessment_contracts FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Assessment contract items company access" ON public.assessment_contract_items;
CREATE POLICY "allow_all_assessment_contract_items"
    ON public.assessment_contract_items FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Contract amendments company access" ON public.contract_amendments;
CREATE POLICY "allow_all_contract_amendments"
    ON public.contract_amendments FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- ─── 4. One contract number per live contract ─────────────────────────────
-- Partial index: tombstones (data.deleted = true) keep their number but must
-- not block a fresh contract from reusing it. Skipped (with a notice) when
-- duplicates already exist so the migration never fails on dirty data.

DO $$
DECLARE
    dup_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT data->>'contract_number' AS cn
        FROM public.assessment_contracts
        WHERE (data->>'deleted') IS DISTINCT FROM 'true'
          AND data->>'contract_number' IS NOT NULL
        GROUP BY data->>'contract_number'
        HAVING COUNT(*) > 1
    ) d;

    IF dup_count = 0 THEN
        CREATE UNIQUE INDEX IF NOT EXISTS uq_assessment_contracts_contract_number
            ON public.assessment_contracts ((data->>'contract_number'))
            WHERE (data->>'deleted') IS DISTINCT FROM 'true';
    ELSE
        RAISE NOTICE 'Skipped uq_assessment_contracts_contract_number: % duplicate contract_number value(s) exist — resolve manually before re-running', dup_count;
    END IF;
END $$;

COMMIT;

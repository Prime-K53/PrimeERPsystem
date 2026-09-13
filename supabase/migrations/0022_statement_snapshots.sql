-- ============================================================================
-- 0022_statement_snapshots.sql
-- Prime ERP / Portal
--
-- Immutable statement snapshots used for public document verification.
--
-- BUSINESS MODEL:
--
--   Live customer ledger
--          ↓
--   ERP generates statement
--          ↓
--   Immutable statement snapshot
--          ↓
--   PDF / QR contains statementNumber + verificationToken
--          ↓
--   Public verification endpoint
--          ↓
--   ERP backend verifies the stored snapshot
--
-- IMPORTANT:
--   The public verification endpoint must NOT query live customer/ledger data
--   as the authoritative document. It verifies the stored snapshot.
--
-- ARCHITECTURE:
--   Single company / single admin.
--   NO tenant_id.
--   NO organization_id.
--   NO multi-tenancy.
--
-- SECURITY:
--   RLS enabled.
--   ZERO permissive policies.
--   Backend service-role performs snapshot creation/read/update operations.
--   Public verification is performed through the ERP backend endpoint.
--
-- STORAGE CONTRACT:
--   { id (= statementNumber), data JSONB, created_at, updated_at, version }
-- ============================================================================


-- ============================================================================
-- 1. TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.statement_snapshots (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Business statement number.
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_snapshots_number
    ON public.statement_snapshots ((data->>'statementNumber'))
    WHERE COALESCE(data->>'statementNumber', '') <> '';


-- Customer history / lookup.
CREATE INDEX IF NOT EXISTS idx_statement_snapshots_customer
    ON public.statement_snapshots ((data->>'customerId'));


-- Snapshot lifecycle/status.
CREATE INDEX IF NOT EXISTS idx_statement_snapshots_status
    ON public.statement_snapshots ((data->>'status'));


-- Creation/history ordering.
CREATE INDEX IF NOT EXISTS idx_statement_snapshots_created_at
    ON public.statement_snapshots (created_at);


-- Verification-token lookup.
--
-- The token must identify at most one snapshot.
-- The actual public verification endpoint must still validate the token
-- together with the requested statement number and any other expected
-- verification parameters.
CREATE UNIQUE INDEX IF NOT EXISTS uq_statement_snapshots_verification_token
    ON public.statement_snapshots ((data->>'verificationToken'))
    WHERE COALESCE(data->>'verificationToken', '') <> '';


-- ============================================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================================
--
-- Snapshot creation is authoritative.
-- The standard envelope trigger is retained for compatibility with the
-- existing persistence contract and administrative metadata updates.
--
-- Business/application code MUST NOT rewrite the frozen financial payload
-- after issuance.
-- ============================================================================

DROP TRIGGER IF EXISTS trg_statement_snapshots_update_updated_at
    ON public.statement_snapshots;

CREATE TRIGGER trg_statement_snapshots_update_updated_at
    BEFORE UPDATE
    ON public.statement_snapshots
    FOR EACH ROW
    EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================================
-- 4. ROW LEVEL SECURITY
-- ============================================================================
--
-- CRITICAL SECURITY RULE:
--
-- There are intentionally ZERO policies on this table.
--
-- This prevents:
--   - anonymous direct PostgREST access;
--   - authenticated users reading other customers' statements;
--   - authenticated users inserting forged snapshots;
--   - authenticated users modifying verification snapshots.
--
-- The ERP backend uses the service-role path for authorized snapshot access.
-- The public QR verification endpoint also goes through the ERP backend.
--
-- DO NOT replace this with:
--
--   USING (true)
--   WITH CHECK (true)
--
-- or any other public/authenticated allow-all policy.
-- ============================================================================

ALTER TABLE public.statement_snapshots
    ENABLE ROW LEVEL SECURITY;


-- Remove the unsafe legacy policy if this migration is being applied over
-- the previously proposed 0022 version.
DROP POLICY IF EXISTS "allow_all_statement_snapshots"
    ON public.statement_snapshots;


-- ============================================================================
-- 5. REALTIME PUBLICATION
-- ============================================================================
--
-- Realtime is optional infrastructure for ERP statement-history/UI refresh.
-- It does NOT grant database access and does not create an RLS policy.
-- ============================================================================

DO $$
BEGIN

    IF EXISTS (
        SELECT 1
        FROM pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN

        BEGIN
            ALTER PUBLICATION supabase_realtime
                ADD TABLE public.statement_snapshots;
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;

    END IF;

END $$;


-- ============================================================================
-- 6. POST-MIGRATION SECURITY VERIFICATION
-- ============================================================================
--
-- These checks are read-only.
-- ============================================================================

DO $$
DECLARE
    v_table_exists BOOLEAN;
    v_rls_enabled BOOLEAN;
    v_policy_count INTEGER;
BEGIN

    -- Table exists.
    SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'statement_snapshots'
    )
    INTO v_table_exists;

    IF NOT v_table_exists THEN
        RAISE EXCEPTION
            '0022 verification failed: statement_snapshots table missing';
    END IF;


    -- RLS enabled.
    SELECT c.relrowsecurity
    INTO v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'statement_snapshots';

    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0022 verification failed: RLS is not enabled';
    END IF;


    -- ZERO policies.
    SELECT COUNT(*)
    INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'statement_snapshots';

    IF v_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0022 verification failed: expected ZERO RLS policies, found %',
            v_policy_count;
    END IF;


    RAISE NOTICE
        '0022 verification PASSED: table exists, RLS enabled, zero policies';

END $$;


-- ============================================================================
-- 7. READ-ONLY VERIFICATION OUTPUT
-- ============================================================================

SELECT
    schemaname,
    tablename,
    rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'statement_snapshots';


SELECT
    schemaname,
    tablename,
    policyname,
    permissive,
    roles,
    cmd
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'statement_snapshots'
ORDER BY policyname;


SELECT
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'statement_snapshots'
ORDER BY indexname;


-- ============================================================================
-- End of 0022
-- ============================================================================

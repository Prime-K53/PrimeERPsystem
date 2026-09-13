-- ============================================================================
-- 0021_customer_registration_requests.sql
-- Prime ERP / Portal
--
-- Customer Registration Requests
--
-- FLOW:
--   Public Portal Registration
--        ↓
--   PENDING customer_registration_requests row
--        ↓
--   ERP Admin Review
--        ↓
--   APPROVE
--        ↓
--   Official ERP customer + portal credentials
--
-- IMPORTANT:
--   This table is an application/intake table.
--   It MUST NOT create customers, portal_users, sessions, JWTs,
--   refresh tokens, passwords, or credentials.
--
-- ARCHITECTURE:
--   Single company / single admin.
--   NO tenant_id.
--   NO organization_id.
--   NO multi-tenancy.
--
-- STORAGE CONTRACT:
--   { id TEXT PK, data JSONB, created_at, updated_at, version }
--
-- SECURITY:
--   RLS enabled.
--   ZERO permissive policies.
--   All application access occurs through the backend service-role path.
-- ============================================================================


-- ============================================================================
-- 1. TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.customer_registration_requests (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);


-- ============================================================================
-- 2. INDEXES
-- ============================================================================

-- Admin pending/review queue.
CREATE INDEX IF NOT EXISTS idx_creg_status
    ON public.customer_registration_requests ((data->>'status'));


-- Normalized email lookup.
--
-- Application normalization is lower-case + trim/remove whitespace.
-- Keep the database expression aligned with the service-layer lookup.
CREATE INDEX IF NOT EXISTS idx_creg_email
    ON public.customer_registration_requests
    ((lower(regexp_replace(COALESCE(data->>'email', ''), '\s+', '', 'g'))));


-- Phone lookup.
CREATE INDEX IF NOT EXISTS idx_creg_phone
    ON public.customer_registration_requests ((data->>'phone'));


-- Referral attribution.
CREATE INDEX IF NOT EXISTS idx_creg_referred_by_code
    ON public.customer_registration_requests ((data->>'referred_by_code'));


-- Admin queue ordering.
CREATE INDEX IF NOT EXISTS idx_creg_created_at
    ON public.customer_registration_requests (created_at);


-- Official customer linkage after approval.
CREATE INDEX IF NOT EXISTS idx_creg_linked_customer
    ON public.customer_registration_requests ((data->>'linked_customer_id'));


-- Public request-status lookup.
CREATE INDEX IF NOT EXISTS idx_creg_request_number
    ON public.customer_registration_requests ((data->>'request_number'));


-- ============================================================================
-- 3. ACTIVE-PENDING EMAIL UNIQUENESS
-- ============================================================================
--
-- Only one PENDING registration may exist for a normalized email.
--
-- APPROVED / REJECTED / CANCELLED historical requests remain preserved and
-- do not block a future registration.
--
-- This is a database-level safety net in addition to service-layer checks.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_creg_pending_email
    ON public.customer_registration_requests
    (
        lower(
            regexp_replace(
                COALESCE(data->>'email', ''),
                '\s+',
                '',
                'g'
            )
        )
    )
    WHERE data->>'status' = 'pending'
      AND COALESCE(data->>'email', '') <> '';


-- ============================================================================
-- 4. REQUEST NUMBER UNIQUENESS
-- ============================================================================
--
-- CREG-YYYY-###### is the public/business identifier.
-- NULL values remain allowed at the DB level for legacy/incomplete rows,
-- while actual application-created requests must always supply a number.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_creg_request_number
    ON public.customer_registration_requests ((data->>'request_number'))
    WHERE COALESCE(data->>'request_number', '') <> '';


-- ============================================================================
-- 5. UPDATED_AT TRIGGER
-- ============================================================================
--
-- Uses the existing canonical update_updated_at_column() function.
-- ============================================================================

DO $$
BEGIN
    IF to_regclass('public.customer_registration_requests') IS NOT NULL THEN

        DROP TRIGGER IF EXISTS trg_creg_update_updated_at
            ON public.customer_registration_requests;

        CREATE TRIGGER trg_creg_update_updated_at
            BEFORE UPDATE
            ON public.customer_registration_requests
            FOR EACH ROW
            EXECUTE FUNCTION public.update_updated_at_column();

    END IF;
END $$;


-- ============================================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================================
--
-- CRITICAL:
--   Do NOT create USING (true) / WITH CHECK (true) policies.
--
-- Anonymous/public users must NOT be able to read or write this table
-- directly through PostgREST.
--
-- Backend service-role access bypasses RLS.
-- ============================================================================

ALTER TABLE public.customer_registration_requests
    ENABLE ROW LEVEL SECURITY;


-- ============================================================================
-- 7. REALTIME PUBLICATION
-- ============================================================================
--
-- Realtime is optional infrastructure for the ERP admin review queue.
-- If Supabase Realtime exists, add this table to the publication.
--
-- No public database policy is created by this section.
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
                ADD TABLE public.customer_registration_requests;
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;

    END IF;
END $$;


-- ============================================================================
-- 8. POST-MIGRATION VERIFICATION
-- ============================================================================
--
-- These are READ-ONLY checks. They intentionally do not modify data.
-- ============================================================================

DO $$
DECLARE
    v_rls_enabled BOOLEAN;
    v_policy_count INTEGER;
    v_table_exists BOOLEAN;
BEGIN

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'customer_registration_requests'
    )
    INTO v_table_exists;

    IF NOT v_table_exists THEN
        RAISE EXCEPTION
            '0021 verification failed: customer_registration_requests missing';
    END IF;


    SELECT c.relrowsecurity
    INTO v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n
      ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'customer_registration_requests';

    IF COALESCE(v_rls_enabled, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0021 verification failed: RLS is not enabled';
    END IF;


    SELECT COUNT(*)
    INTO v_policy_count
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'customer_registration_requests';

    IF v_policy_count <> 0 THEN
        RAISE EXCEPTION
            '0021 verification failed: expected ZERO RLS policies, found %',
            v_policy_count;
    END IF;


    RAISE NOTICE
        '0021 verification PASSED: table exists, RLS enabled, zero policies';
END $$;


-- ============================================================================
-- End of 0021
-- ============================================================================
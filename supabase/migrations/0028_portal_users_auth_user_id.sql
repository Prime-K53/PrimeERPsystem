-- ============================================================================
-- 0028_portal_users_auth_user_id.sql
-- Prime ERP / Portal — PHASE 1 (shadow-only, staging-safe)
--
-- Adds the additive Supabase Auth identity mapping column on portal_users:
--
--   auth.users.id (UUID, Supabase-owned)
--        ↓
--   portal_users.auth_user_id (UUID, NULL, UNIQUE — THIS MIGRATION)
--        ↓
--   portal_users.id (TEXT PK, unchanged Portal-user/application identity)
--        ↓
--   portal_users.customer_id (TEXT, unchanged ERP customer/business identity)
--        ↓
--   customers.id (TEXT PK, unchanged business/customer primary key)
--
-- CONTRACT (see architecture audit PHASE 1 + PHASE 2):
--   - NULLABLE: legacy rows stay NULL; NOT NULL is deliberately NOT enforced.
--   - UNIQUE: one Supabase Auth user maps to at most one portal_users row.
--     Enforced by the partial unique index below (NULLs are exempt, so any
--     number of unmapped legacy rows may coexist). The UNIQUE index IS the
--     index — no second index is created.
--   - NO foreign key to auth.users: cross-schema auth→public FKs couple app
--     migrations to GoTrue internals and are intentionally avoided.
--   - NO backfill: this migration writes ZERO rows. Existing rows keep
--     auth_user_id IS NULL until a later, explicitly approved phase.
--   - NO RLS changes. NO tenant/company dimension. NO customer ID changes.
--
-- ARCHITECTURE:
--   Single company. NO tenant_id. NO organization_id. NO multi-tenancy.
-- ============================================================================


-- ============================================================================
-- 1. COLUMN (idempotent, additive, nullable, no default, no backfill)
-- ============================================================================

ALTER TABLE public.portal_users
    ADD COLUMN IF NOT EXISTS auth_user_id UUID;


-- ============================================================================
-- 2. UNIQUENESS (partial unique index = constraint + index in one object)
-- ============================================================================
--
-- Enforces "one auth.users user → at most one portal_users row" while
-- permitting unlimited NULL (unmapped legacy) rows. No separate plain index
-- is created: the unique index already serves auth_user_id lookups.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_portal_users_auth_user_id
    ON public.portal_users (auth_user_id)
    WHERE auth_user_id IS NOT NULL;


-- ============================================================================
-- 3. POST-MIGRATION VERIFICATION (READ-ONLY checks, modify nothing)
-- ============================================================================

DO $$
DECLARE
    v_col_exists BOOLEAN;
    v_col_nullable BOOLEAN;
    v_idx_exists BOOLEAN;
    v_fk_count INTEGER;
    v_mapped_count INTEGER;
BEGIN

    SELECT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'portal_users'
          AND column_name = 'auth_user_id'
    )
    INTO v_col_exists;

    IF NOT v_col_exists THEN
        RAISE EXCEPTION
            '0028 verification failed: portal_users.auth_user_id missing';
    END IF;


    SELECT (is_nullable = 'YES')
    INTO v_col_nullable
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'portal_users'
      AND column_name = 'auth_user_id';

    IF COALESCE(v_col_nullable, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION
            '0028 verification failed: portal_users.auth_user_id must be nullable';
    END IF;


    SELECT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'portal_users'
          AND indexname = 'uq_portal_users_auth_user_id'
    )
    INTO v_idx_exists;

    IF NOT v_idx_exists THEN
        RAISE EXCEPTION
            '0028 verification failed: uq_portal_users_auth_user_id missing';
    END IF;


    -- No FK to auth.users may exist (contract: mapping hygiene lives in the
    -- provisioning service, not in DDL).
    SELECT COUNT(*)
    INTO v_fk_count
    FROM information_schema.table_constraints
    WHERE table_schema = 'public'
      AND table_name = 'portal_users'
      AND constraint_type = 'FOREIGN KEY'
      AND constraint_name ILIKE '%auth_user_id%';

    IF v_fk_count <> 0 THEN
        RAISE EXCEPTION
            '0028 verification failed: unexpected FK on auth_user_id (%)',
            v_fk_count;
    END IF;


    -- Informational only: how many rows (if any) already carry a mapping.
    -- A fresh PHASE 1 run must report 0; the check never fails the migration.
    SELECT COUNT(*)
    INTO v_mapped_count
    FROM public.portal_users
    WHERE auth_user_id IS NOT NULL;

    RAISE NOTICE
        '0028 verification PASSED: column nullable, partial unique index present, no FK, mapped rows = %',
        v_mapped_count;

END $$;


-- ============================================================================
-- End of 0028
-- ============================================================================

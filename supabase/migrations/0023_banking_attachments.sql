-- ============================================================================
-- 0023_banking_attachments.sql
--
-- Missing table for the Banking → Attachments feature.
-- Frontend store `bankingAttachments` (db.ts:135, CLOUD_TABLE_MAP bankingAttachments
-- → banking_attachments) was queued via durableSyncQueue but had no Supabase
-- table and no allow-list entry, so every write dead-lettered.
--
-- This migration creates the cloud table with the standard Prime ERP envelope
-- (id / data JSONB / version / updated_at trigger), enables RLS with the
-- project's allow_all pattern (consistent with bank_* tables), and adds the
-- table to supabase_realtime.
-- ============================================================================

-- 1. TABLE
CREATE TABLE IF NOT EXISTS public.banking_attachments (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);

-- 2. INDEXES
CREATE INDEX IF NOT EXISTS idx_banking_attachments_updated
    ON public.banking_attachments (updated_at DESC);

-- Optional: account linkage if stored in data->>'bankAccountId' / data->>'accountId'
CREATE INDEX IF NOT EXISTS idx_banking_attachments_account
    ON public.banking_attachments ((data->>'bankAccountId'));
CREATE INDEX IF NOT EXISTS idx_banking_attachments_account_alt
    ON public.banking_attachments ((data->>'accountId'));

-- 3. UPDATED_AT TRIGGER
DROP TRIGGER IF EXISTS trg_banking_attachments_update_updated_at
    ON public.banking_attachments;

CREATE TRIGGER trg_banking_attachments_update_updated_at
    BEFORE UPDATE ON public.banking_attachments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 4. ROW LEVEL SECURITY (allow_all pattern — matches bank_* tables in 0001)
ALTER TABLE public.banking_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all_banking_attachments"
    ON public.banking_attachments;

CREATE POLICY "allow_all_banking_attachments"
    ON public.banking_attachments FOR ALL TO authenticated
    USING (true) WITH CHECK (true);

-- 5. REALTIME PUBLICATION
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        BEGIN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.banking_attachments;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END;
    END IF;
END $$;

-- 6. VERIFICATION
DO $$
DECLARE
    v_exists BOOLEAN;
    v_rls BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name='banking_attachments'
    ) INTO v_exists;
    IF NOT v_exists THEN
        RAISE EXCEPTION '0023 verification failed: banking_attachments table missing';
    END IF;

    SELECT c.relrowsecurity INTO v_rls
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname='banking_attachments';

    IF COALESCE(v_rls, FALSE) IS NOT TRUE THEN
        RAISE EXCEPTION '0023 verification failed: RLS not enabled on banking_attachments';
    END IF;

    RAISE NOTICE '0023 verification PASSED: banking_attachments ready';
END $$;

-- ============================================================================
-- 0024_fixed_assets_sync.sql
--
-- Fixed Assets — 13 IndexedDB stores were written locally (db.ts:620 STORE_NAMES
-- + CLOUD_TABLE_MAP) but had no Supabase tables and no allow-list entries, so
-- every write was queued then dead-lettered (table not allowed) and never
-- reached other devices.
--
-- Single-company app — NO tenant_id / company_id / organization_id column.
-- Same envelope as `assets` (0001:894): id TEXT PK, data JSONB, version,
-- created_at/updated_at with update_updated_at_column() trigger.
-- RLS: allow_all pattern consistent with 0001 bank_* / assets tables.
-- ============================================================================

-- Helper to create one fixed-asset envelope table
-- (inline for each of the 13 tables to keep migration idempotent and readable)

-- 1. fixed_assets (master registry)
CREATE TABLE IF NOT EXISTS public.fixed_assets (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_assets_updated ON public.fixed_assets (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_assets_update_updated_at ON public.fixed_assets;
CREATE TRIGGER trg_fixed_assets_update_updated_at BEFORE UPDATE ON public.fixed_assets
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_assets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_assets" ON public.fixed_assets;
CREATE POLICY "allow_all_fixed_assets" ON public.fixed_assets FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. depreciation_entries
CREATE TABLE IF NOT EXISTS public.depreciation_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_depreciation_entries_updated ON public.depreciation_entries (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_depreciation_entries_asset ON public.depreciation_entries ((data->>'assetId'));
DROP TRIGGER IF EXISTS trg_depreciation_entries_update_updated_at ON public.depreciation_entries;
CREATE TRIGGER trg_depreciation_entries_update_updated_at BEFORE UPDATE ON public.depreciation_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.depreciation_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_depreciation_entries" ON public.depreciation_entries;
CREATE POLICY "allow_all_depreciation_entries" ON public.depreciation_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. asset_disposals
CREATE TABLE IF NOT EXISTS public.asset_disposals (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asset_disposals_updated ON public.asset_disposals (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_disposals_asset ON public.asset_disposals ((data->>'assetId'));
DROP TRIGGER IF EXISTS trg_asset_disposals_update_updated_at ON public.asset_disposals;
CREATE TRIGGER trg_asset_disposals_update_updated_at BEFORE UPDATE ON public.asset_disposals
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.asset_disposals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_asset_disposals" ON public.asset_disposals;
CREATE POLICY "allow_all_asset_disposals" ON public.asset_disposals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4. fixed_asset_locations
CREATE TABLE IF NOT EXISTS public.fixed_asset_locations (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_locations_updated ON public.fixed_asset_locations (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_locations_update_updated_at ON public.fixed_asset_locations;
CREATE TRIGGER trg_fixed_asset_locations_update_updated_at BEFORE UPDATE ON public.fixed_asset_locations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_locations" ON public.fixed_asset_locations;
CREATE POLICY "allow_all_fixed_asset_locations" ON public.fixed_asset_locations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5. fixed_asset_custodians
CREATE TABLE IF NOT EXISTS public.fixed_asset_custodians (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_custodians_updated ON public.fixed_asset_custodians (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_custodians_update_updated_at ON public.fixed_asset_custodians;
CREATE TRIGGER trg_fixed_asset_custodians_update_updated_at BEFORE UPDATE ON public.fixed_asset_custodians
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_custodians ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_custodians" ON public.fixed_asset_custodians;
CREATE POLICY "allow_all_fixed_asset_custodians" ON public.fixed_asset_custodians FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 6. fixed_asset_transfers
CREATE TABLE IF NOT EXISTS public.fixed_asset_transfers (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_transfers_updated ON public.fixed_asset_transfers (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_transfers_asset ON public.fixed_asset_transfers ((data->>'assetId'));
DROP TRIGGER IF EXISTS trg_fixed_asset_transfers_update_updated_at ON public.fixed_asset_transfers;
CREATE TRIGGER trg_fixed_asset_transfers_update_updated_at BEFORE UPDATE ON public.fixed_asset_transfers
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_transfers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_transfers" ON public.fixed_asset_transfers;
CREATE POLICY "allow_all_fixed_asset_transfers" ON public.fixed_asset_transfers FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 7. fixed_asset_revaluations
CREATE TABLE IF NOT EXISTS public.fixed_asset_revaluations (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_revaluations_updated ON public.fixed_asset_revaluations (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_revaluations_update_updated_at ON public.fixed_asset_revaluations;
CREATE TRIGGER trg_fixed_asset_revaluations_update_updated_at BEFORE UPDATE ON public.fixed_asset_revaluations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_revaluations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_revaluations" ON public.fixed_asset_revaluations;
CREATE POLICY "allow_all_fixed_asset_revaluations" ON public.fixed_asset_revaluations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 8. fixed_asset_impairments
CREATE TABLE IF NOT EXISTS public.fixed_asset_impairments (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_impairments_updated ON public.fixed_asset_impairments (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_impairments_update_updated_at ON public.fixed_asset_impairments;
CREATE TRIGGER trg_fixed_asset_impairments_update_updated_at BEFORE UPDATE ON public.fixed_asset_impairments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_impairments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_impairments" ON public.fixed_asset_impairments;
CREATE POLICY "allow_all_fixed_asset_impairments" ON public.fixed_asset_impairments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 9. fixed_asset_maintenance
CREATE TABLE IF NOT EXISTS public.fixed_asset_maintenance (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_maintenance_updated ON public.fixed_asset_maintenance (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_maintenance_asset ON public.fixed_asset_maintenance ((data->>'assetId'));
DROP TRIGGER IF EXISTS trg_fixed_asset_maintenance_update_updated_at ON public.fixed_asset_maintenance;
CREATE TRIGGER trg_fixed_asset_maintenance_update_updated_at BEFORE UPDATE ON public.fixed_asset_maintenance
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_maintenance" ON public.fixed_asset_maintenance;
CREATE POLICY "allow_all_fixed_asset_maintenance" ON public.fixed_asset_maintenance FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 10. fixed_asset_warranty
CREATE TABLE IF NOT EXISTS public.fixed_asset_warranty (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_warranty_updated ON public.fixed_asset_warranty (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_warranty_update_updated_at ON public.fixed_asset_warranty;
CREATE TRIGGER trg_fixed_asset_warranty_update_updated_at BEFORE UPDATE ON public.fixed_asset_warranty
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_warranty ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_warranty" ON public.fixed_asset_warranty;
CREATE POLICY "allow_all_fixed_asset_warranty" ON public.fixed_asset_warranty FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 11. fixed_asset_insurance
CREATE TABLE IF NOT EXISTS public.fixed_asset_insurance (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_insurance_updated ON public.fixed_asset_insurance (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_insurance_update_updated_at ON public.fixed_asset_insurance;
CREATE TRIGGER trg_fixed_asset_insurance_update_updated_at BEFORE UPDATE ON public.fixed_asset_insurance
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_insurance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_insurance" ON public.fixed_asset_insurance;
CREATE POLICY "allow_all_fixed_asset_insurance" ON public.fixed_asset_insurance FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 12. fixed_asset_verification
CREATE TABLE IF NOT EXISTS public.fixed_asset_verification (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_verification_updated ON public.fixed_asset_verification (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_verification_update_updated_at ON public.fixed_asset_verification;
CREATE TRIGGER trg_fixed_asset_verification_update_updated_at BEFORE UPDATE ON public.fixed_asset_verification
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_verification ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_verification" ON public.fixed_asset_verification;
CREATE POLICY "allow_all_fixed_asset_verification" ON public.fixed_asset_verification FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 13. fixed_asset_reversals
CREATE TABLE IF NOT EXISTS public.fixed_asset_reversals (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_fixed_asset_reversals_updated ON public.fixed_asset_reversals (updated_at DESC);
DROP TRIGGER IF EXISTS trg_fixed_asset_reversals_update_updated_at ON public.fixed_asset_reversals;
CREATE TRIGGER trg_fixed_asset_reversals_update_updated_at BEFORE UPDATE ON public.fixed_asset_reversals
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.fixed_asset_reversals ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_fixed_asset_reversals" ON public.fixed_asset_reversals;
CREATE POLICY "allow_all_fixed_asset_reversals" ON public.fixed_asset_reversals FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- REALTIME
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY[
            'fixed_assets','depreciation_entries','asset_disposals',
            'fixed_asset_locations','fixed_asset_custodians','fixed_asset_transfers',
            'fixed_asset_revaluations','fixed_asset_impairments','fixed_asset_maintenance',
            'fixed_asset_warranty','fixed_asset_insurance','fixed_asset_verification','fixed_asset_reversals'
        ] LOOP
            BEGIN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            EXCEPTION WHEN duplicate_object THEN NULL;
            END;
        END LOOP;
    END IF;
END $$;

-- VERIFICATION
DO $$
DECLARE
    v_missing TEXT[] := '{}';
    t TEXT;
    v_exists BOOLEAN;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'fixed_assets','depreciation_entries','asset_disposals',
        'fixed_asset_locations','fixed_asset_custodians','fixed_asset_transfers',
        'fixed_asset_revaluations','fixed_asset_impairments','fixed_asset_maintenance',
        'fixed_asset_warranty','fixed_asset_insurance','fixed_asset_verification','fixed_asset_reversals'
    ] LOOP
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) INTO v_exists;
        IF NOT v_exists THEN
            v_missing := array_append(v_missing, t);
        END IF;
    END LOOP;
    IF array_length(v_missing,1) IS NOT NULL THEN
        RAISE EXCEPTION '0024 verification failed: missing tables %', array_to_string(v_missing, ', ');
    END IF;
    RAISE NOTICE '0024 verification PASSED: 13 fixed-asset tables ready (single-company, no tenant)';
END $$;

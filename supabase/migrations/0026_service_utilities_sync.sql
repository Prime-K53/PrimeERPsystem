-- ============================================================================
-- 0026_service_utilities_sync.sql
--
-- Service Catalog + Utilities sub-ledgers — 13 IndexedDB stores were written
-- locally (db.ts:569 STORE_NAMES, CLOUD_TABLE_MAP) but had no Supabase tables
-- and no allow-list entries, so every write dead-lettered.
--
-- Stores:
--   serviceRecipes, serviceJobs, serviceResources, serviceConsumptions (4)
--   purchaseInvoices, interestIncomeEntries, prepayments,
--   prepaymentAmortizations, staffAdvances, utilityExpenses, utilityPayments,
--   bankChargeEntries, payrollEntries (9)
--
-- Single-company app — NO tenant_id / company_id / organization_id column.
-- Same envelope as `assets` (0001:894) and 0023/0024/0025: id TEXT PK, data JSONB,
-- version, created_at/updated_at with update_updated_at_column() trigger.
-- RLS: allow_all pattern consistent with 0001.
-- ============================================================================

-- 1. purchase_invoices (vendor bill invoices — procurement)
CREATE TABLE IF NOT EXISTS public.purchase_invoices (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_purchase_invoices_updated ON public.purchase_invoices (updated_at DESC);
DROP TRIGGER IF EXISTS trg_purchase_invoices_update_updated_at ON public.purchase_invoices;
CREATE TRIGGER trg_purchase_invoices_update_updated_at BEFORE UPDATE ON public.purchase_invoices
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.purchase_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_purchase_invoices" ON public.purchase_invoices;
CREATE POLICY "allow_all_purchase_invoices" ON public.purchase_invoices FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. interest_income_entries
CREATE TABLE IF NOT EXISTS public.interest_income_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_interest_income_entries_updated ON public.interest_income_entries (updated_at DESC);
DROP TRIGGER IF EXISTS trg_interest_income_entries_update_updated_at ON public.interest_income_entries;
CREATE TRIGGER trg_interest_income_entries_update_updated_at BEFORE UPDATE ON public.interest_income_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.interest_income_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_interest_income_entries" ON public.interest_income_entries;
CREATE POLICY "allow_all_interest_income_entries" ON public.interest_income_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. prepayments
CREATE TABLE IF NOT EXISTS public.prepayments (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prepayments_updated ON public.prepayments (updated_at DESC);
DROP TRIGGER IF EXISTS trg_prepayments_update_updated_at ON public.prepayments;
CREATE TRIGGER trg_prepayments_update_updated_at BEFORE UPDATE ON public.prepayments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.prepayments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_prepayments" ON public.prepayments;
CREATE POLICY "allow_all_prepayments" ON public.prepayments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4. prepayment_amortizations
CREATE TABLE IF NOT EXISTS public.prepayment_amortizations (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_prepayment_amortizations_updated ON public.prepayment_amortizations (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_prepayment_amortizations_prepayment ON public.prepayment_amortizations ((data->>'prepaymentId'));
DROP TRIGGER IF EXISTS trg_prepayment_amortizations_update_updated_at ON public.prepayment_amortizations;
CREATE TRIGGER trg_prepayment_amortizations_update_updated_at BEFORE UPDATE ON public.prepayment_amortizations
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.prepayment_amortizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_prepayment_amortizations" ON public.prepayment_amortizations;
CREATE POLICY "allow_all_prepayment_amortizations" ON public.prepayment_amortizations FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5. staff_advances
CREATE TABLE IF NOT EXISTS public.staff_advances (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_staff_advances_updated ON public.staff_advances (updated_at DESC);
DROP TRIGGER IF EXISTS trg_staff_advances_update_updated_at ON public.staff_advances;
CREATE TRIGGER trg_staff_advances_update_updated_at BEFORE UPDATE ON public.staff_advances
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.staff_advances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_staff_advances" ON public.staff_advances;
CREATE POLICY "allow_all_staff_advances" ON public.staff_advances FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 6. utility_expenses
CREATE TABLE IF NOT EXISTS public.utility_expenses (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_utility_expenses_updated ON public.utility_expenses (updated_at DESC);
DROP TRIGGER IF EXISTS trg_utility_expenses_update_updated_at ON public.utility_expenses;
CREATE TRIGGER trg_utility_expenses_update_updated_at BEFORE UPDATE ON public.utility_expenses
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.utility_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_utility_expenses" ON public.utility_expenses;
CREATE POLICY "allow_all_utility_expenses" ON public.utility_expenses FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 7. utility_payments
CREATE TABLE IF NOT EXISTS public.utility_payments (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_utility_payments_updated ON public.utility_payments (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_utility_payments_expense ON public.utility_payments ((data->>'utilityExpenseId'));
DROP TRIGGER IF EXISTS trg_utility_payments_update_updated_at ON public.utility_payments;
CREATE TRIGGER trg_utility_payments_update_updated_at BEFORE UPDATE ON public.utility_payments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.utility_payments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_utility_payments" ON public.utility_payments;
CREATE POLICY "allow_all_utility_payments" ON public.utility_payments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 8. bank_charge_entries
CREATE TABLE IF NOT EXISTS public.bank_charge_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bank_charge_entries_updated ON public.bank_charge_entries (updated_at DESC);
DROP TRIGGER IF EXISTS trg_bank_charge_entries_update_updated_at ON public.bank_charge_entries;
CREATE TRIGGER trg_bank_charge_entries_update_updated_at BEFORE UPDATE ON public.bank_charge_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.bank_charge_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_bank_charge_entries" ON public.bank_charge_entries;
CREATE POLICY "allow_all_bank_charge_entries" ON public.bank_charge_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 9. payroll_entries
CREATE TABLE IF NOT EXISTS public.payroll_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_payroll_entries_updated ON public.payroll_entries (updated_at DESC);
DROP TRIGGER IF EXISTS trg_payroll_entries_update_updated_at ON public.payroll_entries;
CREATE TRIGGER trg_payroll_entries_update_updated_at BEFORE UPDATE ON public.payroll_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.payroll_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_payroll_entries" ON public.payroll_entries;
CREATE POLICY "allow_all_payroll_entries" ON public.payroll_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 10. service_recipes
CREATE TABLE IF NOT EXISTS public.service_recipes (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_recipes_updated ON public.service_recipes (updated_at DESC);
DROP TRIGGER IF EXISTS trg_service_recipes_update_updated_at ON public.service_recipes;
CREATE TRIGGER trg_service_recipes_update_updated_at BEFORE UPDATE ON public.service_recipes
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.service_recipes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_service_recipes" ON public.service_recipes;
CREATE POLICY "allow_all_service_recipes" ON public.service_recipes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 11. service_jobs
CREATE TABLE IF NOT EXISTS public.service_jobs (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_jobs_updated ON public.service_jobs (updated_at DESC);
DROP TRIGGER IF EXISTS trg_service_jobs_update_updated_at ON public.service_jobs;
CREATE TRIGGER trg_service_jobs_update_updated_at BEFORE UPDATE ON public.service_jobs
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.service_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_service_jobs" ON public.service_jobs;
CREATE POLICY "allow_all_service_jobs" ON public.service_jobs FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 12. service_resources
CREATE TABLE IF NOT EXISTS public.service_resources (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_resources_updated ON public.service_resources (updated_at DESC);
DROP TRIGGER IF EXISTS trg_service_resources_update_updated_at ON public.service_resources;
CREATE TRIGGER trg_service_resources_update_updated_at BEFORE UPDATE ON public.service_resources
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.service_resources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_service_resources" ON public.service_resources;
CREATE POLICY "allow_all_service_resources" ON public.service_resources FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 13. service_consumptions
CREATE TABLE IF NOT EXISTS public.service_consumptions (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_service_consumptions_updated ON public.service_consumptions (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_consumptions_job ON public.service_consumptions ((data->>'serviceJobId'));
DROP TRIGGER IF EXISTS trg_service_consumptions_update_updated_at ON public.service_consumptions;
CREATE TRIGGER trg_service_consumptions_update_updated_at BEFORE UPDATE ON public.service_consumptions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.service_consumptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_service_consumptions" ON public.service_consumptions;
CREATE POLICY "allow_all_service_consumptions" ON public.service_consumptions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- REALTIME
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY[
            'purchase_invoices','interest_income_entries','prepayments','prepayment_amortizations',
            'staff_advances','utility_expenses','utility_payments','bank_charge_entries','payroll_entries',
            'service_recipes','service_jobs','service_resources','service_consumptions'
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
        'purchase_invoices','interest_income_entries','prepayments','prepayment_amortizations',
        'staff_advances','utility_expenses','utility_payments','bank_charge_entries','payroll_entries',
        'service_recipes','service_jobs','service_resources','service_consumptions'
    ] LOOP
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) INTO v_exists;
        IF NOT v_exists THEN
            v_missing := array_append(v_missing, t);
        END IF;
    END LOOP;
    IF array_length(v_missing,1) IS NOT NULL THEN
        RAISE EXCEPTION '0026 verification failed: missing tables %', array_to_string(v_missing, ', ');
    END IF;
    RAISE NOTICE '0026 verification PASSED: 13 service/utilities tables ready (single-company, no tenant)';
END $$;

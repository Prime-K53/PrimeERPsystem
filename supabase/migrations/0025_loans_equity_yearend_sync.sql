-- ============================================================================
-- 0025_loans_equity_yearend_sync.sql
--
-- Loans / Owner Equity / Year-End closing — 5 IndexedDB stores were written
-- locally (db.ts:649 STORE_NAMES, CLOUD_TABLE_MAP) but had no Supabase tables
-- and no allow-list entries, so every write dead-lettered.
--
-- Single-company app — NO tenant_id / company_id / organization_id column.
-- Same envelope as `assets` (0001:894) and 0023/0024: id TEXT PK, data JSONB,
-- version, created_at/updated_at with update_updated_at_column() trigger.
-- RLS: allow_all pattern (consistent with 0001 bank_* / assets).
-- ============================================================================

-- 1. loans (master loan registry — Accounts → Loans)
CREATE TABLE IF NOT EXISTS public.loans (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_loans_updated ON public.loans (updated_at DESC);
DROP TRIGGER IF EXISTS trg_loans_update_updated_at ON public.loans;
CREATE TRIGGER trg_loans_update_updated_at BEFORE UPDATE ON public.loans
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.loans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_loans" ON public.loans;
CREATE POLICY "allow_all_loans" ON public.loans FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 2. loan_repayments (repayment schedule — child of loans)
CREATE TABLE IF NOT EXISTS public.loan_repayments (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_updated ON public.loan_repayments (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_loan_repayments_loan ON public.loan_repayments ((data->>'loanId'));
DROP TRIGGER IF EXISTS trg_loan_repayments_update_updated_at ON public.loan_repayments;
CREATE TRIGGER trg_loan_repayments_update_updated_at BEFORE UPDATE ON public.loan_repayments
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.loan_repayments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_loan_repayments" ON public.loan_repayments;
CREATE POLICY "allow_all_loan_repayments" ON public.loan_repayments FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 3. owner_equity_transactions (Owner Equity — capital / drawings)
CREATE TABLE IF NOT EXISTS public.owner_equity_transactions (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_owner_equity_transactions_updated ON public.owner_equity_transactions (updated_at DESC);
DROP TRIGGER IF EXISTS trg_owner_equity_transactions_update_updated_at ON public.owner_equity_transactions;
CREATE TRIGGER trg_owner_equity_transactions_update_updated_at BEFORE UPDATE ON public.owner_equity_transactions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.owner_equity_transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_owner_equity_transactions" ON public.owner_equity_transactions;
CREATE POLICY "allow_all_owner_equity_transactions" ON public.owner_equity_transactions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 4. accrual_entries (Year-End → Accruals)
CREATE TABLE IF NOT EXISTS public.accrual_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_accrual_entries_updated ON public.accrual_entries (updated_at DESC);
DROP TRIGGER IF EXISTS trg_accrual_entries_update_updated_at ON public.accrual_entries;
CREATE TRIGGER trg_accrual_entries_update_updated_at BEFORE UPDATE ON public.accrual_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.accrual_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_accrual_entries" ON public.accrual_entries;
CREATE POLICY "allow_all_accrual_entries" ON public.accrual_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- 5. income_summary_entries (Year-End → Income Summary)
CREATE TABLE IF NOT EXISTS public.income_summary_entries (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_income_summary_entries_updated ON public.income_summary_entries (updated_at DESC);
DROP TRIGGER IF EXISTS trg_income_summary_entries_update_updated_at ON public.income_summary_entries;
CREATE TRIGGER trg_income_summary_entries_update_updated_at BEFORE UPDATE ON public.income_summary_entries
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
ALTER TABLE public.income_summary_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_income_summary_entries" ON public.income_summary_entries;
CREATE POLICY "allow_all_income_summary_entries" ON public.income_summary_entries FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- REALTIME
DO $$
DECLARE t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['loans','loan_repayments','owner_equity_transactions','accrual_entries','income_summary_entries'] LOOP
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
    FOREACH t IN ARRAY ARRAY['loans','loan_repayments','owner_equity_transactions','accrual_entries','income_summary_entries'] LOOP
        SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=t) INTO v_exists;
        IF NOT v_exists THEN
            v_missing := array_append(v_missing, t);
        END IF;
    END LOOP;
    IF array_length(v_missing,1) IS NOT NULL THEN
        RAISE EXCEPTION '0025 verification failed: missing tables %', array_to_string(v_missing, ', ');
    END IF;
    RAISE NOTICE '0025 verification PASSED: 5 loans/equity/year-end tables ready (single-company, no tenant)';
END $$;

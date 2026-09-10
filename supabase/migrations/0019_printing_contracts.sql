-- ============================================================
-- 0019_printing_contracts.sql
--
-- Prime ERP Phase 3: Printing Contracts Integration
-- Integrates existing assessment_contracts tables into the
-- frontend, sync gateway, and application layer.
--
-- Changes:
-- 1. Add job_order_id and examination_printing_batch_id to
--    assessment_contract_items
-- 2. Add contract_assessment_id to job_orders
-- 3. Add indexes for new columns
-- 4. Ensure RLS policies exist for new columns
--
-- NOTE: assessment_contracts, assessment_contract_items, and
-- contract_amendments tables already exist from migration 0006.
-- This migration only adds columns and indexes.
-- ============================================================

BEGIN;

-- ─── Add job_order_id to assessment_contract_items ────────────────────
ALTER TABLE IF EXISTS public.assessment_contract_items ADD COLUMN IF NOT EXISTS job_order_id TEXT;
ALTER TABLE IF EXISTS public.assessment_contract_items ADD COLUMN IF NOT EXISTS examination_printing_batch_id TEXT;

-- ─── Add contract_assessment_id to job_orders ─────────────────────────
ALTER TABLE IF EXISTS public.job_orders ADD COLUMN IF NOT EXISTS contract_assessment_id TEXT;

-- ─── Indexes ──────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ac_items_job_order ON public.assessment_contract_items (job_order_id);
CREATE INDEX IF NOT EXISTS idx_ac_items_exam_batch ON public.assessment_contract_items (examination_printing_batch_id);
CREATE INDEX IF NOT EXISTS idx_job_orders_contract_assessment ON public.job_orders (contract_assessment_id);

-- ─── Foreign Key Constraints (optional, for referential integrity) ─────
ALTER TABLE IF EXISTS public.assessment_contract_items
    ADD CONSTRAINT fk_ac_items_job_order
    FOREIGN KEY (job_order_id) REFERENCES public.job_orders(id)
    ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.assessment_contract_items
    ADD CONSTRAINT fk_ac_items_exam_batch
    FOREIGN KEY (examination_printing_batch_id) REFERENCES public.examination_printing_batches(id)
    ON DELETE SET NULL;

ALTER TABLE IF EXISTS public.job_orders
    ADD CONSTRAINT fk_job_orders_contract_assessment
    FOREIGN KEY (contract_assessment_id) REFERENCES public.assessment_contract_items(id)
    ON DELETE SET NULL;

-- ─── Updated_at Trigger for assessment_contract_items ─────────────────
DROP TRIGGER IF EXISTS trg_update_updated_at_assessment_contract_items ON public.assessment_contract_items;
CREATE TRIGGER trg_update_updated_at_assessment_contract_items
    BEFORE UPDATE ON public.assessment_contract_items
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMIT;

-- ============================================================
-- RLS Policies (verify existing policies cover new columns)
-- Existing policies from 0006_assessment_contracts.sql use
-- company_id = public.get_current_company_id() which already
-- covers all rows including the new columns.
-- ============================================================

-- Verify RLS is enabled on all contract tables
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'assessment_contracts' AND rls_enabled = true
    ) THEN
        ALTER TABLE public.assessment_contracts ENABLE ROW LEVEL SECURITY;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'assessment_contract_items' AND rls_enabled = true
    ) THEN
        ALTER TABLE public.assessment_contract_items ENABLE ROW LEVEL SECURITY;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'contract_amendments' AND rls_enabled = true
    ) THEN
        ALTER TABLE public.contract_amendments ENABLE ROW LEVEL SECURITY;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = 'job_orders' AND rls_enabled = true
    ) THEN
        ALTER TABLE public.job_orders ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;

-- Ensure tenant isolation policies exist for job_orders (harden from permissive)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies WHERE tablename = 'job_orders' AND policyname = 'tenant_isolation_policy'
    ) THEN
        CREATE POLICY "tenant_isolation_policy"
            ON public.job_orders AS RESTRICTIVE FOR ALL
            TO authenticated
            USING (company_id = public.get_user_company_id())
            WITH CHECK (company_id = public.get_user_company_id());
    END IF;
END $$;

-- ============================================================================
-- 0014_coa_new_columns.sql — CORRECTED VERSION
--
-- Prime ERP — Chart of Accounts Top-Level Columns + Safe Backfill
--
-- This migration:
-- 1. Adds the missing top-level columns to chart_of_accounts
-- 2. Backfills them from the existing JSONB `data` column
-- 3. Handles BOTH legacy format (code/type) and new format
--    (account_number/account_type)
-- 4. Preserves all 65 canonical COA accounts
-- 5. Preserves all 60 parent-child relationships (which already use
--    canonical account UUIDs in the new accounts)
-- 6. Preserves legacy accounts for historical reporting (company_id=NULL)
-- 7. Does NOT touch ledger_entries or any other table
-- 8. Does NOT introduce multi-tenant architecture
-- 9. Is idempotent (safe to re-run)
-- ============================================================================

-- ============================================================================
-- STEP 1: Add top-level columns (idempotent)
-- ============================================================================

-- company_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'company_id'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN company_id TEXT;
  END IF;
END $$;

-- account_number
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'account_number'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN account_number TEXT;
  END IF;
END $$;

-- account_type
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'account_type'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN account_type TEXT
      CHECK (account_type IN ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'));
  END IF;
END $$;

-- account_group
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'account_group'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN account_group TEXT;
  END IF;
END $$;

-- parent_account_id
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'parent_account_id'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN parent_account_id TEXT
      REFERENCES public.chart_of_accounts(id);
  END IF;
END $$;

-- normal_balance
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'normal_balance'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN normal_balance TEXT
      CHECK (normal_balance IN ('DEBIT', 'CREDIT'));
  END IF;
END $$;

-- is_system_account
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'is_system_account'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN is_system_account BOOLEAN DEFAULT FALSE;
  END IF;
END $$;

-- allow_posting
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'allow_posting'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN allow_posting BOOLEAN DEFAULT TRUE;
  END IF;
END $$;

-- opening_balance
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'opening_balance'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN opening_balance NUMERIC(20,4) DEFAULT 0;
  END IF;
END $$;

-- opening_balance_date
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'opening_balance_date'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN opening_balance_date TIMESTAMPTZ;
  END IF;
END $$;

-- subtype
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'subtype'
    AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.chart_of_accounts ADD COLUMN subtype TEXT;
  END IF;
END $$;

-- ============================================================================
-- STEP 2: Create indexes (idempotent)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_parent
  ON public.chart_of_accounts(parent_account_id);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_type
  ON public.chart_of_accounts(account_type);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_number
  ON public.chart_of_accounts(account_number);

CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_company
  ON public.chart_of_accounts(company_id);

-- ============================================================================
-- STEP 3: Backfill from JSONB data column
--
-- Handles BOTH formats:
--   FORMAT A (new): data.account_number, data.account_type, etc.
--   FORMAT B (legacy): data.code, data.type (lowercase), etc.
--
-- For legacy accounts where a field is missing, use safe defaults.
-- Legacy accounts with NULL company_id are preserved as-is.
-- ============================================================================

-- company_id: from data.company_id (NULL for legacy = preserved)
UPDATE public.chart_of_accounts
SET company_id = data->>'company_id'
WHERE company_id IS NULL
  AND data->>'company_id' IS NOT NULL;

-- account_number: prefer data.account_number, fallback to data.code
UPDATE public.chart_of_accounts
SET account_number = COALESCE(
  NULLIF(data->>'account_number', ''),
  NULLIF(data->>'code', '')
)
WHERE account_number IS NULL;

-- account_type: prefer data.account_type, fallback to UPPER(data.type)
-- Map legacy 'revenue' to 'INCOME'
UPDATE public.chart_of_accounts
SET account_type = CASE
  WHEN data->>'account_type' IS NOT NULL THEN data->>'account_type'
  WHEN LOWER(data->>'type') = 'revenue' THEN 'INCOME'
  ELSE UPPER(data->>'type')
END
WHERE account_type IS NULL
  AND (
    data->>'account_type' IS NOT NULL
    OR data->>'type' IS NOT NULL
  );

-- account_group: from data.account_group, no legacy mapping
UPDATE public.chart_of_accounts
SET account_group = data->>'account_group'
WHERE account_group IS NULL
  AND data->>'account_group' IS NOT NULL;

-- parent_account_id: from data.parent_account_id
-- NOTE: Legacy accounts use data.parent_id, but we confirmed no legacy
-- accounts have non-NULL parent_id. Legacy parent_account_id stays NULL.
UPDATE public.chart_of_accounts
SET parent_account_id = data->>'parent_account_id'
WHERE parent_account_id IS NULL
  AND data->>'parent_account_id' IS NOT NULL;

-- normal_balance: prefer data.normal_balance, fallback to derived from type
UPDATE public.chart_of_accounts
SET normal_balance = COALESCE(
  data->>'normal_balance',
  CASE account_type
    WHEN 'ASSET' THEN 'DEBIT'
    WHEN 'EXPENSE' THEN 'DEBIT'
    WHEN 'LIABILITY' THEN 'CREDIT'
    WHEN 'EQUITY' THEN 'CREDIT'
    WHEN 'INCOME' THEN 'CREDIT'
    ELSE 'DEBIT'
  END
)
WHERE normal_balance IS NULL;

-- is_system_account: from data.is_system_account (0/1 → false/true)
UPDATE public.chart_of_accounts
SET is_system_account = CASE
  WHEN (data->>'is_system_account')::int = 1 THEN TRUE
  ELSE FALSE
END
WHERE is_system_account IS NULL;

-- allow_posting: from data.allow_posting (0/1 → false/true), default TRUE
UPDATE public.chart_of_accounts
SET allow_posting = CASE
  WHEN data->>'allow_posting' IS NULL THEN TRUE
  WHEN (data->>'allow_posting')::int = 1 THEN TRUE
  ELSE FALSE
END
WHERE allow_posting IS NULL;

-- opening_balance: from data.opening_balance
UPDATE public.chart_of_accounts
SET opening_balance = COALESCE(
  (data->>'opening_balance')::numeric,
  0
)
WHERE opening_balance IS NULL;

-- opening_balance_date: from data.opening_balance_date
UPDATE public.chart_of_accounts
SET opening_balance_date = (data->>'opening_balance_date')::timestamptz
WHERE opening_balance_date IS NULL
  AND data->>'opening_balance_date' IS NOT NULL;

-- subtype: from data.subtype
UPDATE public.chart_of_accounts
SET subtype = data->>'subtype'
WHERE subtype IS NULL
  AND data->>'subtype' IS NOT NULL;

-- ============================================================================
-- STEP 4: NOT NULL constraints (optional, conservative)
-- We do NOT add NOT NULL constraints because:
-- 1. Legacy accounts legitimately have NULL fields
-- 2. The application should handle NULL gracefully
-- 3. Adding NOT NULL would break legacy account queries
-- ============================================================================

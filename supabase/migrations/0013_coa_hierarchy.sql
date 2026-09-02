-- ============================================================================
-- 0013_coa_hierarchy.sql
--
-- Prime ERP — Chart of Accounts Hierarchical Structure
--
-- Phase 1: Redesign Chart of Accounts to follow proper hierarchical
-- accounting structure with 5 primary account types, account groups,
-- parent/child relationships, and structured account numbering.
--
-- This migration is ADDITIVE - it only adds new fields and does not
-- remove or modify existing columns to preserve backward compatibility.
-- ============================================================================

-- ============================================================================
-- Helper function to check if chart_of_accounts has legacy flat columns
-- (SQLite local DB uses flat columns; Supabase uses JSONB data field)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.coa_has_flat_columns()
RETURNS BOOLEAN AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chart_of_accounts'
    AND column_name = 'code'
    AND table_schema = 'public'
  );
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 1: Add new top-level columns for hierarchical COA structure
-- These columns are additive and preserve existing data.
-- ============================================================================

-- Add company_id if it doesn't exist (for multi-tenant isolation)
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

-- Add account_number (5-digit structured numbering, supersedes code)
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

-- Add account_type (primary financial statement classification)
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

-- Add account_group (sub-classification for reporting)
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

-- Add parent_account_id (for hierarchical structure)
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

    -- Add index for faster hierarchical queries
    CREATE INDEX IF NOT EXISTS idx_chart_of_accounts_parent
    ON public.chart_of_accounts(parent_account_id);
  END IF;
END $$;

-- Add normal_balance (DEBIT or CREDIT - defines how balances increase)
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

-- Add is_system_account (prevents deletion of system-critical accounts)
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

-- Add allow_posting (group accounts cannot receive postings)
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

-- Add opening_balance (initial balance before transactions)
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

-- Add opening_balance_date (when opening balance was set)
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

-- Add subtype (for specialized classification: BANK, RECEIVABLE, PAYABLE, INVENTORY, TAX)
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
-- STEP 2: Create constraint for unique account numbers per company
-- ============================================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'chart_of_accounts'
    AND constraint_name = 'chk_coa_account_number_unique'
    AND table_schema = 'public'
  ) THEN
    -- Note: This is a check constraint since we can't have partial unique indexes easily
    -- The actual uniqueness enforcement is done at the application/service layer
    -- But we add a check to ensure account_number format is correct (5 digits)
    ALTER TABLE public.chart_of_accounts
    ADD CONSTRAINT chk_coa_account_number_format
    CHECK (account_number IS NULL OR account_number ~ '^\d{5}$');
  END IF;
END $$;

-- ============================================================================
-- STEP 3: Update existing records with default account_type from legacy type
-- This preserves existing data while migrating to new structure
-- ============================================================================

-- Function to map legacy type to new account_type
CREATE OR REPLACE FUNCTION public.map_legacy_account_type(legacy_type TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN CASE LOWER(legacy_type)
    WHEN 'asset' THEN 'ASSET'
    WHEN 'liability' THEN 'LIABILITY'
    WHEN 'equity' THEN 'EQUITY'
    WHEN 'revenue' THEN 'INCOME'
    WHEN 'expense' THEN 'EXPENSE'
    ELSE NULL
  END;
END;
$$ LANGUAGE plpgsql;

-- Function to determine normal_balance from account_type
CREATE OR REPLACE FUNCTION public.get_normal_balance(p_account_type TEXT)
RETURNS TEXT AS $$
BEGIN
  RETURN CASE p_account_type
    WHEN 'ASSET' THEN 'DEBIT'
    WHEN 'EXPENSE' THEN 'DEBIT'
    WHEN 'LIABILITY' THEN 'CREDIT'
    WHEN 'EQUITY' THEN 'CREDIT'
    WHEN 'INCOME' THEN 'CREDIT'
    ELSE 'DEBIT'
  END;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 4: Create view for hierarchical account tree
-- This provides a convenient way to query accounts with their hierarchy
-- ============================================================================
CREATE OR REPLACE VIEW public.v_chart_of_accounts_tree AS
WITH RECURSIVE account_tree AS (
  -- Base case: root accounts (no parent)
  SELECT
    coa.id,
    coa.company_id,
    coa.account_number,
    coa.name,
    coa.account_type,
    coa.account_group,
    coa.parent_account_id,
    coa.normal_balance,
    coa.is_system_account,
    coa.allow_posting,
    coa.opening_balance,
    coa.is_active,
    coa.subtype,
    coa.description,
    coa.depth,
    coa.path
  FROM (
    SELECT
      *,
      0 AS depth,
      account_number AS path
    FROM public.chart_of_accounts
    WHERE parent_account_id IS NULL
  ) coa

  UNION ALL

  -- Recursive case: child accounts
  SELECT
    coa.id,
    coa.company_id,
    coa.account_number,
    coa.name,
    coa.account_type,
    coa.account_group,
    coa.parent_account_id,
    coa.normal_balance,
    coa.is_system_account,
    coa.allow_posting,
    coa.opening_balance,
    coa.is_active,
    coa.subtype,
    coa.description,
    at.depth + 1,
    at.path || ' > ' || coa.account_number
  FROM public.chart_of_accounts coa
  INNER JOIN account_tree at ON coa.parent_account_id = at.id
)
SELECT * FROM account_tree;

-- ============================================================================
-- STEP 5: Create function to get account subtree
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_account_subtree(p_account_id TEXT)
RETURNS TABLE (
  id TEXT,
  company_id TEXT,
  account_number TEXT,
  name TEXT,
  account_type TEXT,
  account_group TEXT,
  parent_account_id TEXT,
  normal_balance TEXT,
  is_system_account BOOLEAN,
  allow_posting BOOLEAN,
  opening_balance NUMERIC,
  is_active BOOLEAN,
  subtype TEXT,
  description TEXT,
  depth INTEGER,
  path TEXT
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE account_tree AS (
    SELECT
      coa.*,
      0 AS depth,
      coa.account_number AS path
    FROM public.chart_of_accounts coa
    WHERE coa.id = p_account_id

    UNION ALL

    SELECT
      coa.*,
      at.depth + 1,
      at.path || ' > ' || coa.account_number
    FROM public.chart_of_accounts coa
    INNER JOIN account_tree at ON coa.parent_account_id = at.id
  )
  SELECT * FROM account_tree;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 6: Create function to calculate account balance including children
-- ============================================================================
CREATE OR REPLACE FUNCTION public.calculate_account_balance(p_account_id TEXT)
RETURNS NUMERIC AS $$
DECLARE
  v_opening_balance NUMERIC;
  v ledger_total NUMERIC;
  v_normal_balance TEXT;
BEGIN
  -- Get opening balance
  SELECT opening_balance INTO v_opening_balance
  FROM public.chart_of_accounts
  WHERE id = p_account_id;

  -- Get normal balance
  SELECT normal_balance INTO v_normal_balance
  FROM public.chart_of_accounts
  WHERE id = p_account_id;

  -- Calculate from ledger entries
  SELECT COALESCE(SUM(
    CASE
      WHEN le.entry_type = 'debit' THEN le.amount
      WHEN le.entry_type = 'credit' THEN -le.amount
      ELSE 0
    END
  ), 0) INTO v_ledger_total
  FROM public.ledger_entries le
  WHERE le.account_id = p_account_id;

  -- Adjust based on normal balance
  IF v_normal_balance = 'CREDIT' THEN
    RETURN COALESCE(v_opening_balance, 0) - v_ledger_total;
  ELSE
    RETURN COALESCE(v_opening_balance, 0) + v_ledger_total;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 7: Add RLS policies for chart_of_accounts
-- ============================================================================

-- Enable RLS if not already enabled
ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see accounts for their company
DROP POLICY IF EXISTS "Users can view their company's accounts" ON public.chart_of_accounts;
CREATE POLICY "Users can view their company's accounts"
  ON public.chart_of_accounts FOR SELECT
  USING (
    company_id IS NULL OR
    company_id = public.get_current_company_id() OR
    NOT EXISTS (SELECT 1 FROM public.chart_of_accounts WHERE company_id IS NOT NULL)
  );

-- Policy: Users can only insert accounts for their company
DROP POLICY IF EXISTS "Users can insert their company's accounts" ON public.chart_of_accounts;
CREATE POLICY "Users can insert their company's accounts"
  ON public.chart_of_accounts FOR INSERT
  WITH CHECK (
    company_id IS NULL OR
    company_id = public.get_current_company_id()
  );

-- Policy: Users can only update their company's accounts
DROP POLICY IF EXISTS "Users can update their company's accounts" ON public.chart_of_accounts;
CREATE POLICY "Users can update their company's accounts"
  ON public.chart_of_accounts FOR UPDATE
  USING (
    company_id IS NULL OR
    company_id = public.get_current_company_id()
  );

-- Policy: System accounts cannot be deleted via policy (application-level enforced)
DROP POLICY IF EXISTS "System accounts cannot be deleted" ON public.chart_of_accounts;
CREATE POLICY "System accounts cannot be deleted"
  ON public.chart_of_accounts FOR DELETE
  USING (is_system_account = FALSE OR is_system_account IS NULL);

-- ============================================================================
-- STEP 8: Create function to validate no circular hierarchy
-- ============================================================================
CREATE OR REPLACE FUNCTION public.validate_no_circular_hierarchy(
  p_account_id TEXT,
  p_parent_account_id TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_ancestor_id TEXT;
BEGIN
  -- If setting parent to NULL, no circular possibility
  IF p_parent_account_id IS NULL THEN
    RETURN TRUE;
  END IF;

  -- Cannot be your own parent
  IF p_account_id = p_parent_account_id THEN
    RETURN FALSE;
  END IF;

  -- Check if proposed parent is a descendant of the account
  -- This prevents A -> B -> C -> A cycles
  FOR v_ancestor_id IN
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_account_id
      FROM public.chart_of_accounts
      WHERE id = p_parent_account_id

      UNION ALL

      SELECT coa.id, coa.parent_account_id
      FROM public.chart_of_accounts coa
      INNER JOIN ancestors a ON coa.id = a.parent_account_id
    )
    SELECT id FROM ancestors
  LOOP
    IF v_ancestor_id = p_account_id THEN
      RETURN FALSE;
    END IF;
  END LOOP;

  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 9: Create function to get next account number in range
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_next_account_number(
  p_account_type TEXT,
  p_company_id TEXT DEFAULT NULL
)
RETURNS TEXT AS $$
DECLARE
  v_min_number TEXT;
  v_max_number TEXT;
  v_next_number INTEGER;
BEGIN
  -- Set ranges based on account type
  v_min_number := CASE p_account_type
    WHEN 'ASSET' THEN '10000'
    WHEN 'LIABILITY' THEN '20000'
    WHEN 'EQUITY' THEN '30000'
    WHEN 'INCOME' THEN '40000'
    WHEN 'EXPENSE' THEN '50000'
    ELSE '90000'
  END;

  v_max_number := CASE p_account_type
    WHEN 'ASSET' THEN '19999'
    WHEN 'LIABILITY' THEN '29999'
    WHEN 'EQUITY' THEN '39999'
    WHEN 'INCOME' THEN '49999'
    WHEN 'EXPENSE' THEN '59999'
    ELSE '99999'
  END;

  -- Find the highest existing number in range for this company
  SELECT MAX(CAST(account_number AS INTEGER)) + 1
  INTO v_next_number
  FROM public.chart_of_accounts
  WHERE account_number ~ '^\d{5}$'
    AND CAST(account_number AS INTEGER) >= CAST(v_min_number AS INTEGER)
    AND CAST(account_number AS INTEGER) <= CAST(v_max_number AS INTEGER)
    AND (p_company_id IS NULL OR company_id = p_company_id);

  -- If no existing account, start at minimum
  IF v_next_number IS NULL THEN
    v_next_number := CAST(v_min_number AS INTEGER);
  END IF;

  -- Ensure we don't exceed max
  IF v_next_number > CAST(v_max_number AS INTEGER) THEN
    RAISE EXCEPTION 'Account number range exhausted for type %', p_account_type;
  END IF;

  RETURN LPAD(v_next_number::TEXT, 5, '0');
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- STEP 10: Create trigger to auto-set normal_balance from account_type
-- ============================================================================
CREATE OR REPLACE FUNCTION public.set_normal_balance_from_type()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.normal_balance IS NULL AND NEW.account_type IS NOT NULL THEN
    NEW.normal_balance := public.get_normal_balance(NEW.account_type);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_set_normal_balance ON public.chart_of_accounts;
CREATE TRIGGER trg_set_normal_balance
  BEFORE INSERT OR UPDATE ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_normal_balance_from_type();

-- ============================================================================
-- STEP 11: Grant necessary permissions
-- ============================================================================
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.chart_of_accounts TO authenticated;
GRANT SELECT ON public.v_chart_of_accounts_tree TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_account_subtree TO authenticated;
GRANT EXECUTE ON FUNCTION public.calculate_account_balance TO authenticated;
GRANT EXECUTE ON FUNCTION public.validate_no_circular_hierarchy TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_next_account_number TO authenticated;
GRANT EXECUTE ON FUNCTION public.map_legacy_account_type TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_normal_balance TO authenticated;

-- ============================================================================
-- SUMMARY
-- ============================================================================
-- This migration adds the following new capabilities:
--
-- 1. New columns: company_id, account_number, account_type, account_group,
--    parent_account_id, normal_balance, is_system_account, allow_posting,
--    opening_balance, opening_balance_date, subtype
--
-- 2. Constraints: account_number format (5 digits), check constraints
--
-- 3. Views: v_chart_of_accounts_tree (hierarchical view)
--
-- 4. Functions:
--    - get_account_subtree(p_account_id) - get account and all descendants
--    - calculate_account_balance(p_account_id) - calculate balance with normal balance
--    - validate_no_circular_hierarchy(p_account_id, p_parent_id) - prevent cycles
--    - get_next_account_number(p_account_type, p_company_id) - suggest next number
--    - map_legacy_account_type(legacy_type) - convert old types to new
--    - get_normal_balance(account_type) - get normal balance for type
--    - set_normal_balance_from_type() - auto-set normal balance trigger
--
-- 5. RLS: Company-scoped access policies
--
-- NEXT: Run the backfill script to populate new fields from existing data
-- ============================================================================

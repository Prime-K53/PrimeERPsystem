-- ============================================================================
-- POST-MIGRATION VERIFICATION: chart_of_accounts Top-Level Columns
-- Run this AFTER applying migration 0014 to verify correctness
-- ============================================================================

-- 1. Verify all expected columns exist
SELECT
  column_name,
  data_type,
  is_nullable
FROM information_schema.columns
WHERE table_name = 'chart_of_accounts'
  AND table_schema = 'public'
  AND column_name IN (
    'company_id', 'account_number', 'account_type', 'account_group',
    'parent_account_id', 'normal_balance', 'is_system_account',
    'allow_posting', 'opening_balance', 'opening_balance_date', 'subtype'
  )
ORDER BY column_name;

-- Expected: 11 rows (all canonical columns present)

-- 2. Total accounts preserved (should match pre-flight count)
SELECT COUNT(*) AS total_accounts FROM public.chart_of_accounts;

-- 3. Accounts with account_number populated
SELECT
  COUNT(*) AS accounts_with_account_number,
  COUNT(*) FILTER (WHERE account_number IS NULL) AS accounts_without_account_number
FROM public.chart_of_accounts;

-- Expected: all accounts should have account_number after migration

-- 4. Accounts with account_type populated
SELECT
  COUNT(*) AS accounts_with_account_type,
  COUNT(*) FILTER (WHERE account_type IS NULL) AS accounts_without_account_type
FROM public.chart_of_accounts;

-- Expected: all accounts with type info should have account_type

-- 5. Account type distribution
SELECT account_type, COUNT(*) AS count
FROM public.chart_of_accounts
GROUP BY account_type
ORDER BY account_type;

-- Expected: 5 types (ASSET, LIABILITY, EQUITY, INCOME, EXPENSE)

-- 6. Accounts with normal_balance populated
SELECT
  COUNT(*) AS accounts_with_normal_balance,
  COUNT(*) FILTER (WHERE normal_balance IS NULL) AS accounts_without_normal_balance
FROM public.chart_of_accounts;

-- Expected: all accounts should have normal_balance

-- 7. Normal balance distribution
SELECT normal_balance, COUNT(*) AS count
FROM public.chart_of_accounts
GROUP BY normal_balance
ORDER BY normal_balance;

-- Expected: DEBIT and CREDIT both present

-- 8. Verify 65 canonical accounts for COMP-PRIME-ERP
SELECT COUNT(*) AS prime_erp_accounts
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP';

-- Expected: 65

-- 9. Verify specific key accounts exist
SELECT account_number, name, account_type, normal_balance, allow_posting, is_system_account
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP'
  AND account_number IN ('11110', '11210', '11220', '11230', '12500', '34000', '41100', '51200')
ORDER BY account_number;

-- Expected: 8 rows, all with correct values

-- 10. Verify Accumulated Depreciation has CREDIT normal balance (special case)
SELECT account_number, name, account_type, normal_balance
FROM public.chart_of_accounts
WHERE account_number = '12500';

-- Expected: 12500, Accumulated Depreciation, ASSET, CREDIT

-- 11. Verify Drawings has DEBIT normal balance (special case)
SELECT account_number, name, account_type, normal_balance
FROM public.chart_of_accounts
WHERE account_number = '34000';

-- Expected: 34000, Drawings, EQUITY, DEBIT

-- 12. Verify parent_account_id uses canonical UUIDs (not account numbers)
SELECT
  COUNT(*) FILTER (WHERE parent_account_id IS NOT NULL) AS accounts_with_parent,
  COUNT(*) FILTER (WHERE parent_account_id IS NULL) AS accounts_without_parent
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP';

-- Expected: 5 root accounts with NULL, 60 with parent

-- 13. Verify parent IDs reference actual canonical accounts
SELECT COUNT(*) AS valid_parent_references
FROM public.chart_of_accounts coa_child
WHERE coa_child.parent_account_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.chart_of_accounts coa_parent
    WHERE coa_parent.id = coa_child.parent_account_id
  );

-- Expected: 60 (all parent references are valid)

-- 14. Verify orphan parent references (should be 0)
SELECT COUNT(*) AS orphan_parent_references
FROM public.chart_of_accounts
WHERE parent_account_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts coa_parent
    WHERE coa_parent.id = chart_of_accounts.parent_account_id
  );

-- Expected: 0

-- 15. Verify account IDs are preserved (no changes)
SELECT COUNT(*) AS unique_canonical_ids
FROM (
  SELECT DISTINCT id FROM public.chart_of_accounts
) sub;

-- Expected: matches total account count (no duplicates)

-- 16. Verify legacy accounts preserved (company_id = NULL)
SELECT COUNT(*) AS legacy_accounts
FROM public.chart_of_accounts
WHERE company_id IS NULL;

-- Expected: > 0 (legacy accounts must be preserved for historical reporting)

-- 17. Verify no unexpected NULL accounting fields on canonical accounts
SELECT
  COUNT(*) FILTER (WHERE account_number IS NULL) AS null_account_number,
  COUNT(*) FILTER (WHERE account_type IS NULL) AS null_account_type,
  COUNT(*) FILTER (WHERE normal_balance IS NULL) AS null_normal_balance,
  COUNT(*) FILTER (WHERE allow_posting IS NULL) AS null_allow_posting
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP';

-- Expected: all zeros (canonical accounts should have all fields)

-- 18. Verify no legacy codes in canonical accounts
SELECT
  COUNT(*) FILTER (WHERE account_number IN ('1000', '1050', '1100', '1200', '2000', '4000', '5000')) AS legacy_codes_found
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP';

-- Expected: 0 (canonical accounts should not use legacy 4-digit codes)

-- 19. Verify 60 hierarchy relationships for COMP-PRIME-ERP
SELECT COUNT(*) AS hierarchy_relationships
FROM public.chart_of_accounts coa_child
WHERE coa_child.company_id = 'COMP-PRIME-ERP'
  AND coa_child.parent_account_id IS NOT NULL;

-- Expected: 60

-- 20. Verify all canonical account IDs are unchanged
-- (Compare current IDs against known canonical IDs from pre-migration snapshot)
-- The IDs should be the same UUIDs as before migration
SELECT
  COUNT(DISTINCT id) AS unique_ids,
  COUNT(*) AS total_rows
FROM public.chart_of_accounts
WHERE company_id = 'COMP-PRIME-ERP';

-- Expected: unique_ids = total_rows = 65

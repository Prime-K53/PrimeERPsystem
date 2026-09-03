-- ============================================================================
-- PRE-FLIGHT INSPECTION: chart_of_accounts JSONB State
-- Run this BEFORE applying migration 0014 to verify expected values
-- ============================================================================

-- 1. Current top-level columns
SELECT
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_name = 'chart_of_accounts'
  AND table_schema = 'public'
ORDER BY ordinal_position;

-- 2. Total row count
SELECT COUNT(*) AS total_accounts FROM public.chart_of_accounts;

-- 3. Accounts with company_id in JSONB data
SELECT
  COUNT(*) AS accounts_with_company_id
FROM public.chart_of_accounts
WHERE data->>'company_id' IS NOT NULL;

-- 4. Accounts with account_number in JSONB data (new format)
SELECT
  COUNT(*) AS accounts_with_new_format
FROM public.chart_of_accounts
WHERE data->>'account_number' IS NOT NULL;

-- 5. Accounts with code in JSONB data (legacy format)
SELECT
  COUNT(*) AS accounts_with_legacy_code
FROM public.chart_of_accounts
WHERE data->>'code' IS NOT NULL
  AND data->>'account_number' IS NULL;

-- 6. Accounts with parent_account_id in JSONB data
SELECT
  COUNT(*) AS accounts_with_parent
FROM public.chart_of_accounts
WHERE data->>'parent_account_id' IS NOT NULL;

-- 7. Accounts with normal_balance in JSONB data
SELECT
  COUNT(*) AS accounts_with_normal_balance
FROM public.chart_of_accounts
WHERE data->>'normal_balance' IS NOT NULL;

-- 8. Distinct account_type values in JSONB
SELECT
  data->>'account_type' AS account_type,
  COUNT(*) AS count
FROM public.chart_of_accounts
GROUP BY data->>'account_type'
ORDER BY count DESC;

-- 9. Distinct type values in JSONB (legacy)
SELECT
  data->>'type' AS legacy_type,
  COUNT(*) AS count
FROM public.chart_of_accounts
WHERE data->>'type' IS NOT NULL
GROUP BY data->>'type'
ORDER BY count DESC;

-- 10. Sample rows for each format
SELECT id, data->>'account_number' AS account_number, data->>'code' AS code,
       data->>'account_type' AS account_type, data->>'type' AS legacy_type,
       data->>'parent_account_id' AS parent_account_id, data->>'company_id' AS company_id
FROM public.chart_of_accounts
WHERE data->>'account_number' IS NOT NULL
LIMIT 3;

SELECT id, data->>'account_number' AS account_number, data->>'code' AS code,
       data->>'account_type' AS account_type, data->>'type' AS legacy_type,
       data->>'parent_account_id' AS parent_account_id, data->>'company_id' AS company_id
FROM public.chart_of_accounts
WHERE data->>'account_number' IS NULL
  AND data->>'code' IS NOT NULL
LIMIT 3;

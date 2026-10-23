-- Pre-flight safety checks for applying 0048 to the live project.
-- READ-ONLY. Nothing here mutates anything.

-- 1. The posting accounts must exist, be active and allow posting, or the
--    corrected consume would fail closed and block all consumption.
SELECT a.id, a.data->>'code' AS code, a.data->>'name' AS name,
       a.data->>'is_active' AS is_active, a.data->>'allow_posting' AS allow_posting,
       a.data->>'account_type' AS type, a.data->>'normal_balance' AS normal
FROM public.accounts a
WHERE a.data->>'code' IN ('21300','41100') OR a.data->>'account_number' IN ('21300','41100')
ORDER BY a.id;

-- 2. The financial-year records the gates will read.
SELECT id, data->>'name' AS name, data->>'is_closed' AS is_closed,
       LEFT(COALESCE(data->>'start_date',''),10) AS start_date,
       LEFT(COALESCE(data->>'end_date',''),10) AS end_date,
       (data->>'start_date') IS NULL AS start_null,
       (data->>'end_date') IS NULL AS end_null
FROM public.financial_years ORDER BY id;

-- 3. The closed-period registry the new gate will read.
SELECT id, jsonb_typeof(data->'value') AS value_type FROM public.settings WHERE id = 'financial_closed_periods';

-- 4. The idempotency_keys envelope shape the replay path depends on.
SELECT COUNT(*) AS total,
       COUNT(*) FILTER (WHERE data IS NULL) AS null_data,
       COUNT(*) FILTER (WHERE id IS NULL) AS null_id
FROM public.idempotency_keys;

-- 5. Existing printing contracts: do any of them carry fields the new
--    coverage rule reads? (A NULL reserved_amount is handled; a malformed
--    one would make the new function fail closed.)
SELECT COUNT(*) AS contracts,
       COUNT(*) FILTER (WHERE data->>'reserved_amount' IS NULL) AS reserved_null,
       COUNT(*) FILTER (WHERE data->>'consumed_amount' IS NULL) AS consumed_null,
       COUNT(*) FILTER (WHERE data->>'customer_id' IS NULL) AS customer_null,
       COUNT(*) FILTER (WHERE data->>'status' IS NULL) AS status_null
FROM public.assessment_contracts;

-- 6. The assessment items the consume path reads.
SELECT COUNT(*) AS items,
       COUNT(*) FILTER (WHERE data->>'contract_id' IS NULL) AS contract_null,
       COUNT(*) FILTER (WHERE data->>'item_price' IS NULL) AS price_null,
       COUNT(*) FILTER (WHERE data->>'status' IS NULL) AS status_null
FROM public.assessment_contract_items;

-- 7. The customers the wallet path reads.
SELECT COUNT(*) AS customers,
       COUNT(*) FILTER (WHERE data->>'walletBalance' IS NULL) AS wallet_null,
       COUNT(*) FILTER (WHERE data->>'walletBalance' IS NOT NULL
                          AND (data->>'walletBalance') !~ '^-?[0-9]+(\.[0-9]+)?$') AS wallet_not_numeric
FROM public.customers;

-- 8. Multi-statement behaviour of this endpoint (harmless): does it return
--    the last statement's result?
SELECT 'first' AS which;
SELECT 'last' AS which;

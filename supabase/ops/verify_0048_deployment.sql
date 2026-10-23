-- =============================================================================
-- Post-apply verification for migration 0048
-- =============================================================================
-- Run this in the Supabase SQL editor (or via psql) immediately AFTER
-- applying supabase/migrations/0048_printing_contracts_server_atomicity.sql.
--
-- It is read-only: it inspects the catalogue and the business tables. It
-- writes nothing and changes no data.
-- =============================================================================

\echo '--- 1. function inventory, ownership, security attributes ---'
SELECT p.proname,
       pg_get_userbyid(p.proowner)             AS owner,
       p.prosecdef                             AS security_definer,
       p.proconfig::text                       AS settings,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS svc,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'consume_contract_assessment_atomic',
    'reserve_contract_assessment_atomic',
    'resolve_posting_account',
    'is_contract_date_in_closed_fy',
    'is_contract_date_in_closed_period',
    'current_erp_rpc_role')
ORDER BY p.proname;
-- EXPECTED: 6 rows; owner=postgres; secdef=true for the two RPCs and
--            resolve_posting_account; svc=true; auth=false; anon=false;
--            search_path pinned to pg_catalog, public, pg_temp.

\echo '--- 2. the posting accounts must resolve ---'
SELECT public.resolve_posting_account('21300') AS deposits_account,
       public.resolve_posting_account('41100') AS revenue_account;
-- EXPECTED: two account ids that exist in public.accounts (in the deployed
--            database they are 'ACC-21300' and 'ACC-41100').

\echo '--- 3. the closed-period gates ---'
SELECT EXISTS (SELECT 1 FROM public.is_contract_date_in_closed_fy('2026-03-20'::date))     AS fy_open_2026,
       EXISTS (SELECT 1 FROM public.is_contract_date_in_closed_fy('2025-06-15'::date))     AS fy_closed_2025,
       EXISTS (SELECT 1 FROM public.is_contract_date_in_closed_period('2025-06-15'::date)) AS registry_closed_2025;
-- EXPECTED: fy_open_2026 = false, and the other two = true whenever the
--            corresponding closure exists. A false on fy_closed_2025 means no
--            closed year covers 2025 — check public.financial_years.

\echo '--- 4. reconciliation R1: one debit + one ledger row per consumption ---'
SELECT wt.data->>'assessment_item_id' AS item_id,
       COUNT(DISTINCT wt.id)          AS wallet_rows,
       COUNT(DISTINCT le.id)          AS ledger_rows,
       SUM((wt.data->>'amount')::numeric) AS wallet_total,
       SUM((le.data->>'amount')::numeric) AS ledger_total
FROM public.wallet_transactions wt
LEFT JOIN public.ledger_entries le ON le.id = 'LG-' || wt.id
WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
GROUP BY 1
HAVING COUNT(DISTINCT wt.id) <> 1
    OR COUNT(DISTINCT le.id) <> 1
    OR SUM((wt.data->>'amount')::numeric) <> SUM((le.data->>'amount')::numeric);
-- EXPECTED: 0 rows.

\echo '--- 5. reconciliation R2: the canonical Dr/Cr legs ---'
SELECT le.data->>'debitAccountId'  AS debit,
       le.data->>'creditAccountId' AS credit,
       COUNT(*) AS n
FROM public.ledger_entries le
WHERE le.data->>'referenceId' IN (
        SELECT wt.data->>'assessment_item_id'
        FROM public.wallet_transactions wt
        WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION')
GROUP BY 1,2;
-- EXPECTED: a single row — the deposits account and the revenue account.

\echo '--- 6. reconciliation R3: wallet balance vs consumed total ---'
SELECT c.id,
       (c.data->>'walletBalance')::numeric AS wallet_balance,
       COALESCE(SUM((wt.data->>'amount')::numeric), 0) AS consumed_total
FROM public.customers c
LEFT JOIN public.wallet_transactions wt
       ON wt.data->>'customer_id' = c.id
      AND wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
GROUP BY c.id, c.data->>'walletBalance'
ORDER BY c.id;
-- REVIEW: wallet_balance must equal the opening balance minus consumed_total.

\echo '--- 7. reconciliation R4: contract buckets vs assessment items ---'
SELECT ct.id,
       (ct.data->>'reserved_amount')::numeric AS reserved_bucket,
       (ct.data->>'consumed_amount')::numeric AS consumed_bucket,
       COALESCE(SUM((ai.data->>'item_price')::numeric)
                FILTER (WHERE ai.data->>'status' = 'reserved'), 0) AS reserved_items,
       COALESCE(SUM((ai.data->>'item_price')::numeric)
                FILTER (WHERE ai.data->>'status' = 'consumed'), 0) AS consumed_items
FROM public.assessment_contracts ct
LEFT JOIN public.assessment_contract_items ai ON ai.data->>'contract_id' = ct.id
GROUP BY ct.id, ct.data->>'reserved_amount', ct.data->>'consumed_amount'
ORDER BY ct.id;
-- REVIEW: consumed_bucket must equal consumed_items; reserved_bucket must be
--          >= reserved_items (the bucket is the healing value).

\echo '--- 8. reconciliation R5: no assessment consumed without its wallet transaction ---'
SELECT ai.id
FROM public.assessment_contract_items ai
WHERE ai.data->>'status' = 'consumed'
  AND NOT EXISTS (
        SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.id = 'WTX-' || ai.id || '-CONSUMED');
-- EXPECTED: 0 rows.

\echo '--- 9. reconciliation R6: no idempotency key claims an unbacked result ---'
SELECT k.id, k.data->>'item_id'
FROM public.idempotency_keys k
WHERE k.data->>'scope' = 'contract_assessment_consume'
  AND k.data->>'status' = 'succeeded'
  AND NOT EXISTS (
        SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.id = 'WTX-' || (k.data->>'item_id') || '-CONSUMED');
-- EXPECTED: 0 rows.

\echo '--- 10. the live financial-year configuration ---'
SELECT id, data->>'name' AS name, data->>'is_closed' AS is_closed,
       LEFT(COALESCE(data->>'start_date',''),10) AS start_date,
       LEFT(COALESCE(data->>'end_date',''),10)   AS end_date
FROM public.financial_years
ORDER BY id;

\echo '--- 11. the closed-period registry (settings) ---'
SELECT id, data->'value' AS closed_periods
FROM public.settings
WHERE id = 'financial_closed_periods';
-- An empty/absent registry means no period closures are configured.

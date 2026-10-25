-- ============================================================================
-- diag_printing_contract_customer_identity.sql — READ-ONLY diagnostic.
--
-- Establishes which customer-identity fields are actually persisted on the
-- live printing contracts around PC-P726/021..024 and how they map to the
-- `customers` / `schools` envelope tables. Executed with
--   node supabase/ops/run-sql.mjs supabase/ops/diag_printing_contract_customer_identity.sql --each
-- It performs SELECTs only: no INSERT/UPDATE/DELETE/DDL.
-- ============================================================================

-- 1. Contracts: envelope business fields + legacy top-level columns.
SELECT
    id,
    data->>'contract_number'      AS envelope_number,
    contract_number               AS column_number,
    data->>'customer_id'          AS envelope_customer_id,
    customer_id                   AS column_customer_id,
    data->>'customerId'           AS envelope_customerId,
    data->>'customerName'         AS "customerName",
    data->>'customer_name'        AS customer_name,
    data->>'school_id'            AS school_id,
    data->>'school_name'          AS school_name,
    data->>'status'               AS status,
    version,
    updated_at
FROM public.assessment_contracts
WHERE COALESCE(data->>'contract_number', contract_number) LIKE 'PC-P726/0%'
ORDER BY COALESCE(data->>'contract_number', contract_number);

-- 2. Customers referenced by those contracts (all identity fields).
SELECT
    c.id,
    c.data->>'business_name'  AS business_name,
    c.data->>'businessName'   AS "businessName",
    c.data->>'company_name'   AS company_name,
    c.data->>'companyName'    AS "companyName",
    c.data->>'name'           AS legacy_name,
    c.data->>'contact_name'   AS contact_name,
    c.data->>'contactName'    AS "contactName",
    c.updated_at
FROM public.customers c
WHERE c.id IN (
    SELECT NULLIF(ac.data->>'customer_id', '')
    FROM public.assessment_contracts ac
    WHERE COALESCE(ac.data->>'contract_number', ac.contract_number) LIKE 'PC-P726/0%'
)
ORDER BY c.id;

-- 3. Every customer whose identity fields look like a placeholder, so the
--    scale of the data problem (if any) is visible before any repair.
SELECT
    c.id,
    c.data->>'business_name'  AS business_name,
    c.data->>'name'           AS legacy_name,
    c.data->>'contact_name'   AS contact_name
FROM public.customers c
WHERE btrim(COALESCE(c.data->>'business_name', '')) IN ('', '-', '—', '_', 'n/a', 'N/A')
  AND btrim(COALESCE(c.data->>'name', '')) IN ('', '-', '—', '_', 'n/a', 'N/A')
ORDER BY c.id;

-- 4. How many live contracts carry no resolvable customer link at all.
SELECT
    COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ac.data->>'customer_id', ac.customer_id, '')), '') IS NULL) AS contracts_without_customer_id,
    COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(ac.data->>'customerName', ac.data->>'customer_name', '')), '') IS NULL) AS contracts_without_customer_name,
    COUNT(*) AS total_contracts
FROM public.assessment_contracts ac
WHERE (ac.data->>'deleted') IS DISTINCT FROM 'true';

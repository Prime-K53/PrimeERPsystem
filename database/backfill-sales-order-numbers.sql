-- ============================================================================
-- OPTIONAL one-time backfill: sales_orders created before the request→order
-- conversion fix (see report) were written by the ERP frontend store WITHOUT
-- an `order_number` (the admin list showed "Unnumbered order") and with only
-- one customer-key spelling, so the portal history scope could miss them.
--
-- This script:
--   1. Assigns `SO-YYYY-######` numbers to every sales_order that has no
--      proper SO-YYYY-###### number yet, continuing per-year from the HIGHEST
--      sequence already in use (so no duplicate numbers are ever produced).
--      Derived ONLY from the rows themselves — no invented values.
--   2. Mirrors the customer key spelling (`customer_id` ⇄ `customerId`) where
--      exactly one exists, so both the ERP admin list and the portal's
--      dual-key customer scope resolve the record.
--
-- It deliberately does NOT link orders back to their originating quotation
-- requests: that relationship cannot be derived safely from existing data
-- (it was never recorded) and would risk mis-assigning customers.
--
-- Run once against Supabase (SQL editor) after the code fix is deployed.
-- Idempotent: rows that already carry a proper SO-YYYY-###### number are
-- left untouched.
-- ============================================================================

BEGIN;

-- 1. Number every sales_order that lacks a proper SO-YYYY-###### number,
--    continuing per year from the highest sequence already in use.
WITH existing_max AS (
  SELECT
    EXTRACT(YEAR FROM created_at)::int AS yr,
    MAX(substring(data->>'order_number' from '^SO-[0-9]{4}-([0-9]+)$')::int) AS max_seq
  FROM public.sales_orders
  WHERE data->>'order_number' ~ '^SO-[0-9]{4}-[0-9]+$'
  GROUP BY 1
),
missing AS (
  SELECT
    id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY EXTRACT(YEAR FROM created_at)
      ORDER BY created_at ASC, id ASC
    ) AS rn
  FROM public.sales_orders
  WHERE data->>'order_number' IS NULL
     OR data->>'order_number' = ''
     OR data->>'order_number' !~ '^SO-[0-9]{4}-[0-9]+$'
)
UPDATE public.sales_orders so
SET data = jsonb_set(
      jsonb_set(
        so.data,
        '{order_number}',
        to_jsonb(
          'SO-' || EXTRACT(YEAR FROM so.created_at)::int || '-' ||
          lpad(
            (COALESCE((SELECT m.max_seq FROM existing_max m WHERE m.yr = EXTRACT(YEAR FROM so.created_at)::int), 0)
             + (SELECT rn FROM missing r WHERE r.id = so.id))::text,
            6, '0'
          )
        )
      ),
      '{updated_at}',
      to_jsonb(now()::text)
    )
WHERE so.id IN (SELECT id FROM missing);

-- 2a. camelCase `customerId` → snake_case `customer_id` (backend/portal scope).
UPDATE public.sales_orders
SET data = jsonb_set(
      jsonb_set(data, '{customer_id}', to_jsonb(data->>'customerId')),
      '{updated_at}', to_jsonb(now()::text)
    )
WHERE data->>'customerId' IS NOT NULL AND data->>'customerId' <> ''
  AND (data->>'customer_id' IS NULL OR data->>'customer_id' = '');

-- 2b. snake_case `customer_id` → camelCase `customerId` (ERP frontend store).
UPDATE public.sales_orders
SET data = jsonb_set(
      jsonb_set(data, '{customerId}', to_jsonb(data->>'customer_id')),
      '{updated_at}', to_jsonb(now()::text)
    )
WHERE data->>'customer_id' IS NOT NULL AND data->>'customer_id' <> ''
  AND (data->>'customerId' IS NULL OR data->>'customerId' = '');

COMMIT;

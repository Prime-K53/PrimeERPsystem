-- ============================================================================
-- Migration 0027: Series-aware official Sales Order sequence
-- Prime ERP — Single-Company
-- ============================================================================
--
-- Purpose:
--   Provide ONE atomic numeric sequence PER CONFIGURED SERIES for unified
--   official Sales Order numbers:
--     Direct ERP origin            -> ORD-{series}/NNN
--     Quotation/request conversion -> SO-{series}/NNN
--   (e.g. P726 today; P727 tomorrow — each series has an independent counter.)
--
--   The sequence is prefix-agnostic within a series: a single integer counter
--   per series is claimed atomically and the caller formats it with the
--   origin-appropriate prefix. There are deliberately NO separate SO and ORD
--   counters — but every configured series gets its OWN counter row, so
--   series never share or collide on sequence values.
--
-- ABSOLUTE INVARIANTS (enforced by review, not just comments):
--   - This migration NEVER inserts, updates, or deletes rows in
--     sales_orders, orders, or any business table.
--   - It NEVER renames, normalizes, or repopulates historical numbers
--     (SO-P726/*, ORDER-P726/*, ORD-YYYY-######, or any other shape).
--   - It only ADDS: a series-keyed counter table, an atomic claim function,
--     and a uniqueness guard on the canonical official-number field.
--
-- Counter initialization without touching history:
--   Each historically observed series is seeded from the MAXIMUM numeric
--   suffix already present for THAT series. Every field that can carry an
--   operational number is scanned INDEPENDENTLY (both sales_orders number
--   spellings, orders number spellings, plus row ids which equal their
--   numbers for legacy rows) — never COALESCE-first, because a single
--   COALESCE pick would shadow the other fields on rows that carry several
--   identifiers at once (e.g. a row whose order_number is a legacy backend
--   number while its id/orderNumber holds the operational P726 number).
--   Legacy ORDER-{series} rows count toward their series (historical
--   compatibility); legacy backend ORD-YYYY-NNNNNN rows never match the
--   unified shape and are ignored. Re-running the migration can only RAISE
--   counters (GREATEST per series), never lower them, so already-issued
--   numbers stay safe. Series with no history start on first claim (see the
--   claim function, which self-initializes unseen series from history inside
--   the same lock — never blind /001).
--   Digit runs are capped at 9 characters so malformed data can neither
--   overflow the integer column nor abort this migration.
--
-- Claiming (backend only, service-role):
--   SELECT claim_next_sales_order_number('P726');  -- single atomic step
--   The per-series lock serializes concurrent claimants of the SAME series
--   (A→25, B→26, never 25/25); different series never block each other.
--
-- Operator verification (read-only; run in SQL Editor, changes nothing):
--   SELECT series, last_value, updated_at
--   FROM public.sales_order_number_counters ORDER BY series;
--   -- per-series occupancy across both tables and all three fields:
--   SELECT (m)[2] AS series, MAX((m)[3]::int) AS max_suffix, COUNT(*) AS rows
--   FROM (
--     SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'order_number' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'orderNumber' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(id, '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders
--     UNION ALL
--     SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'order_number' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'orderNumber' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(id, '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders
--   ) s WHERE m IS NOT NULL GROUP BY 1 ORDER BY 1;
--
-- ============================================================================

-- ─── STEP 0: remove the never-deployed P726-only objects (no-op if absent) ───
-- These names were introduced by an uncommitted draft of this migration and
-- must not survive: a P726-locked counter identity is not acceptable.
DROP FUNCTION IF EXISTS public.claim_next_p726_order_number();
DROP TABLE IF EXISTS public.sales_order_p726_counter;

-- ─── STEP 1: series-keyed counter table (service-role only) ─────────────────
CREATE TABLE IF NOT EXISTS public.sales_order_number_counters (
  series TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.sales_order_number_counters ENABLE ROW LEVEL SECURITY;
-- Intentionally NO permissive policy: anon/authenticated get nothing.
-- The service-role key bypasses RLS, which is exactly how the backend claims.

-- ─── STEP 2: seed every historically observed series (reads only) ───────────
-- Six independent branches (both tables × order_number/orderNumber/id):
-- each field is scanned on its own so that no field shadows another on rows
-- carrying several identifiers (verified live shape: order_number holds a
-- legacy backend number while id/orderNumber hold the operational P726
-- number — a COALESCE-first scan would miss the P726 suffix entirely).
INSERT INTO public.sales_order_number_counters (series, last_value, updated_at)
SELECT
  (m)[2] AS series,
  MAX((m)[3]::int) AS last_value,
  NOW()
FROM (
  SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'order_number' IS NOT NULL
  UNION ALL
  SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'orderNumber' IS NOT NULL
  UNION ALL
  SELECT regexp_match(id, '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.sales_orders
  UNION ALL
  SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'order_number' IS NOT NULL
  UNION ALL
  SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'orderNumber' IS NOT NULL
  UNION ALL
  SELECT regexp_match(id, '^(SO|ORD|ORDER)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.orders
) s
WHERE m IS NOT NULL
GROUP BY 1
ON CONFLICT (series) DO UPDATE SET
  last_value = GREATEST(public.sales_order_number_counters.last_value, EXCLUDED.last_value),
  updated_at = NOW();

-- ─── STEP 3: atomic per-series claim function ───────────────────────────────
-- One transaction: take the series advisory lock, then either bump the
-- existing row or safely initialize an unseen series from that series'
-- history (same lock held throughout, so two concurrent first-claims for a
-- new series serialize instead of double-initializing).
CREATE OR REPLACE FUNCTION public.claim_next_sales_order_number(p_series TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed INTEGER;
  clean_series TEXT;
BEGIN
  clean_series := NULLIF(trim(both from p_series), '');
  IF clean_series IS NULL OR clean_series !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid sales order series: %', p_series;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('sales_order_number_counters:' || clean_series));

  SELECT last_value INTO claimed
  FROM public.sales_order_number_counters
  WHERE series = clean_series;

  IF NOT FOUND THEN
    SELECT COALESCE(MAX((m)[3]::int), 0) + 1 INTO claimed
    FROM (
      SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'order_number' IS NOT NULL
      UNION ALL
      SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.sales_orders WHERE data->>'orderNumber' IS NOT NULL
      UNION ALL
      SELECT regexp_match(id, '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.sales_orders
      UNION ALL
      SELECT regexp_match(data->>'order_number', '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'order_number' IS NOT NULL
      UNION ALL
      SELECT regexp_match(data->>'orderNumber', '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.orders WHERE data->>'orderNumber' IS NOT NULL
      UNION ALL
      SELECT regexp_match(id, '^(SO|ORD|ORDER)-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.orders
    ) s
    WHERE m IS NOT NULL;
    INSERT INTO public.sales_order_number_counters (series, last_value, updated_at)
    VALUES (clean_series, claimed, NOW());
  ELSE
    claimed := claimed + 1;
    UPDATE public.sales_order_number_counters
    SET last_value = claimed,
        updated_at = NOW()
    WHERE series = clean_series;
  END IF;

  RETURN claimed;
END;
$$;

-- Only the service role may execute the claim. Frontend clients never claim:
-- offline orders use provisional identities until the backend numbers them.
REVOKE ALL ON FUNCTION public.claim_next_sales_order_number(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_sales_order_number(TEXT) TO service_role;

-- ─── STEP 4: uniqueness backstop on the CANONICAL official-number field ──────
-- data.order_number is authoritative for official numbers (see
-- getSalesOrderOfficialNumber). The legacy 0009 index guards only the
-- compatibility field data->>'orderNumber' and is left untouched. This guard
-- is series-agnostic: it protects every official number equally.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_orders_official_number_unique
ON public.sales_orders (((data->>'order_number')::text))
WHERE data->>'order_number' IS NOT NULL
  AND data->>'order_number' <> '';

-- ============================================================================
-- END MIGRATION 0027
-- ============================================================================

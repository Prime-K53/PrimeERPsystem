-- ============================================================================
-- 0010_referral_attribution_fields.sql
--
-- Adds JSONB expression indexes for referral attribution tracking in
-- sales_orders and quotation_requests. The referral attribution itself is
-- stored in the existing JSONB `data` envelope (data->>'referred_by_id' etc.)
-- — no new top-level columns are needed.
--
-- Indexes added:
--   sales_orders       — data->>'referred_by_id', data->>'referred_by_code'
--   quotation_requests — data->>'referred_by_id', data->>'referred_by_code'
--
-- Idempotent: CREATE INDEX IF NOT EXISTS.
-- ============================================================================

-- ─── 1. sales_orders.data — expression indexes ────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_sales_orders_referred_by_id
  ON public.sales_orders ((data->>'referred_by_id'));

CREATE INDEX IF NOT EXISTS idx_sales_orders_referred_by_code
  ON public.sales_orders ((data->>'referred_by_code'));

-- ─── 2. quotation_requests.data — expression indexes ────────────────────────
CREATE INDEX IF NOT EXISTS idx_quotation_requests_referred_by_id
  ON public.quotation_requests ((data->>'referred_by_id'));

CREATE INDEX IF NOT EXISTS idx_quotation_requests_referred_by_code
  ON public.quotation_requests ((data->>'referred_by_code'));

-- ============================================================================
-- End of 0010
-- ============================================================================

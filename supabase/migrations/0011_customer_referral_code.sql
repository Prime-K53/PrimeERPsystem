-- ============================================================================
-- 0011_customer_referral_code.sql
--
-- Adds referred_by_code column to customers table to track the referral code
-- used during self-service registration. This column records the referral code
-- (not the referrer's customer ID) that a new customer used when signing up.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.
-- ============================================================================

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS referred_by_code TEXT;

-- Index for looking up customers by referral code used at registration
CREATE INDEX IF NOT EXISTS idx_customers_referred_by_code
  ON public.customers ((referred_by_code));

-- ============================================================================
-- End of 0011
-- ============================================================================

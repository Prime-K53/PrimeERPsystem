-- ============================================================
-- Mobile Money Account Migration
-- Adds 11240 Mobile Money as a canonical payment account
--
-- RATIONALE:
-- 11230 is NBS Bank (a bank account). It was incorrectly used as
-- Mobile Money in some places, but 11230 = NBS Bank, NOT Mobile Money.
-- This migration adds the proper 11240 Mobile Money account.
--
-- PAYMENT COA AFTER THIS MIGRATION:
-- 11110 = Cash Drawer
-- 11210 = National Bank
-- 11220 = FDH Bank
-- 11230 = NBS Bank
-- 11240 = Mobile Money (NEW)
--
-- SAFETY:
-- - Idempotent: only inserts if 11240 does not exist
-- - Does NOT modify 11210, 11220, 11230 (NBS Bank must remain)
-- - Does NOT migrate historical transactions
-- - Does NOT touch any other accounts
-- ============================================================

BEGIN;

-- Mobile Money (11240) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11240', jsonb_build_object(
    'id', '11240',
    'code', '11240',
    'account_number', '11240',
    'name', 'Mobile Money',
    'account_type', 'ASSET',
    'type', 'Asset',
    'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11200',
    'subtype', 'MOBILE_MONEY',
    'allow_posting', true,
    'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = '11240' OR data->>'account_number' = '11240'
);

COMMIT;

-- ============================================================
-- Migration complete. 11240 Mobile Money account added.
-- Existing bank accounts (11210, 11220, 11230) unchanged.
-- Historical transactions unchanged.
-- ============================================================

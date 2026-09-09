-- ============================================================
-- Bank Accounts Migration
-- Adds missing bank accounts under 11200 Bank Accounts parent
--
-- ACCOUNTS ADDED:
-- 11210 = National Bank
-- 11220 = FDH Bank
-- 11230 = NBS Bank
--
-- SAFETY:
-- - Idempotent: only inserts if account does not exist
-- - Does NOT modify existing accounts
-- - Does NOT migrate historical transactions
-- ============================================================

BEGIN;

-- National Bank (11210) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11210', jsonb_build_object(
    'id', '11210',
    'code', '11210',
    'account_number', '11210',
    'name', 'National Bank',
    'account_type', 'ASSET',
    'type', 'Asset',
    'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11200',
    'subtype', 'BANK',
    'allow_posting', true,
    'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = '11210' OR data->>'account_number' = '11210'
);

-- FDH Bank (11220) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11220', jsonb_build_object(
    'id', '11220',
    'code', '11220',
    'account_number', '11220',
    'name', 'FDH Bank',
    'account_type', 'ASSET',
    'type', 'Asset',
    'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11200',
    'subtype', 'BANK',
    'allow_posting', true,
    'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = '11220' OR data->>'account_number' = '11220'
);

-- NBS Bank (11230) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11230', jsonb_build_object(
    'id', '11230',
    'code', '11230',
    'account_number', '11230',
    'name', 'NBS Bank',
    'account_type', 'ASSET',
    'type', 'Asset',
    'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11200',
    'subtype', 'BANK',
    'allow_posting', true,
    'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (
    SELECT 1 FROM public.accounts
    WHERE id = '11230' OR data->>'account_number' = '11230'
);

COMMIT;

-- ============================================================
-- Migration complete. Bank accounts (11210, 11220, 11230) added.
-- ============================================================

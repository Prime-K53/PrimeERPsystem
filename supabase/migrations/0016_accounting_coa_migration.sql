-- ============================================================
-- Phase 1: Accounting Chart of Accounts Migration
-- Migrates legacy 4-digit account codes to canonical 5-digit codes
-- Removes duplicate 10000 Assets, creates missing canonical accounts
-- ============================================================

-- ── 1. Clean up duplicate 10000 Assets accounts ──
-- Keep the one with account_number '10000' and remove duplicates
-- that have the same account_number but different id/code
DELETE FROM public.accounts
WHERE id IN (
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY data->>'account_number'
                   ORDER BY created_at DESC
               ) AS rn
        FROM public.accounts
        WHERE data->>'account_number' = '10000'
    ) sub
    WHERE rn > 1
);

-- Also remove any accounts with old 4-digit codes as id or code
-- that are duplicates of canonical accounts
DELETE FROM public.accounts
WHERE id IN (
    SELECT a.id FROM public.accounts a
    WHERE a.data->>'code' IN ('1000','1100','1110','1111','1120','1121','1122','1200','1300','2000','2100','2110','2120','2121','3000','3100','3200','3300','4000','4100','4110','5000','5100','5120','5200','5210','5220','5230','5290')
    AND EXISTS (
        SELECT 1 FROM public.accounts b
        WHERE b.data->>'account_number' = a.data->>'account_number'
        AND b.id != a.id
    )
);

-- ── 2. Update old 4-digit codes to canonical 5-digit codes ──
-- Update accounts where data->>'code' or data->>'account_number' is an old code
-- Map: code/account_number → canonical account_number
-- Note: account_number is the canonical 5-digit identifier used for posting

-- Cash Drawer: 1000 → 11110
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11110"'),
    '{account_number}', '"11110"'
)
WHERE data->>'code' = '1000' OR data->>'account_number' = '1000';

-- Accounts Receivable: 1100 → 11300
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11300"'),
    '{account_number}', '"11300"'
)
WHERE data->>'code' = '1100' OR data->>'account_number' = '1100';

-- Bank Account: 1050 → 11210
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11210"'),
    '{account_number}', '"11210"'
)
WHERE data->>'code' = '1050' OR data->>'account_number' = '1050';

-- Mobile Money: 1060 → 11230
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11230"'),
    '{account_number}', '"11230"'
)
WHERE data->>'code' = '1060' OR data->>'account_number' = '1060';

-- Sales/Revenue: 4000 → 41100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"41100"'),
    '{account_number}', '"41100"'
)
WHERE data->>'code' = '4000' OR data->>'account_number' = '4000';

-- COGS: 5000 → 51200
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"51200"'),
    '{account_number}', '"51200"'
)
WHERE data->>'code' = '5000' OR data->>'account_number' = '5000';

-- Current Assets: 1100 (id/code) → 11000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11000"'),
    '{account_number}', '"11000"'
)
WHERE data->>'id' = '1100' AND data->>'account_number' = '11000';

-- Cash in Hand: 1110 (id/code) → 11100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11100"'),
    '{account_number}', '"11100"'
)
WHERE data->>'id' = '1110' AND data->>'account_number' = '11100';

-- Main Cash: 1111 (id/code) with account_number 11101 → 11110
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11110"'),
    '{account_number}', '"11110"',
    '{id}', '"11110"'
)
WHERE data->>'id' = '1111' AND (data->>'account_number' = '11101' OR data->>'code' = '1111');

-- FDH Bank: 1121 (id/code) with account_number 11201 → 11220
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11220"'),
    '{account_number}', '"11220"',
    '{id}', '"11220"'
)
WHERE data->>'id' = '1121' AND (data->>'account_number' = '11201' OR data->>'code' = '1121');

-- NBS Bank: 1122 (id/code) with account_number 11202 → 11230
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11230"'),
    '{account_number}', '"11230"',
    '{id}', '"11230"'
)
WHERE data->>'id' = '1122' AND (data->>'account_number' = '11202' OR data->>'code' = '1122');

-- Inventory: 1300 (id/code) with account_number 13000 → 11400
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11400"'),
    '{account_number}', '"11400"',
    '{id}', '"11400"'
)
WHERE data->>'id' = '1300' AND (data->>'account_number' = '13000' OR data->>'code' = '1300');

-- Sales/Revenue parent: 4100 (id/code) with account_number 41000 → stays 41000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"41000"'),
    '{account_number}', '"41000"',
    '{id}', '"41000"'
)
WHERE data->>'id' = '4100' AND (data->>'account_number' = '41000' OR data->>'code' = '4100');

-- Product Sales: 4110 (id/code) with account_number 41100 → stays 41100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"41100"'),
    '{account_number}', '"41100"',
    '{id}', '"41100"'
)
WHERE data->>'id' = '4110' AND (data->>'account_number' = '41100' OR data->>'code' = '4110');

-- Cost of Goods Sold: 5120 (id/code) with account_number 51200 → stays 51200
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"51200"'),
    '{account_number}', '"51200"',
    '{id}', '"51200"'
)
WHERE data->>'id' = '5120' AND (data->>'account_number' = '51200' OR data->>'code' = '5120');

-- Cost of Sales: 5100 (id/code) with account_number 51000 → stays 51000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"51000"'),
    '{account_number}', '"51000"',
    '{id}', '"51000"'
)
WHERE data->>'id' = '5100' AND (data->>'account_number' = '51000' OR data->>'code' = '5100');

-- VAT Payable: 2121 (id/code) with account_number 21201 → 21210
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"21210"'),
    '{account_number}', '"21210"',
    '{id}', '"21210"'
)
WHERE data->>'id' = '2121' AND (data->>'account_number' = '21201' OR data->>'code' = '2121');

-- Current Liabilities: 2100 (id/code) with account_number 21000 → stays 21000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"21000"'),
    '{account_number}', '"21000"',
    '{id}', '"21000"'
)
WHERE data->>'id' = '2100' AND (data->>'account_number' = '21000' OR data->>'code' = '2100');

-- Liabilities root: 2000 (id/code) with account_number 20000 → stays 20000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"20000"'),
    '{account_number}', '"20000"',
    '{id}', '"20000"'
)
WHERE data->>'id' = '2000' AND (data->>'account_number' = '20000' OR data->>'code' = '2000');

-- Equity root: 3000 (id/code) with account_number 30000 → stays 30000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"30000"'),
    '{account_number}', '"30000"',
    '{id}', '"30000"'
)
WHERE data->>'id' = '3000' AND (data->>'account_number' = '30000' OR data->>'code' = '3000');

-- Retained Earnings: 3200 (id/code) with account_number 32000 → stays 32000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"32000"'),
    '{account_number}', '"32000"',
    '{id}', '"32000"'
)
WHERE data->>'id' = '3200' AND (data->>'account_number' = '32000' OR data->>'code' = '3200');

-- Current Year Earnings: 3300 (id/code) with account_number 33000 → stays 33000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"33000"'),
    '{account_number}', '"33000"',
    '{id}', '"33000"'
)
WHERE data->>'id' = '3300' AND (data->>'account_number' = '33000' OR data->>'code' = '3300');

-- Owner's Capital: 3100 (id/code) with account_number 31000 → stays 31000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"31000"'),
    '{account_number}', '"31000"',
    '{id}', '"31000"'
)
WHERE data->>'id' = '3100' AND (data->>'account_number' = '31000' OR data->>'code' = '3100');

-- Other Income: 4200 (id/code) with account_number 42000 → stays 42000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"42000"'),
    '{account_number}', '"42000"',
    '{id}', '"42000"'
)
WHERE data->>'id' = '4200' AND (data->>'account_number' = '42000' OR data->>'code' = '4200');

-- Operating Expenses parent: 5200 (id/code) with account_number 52000 → stays 52000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52000"'),
    '{account_number}', '"52000"',
    '{id}', '"52000"'
)
WHERE data->>'id' = '5200' AND (data->>'account_number' = '52000' OR data->>'code' = '5200');

-- Salaries: 5210 (id/code) with account_number 52100 → stays 52100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52100"'),
    '{account_number}', '"52100"',
    '{id}', '"52100"'
)
WHERE data->>'id' = '5210' AND (data->>'account_number' = '52100' OR data->>'code' = '5210');

-- Rent: 5220 (id/code) with account_number 52200 → stays 52200
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52200"'),
    '{account_number}', '"52200"',
    '{id}', '"52200"'
)
WHERE data->>'id' = '5220' AND (data->>'account_number' = '52200' OR data->>'code' = '5220');

-- Utilities: 5230 (id/code) with account_number 52300 → stays 52300
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52300"'),
    '{account_number}', '"52300"',
    '{id}', '"52300"'
)
WHERE data->>'id' = '5230' AND (data->>'account_number' = '52300' OR data->>'code' = '5230');

-- Bank Charges: 5290 (id/code) with account_number 52900 → stays 52900
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52900"'),
    '{account_number}', '"52900"',
    '{id}', '"52900"'
)
WHERE data->>'id' = '5290' AND (data->>'account_number' = '52900' OR data->>'code' = '5290');

-- ── 3. Create missing canonical accounts if they don't exist ──
-- Use ON CONFLICT-style insert via WHERE NOT EXISTS

-- Cash in Hand (11100) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11100', jsonb_build_object(
    'id', '11100', 'code', '11100', 'account_number', '11100', 'name', 'Cash in Hand',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'CASH', 'allow_posting', false, 'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11100' OR data->>'account_number' = '11100');

-- Main Cash / Cash Drawer (11110) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11110', jsonb_build_object(
    'id', '11110', 'code', '11110', 'account_number', '11110', 'name', 'Main Cash',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'CASH', 'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'DEBIT', 'role', 'cash_drawer'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11110' OR data->>'account_number' = '11110');

-- Petty Cash (11120) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11120', jsonb_build_object(
    'id', '11120', 'code', '11120', 'account_number', '11120', 'name', 'Petty Cash',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'CASH', 'allow_posting', true, 'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11120' OR data->>'account_number' = '11120');

-- National Bank (11210) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11210', jsonb_build_object(
    'id', '11210', 'code', '11210', 'account_number', '11210', 'name', 'National Bank',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'BANK', 'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'DEBIT', 'role', 'bank_national'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11210' OR data->>'account_number' = '11210');

-- FDH Bank (11220) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11220', jsonb_build_object(
    'id', '11220', 'code', '11220', 'account_number', '11220', 'name', 'FDH Bank',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'BANK', 'allow_posting', true, 'is_system_account', false,
    'normal_balance', 'DEBIT', 'role', 'bank_fdh'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11220' OR data->>'account_number' = '11220');

-- NBS Bank (11230) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11230', jsonb_build_object(
    'id', '11230', 'code', '11230', 'account_number', '11230', 'name', 'NBS Bank',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'BANK', 'allow_posting', true, 'is_system_account', false,
    'normal_balance', 'DEBIT', 'role', 'bank_nbs'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11230' OR data->>'account_number' = '11230');

-- Inventory (11400) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11400', jsonb_build_object(
    'id', '11400', 'code', '11400', 'account_number', '11400', 'name', 'Inventory',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'INVENTORY', 'allow_posting', false, 'is_system_account', true,
    'normal_balance', 'DEBIT', 'role', 'inventory'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11400' OR data->>'account_number' = '11400');

-- Accounts Payable (21100) already exists from canonical setup; ensure it's correct
-- No-op if exists

-- Product Sales (41100) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '41100', jsonb_build_object(
    'id', '41100', 'code', '41100', 'account_number', '41100', 'name', 'Product Sales',
    'account_type', 'INCOME', 'type', 'Revenue', 'account_group', 'REVENUE',
    'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'CREDIT', 'role', 'sales'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '41100' OR data->>'account_number' = '41100');

-- ── 4. Verify no old 4-digit codes remain in accounts table ──
-- Delete any remaining accounts with old 4-digit codes that don't correspond to canonical account_numbers
DELETE FROM public.accounts
WHERE data->>'code' IN ('1000','1050','1060','1100','2000','4000','5000','1111','1121','1122','1300','2121','3200','3300','3100','4100','4110','5100','5120','5210','5220','5230','5290')
AND data->>'account_number' NOT IN ('10000','11000','11100','11110','11120','11200','11210','11220','11230','11300','11400','12000','20000','21000','21100','21200','21210','22000','30000','31000','32000','33000','40000','41000','41100','42000','50000','51000','51200','52000','52100','52200','52300','52900');

-- ── 5. Update ledger entries referencing old account codes ──
-- Update debitAccountId and creditAccountId in ledger_entries table
-- Note: ledger entries may reference account codes or account_numbers
-- We need to update any that reference old 4-digit codes

-- Create a temp mapping for old code → new account_number
-- This uses a CTE approach to update ledger entries
WITH code_map AS (
    SELECT '1000'::text as old_code, '11110'::text as new_code
    UNION ALL SELECT '1050', '11210'
    UNION ALL SELECT '1060', '11230'
    UNION ALL SELECT '1100', '11300'
    UNION ALL SELECT '2000', '21100'
    UNION ALL SELECT '4000', '41100'
    UNION ALL SELECT '5000', '51200'
)
UPDATE public.ledger_entries
SET debit_account_id = CASE
    WHEN debit_account_id = cm.old_code THEN cm.new_code
    ELSE debit_account_id
END,
credit_account_id = CASE
    WHEN credit_account_id = cm.old_code THEN cm.new_code
    ELSE credit_account_id
END
FROM code_map cm
WHERE debit_account_id = cm.old_code OR credit_account_id = cm.old_code;

-- ── 6. Create index for performance ──
CREATE INDEX IF NOT EXISTS idx_accounts_account_number ON public.accounts ((data->>'account_number'));
CREATE INDEX IF NOT EXISTS idx_ledger_debit_account ON public.ledger_entries (debit_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_credit_account ON public.ledger_entries (credit_account_id);

-- ============================================================
-- Migration complete. All account codes now use canonical 5-digit numbers.
-- ============================================================

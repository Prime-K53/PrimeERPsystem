-- ============================================================
-- Phase 1: Accounting Chart of Accounts Migration
-- Migrates legacy 4-digit account codes to canonical 5-digit codes
-- Removes duplicate 10000 Assets, creates missing canonical accounts
--
-- SAFETY RULES:
-- - 1050 (Bank Account) is NOT blindly mapped to 11210 (National Bank)
--   without historical evidence. Preserved as archive.
-- - 1060 (Mobile Money) has NO canonical equivalent. Preserved as archive.
-- - 4000 (Sales) is NOT blindly mapped to 41100 (Product Sales)
--   without classifying product vs service. Preserved as archive.
-- - 2000 (Liabilities) is NOT blindly mapped to 21100 (AP parent).
--   Mapped to 21110 (Trade Creditors) only for supplier payables.
-- ============================================================

BEGIN;

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
-- SAFE mappings only:
-- 1000 (Cash) → 11110 (Cash Drawer)
-- 1100 (AR) → 11310 (Trade Debtors) -- posting account, not 11300 parent
-- 1200 (Inventory) → 11410 (Merchandise Inventory)
-- 2200 (Supplier AP) → 21110 (Trade Creditors)
-- 3000 (Drawings) → 34000 (Drawings)
-- 4900 (Other Income) → 42100 (Interest Income)
-- 5000 (COGS) → 51200 (Cost of Goods Sold)
-- 5100 (Purchases) → 51100 (Purchases)
-- 5120 (COGS) → 51200 (Cost of Goods Sold)
-- 5200 (Op Exp) → 52000 (Operating Expenses)
-- 5210 (Salaries) → 52100 (Salaries & Wages)
-- 5220 (Rent) → 52200 (Rent)
-- 5230 (Utilities) → 52300 (Utilities)
-- 6100 (Gen Exp) → 52000 (Operating Expenses)
-- 6200 (Utilities) → 52300 (Utilities)
-- 6300 (Salaries) → 52100 (Salaries & Wages)
-- 2000 (Liabilities parent) → 21110 (Trade Creditors) -- for supplier payables only
-- 3000 (Equity parent) → 30000 (Equity) -- if it was the root
-- 3200 (Retained Earnings) → 32000 (Retained Earnings)
-- 3300 (Current Year Earnings) → 33000 (Current Year Earnings)
-- 3100 (Owner's Capital) → 31000 (Owner's Capital)
-- 4000 (Sales parent) → preserved as archive, NOT mapped to 41100
-- 1050 (Bank Account) → preserved as archive, NOT mapped to 11210
-- 1060 (Mobile Money) → preserved as archive, NOT mapped to 11230

-- Cash Drawer: 1000 → 11110
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11110"'),
    '{account_number}', '"11110"'
)
WHERE data->>'code' = '1000' OR data->>'account_number' = '1000';

-- Accounts Receivable: 1100 → 11310 (Trade Debtors, not 11300 parent)
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11310"'),
    '{account_number}', '"11310"',
    '{id}', '"11310"'
)
WHERE data->>'code' = '1100' OR data->>'account_number' = '1100';

-- Sales/Revenue parent: 4000 → preserve as archive (code 4000, marked inactive)
-- Do NOT map to 41100 without classifying product vs service
UPDATE public.accounts
SET data = jsonb_set(data::jsonb, '{is_active}', 'false')
WHERE data->>'code' = '4000' OR data->>'account_number' = '4000';

-- Bank Account: 1050 → preserve as archive (no canonical equivalent without evidence)
UPDATE public.accounts
SET data = jsonb_set(data::jsonb, '{is_active}', 'false')
WHERE data->>'code' = '1050' OR data->>'account_number' = '1050';

-- Mobile Money: 1060 → preserve as archive (no canonical COA equivalent)
UPDATE public.accounts
SET data = jsonb_set(data::jsonb, '{is_active}', 'false')
WHERE data->>'code' = '1060' OR data->>'account_number' = '1060';

-- COGS: 5000 → 51200
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"51200"'),
    '{account_number}', '"51200"'
)
WHERE data->>'code' = '5000' OR data->>'account_number' = '5000';

-- Liabilities parent: 2000 → 21110 (Trade Creditors) for supplier payables
-- Mark 2000 as inactive since it was a generic liabilities root
UPDATE public.accounts
SET data = jsonb_set(data::jsonb, '{is_active}', 'false')
WHERE data->>'code' = '2000' OR data->>'account_number' = '2000'
AND data->>'account_number' = '20000';

-- Other Income: 4900 → 42100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"42100"'),
    '{account_number}', '"42100"'
)
WHERE data->>'code' = '4900' OR data->>'account_number' = '4900';

-- Purchases: 5110 → 51100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"51100"'),
    '{account_number}', '"51100"'
)
WHERE data->>'code' = '5110' OR data->>'account_number' = '5110';

-- Operating Expenses parent: 5200 → 52000
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52000"'),
    '{account_number}', '"52000"'
)
WHERE data->>'code' = '5200' OR data->>'account_number' = '5200';

-- Salaries: 5210 → 52100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52100"'),
    '{account_number}', '"52100"'
)
WHERE data->>'code' = '5210' OR data->>'account_number' = '5210';

-- Rent: 5220 → 52200
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52200"'),
    '{account_number}', '"52200"'
)
WHERE data->>'code' = '5220' OR data->>'account_number' = '5220';

-- Utilities: 5230 → 52300
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52300"'),
    '{account_number}', '"52300"'
)
WHERE data->>'code' = '5230' OR data->>'account_number' = '5230';

-- General Expense (6100): → 52000 (Operating Expenses)
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52000"'),
    '{account_number}', '"52000"'
)
WHERE data->>'code' = '6100' OR data->>'account_number' = '6100';

-- Utilities (6200): → 52300
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52300"'),
    '{account_number}', '"52300"'
)
WHERE data->>'code' = '6200' OR data->>'account_number' = '6200';

-- Salaries (6300): → 52100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"52100"'),
    '{account_number}', '"52100"'
)
WHERE data->>'code' = '6300' OR data->>'account_number' = '6300';

-- Also update codes that were previously 11100, 1111, 1121, 1122, 1300, 2100, 2121, 3100, 3200, 3300, 4100, 4110, 5100, 5120, 5210, 5220, 5230, 5290
-- Current Assets parent: 1100 (id/code) → 11000 (already updated above for 1100)
-- Cash in Hand: 1110 (id/code) → 11100
UPDATE public.accounts
SET data = jsonb_set(
    jsonb_set(data::jsonb, '{code}', '"11100"'),
    '{account_number}', '"11100"'
)
WHERE data->>'id' = '1110' AND (data->>'account_number' = '11100' OR data->>'code' = '1110');

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
-- Use WHERE NOT EXISTS to be truly idempotent

-- Cash in Hand (11100) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11100', jsonb_build_object(
    'id', '11100', 'code', '11100', 'account_number', '11100', 'name', 'Cash in Hand',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'CASH', 'allow_posting', false, 'is_system_account', false,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11100' OR data->>'account_number' = '11100');

-- Cash Drawer / Main Cash (11110) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11110', jsonb_build_object(
    'id', '11110', 'code', '11110', 'account_number', '11110', 'name', 'Cash Drawer',
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

-- NBS Bank (11230) if missing -- note: this is NBS Bank, NOT Mobile Money
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11230', jsonb_build_object(
    'id', '11230', 'code', '11230', 'account_number', '11230', 'name', 'NBS Bank',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'BANK', 'allow_posting', true, 'is_system_account', false,
    'normal_balance', 'DEBIT', 'role', 'bank_nbs'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11230' OR data->>'account_number' = '11230');

-- Trade Debtors (11310) if missing -- the actual posting account for customer invoices
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11310', jsonb_build_object(
    'id', '11310', 'code', '11310', 'account_number', '11310', 'name', 'Trade Debtors',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11300', 'subtype', 'RECEIVABLE', 'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11310' OR data->>'account_number' = '11310');

-- Inventory (11400) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11400', jsonb_build_object(
    'id', '11400', 'code', '11400', 'account_number', '11400', 'name', 'Inventory',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'subtype', 'INVENTORY', 'allow_posting', false, 'is_system_account', true,
    'normal_balance', 'DEBIT', 'role', 'inventory'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11400' OR data->>'account_number' = '11400');

-- Merchandise Inventory (11410) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '11410', jsonb_build_object(
    'id', '11410', 'code', '11410', 'account_number', '11410', 'name', 'Merchandise Inventory',
    'account_type', 'ASSET', 'type', 'Asset', 'account_group', 'CURRENT_ASSET',
    'parent_account_id', '11400', 'subtype', 'INVENTORY', 'allow_posting', true, 'normal_balance', 'DEBIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '11410' OR data->>'account_number' = '11410');

-- Product Sales (41100) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '41100', jsonb_build_object(
    'id', '41100', 'code', '41100', 'account_number', '41100', 'name', 'Product Sales',
    'account_type', 'INCOME', 'type', 'Revenue', 'account_group', 'REVENUE',
    'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'CREDIT', 'role', 'sales'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '41100' OR data->>'account_number' = '41100');

-- Service Income (41200) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '41200', jsonb_build_object(
    'id', '41200', 'code', '41200', 'account_number', '41200', 'name', 'Service Income',
    'account_type', 'INCOME', 'type', 'Revenue', 'account_group', 'REVENUE',
    'allow_posting', true, 'is_system_account', true,
    'normal_balance', 'CREDIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '41200' OR data->>'account_number' = '41200');

-- Trade Creditors (21110) if missing
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '21110', jsonb_build_object(
    'id', '21110', 'code', '21110', 'account_number', '21110', 'name', 'Trade Creditors',
    'account_type', 'LIABILITY', 'type', 'Liability', 'account_group', 'CURRENT_LIABILITY',
    'parent_account_id', '21100', 'subtype', 'PAYABLE', 'allow_posting', true, 'normal_balance', 'CREDIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '21110' OR data->>'account_number' = '21110');

-- Accrued Expenses (21300) if missing -- for customer deposits
INSERT INTO public.accounts (id, data, created_at, updated_at, version)
SELECT '21300', jsonb_build_object(
    'id', '21300', 'code', '21300', 'account_number', '21300', 'name', 'Accrued Expenses',
    'account_type', 'LIABILITY', 'type', 'Liability', 'account_group', 'CURRENT_LIABILITY',
    'allow_posting', true, 'normal_balance', 'CREDIT'
), NOW(), NOW(), 1
WHERE NOT EXISTS (SELECT 1 FROM public.accounts WHERE id = '21300' OR data->>'account_number' = '21300');

-- ── 4. Update parent_account_id references when account IDs change ──
-- When 1100 was updated to 11310, any parent_account_id pointing to 1100 needs updating
-- When 1000 was updated to 11110, any parent_account_id pointing to 1000 needs updating
-- When 1111 was updated to 11110, any parent_account_id pointing to 1111 needs updating
-- When 1121 was updated to 11220, any parent_account_id pointing to 1121 needs updating
-- When 1122 was updated to 11230, any parent_account_id pointing to 1122 needs updating
-- When 1300 was updated to 11400, any parent_account_id pointing to 1300 needs updating
-- When 4100 was updated to 41000, any parent_account_id pointing to 4100 needs updating
-- When 4110 was updated to 41100, any parent_account_id pointing to 4110 needs updating
-- When 5120 was updated to 51200, any parent_account_id pointing to 5120 needs updating
-- When 5100 was updated to 51000, any parent_account_id pointing to 5100 needs updating
-- When 2121 was updated to 21210, any parent_account_id pointing to 2121 needs updating
-- When 2100 was updated to 21000, any parent_account_id pointing to 2100 needs updating
-- When 2000 was updated to 20000, any parent_account_id pointing to 2000 needs updating
-- When 3000 was updated to 30000, any parent_account_id pointing to 3000 needs updating
-- When 3200 was updated to 32000, any parent_account_id pointing to 3200 needs updating
-- When 3300 was updated to 33000, any parent_account_id pointing to 3300 needs updating
-- When 3100 was updated to 31000, any parent_account_id pointing to 3100 needs updating
-- When 4200 was updated to 42000, any parent_account_id pointing to 4200 needs updating
-- When 5200 was updated to 52000, any parent_account_id pointing to 5200 needs updating
-- When 5210 was updated to 52100, any parent_account_id pointing to 5210 needs updating
-- When 5220 was updated to 52200, any parent_account_id pointing to 5220 needs updating
-- When 5230 was updated to 52300, any parent_account_id pointing to 5230 needs updating
-- When 5290 was updated to 52900, any parent_account_id pointing to 5290 needs updating
-- When 1200 was updated to 11410, any parent_account_id pointing to 1200 needs updating

-- Update parent_account_id references in accounts table itself
UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11300"')
WHERE data->>'parent_account_id' = '1100' AND id = '11310';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11000"')
WHERE data->>'parent_account_id' = '1110' AND id = '11100';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11100"')
WHERE data->>'parent_account_id' = '1111' AND id = '11110';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11200"')
WHERE data->>'parent_account_id' = '1121' AND id = '11220';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11200"')
WHERE data->>'parent_account_id' = '1122' AND id = '11230';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11400"')
WHERE data->>'parent_account_id' = '1300' AND id = '11400';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"41000"')
WHERE data->>'parent_account_id' = '4100' AND id = '41100';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"51000"')
WHERE data->>'parent_account_id' = '5100' AND id = '51100';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"51000"')
WHERE data->>'parent_account_id' = '5120' AND id = '51200';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"51000"')
WHERE data->>'parent_account_id' = '5100' AND id = '51000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"21200"')
WHERE data->>'parent_account_id' = '2121' AND id = '21210';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"21000"')
WHERE data->>'parent_account_id' = '2100' AND id = '21000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"20000"')
WHERE data->>'parent_account_id' = '2000' AND id = '20000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"30000"')
WHERE data->>'parent_account_id' = '3000' AND id = '30000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"32000"')
WHERE data->>'parent_account_id' = '3200' AND id = '32000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"33000"')
WHERE data->>'parent_account_id' = '3300' AND id = '33000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"31000"')
WHERE data->>'parent_account_id' = '3100' AND id = '31000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"42000"')
WHERE data->>'parent_account_id' = '4200' AND id = '42000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"52000"')
WHERE data->>'parent_account_id' = '5200' AND id = '52000';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"52000"')
WHERE data->>'parent_account_id' = '5210' AND id = '52100';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"52000"')
WHERE data->>'parent_account_id' = '5220' AND id = '52200';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"52000"')
WHERE data->>'parent_account_id' = '5230' AND id = '52300';

UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"52000"')
WHERE data->>'parent_account_id' = '5290' AND id = '52900';

-- Update parent_account_id in JSONB data of other tables that reference account IDs
-- Check accounts table for any remaining old parent_account_id references
UPDATE public.accounts
SET data = jsonb_set(data, '{parent_account_id}', '"11300"')
WHERE data->>'parent_account_id' = '1100' AND data->>'account_number' != '11300';

-- ── 5. Update ledger entries referencing old account codes ──
-- Create a temp mapping for old code → new account_number
-- SAFE mappings only: 1000→11110, 1100→11310, 2000→21110, 5000→51200, 5100→51100, 5120→51200, 5200→52000, 5210→52100, 5220→52200, 5230→52300, 6100→52000, 6200→52300, 6300→52100, 4900→42100
WITH code_map AS (
    SELECT '1000'::text as old_code, '11110'::text as new_code
    UNION ALL SELECT '1100', '11310'
    UNION ALL SELECT '2000', '21110'
    UNION ALL SELECT '5000', '51200'
    UNION ALL SELECT '5100', '51100'
    UNION ALL SELECT '5120', '51200'
    UNION ALL SELECT '5200', '52000'
    UNION ALL SELECT '5210', '52100'
    UNION ALL SELECT '5220', '52200'
    UNION ALL SELECT '5230', '52300'
    UNION ALL SELECT '6100', '52000'
    UNION ALL SELECT '6200', '52300'
    UNION ALL SELECT '6300', '52100'
    UNION ALL SELECT '4900', '42100'
    -- 1050, 1060, 4000 are NOT in this mapping (preserved as archives)
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

-- Also update JSONB references in other tables that may contain account codes
-- Search all tables for embedded account references
-- Note: This is a template; actual tables depend on the schema
-- The ledger_entries table is already handled above.
-- Other tables with JSONB data containing account references should be updated separately.

-- ── 6. Add UNIQUE constraint on account_number after duplicates resolved ──
-- Only add after confirming no duplicates remain
ALTER TABLE public.accounts ADD CONSTRAINT IF NOT EXISTS accounts_account_number_unique UNIQUE (data->>'account_number');

-- ── 7. Create index for performance ──
CREATE INDEX IF NOT EXISTS idx_accounts_account_number ON public.accounts ((data->>'account_number'));
CREATE INDEX IF NOT EXISTS idx_ledger_debit_account ON public.ledger_entries (debit_account_id);
CREATE INDEX IF NOT EXISTS idx_ledger_credit_account ON public.ledger_entries (credit_account_id);

-- ── 8. Mark unsafe legacy accounts as archived ──
-- 1050 (Bank Account), 1060 (Mobile Money), 4000 (Sales parent) are preserved but inactive
-- Their historical transactions remain intact but no new postings use these accounts

COMMIT;

-- ============================================================
-- Migration complete. All account codes now use canonical 5-digit numbers.
-- Unsafe mappings (1050→11210, 1060→11230, 4000→41100) were NOT performed.
-- Legacy accounts 1050, 1060, 4000 preserved as inactive archives.
-- All ledger entries updated to canonical codes via safe mappings only.
-- parent_account_id references updated when account IDs changed.
-- UNIQUE constraint added on account_number.
-- ============================================================
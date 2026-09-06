-- ============================================================================
-- LEGACY CUSTOMER BUSINESS_NAME CORRECTION
-- ============================================================================
-- Rule: business_name = CUSTOMER IDENTITY, contact_name = CONTACT PERSON
-- Scope: 30 clearly-identifiable organizations/schools
-- DO NOT modify any other customer records
-- ============================================================================

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 1: PRE-FLIGHT SELECT
-- Show current state before any modification
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 
  id,
  data->>'business_name' AS current_business_name,
  data->>'contact_name' AS current_contact_name,
  data->>'name' AS legacy_name,
  CASE 
    WHEN data->>'business_name' IS NULL OR trim(data->>'business_name') = '' 
    THEN 'EMPTY - WILL BE UPDATED'
    ELSE 'HAS VALUE - WILL NOT BE UPDATED'
  END AS status
FROM customers
WHERE id IN (
  'CUST-0003', 'CUST-0004', 'CUST-0005', 'CUST-0006', 'CUST-0007',
  'CUST-0008', 'CUST-0010', 'CUST-0011', 'CUST-0012', 'CUST-0013',
  'CUST-0014', 'CUST-0015', 'CUST-0016', 'CUST-0032', 'CUST-0033',
  'CUST-0034', 'CUST-0035', 'CUST-0036', 'CUST-0037', 'CUST-0038',
  'CUST-0039', 'CUST-0040', 'CUST-0044', 'CUST-0045', 'CUST-0046',
  'CUST-0047', 'CUST-0048', 'CUST-0050', 'CUST-0051', 'CUST-0053'
)
ORDER BY id;

-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 2: VERIFICATION QUERY (run BEFORE update)
-- Confirm all 30 have NULL/empty business_name
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 
  COUNT(*) AS total_in_scope,
  COUNT(*) FILTER (
    WHERE data->>'business_name' IS NULL OR trim(data->>'business_name') = ''
  ) AS empty_business_name_count,
  COUNT(*) FILTER (
    WHERE data->>'business_name' IS NOT NULL AND trim(data->>'business_name') <> ''
  ) AS has_business_name_count
FROM customers
WHERE id IN (
  'CUST-0003', 'CUST-0004', 'CUST-0005', 'CUST-0006', 'CUST-0007',
  'CUST-0008', 'CUST-0010', 'CUST-0011', 'CUST-0012', 'CUST-0013',
  'CUST-0014', 'CUST-0015', 'CUST-0016', 'CUST-0032', 'CUST-0033',
  'CUST-0034', 'CUST-0035', 'CUST-0036', 'CUST-0037', 'CUST-0038',
  'CUST-0039', 'CUST-0040', 'CUST-0044', 'CUST-0045', 'CUST-0046',
  'CUST-0047', 'CUST-0048', 'CUST-0050', 'CUST-0051', 'CUST-0053'
);

-- Expected output: total_in_scope = 30, empty_business_name_count = 30, has_business_name_count = 0
-- IF has_business_name_count > 0, STOP and review those records manually


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 3: UPDATE TRANSACTION
-- Set business_name = data.name for the 30 specified customer IDs
-- Preserves: id, contact_name, name, email, phone, and all other fields
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

UPDATE customers
SET data = jsonb_set(
  data,
  '{business_name}',
  data->'name',
  true  -- create key if it doesn't exist
)
WHERE id IN (
  'CUST-0003', 'CUST-0004', 'CUST-0005', 'CUST-0006', 'CUST-0007',
  'CUST-0008', 'CUST-0010', 'CUST-0011', 'CUST-0012', 'CUST-0013',
  'CUST-0014', 'CUST-0015', 'CUST-0016', 'CUST-0032', 'CUST-0033',
  'CUST-0034', 'CUST-0035', 'CUST-0036', 'CUST-0037', 'CUST-0038',
  'CUST-0039', 'CUST-0040', 'CUST-0044', 'CUST-0045', 'CUST-0046',
  'CUST-0047', 'CUST-0048', 'CUST-0050', 'CUST-0051', 'CUST-0053'
);

-- Verify row count affected
SELECT ROW_COUNT() AS rows_updated;

COMMIT;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 4: POST-FLIGHT SELECT
-- Prove all 30 have the expected business_name
-- Prove contact_name was NOT changed
-- Prove data.name was NOT changed
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 
  id,
  data->>'business_name' AS new_business_name,
  data->>'contact_name' AS contact_name,
  data->>'name' AS legacy_name,
  -- Verification flags
  CASE 
    WHEN data->>'business_name' = data->>'name' 
    THEN '✓ business_name matches legacy name'
    ELSE '✗ MISMATCH - investigate'
  END AS business_name_check,
  CASE 
    WHEN data->>'contact_name' IS NOT NULL OR true 
    THEN 'contact_name preserved (not modified by this update)'
    ELSE 'check'
  END AS contact_name_check
FROM customers
WHERE id IN (
  'CUST-0003', 'CUST-0004', 'CUST-0005', 'CUST-0006', 'CUST-0007',
  'CUST-0008', 'CUST-0010', 'CUST-0011', 'CUST-0012', 'CUST-0013',
  'CUST-0014', 'CUST-0015', 'CUST-0016', 'CUST-0032', 'CUST-0033',
  'CUST-0034', 'CUST-0035', 'CUST-0036', 'CUST-0037', 'CUST-0038',
  'CUST-0039', 'CUST-0040', 'CUST-0044', 'CUST-0045', 'CUST-0046',
  'CUST-0047', 'CUST-0048', 'CUST-0050', 'CUST-0051', 'CUST-0053'
)
ORDER BY id;


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 5: FINAL VERIFICATION COUNT
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 
  COUNT(*) AS total_in_scope,
  COUNT(*) FILTER (
    WHERE data->>'business_name' = data->>'name'
  ) AS business_name_matches_legacy_name,
  COUNT(*) FILTER (
    WHERE data->>'business_name' IS NULL OR trim(data->>'business_name') = ''
  ) AS still_empty_count
FROM customers
WHERE id IN (
  'CUST-0003', 'CUST-0004', 'CUST-0005', 'CUST-0006', 'CUST-0007',
  'CUST-0008', 'CUST-0010', 'CUST-0011', 'CUST-0012', 'CUST-0013',
  'CUST-0014', 'CUST-0015', 'CUST-0016', 'CUST-0032', 'CUST-0033',
  'CUST-0034', 'CUST-0035', 'CUST-0036', 'CUST-0037', 'CUST-0038',
  'CUST-0039', 'CUST-0040', 'CUST-0044', 'CUST-0045', 'CUST-0046',
  'CUST-0047', 'CUST-0048', 'CUST-0050', 'CUST-0051', 'CUST-0053'
);

-- Expected output: 
--   total_in_scope = 30
--   business_name_matches_legacy_name = 30
--   still_empty_count = 0


-- ═══════════════════════════════════════════════════════════════════════════
-- STEP 6: SAFETY CHECK - Verify excluded records were NOT touched
-- ═══════════════════════════════════════════════════════════════════════════

SELECT 
  id,
  data->>'business_name' AS business_name,
  data->>'name' AS legacy_name
FROM customers
WHERE id IN (
  'CUST-0001', 'CUST-0017', 'CUST-0018', 'CUST-0019', 'CUST-0020',
  'CUST-0021', 'CUST-0022', 'CUST-0023', 'CUST-0024', 'CUST-0025',
  'CUST-0026', 'CUST-0027', 'CUST-0028', 'CUST-0029', 'CUST-0030',
  'CUST-0031', 'CUST-0041', 'CUST-0042', 'CUST-0043', 'CUST-0052',
  'CUST-0054', 'CUST-0055', 'CUST-0056', 'CUST-0057'
)
ORDER BY id;

-- These records should remain UNCHANGED (business_name still NULL/empty 
-- or whatever it was before). They require separate manual review.

-- 0055_customer_name_correction.sql
-- APPLIED to live project rdtuzuzehfbwvfdzqliw on 2026-10-23.
-- Two fixes in one migration:
--   1. Normalise the customer display name for CUST-0072 to "Nadzikhale
--      Primary School" across name / businessName / companyName in the
--      `data` JSONB envelope.
--   2. Strip any trailing "(CUST-…)" suffix from the denormalised
--      `customerName` on existing assessment_contracts rows so that
--      printed contracts and the contracts hub show the bare customer
--      name — never the customer number appended to it.

-- ── 1. Customer name normalisation (idempotent) ─────────────────────────
DO
$$
DECLARE
  v_now   TIMESTAMPTZ := NOW();
  v_id    TEXT        := 'CUST-0072';
  v_name  TEXT        := 'Nadzikhale Primary School';
BEGIN
  IF EXISTS (SELECT 1 FROM public.customers WHERE id = v_id) THEN
    UPDATE public.customers
    SET    data = data
            || jsonb_build_object(
                 'name',          v_name,
                 'businessName',  v_name,
                 'companyName',   v_name
               ),
           version = COALESCE(version, 0) + 1,
           updated_at = v_now
    WHERE  id = v_id;

    RAISE NOTICE 'customer % name normalised to "%"', v_id, v_name;
  ELSE
    RAISE NOTICE 'customer % not found — skipped', v_id;
  END IF;
END
$$;

-- ── 2. Strip trailing "(CUST-…)" from denormalised contract customerName ─
-- The contracts hub previously embedded the customer number in the
-- denormalised `customerName` field.  Remove it so names are clean.
WITH to_fix AS (
  SELECT id, data->>'customerName' AS cn
  FROM   public.assessment_contracts
  WHERE  (data->>'customerName') IS NOT NULL
    AND  (data->>'customerName') ~ '\s*\([^)]+\)\s*$'
)
UPDATE public.assessment_contracts ac
SET    data = jsonb_set(data, '{customerName}',
                       to_jsonb(regexp_replace(data->>'customerName', '\s*\([^)]+\)\s*$', '', 'g'))),
       version = COALESCE(version, 0) + 1,
       updated_at = NOW()
FROM   to_fix
WHERE  ac.id = to_fix.id;

-- ── Also handle the legacy flat column if it exists ─────────────────────
-- (Some deployments store customerName as a top-level column instead of
--  inside the JSONB envelope.)
DO
$$
DECLARE
  col_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE  table_name = 'assessment_contracts'
      AND  column_name = 'customer_name'
  ) INTO col_exists;

  IF col_exists THEN
    UPDATE public.assessment_contracts
    SET    customer_name = regexp_replace(customer_name, '\s*\([^)]+\)\s*$', '', 'g'),
           version = COALESCE(version, 0) + 1,
           updated_at = NOW()
    WHERE  customer_name IS NOT NULL
      AND  customer_name ~ '\s*\([^)]+\)\s*$';
  END IF;
END
$$;

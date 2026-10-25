-- ============================================================================
-- 0059_examination_integrity_and_token_hardening.sql
--
-- Repairs the Examination integrity diagnostics and hardens QR verification
-- tokens.
--
-- Frozen defects
-- --------------
-- 1. 0050's `examination_integrity_findings` looked for the invoice number in
--    `data->>'invoiceNumber'`, but ledger rows written by the real application
--    carry the invoice identity in `data->>'referenceId'` (and the 0051 RPCs
--    write both). On live data the view therefore returned ZERO findings while
--    43 orphan EXM ledger rows (net AR MWK 755,250) were present.
-- 2. 0050's `assert_examination_invoice_number_unique` counted ledger rows by
--    `invoiceNumber` only, so it missed `referenceId`-only orphans.
-- 3. `invoices.data->>'verificationToken'` had no uniqueness constraint, and
--    6 live invoices had no token at all. A duplicated token would let one QR
--    verify a different document.
--
-- What this migration changes
-- ---------------------------
--   - Replaces the integrity view with referenceId/reference_id lineage and
--     adds orphan AR-impact, number-reuse, claim-without-invoice, duplicate
--     token and missing-token findings.
--   - Rewrites `assert_examination_invoice_number_unique` to read referenceId.
--   - Backfills a cryptographically random 64-hex token on live invoices that
--     have none (existing tokens are never regenerated).
--   - Adds a partial unique index on the token.
--
-- It does NOT delete, reverse or write off any ledger row. Orphan financial
-- history requires an explicit operator decision; see 0060.
--
-- CREATED — NOT YET APPLIED to the live project. Apply only after the
-- pre-flight checks below return zero rows.
--
-- PRE-FLIGHT (read-only)
--   SELECT * FROM public.examination_integrity_findings ORDER BY 1,2;
--   SELECT COALESCE(data->>'verificationToken','') AS token, COUNT(*)
--     FROM public.invoices
--    WHERE nullif(btrim(COALESCE(data->>'verificationToken','')), '') IS NOT NULL
--      AND COALESCE(data->>'deleted','false') NOT IN ('true','t','1')
--      AND data->>'deletedAt' IS NULL
--    GROUP BY 1 HAVING COUNT(*) > 1;
-- ============================================================================

BEGIN;

-- ─── 1. Reference-aware invoice-number assertion ────────────────────────────
CREATE OR REPLACE FUNCTION public.assert_examination_invoice_number_unique(
  p_invoice_number TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_count INT;
  v_ledger_count INT;
BEGIN
  IF p_invoice_number IS NULL OR p_invoice_number NOT LIKE 'EXM-%' THEN
    RETURN TRUE;
  END IF;

  SELECT COUNT(*) INTO v_invoice_count
  FROM public.invoices
  WHERE (
          id = p_invoice_number
          OR COALESCE(data->>'invoiceNumber', data->>'invoice_number') = p_invoice_number
        )
    AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND data->>'deletedAt' IS NULL;

  IF v_invoice_count > 1 THEN
    RAISE EXCEPTION
      'EXAMINATION_INVOICE_NUMBER_DUPLICATE: % resolves to % live invoice rows',
      p_invoice_number, v_invoice_count
      USING ERRCODE = 'unique_violation';
  END IF;

  -- The live application records the invoice identity in `referenceId`.
  -- `invoiceNumber` is retained as a compatibility fallback for older rows.
  SELECT COUNT(*) INTO v_ledger_count
  FROM public.ledger_entries
  WHERE COALESCE(
          data->>'referenceId',
          data->>'reference_id',
          data->>'invoiceNumber',
          data->>'invoice_number'
        ) = p_invoice_number;

  IF v_ledger_count > 0 AND v_invoice_count = 0 THEN
    RAISE EXCEPTION
      'EXAMINATION_INVOICE_ORPHAN_LEDGER: % has % ledger row(s) but no invoice row',
      p_invoice_number, v_ledger_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_examination_invoice_number_unique(TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_examination_invoice_number_unique(TEXT)
  TO service_role;

-- ─── 2. Integrity findings with real ledger lineage ─────────────────────────
CREATE OR REPLACE VIEW public.examination_integrity_findings AS
WITH ar_accounts AS (
  SELECT id
  FROM public.accounts
  WHERE COALESCE(data->>'code', data->>'accountNumber', data->>'account_number') = '11310'
),
live_invoices AS (
  SELECT
    i.id,
    COALESCE(i.data->>'invoiceNumber', i.data->>'invoice_number', i.id) AS invoice_number,
    NULLIF(BTRIM(COALESCE(i.data->>'verificationToken', '')), '') AS verification_token,
    i.data
  FROM public.invoices i
  WHERE COALESCE(i.data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND i.data->>'deletedAt' IS NULL
),
exam_ledger AS (
  SELECT
    le.id,
    le.data,
    COALESCE(
      le.data->>'referenceId',
      le.data->>'reference_id',
      le.data->>'invoiceNumber',
      le.data->>'invoice_number'
    ) AS reference
  FROM public.ledger_entries le
  WHERE COALESCE(
          le.data->>'referenceId',
          le.data->>'reference_id',
          le.data->>'invoiceNumber',
          le.data->>'invoice_number'
        ) LIKE 'EXM-%'
),
orphan_ledger AS (
  SELECT
    l.reference,
    COUNT(*)::INT AS occurrences,
    COUNT(DISTINCT COALESCE(NULLIF(BTRIM(COALESCE(l.data->>'customerId', '')), ''), 'UNKNOWN'))::INT
      AS customer_count,
    (
      SUM(CASE WHEN l.data->>'debitAccountId' IN (SELECT id FROM ar_accounts)
               THEN COALESCE(NULLIF(l.data->>'amount', '')::NUMERIC, 0) ELSE 0 END)
      - SUM(CASE WHEN l.data->>'creditAccountId' IN (SELECT id FROM ar_accounts)
                THEN COALESCE(NULLIF(l.data->>'amount', '')::NUMERIC, 0) ELSE 0 END)
    )::NUMERIC(18, 2) AS net_amount,
    jsonb_build_object(
      'entryIds', jsonb_agg(l.id ORDER BY l.id),
      'customers', jsonb_agg(DISTINCT COALESCE(NULLIF(BTRIM(COALESCE(l.data->>'customerName', '')), ''), 'Unknown') ORDER BY COALESCE(NULLIF(BTRIM(COALESCE(l.data->>'customerName', '')), ''), 'Unknown')),
      'customerIds', jsonb_agg(DISTINCT COALESCE(NULLIF(BTRIM(COALESCE(l.data->>'customerId', '')), ''), 'UNKNOWN') ORDER BY COALESCE(NULLIF(BTRIM(COALESCE(l.data->>'customerId', '')), ''), 'UNKNOWN')),
      'modules', jsonb_agg(DISTINCT COALESCE(l.data->>'originModule', l.data->>'origin_module', 'legacy') ORDER BY COALESCE(l.data->>'originModule', l.data->>'origin_module', 'legacy')),
      'firstSeen', MIN(COALESCE(l.data->>'date', l.id)),
      'lastSeen', MAX(COALESCE(l.data->>'date', l.id)),
      'reversalRows', COUNT(*) FILTER (
        WHERE l.id LIKE 'LG-REV-%'
           OR COALESCE(l.data->>'originModule', l.data->>'origin_module', '') = 'examination_reversal'
      )::INT
    ) AS detail
  FROM exam_ledger l
  WHERE NOT EXISTS (
    SELECT 1
    FROM live_invoices i
    WHERE i.id = l.reference
       OR i.invoice_number = l.reference
  )
  GROUP BY l.reference
)
SELECT
  'duplicate_active_invoice_per_batch'::TEXT AS finding,
  COALESCE(i.data->>'batchId', i.data->>'batch_id') AS subject,
  COUNT(*)::INT AS occurrences,
  NULL::NUMERIC(18, 2) AS net_amount,
  jsonb_agg(
    jsonb_build_object('invoiceId', i.id, 'status', i.data->>'status')
    ORDER BY i.id
  ) AS detail,
  'critical'::TEXT AS severity
FROM live_invoices i
WHERE COALESCE(i.data->>'origin_module', i.data->>'originModule', '') = 'examination'
  AND LOWER(COALESCE(i.data->>'status', '')) NOT IN ('cancelled', 'void', 'voided', 'draft')
  AND COALESCE(i.data->>'batchId', i.data->>'batch_id') IS NOT NULL
  AND COALESCE(i.data->>'batchId', i.data->>'batch_id') <> ''
GROUP BY COALESCE(i.data->>'batchId', i.data->>'batch_id')
HAVING COUNT(*) > 1

UNION ALL

SELECT
  'orphan_ledger_exam_invoice'::TEXT,
  o.reference,
  o.occurrences,
  o.net_amount,
  o.detail || jsonb_build_object(
    'claimExists', EXISTS (
      SELECT 1
      FROM public.examination_invoice_number_claims c
      WHERE c.invoice_number = o.reference
    )
  ),
  CASE WHEN ABS(COALESCE(o.net_amount, 0)) > 0.005 THEN 'critical' ELSE 'warning' END::TEXT
FROM orphan_ledger o

UNION ALL

SELECT
  'reused_exam_number_across_customers'::TEXT,
  o.reference,
  o.customer_count,
  o.net_amount,
  o.detail,
  'critical'::TEXT
FROM orphan_ledger o
WHERE o.customer_count > 1

UNION ALL

SELECT
  'duplicate_exam_invoice_number'::TEXT,
  i.invoice_number,
  COUNT(*)::INT,
  NULL::NUMERIC(18, 2),
  jsonb_agg(
    jsonb_build_object(
      'invoiceId', i.id,
      'customerId', i.data->>'customerId',
      'totalAmount', i.data->>'totalAmount'
    )
    ORDER BY i.id
  ),
  'critical'::TEXT
FROM live_invoices i
WHERE i.invoice_number LIKE 'EXM-%'
GROUP BY i.invoice_number
HAVING COUNT(*) > 1

UNION ALL

SELECT
  'exam_claim_without_invoice'::TEXT,
  c.invoice_number,
  1,
  NULL::NUMERIC(18, 2),
  jsonb_build_object(
    'series', c.series,
    'sequence', c.sequence,
    'claimedAt', c.claimed_at
  ),
  'warning'::TEXT
FROM public.examination_invoice_number_claims c
WHERE NOT EXISTS (
  SELECT 1
  FROM live_invoices i
  WHERE i.id = c.invoice_number
     OR i.invoice_number = c.invoice_number
)

UNION ALL

SELECT
  'duplicate_verification_token'::TEXT,
  i.verification_token,
  COUNT(*)::INT,
  NULL::NUMERIC(18, 2),
  jsonb_agg(i.id ORDER BY i.id),
  'critical'::TEXT
FROM live_invoices i
WHERE i.verification_token IS NOT NULL
GROUP BY i.verification_token
HAVING COUNT(*) > 1

UNION ALL

SELECT
  'invoice_without_verification_token'::TEXT,
  i.id,
  1,
  NULL::NUMERIC(18, 2),
  jsonb_build_object(
    'invoiceNumber', i.invoice_number,
    'originModule', COALESCE(i.data->>'originModule', i.data->>'origin_module', ''),
    'status', i.data->>'status'
  ),
  'warning'::TEXT
FROM live_invoices i
WHERE i.verification_token IS NULL;

COMMENT ON VIEW public.examination_integrity_findings IS
  'Examination integrity violations. Diagnostic only — this view reports, it does not repair. Ledger lineage reads data->>referenceId (with legacy fallbacks).';

REVOKE ALL ON public.examination_integrity_findings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.examination_integrity_findings TO service_role;

-- ─── 3. Do not create the unique token index over a duplicate ───────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoices
    WHERE nullif(btrim(coalesce(data->>'verificationToken', '')), '') IS NOT NULL
      AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
      AND data->>'deletedAt' IS NULL
    GROUP BY data->>'verificationToken'
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      '0059 pre-flight failed: duplicate live verificationToken values exist';
  END IF;
END $$;

-- ─── 4. Backfill missing tokens; never regenerate an existing one ───────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
  END IF;
END $$;

UPDATE public.invoices
   SET data = data || jsonb_build_object(
                'verificationToken',
                encode(extensions.gen_random_bytes(32), 'hex')
              ),
       updated_at = NOW(),
       version = COALESCE(version, 0) + 1
 WHERE nullif(btrim(coalesce(data->>'verificationToken', '')), '') IS NULL
   AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
   AND data->>'deletedAt' IS NULL;

-- ─── 5. One live document per verification token ────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_verification_token_unique
  ON public.invoices ((data->>'verificationToken'))
  WHERE nullif(btrim(coalesce(data->>'verificationToken', '')), '') IS NOT NULL
    AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND data->>'deletedAt' IS NULL;

COMMENT ON INDEX public.idx_invoices_verification_token_unique IS
  'A QR verification token must resolve to exactly one live invoice. Tombstones are excluded so document history is never blocked by a deleted row.';

-- ─── 6. Verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.invoices
    WHERE nullif(btrim(coalesce(data->>'verificationToken', '')), '') IS NULL
      AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
      AND data->>'deletedAt' IS NULL
  ) THEN
    RAISE EXCEPTION '0059 verification failed: live invoices without a token remain';
  END IF;

  IF to_regclass('public.idx_invoices_verification_token_unique') IS NULL THEN
    RAISE EXCEPTION '0059 verification failed: unique token index is missing';
  END IF;

  IF pg_get_functiondef(
       'public.assert_examination_invoice_number_unique(text)'::regprocedure
     ) NOT ILIKE '%referenceId%' THEN
    RAISE EXCEPTION
      '0059 verification failed: assertion function still does not read referenceId';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK
--   DROP INDEX IF EXISTS public.idx_invoices_verification_token_unique;
--   -- Tokens are intentionally NOT removed: removing them would break every
--   -- QR already printed from the backfilled rows.
--   DROP VIEW IF EXISTS public.examination_integrity_findings;
--   -- Restore 0050's function body and grants if a full rollback is required.
-- ============================================================================

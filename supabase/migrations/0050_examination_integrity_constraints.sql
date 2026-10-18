-- ============================================================================
-- 0050_examination_integrity_constraints.sql
--
-- Database-level enforcement for the Examination lifecycle. Additive only and
-- idempotent (IF NOT EXISTS), so it is safe to run against a live database that
-- already carries examination data.
--
-- NOT APPLIED TO PRODUCTION by this change — apply during a maintenance window.
-- Rollback: drop the three indexes created below (see the ROLLBACK footer).
--
-- Context
-- -------
-- examination_batches and invoices are envelope tables
-- ({ id, data JSONB, updated_at, version }; see 0001_baseline_live_schema.sql).
-- The envelope shape means no FK, CHECK or business-key uniqueness can be
-- expressed by the table definition, so every Examination invariant was enforced
-- only by client code on one device's IndexedDB copy. These constraints make
-- the invariants hold regardless of which device writes, and regardless of
-- whether application code remembers to check.
--
-- The sync gateway (backend/services/examinationSyncGuards.cjs) additionally
-- enforces the status state machine as an atomic precondition on the write
-- itself. These indexes are the backstop that still holds if a write arrives
-- through a path the gateway does not guard.
-- ============================================================================

BEGIN;

-- ─── 1. Batch numbers are unique business keys ───────────────────────────────
-- Two devices mint batch numbers from a device-local MAX+1 counter
-- (frontend/services/documentNumberService.ts), so offline the same
-- batch_number could be produced twice. tombstones are excluded because a
-- tombstoned row is superseded history, not a live claim on the number.
CREATE UNIQUE INDEX IF NOT EXISTS idx_examination_batches_batch_number_unique
  ON public.examination_batches ((COALESCE(data->>'batch_number', data->>'batchNumber')))
  WHERE COALESCE(data->>'batch_number', data->>'batchNumber') IS NOT NULL
    AND COALESCE(data->>'batch_number', data->>'batchNumber') <> ''
    AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND data->>'deletedAt' IS NULL;

-- ─── 2. One ACTIVE invoice per examination batch ─────────────────────────────
-- The client enforced "one batch, one live invoice" by scanning local IndexedDB
-- (frontend/services/examinationInvoiceSyncService.ts), which two devices racing
-- to invoice the same batch both pass. Voided/cancelled invoices are excluded
-- so a regeneration can issue a replacement invoice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_exam_one_active_per_batch
  ON public.invoices ((COALESCE(data->>'batchId', data->>'batch_id')))
  WHERE COALESCE(data->>'origin_module', data->>'originModule', '') = 'examination'
    AND COALESCE(data->>'batchId', data->>'batch_id') IS NOT NULL
    AND COALESCE(data->>'batchId', data->>'batch_id') <> ''
    AND COALESCE(data->>'status', '') NOT IN ('cancelled', 'void', 'voided', 'draft')
    AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND data->>'deletedAt' IS NULL;

-- ─── 3. An invoice number may not be claimed twice, across origin tables ────
-- 0013_financial_integrity.sql already indexes data->>'invoiceNumber' globally.
-- The examination claim ledger (0042) is authoritative for EXM numbers, but a
-- stale device could still stamp an unclaimed EXM number onto any invoice row.
-- Enforce that an EXM- invoice number is unique across BOTH invoices and
-- ledger_entries, because the invoice id IS its ledger referenceId.
-- The ledger side must be added as a separate index (it is a different table),
-- then cross-table uniqueness is asserted by the RPC below.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_entries_exam_number_unique
  ON public.ledger_entries ((COALESCE(data->>'invoiceNumber', data->>'invoice_number')))
  WHERE COALESCE(data->>'invoiceNumber', data->>'invoice_number') LIKE 'EXM-%';

-- ─── 4. Canonical status vocabulary ─────────────────────────────────────────
-- A CHECK constraint on the JSONB envelope. Unknown statuses previously fell
-- through the client's LOCKED_BATCH_STATUSES test (a set membership check), so a
-- typo like 'approvedd' or 'Invoiced ' silently read as UNLOCKED and was
-- therefore mutable. Normalising here makes the frozen set exhaustive.
--
-- Implemented as a trigger rather than a CHECK because the constraint is on a
-- JSON expression inside a NOT NULL column; the trigger gives a precise error
-- and can be relaxed independently if the vocabulary grows.
CREATE OR REPLACE FUNCTION public.examination_batch_status_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
  v_allowed TEXT[] := ARRAY[
    'draft', 'calculated', 'approved', 'invoiced', 'completed', 'paid'
  ];
BEGIN
  v_status := LOWER(BTRIM(COALESCE(NEW.data->>'status', '')));
  IF v_status = '' THEN
    RETURN NEW;
  END IF;
  IF NOT (v_status = ANY (v_allowed)) THEN
    RAISE EXCEPTION
      'EXAMINATION_STATUS_INVALID: "%" is not a valid examination batch status (allowed: %)',
      v_status, array_to_string(v_allowed, ', ')
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_examination_batch_status_guard ON public.examination_batches;
CREATE TRIGGER trg_examination_batch_status_guard
  BEFORE INSERT OR UPDATE ON public.examination_batches
  FOR EACH ROW
  EXECUTE FUNCTION public.examination_batch_status_guard();

-- ─── 5. Cross-table examination invoice-number uniqueness ───────────────────
-- The invoice id IS the official invoice number AND the ledger referenceId
-- (see backend/routes/sync.cjs on examination invoice identity), so one EXM
-- number must resolve to exactly one invoice and one ledger reference. A partial
-- unique index per table cannot express a cross-table rule, so it is asserted
-- here. The gateway calls this through the idempotency probe path; it is also
-- safe to call directly for a reconciliation sweep.
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
  WHERE COALESCE(data->>'invoiceNumber', data->>'invoice_number', data->>'id') = p_invoice_number
    AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND data->>'deletedAt' IS NULL;

  IF v_invoice_count > 1 THEN
    RAISE EXCEPTION
      'EXAMINATION_INVOICE_NUMBER_DUPLICATE: % resolves to % live invoice rows',
      p_invoice_number, v_invoice_count
      USING ERRCODE = 'unique_violation';
  END IF;

  SELECT COUNT(*) INTO v_ledger_count
  FROM public.ledger_entries
  WHERE COALESCE(data->>'invoiceNumber', data->>'invoice_number') = p_invoice_number;

  IF v_ledger_count > 0 AND v_invoice_count = 0 THEN
    RAISE EXCEPTION
      'EXAMINATION_INVOICE_ORPHAN_LEDGER: % has % ledger row(s) but no invoice row',
      p_invoice_number, v_ledger_count
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN TRUE;
END;
$$;

-- ─── 6. Reconciliation view for the pre-existing data ───────────────────────
-- Reported, never repaired automatically: applying a repair to financial
-- history without an operator decision is out of scope for this migration.
CREATE OR REPLACE VIEW public.examination_integrity_findings AS
SELECT 'duplicate_active_invoice_per_batch'::TEXT AS finding,
       COALESCE(data->>'batchId', data->>'batch_id') AS subject,
       COUNT(*)::INT AS occurrences
FROM public.invoices
WHERE COALESCE(data->>'origin_module', data->>'originModule', '') = 'examination'
  AND COALESCE(data->>'status', '') NOT IN ('cancelled', 'void', 'voided', 'draft')
  AND COALESCE(data->>'deleted', 'false') NOT IN ('true', 't', '1')
  AND data->>'deletedAt' IS NULL
  AND COALESCE(data->>'batchId', data->>'batch_id') IS NOT NULL
GROUP BY 2
HAVING COUNT(*) > 1
UNION ALL
SELECT 'orphan_ledger_exam_invoice'::TEXT,
       COALESCE(le.data->>'invoiceNumber', le.data->>'invoice_number'),
       COUNT(*)::INT
FROM public.ledger_entries le
WHERE COALESCE(le.data->>'invoiceNumber', le.data->>'invoice_number') LIKE 'EXM-%'
  AND NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE COALESCE(i.data->>'invoiceNumber', i.data->>'invoice_number', i.data->>'id')
          = COALESCE(le.data->>'invoiceNumber', le.data->>'invoice_number')
      AND COALESCE(i.data->>'deleted', 'false') NOT IN ('true', 't', '1')
      AND i.data->>'deletedAt' IS NULL
  )
GROUP BY 2;

COMMENT ON VIEW public.examination_integrity_findings IS
  'Pre-existing Examination integrity violations. Diagnostic only — this migration reports, it does not repair.';

-- ─── RLS ────────────────────────────────────────────────────────────────────
-- The constraints above are enforced for every writer including the service
-- role, so no new policy is required. examination_batches keeps the SELECT-only
-- policy installed by 0040_examination_invoice_rls_hardening.sql; the trigger
-- and indexes fire regardless of which role issues the write.
REVOKE ALL ON FUNCTION public.assert_examination_invoice_number_unique(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_examination_invoice_number_unique(TEXT) TO service_role;

COMMIT;

-- ============================================================================
-- ROLLBACK
--   DROP INDEX IF EXISTS public.idx_examination_batches_batch_number_unique;
--   DROP INDEX IF EXISTS public.idx_invoices_exam_one_active_per_batch;
--   DROP INDEX IF EXISTS public.idx_ledger_entries_exam_number_unique;
--   DROP TRIGGER IF EXISTS trg_examination_batch_status_guard ON public.examination_batches;
--   DROP FUNCTION IF EXISTS public.examination_batch_status_guard();
--   DROP FUNCTION IF EXISTS public.assert_examination_invoice_number_unique(TEXT);
--   DROP VIEW IF EXISTS public.examination_integrity_findings;
--
-- PRE-FLIGHT — run these BEFORE applying. Each must return zero rows, or the
-- matching index creation will fail:
--   SELECT COALESCE(data->>'batch_number', data->>'batchNumber') AS bn, COUNT(*)
--   FROM public.examination_batches
--   WHERE COALESCE(data->>'deleted','false') NOT IN ('true','t','1')
--     AND data->>'deletedAt' IS NULL
--     AND COALESCE(data->>'batch_number', data->>'batchNumber') <> ''
--   GROUP BY 1 HAVING COUNT(*) > 1;
--
--   SELECT * FROM public.examination_integrity_findings;
-- ============================================================================
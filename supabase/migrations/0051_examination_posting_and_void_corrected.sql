-- ============================================================================
-- 0051_examination_posting_and_void.sql
--
-- Server-authoritative Examination invoice posting and void/reversal.
-- Additive only, idempotent (IF NOT EXISTS / OR REPLACE), wrapped in BEGIN/COMMIT
-- so a failure leaves nothing half-written.
--
-- NOT APPLIED TO PRODUCTION by this change. Apply only after running the
-- PRE-FLIGHT block in 0050 against a disposable copy of production-shaped data
-- and after the integration suite passes against real PostgreSQL.
--
-- Why this exists
-- ---------------
-- The canonical Examination posting path is CLIENT-SIDE: the browser claims an
-- EXM number, derives amounts, and writes the invoice + ledger rows into
-- IndexedDB, which later mirror to Supabase through the generic
-- POST /api/sync/ops envelope gateway. That gateway applies NO Examination
-- business rules (only portal_ads / products / assessment_contracts have
-- validators), and the client-side guard it replaces
-- (examinationBatchService.assertBatchMutable) reads only that device's
-- IndexedDB copy. Two devices offline can therefore both invoice one batch.
--
-- These RPCs move the decision into PostgreSQL, where it can be enforced
-- atomically against authoritative state. They follow the established
-- server-atomic pattern of 0048_printing_contracts_server_atomicity.sql:
-- SELECT ... FOR UPDATE, all writes in one transaction, deterministic ids for
-- idempotency, and exceptions that map to a client-visible code.
--
-- Envelope convention (see 0001): examination_batches / invoices / ledger_entries
-- are { id, data JSONB, created_at, updated_at, version }.
--
-- Accounting model is UNCHANGED. Examination posts exactly one balanced pair,
-- identical to what the client already produces in
-- transactionService.processInvoice: DR accounts receivable (11310) /
-- CR service income (41200). Examination invoices carry no tax and no COGS
-- (their lines are type 'Service', which _executeDeductInventory skips). No new
-- account, no tax behaviour and no issuance behaviour is introduced here.
--
-- Batch reissue policy (deliberate, and enforced below)
-- ----------------------------------------------------
-- Voiding does NOT clear batch.invoice_id and does NOT reset the batch to
-- 'approved'. The batch stays closed with its original invoice identity and
-- number permanently attached. The void records a linked voided_invoice_id and
-- voided_at. Reissue is a separate, audited workflow that must allocate a NEW
-- identity and number; it is not performed by this migration.
-- ============================================================================

BEGIN;

-- ─── 1. Durable posting operation state ─────────────────────────────────────
-- Records intent BEFORE the effects and the committed result after them, so a
-- client that times out mid-request can be told what actually happened on retry
-- instead of re-posting. (operation, idempotency_key) is unique, which is what
-- makes a repeated request with the same key collapse to one posting.
CREATE TABLE IF NOT EXISTS public.examination_postings (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  batch_id TEXT,
  invoice_number TEXT,
  state TEXT NOT NULL DEFAULT 'PENDING',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT examination_postings_operation_ck
    CHECK (operation IN ('POST', 'VOID')),
  CONSTRAINT examination_postings_state_ck
    CHECK (state IN ('PENDING', 'COMMITTED', 'FAILED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_examination_postings_idempotency
  ON public.examination_postings (operation, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_examination_postings_invoice
  ON public.examination_postings (invoice_number);

-- One COMMITTED POST per batch. This is the constraint that makes two devices
-- racing to invoice the same batch impossible to satisfy: the second INSERT
-- violates the unique index and the caller's transaction rolls back.
CREATE UNIQUE INDEX IF NOT EXISTS idx_examination_postings_one_post_per_batch
  ON public.examination_postings (batch_id)
  WHERE operation = 'POST' AND state = 'COMMITTED';

CREATE INDEX IF NOT EXISTS idx_examination_postings_pending
  ON public.examination_postings (state)
  WHERE state = 'PENDING';

-- ─── 2. Authoritative posting ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_examination_invoice_atomic(
  p_batch_id            TEXT,
  p_invoice_number      TEXT,
  p_idempotency_key     TEXT,
  p_invoice_data        JSONB,
  p_ledger_data         JSONB,
  p_expected_version    INTEGER DEFAULT NULL,
  p_business_date       DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_batch        RECORD;
  v_status       TEXT;
  v_existing     RECORD;
  v_result       JSONB;
  v_snapshot     JSONB;
  v_frozen_total NUMERIC;
  v_invoice_total NUMERIC;
  v_new_version  INTEGER;
BEGIN
  -- ── Input validation (fail closed) ────────────────────────────────────────
  IF p_batch_id IS NULL OR p_batch_id = '' THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: batchId is required';
  END IF;
  IF p_invoice_number IS NULL OR p_invoice_number NOT LIKE 'EXM-%' THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: an examination invoice number must be an EXM- identity, got %',
      COALESCE(p_invoice_number, 'null');
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: an idempotency key is required';
  END IF;
  IF p_invoice_data IS NULL OR jsonb_typeof(p_invoice_data) <> 'object' THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: invoiceData must be a JSON object';
  END IF;
  IF p_ledger_data IS NULL OR jsonb_typeof(p_ledger_data) <> 'object' THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: ledgerData must be a JSON object';
  END IF;

  -- ── Idempotent replay: same key, already committed → return the SAME result ─
  SELECT * INTO v_existing
  FROM public.examination_postings
  WHERE operation = 'POST' AND idempotency_key = p_idempotency_key;

  IF FOUND AND v_existing.state = 'COMMITTED' THEN
    RETURN (v_existing.result || jsonb_build_object('replayed', true));
  END IF;

  -- ── Lock the batch. Everything below is decided against this row only. ─────
  SELECT * INTO v_batch
  FROM public.examination_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXAM_POST_BATCH_MISSING: no examination batch %', p_batch_id
      USING ERRCODE = 'no_data_found';
  END IF;

  v_status := LOWER(BTRIM(COALESCE(v_batch.data->>'status', '')));

  -- A stale device must not post against a batch it never saw approved.
  IF p_expected_version IS NOT NULL
     AND p_expected_version IS DISTINCT FROM v_batch.version THEN
    RAISE EXCEPTION 'EXAM_POST_VERSION_CONFLICT: batch % is at version %, caller expected %',
      p_batch_id, v_batch.version, p_expected_version
      USING ERRCODE = '40001';
  END IF;

  IF v_status NOT IN ('approved', 'invoiced') THEN
    RAISE EXCEPTION 'EXAM_POST_STATUS_INVALID: batch % is %, only approved batches can be invoiced',
      p_batch_id, v_status;
  END IF;

  -- ── Already invoiced. Return the committed invoice; never issue a second. ──
  IF v_status = 'invoiced' AND NULLIF(BTRIM(COALESCE(v_batch.data->>'invoice_id', '')), '') IS NOT NULL THEN
    IF v_batch.data->>'invoice_id' = p_invoice_number THEN
      -- Same identity: idempotent success.
      SELECT * INTO v_existing
      FROM public.examination_postings
      WHERE operation = 'POST' AND batch_id = p_batch_id AND state = 'COMMITTED'
      LIMIT 1;

      IF FOUND THEN
        RETURN (v_existing.result || jsonb_build_object('replayed', true));
      END IF;

      RETURN jsonb_build_object(
        'invoiceNumber', v_batch.data->>'invoice_id',
        'invoiceId', v_batch.data->>'invoice_id',
        'status', 'committed',
        'batchVersion', v_batch.version,
        'replayed', true
      );
    END IF;

    RAISE EXCEPTION 'EXAM_POST_ALREADY_INVOICED: batch % is already invoiced as %, refusing to issue %',
      p_batch_id, v_batch.data->>'invoice_id', p_invoice_number
      USING ERRCODE = 'unique_violation';
  END IF;

  -- ── Stale-snapshot protection ────────────────────────────────────────────
  -- The invoice total must equal the APPROVED snapshot total. This is the check
  -- that makes "approved pricing is immutable" enforceable server-side: a
  -- device that drifted its local classes cannot bill a different amount.
  v_snapshot := v_batch.data->'pricing_snapshot';
  IF v_snapshot IS NULL OR jsonb_typeof(v_snapshot) <> 'object' THEN
    RAISE EXCEPTION 'EXAM_POST_NO_SNAPSHOT: batch % has no approved pricing snapshot', p_batch_id;
  END IF;

  v_frozen_total := NULLIF(TRIM(BOTH COALESCE(v_snapshot->'result'->>'totalAmount', '')), '')::NUMERIC;
  v_invoice_total := NULLIF(TRIM(BOTH COALESCE(p_invoice_data->>'totalAmount', '')), '')::NUMERIC;

  IF v_frozen_total IS NULL THEN
    RAISE EXCEPTION 'EXAM_POST_NO_SNAPSHOT: batch % snapshot has no result.totalAmount', p_batch_id;
  END IF;
  IF v_invoice_total IS NULL THEN
    RAISE EXCEPTION 'EXAM_POST_INVALID: invoiceData.totalAmount is required';
  END IF;
  IF ABS(v_invoice_total - v_frozen_total) > 0.005 THEN
    RAISE EXCEPTION
      'EXAM_POST_SNAPSHOT_MISMATCH: batch % was approved at % but the invoice is %, refusing to post a repriced invoice',
      p_batch_id, v_frozen_total, v_invoice_total
      USING ERRCODE = 'check_violation';
  END IF;

  -- ── Ledger must be balanced and must agree with the invoice total ─────────
  IF ABS(COALESCE(NULLIF(TRIM(BOTH COALESCE(p_ledger_data->>'amount', '')), '')::NUMERIC, 0)
         - v_invoice_total) > 0.005 THEN
    RAISE EXCEPTION 'EXAM_POST_LEDGER_UNBALANCED: ledger amount does not match the invoice total %', v_invoice_total
      USING ERRCODE = 'check_violation';
  END IF;
  IF NULLIF(BTRIM(COALESCE(p_ledger_data->>'debitAccountId', '')), '') IS NULL
     OR NULLIF(BTRIM(COALESCE(p_ledger_data->>'creditAccountId', '')), '') IS NULL THEN
    RAISE EXCEPTION 'EXAM_POST_LEDGER_UNBALANCED: ledger entry needs both debitAccountId and creditAccountId';
  END IF;

  -- ── Record intent, then commit the effects. Same transaction. ────────────
  INSERT INTO public.examination_postings (
    id, operation, idempotency_key, batch_id, invoice_number, state
  ) VALUES (
    'EXP-' || p_idempotency_key, 'POST', p_idempotency_key, p_batch_id, p_invoice_number, 'PENDING'
  )
  ON CONFLICT (operation, idempotency_key) DO NOTHING;

  -- Canonical invoice. id IS the invoice number (established identity contract).
  INSERT INTO public.invoices (id, data, created_at, updated_at, version)
  VALUES (
    p_invoice_number,
    p_invoice_data
      || jsonb_build_object(
           'id', p_invoice_number,
           'invoiceNumber', p_invoice_number,
           'origin_module', 'examination',
           'batchId', COALESCE(NULLIF(BTRIM(COALESCE(v_batch.data->>'batch_number', '')), ''), p_batch_id),
           'idempotencyKey', p_idempotency_key,
           'status', COALESCE(p_invoice_data->>'status', 'Unpaid'),
           'postedBy', 'server',
           'postedAt', NOW()::TEXT
         ),
    NOW(), NOW(), 1
  )
  ON CONFLICT (id) DO NOTHING;

  -- Canonical ledger entry. referenceId == invoice id == EXM number.
  INSERT INTO public.ledger_entries (id, data, created_at, updated_at, version)
  VALUES (
    COALESCE(NULLIF(BTRIM(COALESCE(p_ledger_data->>'id', '')), ''), 'LG-INV-' || p_invoice_number),
    p_ledger_data
      || jsonb_build_object(
           'referenceId', p_invoice_number,
           'invoiceNumber', p_invoice_number,
           'originModule', 'examination',
           'idempotencyKey', p_idempotency_key
         ),
    NOW(), NOW(), 1
  )
  ON CONFLICT (id) DO NOTHING;

  -- Close the batch onto the immutable invoice identity.
  v_new_version := v_batch.version + 1;
  UPDATE public.examination_batches
     SET data = data || jsonb_build_object(
                   'status', 'invoiced',
                   'invoice_id', p_invoice_number,
                   'posted_at', NOW()::TEXT
                 ),
         version = v_new_version,
         updated_at = NOW()
   WHERE id = p_batch_id;

  v_result := jsonb_build_object(
    'invoiceNumber', p_invoice_number,
    'invoiceId', p_invoice_number,
    'totalAmount', v_invoice_total,
    'status', 'committed',
    'batchVersion', v_new_version,
    'postedAt', NOW()::TEXT,
    'replayed', false
  );

  UPDATE public.examination_postings
     SET state = 'COMMITTED',
         result = v_result,
         updated_at = NOW()
   WHERE operation = 'POST' AND idempotency_key = p_idempotency_key;

  RETURN v_result;
END;
$$;

-- ─── 3. Authoritative void + reversal ───────────────────────────────────────
-- Reversal identities are DETERMINISTIC (derived from the original entry id),
-- so a repeated void finds them already present and cannot double-reverse.
-- Original entries are marked with a reversal link using a compare-and-swap
-- predicate, so two concurrent voids cannot both claim the same entry.
CREATE OR REPLACE FUNCTION public.void_examination_invoice_atomic(
  p_batch_id          TEXT,
  p_invoice_number    TEXT,
  p_idempotency_key   TEXT,
  p_void_reason       TEXT,
  p_performed_by      TEXT DEFAULT 'system',
  p_deduction_ids     TEXT[] DEFAULT NULL,
  p_business_date     DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice       RECORD;
  v_batch         RECORD;
  v_existing      RECORD;
  v_entry         RECORD;
  v_reversed      INT := 0;
  v_skipped       INT := 0;
  v_stock         INT := 0;
  v_deduction     RECORD;
  v_deduction_row JSONB;
  v_line          JSONB;
  v_result        JSONB;
  v_amount        NUMERIC;
BEGIN
  IF p_invoice_number IS NULL OR p_invoice_number NOT LIKE 'EXM-%' THEN
    RAISE EXCEPTION 'EXAM_VOID_INVALID: an examination invoice number must be an EXM- identity';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN
    RAISE EXCEPTION 'EXAM_VOID_INVALID: an idempotency key is required';
  END IF;

  -- ── Idempotent replay ─────────────────────────────────────────────────────
  SELECT * INTO v_existing
  FROM public.examination_postings
  WHERE operation = 'VOID' AND idempotency_key = p_idempotency_key;

  IF FOUND AND v_existing.state = 'COMMITTED' THEN
    RETURN (v_existing.result || jsonb_build_object('replayed', true));
  END IF;

  -- ── Lock invoice, then batch. Fixed order, so concurrent voids serialise. ─
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_number
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'EXAM_VOID_INVOICE_MISSING: no invoice %', p_invoice_number
      USING ERRCODE = 'no_data_found';
  END IF;

  IF LOWER(BTRIM(COALESCE(v_invoice.data->>'status', ''))) IN ('cancelled', 'void', 'voided') THEN
    RAISE EXCEPTION 'EXAM_VOID_ALREADY_VOID: invoice % is already voided', p_invoice_number;
  END IF;

  IF COALESCE(NULLIF(BTRIM(COALESCE(v_invoice.data->>'paidAmount', '')), '')::NUMERIC, 0) > 0.005 THEN
    RAISE EXCEPTION 'EXAM_VOID_HAS_PAYMENTS: invoice % has payments against it; reverse the payments first',
      p_invoice_number;
  END IF;

  IF p_batch_id IS NOT NULL AND p_batch_id <> '' THEN
    SELECT * INTO v_batch
    FROM public.examination_batches
    WHERE id = p_batch_id
    FOR UPDATE;
  END IF;

  INSERT INTO public.examination_postings (
    id, operation, idempotency_key, batch_id, invoice_number, state
  ) VALUES (
    'EXV-' || p_idempotency_key, 'VOID', p_idempotency_key, p_batch_id, p_invoice_number, 'PENDING'
  )
  ON CONFLICT (operation, idempotency_key) DO NOTHING;

  -- ── Ledger reversal: swap debit/credit, keep amount and accounts ──────────
  FOR v_entry IN
    SELECT id, data FROM public.ledger_entries
     WHERE data->>'referenceId' = p_invoice_number
       AND data->>'reversalEntryId' IS NULL
       AND data->>'originModule' IS DISTINCT FROM 'examination_reversal'
     FOR UPDATE
  LOOP
    v_amount := NULLIF(TRIM(BOTH COALESCE(v_entry.data->>'amount', '')), '')::NUMERIC;
    IF v_amount IS NULL THEN
      RAISE EXCEPTION 'EXAM_VOID_ENTRY_INVALID: ledger entry % has no amount', v_entry.id;
    END IF;

    INSERT INTO public.ledger_entries (id, data, created_at, updated_at, version)
    VALUES (
      'LG-REV-' || v_entry.id,
      (v_entry.data - 'id' - 'reversedBy' - 'reversalEntryId')
        || jsonb_build_object(
             'id', 'LG-REV-' || v_entry.id,
             'debitAccountId', v_entry.data->>'creditAccountId',
             'creditAccountId', v_entry.data->>'debitAccountId',
             'amount', v_amount,
             'referenceId', p_invoice_number,
             'invoiceNumber', p_invoice_number,
             'originModule', 'examination_reversal',
             'reversesEntryId', v_entry.id,
             'description', 'REVERSAL: ' || COALESCE(v_entry.data->>'description', 'examination invoice'),
             'voidReason', p_void_reason,
             'idempotencyKey', p_idempotency_key
           ),
      NOW(), NOW(), 1
    )
    ON CONFLICT (id) DO NOTHING;

    -- Compare-and-swap the link so a concurrent void cannot claim this entry
    -- twice. Reversed rows are excluded by the FOR UPDATE query above, so this
    -- only ever transitions an unreversed entry.
    UPDATE public.ledger_entries
       SET data = data || jsonb_build_object(
                     'reversalEntryId', 'LG-REV-' || v_entry.id,
                     'reversedAt', NOW()::TEXT
                   ),
           updated_at = NOW()
     WHERE id = v_entry.id
       AND data->>'reversalEntryId' IS NULL;

    IF FOUND THEN
      v_reversed := v_reversed + 1;
    ELSE
      v_skipped := v_skipped + 1;
    END IF;
  END LOOP;

  -- ── Inventory reversal ───────────────────────────────────────────────────
  -- ONLY movements that were actually recorded are reversed, using the recorded
  -- line quantities. No deduction ids were supplied -> nothing is credited.
  -- Examination INVOICE lines are type 'Service' and were never deducted, so no
  -- invoice line is ever credited here. Only real production-consumption
  -- deductions are.
  IF p_deduction_ids IS NOT NULL AND array_length(p_deduction_ids, 1) > 0 THEN
    FOR v_deduction IN
      SELECT * FROM public.examination_inventory_deductions
       WHERE id = ANY (p_deduction_ids)
       FOR UPDATE
    LOOP
      v_deduction_row := v_deduction.data;

      IF v_deduction_row->>'voidedBy' IS NOT NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      FOR v_line IN
        SELECT * FROM jsonb_array_elements(
          COALESCE(v_deduction_row->'lines', '[]'::jsonb)
        )
      LOOP
        IF NULLIF(BTRIM(COALESCE(v_line->>'item_id', '')), '') IS NULL THEN
          CONTINUE;
        END IF;
        IF COALESCE(NULLIF(TRIM(BOTH COALESCE(v_line->>'quantity', '')), '')::NUMERIC, 0) <= 0 THEN
          CONTINUE;
        END IF;

        -- Mark the movement reversed FIRST (compare-and-swap on the deduction),
        -- so a crash after the credit but before commit cannot double-credit.
        UPDATE public.examination_inventory_deductions
           SET data = data || jsonb_build_object(
                         'voidedBy', p_invoice_number,
                         'voidedAt', NOW()::TEXT,
                         'voidReason', p_void_reason
                       ),
               updated_at = NOW()
         WHERE id = v_deduction.id
           AND data->>'voidedBy' IS NULL;

        IF FOUND THEN
          v_stock := v_stock + 1;
        ELSE
          v_skipped := v_skipped + 1;
        END IF;
      END LOOP;
    END LOOP;
  END IF;

  -- ── Invoice: voided but RETAINED. History is never deleted. ──────────────
  UPDATE public.invoices
     SET data = data || jsonb_build_object(
                   'status', 'cancelled',
                   'voided', true,
                   'voidReason', COALESCE(p_void_reason, 'Voided'),
                   'voidedBy', COALESCE(p_performed_by, 'system'),
                   'voidedAt', NOW()::TEXT,
                   'voidIdempotencyKey', p_idempotency_key
                 ),
         updated_at = NOW()
   WHERE id = p_invoice_number;

  -- ── Batch: stays CLOSED. invoice_id is intentionally NOT cleared and the
  --    status is intentionally NOT reset to 'approved'. The batch keeps its
  --    original invoice identity and number forever.
  IF FOUND AND v_batch.id IS NOT NULL THEN
    UPDATE public.examination_batches
       SET data = data || jsonb_build_object(
                     'voided_invoice_id', p_invoice_number,
                     'voided_at', NOW()::TEXT,
                     'void_reason', COALESCE(p_void_reason, 'Voided'),
                     'reissue_allowed', true
                   ),
           updated_at = NOW()
     WHERE id = v_batch.id;
  END IF;

  v_result := jsonb_build_object(
    'invoiceNumber', p_invoice_number,
    'status', 'voided',
    'ledgerEntriesReversed', v_reversed,
    'inventoryMovementsReversed', v_stock,
    'skipped', v_skipped,
    'batchStatus', 'invoiced',
    'batchClosed', true,
    'voidedAt', NOW()::TEXT,
    'replayed', false
  );

  UPDATE public.examination_postings
     SET state = 'COMMITTED', result = v_result, updated_at = NOW()
   WHERE operation = 'VOID' AND idempotency_key = p_idempotency_key;

  RETURN v_result;
END;
$$;

-- ─── 4. Reconciliation view ─────────────────────────────────────────────────
-- Operational, not a repair: surfaces postings that claim PENDING (client timed
-- out and we cannot tell whether it committed), batches invoiced with no
-- posting record, and ledger references with no invoice.
CREATE OR REPLACE VIEW public.examination_posting_findings AS
SELECT 'posting_stuck_pending'::TEXT AS finding,
       p.id::TEXT AS subject,
       jsonb_build_object('operation', p.operation, 'invoice', p.invoice_number, 'ageSeconds',
         EXTRACT(EPOCH FROM (NOW() - p.created_at))::BIGINT) AS detail
  FROM public.examination_postings p
 WHERE p.state = 'PENDING'
UNION ALL
SELECT 'batched_invoiced_without_posting',
       b.id::TEXT,
       jsonb_build_object('invoice', b.data->>'invoice_id', 'status', b.data->>'status')
  FROM public.examination_batches b
 WHERE LOWER(BTRIM(COALESCE(b.data->>'status',''))) IN ('invoiced','completed')
   AND NULLIF(BTRIM(COALESCE(b.data->>'invoice_id','')), '') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.examination_postings p
      WHERE p.operation = 'POST' AND p.state = 'COMMITTED'
        AND p.batch_id = b.id
   )
UNION ALL
SELECT 'ledger_reference_without_invoice',
       le.data->>'referenceId',
       jsonb_build_object('entryId', le.id, 'module', le.data->>'originModule')
  FROM public.ledger_entries le
 WHERE le.data->>'originModule' = 'examination'
   AND NULLIF(BTRIM(COALESCE(le.data->>'referenceId','')), '') IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.invoices i
      WHERE i.id = le.data->>'referenceId'
        AND COALESCE(i.data->>'deleted','false') NOT IN ('true','t','1')
        AND i.data->>'deletedAt' IS NULL
   );

COMMENT ON VIEW public.examination_posting_findings IS
  'Examination posting reconciliation. Diagnostic only — reports, never repairs.';

-- ─── 5. RLS and privileges ──────────────────────────────────────────────────
-- These functions are the authoritative financial boundary, so they are
-- service-role only. No authenticated client may post or void an examination
-- invoice directly; the gateway calls them with the service key.
REVOKE ALL ON FUNCTION public.post_examination_invoice_atomic(TEXT,TEXT,TEXT,JSONB,JSONB,INTEGER,DATE) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.void_examination_invoice_atomic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.post_examination_invoice_atomic(TEXT,TEXT,TEXT,JSONB,JSONB,INTEGER,DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.void_examination_invoice_atomic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],DATE) TO service_role;

-- examination_postings carries invoice identities and posting state: no policy
-- for authenticated roles, service-role access only (same posture as
-- examination_invoice_number_claims in 0042).
ALTER TABLE public.examination_postings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.examination_postings FROM PUBLIC, anon, authenticated;

COMMIT;

-- ============================================================================
-- ROLLBACK
--   DROP VIEW IF EXISTS public.examination_posting_findings;
--   DROP FUNCTION IF EXISTS public.void_examination_invoice_atomic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],DATE);
--   DROP FUNCTION IF EXISTS public.post_examination_invoice_atomic(TEXT,TEXT,TEXT,JSONB,JSONB,INTEGER,DATE);
--   DROP TABLE IF EXISTS public.examination_postings;
--
-- PRE-FLIGHT (run against a disposable copy BEFORE applying)
--   -- 1. Any duplicate live EXM numbers would break 0050's unique indexes:
--   SELECT * FROM public.examination_integrity_findings;
--   -- 2. examination_inventory_deductions must exist for the void's reversal:
--   SELECT to_regclass('public.examination_inventory_deductions');
--   -- 3. A batch already invoiced would gain a fresh (correct) posting record;
--   --    confirm the count is understood before backfilling:
--   SELECT COUNT(*) FROM public.examination_batches
--    WHERE lower(btrim(coalesce(data->>'status',''))) = 'invoiced';
-- ============================================================================
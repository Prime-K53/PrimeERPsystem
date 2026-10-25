-- ============================================================================
-- 0060_examination_orphan_reconciliation.sql
--
-- Non-destructive reconciliation tooling for pre-existing Examination ledger
-- orphans.
--
-- Live evidence (2026-10-23 audit):
--   EXM-P726/021   40 rows   net AR  0
--   EXM-P726/022    2 rows   net AR  750,250
--   EXM-P726/023    1 row    net AR    5,000
--   Total                    net AR  755,250
--
-- Those rows have no invoice. They are financial history, so this migration
-- deliberately does NOT delete them, reverse them, or write them off. Instead
-- it provides:
--
--   1. `examination_orphan_ledger_reconciliation` — one row per orphaned EXM
--      reference with the net AR impact computed from the AR account, the
--      customers/modules involved, claim state, and the latest operator
--      decision.
--   2. `examination_reconciliation_decisions` — an append-only record of the
--      explicit decision an operator makes for each reference.
--   3. `record_examination_reconciliation_decision(...)` — service-role-only
--      RPC that records that decision. It never mutates the ledger.
--
-- Applying a write-off/link remains a separate, reviewed operation after the
-- decision is recorded.
--
-- CREATED — NOT YET APPLIED to the live project.
--
-- PRE-FLIGHT (read-only)
--   SELECT * FROM public.examination_orphan_ledger_reconciliation
--    ORDER BY ABS(net_ar_impact) DESC;
-- ============================================================================

BEGIN;

-- ─── 1. Append-only operator decision log ───────────────────────────────────
CREATE TABLE IF NOT EXISTS public.examination_reconciliation_decisions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  finding TEXT NOT NULL DEFAULT 'orphan_ledger_exam_invoice',
  subject TEXT NOT NULL,
  decision TEXT NOT NULL,
  linked_invoice_number TEXT,
  rationale TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT examination_reconciliation_decisions_decision_ck
    CHECK (decision IN ('WRITE_OFF', 'LINK_TO_INVOICE', 'RETAIN_AS_HISTORY', 'IGNORE')),
  CONSTRAINT examination_reconciliation_decisions_link_ck
    CHECK (decision <> 'LINK_TO_INVOICE' OR linked_invoice_number IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_examination_reconciliation_decisions_subject
  ON public.examination_reconciliation_decisions (subject, decided_at DESC);

ALTER TABLE public.examination_reconciliation_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.examination_reconciliation_decisions FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.examination_reconciliation_decisions TO service_role;

-- Decisions are evidence: correct a mistake by appending a new decision, never
-- by editing or deleting the prior one.
CREATE OR REPLACE FUNCTION public.examination_reconciliation_decision_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'EXAM_RECONCILIATION_DECISION_IMMUTABLE: append a new decision instead of changing history';
END;
$$;

DROP TRIGGER IF EXISTS trg_examination_reconciliation_decision_immutable
  ON public.examination_reconciliation_decisions;
CREATE TRIGGER trg_examination_reconciliation_decision_immutable
  BEFORE UPDATE OR DELETE ON public.examination_reconciliation_decisions
  FOR EACH ROW
  EXECUTE FUNCTION public.examination_reconciliation_decision_immutable();

-- ─── 2. Orphan report: AR impact from the AR account, not descriptions ──────
CREATE OR REPLACE VIEW public.examination_orphan_ledger_reconciliation AS
WITH ar_accounts AS (
  SELECT id
  FROM public.accounts
  WHERE COALESCE(data->>'code', data->>'accountNumber', data->>'account_number') = '11310'
),
live_invoices AS (
  SELECT
    i.id,
    COALESCE(i.data->>'invoiceNumber', i.data->>'invoice_number', i.id) AS invoice_number
  FROM public.invoices i
  WHERE COALESCE(i.data->>'deleted', 'false') NOT IN ('true', 't', '1')
    AND i.data->>'deletedAt' IS NULL
),
orphans AS (
  SELECT
    COALESCE(
      le.data->>'referenceId',
      le.data->>'reference_id',
      le.data->>'invoiceNumber',
      le.data->>'invoice_number'
    ) AS invoice_number,
    COUNT(*)::INT AS ledger_rows,
    (
      SUM(CASE WHEN le.data->>'debitAccountId' IN (SELECT id FROM ar_accounts)
               THEN COALESCE(NULLIF(le.data->>'amount', '')::NUMERIC, 0) ELSE 0 END)
      - SUM(CASE WHEN le.data->>'creditAccountId' IN (SELECT id FROM ar_accounts)
                THEN COALESCE(NULLIF(le.data->>'amount', '')::NUMERIC, 0) ELSE 0 END)
    )::NUMERIC(18, 2) AS net_ar_impact,
    jsonb_agg(
      jsonb_build_object(
        'entryId', le.id,
        'date', COALESCE(le.data->>'date', le.data->>'createdAt', le.created_at::TEXT),
        'debitAccountId', le.data->>'debitAccountId',
        'creditAccountId', le.data->>'creditAccountId',
        'amount', le.data->>'amount',
        'customerId', le.data->>'customerId',
        'customerName', le.data->>'customerName',
        'description', le.data->>'description',
        'originModule', COALESCE(le.data->>'originModule', le.data->>'origin_module'),
        'reversesEntryId', le.data->>'reversesEntryId',
        'reversalEntryId', le.data->>'reversalEntryId'
      )
      ORDER BY COALESCE(le.data->>'date', le.created_at::TEXT), le.id
    ) AS ledger_detail,
    jsonb_agg(DISTINCT COALESCE(NULLIF(BTRIM(COALESCE(le.data->>'customerName', '')), ''), 'Unknown')) AS customers,
    jsonb_agg(DISTINCT COALESCE(NULLIF(BTRIM(COALESCE(le.data->>'customerId', '')), ''), 'UNKNOWN')) AS customer_ids,
    jsonb_agg(DISTINCT COALESCE(le.data->>'originModule', le.data->>'origin_module', 'legacy')) AS origin_modules,
    MIN(COALESCE(le.data->>'date', le.created_at::TEXT)) AS first_seen,
    MAX(COALESCE(le.data->>'date', le.created_at::TEXT)) AS last_seen
  FROM public.ledger_entries le
  WHERE COALESCE(
          le.data->>'referenceId',
          le.data->>'reference_id',
          le.data->>'invoiceNumber',
          le.data->>'invoice_number'
        ) LIKE 'EXM-%'
    AND NOT EXISTS (
      SELECT 1
      FROM live_invoices i
      WHERE i.id = COALESCE(
              le.data->>'referenceId',
              le.data->>'reference_id',
              le.data->>'invoiceNumber',
              le.data->>'invoice_number'
            )
         OR i.invoice_number = COALESCE(
              le.data->>'referenceId',
              le.data->>'reference_id',
              le.data->>'invoiceNumber',
              le.data->>'invoice_number'
            )
    )
  GROUP BY COALESCE(
    le.data->>'referenceId',
    le.data->>'reference_id',
    le.data->>'invoiceNumber',
    le.data->>'invoice_number'
  )
)
SELECT
  o.invoice_number,
  o.ledger_rows,
  o.net_ar_impact,
  o.customers,
  o.customer_ids,
  o.origin_modules,
  o.first_seen,
  o.last_seen,
  EXISTS (
    SELECT 1
    FROM public.examination_invoice_number_claims c
    WHERE c.invoice_number = o.invoice_number
  ) AS number_claimed,
  d.decision AS latest_decision,
  d.linked_invoice_number,
  d.rationale AS decision_rationale,
  d.decided_by,
  d.decided_at,
  CASE
    WHEN d.decision IS NULL THEN 'AWAITING_OPERATOR_DECISION'
    ELSE d.decision
  END AS reconciliation_status,
  o.ledger_detail
FROM orphans o
LEFT JOIN LATERAL (
  SELECT *
  FROM public.examination_reconciliation_decisions dec
  WHERE dec.subject = o.invoice_number
  ORDER BY dec.decided_at DESC
  LIMIT 1
) d ON TRUE;

COMMENT ON VIEW public.examination_orphan_ledger_reconciliation IS
  'Examination orphan ledger report. Non-destructive: reports the AR impact and the latest operator decision; never repairs.';

REVOKE ALL ON public.examination_orphan_ledger_reconciliation FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.examination_orphan_ledger_reconciliation TO service_role;

-- ─── 3. Record an operator decision (never mutates the ledger) ──────────────
CREATE OR REPLACE FUNCTION public.record_examination_reconciliation_decision(
  p_subject TEXT,
  p_decision TEXT,
  p_rationale TEXT,
  p_decided_by TEXT,
  p_linked_invoice_number TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_subject TEXT := NULLIF(BTRIM(COALESCE(p_subject, '')), '');
  v_decision TEXT := UPPER(NULLIF(BTRIM(COALESCE(p_decision, '')), ''));
  v_rationale TEXT := NULLIF(BTRIM(COALESCE(p_rationale, '')), '');
  v_decided_by TEXT := NULLIF(BTRIM(COALESCE(p_decided_by, '')), '');
  v_link TEXT := NULLIF(BTRIM(COALESCE(p_linked_invoice_number, '')), '');
  v_id TEXT;
BEGIN
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'EXAM_RECONCILIATION_INVALID: subject is required';
  END IF;
  IF v_rationale IS NULL THEN
    RAISE EXCEPTION 'EXAM_RECONCILIATION_INVALID: a rationale is required';
  END IF;
  IF v_decided_by IS NULL THEN
    RAISE EXCEPTION 'EXAM_RECONCILIATION_INVALID: decided_by is required';
  END IF;
  IF v_decision IS NULL OR v_decision NOT IN (
    'WRITE_OFF', 'LINK_TO_INVOICE', 'RETAIN_AS_HISTORY', 'IGNORE'
  ) THEN
    RAISE EXCEPTION
      'EXAM_RECONCILIATION_INVALID: decision must be WRITE_OFF, LINK_TO_INVOICE, RETAIN_AS_HISTORY or IGNORE';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.examination_orphan_ledger_reconciliation r
    WHERE r.invoice_number = v_subject
  ) THEN
    RAISE EXCEPTION
      'EXAM_RECONCILIATION_NOT_ORPHAN: % is not an outstanding orphaned EXM reference',
      v_subject;
  END IF;

  IF v_decision = 'LINK_TO_INVOICE' THEN
    IF v_link IS NULL THEN
      RAISE EXCEPTION
        'EXAM_RECONCILIATION_INVALID: LINK_TO_INVOICE requires a linked invoice number';
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.invoices i
      WHERE (i.id = v_link OR COALESCE(i.data->>'invoiceNumber', i.data->>'invoice_number') = v_link)
        AND COALESCE(i.data->>'deleted', 'false') NOT IN ('true', 't', '1')
        AND i.data->>'deletedAt' IS NULL
    ) THEN
      RAISE EXCEPTION
        'EXAM_RECONCILIATION_INVALID: linked invoice % does not exist',
        v_link;
    END IF;
  END IF;

  INSERT INTO public.examination_reconciliation_decisions (
    finding, subject, decision, linked_invoice_number, rationale, decided_by
  ) VALUES (
    'orphan_ledger_exam_invoice', v_subject, v_decision, v_link, v_rationale, v_decided_by
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_examination_reconciliation_decision(
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_examination_reconciliation_decision(
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

-- ─── 4. Verification ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.examination_reconciliation_decisions') IS NULL THEN
    RAISE EXCEPTION '0060 verification failed: decision log is missing';
  END IF;
  IF to_regclass('public.examination_orphan_ledger_reconciliation') IS NULL THEN
    RAISE EXCEPTION '0060 verification failed: reconciliation view is missing';
  END IF;
  IF has_function_privilege(
    'anon',
    'public.record_examination_reconciliation_decision(text,text,text,text,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.record_examination_reconciliation_decision(text,text,text,text,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION '0060 verification failed: a client role can record decisions';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- ROLLBACK
--   DROP FUNCTION IF EXISTS public.record_examination_reconciliation_decision(TEXT,TEXT,TEXT,TEXT,TEXT);
--   DROP VIEW IF EXISTS public.examination_orphan_ledger_reconciliation;
--   DROP TABLE IF EXISTS public.examination_reconciliation_decisions;
--   DROP FUNCTION IF EXISTS public.examination_reconciliation_decision_immutable();
-- ============================================================================

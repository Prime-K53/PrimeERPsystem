-- ============================================================================
-- Migration 0041: Cloud-authoritative Examination Invoice identity sequence
-- Prime ERP — Single-Company (no tenancy/organization/company scoping)
-- ============================================================================
--
-- Purpose:
--   Make the EXM examination-invoice identity — the invoice PRIMARY KEY and
--   the ledger `referenceId` in the SAME field — server-authoritative, exactly
--   like official Sales Order numbers (ORD-{series}/NNN, migration 0027).
--
-- Why this exists (incident BTC-P726/023 / BTC-P726/021):
--   The EXM namespace was minted device-locally from
--   `dbService.getAll('invoices')`. Two batches on two devices both minted
--   `EXM-P726/022` because the local scan could not see the other device's
--   invoice, and BOTH then posted AR under `referenceId = EXM-P726/022`
--   (550,000 + 200,250 = 750,250 on a 200,250 invoice). The invoice id IS the
--   accounting identity, so a provisional-then-renumber design is impossible
--   here: the ledger reference can never be rewritten after the fact. The
--   identity must therefore be authoritative BEFORE the invoice is written.
--
-- ABSOLUTE INVARIANTS (enforced by review, not just comments):
--   - This migration NEVER inserts, updates or deletes rows in `invoices`,
--     `ledger_entries`, or any other business table.
--   - It does NOT renumber, normalize, split, void or repair any existing
--     examination invoice or ledger entry. Existing history is left EXACTLY as
--     it is, including the already-observed duplicate identity.
--   - It only ADDS: a series-keyed counter table, an atomic claim function,
--     and read-only observability indexes.
--   - No tenancy / organization / company / tenant column is introduced.
--
-- Counter initialization without touching history:
--   Each observed series is seeded from the MAXIMUM numeric suffix ALREADY
--   PRESENT for that series. EXM numbers are scanned from BOTH tables on
--   purpose:
--     * public.invoices       — `id`, `data->>'invoiceNumber'`,
--                               `data->>'invoice_number'`
--     * public.ledger_entries — `data->>'referenceId'`  (the accounting
--                               identity; examination AR/COGS/ADJ lines carry
--                               it even when the invoice row itself never
--                               synced)
--   Seeding from `invoices` alone would restart the sequence at 1 and re-mint
--   identities that the ledger already uses — reproducing the very collision
--   this migration exists to prevent.
--   Re-running the migration can only RAISE counters (GREATEST per series),
--   never lower them. Unseen series self-initialize on first claim, inside the
--   same lock (never a blind /001).
--   Digit runs are capped at 9 characters so malformed data can neither
--   overflow the integer column nor abort this migration.
--
-- Claiming (backend only, service-role):
--   SELECT claim_next_examination_invoice_number('P726');  -- single atomic step
--   The per-series advisory lock serializes concurrent claimants of the SAME
--   series (A->23, B->24, never 23/23); different series never block.
--
-- Operator verification (read-only; SQL Editor only, changes nothing):
--   SELECT series, last_value, updated_at
--   FROM public.examination_invoice_number_counters ORDER BY series;
--   -- per-series occupancy across every field that can carry an EXM number:
--   SELECT (m)[2] AS series, MAX((m)[3]::int) AS max_suffix, COUNT(*) AS rows
--   FROM (
--     SELECT regexp_match(id, '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices
--     UNION ALL
--     SELECT regexp_match(data->>'invoiceNumber', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoiceNumber' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(data->>'invoice_number', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoice_number' IS NOT NULL
--     UNION ALL
--     SELECT regexp_match(data->>'referenceId', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.ledger_entries WHERE data->>'referenceId' IS NOT NULL
--   ) s WHERE m IS NOT NULL GROUP BY 1 ORDER BY 1;
--
-- ============================================================================

-- ─── STEP 1: series-keyed counter table (service-role only) ──────────────────
CREATE TABLE IF NOT EXISTS public.examination_invoice_number_counters (
  series TEXT PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.examination_invoice_number_counters ENABLE ROW LEVEL SECURITY;
-- Intentionally NO permissive policy: anon/authenticated get nothing. The
-- service-role key bypasses RLS, which is how the backend claims.

-- ─── STEP 2: seed every historically observed series (reads only) ───────────
-- Four independent branches. Each field is scanned on its own so that no field
-- shadows another on rows carrying several identifiers at once.
INSERT INTO public.examination_invoice_number_counters (series, last_value, updated_at)
SELECT
  (m)[2] AS series,
  MAX((m)[3]::int) AS last_value,
  NOW()
FROM (
  SELECT regexp_match(id, '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices
  UNION ALL
  SELECT regexp_match(data->>'invoiceNumber', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoiceNumber' IS NOT NULL
  UNION ALL
  SELECT regexp_match(data->>'invoice_number', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoice_number' IS NOT NULL
  UNION ALL
  SELECT regexp_match(data->>'referenceId', '^(EXM)-([A-Za-z0-9]+)/([0-9]{1,9})$') AS m FROM public.ledger_entries WHERE data->>'referenceId' IS NOT NULL
) s
WHERE m IS NOT NULL
GROUP BY 1
ON CONFLICT (series) DO UPDATE SET
  last_value = GREATEST(public.examination_invoice_number_counters.last_value, EXCLUDED.last_value),
  updated_at = NOW();

-- ─── STEP 3: atomic per-series claim function ───────────────────────────────
-- One transaction: take the series advisory lock, then either bump the existing
-- row or safely initialize an unseen series from that series' history (same
-- lock held throughout, so two concurrent first-claims for a new series
-- serialize instead of double-initializing).
--
-- IMPORTANT — history wins over the counter: the max suffix already present in
-- `invoices` OR `ledger_entries` is always taken into account, so an identity
-- that the ledger already uses can never be handed out again even if the
-- counter row is behind (e.g. restored from a partial backup).
CREATE OR REPLACE FUNCTION public.claim_next_examination_invoice_number(p_series TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed INTEGER;
  clean_series TEXT;
  history_max INTEGER;
BEGIN
  clean_series := NULLIF(trim(both from p_series), '');
  IF clean_series IS NULL OR clean_series !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid examination invoice series: %', p_series;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('examination_invoice_number_counters:' || clean_series));

  -- The sequence is capture group 1: `EXM` is a literal here, NOT a group.
  -- (Indexing [3] against a 2-group pattern yields NULL for every row, which
  -- silently pins history_max at 0 and disables the history guard entirely.)
  SELECT COALESCE(MAX((m)[1]::int), 0) INTO history_max
  FROM (
    SELECT regexp_match(id, '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices
    UNION ALL
    SELECT regexp_match(data->>'invoiceNumber', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoiceNumber' IS NOT NULL
    UNION ALL
    SELECT regexp_match(data->>'invoice_number', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoice_number' IS NOT NULL
    UNION ALL
    SELECT regexp_match(data->>'referenceId', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.ledger_entries WHERE data->>'referenceId' IS NOT NULL
  ) s
  WHERE m IS NOT NULL;

  SELECT last_value INTO claimed
  FROM public.examination_invoice_number_counters
  WHERE series = clean_series;

  IF NOT FOUND THEN
    claimed := history_max + 1;
    INSERT INTO public.examination_invoice_number_counters (series, last_value, updated_at)
    VALUES (clean_series, claimed, NOW());
  ELSE
    -- Never issue a number at or below an identity history already proves is
    -- in use. GREATEST keeps the counter monotonic while history leads it.
    claimed := GREATEST(claimed, history_max) + 1;
    UPDATE public.examination_invoice_number_counters
    SET last_value = claimed,
        updated_at = NOW()
    WHERE series = clean_series;
  END IF;

  RETURN claimed;
END;
$$;

-- Only the service role may execute the claim. Frontend clients never claim:
-- they obtain an authoritative identity through the backend gateway, and a NEW
-- examination invoice identity is never finalized without one.
REVOKE ALL ON FUNCTION public.claim_next_examination_invoice_number(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_examination_invoice_number(TEXT) TO service_role;

-- ─── STEP 4: read-only observability index (NOT a uniqueness constraint) ─────
-- Deliberately NON-unique. A unique index would have to reject the historical
-- duplicate identity that already exists (two batches sharing one EXM
-- reference), i.e. it would fail or force data changes. This migration fixes
-- FORWARD behavior only; the counter is the convergence mechanism and history
-- is left untouched. This index exists purely to make the EXM occupancy of the
-- ledger cheap to inspect.
CREATE INDEX IF NOT EXISTS idx_ledger_entries_examination_reference
ON public.ledger_entries (((data->>'referenceId')::text))
WHERE data->>'referenceId' LIKE 'EXM-%';

-- ============================================================================
-- END MIGRATION 0041
-- ============================================================================
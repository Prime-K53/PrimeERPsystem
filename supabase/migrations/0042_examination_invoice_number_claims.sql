-- ============================================================================
-- Migration 0042: Durable claim record for Examination Invoice identities
-- Prime ERP — Single-Company (no tenancy/organization/company scoping)
-- ============================================================================
--
-- Purpose:
--   Give the EXAM examination-invoice numbering mechanism a durable record of
--   WHICH identities were actually issued.
--
-- Why (the gap 0041 left open):
--   0041 stores only a monotonic high-water mark:
--     examination_invoice_number_counters(series, last_value, updated_at)
--   The claim function reads `last_value`, increments it, and DISCARDS the
--   claimed value. Consequently the cloud cannot distinguish
--       legitimately claimed EXM number   (e.g. EXM-P726/023)
--   from
--       fabricated EXM number             (e.g. EXM-P726/022, a stale bundle)
--   The only derivable predicate is `sequence <= last_value`, and that admits
--   EVERY historical number — 22 <= 22 passes, which is precisely the identity
--   that already carries two batches' AR postings (K550,000 + K200,250). A
--   high-water-mark check has ZERO discriminating power against fabrication, so
--   the future gateway validator (P1.1) must NOT be built on it.
--
--   This migration adds the missing primitive — an append-only, per-identity
--   claim record written inside the SAME transaction and the SAME advisory lock
--   that bumps the counter. It is not a second numbering mechanism: there is
--   still exactly one counter and one claim function.
--
-- ABSOLUTE INVARIANTS (enforced by review AND by tests):
--   - This migration NEVER inserts, updates, deletes or rewrites any row in
--     `invoices`, `ledger_entries`, `examination_batches`, or any other
--     business table. It only READS those tables inside a classification
--     function.
--   - It does NOT renumber, renamespace, split, void or repair any existing
--     examination invoice or ledger entry — including the already-observed
--     duplicate identity EXM-P726/022 and the 7-way EXM-P726/021 collision.
--   - It fabricates NO claim rows for historical identities. See
--     "HISTORICAL GRANDFATHERING" below.
--   - No tenancy / organization / company / tenant column is introduced.
--
-- ── NEW PRIMITIVE ───────────────────────────────────────────────────────────
--   public.examination_invoice_number_claims
--     One row per identity actually issued by the counter from now on.
--     PRIMARY KEY (series, sequence)  -> two claims can never collide
--     UNIQUE      (invoice_number)    -> one identity can never be issued twice
--
--   public.claim_next_examination_invoice_number(p_series, p_padding, p_suffix)
--     Same return value as 0041 (the claimed sequence INTEGER). The counter
--     bump and the claim insert happen in ONE transaction under the SAME
--     advisory lock, so a failed claim consumes NEITHER the counter value NOR
--     leaves an orphan claim row.
--
-- ── HISTORICAL GRANDFATHERING ───────────────────────────────────────────────
--   The claims table starts EMPTY, but EXM identities up to EXM-P726/022 are
--   already in use. Those were issued before this migration, so claiming them
--   now would be a lie. Instead of fabricating rows, historical recognition is
--   exposed through a SEPARATE, read-only predicate:
--
--     public.classify_examination_invoice_number(p_series, p_sequence)
--       → 'CLAIMED_NEW'             issued by the counter; a claim row exists
--       → 'HISTORICAL_GRANDFATHERED' predates 0042; authoritative invoice or
--                                     ledger evidence exists, but NO claim row
--       → 'UNKNOWN'                 no claim row and no evidence
--
--     public.examination_invoice_number_evidence_counts(p_series, p_sequence)
--       → (invoice_evidence, ledger_evidence) read-only counts, so a caller can
--         see that EXM-P726/022 has MULTIPLE historical ledger rows (two AR
--         postings from two batches) and must therefore never be presented as
--         one clean, uniquely-claimed identity.
--
--   The distinction CLAIMED_NEW ≠ HISTORICAL_GRANDFATHERED is deliberate and
--   must never be collapsed:
--     * a claim row is a statement of FACT about issuance;
--     * grandfathered evidence is a statement about PRE-EXISTING data and
--       carries no ownership — EXM-P726/022 is not assigned to either batch;
--     * historical evidence may NEVER authorize a NEW invoice to reuse an old
--       EXM number (the counter still refuses to reissue anything at or below
--       `history_max`, exactly as in 0041).
--
-- Operator verification (read-only; SQL Editor only, changes nothing):
--   SELECT * FROM public.examination_invoice_number_claims ORDER BY series, sequence;
--   SELECT series, last_value FROM public.examination_invoice_number_counters;
--   SELECT public.classify_examination_invoice_number('P726', 22);   -- HISTORICAL_GRANDFATHERED
--   SELECT * FROM public.examination_invoice_number_evidence_counts('P726', 22);
--
-- ============================================================================

-- ─── STEP 1: durable claim record (service-role only) ───────────────────────
CREATE TABLE IF NOT EXISTS public.examination_invoice_number_claims (
  series TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  invoice_number TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT examination_invoice_number_claims_pkey PRIMARY KEY (series, sequence),
  CONSTRAINT examination_invoice_number_claims_invoice_number_key UNIQUE (invoice_number),
  CONSTRAINT examination_invoice_number_claims_sequence_positive CHECK (sequence > 0)
);

ALTER TABLE public.examination_invoice_number_claims ENABLE ROW LEVEL SECURITY;
-- Intentionally NO permissive policy: anon/authenticated get nothing. The
-- service-role key bypasses RLS, which is how the backend claims and how the
-- future gateway validator reads.

-- Fast series lookups (the PK already covers (series, sequence)).
CREATE INDEX IF NOT EXISTS idx_examination_invoice_number_claims_series
ON public.examination_invoice_number_claims (series, claimed_at);

-- ─── STEP 2: replace the claim function (same counter, now also durable) ───
-- 0041 shipped claim_next_examination_invoice_number(TEXT). Postgres treats a
-- different arity as an OVERLOAD rather than a replacement, so the 0041
-- signature is dropped explicitly before recreating it with the two formatting
-- parameters it needs in order to store the exact `invoice_number` string.
--
--   p_padding / p_suffix are OPTIONAL. The backend resolves both from the
--   company numbering settings and passes them; omitting them keeps the exact
--   0041 call shape working (1-arg) and defaults to the observed deployment
--   shape (padding 3, no suffix).
--
--   The RETURN value is UNCHANGED: the claimed sequence INTEGER. Callers keep
--   formatting client-side exactly as before.
DROP FUNCTION IF EXISTS public.claim_next_examination_invoice_number(TEXT);

CREATE OR REPLACE FUNCTION public.claim_next_examination_invoice_number(
  p_series TEXT,
  p_padding INTEGER DEFAULT NULL,
  p_suffix TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed INTEGER;
  clean_series TEXT;
  history_max INTEGER;
  claimed_number TEXT;
  clean_padding INTEGER;
BEGIN
  -- 1. Normalize/validate the series — IDENTICAL to 0041.
  clean_series := NULLIF(trim(both from p_series), '');
  IF clean_series IS NULL OR clean_series !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid examination invoice series: %', p_series;
  END IF;

  -- 2. Same advisory lock as 0041 (same lock key) — same-series claims
  --    serialize, so two callers can never be handed the same sequence.
  PERFORM pg_advisory_xact_lock(hashtext('examination_invoice_number_counters:' || clean_series));

  -- 3. History still wins over the counter — same scan as 0041, READ ONLY.
  --    `EXM` is a plain literal and the sequence is capture group 1. (Reading the
  --    sequence from a group the pattern does not define yields NULL for every
  --    row, which silently pins history_max at 0 and disables this guard.)
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

  -- 4. Next sequence — IDENTICAL to 0041 (counter bump, history-dominant).
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

  -- 5. Durable claim record — SAME transaction as the counter bump above.
  --    Any failure here (unique violation, check violation, …) aborts the whole
  --    statement, rolling back the counter UPDATE/INSERT with it: a failed claim
  --    consumes neither the counter value nor leaves an orphan claim row.
  --
  --    Formatting mirrors formatConfiguredDocumentNumber for the EXM rule:
  --      EXM + '-' + series + '/' + lpad(sequence, padding) + suffix
  clean_padding := COALESCE(p_padding, 3);
  IF clean_padding IS NULL OR clean_padding < 1 THEN
    clean_padding := 1;
  END IF;
  claimed_number := 'EXM-' || clean_series || '/'
                 || lpad(claimed::text, clean_padding, '0')
                 || COALESCE(p_suffix, '');

  INSERT INTO public.examination_invoice_number_claims (series, sequence, invoice_number, claimed_at)
  VALUES (clean_series, claimed, claimed_number, NOW());

  -- 6. Same response/value as 0041.
  RETURN claimed;
END;
$$;

-- Only the service role may execute the claim. Frontend clients never claim:
-- they obtain an authoritative identity through the backend gateway, and a NEW
-- examination invoice identity is never finalized without one.
REVOKE ALL ON FUNCTION public.claim_next_examination_invoice_number(TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_examination_invoice_number(TEXT, INTEGER, TEXT) TO service_role;

-- ─── STEP 3: historical grandfathering predicate (READ ONLY) ────────────────
-- Distinguishes a post-0042 claim from pre-0042 historical usage WITHOUT
-- inserting any claim row for history and WITHOUT assigning ownership of a
-- duplicated identity to any batch.
--
--   CLAIMED_NEW              -> a claim row exists (fact of issuance)
--   HISTORICAL_GRANDFATHERED -> no claim row, but authoritative invoice/ledger
--                               evidence exists (pre-0042 usage, ownership
--                               deliberately UNKNOWN)
--   UNKNOWN                  -> neither
CREATE OR REPLACE FUNCTION public.classify_examination_invoice_number(p_series TEXT, p_sequence INTEGER)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean_series TEXT;
  has_claim BOOLEAN;
  invoice_hits INTEGER;
  ledger_hits INTEGER;
BEGIN
  clean_series := NULLIF(trim(both from p_series), '');
  IF clean_series IS NULL OR clean_series !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid examination invoice series: %', p_series;
  END IF;
  IF p_sequence IS NULL OR p_sequence <= 0 THEN
    RAISE EXCEPTION 'Invalid examination invoice sequence: %', p_sequence;
  END IF;

  -- Claim row is checked FIRST, and that ordering is load-bearing.
  -- A genuine new claim (say EXM-P726/024) will, once the invoice is saved,
  -- present its OWN row as historical evidence — so evidence-first would
  -- misreport a real claim as HISTORICAL_GRANDFATHERED. A claim row is the
  -- stronger statement (it proves the counter issued the number), so it wins.
  --
  -- The converse cannot arise: with the history guard above working, the
  -- counter refuses any sequence at or below history_max, so a counter-issued
  -- claim row can never sit on an identity history already proves is in use.
  SELECT EXISTS (
    SELECT 1 FROM public.examination_invoice_number_claims
    WHERE series = clean_series AND sequence = p_sequence
  ) INTO has_claim;

  -- Zero-padded and unpadded forms are treated identically: the sequence is
  -- extracted with a regex, exactly as 0041 does for history_max.
  SELECT COUNT(*) INTO invoice_hits
  FROM (
    SELECT regexp_match(id, '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices
    UNION ALL
    SELECT regexp_match(data->>'invoiceNumber', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoiceNumber' IS NOT NULL
    UNION ALL
    SELECT regexp_match(data->>'invoice_number', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoice_number' IS NOT NULL
  ) s
  WHERE m IS NOT NULL AND (m)[1]::int = p_sequence;

  SELECT COUNT(*) INTO ledger_hits
  FROM (
    SELECT regexp_match(data->>'referenceId', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.ledger_entries WHERE data->>'referenceId' IS NOT NULL
  ) s
  WHERE m IS NOT NULL AND (m)[1]::int = p_sequence;

  IF has_claim THEN
    RETURN 'CLAIMED_NEW';
  END IF;
  IF invoice_hits > 0 OR ledger_hits > 0 THEN
    RETURN 'HISTORICAL_GRANDFATHERED';
  END IF;
  RETURN 'UNKNOWN';
END;
$$;

REVOKE ALL ON FUNCTION public.classify_examination_invoice_number(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.classify_examination_invoice_number(TEXT, INTEGER) TO service_role;

-- Read-only evidence counts, so a caller can see how much history sits behind
-- an identity. EXM-P726/022 has MULTIPLE ledger rows (two AR postings from two
-- different batches) and zero claim rows: it is historical usage, never one
-- clean uniquely-claimed identity.
CREATE OR REPLACE FUNCTION public.examination_invoice_number_evidence_counts(p_series TEXT, p_sequence INTEGER)
RETURNS TABLE (invoice_evidence INTEGER, ledger_evidence INTEGER)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clean_series TEXT;
BEGIN
  clean_series := NULLIF(trim(both from p_series), '');
  IF clean_series IS NULL OR clean_series !~ '^[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'Invalid examination invoice series: %', p_series;
  END IF;
  IF p_sequence IS NULL OR p_sequence <= 0 THEN
    RAISE EXCEPTION 'Invalid examination invoice sequence: %', p_sequence;
  END IF;

  RETURN QUERY
  SELECT
    (
      SELECT COUNT(*)::int FROM (
        SELECT regexp_match(id, '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices
        UNION ALL
        SELECT regexp_match(data->>'invoiceNumber', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoiceNumber' IS NOT NULL
        UNION ALL
        SELECT regexp_match(data->>'invoice_number', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.invoices WHERE data->>'invoice_number' IS NOT NULL
      ) s
      WHERE m IS NOT NULL AND (m)[1]::int = p_sequence
    ),
    (
      SELECT COUNT(*)::int FROM (
        SELECT regexp_match(data->>'referenceId', '^EXM-' || clean_series || '/([0-9]{1,9})$') AS m FROM public.ledger_entries WHERE data->>'referenceId' IS NOT NULL
      ) s
      WHERE m IS NOT NULL AND (m)[1]::int = p_sequence
    );
END;
$$;

REVOKE ALL ON FUNCTION public.examination_invoice_number_evidence_counts(TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.examination_invoice_number_evidence_counts(TEXT, INTEGER) TO service_role;

-- ============================================================================
-- END MIGRATION 0042
-- ============================================================================
-- ============================================================================
-- 0052_contract_document_identity.sql
--
-- PROPOSED — NOT APPLIED. Prepared for review only (Phase 2F). Do NOT run this
-- against production without the deployment sequence in the report and the
-- preflight queries passing.
--
-- SCOPE
--   This migration does FOUR things and nothing else:
--     1. IDENTITY  — a unique index for SCHEDULES keyed by the stable contract
--                    id + version. Receipts are explicitly OUT of scope.
--     2. LEGACY INDEX RESOLUTION — migration 0049's number-keyed unique index
--                    is dropped, because it (provably) blocks valid schedules.
--     3. IMMUTABILITY — a trigger that freezes every issued field, blocks
--                    deletion and tombstoning, and enforces the document
--                    lifecycle (a superseded document can never return to
--                    VALID).
--     4. RLS       — direct client writes to issued documents are denied; the
--                    service-role sync path and the SELECT/realtime path are
--                    preserved.
--
--   It deliberately does NOT:
--     - add a "one current schedule" constraint (that is 0053, kept separate
--       because it depends on the issuance ordering being made safe);
--     - modify, renumber, delete or rewrite ANY existing row.
--
-- ── 1. WHY THE NUMBER-BASED INDEX IS DROPPED (and what replaces it) ───────
--   0049 creates:
--     uq_contract_documents_number_version
--       UNIQUE ((data->>'documentNumber'), ((data->>'documentVersion')::INT))
--       WHERE COALESCE(data->>'documentNumber','') <> ''
--
--   It constrains EVERY document that carries a number:
--     * schedules  — documentNumber = the human contract number
--     * receipts   — documentNumber = 'PCR-<human contract number>'
--
--   The (number, version) pair is NOT an identity in either case:
--     * the human contract number is NOT unique — live production holds two
--       different contracts numbered PC-P726/022 (one cancelled, one active);
--     * a receipt's number is per contract and its version is per contract, so
--       two contracts sharing a human number produce the SAME (receipt number,
--       receipt version) pair.
--   Proven by execution against a disposable PostgreSQL 15.18 (Phase 2E): with
--   the index in place, publishing a schedule for the second contract of a
--   shared number fails with
--       23505 duplicate key value violates unique constraint
--             "uq_contract_documents_number_version"
--   i.e. the second contract could NEVER hold a schedule. The same argument
--   applies to the first receipt of that contract.
--
--   The invariant that replaces it, per document type:
--     * schedule identity = (contract_id, documentVersion)
--       -> uq_contract_documents_schedule_identity (created below). The
--          human number is a LABEL, not an identity.
--     * receipt identity  = the assessment item
--       -> uq_contract_documents_receipt_item (0049:45-48, kept untouched). It
--          is globally unique, so it is safe for contracts that share a number.
--     * within one contract, the version sequence is unique by construction
--       (the client allocates it per contract and per document type).
--
-- ── 2. CANONICAL vs LEGACY VERSIONS ───────────────────────────────────────
--   R1 — CANONICAL (what a NEW version must be):
--       jsonb_typeof(data->'documentVersion') = 'number'
--       AND (data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$'
--     A positive integer of at most nine digits, i.e. 1 .. 999999999. The
--     nine-digit cap keeps every `::INT` cast inside the INT4 range, so a
--     stored value can never overflow the index expression. A JSON number is
--     required: a string is not canonical, even when it reads like one.
--
--   R2 — LEGACY COMPARISON VALUE (how an EXISTING row is ordered/compared):
--       CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
--            THEN (data->>'documentVersion')::INT ELSE 0 END
--     A historical row keeps its value when its text form is an integer
--     (leading zeros allowed: '05' compares as 5). Anything else — missing,
--     null, fractional, exponent form, or too large — compares as 0, i.e.
--     "older than any canonical version".
--
--   Why R2 exists: a legacy row whose version is not canonical must still be
--   RETIRABLE, otherwise its contract could never publish a new version again
--   (proved in Phase 2E: the insert of the next version failed with
--   "the superseded document has a non-canonical version"). Historical rows are
--   never rewritten to become canonical — R2 only affects comparison.
--
--   R2 is used consistently in every comparison: the `supersededBy` validation
--   in this file, the current-schedule rule in 0053, and the gateway's
--   pre-write guard (backend/services/contractDocumentGuard.cjs). A lower
--   version still can never supersede a higher one.
--
--   NOTE for anyone editing a PL/pgSQL condition: PL/pgSQL parses an `IF`
--   condition up to the FIRST `THEN`, so a CASE expression inside a condition
--   MUST be parenthesised.
--
-- ── 3. DEPLOYMENT ORDER ───────────────────────────────────────────────────
--   1. Deploy the Phase 2D client (insert-then-supersede ordering, the
--      client-side guard, the per-contract receipt version, the base-preserving
--      OCC). The current client inserts the new version BEFORE superseding the
--      old one, which is what lets the trigger validate `supersededBy` against
--      a row that already exists. A supersede-first client is REFUSED by this
--      trigger (proved in Phase 2E) and must not be in production when it runs.
--   2. Apply this migration (0052).
--   3. Apply 0053 (single current schedule).
--
-- ── 4. LOCKING ────────────────────────────────────────────────────────────
--   One transaction, so the whole change is atomic: a failure leaves the table
--   exactly as it was. The index build takes a SHARE lock on the table (two
--   rows in production) and CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock.
--   Run it in a quiet window.
--
-- ── 5. ROLLBACK ───────────────────────────────────────────────────────────
--   Recreate uq_contract_documents_number_version ONLY if the number-keyed
--   uniqueness is wanted back — but note that it cannot be recreated while two
--   contracts share a human number AND hold documents, which is exactly the
--   state this migration unblocks.
-- ============================================================================

BEGIN;

-- ─── Preflight: every condition that could make the index build fail ───────
DO $$
DECLARE
  dup_identity   INT;
  dup_number     INT;
  noncanonical   INT;
  multi_valid    INT;
  bad_status     INT;
BEGIN
  -- (a) Duplicates under the FINAL index design (schedules only, R1 versions).
  --     This is the only way the index build can fail. The expression is the
  --     index's own expression, and the version value uses R2, which cannot
  --     raise on any stored text.
  SELECT COUNT(*) INTO dup_identity
  FROM (
    SELECT data->>'contract_id' AS cid,
           CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
                THEN (data->>'documentVersion')::INT ELSE 0 END AS v
    FROM public.contract_documents
    WHERE COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
      AND COALESCE(data->>'contract_id', '') <> ''
      AND jsonb_typeof(data->'documentVersion') = 'number'
      AND (data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$'
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
  ) d;
  IF dup_identity > 0 THEN
    RAISE EXCEPTION 'contract_documents has % duplicate (contract_id, documentVersion) schedule identit(ies). Resolve them before applying 0052 — nothing was applied.', dup_identity;
  END IF;

  -- (b) (documentNumber, documentVersion) pairs that the number-keyed index
  --     used to forbid. Under the final design they are LEGAL (the human
  --     number is a label, not an identity) — reported, never rewritten.
  SELECT COUNT(*) INTO dup_number
  FROM (
    SELECT data->>'documentNumber' AS num,
           CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
                THEN (data->>'documentVersion')::INT ELSE 0 END AS v
    FROM public.contract_documents
    WHERE COALESCE(data->>'documentNumber', '') <> ''
    GROUP BY 1, 2
    HAVING COUNT(*) > 1
  ) d;
  IF dup_number > 0 THEN
    RAISE NOTICE 'contract_documents: % (documentNumber, documentVersion) pair(s) collide under the OLD number-keyed index. They are LEGAL under the final design (identity is the contract id, or the assessment item for a receipt) and are kept as they are.', dup_number;
  END IF;

  -- (c) Rows whose version is not canonical. They are EXCLUDED from the
  --     identity index (so they cannot break the build) and they are compared
  --     with R2. Reported, never rewritten: an issued document is the
  --     customer's evidence.
  SELECT COUNT(*) INTO noncanonical
  FROM public.contract_documents
  WHERE COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
    AND (
      COALESCE(data->>'contract_id', '') = ''
      OR jsonb_typeof(data->'documentVersion') IS DISTINCT FROM 'number'
      OR COALESCE(data->>'documentVersion', '') !~ '^[1-9][0-9]{0,8}$'
    );
  IF noncanonical > 0 THEN
    RAISE NOTICE 'contract_documents: % schedule row(s) carry a non-canonical identity (contract_id / documentVersion). They are EXCLUDED from uq_contract_documents_schedule_identity, compared as version 0 (R2), and were NOT modified.', noncanonical;
  END IF;

  -- (d) Contracts that currently hold more than one VALID schedule. REPORTED
  --     only: 0053 retires the older one when a new version is published, and
  --     no existing row is modified here.
  SELECT COUNT(*) INTO multi_valid
  FROM (
    SELECT data->>'contract_id' AS cid
    FROM public.contract_documents
    WHERE COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
      AND data->>'status' = 'VALID'
      AND COALESCE(data->>'contract_id', '') <> ''
    GROUP BY 1
    HAVING COUNT(*) > 1
  ) d;
  IF multi_valid > 0 THEN
    RAISE NOTICE 'contract_documents: % contract(s) currently hold more than one VALID schedule. Migration 0053 retires the older current schedule when a new version is issued; 0052 modified no row.', multi_valid;
  END IF;

  -- (e) Status values outside the known vocabulary. REPORTED only.
  SELECT COUNT(*) INTO bad_status
  FROM public.contract_documents
  WHERE COALESCE(data->>'status', '') NOT IN ('VALID', 'SUPERSEDED', 'VOID');
  IF bad_status > 0 THEN
    RAISE NOTICE 'contract_documents: % row(s) carry a status outside VALID/SUPERSEDED/VOID. They were left untouched; review them manually.', bad_status;
  END IF;
END $$;

-- ─── 2. Identity: schedules are keyed by the stable contract id + version ──
-- The predicate carries R1, so the `::INT` expression can never overflow and
-- can never raise: only rows whose version is a positive integer of at most
-- nine digits are indexed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_documents_schedule_identity
  ON public.contract_documents (
    ((data->>'contract_id')),
    ((data->>'documentVersion')::INT)
  )
  WHERE COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
    AND COALESCE(data->>'contract_id', '') <> ''
    AND jsonb_typeof(data->'documentVersion') = 'number'
    AND (data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$';

-- ─── 3. Retire the number-keyed uniqueness (see section 1) ─────────────────
-- The replacement invariants are documented in the header: schedule identity is
-- (contract_id, documentVersion) — the index above; receipt identity is the
-- assessment item — 0049's uq_contract_documents_receipt_item, untouched.
DROP INDEX IF EXISTS public.uq_contract_documents_number_version;

-- ─── 4. Immutability + lifecycle ──────────────────────────────────────────
-- The client mirror of these rules lives in
-- frontend/services/contractDocumentGuard.ts. When one changes, so must the
-- other: the client refuses to emit a write the database would reject, and
-- the database refuses a write from any other writer.
CREATE OR REPLACE FUNCTION public.enforce_contract_document_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_status_old TEXT;
  v_status_new TEXT;
  v_target    RECORD;
  v_target_ver INT;
  v_old_ver    INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'contract_documents rows are immutable and cannot be deleted (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.data->>'contract_id', '') = '' THEN
      RAISE EXCEPTION 'contract_documents: a document requires a contract_id (id=%)', NEW.id
        USING ERRCODE = 'P0001';
    END IF;
    IF COALESCE(NEW.data->>'documentType', '') = '' THEN
      RAISE EXCEPTION 'contract_documents: a document requires a documentType (id=%)', NEW.id
        USING ERRCODE = 'P0001';
    END IF;
    v_status_new := UPPER(COALESCE(NEW.data->>'status', ''));
    IF v_status_new NOT IN ('VALID', 'SUPERSEDED') THEN
      -- VOID is deliberately not insertable: no writer produces it and its
      -- meaning for an already printed document is a business decision.
      RAISE EXCEPTION 'contract_documents: a document cannot be created with status % (id=%)', v_status_new, NEW.id
        USING ERRCODE = 'P0001';
    END IF;
    -- R1: a NEW version must be a positive integer of at most nine digits.
    IF jsonb_typeof(NEW.data->'documentVersion') IS DISTINCT FROM 'number'
       OR COALESCE(NEW.data->>'documentVersion', '') !~ '^[1-9][0-9]{0,8}$' THEN
      RAISE EXCEPTION 'contract_documents: a new documentVersion must be a positive integer of at most nine digits (id=%, got %)',
        NEW.id, COALESCE(NEW.data->>'documentVersion', '<absent>')
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  -- ── UPDATE ──────────────────────────────────────────────────────────────
  v_status_old := UPPER(COALESCE(OLD.data->>'status', ''));
  v_status_new := UPPER(COALESCE(NEW.data->>'status', ''));

  -- (a) Row identity is immutable: the primary key and the payload copy of it.
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'contract_documents: the row id is immutable (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;
  IF (NEW.data->>'id') IS DISTINCT FROM (OLD.data->>'id') THEN
    RAISE EXCEPTION 'contract_documents: the payload id is immutable (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- (b) Issued content, hash, hash RULE, token, identity and issuance audit
  --     fields are immutable. The content is compared as JSONB (not as text),
  --     so 1 and 1.0 are the same value and a re-send of an unchanged
  --     document is never rejected because of serialization.
  IF NEW.data->'content'              IS DISTINCT FROM OLD.data->'content'
     OR (NEW.data->>'contentHash')       IS DISTINCT FROM (OLD.data->>'contentHash')
     OR (NEW.data->>'hashVersion')       IS DISTINCT FROM (OLD.data->>'hashVersion')
     OR (NEW.data->>'verificationToken') IS DISTINCT FROM (OLD.data->>'verificationToken')
     OR (NEW.data->>'documentNumber')    IS DISTINCT FROM (OLD.data->>'documentNumber')
     OR (NEW.data->>'documentType')      IS DISTINCT FROM (OLD.data->>'documentType')
     OR (NEW.data->>'documentVersion')   IS DISTINCT FROM (OLD.data->>'documentVersion')
     OR (NEW.data->>'contract_id')       IS DISTINCT FROM (OLD.data->>'contract_id')
     OR (NEW.data->>'company_id')        IS DISTINCT FROM (OLD.data->>'company_id')
     OR (NEW.data->>'customer_id')       IS DISTINCT FROM (OLD.data->>'customer_id')
     OR (NEW.data->>'assessmentItemId')  IS DISTINCT FROM (OLD.data->>'assessmentItemId')
     OR (NEW.data->>'walletTransactionId') IS DISTINCT FROM (OLD.data->>'walletTransactionId')
     OR (NEW.data->>'ledgerEntryId')     IS DISTINCT FROM (OLD.data->>'ledgerEntryId')
     OR (NEW.data->>'issuedAt')          IS DISTINCT FROM (OLD.data->>'issuedAt')
     OR (NEW.data->>'issuedBy')          IS DISTINCT FROM (OLD.data->>'issuedBy')
     OR (NEW.data->>'contractVersion')   IS DISTINCT FROM (OLD.data->>'contractVersion')
  THEN
    RAISE EXCEPTION 'contract_documents: issued content is immutable (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- (c) An issued document is never tombstoned: the physical row IS the
  --     evidence the customer keeps. UNRESOLVED business decision — if a
  --     business need for deleting an issued document appears, it needs its
  --     own rule (e.g. a documented void), not a silent tombstone.
  IF (NEW.data->>'deleted')   IS DISTINCT FROM (OLD.data->>'deleted')
     OR (NEW.data->>'deletedAt') IS DISTINCT FROM (OLD.data->>'deletedAt')
  THEN
    RAISE EXCEPTION 'contract_documents: an issued document must not be tombstoned (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  -- (d) Lifecycle. A document may only move VALID -> SUPERSEDED. It may
  --     never return to VALID, and VOID is not available yet.
  IF v_status_new IS DISTINCT FROM v_status_old THEN
    IF v_status_old = 'VALID' AND v_status_new = 'SUPERSEDED' THEN
      NULL; -- allowed; the link is validated below
    ELSIF v_status_new = 'VOID' THEN
      RAISE EXCEPTION 'contract_documents: VOID is not an available transition yet (id=%) - business decision required', OLD.id
        USING ERRCODE = 'P0001';
    ELSE
      RAISE EXCEPTION 'contract_documents: illegal status transition % -> % (id=%); a superseded document must never return to VALID', v_status_old, v_status_new, OLD.id
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- (e) The supersede link must point at a real, NEWER version of the same
  --     contract and document type. The client inserts the replacement BEFORE
  --     superseding the predecessor, so the target exists by the time the
  --     supersede lands.
  --
  --     R2 is used for both sides: a legacy row keeps its numeric value when
  --     its text form is an integer, and compares as 0 otherwise — so a
  --     malformed legacy version can still be retired (it can never block the
  --     publication of the next version) while a LOWER version still can never
  --     supersede a HIGHER one.
  --
  --     The CASE expressions are parenthesised because PL/pgSQL parses an IF
  --     condition up to the first THEN.
  IF v_status_new = 'SUPERSEDED' THEN
    IF COALESCE(NEW.data->>'supersededBy', '') = '' THEN
      RAISE EXCEPTION 'contract_documents: a SUPERSEDED document must record supersededBy (id=%)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF NEW.data->>'supersededBy' = OLD.id THEN
      RAISE EXCEPTION 'contract_documents: a document cannot supersede itself (id=%)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    SELECT id, data INTO v_target FROM public.contract_documents WHERE id = NEW.data->>'supersededBy';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'contract_documents: the superseding document % does not exist yet (id=%)', NEW.data->>'supersededBy', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF (v_target.data->>'contract_id') IS DISTINCT FROM (OLD.data->>'contract_id') THEN
      RAISE EXCEPTION 'contract_documents: the superseding document belongs to a different contract (id=%)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    IF (v_target.data->>'documentType') IS DISTINCT FROM (OLD.data->>'documentType') THEN
      RAISE EXCEPTION 'contract_documents: the superseding document has a different document type (id=%)', OLD.id
        USING ERRCODE = 'P0001';
    END IF;
    v_target_ver := CASE WHEN (v_target.data->>'documentVersion') ~ '^[0-9]{1,9}$'
                         THEN (v_target.data->>'documentVersion')::INT ELSE 0 END;
    v_old_ver := CASE WHEN (OLD.data->>'documentVersion') ~ '^[0-9]{1,9}$'
                       THEN (OLD.data->>'documentVersion')::INT ELSE 0 END;
    -- A canonical row may only be superseded by a STRICTLY newer version.
    -- A LEGACY row (one whose version is not canonical) may be superseded by a
    -- version that is not older than it: the canonical 1 legitimately replaces
    -- the legacy '01'. In both cases a LOWER version can never supersede a
    -- higher one.
    IF jsonb_typeof(OLD.data->'documentVersion') = 'number'
       AND (OLD.data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$' THEN
      IF v_target_ver <= v_old_ver THEN
        RAISE EXCEPTION 'contract_documents: the superseding document must have a greater version (target %, id=%)', v_target_ver, OLD.id
          USING ERRCODE = 'P0001';
      END IF;
    ELSE
      IF v_target_ver < v_old_ver THEN
        RAISE EXCEPTION 'contract_documents: the superseding document must not be older than the superseded document (target %, id=%)', v_target_ver, OLD.id
          USING ERRCODE = 'P0001';
      END IF;
    END IF;
  ELSIF (NEW.data->>'supersededBy') IS DISTINCT FROM (OLD.data->>'supersededBy') THEN
    RAISE EXCEPTION 'contract_documents: only a SUPERSEDED document carries a supersededBy link (id=%)', OLD.id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_contract_documents_immutable ON public.contract_documents;
-- INSERT is part of the trigger: the canonical identity (R1), the required
-- contract id / document type and the insertable status vocabulary are all
-- enforced at write time. Without INSERT in the trigger list the insert branch
-- of the function was never executed (proved in Phase 2F: a new version of
-- 1000000000, 0, -1, 1.5, '1e3', '1' or NULL was accepted).
CREATE TRIGGER trg_contract_documents_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON public.contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_document_immutability();

-- ─── 5. RLS: direct client writes to issued documents are denied ───────────
-- The ERP writes business data through the sync gateway, which uses the
-- SERVICE-ROLE key and therefore bypasses RLS. Reads (pull + realtime) need
-- a SELECT policy for `authenticated`: the browser's realtime subscription
-- (frontend/services/syncService.ts) is what delivers a version published by
-- another device.
--
-- Migration 0049 granted `FOR ALL TO authenticated USING (true)`, which meant
-- any signed-in browser session could rewrite or delete an issued, hashed
-- document directly through PostgREST — the "tamper-evident" claim was not
-- enforced. The trigger above is now the backstop for the service-role path;
-- this policy removes the direct path entirely.
ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all_contract_documents" ON public.contract_documents;
DROP POLICY IF EXISTS "select_contract_documents" ON public.contract_documents;

CREATE POLICY "select_contract_documents"
  ON public.contract_documents FOR SELECT TO authenticated
  USING (true);

COMMIT;

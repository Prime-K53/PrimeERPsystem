-- ============================================================================
-- 0053_contract_document_single_current.sql
--
-- PROPOSED — NOT APPLIED. Prepared for review only (Phase 2F).
--
-- WHY THIS IS A SEPARATE MIGRATION
--   The "at most one current schedule per contract" rule depends on the ORDER
--   in which a new version is published. The Phase 2C draft expressed it as a
--   partial UNIQUE index, which only works if the client SUPERSEDES the old
--   version BEFORE inserting the new one. The client does the opposite (insert
--   first, then supersede) because that order never leaves a contract without a
--   current document if the device dies mid-issue. The two orders are mutually
--   exclusive, so the rule is expressed here as a TRIGGER that works with the
--   insert-first order.
--
-- THE TWO ORDERS AND THEIR FAILURE BEHAVIOUR
--   supersede-first:
--     + the server never holds two current versions;
--     + a unique index alone would enforce it;
--     - if the device dies between the two writes, the contract has NO current
--       schedule until the user re-issues. Migration 0052's trigger also
--       REFUSES a supersede whose target does not exist yet, so an old client
--       cannot publish at all against 0052.
--   insert-first (chosen, and what the current client does):
--     + the contract ALWAYS has a current version, locally and after a crash;
--     - between the two writes the server can briefly hold two current
--       versions, so the public page could present the stale one as current.
--   This migration closes that window: the INSERT itself retires the older
--   current schedule in the SAME transaction, so the server never holds two
--   current versions and the public page never shows a stale schedule as the
--   current one. Verified against a disposable PostgreSQL 15.18 with two
--   independent sessions (Phase 2E).
--
-- VERSION RULES (identical to migration 0052)
--   R1 — CANONICAL (what a NEW version must be):
--       jsonb_typeof(data->'documentVersion') = 'number'
--       AND (data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$'
--   R2 — LEGACY COMPARISON VALUE (how an EXISTING row is ordered/compared):
--       CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
--            THEN (data->>'documentVersion')::INT ELSE 0 END
--   R2 is used here so that a historical row whose version is not canonical is
--   still comparable (and therefore still retirable) instead of being skipped
--   by a regex filter. The CASE form can never raise: the `::INT` cast is only
--   evaluated for a text form of at most nine digits.
--
-- WHAT IT DOES
--   An AFTER INSERT trigger on a VALID schedule retires the contract's other
--   current schedules (the ones with a lower version). If the inserted
--   schedule is itself STALE (another current schedule with a HIGHER version
--   already exists — an out-of-order retry from a second device), the NEW row
--   is retired instead, so "newest version wins" always holds.
--
--   No existing row is modified. Contracts that already hold more than one
--   current schedule are REPORTED by the preflight and left exactly as they
--   are; the next issuance for such a contract repairs it.
--
-- DEPLOYMENT ORDER
--   Apply AFTER 0052 and after the insert-first client is deployed. The trigger
--   is compatible with both client orders, but 0052's `supersededBy` validation
--   expects the insert-first order.
--
-- LOCKING
--   One transaction; CREATE TRIGGER takes a SHARE ROW EXCLUSIVE lock on the
--   table (two rows in production). The trigger's own UPDATE runs inside the
--   inserting transaction and briefly locks the retired row.
--
-- CONCURRENCY NOTE
--   Two devices publishing a version for the same contract at the same instant
--   can deadlock (each trigger retiring the other's row). PostgreSQL detects
--   the deadlock, aborts one transaction with 40P01, and the sync gateway
--   treats 5xx as retryable, so the failed write is re-sent and converges.
-- ============================================================================

BEGIN;

-- ─── Preflight: report (never rewrite) contracts with several current rows ──
DO $$
DECLARE
  multi_valid INT;
BEGIN
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
    RAISE NOTICE 'contract_documents: % contract(s) currently hold more than one VALID schedule. They were NOT modified: the next issuance for each of them retires the older current schedule.', multi_valid;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enforce_contract_document_single_current()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_cid         TEXT;
  v_new_version INT;
  v_higher      RECORD;
  v_row         RECORD;
BEGIN
  -- Only a newly published CURRENT schedule can change what is current.
  IF NEW.data->>'documentType' IS DISTINCT FROM 'printing_contract_schedule' THEN
    RETURN NEW;
  END IF;
  IF UPPER(COALESCE(NEW.data->>'status', '')) <> 'VALID' THEN
    RETURN NEW;
  END IF;
  v_cid := COALESCE(NEW.data->>'contract_id', '');
  IF v_cid = '' THEN
    RETURN NEW;
  END IF;

  -- SERIALISE the publications of one contract.
  --
  -- Two devices that publish a version for the same contract at the same
  -- moment each see only the rows that are already committed, so each would
  -- retire the older versions it can see and leave its own row current: the
  -- contract would end up with TWO current schedules. Proved in Phase 2H with
  -- two independent sessions.
  --
  -- A transaction-scoped advisory lock on the contract id makes the two
  -- publications serialise: the second one waits for the first to commit and
  -- then sees its row, so it retires it. The lock is released at COMMIT.
  PERFORM pg_advisory_xact_lock(hashtext(v_cid)::bigint);

  -- R2: the comparison value of the version being published. A non-canonical
  -- version compares as 0, i.e. it can never become the current document — and
  -- it is still processed below, so it is retired as stale instead of being
  -- silently ignored (which used to leave two current schedules behind).
  v_new_version := CASE WHEN (NEW.data->>'documentVersion') ~ '^[0-9]{1,9}$'
                        THEN (NEW.data->>'documentVersion')::INT ELSE 0 END;

  -- 1. A STALE insert (a version that is not newer than an already current
  --    one) must not become the current document. Retire the row that was just
  --    inserted; the higher version stays current.
  SELECT id, (data->>'documentVersion') AS v
    INTO v_higher
  FROM public.contract_documents
  WHERE id <> NEW.id
    AND COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
    AND COALESCE(data->>'contract_id', '') = v_cid
    AND UPPER(COALESCE(data->>'status', '')) = 'VALID'
    AND (CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
              THEN (data->>'documentVersion')::INT ELSE 0 END) > v_new_version
  ORDER BY (CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
                  THEN (data->>'documentVersion')::INT ELSE 0 END) DESC
  LIMIT 1;
  IF FOUND THEN
    UPDATE public.contract_documents
    SET data = jsonb_set(
          jsonb_set(data, '{status}', to_jsonb('SUPERSEDED'::text), true),
          '{supersededBy}', to_jsonb(v_higher.id), true)
    WHERE id = NEW.id;
    RETURN NEW;
  END IF;

  -- 2. The normal case: retire every current schedule of this contract that
  --    is NOT NEWER than the row just published.
  --
  --    The comparison is "<=" and not "<": a legacy row whose version compares
  --    EQUAL to the new one (e.g. the legacy '01' and the canonical 1) is
  --    superseded by it as well. With a strict "<" such a row would stay VALID
  --    and the contract would keep TWO current schedules — proved in Phase 2F.
  --
  --    Oldest first keeps the lock order consistent and lowers the chance of
  --    a deadlock between two concurrent issuances.
  FOR v_row IN
    SELECT id FROM public.contract_documents
    WHERE id <> NEW.id
      AND COALESCE(data->>'documentType', '') = 'printing_contract_schedule'
      AND COALESCE(data->>'contract_id', '') = v_cid
      AND UPPER(COALESCE(data->>'status', '')) = 'VALID'
      AND (CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
                THEN (data->>'documentVersion')::INT ELSE 0 END) <= v_new_version
    ORDER BY (CASE WHEN (data->>'documentVersion') ~ '^[0-9]{1,9}$'
                    THEN (data->>'documentVersion')::INT ELSE 0 END) ASC
  LOOP
    UPDATE public.contract_documents
    SET data = jsonb_set(
          jsonb_set(data, '{status}', to_jsonb('SUPERSEDED'::text), true),
          '{supersededBy}', to_jsonb(NEW.id), true)
    WHERE id = v_row.id;
  END LOOP;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_contract_documents_single_current ON public.contract_documents;
CREATE TRIGGER trg_contract_documents_single_current
  AFTER INSERT ON public.contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_document_single_current();

COMMIT;

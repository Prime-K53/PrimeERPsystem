-- ============================================================================
-- 0052_contract_document_identity.test.sql
--
-- POSTGRESQL BEHAVIOUR TESTS for migrations 0049 + 0052 + 0053.
--
-- HOW TO RUN (a DISPOSABLE instance only — never production)
--   createdb contract_doc_test
--   psql -v ON_ERROR_STOP=1 -d contract_doc_test \
--        -f supabase/migrations/0049_contract_documents.sql \
--        -f supabase/migrations/0052_contract_document_identity.sql \
--        -f supabase/migrations/0053_contract_document_single_current.sql \
--        -f supabase/tests/0052_contract_document_identity.test.sql
--
--   The script runs inside ONE transaction and ROLLS BACK at the end, so the
--   disposable database is left exactly as it was. Any violated invariant
--   aborts the run (the helpers raise); nothing is suppressed to obtain a
--   green result.
--
-- WHAT IT COVERS
--   A. identity: schedules are unique per (contract_id, documentVersion);
--      a schedule and a receipt may share a contract id and a version;
--      several receipts of one contract are allowed; TWO CONTRACTS MAY SHARE
--      THE SAME HUMAN-READABLE CONTRACT NUMBER.
--   B. versions: canonical, legacy, missing, null, string, zero, negative,
--      fractional, exponent form, the largest supported version, one above it
--      and a very large integer. Malformed rows are never rewritten and never
--      abort the index build; a malformed VALID schedule must not block the
--      publication of the next canonical version.
--   C. immutability: content, hash, hash rule, token, identity, issuance
--      audit fields, the row id and the payload id cannot change; deletes and
--      tombstones are refused.
--   D. lifecycle: VALID -> SUPERSEDED is allowed, an idempotent repeat is
--      allowed, a resurrection to VALID is refused, VOID is refused, and a
--      supersede must point at a real, newer row of the same contract/type.
--   E. single current schedule (0053): publishing a new version retires the
--      older one; a stale (lower) version retires itself.
--   F. concurrency (same-version and different-version issuance) is NOT covered
--      here — it needs two independent sessions and lives in the Phase 2E
--      harness.
-- ============================================================================

\set ON_ERROR_STOP on

BEGIN;

-- ─── helpers ──────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.assert_rejected(stmt text, expected text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_msg TEXT;
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg LIKE '%' || expected || '%' THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'ASSERT FAILED: expected "%" in the error, got: %', expected, v_msg;
  END;
  RAISE EXCEPTION 'ASSERT FAILED: the statement was ACCEPTED, expected a rejection containing "%": %', expected, stmt;
END $$;

CREATE FUNCTION pg_temp.assert_accepted(stmt text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'ASSERT FAILED: the statement was REJECTED, expected acceptance: %', SQLERRM;
  END;
END $$;

CREATE FUNCTION pg_temp.assert_true(cond boolean, what text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cond IS NOT TRUE THEN
    RAISE EXCEPTION 'ASSERT FAILED: %', what;
  END IF;
END $$;

-- ─── fixtures ─────────────────────────────────────────────────────────────
-- A schedule v1 and a receipt v1 that share one contract id and one version:
-- the production shape (two live rows, same contract_id, documentVersion 1).
INSERT INTO public.contract_documents (id, data) VALUES
  ('SCH-cid-1-v1', jsonb_build_object(
      'id', 'SCH-cid-1-v1', 'contract_id', 'cid-1',
      'documentType', 'printing_contract_schedule',
      'documentNumber', 'PC-1', 'documentVersion', 1,
      'status', 'VALID', 'verificationToken', 'tok-sched-1',
      'contentHash', repeat('a', 64), 'hashVersion', 2,
      'content', jsonb_build_object('contractNumber', 'PC-1', 'customerName', 'School'))),
  ('PCR-item-1', jsonb_build_object(
      'id', 'PCR-item-1', 'contract_id', 'cid-1',
      'documentType', 'printing_contract_completion_receipt',
      'documentNumber', 'PCR-PC-1', 'documentVersion', 1,
      'status', 'VALID', 'verificationToken', 'tok-receipt-1',
      'assessmentItemId', 'item-1',
      'contentHash', repeat('b', 64),
      'content', jsonb_build_object('receiptNumber', 'PCR-PC-1')));

-- ─── A. identity ──────────────────────────────────────────────────────────
-- A schedule and a receipt may share a contract id and a version.
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents WHERE data->>'contract_id' = 'cid-1') = 2,
  'the schedule and the receipt of one contract must both exist');

-- A SECOND receipt of the same contract is allowed (receipt identity is the
-- assessment item; the schedule identity index must not apply to it).
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('PCR-item-2', jsonb_build_object(
    'id', 'PCR-item-2', 'contract_id', 'cid-1',
    'documentType', 'printing_contract_completion_receipt',
    'documentNumber', 'PCR-PC-1', 'documentVersion', 2,
    'status', 'VALID', 'verificationToken', 'tok-receipt-2',
    'assessmentItemId', 'item-2', 'contentHash', repeat('c', 64)))
$q$);

-- A second receipt for the SAME assessment item is refused (0049's item index).
SELECT pg_temp.assert_rejected($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('PCR-item-2-alt', jsonb_build_object(
    'id', 'PCR-item-2-alt', 'contract_id', 'cid-1',
    'documentType', 'printing_contract_completion_receipt',
    'documentNumber', 'PCR-PC-1', 'documentVersion', 3,
    'status', 'VALID', 'verificationToken', 'tok-receipt-2-alt',
    'assessmentItemId', 'item-2', 'contentHash', repeat('c', 64)))
$q$, 'uq_contract_documents_receipt_item');

-- A second schedule with the SAME identity is refused (the identity index).
SELECT pg_temp.assert_rejected($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-1-v1-dup', jsonb_build_object(
    'id', 'SCH-cid-1-v1-dup', 'contract_id', 'cid-1',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-1', 'documentVersion', 1,
    'status', 'VALID', 'verificationToken', 'tok-dup',
    'contentHash', repeat('d', 64)))
$q$, 'uq_contract_documents_schedule_identity');

-- TWO DIFFERENT CONTRACTS MAY SHARE THE SAME HUMAN-READABLE NUMBER: the
-- number is a label, not an identity (live production has PC-P726/022 twice).
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-2-v1', jsonb_build_object(
    'id', 'SCH-cid-2-v1', 'contract_id', 'cid-2',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-1', 'documentVersion', 1,
    'status', 'VALID', 'verificationToken', 'tok-cid-2',
    'contentHash', repeat('e', 64)))
$q$);
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents
    WHERE data->>'documentNumber' = 'PC-1' AND data->>'documentType' = 'printing_contract_schedule') = 2,
  'two contracts sharing a human number must each be able to hold a schedule');

-- ─── B. versions ──────────────────────────────────────────────────────────
-- B1. The largest supported canonical version is accepted.
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-max-v', jsonb_build_object(
    'id', 'SCH-max-v', 'contract_id', 'cid-max',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-MAX', 'documentVersion', 999999999,
    'status', 'VALID', 'verificationToken', 'tok-max',
    'contentHash', repeat('f', 64)))
$q$);

-- B2. One above the supported maximum is refused (and must not break anything).
SELECT pg_temp.assert_rejected($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-over-v', jsonb_build_object(
    'id', 'SCH-over-v', 'contract_id', 'cid-over',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-OVER', 'documentVersion', 1000000000,
    'status', 'VALID', 'verificationToken', 'tok-over',
    'contentHash', repeat('f', 64)))
$q$, 'at most nine digits');

-- B3. A very large integer is refused the same way.
SELECT pg_temp.assert_rejected($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-huge-v', jsonb_build_object(
    'id', 'SCH-huge-v', 'contract_id', 'cid-huge',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-HUGE', 'documentVersion', 99999999999999999999,
    'status', 'VALID', 'verificationToken', 'tok-huge',
    'contentHash', repeat('f', 64)))
$q$, 'at most nine digits');

-- B4. A missing version key: the row is stored verbatim, WITHOUT a version.
--     (The key is genuinely absent — not defaulted to 1.)
--     Legacy rows are created the way they actually exist: written BEFORE
--     0052 introduced the canonical-version rule. The trigger is therefore
--     disabled for these inserts only — it is the trigger that refuses a NEW
--     document whose version is not canonical, and re-enabled immediately.
ALTER TABLE public.contract_documents DISABLE TRIGGER trg_contract_documents_immutable;
INSERT INTO public.contract_documents (id, data) VALUES
  ('SCH-noversion', jsonb_build_object(
      'id', 'SCH-noversion', 'contract_id', 'cid-noversion',
      'documentType', 'printing_contract_schedule',
      'documentNumber', 'PC-NOVER', 'status', 'VALID',
      'verificationToken', 'tok-noversion', 'contentHash', repeat('f', 64))),
  ('SCH-null-v', jsonb_build_object('id','SCH-null-v','contract_id','cid-null','documentType','printing_contract_schedule','documentNumber','PC-NULL','documentVersion',NULL,'status','VALID','verificationToken','tok-null','contentHash',repeat('f',64))),
  ('SCH-str-v', jsonb_build_object('id','SCH-str-v','contract_id','cid-str','documentType','printing_contract_schedule','documentNumber','PC-STR','documentVersion','1','status','VALID','verificationToken','tok-str','contentHash',repeat('f',64))),
  ('SCH-lead-v', jsonb_build_object('id','SCH-lead-v','contract_id','cid-lead','documentType','printing_contract_schedule','documentNumber','PC-LEAD','documentVersion','01','status','VALID','verificationToken','tok-lead','contentHash',repeat('f',64))),
  ('SCH-zero-v', jsonb_build_object('id','SCH-zero-v','contract_id','cid-zero','documentType','printing_contract_schedule','documentNumber','PC-ZERO','documentVersion',0,'status','VALID','verificationToken','tok-zero','contentHash',repeat('f',64))),
  ('SCH-neg-v', jsonb_build_object('id','SCH-neg-v','contract_id','cid-neg','documentType','printing_contract_schedule','documentNumber','PC-NEG','documentVersion',-1,'status','VALID','verificationToken','tok-neg','contentHash',repeat('f',64))),
  ('SCH-frac-v', jsonb_build_object('id','SCH-frac-v','contract_id','cid-frac','documentType','printing_contract_schedule','documentNumber','PC-FRAC','documentVersion',1.5,'status','VALID','verificationToken','tok-frac','contentHash',repeat('f',64))),
  ('SCH-exp-v', jsonb_build_object('id','SCH-exp-v','contract_id','cid-exp','documentType','printing_contract_schedule','documentNumber','PC-EXP','documentVersion','1e3','status','VALID','verificationToken','tok-exp','contentHash',repeat('f',64)));
ALTER TABLE public.contract_documents ENABLE TRIGGER trg_contract_documents_immutable;

SELECT pg_temp.assert_true(
  NOT EXISTS (SELECT 1 FROM public.contract_documents WHERE id = 'SCH-noversion' AND data ? 'documentVersion'),
  'a document with no documentVersion key must keep it absent');
SELECT pg_temp.assert_true(
  (SELECT data->>'documentVersion' FROM public.contract_documents WHERE id = 'SCH-noversion') IS NULL,
  'a missing version must read back as NULL, never as 1');
SELECT pg_temp.assert_true(
  (SELECT data->>'documentVersion' FROM public.contract_documents WHERE id = 'SCH-lead-v') = '01',
  'a legacy version must be stored verbatim, never renumbered');
SELECT pg_temp.assert_true(
  (SELECT data->>'documentVersion' FROM public.contract_documents WHERE id = 'SCH-frac-v') = '1.5',
  'a fractional legacy version must be stored verbatim');
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents
    WHERE id IN ('SCH-noversion','SCH-null-v','SCH-str-v','SCH-lead-v','SCH-zero-v','SCH-neg-v','SCH-frac-v','SCH-exp-v')
      AND jsonb_typeof(data->'documentVersion') = 'number'
      AND (data->>'documentVersion') ~ '^[1-9][0-9]{0,8}$') = 0,
  'no malformed version may be covered by the identity index');

-- B6. A malformed VALID schedule must NOT block the publication of the next
--     canonical version of its contract (the legacy comparison rule).
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-lead-v2', jsonb_build_object(
    'id', 'SCH-lead-v2', 'contract_id', 'cid-lead',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-LEAD', 'documentVersion', 2,
    'status', 'VALID', 'verificationToken', 'tok-lead-2',
    'contentHash', repeat('f', 64)))
$q$);
SELECT pg_temp.assert_true(
  (SELECT data->>'status' FROM public.contract_documents WHERE id = 'SCH-lead-v') = 'SUPERSEDED',
  'the malformed legacy schedule must be retired when a newer version is published');
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents
    WHERE data->>'contract_id' = 'cid-lead' AND data->>'documentType' = 'printing_contract_schedule' AND data->>'status' = 'VALID') = 1,
  'exactly one current schedule must remain for a contract with a legacy version');

-- ─── C. immutability ──────────────────────────────────────────────────────
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{content}', '"tampered"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{contentHash}', ('"' || repeat('1', 64) || '"')::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{hashVersion}', '1'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{verificationToken}', '"tok-stolen"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{documentNumber}', '"PC-9"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{issuedAt}', '"2020-01-01T00:00:00.000Z"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'immutable');

-- The row identity itself.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET id = 'SCH-renamed' WHERE id = 'SCH-cid-1-v1'
$q$, 'row id is immutable');

-- The duplicated payload id.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{id}', '"SCH-other"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'payload id is immutable');

-- A tombstone (soft delete) of an issued document.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{deleted}', 'true'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'must not be tombstoned');

-- A hard delete.
SELECT pg_temp.assert_rejected($q$
  DELETE FROM public.contract_documents WHERE id = 'SCH-cid-1-v1'
$q$, 'cannot be deleted');

-- ─── D. lifecycle ─────────────────────────────────────────────────────────
-- Publish v2 (the insert happens BEFORE the supersede, by contract).
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-1-v2', jsonb_build_object(
    'id', 'SCH-cid-1-v2', 'contract_id', 'cid-1',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-1', 'documentVersion', 2,
    'status', 'VALID', 'verificationToken', 'tok-sched-2',
    'contentHash', repeat('2', 64), 'hashVersion', 2,
    'content', jsonb_build_object('contractNumber', 'PC-1', 'customerName', 'School')))
$q$);

-- Superseding v1 -> v2 is allowed.
SELECT pg_temp.assert_accepted($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-cid-1-v2"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$);

-- Re-sending the SAME supersede (a retried write) is allowed.
SELECT pg_temp.assert_accepted($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-cid-1-v2"'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$);

-- Resurrection is refused.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"VALID"'::jsonb), '{supersededBy}', 'null'::jsonb)
  WHERE id = 'SCH-cid-1-v1'
$q$, 'illegal status transition');

-- VOID is refused (business decision still open).
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents SET data = jsonb_set(data, '{status}', '"VOID"'::jsonb)
  WHERE id = 'SCH-cid-1-v2'
$q$, 'VOID is not an available transition');

-- A supersede pointing at a row that does not exist.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-does-not-exist"'::jsonb)
  WHERE id = 'SCH-cid-2-v1'
$q$, 'does not exist yet');

-- A supersede pointing at another contract's row.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-cid-1-v2"'::jsonb)
  WHERE id = 'SCH-cid-2-v1'
$q$, 'different contract');

-- A supersede pointing at itself.
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-cid-2-v1"'::jsonb)
  WHERE id = 'SCH-cid-2-v1'
$q$, 'cannot supersede itself');

-- A LOWER version may never supersede a higher one.
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-2-v2', jsonb_build_object(
    'id', 'SCH-cid-2-v2', 'contract_id', 'cid-2',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-1', 'documentVersion', 2,
    'status', 'VALID', 'verificationToken', 'tok-cid-2-b',
    'contentHash', repeat('3', 64)))
$q$);
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-cid-2-v1"'::jsonb)
  WHERE id = 'SCH-cid-2-v2'
$q$, 'must have a greater version');

-- A legacy version keeps its numeric value: '05' compares as 5, so a target
-- of version 3 may NOT supersede it (a lower version can never supersede a
-- higher one, and the legacy value is not treated as zero).
ALTER TABLE public.contract_documents DISABLE TRIGGER trg_contract_documents_immutable;
INSERT INTO public.contract_documents (id, data) VALUES ('SCH-lead2-v05', jsonb_build_object(
  'id','SCH-lead2-v05','contract_id','cid-lead2','documentType','printing_contract_schedule',
  'documentNumber','PC-LEAD2','documentVersion','05','status','VALID',
  'verificationToken','tok-lead2','contentHash',repeat('f',64)));
ALTER TABLE public.contract_documents ENABLE TRIGGER trg_contract_documents_immutable;
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-lead2-v3', jsonb_build_object(
    'id', 'SCH-lead2-v3', 'contract_id', 'cid-lead2',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-LEAD2', 'documentVersion', 3,
    'status', 'VALID', 'verificationToken', 'tok-lead2-3',
    'contentHash', repeat('f', 64)))
$q$);
SELECT pg_temp.assert_rejected($q$
  UPDATE public.contract_documents
  SET data = jsonb_set(jsonb_set(data, '{status}', '"SUPERSEDED"'::jsonb), '{supersededBy}', '"SCH-lead2-v3"'::jsonb)
  WHERE id = 'SCH-lead2-v05'
$q$, 'must not be older');

-- ─── E. single current schedule (0053) ────────────────────────────────────
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents
    WHERE data->>'contract_id' = 'cid-1' AND data->>'status' = 'VALID'
      AND data->>'documentType' = 'printing_contract_schedule') = 1,
  'after publishing v2 exactly one schedule of cid-1 may be VALID');

-- cid-3 holds a VALID schedule with a MALFORMED version (a pre-existing row:
-- written before 0052 required a canonical version). Publishing a canonical
-- version for cid-3 must retire it — a legacy version must never block the
-- publication of the next version.
ALTER TABLE public.contract_documents DISABLE TRIGGER trg_contract_documents_immutable;
INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-3-legacy', jsonb_build_object(
  'id', 'SCH-cid-3-legacy', 'contract_id', 'cid-3',
  'documentType', 'printing_contract_schedule',
  'documentNumber', 'PC-3', 'documentVersion', '01',
  'status', 'VALID', 'verificationToken', 'tok-cid-3-legacy',
  'contentHash', repeat('4', 64)));
ALTER TABLE public.contract_documents ENABLE TRIGGER trg_contract_documents_immutable;
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-3-v1', jsonb_build_object(
    'id', 'SCH-cid-3-v1', 'contract_id', 'cid-3',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-3', 'documentVersion', 1,
    'status', 'VALID', 'verificationToken', 'tok-cid-3-b',
    'contentHash', repeat('4', 64)))
$q$);
SELECT pg_temp.assert_true(
  (SELECT data->>'status' FROM public.contract_documents WHERE id = 'SCH-cid-3-legacy') = 'SUPERSEDED',
  'the legacy (malformed version) schedule must be retired when a newer version is published');
SELECT pg_temp.assert_true(
  (SELECT count(*) FROM public.contract_documents
    WHERE data->>'contract_id' = 'cid-3' AND data->>'status' = 'VALID'
      AND data->>'documentType' = 'printing_contract_schedule') = 1,
  'publishing a version must retire the contract''s previous current schedule');

-- A STALE insert (a lower version published while a higher one is already
-- current) must retire ITSELF, not the current one. cid-4 publishes version 2
-- first, so version 1 is a genuinely stale, still-canonical version.
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-4-v2', jsonb_build_object(
    'id', 'SCH-cid-4-v2', 'contract_id', 'cid-4',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-4', 'documentVersion', 2,
    'status', 'VALID', 'verificationToken', 'tok-cid-4-b',
    'contentHash', repeat('5', 64)))
$q$);
SELECT pg_temp.assert_accepted($q$
  INSERT INTO public.contract_documents (id, data) VALUES ('SCH-cid-4-v1', jsonb_build_object(
    'id', 'SCH-cid-4-v1', 'contract_id', 'cid-4',
    'documentType', 'printing_contract_schedule',
    'documentNumber', 'PC-4', 'documentVersion', 1,
    'status', 'VALID', 'verificationToken', 'tok-cid-4-c',
    'contentHash', repeat('5', 64)))
$q$);
SELECT pg_temp.assert_true(
  (SELECT data->>'status' FROM public.contract_documents WHERE id = 'SCH-cid-4-v1') = 'SUPERSEDED',
  'a stale (lower version) insert must retire itself');
SELECT pg_temp.assert_true(
  (SELECT data->>'status' FROM public.contract_documents WHERE id = 'SCH-cid-4-v2') = 'VALID',
  'the current schedule must stay VALID');

ROLLBACK;

\echo '0052/0053 contract document behaviour: ALL ASSERTIONS PASSED'

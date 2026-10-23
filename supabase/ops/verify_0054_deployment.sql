-- =============================================================================
-- Post-apply verification for 0054_contract_documents_rls_hardening.sql
-- READ-ONLY overall, but sections 3 and 6 deliberately attempt a forbidden
-- write inside BEGIN … ROLLBACK. RUN THIS FILE AS ONE psql SCRIPT.
-- Do NOT run it with `run-sql.mjs --each`: splitting the statements would
-- autocommit the probe UPDATE/INSERT instead of rolling it back.
-- =============================================================================

\echo '--- 1. the policy set (must be exactly one row) ---'
SELECT policyname, cmd, roles::TEXT AS roles, qual AS using, COALESCE(with_check, '-') AS with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'contract_documents'
ORDER BY policyname;
-- EXPECTED: exactly one row
--   select_contract_documents | SELECT | {authenticated} | true | -
-- The FOR ALL policy is gone.

\echo '--- 2. the direct write path is closed for every non-bypassing role ---'
SELECT r AS role,
       has_table_privilege(r, 'public.contract_documents', 'SELECT') AS can_select,
       has_table_privilege(r, 'public.contract_documents', 'INSERT') AS can_insert,
       has_table_privilege(r, 'public.contract_documents', 'UPDATE') AS can_update,
       has_table_privilege(r, 'public.contract_documents', 'DELETE') AS can_delete
FROM (VALUES ('anon'), ('authenticated'), ('service_role')) v(r);
-- EXPECTED: anon and authenticated can_select = true, can_insert/can_update/
--            can_delete = false (RLS refuses them); service_role can write
--            (it holds the table privilege and BYPASSES RLS).

\echo '--- 3. an authenticated session must not be able to forge a document ---'
-- The probe below runs the write as the authenticated role and is expected
-- to be refused. It is rolled back either way, so it changes nothing.
BEGIN;
SET LOCAL ROLE authenticated;
UPDATE public.contract_documents
   SET data = jsonb_set(data, '{contentHash}', '"forged-hash"')
 WHERE id = (SELECT id FROM public.contract_documents LIMIT 1);
ROLLBACK;
-- EXPECTED: "permission denied for table contract_documents" (or
--            "new row violates row-level security policy").

\echo '--- 4. an anonymous session sees nothing ---'
BEGIN;
SET LOCAL ROLE anon;
SELECT count(*) AS anon_visible_rows FROM public.contract_documents;
ROLLBACK;
-- EXPECTED: 0.

\echo '--- 5. an authenticated session still reads (the realtime path) ---'
BEGIN;
SET LOCAL ROLE authenticated;
SELECT count(*) AS authenticated_visible_rows FROM public.contract_documents;
ROLLBACK;
-- EXPECTED: the same count as the service role sees (nothing is narrowed).

\echo '--- 6. the service-role write path (the sync gateway) still writes ---'
BEGIN;
SET LOCAL ROLE service_role;
INSERT INTO public.contract_documents (id, data, version)
VALUES ('SCH-VERIFY-PROBE', '{"documentType":"printing_contract_schedule","contract_id":"C-PROBE","documentNumber":"PC-PROBE","documentVersion":1,"status":"VALID"}'::jsonb, 1);
ROLLBACK;
-- EXPECTED: "INSERT 0 1" and no error.

\echo '--- 7. no row was modified ---'
SELECT id, data->>'documentType' AS type, data->>'status' AS status,
       data->>'documentVersion' AS version, data->>'contract_id' AS contract
FROM public.contract_documents
WHERE id <> 'SCH-VERIFY-PROBE'
ORDER BY id;
-- EXPECTED: the same rows, statuses and versions as before the migration.

\echo '--- 8. related contract-document migrations (0052 + 0053) are applied ---'
-- 0052 (identity index + immutability trigger) and 0053 (single current
-- schedule) were applied on 2026-10-23, immediately after 0054, once the
-- insert-first client in frontend/services/contractDocumentService.ts was
-- confirmed deployed. All three triggers must now be present.
SELECT p.proname AS trigger_name
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.contract_documents'::regclass
  AND NOT t.tgisinternal
ORDER BY 1;
-- EXPECTED:
--   enforce_contract_document_immutability
--   enforce_contract_document_single_current
--   update_updated_at_column
-- (i.e. trg_contract_documents_immutable and
--  trg_contract_documents_single_current must both be PRESENT).

\echo '--- 9. the 0052 identity index replaced the old number-keyed index ---'
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'contract_documents'
ORDER BY indexname;
-- EXPECTED: uq_contract_documents_schedule_identity and
--            uq_contract_documents_receipt_item are PRESENT;
--            uq_contract_documents_number_version is ABSENT.

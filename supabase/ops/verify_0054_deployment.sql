-- =============================================================================
-- Post-apply verification for 0054_contract_documents_rls_hardening.sql
-- READ-ONLY. Nothing here writes.
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

\echo '--- 8. the remaining migrations that are still pending ---'
-- 0052 (identity index + immutability trigger) and 0053 (single current
-- schedule) are NOT applied: the DEPLOYED client supersedes the previous
-- version BEFORE inserting the replacement, and 0052's trigger refuses a
-- supersede whose target does not exist yet. They require the Phase 2D
-- client and the backend guard to be deployed first.
SELECT p.proname AS trigger_name
FROM pg_trigger t
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE t.tgrelid = 'public.contract_documents'::regclass
  AND NOT t.tgisinternal
ORDER BY 1;
-- EXPECTED: trg_contract_documents_update_updated_at only.
--            trg_contract_documents_immutable and
--            trg_contract_documents_single_current must be ABSENT.

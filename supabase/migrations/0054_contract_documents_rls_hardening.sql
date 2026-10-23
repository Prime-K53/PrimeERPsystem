-- ============================================================================
-- 0054_contract_documents_rls_hardening.sql
--
-- APPLIED to live project rdtuzuzehfbwvfdzqliw on 2026-10-23.
--
-- The RLS half of migration 0052, applied on its own first so the direct
-- write path was closed before the identity/immutability work landed.
--
-- WHY IT IS SPLIT OUT
--   0052 bundles four changes. Three of them — the identity index swap, the
--   immutability trigger and its function — REQUIRE the Phase 2D client to be
--   deployed first, because the DEPLOYED client supersedes the previous
--   version BEFORE inserting the replacement:
--
--       for (const p of prior) {
--         put({ ...p, status: 'SUPERSEDED', supersededBy: record.id });
--       }
--       put(record);                       // the replacement is written LAST
--
--   0052's trigger validates `supersededBy` against a row that must already
--   exist, so it refuses that client outright:
--
--       ERROR: contract_documents: the superseding document SCH-...-v2 does
--              not exist yet (id=SCH-...-v1)
--
--   Reproduced against a real PostgreSQL with 0049 + 0052 + 0053 applied: the
--   supersede-first client's write sequence is REJECTED, the Phase 2D
--   (insert-first) sequence is ACCEPTED. Applying 0052 before the client is
--   deployed would break every schedule re-issue. 0052 and 0053 therefore
--   stayed unapplied until the client and the backend guard were deployed, in
--   their prescribed order: client -> backend -> required_client_capability
--   -> 0052 -> 0053.
--
--   That precondition is now met: frontend/services/contractDocumentService.ts
--   inserts the replacement before superseding the previous version, and the
--   live preflight was clean, so 0052 and 0053 were applied on 2026-10-23
--   immediately after this migration.
--
--   The RLS change does NOT depend on the client protocol, and it closes a
--   live integrity hole. It is safe on its own, so it landed first.
--
-- THE HOLE THIS CLOSES
--   0049 created, on public.contract_documents:
--
--     CREATE POLICY "allow_all_contract_documents"
--       ON public.contract_documents FOR ALL TO authenticated
--       USING (true) WITH CHECK (true);
--
--   FOR ALL means SELECT, INSERT, UPDATE and DELETE. So ANY signed-in session
--   — including a portal customer, which this deployment has — could PATCH an
--   issued document's `content` and `contentHash` straight through
--   PostgREST. The document would then fail its own integrity check, but the
--   forged row is what a verification lookup returns, and nothing else in the
--   stack re-hashes an issued document on read. The "tamper-evident" claim
--   was therefore not enforced at the storage boundary.
--
-- WHAT REPLACES IT
--   SELECT for `authenticated` only.
--     - SELECT is kept: the browser's realtime subscription
--       (frontend/services/syncService.ts) and the ERP's list views need it.
--     - INSERT/UPDATE/DELETE are removed for every non-bypassing role. Every
--       business write goes through POST /api/sync/ops, which uses the
--       service-role key and bypasses RLS. That architecture is asserted by
--       frontend/tests/services/supabaseWritePathGuard.test.ts: "The browser
--       anon key must NEVER issue business writes directly."
--
--   Verified against the live project: `anon` reads 0 rows of
--   contract_documents before AND after this change, so no read path that
--   exists today is narrowed. `service_role` is unaffected (it bypasses RLS).
--
-- COMPATIBILITY
--   0052 later re-runs the same policy swap
--   (DROP POLICY IF EXISTS + CREATE POLICY), so applying it after this
--   migration is idempotent. 0052 also creates
--   uq_contract_documents_schedule_identity, which is independent of this
--   change and is deliberately NOT included here: it belongs with the
--   identity work, and dropping the number-keyed index relaxes a constraint
--   that is better changed together with the client that relies on it.
-- ============================================================================

BEGIN;

-- ─── Preflight: report what is about to change (never modifies a row) ───────
DO $$
DECLARE
  v_tables    INT;
  v_rows      INT;
  v_policies  TEXT;
  v_realtime  BOOLEAN;
BEGIN
  IF to_regclass('public.contract_documents') IS NULL THEN
    RAISE EXCEPTION 'public.contract_documents does not exist — this migration is meant for a database where 0049 is applied. Nothing was applied.';
  END IF;

  SELECT COUNT(*) INTO v_tables FROM pg_tables WHERE schemaname = 'public' AND tablename = 'contract_documents';
  SELECT COUNT(*) INTO v_rows   FROM public.contract_documents;

  SELECT string_agg(policyname || ' [' || cmd || ' TO ' || roles::text || ']', ', ' ORDER BY policyname)
    INTO v_policies
  FROM pg_policies WHERE schemaname = 'public' AND tablename = 'contract_documents';

  SELECT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'contract_documents'
  ) INTO v_realtime;

  RAISE NOTICE 'contract_documents: % row(s), policies: %', v_rows, COALESCE(v_policies, '(none)');
  RAISE NOTICE 'contract_documents: realtime publication = %', v_realtime;

  -- The direct write path must actually be open, or this migration has
  -- nothing to do and should say so rather than silently rewrite a policy
  -- that is already correct.
  IF v_policies IS NULL OR v_policies NOT LIKE '%allow_all_contract_documents%' THEN
    RAISE NOTICE 'contract_documents: the allow_all policy is already absent — nothing to revoke.';
  ELSE
    RAISE NOTICE 'contract_documents: revoking the direct write path (FOR ALL TO authenticated) and keeping the read path.';
  END IF;
END $$;

-- ─── 1. Remove the direct write path ──────────────────────────────────────
DROP POLICY IF EXISTS "allow_all_contract_documents" ON public.contract_documents;
DROP POLICY IF EXISTS "select_contract_documents" ON public.contract_documents;

-- ─── 2. Keep the read path for the signed-in application ────────────────
-- SELECT only. The realtime subscription and the ERP list views need it; the
-- writes go through the service-role sync gateway.
CREATE POLICY "select_contract_documents"
  ON public.contract_documents FOR SELECT TO authenticated
  USING (true);

COMMIT;

-- =============================================================================
-- Verification (read-only, run after the transaction)
--
--   SELECT policyname, cmd, roles, qual, with_check
--   FROM pg_policies WHERE schemaname='public' AND tablename='contract_documents';
-- EXPECTED: exactly one row —
--   select_contract_documents | SELECT | {authenticated} | true | (null)
--
--   SELECT has_table_privilege('anon',         'public.contract_documents', 'INSERT'),
--          has_table_privilege('anon',         'public.contract_documents', 'UPDATE'),
--          has_table_privilege('anon',         'public.contract_documents', 'DELETE'),
--          has_table_privilege('authenticated', 'public.contract_documents', 'INSERT'),
--          has_table_privilege('authenticated', 'public.contract_documents', 'UPDATE'),
--          has_table_privilege('authenticated', 'public.contract_documents', 'DELETE'),
--          has_table_privilege('service_role',  'public.contract_documents', 'INSERT');
-- EXPECTED: anon write = false for all three; authenticated write = false for
--            all three; service_role INSERT = true.
--
-- No row of contract_documents is modified by this migration.
-- =============================================================================

-- =============================================================================
-- REMEDIATION: remove anonymous execution of the printing-contract RPCs
-- =============================================================================
-- WHY
--   Six contract functions are granted EXECUTE to `anon` (and, because the
--   PostgreSQL default is EXECUTE TO PUBLIC, to PUBLIC as well). Two of them
--   are SECURITY DEFINER and move money:
--     • consume_contract_assessment_atomic — debits customers.walletBalance
--       and inserts into wallet_transactions and ledger_entries
--     • reserve_contract_assessment_atomic — creates reserved assessments
--     • verify_payment_and_activate_contract — ACTIVATES a contract and
--       writes a CONTRACT_ACTIVATION wallet transaction
--     • create_assessment_contract — creates contracts from caller-supplied
--       customer_id / prepaid_amount / assessment_price
--   An unauthenticated internet caller can therefore reach them through
--   PostgREST. Confirmed by live probe: the function bodies execute and
--   return their own error messages, not a permission error.
--
-- WHAT THIS CHANGES
--   EXECUTE only. No business data, no table, no policy, no function body.
--   `service_role` keeps its grant, so the Prime ERP backend
--   (backend/routes/printingContracts.cjs) is unaffected — it is the only
--   caller of the two assessment RPCs, and it uses the service-role key.
--   No other code in the repository calls these six functions with `anon`
--   or `authenticated` (checked: frontend, backend, supabase/functions).
--
-- HOW TO RUN
--   Supabase dashboard → SQL Editor → paste → Run. Or with the CLI:
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
--       -f supabase/ops/revoke_anon_contract_rpcs.sql
--
--   The script is idempotent and prints what it did.
--
-- ROLLBACK
--   supabase/ops/revoke_anon_contract_rpcs.rollback.sql restores the exact
--   previous grant set.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r          record;
  v_revoked  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'consume_contract_assessment_atomic',
        'reserve_contract_assessment_atomic',
        'is_contract_date_in_closed_fy',
        'verify_payment_and_activate_contract',
        'create_assessment_contract',
        'get_contract_available_funds'
      )
  LOOP
    -- The signature is resolved from the catalogue, so there is no chance of
    -- a type mismatch silently revoking nothing.
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', r.sig);
    v_revoked := array_append(v_revoked, r.sig::TEXT);
  END LOOP;

  RAISE NOTICE 'revoked anon/authenticated/PUBLIC EXECUTE on % function(s)', array_length(v_revoked, 1);
  FOREACH r.sig IN ARRAY v_revoked LOOP
    RAISE NOTICE '  revoked: %', r.sig;
  END LOOP;
END $$;

COMMIT;

-- -----------------------------------------------------------------------------
-- Verification (run after the transaction).
--
--   SELECT p.proname,
--          has_function_privilege('anon', p.oid, 'EXECUTE')         AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
--          has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public'
--     AND p.proname IN (
--       'consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
--       'is_contract_date_in_closed_fy','verify_payment_and_activate_contract',
--       'create_assessment_contract','get_contract_available_funds')
--   ORDER BY p.proname;
--
-- EXPECTED: anon = false, authenticated = false, service_role = true.
--
-- PostgREST caches its schema, so the change can take up to ~1 minute to be
-- visible to the API. Re-run the anon probe afterwards; it must return a
-- permission error (401/403/404), never a message from inside the function.
-- =============================================================================

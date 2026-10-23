-- =============================================================================
-- ROLLBACK of revoke_anon_contract_rpcs.sql — restores the previous grants
-- =============================================================================
-- The grants below are the ones the migration chain declares for these
-- functions, PLUS the PostgreSQL default (EXECUTE TO PUBLIC) that the
-- original creation carried. Restoring the exact previous state means
-- restoring both.
--
-- 0006 grants (authenticated, anon, service_role):
--   verify_payment_and_activate_contract(TEXT, TEXT)
--   create_assessment_contract(TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC(15,2),
--                               TEXT, TEXT, TEXT, INTEGER, NUMERIC(15,2),
--                               TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT)
--   get_contract_available_funds(TEXT)
--
-- 0048 (the deployed draft) grants (authenticated, service_role + PUBLIC default):
--   consume_contract_assessment_atomic(TEXT, TEXT, TEXT, DATE)
--   reserve_contract_assessment_atomic(TEXT, TEXT, JSONB, NUMERIC, DATE)
--   is_contract_date_in_closed_fy(DATE)
--
-- WARNING: rolling back re-opens the anonymous exposure. Only use this if
-- the remediation has to be reverted, and re-apply the revoke immediately
-- after.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  r record;
BEGIN
  -- The three 0006 functions: back to their declared role list, plus PUBLIC.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('verify_payment_and_activate_contract',
                        'get_contract_available_funds')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, authenticated, anon, service_role', r.sig);
    RAISE NOTICE 'restored: %', r.sig;
  END LOOP;

  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'create_assessment_contract'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, authenticated, anon, service_role', r.sig);
    RAISE NOTICE 'restored: %', r.sig;
  END LOOP;

  -- The three assessment RPCs: back to the draft's role list, plus PUBLIC.
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('consume_contract_assessment_atomic',
                        'reserve_contract_assessment_atomic',
                        'is_contract_date_in_closed_fy')
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC, authenticated, service_role', r.sig);
    RAISE NOTICE 'restored: %', r.sig;
  END LOOP;
END $$;

COMMIT;

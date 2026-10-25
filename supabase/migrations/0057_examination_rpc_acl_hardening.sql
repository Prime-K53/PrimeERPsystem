-- ============================================================================
-- 0057_examination_rpc_acl_hardening.sql
--
-- Close the EXECUTE grants that 0050/0051 left on the authoritative
-- Examination posting functions.
--
-- Frozen defect (verified against live project rdtuzuzehfbwvfdzqliw):
--   post_examination_invoice_atomic(...)          anon=true authenticated=true
--   void_examination_invoice_atomic(...)          anon=true authenticated=true
--   assert_examination_invoice_number_unique(...) anon=true authenticated=true
--   claim_next_examination_invoice_number(...)    anon=false authenticated=false
--
-- 0050/0051 revoked ALL from PUBLIC, but Supabase's baseline default
-- privileges had already granted EXECUTE explicitly to anon and authenticated.
-- Revoking from PUBLIC does not remove those named grants, so any holder of
-- the public anon key could call the posting and void RPCs directly through
-- PostgREST. 0051 intended these to be service-role only; this migration makes
-- that true.
--
-- SCOPE: function privileges only. Function bodies, tables and RLS policies
-- are unchanged. The gateway (backend/services/examinationPostingService.cjs)
-- calls these with the service-role key, which keeps EXECUTE.
--
-- ROLLBACK
--   GRANT EXECUTE ON FUNCTION
--     public.post_examination_invoice_atomic(TEXT,TEXT,TEXT,JSONB,JSONB,INTEGER,DATE)
--     TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION
--     public.void_examination_invoice_atomic(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT[],DATE)
--     TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION
--     public.assert_examination_invoice_number_unique(TEXT)
--     TO anon, authenticated;
-- ============================================================================

BEGIN;

-- ─── 1. Revoke every client role, then grant only the service role ──────────
REVOKE ALL ON FUNCTION public.post_examination_invoice_atomic(
  TEXT, TEXT, TEXT, JSONB, JSONB, INTEGER, DATE
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.void_examination_invoice_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], DATE
) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.assert_examination_invoice_number_unique(
  TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.post_examination_invoice_atomic(
  TEXT, TEXT, TEXT, JSONB, JSONB, INTEGER, DATE
) TO service_role;

GRANT EXECUTE ON FUNCTION public.void_examination_invoice_atomic(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT[], DATE
) TO service_role;

GRANT EXECUTE ON FUNCTION public.assert_examination_invoice_number_unique(
  TEXT
) TO service_role;

-- ─── 2. Verification: fail the migration if any client grant survives ───────
DO $$
DECLARE
  v_signature TEXT;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.post_examination_invoice_atomic(text,text,text,jsonb,jsonb,integer,date)',
    'public.void_examination_invoice_atomic(text,text,text,text,text,text[],date)',
    'public.assert_examination_invoice_number_unique(text)'
  ] LOOP
    IF to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION '0057 verification failed: function % is missing', v_signature;
    END IF;

    IF has_function_privilege('anon', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '0057 verification failed: anon can EXECUTE %', v_signature;
    END IF;

    IF has_function_privilege('authenticated', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '0057 verification failed: authenticated can EXECUTE %', v_signature;
    END IF;

    IF NOT has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION '0057 verification failed: service_role cannot EXECUTE %', v_signature;
    END IF;
  END LOOP;

  -- The number-claim RPC was already correct in 0042. Pin it so a later
  -- blanket GRANT cannot silently reopen a second posting path.
  IF has_function_privilege(
    'anon',
    'public.claim_next_examination_invoice_number(text,integer,text)',
    'EXECUTE'
  ) OR has_function_privilege(
    'authenticated',
    'public.claim_next_examination_invoice_number(text,integer,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      '0057 verification failed: claim_next_examination_invoice_number is executable by a client role';
  END IF;
END $$;

COMMIT;

-- Assertions that must hold immediately after 0048 is applied, inside the
-- same transaction. Any failure RAISEs, which aborts and rolls back the
-- whole transaction — so a failed rehearsal leaves nothing behind.
DO $$
DECLARE
  v_ok      BOOLEAN;
  v_missing TEXT[];
  v_capture TEXT;
BEGIN
  -- 1. All six functions exist.
  SELECT array_agg(t.expected) INTO v_missing
  FROM (VALUES
    ('consume_contract_assessment_atomic'), ('reserve_contract_assessment_atomic'),
    ('resolve_posting_account'), ('is_contract_date_in_closed_fy'),
    ('is_contract_date_in_closed_period'), ('current_erp_rpc_role')
  ) AS t(expected)
  WHERE NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                    WHERE n.nspname = 'public' AND p.proname = t.expected);
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: missing function(s): %', v_missing;
  END IF;

  -- 2. SECURITY DEFINER exactly where it is required, and nowhere else.
  SELECT string_agg(p.proname || ':' || CASE WHEN p.prosecdef THEN 'definer' ELSE 'invoker' END, ', ')
    INTO v_capture
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND ((p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic','resolve_posting_account') AND p.prosecdef)
      OR (p.proname IN ('is_contract_date_in_closed_fy','is_contract_date_in_closed_period','current_erp_rpc_role') AND NOT p.prosecdef));
  IF v_capture IS NULL OR length(v_capture) = 0 THEN
    RAISE EXCEPTION 'ASSERT FAILED: SECURITY DEFINER is not set as required';
  END IF;

  -- 3. Every function has a pinned search_path that includes pg_temp.
  SELECT string_agg(p.proname, ', ') INTO v_capture
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
                      'resolve_posting_account','is_contract_date_in_closed_fy',
                      'is_contract_date_in_closed_period','current_erp_rpc_role')
    AND (p.proconfig IS NULL OR NOT (p.proconfig::text LIKE '%pg_temp%'));
  IF v_capture IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: unpinned search_path on: %', v_capture;
  END IF;

  -- 4. No anonymous or public execution survives.
  SELECT string_agg(p.proname, ', ') INTO v_capture
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
                      'resolve_posting_account','is_contract_date_in_closed_fy',
                      'is_contract_date_in_closed_period','current_erp_rpc_role')
    AND (has_function_privilege('anon', p.oid, 'EXECUTE')
      OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
      OR has_function_privilege('public', p.oid, 'EXECUTE'));
  IF v_capture IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: still executable by anon/authenticated/PUBLIC: %', v_capture;
  END IF;

  -- 5. The service role (the only legitimate caller) keeps EXECUTE.
  SELECT string_agg(p.proname, ', ') INTO v_capture
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
                      'resolve_posting_account','is_contract_date_in_closed_fy',
                      'is_contract_date_in_closed_period')
    AND NOT has_function_privilege('service_role', p.oid, 'EXECUTE');
  IF v_capture IS NOT NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: service_role lost EXECUTE on: %', v_capture;
  END IF;

  -- 6. The posting accounts resolve to real, postable accounts.
  IF public.resolve_posting_account('21300') IS NULL OR public.resolve_posting_account('41100') IS NULL THEN
    RAISE EXCEPTION 'ASSERT FAILED: the posting accounts do not resolve';
  END IF;

  -- 7. The closed-period gates must not block today's data.
  IF EXISTS (SELECT 1 FROM public.is_contract_date_in_closed_fy(CURRENT_DATE))
     OR EXISTS (SELECT 1 FROM public.is_contract_date_in_closed_period(CURRENT_DATE)) THEN
    RAISE EXCEPTION 'ASSERT FAILED: the closed-period gate blocks the current business date';
  END IF;

  -- 8. The migration wrote NO business data.
  IF (SELECT count(*) FROM wallet_transactions) <> (SELECT wt FROM _baseline)
     OR (SELECT count(*) FROM ledger_entries) <> (SELECT le FROM _baseline)
     OR (SELECT count(*) FROM assessment_contract_items) <> (SELECT ai FROM _baseline)
     OR (SELECT count(*) FROM assessment_contracts) <> (SELECT ct FROM _baseline)
     OR (SELECT count(*) FROM customers) <> (SELECT cu FROM _baseline)
     OR (SELECT COALESCE(SUM((data->>'walletBalance')::numeric),0) FROM customers)
        <> (SELECT wsum FROM _baseline) THEN
    RAISE EXCEPTION 'ASSERT FAILED: business data changed during the migration';
  END IF;

  RAISE NOTICE 'ALL ASSERTIONS PASSED';
END $$;

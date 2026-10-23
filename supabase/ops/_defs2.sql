-- The deployed closed-FY gate: its exact contract, and who depends on it.
SELECT p.proname,
       pg_get_function_result(p.oid) AS return_type,
       p.prosrc AS body
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'is_contract_date_in_closed_fy';

-- Which live functions call it, and how?
SELECT p.proname, p.oid::regprocedure::TEXT AS signature
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prosrc ILIKE '%is_contract_date_in_closed_fy%';

-- Is 0049 applied on the live project?
SELECT to_regclass('public.contract_documents') IS NOT NULL AS contract_documents_exists,
       to_regclass('public.contract_amendments') IS NOT NULL AS contract_amendments_exists;

-- The live helper functions that exist now (what 0048 must not break).
SELECT p.proname, p.oid::regprocedure::TEXT AS signature, pg_get_function_result(p.oid) AS returns
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND (p.proname ILIKE '%contract%' OR p.proname ILIKE '%assessment%' OR p.proname ILIKE '%closed%')
ORDER BY p.proname;

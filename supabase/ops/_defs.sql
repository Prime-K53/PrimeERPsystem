-- The live definitions of the 0048 functions, so the migration can be made
-- signature- and return-type-compatible with what is actually deployed.
SELECT p.proname,
       p.oid::regprocedure::TEXT AS signature,
       pg_get_function_result(p.oid) AS return_type,
       pg_get_function_arguments(p.oid) AS arguments,
       p.prosrc AS body
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('consume_contract_assessment_atomic',
                    'reserve_contract_assessment_atomic',
                    'is_contract_date_in_closed_fy')
ORDER BY p.proname;

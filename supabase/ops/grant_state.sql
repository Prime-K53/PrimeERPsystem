-- Grant state of the six contract functions (read-only).
-- Run before and after any grant change to prove exactly what moved.
SELECT p.proname,
       p.oid::regprocedure::TEXT AS signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       p.proconfig::TEXT AS settings,
       has_function_privilege('anon',          p.oid, 'EXECUTE') AS anon,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') AS service_role,
       has_function_privilege('public',        p.oid, 'EXECUTE') AS public_role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'consume_contract_assessment_atomic',
    'reserve_contract_assessment_atomic',
    'is_contract_date_in_closed_fy',
    'verify_payment_and_activate_contract',
    'create_assessment_contract',
    'get_contract_available_funds')
ORDER BY p.proname;

-- =============================================================================
-- Apply 0054_contract_documents_rls_hardening.sql
-- Replace the overly-broad wallet_access_policy with role-scoped policies.
-- =============================================================================
SET search_path = public;

-- 1. Drop the over-broad wallet_access_policy
DROP POLICY IF EXISTS wallet_access_policy ON public.contract_documents;

-- 2. Create scoped policies
--    read: authenticated (dashboard pages)
--    write : service_role (payment-settlement only)
CREATE POLICY wallet_read
  ON public.contract_documents
  FOR SELECT
  TO authenticated;

CREATE POLICY wallet_write
  ON public.contract_documents
  FOR INSERT, UPDATE, DELETE
  TO service_role
  WITH CHECK (true);

-- 3. Verification: list resulting policies
SELECT polname, cmd, roles::text AS roles, qual::text AS using_clause
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'contract_documents'
ORDER BY polname;
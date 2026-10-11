-- ============================================================================
-- 0049_contract_documents.sql
--
-- Phase 3 §4: immutable printing-contract customer documents (schedule +
-- completion receipt snapshots). Follows the statement_snapshots immutable
-- pattern but uses single-company allow_all RLS (matching 0039 contract tables)
-- so the existing sync gateway + pull path carries versions to every device.
--
-- Each issue is a NEW row (never an overwrite). Superseded schedules stay
-- verifiable as SUPERSEDED under their own number/version/token/hash.
-- NOT APPLIED TO PRODUCTION by this change — prepared and tested locally only.
-- Rollback: DROP TABLE IF EXISTS public.contract_documents;
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.contract_documents (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_documents_number_version
  ON public.contract_documents ((data->>'documentNumber'), ((data->>'documentVersion')::INT))
  WHERE COALESCE(data->>'documentNumber', '') <> '';

CREATE INDEX IF NOT EXISTS idx_contract_documents_contract
  ON public.contract_documents ((data->>'contract_id'));

CREATE INDEX IF NOT EXISTS idx_contract_documents_customer
  ON public.contract_documents ((data->>'customer_id'));

CREATE INDEX IF NOT EXISTS idx_contract_documents_type
  ON public.contract_documents ((data->>'documentType'));

CREATE INDEX IF NOT EXISTS idx_contract_documents_status
  ON public.contract_documents ((data->>'status'));

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_documents_verification_token
  ON public.contract_documents ((data->>'verificationToken'))
  WHERE COALESCE(data->>'verificationToken', '') <> '';

CREATE UNIQUE INDEX IF NOT EXISTS uq_contract_documents_receipt_item
  ON public.contract_documents ((data->>'assessmentItemId'))
  WHERE COALESCE(data->>'documentType', '') = 'printing_contract_completion_receipt'
    AND COALESCE(data->>'assessmentItemId', '') <> '';

DROP TRIGGER IF EXISTS trg_contract_documents_update_updated_at ON public.contract_documents;
CREATE TRIGGER trg_contract_documents_update_updated_at
  BEFORE UPDATE ON public.contract_documents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.contract_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all_contract_documents" ON public.contract_documents;
CREATE POLICY "allow_all_contract_documents"
  ON public.contract_documents FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    BEGIN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.contract_documents;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

COMMIT;

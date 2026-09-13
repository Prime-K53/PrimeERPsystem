-- ============================================================================
-- Create public.statement_snapshots for verifiable customer statements.
--
-- Statements are generated on the fly from live ledger data, so they have
-- no natural persistent identity to bind a verification token to. The ERP
-- freezes each issued statement as an immutable snapshot (statementNumber
-- + period + frozen totals + verificationToken); the QR on the statement
-- PDF verifies THAT snapshot — never live customer data.
--
-- Standard { id (= statementNumber), data JSONB, created_at, updated_at,
-- version } row contract, indexes, RLS policy, updated_at trigger and
-- realtime publication membership (mirrors 0005_portal_quotation_requests).
-- ============================================================================

-- Step 1: Create the table (idempotent)
CREATE TABLE IF NOT EXISTS public.statement_snapshots (
  id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  version INTEGER NOT NULL DEFAULT 0
);

-- Step 2: Indexes used by public verification (number + token match) and
-- statement history reads (customer scope + period).
CREATE INDEX IF NOT EXISTS idx_statement_snapshots_number
  ON public.statement_snapshots ((data->>'statementNumber'));

CREATE INDEX IF NOT EXISTS idx_statement_snapshots_customer
  ON public.statement_snapshots ((data->>'customerId'));

CREATE INDEX IF NOT EXISTS idx_statement_snapshots_status
  ON public.statement_snapshots ((data->>'status'));

CREATE INDEX IF NOT EXISTS idx_statement_snapshots_created_at
  ON public.statement_snapshots (created_at);

-- Step 3: updated_at trigger (mirrors the 0001 section-3 pattern)
DROP TRIGGER IF EXISTS trg_update_updated_at ON public.statement_snapshots;
CREATE TRIGGER trg_update_updated_at
  BEFORE UPDATE ON public.statement_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Step 4: RLS — same allow_all pattern as the rest of the single-company schema
ALTER TABLE public.statement_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "allow_all_statement_snapshots" ON public.statement_snapshots;
CREATE POLICY "allow_all_statement_snapshots" ON public.statement_snapshots
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Step 5: Realtime publication membership (idempotent)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.statement_snapshots';
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Step 6: Verify
SELECT schemaname, tablename, rowsecurity FROM pg_tables
WHERE tablename = 'statement_snapshots';

SELECT schemaname, tablename, policyname, permissive, roles, cmd
FROM pg_policies
WHERE tablename = 'statement_snapshots'
ORDER BY policyname;

-- ============================================================================
-- End of migration
-- ============================================================================

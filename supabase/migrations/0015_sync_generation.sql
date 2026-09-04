-- ============================================================================
-- 0015_sync_generation.sql
--
-- Prime ERP — Company Reset Generation
--
-- Adds a server-controlled sync_generation counter to the settings table.
-- This allows administrators to atomically increment the generation, which
-- invalidates all browser-side queued sync operations from the previous
-- generation and prevents data resurrection after a company data reset.
--
-- HOW IT WORKS:
--   - sync_generation starts at 1 (established when this migration runs).
--   - Every sync operation from the browser carries syncGeneration in its
--     envelope (frontend: durableSyncQueue, backend: applyOp).
--   - The server rejects any operation where syncGeneration < current generation.
--   - A company reset increments the generation, making all prior queued ops
--     stale and permanently unreplayable.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING means running this on an
-- already-initialised database is safe.
-- ============================================================================

-- Initialise the sync_generation setting if it does not exist.
-- All existing companies start at generation 1.
INSERT INTO public.settings (id, data, created_at, updated_at, version)
VALUES (
  'sync_generation',
  jsonb_build_object('value', 1),
  NOW(),
  NOW(),
  1
)
ON CONFLICT (id) DO NOTHING;

-- Verify the row is present (no-op if already existed)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.settings WHERE id = 'sync_generation') THEN
    -- Defensive: row missing even after ON CONFLICT DO NOTHING (should not happen)
    RAISE EXCEPTION 'sync_generation setting could not be initialised';
  END IF;
END $$;

-- Restore the updated_at trigger so the row's updated_at advances on writes.
-- (The baseline schema creates this function but it may have been dropped by
-- previous per-table trigger manipulations.)
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Ensure the trigger fires on updates to the settings row.
-- Drop first to avoid "trigger already exists" errors.
DROP TRIGGER IF EXISTS settings_updated_at ON public.settings;
CREATE TRIGGER settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON FUNCTION public.update_updated_at_column() IS
  'Auto-set updated_at on row change. Used by all sync-able tables including settings.';

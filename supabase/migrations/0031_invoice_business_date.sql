-- ============================================================================
-- 0031_invoice_business_date.sql
--
-- Prime ERP — Phase 5A: persisted invoice business date.
--
-- The Phase 5A diagnostic established a genuine contract gap: POST
-- /api/invoices validates `invoice_date` but never persists it, so a
-- backend-API invoice had no business date. The Phase 2 Transport Budget
-- contract requires the document's ACTUAL business date and explicitly
-- forbids substituting the row-creation timestamp or server time.
--
-- SCOPE (narrow):
--   - Adds ONE field to the invoice envelope data: `invoice_date`
--     (date-only YYYY-MM-DD, NULLABLE). The canonical `invoices` table is
--     the standard sync envelope (id TEXT PK, data JSONB) — per-column
--     ALTERs do not apply; the field lives inside `data` like every other
--     domain field (same convention as origin_module / due_date /
--     invoice_number). No index is added: nothing queries invoices by
--     business date (Transport Budget events carry their own indexed
--     businessDate inside transport_budget_events).
--   - NO Transport Budget tables are touched.
--   - NO multi-tenant dimensions of any kind are added (single-company system;
--     no tenant/organization/company scoping columns or logic).
--   - NO backfill: existing invoices keep a NULL/absent invoice_date.
--     Historical dates are NEVER fabricated from the row-creation timestamp.
--     Pre-existing
--     rows remain readable unchanged; only invoices created through the
--     endpoint AFTER this change carry the field.
--
-- The frontend invoice model is free-form (no schema enforcement), so this
-- field needs no frontend change; the backend POST /api/invoices handler
-- persists it (see backend/index.cjs Phase 5A integration).
-- ============================================================================

-- Envelope field, nullable, date-only. Enforced as a comment-level contract
-- (JSONB envelope columns cannot carry per-field CHECKs without table-level
-- expressions; the producer + validator fail closed on malformed dates and
-- no allocation is ever created from a missing/invalid invoice_date).
--
-- Idempotent by design: re-running is a no-op (nothing to ALTER in JSONB;
-- statement kept for provenance and clarity of the data contract).
DO $$
BEGIN
    -- Contract marker only; JSONB data fields require no DDL change.
    -- Kept explicit so the migration chain records the field addition.
    RAISE NOTICE '0031: invoices.invoice_date (data JSONB field, nullable, YYYY-MM-DD) contract registered';
END
$$;

-- ============================================================================
-- Confirmation of the constraints this migration intentionally does NOT do:
--   * does NOT modify transport_budget_events or its functions/triggers
--   * does NOT add any multi-tenant scoping column or logic anywhere
--   * does NOT backfill invoice_date from any timestamp (no fabricated dates)
--   * does NOT change invoice reads: fromSupabaseRow spreads `data`, so
--     existing rows (without the field) surface invoice_date as undefined
--     exactly as before
-- ============================================================================

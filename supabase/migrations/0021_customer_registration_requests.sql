-- ============================================================================
-- 0021_customer_registration_requests.sql
-- Public portal customer-registration requests (approval-gated intake).
--
-- Business rule:
--   Portal registration → Customer Registration Request (PENDING)
--   → ERP admin review → APPROVE → official CUST-XXXX customer + credentials.
--
-- A public registration MUST NEVER directly create:
--   - a `customers` row
--   - a `portal_users` row
--   - a JWT / refresh token / session
--
-- Pending requests live EXCLUSIVELY in this table so they can never appear
-- in the Customer List, AR/debtors, customer selectors, statements, sales,
-- payments, reports, or accounting (all of which read `customers` only).
--
-- Design (single-company, no tenant_id, no multi-tenancy):
--   Same JSONB-envelope contract as every other portal lifecycle table
--   (0001 / 0005 / 0006 / 0007 / 0008): { id TEXT PK, data JSONB, created_at,
--   updated_at, version }. Domain fields are stored inside `data` and are
--   filtered with `data->>` PostgREST predicates (backend SQL→REST shim).
--
--   Domain fields written by the backend (customerRegistrationService):
--     id (creg_<timestamp>_<random>), request_number (CREG-YYYY-######),
--     company_name, contact_name, email (normalized lower/trim),
--     phone (normalized), tier, referred_by_code (UPPER or null),
--     referred_by_id, referred_by_name (server-resolved, null unless valid),
--     status (pending | approved | rejected | cancelled), note,
--     submitted_at, created_by, assigned_to, assigned_at,
--     reviewed_by, reviewed_at, admin_notes, linked_customer_id,
--     idempotency_key, deleted_at.
--
--   NO password / password_hash / JWT / refresh-token / session material is
--   ever stored here. The request is an application, not an account.
--   Credentials are generated later, at approval, by the dedicated approval
--   phase (not this migration).
--
-- RLS design:
--   Rows are PRE-customer PII submitted by anonymous applicants (there is no
--   portal_users row yet, so no customer-isolation join is possible). The
--   table therefore gets NO permissive policy: RLS is enabled with zero
--   policies (default deny for direct PostgREST access, mirroring the
--   referral staff tables in 0006). All reads/writes go through the backend
--   service layer with the service-role key:
--     - public submission: POST /api/portal/registration-requests
--     - staff review:      GET/POST /api/portal/admin/registration-requests/*
--   Portal customers authenticate via the ERP backend (HS256 JWT) and never
--   reach PostgREST directly.
--
-- No foreign keys: the ERP envelope architecture does not use DB-level FKs
-- for document relationships (linked_customer_id is a logical reference).
-- ============================================================================

-- ─── 1. TABLE CREATION (idempotent, envelope contract) ─────────────────────
CREATE TABLE IF NOT EXISTS public.customer_registration_requests (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0
);

-- ─── 2. INDEXES (cover every `data->>` filter the app sends) ───────────────
-- Status queue (admin inbox filter).
CREATE INDEX IF NOT EXISTS idx_creg_status
    ON public.customer_registration_requests ((data->>'status'));

-- Email lookup / duplicate detection. Expression matches the service-layer
-- normalization (lowercase + whitespace-stripped); raw unnormalized values
-- are never treated as authoritative.
CREATE INDEX IF NOT EXISTS idx_creg_email
    ON public.customer_registration_requests ((lower(replace((data->>'email'), ' ', ''))));

-- Phone lookup (non-unique; normalization strips country-code/punctuation
-- variants in the service layer, so the index is for search, not identity).
CREATE INDEX IF NOT EXISTS idx_creg_phone
    ON public.customer_registration_requests ((data->>'phone'));

-- Referral attribution filter.
CREATE INDEX IF NOT EXISTS idx_creg_referred_by_code
    ON public.customer_registration_requests ((data->>'referred_by_code'));

-- Admin inbox ordering.
CREATE INDEX IF NOT EXISTS idx_creg_created_at
    ON public.customer_registration_requests (created_at);

-- Approval linkage (request → official customer).
CREATE INDEX IF NOT EXISTS idx_creg_linked_customer
    ON public.customer_registration_requests ((data->>'linked_customer_id'));

-- Request-number lookup (public status endpoint + admin detail).
CREATE INDEX IF NOT EXISTS idx_creg_request_number
    ON public.customer_registration_requests ((data->>'request_number'));

-- Active-pending duplicate protection: at most one PENDING request per
-- normalized email. The service layer ALSO checks phone/business identity
-- in JS (same pattern as payment_requests ACTIVE_STATUSES per invoice),
-- because phone normalization cannot be expressed safely as a static
-- expression index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_creg_pending_email
    ON public.customer_registration_requests ((lower(replace((data->>'email'), ' ', ''))))
    WHERE data->>'status' = 'pending';

-- Request numbers are globally unique (CREG-YYYY-######).
CREATE UNIQUE INDEX IF NOT EXISTS uq_creg_request_number
    ON public.customer_registration_requests ((data->>'request_number'));

-- ─── 3. updated_at TRIGGER (mirrors 0001 section-3 / 0008 pattern) ─────────
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['customer_registration_requests']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_update_updated_at ON public.%I', t);
        EXECUTE format(
            'CREATE TRIGGER trg_update_updated_at BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()',
            t
        );
    END LOOP;
END $$;

-- ─── 4. RLS — staff/service-role controlled (NO permissive policy) ─────────
-- Intentionally no CREATE POLICY here: with RLS enabled and zero policies,
-- direct PostgREST access is denied by default. The backend service layer
-- (service-role key, bypasses RLS) performs all reads/writes. This mirrors
-- the referral staff-table treatment in 0006 and must NOT be relaxed to the
-- legacy `allow_all_* USING (true)` pattern from 0004/0005.
ALTER TABLE public.customer_registration_requests ENABLE ROW LEVEL SECURITY;

-- ─── 5. REALTIME PUBLICATION MEMBERSHIP (idempotent) ───────────────────────
-- Included so the future ERP admin review inbox can subscribe to new
-- submissions with the same conventions as quotation/payment requests.
DO $$
DECLARE
    t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['customer_registration_requests']
        LOOP
            BEGIN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            EXCEPTION WHEN duplicate_object THEN
                NULL;
            END;
        END LOOP;
    END IF;
END $$;

-- ============================================================================
-- End of 0021
-- ============================================================================

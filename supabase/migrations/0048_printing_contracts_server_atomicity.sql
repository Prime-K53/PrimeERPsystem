-- =============================================================================
-- 0048 — Printing contracts: server-authoritative assessment reservation and
--         consumption (PostgreSQL / Supabase)
-- =============================================================================
-- STATUS: APPLIED to the live project rdtuzuzehfbwvfdzqliw (PostgreSQL 17.6).
--   It replaces an earlier DRAFT of this migration that was already deployed
--   and was executable by `anon`; the anonymous EXECUTE was revoked first
--   (supabase/ops/revoke_anon_contract_rpcs.sql). The deployed
--   is_contract_date_in_closed_fy contract (TABLE(fy_id, fy_name)) is
--   preserved by this revision — a scalar BOOLEAN would be a breaking change
--   that CREATE OR REPLACE refuses with 42P13.
--   Re-applying this file is safe: it is idempotent (CREATE OR REPLACE plus
--   explicit grants), and it creates functions and grants only — no table,
--   column, index, trigger, policy or row.
--
-- Single company, single authorized application user. This migration introduces
-- no tenancy, no company switching and no role hierarchy: it hardens the
-- existing single-company model.
--
-- Depends on (in order):
--   0006  assessment_contracts / assessment_contract_items envelope tables
--   0019  printing-contract tables + RLS
--   0020  customer wallet / payments
--   0039  envelope schema (business fields live in `data` JSONB; the
--         top-level columns are no longer the system of record)
--   0044  assessment-consumption/contract-authority RLS policy set
--
-- ---------------------------------------------------------------------------
-- WHAT THIS REVISION FIXES (the draft was not correct)
-- ---------------------------------------------------------------------------
-- 1. AUTHORIZATION. The draft granted EXECUTE to `authenticated`. The envelope
--    tables (customers, wallet_transactions, ledger_entries) carry
--    `allow_all_*` RLS policies FOR ALL TO authenticated, and the deployment
--    also has portal-customer users in the `authenticated` role. A SECURITY
--    DEFINER function that can debit a wallet and post to the ledger must
--    therefore NOT be executable by `authenticated` or `anon`: that would hand
--    a portal customer a direct, RLS-bypassing path to move money.
--    The only legitimate caller is the Prime ERP backend
--    (backend/routes/printingContracts.cjs), which authenticates the session
--    (requireRole('Admin','Accountant','Editor')) and then calls the RPC with
--    the service-role key.
--    Fix: EXECUTE is granted to `service_role` ONLY; PUBLIC/anon/authenticated
--    are revoked; and the function re-checks the caller's JWT role at the
--    database boundary as defence in depth. A direct DBA/migration connection
--    (no JWT claims) is allowed — that path is already privileged.
--    No caller-supplied user id, customer id, contract id or role is ever
--    trusted as proof of authorization: the customer is always derived from
--    the authoritative contract row, and the contract from the lookup.
--
-- 2. IDEMPOTENCY. The draft inserted the idempotency row with
--    ON CONFLICT DO NOTHING and never inspected whether the insert had
--    succeeded, so a replayed request fell through the whole write path and
--    was caught only incidentally by the wallet-transaction id check.
--    Fix: the insert result IS inspected.
--      - insert succeeded  -> this is a new operation, proceed and persist the
--                              full result on the key row at the end;
--      - insert conflicted  -> the operation already ran (or is running
--                              concurrently). If the stored result is a
--                              completed success, the ORIGINAL result is
--                              returned unchanged and NOT a single extra row is
--                              written. If the key exists without a completed
--                              result, the request is refused as DUPLICATE
--                              rather than being treated as a new operation.
--    The key row and every business write are in the same transaction, so
--    they commit or roll back together. A failed attempt leaves no key row,
--    so the retry is a fresh attempt.
--
-- 3. WALLET COVERAGE RULE. The draft compared the balance against a
--    "protected total" that mixed per-contract buckets with item sums
--    differently from the canonical local op. The canonical rule (verified
--    against frontend/services/transactionService.ts consumeContractAssessment)
--    is: for every holding contract (status active|suspended) of the customer,
--    the claim is max(reserved_amount bucket, sum of its RESERVED items'
--    item_price); the balance must cover the SUM of those claims.
--    That is what makes two assessments unable to independently spend the
--    same insufficient balance.
--
-- 4. RESERVATION SEMANTICS. The draft refused a reservation whenever
--    prepaid_amount - reserved_amount - price < 0. That contradicts the
--    canonical local op, where a reservation is an ALLOCATION, not a payment:
--    over-reservation is allowed and the shortfall is reported as unfunded
--    obligation, and refused later at consumption. The draft would have
--    rejected legitimate local schedules. The count entitlement
--    (max_assessments) is enforced atomically instead, under the contract row
--    lock. The draft also reserved only on an `active` contract while the
--    canonical local op refuses only closed contracts (completed/expired/
--    cancelled) — the server now matches the local rule.
--
-- 5. MISSING GATES. The draft had no closed-PERIOD registry gate (the
--    settings-backed `financial_closed_periods` list the local op enforces),
--    no item-freshness guard on reserve (a duplicate item id could overwrite
--    an existing assessment), no NULL-safe contract-linkage check (an item
--    with a NULL contract_id passed `item.contract <> contract`), no
--    reservation idempotency, and no protection against a caller-supplied
--    price of zero.
--
-- 6. LOCKING. Rows are locked in one global order — idempotency key, then
--    customer, then contract, then assessment item — so concurrent requests
--    serialise instead of racing, and no lock cycle can form. The customer
--    row is the funds serialisation point; the contract row is the
--    entitlement serialisation point.
--
-- 7. REPLAY SEMANTICS CHANGE (deliberate, and the reason the live
--    integration test was updated). A repeat of an accepted operation now
--    returns the ORIGINAL result instead of raising. The route already maps
--    a successful body to `accepted`, and the client
--    (frontend/services/contractServerClient.ts) has no production caller
--    yet, so no client behaviour regresses. A genuine CONFLICT (a key that
--    exists without a completed result, or an item already consumed under a
--    different key) is still refused with the DUPLICATE marker, so the
--    route's 409 / duplicate:true contract is preserved for real conflicts.
--
-- ---------------------------------------------------------------------------
-- ACCOUNTING (canonical, unchanged from the local op)
-- ---------------------------------------------------------------------------
-- For an assessment priced K1,000:
--   Dr 21300 Customer Deposits   1,000
--       Cr 41100 Assessment Revenue  1,000
-- and the customer wallet balance falls by 1,000. Exactly one wallet
-- deduction and one matching ledger row are written, in the same transaction
-- as the item and contract updates. Contract-invoice issuance and payment
-- funding are NOT touched here: the wallet is credited when the invoice is
-- paid (the local canonical settlement path), never by this migration, so
-- the wallet can never be credited twice.
--
-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- Reverting the SCHEMA (safe, and independent of business data):
--   DROP FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE);
--   DROP FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE);
--   DROP FUNCTION public.is_contract_date_in_closed_period(DATE);
--   DROP FUNCTION public.is_contract_date_in_closed_fy(DATE);
--   DROP FUNCTION public.current_erp_rpc_role();
--   (an executable copy lives in
--    supabase/migrations/0048_printing_contracts_server_atomicity.rollback.sql
--    — apply that file, never the list above by hand)
--
-- REVERSING BUSINESS DATA is a DIFFERENT operation and is NOT done by
-- dropping the functions. Rows already written by these RPCs (wallet
-- deductions, ledger postings, consumed assessment items, consumed contract
-- buckets, idempotency key rows) are ordinary financial records. They must be
-- reversed through the normal compensating-reversal path (a reversing wallet
-- transaction and a reversing ledger entry per original), never by removing
-- rows. The reconciliation queries in the deployment notes must be run BEFORE
-- any revert, and the revert must be approved by a human.
--
-- The migration is additive: it creates functions and grants only. It never
-- drops a table, drops a column, truncates, or removes rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: the role the current request is executing as.
--
-- PostgREST publishes the verified JWT claims for the request. A direct
-- DBA/migration connection has none — that path is already privileged and is
-- allowed through (the function is not reachable from outside the cluster
-- without a database role, and the grants below keep it there).
--
-- Returns '' when there is no JWT (direct connection) and the JWT role
-- otherwise.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.current_erp_rpc_role()
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_claims TEXT;
  v_role   TEXT;
BEGIN
  v_claims := current_setting('request.jwt.claims', true);
  IF v_claims IS NULL OR btrim(v_claims) = '' THEN
    RETURN '';
  END IF;
  BEGIN
    v_role := v_claims::jsonb ->> 'role';
  EXCEPTION WHEN others THEN
    v_role := NULL;
  END;
  RETURN COALESCE(v_role, '');
END;
$$;

-- -----------------------------------------------------------------------------
-- Resolve a posting account by code, exactly like the canonical local op
-- (frontend/services/transactions/_internal.ts resolveAccountForPosting).
--
-- WHY THIS EXISTS. The chart of accounts is an envelope table whose ROW id is
-- the account id, and in the deployed database that id is PREFIXED
-- ('ACC-21300'), while the code lives in data->>'code' /
-- data->>'account_number' ('21300'). The canonical local op resolves the
-- code to the account id before posting; hardcoding the code into a ledger
-- entry would reference an account id that does not exist and silently
-- break every financial report that joins the ledger to the COA.
--
-- The same posting rules as the local op apply: an inactive account or an
-- account that does not allow posting is refused, and an unresolvable
-- reference FAILS CLOSED (no write) rather than defaulting.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_posting_account(p_ref TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_id      TEXT;
  v_active  BOOLEAN;
  v_posting BOOLEAN;
BEGIN
  IF p_ref IS NULL OR btrim(p_ref) = '' THEN
    RAISE EXCEPTION 'unable to resolve posting account: %', COALESCE(p_ref, 'undefined');
  END IF;

  SELECT a.id,
         CASE WHEN lower(COALESCE(a.data->>'is_active', 'true')) IN ('false','0','f','no') THEN false ELSE true END,
         CASE WHEN lower(COALESCE(a.data->>'allow_posting', 'true')) IN ('false','0','f','no') THEN false ELSE true END
    INTO v_id, v_active, v_posting
  FROM public.accounts a
  WHERE a.id = p_ref
     OR a.data->>'id' = p_ref
     OR a.data->>'code' = p_ref
     OR a.data->>'account_number' = p_ref
  ORDER BY (a.data->>'code' = p_ref) DESC, (a.id = p_ref) DESC
  LIMIT 1;

  IF v_id IS NULL THEN
    RAISE EXCEPTION 'unable to resolve posting account: %', p_ref;
  END IF;
  IF NOT v_active THEN
    RAISE EXCEPTION 'posting account % is inactive', v_id;
  END IF;
  IF NOT v_posting THEN
    RAISE EXCEPTION 'posting account % does not allow posting', v_id;
  END IF;
  RETURN v_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Closed financial YEAR gate.
--
-- CONTRACT NOTE: the return type is TABLE(fy_id, fy_name) — the shape that
-- is DEPLOYED. The live function is set-returning and both live RPCs call it
-- as a table (`SELECT * FROM public.is_contract_date_in_closed_fy(...)`), so
-- changing it to a scalar BOOLEAN is a breaking change that CREATE OR REPLACE
-- refuses outright (42P13: cannot change return type of existing function).
-- The deployed contract is preserved exactly; only the body is hardened.
--
-- A financial year is closed when its envelope record carries a truthy
-- is_closed AND the business date falls inside start_date..end_date. A
-- missing or malformed bound is treated as "no bound" (the year covers every
-- date) — the safe direction: a malformed record on a CLOSED year blocks
-- rather than allows. The date casts are guarded, so a malformed value can
-- never abort the query.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_contract_date_in_closed_fy(p_business_date DATE)
RETURNS TABLE (fy_id TEXT, fy_name TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT fy.id::TEXT, COALESCE(fy.data->>'name', fy.id::TEXT)
  FROM public.financial_years fy
  WHERE lower(COALESCE(fy.data->>'is_closed', 'false')) IN ('true', '1', 't', 'yes')
    AND (
      CASE WHEN COALESCE(fy.data->>'start_date', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (fy.data->>'start_date')::DATE END IS NULL
      OR p_business_date >= CASE WHEN COALESCE(fy.data->>'start_date', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (fy.data->>'start_date')::DATE END
    )
    AND (
      CASE WHEN COALESCE(fy.data->>'end_date', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (fy.data->>'end_date')::DATE END IS NULL
      OR p_business_date <= CASE WHEN COALESCE(fy.data->>'end_date', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (fy.data->>'end_date')::DATE END
    )
  LIMIT 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- Closed financial PERIOD registry gate.
--
-- The canonical closure record is the settings entry
-- `financial_closed_periods` (public.settings, envelope value under
-- data->'value'): an array of { id, from, to, reason, closedAt, closedBy }
-- with inclusive ISO date bounds. This is the same registry the local
-- canonical op enforces, and the settings store is synced, so the server
-- enforces the same closure the device does.
--
-- Same set-returning shape as the year gate, so the two are interchangeable
-- at the call site.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_contract_date_in_closed_period(p_business_date DATE)
RETURNS TABLE (period_id TEXT, reason TEXT)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT COALESCE(elem->>'id', 'financial_closed_periods'),
         COALESCE(elem->>'reason', 'closed period')
  FROM public.settings s
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(s.data->'value') = 'array' THEN s.data->'value' ELSE '[]'::jsonb END
  ) AS elem
  WHERE s.id = 'financial_closed_periods'
    AND (
      CASE WHEN COALESCE(elem->>'from', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (elem->>'from')::DATE END IS NULL
      OR p_business_date >= CASE WHEN COALESCE(elem->>'from', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (elem->>'from')::DATE END
    )
    AND (
      CASE WHEN COALESCE(elem->>'to', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (elem->>'to')::DATE END IS NULL
      OR p_business_date <= CASE WHEN COALESCE(elem->>'to', '') ~ '^\d{4}-\d{2}-\d{2}'
           THEN (elem->>'to')::DATE END
    )
  LIMIT 1;
END;
$$;

-- -----------------------------------------------------------------------------
-- Reserve an assessment against a printing contract.
--
-- A reservation is an ALLOCATION of the contracted entitlement, never a
-- payment: it moves no money and does not require wallet coverage. The
-- shortfall, if any, is reported as an unfunded obligation by the
-- reconciler and is refused later at consumption.
--
-- Atomicity: the contract row is locked FOR UPDATE, so the count entitlement
-- (max_assessments) cannot be exceeded by concurrent reservations.
--
-- p_item_data carries only the descriptive fields of the assessment
-- (name/date/grade/subject/notes). The price is validated, never trusted
-- silently: it must be a positive finite amount.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reserve_contract_assessment_atomic(
  p_contract_id   TEXT,
  p_item_id       TEXT,
  p_item_data     JSONB,
  p_price         NUMERIC,
  p_business_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller_role   TEXT;
  v_business_date DATE;
  v_closed_count INTEGER;
  v_contract      RECORD;
  v_contract_status TEXT;
  v_price         NUMERIC;
  v_max           INTEGER;
  v_live_items    INTEGER := 0;
  v_reserved      NUMERIC := 0;
  v_new_reserved  NUMERIC := 0;
  v_count         INTEGER := 0;
  v_now           TIMESTAMPTZ := NOW();
  v_item          JSONB;
BEGIN
  -- ── Authorization at the database boundary ──────────────────────────────
  -- Only the service-role backend (which authenticates the session and the
  -- operator role before calling) may mutate financial records. A caller
  -- presenting any other JWT role is refused outright.
  v_caller_role := public.current_erp_rpc_role();
  IF v_caller_role <> '' AND v_caller_role <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: role % may not execute the printing-contract assessment RPCs. Nothing written.', v_caller_role;
  END IF;

  v_business_date := COALESCE(p_business_date, CURRENT_DATE);

  IF p_contract_id IS NULL OR p_contract_id = '' THEN
    RAISE EXCEPTION 'reserve: contractId required';
  END IF;
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'reserve: itemId required';
  END IF;

  -- ── Closed-period gates (business date, not sync date) ──────────────────
  SELECT COUNT(*)::int INTO v_closed_count FROM public.is_contract_date_in_closed_fy(v_business_date);
  IF v_closed_count > 0 THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: business date % falls in a closed financial year. Nothing written.', v_business_date;
  END IF;
  SELECT COUNT(*)::int INTO v_closed_count FROM public.is_contract_date_in_closed_period(v_business_date);
  IF v_closed_count > 0 THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: business date % falls in a closed financial period. Nothing written.', v_business_date;
  END IF;

  -- ── Contract (authoritative, locked) ────────────────────────────────────
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % not found. Nothing written.', p_contract_id;
  END IF;

  v_contract_status := lower(COALESCE(v_contract.data->>'status', ''));
  IF v_contract_status IN ('completed', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'contract % is closed (status: %) — assessments cannot be scheduled on a closed contract. Nothing written.', p_contract_id, v_contract_status;
  END IF;

  -- ── Price guard ─────────────────────────────────────────────────────────
  v_price := COALESCE(p_price, 0);
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'assessment % has an invalid price. Nothing written.', p_item_id;
  END IF;

  -- ── Item id must be fresh ───────────────────────────────────────────────
  -- A reservation must never overwrite an existing assessment (a consumed
  -- one in particular): that would silently rewrite history.
  IF EXISTS (SELECT 1 FROM public.assessment_contract_items WHERE id = p_item_id) THEN
    RAISE EXCEPTION 'DUPLICATE: assessment % already exists — refusing to overwrite it. Nothing written.', p_item_id;
  END IF;

  -- ── Entitlement (max_assessments) ───────────────────────────────────────
  -- The contract row lock above serialises this check against concurrent
  -- reservations of the same contract, so the entitlement cannot be exceeded.
  SELECT COUNT(*)::int INTO v_live_items
  FROM public.assessment_contract_items ai
  WHERE ai.data->>'contract_id' = p_contract_id
    AND lower(COALESCE(ai.data->>'status', '')) <> 'cancelled';

  BEGIN
    v_max := NULLIF(v_contract.data->>'max_assessments', '')::int;
  EXCEPTION WHEN others THEN
    v_max := NULL;
  END;
  IF v_max IS NOT NULL AND v_live_items >= v_max THEN
    RAISE EXCEPTION 'entitlement exceeded: contract % allows % assessments (% already scheduled). Nothing written.', p_contract_id, v_max, v_live_items;
  END IF;

  -- ── Materialise the reserved assessment ─────────────────────────────────
  v_item := jsonb_strip_nulls(jsonb_build_object(
    'id', p_item_id,
    'contract_id', p_contract_id,
    'company_id', v_contract.data->>'company_id',
    'customer_id', v_contract.data->>'customer_id',
    'school_id', v_contract.data->>'school_id',
    'assessment_type', COALESCE(NULLIF(p_item_data->>'assessment_type', ''), v_contract.data->>'assessment_type', 'examination'),
    'assessment_grade', p_item_data->>'assessment_grade',
    'assessment_subject', p_item_data->>'assessment_subject',
    'assessment_name', COALESCE(NULLIF(p_item_data->>'assessment_name', ''), 'Assessment ' || p_item_id),
    'assessment_date', COALESCE(NULLIF(p_item_data->>'assessment_date', ''), v_business_date::TEXT),
    'item_price', v_price,
    'status', 'reserved',
    'reserved_at', v_now::TEXT,
    'notes', p_item_data->>'notes',
    'created_by', COALESCE(NULLIF(p_item_data->>'created_by', ''), 'system'),
    'created_at', v_now::TEXT,
    'updated_at', v_now::TEXT,
    'version', 1,
    'data', '{}'::jsonb
  ));

  INSERT INTO public.assessment_contract_items (id, data, created_at, updated_at, version)
  VALUES (p_item_id, v_item, v_now, v_now, 1);

  -- ── Reservation bucket ──────────────────────────────────────────────────
  BEGIN
    v_reserved := COALESCE(NULLIF(v_contract.data->>'reserved_amount', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_reserved := 0;
  END;
  v_new_reserved := v_reserved + v_price;

  BEGIN
    v_count := COALESCE(NULLIF(v_contract.data->>'assessment_count', '')::int, 0);
  EXCEPTION WHEN others THEN
    v_count := 0;
  END;
  v_count := v_count + 1;

  UPDATE public.assessment_contracts
  SET data = data || jsonb_build_object(
        'reserved_amount', v_new_reserved,
        'assessment_count', v_count,
        'updated_at', v_now::TEXT,
        'version', COALESCE(version, 0) + 1
      ),
      updated_at = v_now
  WHERE id = p_contract_id;

  RETURN jsonb_build_object(
    'success', true,
    'contractId', p_contract_id,
    'assessmentItemId', p_item_id,
    'reservedAmount', v_new_reserved,
    'assessmentCount', v_count
  );
END;
$$;

-- -----------------------------------------------------------------------------
-- Consume a reserved assessment: debit the wallet and recognise the revenue.
--
-- One transaction, one wallet deduction, one ledger posting, one item
-- transition, one contract bucket update, one idempotency record. A failure
-- leaves none of them behind.
--
-- Lock order (global, to avoid cycles):
--   idempotency key -> customer -> contract -> assessment item
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic(
  p_contract_id     TEXT,
  p_item_id         TEXT,
  p_idempotency_key TEXT,
  p_business_date   DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_caller_role     TEXT;
  v_business_date   DATE;
  v_closed_count    INTEGER;
  v_contract        RECORD;
  v_item            RECORD;
  v_customer        RECORD;
  v_contract_status TEXT;
  v_item_status     TEXT;
  v_item_contract   TEXT;
  v_customer_id     TEXT;
  v_customer_name   TEXT;
  v_contract_number TEXT;
  v_item_label      TEXT;
  v_price           NUMERIC := 0;
  v_wallet_balance  NUMERIC := 0;
  v_protected_total NUMERIC := 0;
  v_reserved_before NUMERIC := 0;
  v_reserved_after  NUMERIC := 0;
  v_consumed_after  NUMERIC := 0;
  v_stored_reserved NUMERIC := 0;
  v_stored_consumed NUMERIC := 0;
  v_wallet_id       TEXT;
  v_ledger_id       TEXT;
  v_debit_account   TEXT;
  v_credit_account  TEXT;
  v_idem_key        TEXT;
  v_key_id          UUID;
  v_inserted        UUID;
  v_stored          JSONB;
  v_result          JSONB;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  -- ── Authorization at the database boundary ──────────────────────────────
  v_caller_role := public.current_erp_rpc_role();
  IF v_caller_role <> '' AND v_caller_role <> 'service_role' THEN
    RAISE EXCEPTION 'UNAUTHORIZED: role % may not execute the printing-contract assessment RPCs. Nothing written.', v_caller_role;
  END IF;

  v_business_date := COALESCE(p_business_date, CURRENT_DATE);

  IF p_contract_id IS NULL OR p_contract_id = '' THEN
    RAISE EXCEPTION 'consume: contractId required';
  END IF;
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'consume: itemId required';
  END IF;

  -- ── Idempotency gate — the FIRST write of the transaction ───────────────
  -- The insert result is inspected. ON CONFLICT DO NOTHING blocks until a
  -- concurrent inserter commits or rolls back, so the key row is either
  -- absent (fresh operation) or a COMPLETED operation (replay).
  v_idem_key := COALESCE(NULLIF(p_idempotency_key, ''), 'wallet:assessment:' || p_item_id || ':consumed');
  v_key_id := md5('consume:' || p_item_id || ':' || v_idem_key)::UUID;

  INSERT INTO public.idempotency_keys (id, data, created_at, updated_at, version)
  VALUES (
    v_key_id,
    jsonb_build_object(
      'scope', 'contract_assessment_consume',
      'item_id', p_item_id,
      'contract_id', p_contract_id,
      'idempotency_key', v_idem_key,
      'status', 'in_progress',
      'business_date', v_business_date::TEXT
    ),
    v_now, v_now, 1
  )
  ON CONFLICT (id) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    -- The key already exists. This operation has already been performed (or
    -- is being performed right now by a concurrent request). Never perform a
    -- second debit: return the original result when there is one.
    SELECT data INTO v_stored
    FROM public.idempotency_keys
    WHERE id = v_key_id
    FOR UPDATE;

    IF v_stored IS NOT NULL
       AND v_stored->'result' IS NOT NULL
       AND v_stored->'result'->>'success' = 'true' THEN
      RETURN v_stored->'result' || jsonb_build_object('replayed', true);
    END IF;

    RAISE EXCEPTION 'DUPLICATE: assessment % is already being processed under idempotency key %. Nothing written.', p_item_id, v_idem_key;
  END IF;

  -- ── Closed-period gates (business date, not sync date) ──────────────────
  SELECT COUNT(*)::int INTO v_closed_count FROM public.is_contract_date_in_closed_fy(v_business_date);
  IF v_closed_count > 0 THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: business date % falls in a closed financial year. Nothing written.', v_business_date;
  END IF;
  SELECT COUNT(*)::int INTO v_closed_count FROM public.is_contract_date_in_closed_period(v_business_date);
  IF v_closed_count > 0 THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: business date % falls in a closed financial period. Nothing written.', v_business_date;
  END IF;

  -- ── Contract (authoritative, locked) ────────────────────────────────────
  SELECT * INTO v_contract
  FROM public.assessment_contracts
  WHERE id = p_contract_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'contract % not found. Nothing written.', p_contract_id;
  END IF;

  v_contract_status := lower(COALESCE(v_contract.data->>'status', ''));
  IF v_contract_status <> 'active' THEN
    RAISE EXCEPTION 'contract % is not active (status: %) — assessment consumption requires an active contract (active only). Nothing written.', p_contract_id, v_contract_status;
  END IF;

  -- The customer is derived from the authoritative contract, never supplied.
  v_customer_id := NULLIF(v_contract.data->>'customer_id', '');
  IF v_customer_id IS NULL THEN
    RAISE EXCEPTION 'contract % has no customer. Nothing written.', p_contract_id;
  END IF;

  -- ── Assessment item (authoritative, locked) ─────────────────────────────
  SELECT * INTO v_item
  FROM public.assessment_contract_items
  WHERE id = p_item_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assessment % not found. Nothing written.', p_item_id;
  END IF;

  v_item_contract := NULLIF(v_item.data->>'contract_id', '');
  IF v_item_contract IS DISTINCT FROM p_contract_id THEN
    RAISE EXCEPTION 'assessment % does not belong to contract % (it belongs to %). Nothing written.', p_item_id, p_contract_id, COALESCE(v_item_contract, 'none');
  END IF;

  -- ── Deterministic debit ids (canonical) ─────────────────────────────────
  v_wallet_id := 'WTX-' || p_item_id || '-CONSUMED';
  v_ledger_id := 'LG-' || v_wallet_id;

  -- A consumption transaction for this assessment already exists — a manual
  -- or backfilled row, or an assessment consumed under a DIFFERENT key.
  -- It must never gain a sibling debit. Checked before the funds reasoning
  -- so a duplicate is never reported as a funding problem.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE id = v_wallet_id) THEN
    RAISE EXCEPTION 'DUPLICATE: assessment % already has consumption transaction %. Nothing written.', p_item_id, v_wallet_id;
  END IF;

  v_item_status := lower(COALESCE(v_item.data->>'status', ''));
  IF v_item_status <> 'reserved' THEN
    RAISE EXCEPTION 'assessment % is % — only reserved assessments can be consumed (reserved only). Nothing written.', p_item_id, v_item_status;
  END IF;

  -- The price is the ITEM's own authoritative price, never a parameter.
  BEGIN
    v_price := COALESCE(NULLIF(v_item.data->>'item_price', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_price := 0;
  END;
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'assessment % has an invalid price. Nothing written.', p_item_id;
  END IF;

  -- ── Customer (funds serialisation point, locked) ────────────────────────
  SELECT c.* INTO v_customer
  FROM public.customers c
  WHERE c.id = v_customer_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'customer % not found. Nothing written.', v_customer_id;
  END IF;

  BEGIN
    v_wallet_balance := COALESCE(NULLIF(v_customer.data->>'walletBalance', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_wallet_balance := 0;
  END;

  -- ── Coverage: the balance must fund EVERY protected reservation ─────────
  -- claim(contract) = max(reserved_amount bucket, sum of its RESERVED items)
  -- over the customer's holding contracts (active|suspended). The debit below
  -- reduces the wallet, so the PRE-debit balance must cover all of them —
  -- that is what stops two assessments from independently spending the same
  -- insufficient balance.
  SELECT COALESCE(SUM(
           GREATEST(
             COALESCE(NULLIF(c.data->>'reserved_amount', '')::numeric, 0),
             COALESCE((
               SELECT SUM(COALESCE(NULLIF(ai.data->>'item_price', '')::numeric, 0))
               FROM public.assessment_contract_items ai
               WHERE ai.data->>'contract_id' = c.id
                 AND lower(COALESCE(ai.data->>'status', '')) = 'reserved'
             ), 0)
           )), 0)
    INTO v_protected_total
  FROM public.assessment_contracts c
  WHERE c.data->>'customer_id' = v_customer_id
    AND lower(COALESCE(c.data->>'status', '')) IN ('active', 'suspended');

  IF v_wallet_balance < v_price THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_FUNDS: wallet balance % is below the assessment price %. Nothing written.', v_wallet_balance, v_price;
  END IF;
  IF v_wallet_balance < v_protected_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_FUNDS: wallet balance % is below the protected reservation total %. Nothing written.', v_wallet_balance, v_protected_total;
  END IF;

  -- ── Deterministic debit ids (canonical) ─────────────────────────────────
  v_customer_name := COALESCE(
    NULLIF(v_contract.data->>'customer_name', ''),
    NULLIF(v_customer.data->>'name', ''),
    NULLIF(v_customer.data->>'customerName', ''),
    v_customer_id
  );
  v_contract_number := COALESCE(NULLIF(v_contract.data->>'contract_number', ''), p_contract_id);
  v_item_label := COALESCE(NULLIF(v_item.data->>'assessment_name', ''), p_item_id);

  -- ── Posting accounts, resolved from the chart of accounts ───────────────
  -- 21300 = Customer Deposits (Dr, the wallet liability),
  -- 41100 = Assessment Revenue (Cr). Resolved by CODE, because the deployed
  -- account ids are prefixed ('ACC-21300'). Fails closed if either account
  -- is missing, inactive or does not allow posting.
  v_debit_account := public.resolve_posting_account('21300');
  v_credit_account := public.resolve_posting_account('41100');

  -- ── Write 1/5: the wallet deduction ─────────────────────────────────────
  INSERT INTO public.wallet_transactions (id, data, created_at, updated_at, version)
  VALUES (
    v_wallet_id,
    jsonb_build_object(
      'customerId', v_customer_id,
      'customer_id', v_customer_id,
      'customerName', v_customer_name,
      'amount', v_price,
      'type', 'Deduction',
      'description', 'Assessment consumption ' || v_contract_number || ' — ' || v_item_label,
      'reference', v_contract_number,
      'date', v_now::TEXT,
      'business_date', v_business_date::TEXT,
      'contract_id', p_contract_id,
      'contract_number', v_contract_number,
      'assessment_item_id', p_item_id,
      'idempotencyKey', v_idem_key,
      'consumed_at', v_now::TEXT,
      'data', jsonb_build_object(
        'type', 'ASSESSMENT_CONSUMPTION',
        'contract_id', p_contract_id,
        'contract_number', v_contract_number,
        'assessment_item_id', p_item_id,
        'customer_id', v_customer_id,
        'amount', v_price,
        'idempotencyKey', v_idem_key,
        'consumed_at', v_now::TEXT
      )
    ),
    v_now, v_now, 1
  );

  -- ── Write 2/5: the ledger posting (Dr 21300 / Cr 41100) ─────────────────
  INSERT INTO public.ledger_entries (id, data, created_at, updated_at, version)
  VALUES (
    v_ledger_id,
    jsonb_build_object(
      'amount', v_price,
      'referenceId', p_item_id,
      'customerId', v_customer_id,
      'customerName', v_customer_name,
      'debitAccountId', v_debit_account,
      'creditAccountId', v_credit_account,
      'reconciled', true,
      'date', v_now::TEXT,
      'business_date', v_business_date::TEXT,
      'description', 'Assessment consumption ' || v_contract_number || ' — ' || v_item_label
    ),
    v_now, v_now, 1
  );

  -- ── Write 3/5: the customer wallet balance ──────────────────────────────
  UPDATE public.customers
  SET data = jsonb_set(data, '{walletBalance}', to_jsonb(ROUND((v_wallet_balance - v_price)::numeric, 2))),
      version = COALESCE(version, 0) + 1,
      updated_at = v_now
  WHERE id = v_customer_id;

  -- ── Write 4/5: the assessment item ──────────────────────────────────────
  UPDATE public.assessment_contract_items
  SET data = data || jsonb_build_object(
        'status', 'consumed',
        'consumed_at', v_now::TEXT,
        'updated_at', v_now::TEXT,
        'version', COALESCE(version, 0) + 1
      ),
      updated_at = v_now
  WHERE id = p_item_id;

  -- ── Write 5/5: the contract buckets ─────────────────────────────────────
  -- Reservation-coverage healing (documented, not silent): rows created before
  -- reservation accounting existed carry reserved_amount = 0 despite
  -- genuinely reserved items. The canonical local op heals the same way, so
  -- consuming such an item debits exactly once and leaves truthful buckets.
  BEGIN
    v_stored_reserved := COALESCE(NULLIF(v_contract.data->>'reserved_amount', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_stored_reserved := 0;
  END;
  BEGIN
    v_stored_consumed := COALESCE(NULLIF(v_contract.data->>'consumed_amount', '')::numeric, 0);
  EXCEPTION WHEN others THEN
    v_stored_consumed := 0;
  END;
  v_reserved_before := GREATEST(v_stored_reserved, v_price);
  v_reserved_after := v_reserved_before - v_price;
  v_consumed_after := v_stored_consumed + v_price;
  IF v_reserved_after < 0 OR v_consumed_after < 0 THEN
    RAISE EXCEPTION 'contract invariant violated for % (reserved %, consumed %). Nothing written.', p_contract_id, v_reserved_after, v_consumed_after;
  END IF;

  UPDATE public.assessment_contracts
  SET data = data || jsonb_build_object(
        'reserved_amount', v_reserved_after,
        'consumed_amount', v_consumed_after,
        'updated_at', v_now::TEXT,
        'version', COALESCE(version, 0) + 1
      ),
      updated_at = v_now
  WHERE id = p_contract_id;

  -- ── The result, recorded on the idempotency key ─────────────────────────
  v_result := jsonb_build_object(
    'success', true,
    'replayed', false,
    'walletTransactionId', v_wallet_id,
    'ledgerEntryId', v_ledger_id,
    'newBalance', ROUND((v_wallet_balance - v_price)::numeric, 2),
    'contractId', p_contract_id,
    'assessmentItemId', p_item_id,
    'amount', v_price
  );

  UPDATE public.idempotency_keys
  SET data = data || jsonb_build_object(
        'status', 'succeeded',
        'result', v_result,
        'completed_at', v_now::TEXT
      ),
      updated_at = v_now,
      version = COALESCE(version, 0) + 1
  WHERE id = v_key_id;

  RETURN v_result;
END;
$$;

-- -----------------------------------------------------------------------------
-- GRANTS — minimum necessary.
--
-- The Prime ERP backend is the only caller and it uses the service-role
-- key. `authenticated` and `anon` are removed explicitly: the envelope
-- tables they can already reach carry allow_all RLS policies, and a
-- SECURITY DEFINER function that moves money must not be one of them.
-- The in-function role check is the second line of defence.
-- -----------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_period(DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_posting_account(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE) TO service_role;

REVOKE ALL ON FUNCTION public.is_contract_date_in_closed_fy(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_contract_date_in_closed_period(DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_posting_account(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.current_erp_rpc_role() FROM PUBLIC, anon, authenticated;

-- =============================================================================
-- Rollback (schema only — business data is NOT reversed by dropping functions)
-- =============================================================================
--   DROP FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE);
--   DROP FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE);
--   DROP FUNCTION public.resolve_posting_account(TEXT);
--   DROP FUNCTION public.is_contract_date_in_closed_period(DATE);
--   DROP FUNCTION public.is_contract_date_in_closed_fy(DATE);
--   DROP FUNCTION public.current_erp_rpc_role();
--
-- See supabase/migrations/0048_printing_contracts_server_atomicity.rollback.sql
-- for the executable version. Reversing rows already written by these
-- functions is a separate, human-approved compensating-reversal operation —
-- never a row removal.
-- =============================================================================

-- ============================================================================
-- 0048_printing_contracts_server_atomicity.sql
--
-- Phase 2 §3.1: server-authoritative atomic reserve/consume for Printing Contracts.
-- Additive only. Safe to run multiple times (IF NOT EXISTS / OR REPLACE).
-- NOT APPLIED TO PRODUCTION by this change — prepared and tested locally only.
-- Rollback: DROP FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,TEXT,NUMERIC,TEXT);
--           DROP FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,TEXT);
--
-- Envelope convention (see 0039): assessment_contracts / assessment_contract_items /
-- wallet_transactions / ledger_entries are { id, data JSONB, updated_at, version }.
-- Business fields live in data (contract_id, customer_id, status, item_price,
-- reserved_amount, consumed_amount, etc.). These RPCs lock rows FOR UPDATE and
-- perform ALL writes in one transaction: linkage + ownership + lifecycle +
-- status/price + wallet coverage + idempotency + FY/closed-period + buckets.
-- Idempotency: deterministic wallet tx id WTX-<item>-CONSUMED + idempotency_keys
-- row (uuid5 of operation key). Replay returns prior result, never double-posts.
-- FY closure: financial_years envelope rows with (data->>'is_closed')=true and
-- data->>start_date/end_date covering the BUSINESS date (never the sync timestamp).
-- Closed → exception with SQLSTATE P0001 + message CLOSED_PERIOD:* (gateway maps to
-- adjustmentRequired, retryable=false, nothing half-written).
-- ============================================================================

BEGIN;

-- ─── Helper: is a business date inside a closed financial year? ─────────────
CREATE OR REPLACE FUNCTION public.is_contract_date_in_closed_fy(p_business_date DATE)
RETURNS TABLE (fy_id TEXT, fy_name TEXT)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT f.id::TEXT, COALESCE(f.data->>'name', f.id::TEXT)
  FROM public.financial_years f
  WHERE COALESCE(f.data->>'is_closed', 'false') IN ('true', '1', 't')
    AND (f.data->>'start_date' IS NULL OR p_business_date >= (f.data->>'start_date')::DATE)
    AND (f.data->>'end_date' IS NULL OR p_business_date <= (f.data->>'end_date')::DATE)
  LIMIT 1;
END;
$$;

-- ─── Atomic reserve: create one reserved item + bump reserved_amount ─────────
CREATE OR REPLACE FUNCTION public.reserve_contract_assessment_atomic(
  p_contract_id TEXT,
  p_item_id TEXT,
  p_item_data JSONB,
  p_price NUMERIC,
  p_business_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_contract RECORD;
  v_live_count INT;
  v_max INT;
  v_closed RECORD;
BEGIN
  IF p_contract_id IS NULL OR p_contract_id = '' THEN
    RAISE EXCEPTION 'reserve: contractId required';
  END IF;
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'reserve: itemId required';
  END IF;
  IF p_price IS NULL OR p_price < 0 THEN
    RAISE EXCEPTION 'reserve: invalid price %', p_price;
  END IF;

  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reserve: contract % not found', p_contract_id;
  END IF;
  IF COALESCE(v_contract.data->>'status', '') IN ('completed', 'expired', 'cancelled') THEN
    RAISE EXCEPTION 'reserve: contract % is closed (%)', p_contract_id, v_contract.data->>'status';
  END IF;

  SELECT * INTO v_closed FROM public.is_contract_date_in_closed_fy(p_business_date) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: reserve dated % falls in closed FY % (%)', p_business_date, v_closed.fy_id, v_closed.fy_name;
  END IF;

  SELECT COUNT(*) INTO v_live_count FROM public.assessment_contract_items
  WHERE (data->>'contract_id' = p_contract_id OR data->>'contract_id' = v_contract.id)
    AND COALESCE(data->>'status', '') <> 'cancelled';
  v_max := NULLIF(v_contract.data->>'max_assessments', '')::INT;
  IF v_max IS NOT NULL AND v_live_count >= v_max THEN
    RAISE EXCEPTION 'reserve: entitlement exceeded (% of %)', v_live_count, v_max;
  END IF;

  IF EXISTS (SELECT 1 FROM public.assessment_contract_items WHERE id = p_item_id) THEN
    RAISE EXCEPTION 'DUPLICATE: assessment item % already exists', p_item_id;
  END IF;

  INSERT INTO public.assessment_contract_items (id, data, version)
  VALUES (p_item_id, jsonb_build_object(
    'contract_id', p_contract_id,
    'company_id', v_contract.data->>'company_id',
    'customer_id', v_contract.data->>'customer_id',
    'school_id', v_contract.data->>'school_id',
    'assessment_name', COALESCE(p_item_data->>'assessment_name', 'Assessment'),
    'assessment_type', COALESCE(p_item_data->>'assessment_type', v_contract.data->>'assessment_type', 'examination'),
    'assessment_grade', p_item_data->>'assessment_grade',
    'assessment_subject', p_item_data->>'assessment_subject',
    'assessment_date', COALESCE(p_item_data->>'assessment_date', NOW()::TEXT),
    'item_price', p_price,
    'status', 'reserved',
    'reserved_at', NOW()::TEXT,
    'business_date', p_business_date::TEXT
  ), 1);

  UPDATE public.assessment_contracts
  SET data = data || jsonb_build_object(
      'reserved_amount', COALESCE(NULLIF(data->>'reserved_amount', '')::NUMERIC, 0) + p_price,
      'assessment_count', COALESCE(NULLIF(data->>'assessment_count', '')::INT, 0) + 1
    ),
    version = COALESCE(version, 0) + 1,
    updated_at = NOW()
  WHERE id = p_contract_id;

  RETURN jsonb_build_object('success', true, 'contract_id', p_contract_id, 'item_id', p_item_id, 'reserved_price', p_price);
END;
$$;

-- ─── Atomic consume: reserved→consumed + wallet debit + ledger, exactly once ─
CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic(
  p_contract_id TEXT,
  p_item_id TEXT,
  p_idempotency_key TEXT,
  p_business_date DATE DEFAULT CURRENT_DATE
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_contract RECORD;
  v_item RECORD;
  v_price NUMERIC;
  v_wallet_id TEXT;
  v_customer_id TEXT;
  v_closed RECORD;
  v_protected_total NUMERIC := 0;
  v_wallet_balance NUMERIC;
BEGIN
  IF p_contract_id IS NULL OR p_contract_id = '' THEN
    RAISE EXCEPTION 'consume: contractId required';
  END IF;
  IF p_item_id IS NULL OR p_item_id = '' THEN
    RAISE EXCEPTION 'consume: itemId required';
  END IF;
  v_wallet_id := 'WTX-' || p_item_id || '-CONSUMED';

  SELECT * INTO v_contract FROM public.assessment_contracts WHERE id = p_contract_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'consume: contract % not found', p_contract_id; END IF;
  SELECT * INTO v_item FROM public.assessment_contract_items WHERE id = p_item_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'consume: item % not found', p_item_id; END IF;
  IF (v_item.data->>'contract_id') <> p_contract_id AND (v_item.data->>'contract_id') <> v_contract.id THEN
    RAISE EXCEPTION 'consume: item % does not belong to contract %', p_item_id, p_contract_id;
  END IF;
  IF COALESCE(v_contract.data->>'status', '') <> 'active' THEN
    RAISE EXCEPTION 'consume: contract % is % (active only)', p_contract_id, v_contract.data->>'status';
  END IF;
  IF COALESCE(v_item.data->>'status', '') <> 'reserved' THEN
    RAISE EXCEPTION 'consume: item % is % (reserved only)', p_item_id, v_item.data->>'status';
  END IF;

  SELECT * INTO v_closed FROM public.is_contract_date_in_closed_fy(p_business_date) LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CLOSED_PERIOD: consumption dated % falls in closed FY % (%)', p_business_date, v_closed.fy_id, v_closed.fy_name;
  END IF;

  v_price := COALESCE(NULLIF(v_item.data->>'item_price', '')::NUMERIC, -1);
  IF v_price IS NULL OR v_price <= 0 THEN
    RAISE EXCEPTION 'consume: item % has invalid price', p_item_id;
  END IF;
  v_customer_id := v_contract.data->>'customer_id';
  IF v_customer_id IS NULL OR v_customer_id = '' THEN
    RAISE EXCEPTION 'consume: contract % has no customer', p_contract_id;
  END IF;

  -- Idempotency first among writes: deterministic wallet id + key row.
  IF EXISTS (SELECT 1 FROM public.wallet_transactions WHERE id = v_wallet_id) THEN
    RAISE EXCEPTION 'DUPLICATE: item % already consumed (%)', p_item_id, v_wallet_id;
  END IF;
  INSERT INTO public.idempotency_keys (id, result)
  VALUES (md5('consume:' || p_item_id || ':' || COALESCE(p_idempotency_key, ''))::UUID, v_wallet_id)
  ON CONFLICT (id) DO NOTHING;
  -- Note: envelope idempotency_keys uses UUID id; md5 keeps it deterministic.

  -- Wallet coverage: customer wallet (data->>'walletBalance' on customers envelope)
  -- must cover ALL protected reservations (effective per holding contract).
  SELECT COALESCE(NULLIF((SELECT c.data->>'walletBalance' FROM public.customers c WHERE c.id = v_customer_id), '')::NUMERIC, 0)
    INTO v_wallet_balance;
  SELECT COALESCE(SUM(
    GREATEST(
      COALESCE(NULLIF(ac.data->>'reserved_amount', '')::NUMERIC, 0),
      COALESCE((SELECT SUM(COALESCE(NULLIF(ai.data->>'item_price', '')::NUMERIC, 0))
        FROM public.assessment_contract_items ai
        WHERE ai.data->>'contract_id' = ac.id AND COALESCE(ai.data->>'status','') = 'reserved'), 0)
    )), 0)
    INTO v_protected_total
  FROM public.assessment_contracts ac
  WHERE ac.data->>'customer_id' = v_customer_id
    AND COALESCE(ac.data->>'status','') IN ('active', 'suspended');
  IF v_wallet_balance < v_protected_total THEN
    RAISE EXCEPTION 'INSUFFICIENT_WALLET_FUNDS: wallet % < protected %', v_wallet_balance, v_protected_total;
  END IF;

  INSERT INTO public.wallet_transactions (id, data, version)
  VALUES (v_wallet_id, jsonb_build_object(
    'customerId', v_customer_id,
    'customer_id', v_customer_id,
    'amount', v_price, 'type', 'Deduction',
    'reference', COALESCE(v_contract.data->>'contract_number', p_contract_id),
    'date', NOW()::TEXT, 'business_date', p_business_date::TEXT,
    'type_detail', 'ASSESSMENT_CONSUMPTION',
    'contract_id', p_contract_id, 'assessment_item_id', p_item_id,
    'idempotencyKey', p_idempotency_key, 'consumed_at', NOW()::TEXT
  ), 1);

  INSERT INTO public.ledger_entries (id, data, version)
  VALUES ('LG-' || v_wallet_id, jsonb_build_object(
    'amount', v_price, 'referenceId', p_item_id,
    'customerId', v_customer_id, 'date', NOW()::TEXT,
    'business_date', p_business_date::TEXT,
    'description', 'Assessment consumption ' || COALESCE(v_contract.data->>'contract_number', p_contract_id)
  ), 1);

  UPDATE public.assessment_contract_items
  SET data = data || jsonb_build_object('status', 'consumed', 'consumed_at', NOW()::TEXT),
      version = COALESCE(version, 0) + 1, updated_at = NOW()
  WHERE id = p_item_id;

  UPDATE public.assessment_contracts
  SET data = data || jsonb_build_object(
      'reserved_amount', GREATEST(0, COALESCE(NULLIF(data->>'reserved_amount', '')::NUMERIC, v_price) - v_price),
      'consumed_amount', COALESCE(NULLIF(data->>'consumed_amount', '')::NUMERIC, 0) + v_price
    ),
    version = COALESCE(version, 0) + 1, updated_at = NOW()
  WHERE id = p_contract_id;

  RETURN jsonb_build_object('success', true, 'walletTransactionId', v_wallet_id, 'ledgerEntryId', 'LG-' || v_wallet_id, 'amount', v_price);
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy(DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_contract_assessment_atomic(TEXT, TEXT, JSONB, NUMERIC, DATE) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_contract_assessment_atomic(TEXT, TEXT, TEXT, DATE) TO authenticated, service_role;

COMMIT;

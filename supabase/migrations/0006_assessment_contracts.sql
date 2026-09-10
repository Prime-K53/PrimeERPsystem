-- ============================================================================
-- 0006_assessment_contracts.sql
--
-- Prime ERP Phase 1: Assessment Contract Management
-- Prepaid assessment contracts for schools with wallet-based reservations and consumption
--
-- Required tables: assessment_contracts, assessment_contract_items, contract_amendments
-- Required wallet transaction types: CONTRACT_DEPOSIT, ASSESSMENT_RESERVATION, ASSESSMENT_RELEASE, ASSESSMENT_CONSUMPTION, CONTRACT_REFUND, CONTRACT_ADJUSTMENT
--
-- Money uses decimal/integer-safe storage (NUMERIC(15,2))
-- Contract lifecycle: Draft → Pending Payment → Active → Suspended → Completed → Expired → Cancelled
-- Payment activation sequence: Payment → Payment Verification → Wallet Credit → Contract Activation
-- ============================================================================

-- ─── Assessment Contracts Table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_contracts (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    contract_number TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    -- Financial amounts (using NUMERIC(15,2) for precision)
    prepaid_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    consumed_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    reserved_amount NUMERIC(15,2) NOT NULL DEFAULT 0,
    available_funds NUMERIC(15,2) GENERATED ALWAYS AS (
        prepaid_amount - consumed_amount - reserved_amount
    ) STORED,
    -- Contract lifecycle
    starts_at TIMESTAMPTZ,
    ends_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ,
    activated_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    suspended_at TIMESTAMPTZ,
    -- Assessment configuration
    assessment_type TEXT NOT NULL,
    assessment_grade TEXT,
    assessment_subject TEXT,
    assessment_count INTEGER NOT NULL DEFAULT 0,
    max_assessments INTEGER NOT NULL DEFAULT 0,
    assessment_price NUMERIC(15,2) NOT NULL DEFAULT 0,
    -- Payment and verification
    payment_id TEXT,
    payment_status TEXT DEFAULT 'pending',
    payment_verified_at TIMESTAMPTZ,
    wallet_credit_applied_at TIMESTAMPTZ,
    -- Metadata
    notes TEXT,
    terms TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Constraints
    CONSTRAINT chk_assessment_contracts_positive_amounts CHECK (
        prepaid_amount >= 0 AND consumed_amount >= 0 AND reserved_amount >= 0
    ),
    CONSTRAINT chk_assessment_contracts_funds_match CHECK (
        available_funds = prepaid_amount - consumed_amount - reserved_amount
    ),
    CONSTRAINT chk_assessment_contracts_status CHECK (
        status IN ('draft', 'pending_payment', 'active', 'suspended', 'completed', 'expired', 'cancelled')
    ),
    CONSTRAINT chk_assessment_contracts_payment_status CHECK (
        payment_status IN ('pending', 'verified', 'failed', 'refunded')
    )
);

-- ─── Assessment Contract Items Table ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.assessment_contract_items (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    school_id TEXT NOT NULL,
    
    -- Assessment item details
    assessment_type TEXT NOT NULL,
    assessment_grade TEXT,
    assessment_subject TEXT,
    assessment_name TEXT NOT NULL,
    assessment_date TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'reserved',
    
    -- Financial tracking
    item_price NUMERIC(15,2) NOT NULL,
    consumed_at TIMESTAMPTZ,
    reserved_at TIMESTAMPTZ,
    released_at TIMESTAMPTZ,
    
    -- Metadata
    notes TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Constraints
    CONSTRAINT chk_assessment_items_status CHECK (
        status IN ('reserved', 'consumed', 'released', 'cancelled')
    ),
    CONSTRAINT chk_assessment_items_positive_price CHECK (
        item_price > 0
    )
);

-- ─── Contract Amendments Table ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contract_amendments (
    id TEXT PRIMARY KEY,
    contract_id TEXT NOT NULL,
    company_id TEXT NOT NULL,
    customer_id TEXT NOT NULL,
    
    -- Amendment details
    amendment_type TEXT NOT NULL,
    description TEXT NOT NULL,
    change_amount NUMERIC(15,2),
    new_terms TEXT,
    
    -- Approval tracking
    requested_by TEXT,
    approved_by TEXT,
    approved_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    
    -- Financial impact
    prepaid_amount_adjustment NUMERIC(15,2) DEFAULT 0,
    assessment_count_adjustment INTEGER DEFAULT 0,
    assessment_price_adjustment NUMERIC(15,2) DEFAULT 0,
    
    -- Metadata
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    version INTEGER NOT NULL DEFAULT 0,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    
    -- Constraints
    CONSTRAINT chk_contract_amendments_status CHECK (
        status IN ('pending', 'approved', 'rejected', 'cancelled')
    )
);

-- ─── Indexes ─────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_company ON public.assessment_contracts (company_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_customer ON public.assessment_contracts (customer_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_school ON public.assessment_contracts (school_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_status ON public.assessment_contracts (status);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_dates ON public.assessment_contracts (starts_at, ends_at, expires_at);
CREATE INDEX IF NOT EXISTS idx_assessment_contracts_payment ON public.assessment_contracts (payment_status, payment_verified_at);

CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_contract ON public.assessment_contract_items (contract_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_company ON public.assessment_contract_items (company_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_customer ON public.assessment_contract_items (customer_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_school ON public.assessment_contract_items (school_id);
CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_status ON public.assessment_contract_items (status);
CREATE INDEX IF NOT EXISTS idx_assessment_contract_items_date ON public.assessment_contract_items (assessment_date);

CREATE INDEX IF NOT EXISTS idx_contract_amendments_contract ON public.contract_amendments (contract_id);
CREATE INDEX IF NOT EXISTS idx_contract_amendments_company ON public.contract_amendments (company_id);
CREATE INDEX IF NOT EXISTS idx_contract_amendments_status ON public.contract_amendments (status);
CREATE INDEX IF NOT EXISTS idx_contract_amendments_dates ON public.contract_amendments (approved_at);

-- ─── Updated_at Trigger ─────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_update_updated_at_assessment_contracts ON public.assessment_contracts;
CREATE TRIGGER trg_update_updated_at_assessment_contracts 
    BEFORE UPDATE ON public.assessment_contracts 
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_update_updated_at_assessment_contract_items ON public.assessment_contract_items;
CREATE TRIGGER trg_update_updated_at_assessment_contract_items 
    BEFORE UPDATE ON public.assessment_contract_items 
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

DROP TRIGGER IF EXISTS trg_update_updated_at_contract_amendments ON public.contract_amendments;
CREATE TRIGGER trg_update_updated_at_contract_amendments 
    BEFORE UPDATE ON public.contract_amendments 
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ─── RLS Policies ─────────────────────────────────────────────────────────────
ALTER TABLE public.assessment_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.assessment_contract_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contract_amendments ENABLE ROW LEVEL SECURITY;

-- Company-scoped access
DROP POLICY IF EXISTS "Assessment contracts company access" ON public.assessment_contracts;
CREATE POLICY "Assessment contracts company access"
    ON public.assessment_contracts FOR ALL TO authenticated
    USING (company_id = public.get_current_company_id())
    WITH CHECK (company_id = public.get_current_company_id());

DROP POLICY IF EXISTS "Assessment contract items company access" ON public.assessment_contract_items;
CREATE POLICY "Assessment contract items company access"
    ON public.assessment_contract_items FOR ALL TO authenticated
    USING (company_id = public.get_current_company_id())
    WITH CHECK (company_id = public.get_current_company_id());

DROP POLICY IF EXISTS "Contract amendments company access" ON public.contract_amendments;
CREATE POLICY "Contract amendments company access"
    ON public.contract_amendments FOR ALL TO authenticated
    USING (company_id = public.get_current_company_id())
    WITH CHECK (company_id = public.get_current_company_id());

-- ─── RPC Helper Functions ─────────────────────────────────────────────────────
-- Calculate available funds for a contract
CREATE OR REPLACE FUNCTION public.get_contract_available_funds(
    p_contract_id TEXT
) RETURNS NUMERIC(15,2)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_contract assessment_contracts%ROWTYPE;
BEGIN
    SELECT * INTO v_contract FROM public.assessment_contracts 
    WHERE id = p_contract_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN 0;
    END IF;
    
    RETURN v_contract.prepaid_amount - v_contract.consumed_amount - v_contract.reserved_amount;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_contract_available_funds(TEXT) TO authenticated, anon, service_role;

-- Reserve assessment items from a contract
CREATE OR REPLACE FUNCTION public.reserve_assessment_items(
    p_contract_id TEXT,
    p_customer_id TEXT,
    p_assessment_type TEXT,
    p_assessment_grade TEXT,
    p_assessment_subject TEXT,
    p_count INTEGER,
    p_price NUMERIC(15,2),
    p_created_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_contract assessment_contracts%ROWTYPE;
    v_available_funds NUMERIC(15,2);
    v_total_cost NUMERIC(15,2);
    v_items TEXT[];
    v_now TIMESTAMPTZ := NOW();
    v_success BOOLEAN := true;
    v_message TEXT;
BEGIN
    -- Get contract for update
    SELECT * INTO v_contract FROM public.assessment_contracts 
    WHERE id = p_contract_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'contract_not_found');
    END IF;
    
    -- Check if contract is active
    IF v_contract.status != 'active' THEN
        RETURN jsonb_build_object('success', false, 'reason', 'contract_not_active', 'status', v_contract.status);
    END IF;
    
    -- Calculate available funds
    v_available_funds := v_contract.prepaid_amount - v_contract.consumed_amount - v_contract.reserved_amount;
    v_total_cost := p_count * p_price;
    
    -- Check if sufficient funds are available
    IF v_total_cost > v_available_funds THEN
        RETURN jsonb_build_object('success', false, 'reason', 'insufficient_funds', 'available', v_available_funds, 'required', v_total_cost);
    END IF;
    
    -- Create reservation items
    v_items := array_fill(p_contract_id, 1);
    
    FOR i IN 1..p_count LOOP
        INSERT INTO public.assessment_contract_items (
            id, contract_id, company_id, customer_id, school_id,
            assessment_type, assessment_grade, assessment_subject,
            assessment_name, status, item_price,
            reserved_at, created_by, created_at, updated_at, version, data
        ) VALUES (
            gen_random_uuid()::TEXT, p_contract_id, v_contract.company_id, p_customer_id, v_contract.school_id,
            p_assessment_type, p_assessment_grade, p_assessment_subject,
            format('%s - Assessment %s', p_assessment_type, i), 'reserved', p_price,
            v_now, p_created_by, v_now, v_now, 1, '{}'::jsonb
        ) RETURNING id INTO v_items[i];
    END LOOP;
    
    -- Update contract reserved amount
    UPDATE public.assessment_contracts 
    SET reserved_amount = reserved_amount + v_total_cost,
        updated_at = v_now,
        version = version + 1
    WHERE id = p_contract_id;
    
    -- Create wallet transaction for reservation
    INSERT INTO public.wallet_transactions (
        id, data, created_at, updated_at, version
    ) VALUES (
        gen_random_uuid()::TEXT,
        jsonb_build_object(
            'type', 'ASSESSMENT_RESERVATION',
            'contract_id', p_contract_id,
            'customer_id', p_customer_id,
            'assessment_type', p_assessment_type,
            'assessment_grade', p_assessment_grade,
            'assessment_subject', p_assessment_subject,
            'item_count', p_count,
            'item_price', p_price,
            'total_amount', v_total_cost,
            'assessment_item_ids', v_items,
            'created_by', p_created_by
        ),
        v_now, v_now, 1
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'contract_id', p_contract_id,
        'assessment_item_ids', v_items,
        'total_cost', v_total_cost,
        'remaining_funds', v_available_funds - v_total_cost
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.reserve_assessment_items(
    TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, NUMERIC(15,2), TEXT
) TO authenticated, anon, service_role;

-- Consume assessment items (mark as used)
CREATE OR REPLACE FUNCTION public.consume_assessment_items(
    p_assessment_item_ids TEXT[],
    p_consumed_at TIMESTAMPTZ DEFAULT NOW(),
    p_created_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_item assessment_contract_items%ROWTYPE;
    v_contract assessment_contracts%ROWTYPE;
    v_consumed_count INTEGER := 0;
    v_consumed_amount NUMERIC(15,2) := 0;
    v_now TIMESTAMPTZ := COALESCE(p_consumed_at, NOW());
    v_success BOOLEAN := true;
BEGIN
    -- Process each item
    FOREACH v_item_id IN ARRAY p_assessment_item_ids LOOP
        BEGIN
            -- Get item and contract for update
            SELECT i.* INTO v_item FROM public.assessment_contract_items i
            JOIN public.assessment_contracts c ON i.contract_id = c.id
            WHERE i.id = v_item_id AND i.status = 'reserved' FOR UPDATE;
            
            IF FOUND THEN
                -- Update item status
                UPDATE public.assessment_contract_items 
                SET status = 'consumed',
                    consumed_at = v_now,
                    updated_at = v_now,
                    version = version + 1
                WHERE id = v_item_id;
                
                -- Update contract consumed amount
                UPDATE public.assessment_contracts 
                SET consumed_amount = consumed_amount + v_item.item_price,
                    updated_at = v_now,
                    version = version + 1
                WHERE id = v_item.contract_id;
                
                v_consumed_count := v_consumed_count + 1;
                v_consumed_amount := v_consumed_amount + v_item.item_price;
            END IF;
        EXCEPTION WHEN OTHERS THEN
            -- Log error but continue with other items
            v_success := false;
            CONTINUE;
        END;
    END LOOP;
    
    -- Create wallet transaction for consumption
    IF v_consumed_count > 0 THEN
        INSERT INTO public.wallet_transactions (
            id, data, created_at, updated_at, version
        ) VALUES (
            gen_random_uuid()::TEXT,
            jsonb_build_object(
                'type', 'ASSESSMENT_CONSUMPTION',
                'assessment_item_ids', p_assessment_item_ids,
                'consumed_count', v_consumed_count,
                'consumed_amount', v_consumed_amount,
                'consumed_at', v_now,
                'created_by', p_created_by
            ),
            v_now, v_now, 1
        );
    END IF;
    
    RETURN jsonb_build_object(
        'success', v_success,
        'consumed_count', v_consumed_count,
        'consumed_amount', v_consumed_amount,
        'total_items', array_length(p_assessment_item_ids, 1)
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.consume_assessment_items(
    TEXT[], TIMESTAMPTZ, TEXT
) TO authenticated, anon, service_role;

-- Create assessment contract with payment verification
CREATE OR REPLACE FUNCTION public.create_assessment_contract(
    p_company_id TEXT,
    p_customer_id TEXT,
    p_school_id TEXT,
    p_title TEXT,
    p_description TEXT,
    p_prepaid_amount NUMERIC(15,2),
    p_assessment_type TEXT,
    p_assessment_grade TEXT,
    p_assessment_subject TEXT,
    p_max_assessments INTEGER,
    p_assessment_price NUMERIC(15,2),
    p_starts_at TIMESTAMPTZ,
    p_ends_at TIMESTAMPTZ,
    p_expires_at TIMESTAMPTZ,
    p_payment_id TEXT,
    p_created_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_contract_id TEXT := gen_random_uuid()::TEXT;
    v_contract_number TEXT;
    v_now TIMESTAMPTZ := NOW();
    v_status TEXT := 'pending_payment';
BEGIN
    -- Generate contract number
    v_contract_number := format('AC-%s-%s', 
        to_char(v_now, 'YYYYMMDD'), 
        right(gen_random_uuid()::TEXT, 8));
    
    -- Create contract
    INSERT INTO public.assessment_contracts (
        id, company_id, customer_id, school_id, contract_number, title, description,
        status, prepaid_amount, assessment_type, assessment_grade, assessment_subject,
        assessment_count, max_assessments, assessment_price,
        starts_at, ends_at, expires_at,
        payment_id, payment_status,
        created_by, created_at, updated_at, version, data
    ) VALUES (
        v_contract_id, p_company_id, p_customer_id, p_school_id, v_contract_number, p_title, p_description,
        v_status, p_prepaid_amount, p_assessment_type, p_assessment_grade, p_assessment_subject,
        0, p_max_assessments, p_assessment_price,
        p_starts_at, p_ends_at, p_expires_at,
        p_payment_id, 'pending',
        p_created_by, v_now, v_now, 1, '{}'::jsonb
    );
    
    -- Create wallet transaction for deposit
    INSERT INTO public.wallet_transactions (
        id, data, created_at, updated_at, version
    ) VALUES (
        gen_random_uuid()::TEXT,
        jsonb_build_object(
            'type', 'CONTRACT_DEPOSIT',
            'contract_id', v_contract_id,
            'customer_id', p_customer_id,
            'amount', p_prepaid_amount,
            'assessment_type', p_assessment_type,
            'assessment_grade', p_assessment_grade,
            'assessment_subject', p_assessment_subject,
            'max_assessments', p_max_assessments,
            'assessment_price', p_assessment_price,
            'contract_number', v_contract_number,
            'payment_id', p_payment_id,
            'created_by', p_created_by
        ),
        v_now, v_now, 1
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'contract_id', v_contract_id,
        'contract_number', v_contract_number,
        'status', v_status,
        'message', 'Assessment contract created successfully'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_assessment_contract(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC(15,2), TEXT, TEXT, TEXT, 
    INTEGER, NUMERIC(15,2), TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT
) TO authenticated, anon, service_role;

-- Verify payment and activate contract
CREATE OR REPLACE FUNCTION public.verify_payment_and_activate_contract(
    p_contract_id TEXT,
    p_verified_by TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_contract assessment_contracts%ROWTYPE;
    v_now TIMESTAMPTZ := NOW();
BEGIN
    -- Get contract for update
    SELECT * INTO v_contract FROM public.assessment_contracts 
    WHERE id = p_contract_id FOR UPDATE;
    
    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'contract_not_found');
    END IF;
    
    -- Check current status
    IF v_contract.status != 'pending_payment' THEN
        RETURN jsonb_build_object('success', false, 'reason', 'invalid_status', 'current_status', v_contract.status);
    END IF;
    
    -- Check if payment is already verified
    IF v_contract.payment_status = 'verified' THEN
        RETURN jsonb_build_object('success', false, 'reason', 'already_verified');
    END IF;
    
    -- Update contract
    UPDATE public.assessment_contracts 
    SET status = 'active',
        payment_status = 'verified',
        payment_verified_at = v_now,
        wallet_credit_applied_at = v_now,
        activated_at = v_now,
        updated_at = v_now,
        version = version + 1
    WHERE id = p_contract_id;
    
    -- Create wallet transaction for activation
    INSERT INTO public.wallet_transactions (
        id, data, created_at, updated_at, version
    ) VALUES (
        gen_random_uuid()::TEXT,
        jsonb_build_object(
            'type', 'CONTRACT_ACTIVATION',
            'contract_id', p_contract_id,
            'amount', v_contract.prepaid_amount,
            'verified_by', p_verified_by,
            'activated_at', v_now
        ),
        v_now, v_now, 1
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'contract_id', p_contract_id,
        'status', 'active',
        'activated_at', v_now,
        'message', 'Contract activated successfully'
    );
END;
$$;

GRANT EXECUTE ON FUNCTION public.verify_payment_and_activate_contract(TEXT, TEXT) TO authenticated, anon, service_role;

-- ─── Realtime Publication ─────────────────────────────────────────────────────
-- Add assessment contracts to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.assessment_contracts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.assessment_contract_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.contract_amendments;
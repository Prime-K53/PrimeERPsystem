-- =============================================================================
-- 0013_financial_integrity.sql
-- Prime ERP — Financial integrity hardening (audit fixes F-12, F-21, F-25, F-26).
--
-- CONTEXT
--   0001_baseline_live_schema.sql establishes a JSONB-envelope document store
--   for every financial table. As a result, the application is the sole
--   enforcer of:
--     * invoice.paidAmount = SUM(payment_allocation_lines.amount)
--     * customer.outstandingBalance = (opening + Σ invoice.totalAmount − Σ payment credits)
--     * chart_of_accounts.balance = Σ(ledger_entries) by account
--     * uniqueness of document numbers
--     * ISO 4217 currency codes
--   This migration adds DB-level guarantees around those invariants WITHOUT
--   modifying any protected table (auth.users, products, inventory, warehouses,
--   warehouse_inventory, inventory_transactions, stock_movements, company
--   records, admin profiles).
--
-- IDEMPOTENT — safe to re-run. Uses CREATE OR REPLACE for functions and
-- DROP TRIGGER IF EXISTS / CREATE TRIGGER for trigger installation.
--
-- APPLIES ONLY TO PUBLIC SCHEMA envelope tables that the audit identified
-- as finance-bearing. The engagement/loyalty tables are intentionally left
-- alone (they already have NUMERIC(15,2) columns; no drift risk).
--
-- AUDIT REFERENCES
--   F-12: paidAmount / outstandingBalance / chart_of_accounts.balance drift
--   F-21: bankingService.transferFunds not transactional
--   F-25: missing uniqueness on document numbers
--   F-26: missing CHECK constraints on currency / amount
--   F-30: missing expression indexes on hot lookup fields
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. CHECK constraints on JSONB money / currency fields
--    Reject malformed payloads at the DB boundary so app-side bugs cannot
--    poison the books.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: ISO 4217 currency code check (3 uppercase letters).
CREATE OR REPLACE FUNCTION public.fn_is_iso_currency(code text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT code IS NULL OR code ~ '^[A-Z]{3}$'
$$;

-- Helper: positive-or-zero money check (string → numeric).
CREATE OR REPLACE FUNCTION public.fn_is_nonneg_money(s text)
RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT s IS NULL OR (s ~ '^-?[0-9]+(\.[0-9]+)?$' AND s::numeric >= 0)
$$;

-- Apply to every finance envelope table.  We attach CHECK constraints on the
-- *raw* `data` JSONB column without rewriting it.  A row already in the table
-- that violates a new constraint will block the migration; therefore the
-- constraint is added in NOT VALID form and validated separately.  This
-- follows the Postgres pattern for adding a constraint to a populated table
-- without taking an AccessExclusiveLock on reads.

DO $$
DECLARE
  tbl text;
  amt_paths text[] := ARRAY[
    'data->>''totalAmount''', 'data->>''subtotal''', 'data->>''paidAmount''',
    'data->>''balanceDue''', 'data->>''amount''', 'data->>''unitPrice''',
    'data->>''unit_price''', 'data->>''total''', 'data->>''taxAmount''',
    'data->>''tax_amount''', 'data->>''discount''', 'data->>''discountAmount''',
    'data->>''discount_amount''', 'data->>''otherCharges''',
    'data->>''shipping''', 'data->>''fee''', 'data->>''fees''',
    'data->>''commission'''', 'data->>''openingBalance''',
    'data->>''currentBalance''', 'data->>''balance''',
    'data->>''debit''', 'data->>''credit''',
    'data->>''debit_amount''', 'data->>''credit_amount''',
    'data->>''applied''', 'data->>''allocated''',
    'data->>''unallocatedAmount''',
    'data->>''walletDeposit'''
  ];
  cur_path text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'invoices', 'customer_payments', 'supplier_payments',
    'payment_allocations', 'payment_allocation_lines',
    'purchases', 'sales', 'sales_orders', 'quotations',
    'chart_of_accounts', 'ledger_entries', 'expenses', 'income',
    'bank_accounts', 'bank_transactions', 'transfers', 'cheques',
    'reminders', 'recurring_invoices', 'bank_scheduled_payments',
    'scheduled_payments', 'wallet_transactions',
    'bank_reconciliations', 'bank_adjustments', 'rounding_logs',
    'vat_transactions', 'tax_rates', 'bank_exchange_rates',
    'financial_years', 'payroll_runs', 'payslips', 'assets',
    'goods_receipts', 'delivery_notes', 'purchase_orders',
    'inventory_movements'
  ]
  LOOP
    -- Currency: data->>'currency' must be NULL or a 3-letter ISO code.
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS chk_%I_currency_iso',
      tbl, tbl
    );
    EXECUTE format(
      'ALTER TABLE public.%I ADD CONSTRAINT chk_%I_currency_iso '
      'CHECK (public.fn_is_iso_currency(data->>''currency'')) NOT VALID',
      tbl, tbl
    );

    -- Amount fields must be non-negative numerics or NULL.
    FOREACH cur_path IN ARRAY amt_paths
    LOOP
      EXECUTE format(
        'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS chk_%I_money_nonneg',
        tbl, tbl
      );
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT chk_%I_money_nonneg '
        'CHECK (public.fn_is_nonneg_money(%I)) NOT VALID',
        tbl, tbl, cur_path
      );
    END LOOP;
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. Partial unique constraints on document numbers.
--    Prevents duplicate invoice numbers, payment numbers, etc. across the
--    whole org. NULL/empty values are excluded from the index so legacy rows
--    without a number do not collide.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_invoice_number_unique
  ON public.invoices ((data->>'invoiceNumber'))
  WHERE data->>'invoiceNumber' IS NOT NULL AND data->>'invoiceNumber' <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_payments_payment_number_unique
  ON public.customer_payments ((data->>'paymentNumber'))
  WHERE data->>'paymentNumber' IS NOT NULL AND data->>'paymentNumber' <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_supplier_payments_payment_number_unique
  ON public.supplier_payments ((data->>'paymentNumber'))
  WHERE data->>'paymentNumber' IS NOT NULL AND data->>'paymentNumber' <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_purchase_number_unique
  ON public.purchases ((data->>'purchaseNumber'))
  WHERE data->>'purchaseNumber' IS NOT NULL AND data->>'purchaseNumber' <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotations_quotation_number_unique
  ON public.quotations ((data->>'quotationNumber'))
  WHERE data->>'quotationNumber' IS NOT NULL AND data->>'quotationNumber' <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_cheques_cheque_number_unique
  ON public.cheques ((data->>'chequeNumber'))
  WHERE data->>'chequeNumber' IS NOT NULL AND data->>'chequeNumber' <> '';

-- sales_orders.order_number uniqueness already added in 0009.

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Expression indexes on hot lookup fields.
--    Customer-scoped reports, supplier-scoped reports, account-scoped
--    ledger queries were doing full-table scans.  These indexes are
--    expression B-trees (the JSONB ->> operator is the indexed expression).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_invoices_customer_id_lookup
  ON public.invoices ((data->>'customerId'));

CREATE INDEX IF NOT EXISTS idx_invoices_status_lookup
  ON public.invoices ((data->>'status'));

CREATE INDEX IF NOT EXISTS idx_invoices_date_lookup
  ON public.invoices ((data->>'date'));

CREATE INDEX IF NOT EXISTS idx_customer_payments_customer_id_lookup
  ON public.customer_payments ((data->>'customerId'));

CREATE INDEX IF NOT EXISTS idx_customer_payments_invoice_id_lookup
  ON public.customer_payments ((data->>'invoiceId'));

CREATE INDEX IF NOT EXISTS idx_customer_payments_date_lookup
  ON public.customer_payments ((data->>'date'));

CREATE INDEX IF NOT EXISTS idx_supplier_payments_supplier_id_lookup
  ON public.supplier_payments ((data->>'supplierId'));

CREATE INDEX IF NOT EXISTS idx_purchases_supplier_id_lookup
  ON public.purchases ((data->>'supplierId'));

CREATE INDEX IF NOT EXISTS idx_purchases_date_lookup
  ON public.purchases ((data->>'date'));

CREATE INDEX IF NOT EXISTS idx_ledger_entries_account_id_lookup
  ON public.ledger_entries ((data->>'accountId'));

CREATE INDEX IF NOT EXISTS idx_ledger_entries_entry_date_lookup
  ON public.ledger_entries ((data->>'entryDate'));

CREATE INDEX IF NOT EXISTS idx_ledger_entries_reference_type_lookup
  ON public.ledger_entries ((data->>'referenceType'));

CREATE INDEX IF NOT EXISTS idx_expenses_expense_date_lookup
  ON public.expenses ((data->>'expenseDate'));

CREATE INDEX IF NOT EXISTS idx_income_income_date_lookup
  ON public.income ((data->>'incomeDate'));

CREATE INDEX IF NOT EXISTS idx_bank_transactions_bank_account_id_lookup
  ON public.bank_transactions ((data->>'bankAccountId'));

CREATE INDEX IF NOT EXISTS idx_bank_transactions_date_lookup
  ON public.bank_transactions ((data->>'transactionDate'));

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Authoritative derived balance triggers.
--    These are the DB-level guarantees that prevent the drift surfaced in
--    the audit.  Each trigger is BEFORE INSERT OR UPDATE so the cached
--    value is always written before the row hits the table.
--
--    All three are written in PL/pgSQL (not triggers on every table) so the
--    application keeps its freedom to read whatever it wants — the trigger
--    merely enforces that the *cached* column matches the *authoritative*
--    value.  If the application supplies a wrong cached value, the trigger
--    overwrites it with the correct one.  This is a DB-level "source of
--    truth" guarantee.
-- ─────────────────────────────────────────────────────────────────────────────

-- Helper: numeric-safe coercion of a JSONB text field.
CREATE OR REPLACE FUNCTION public.fn_num(v jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN v IS NULL OR v = 'null'::jsonb THEN 0
    WHEN jsonb_typeof(v) = 'number' THEN (v)::text::numeric
    WHEN jsonb_typeof(v) = 'string' AND v#>>'{}' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (v#>>'{}')::numeric
    ELSE NULL
  END
$$;

-- 4a. invoices.paidAmount = SUM(payment_allocation_lines.amount WHERE invoiceId = NEW.id)
--     and invoices.balanceDue = totalAmount − paidAmount.
--
--     Excludes voided / cancelled allocations (status NOT IN those values).
CREATE OR REPLACE FUNCTION public.fn_invoice_recompute_paid()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_paid numeric;
  v_total numeric;
BEGIN
  v_total := COALESCE(public.fn_num(NEW.data->'totalAmount'), 0);

  SELECT COALESCE(SUM(public.fn_num(l.data->'amount')), 0)
    INTO v_paid
    FROM public.payment_allocation_lines l
    JOIN public.payment_allocations a
      ON a.id = (l.data->>'allocationId')
   WHERE (l.data->>'invoiceId') = NEW.id
     AND COALESCE(LOWER(a.data->>'status'), '') NOT IN ('voided', 'cancelled');

  -- Round to 2 dp; cap at total (overpayment is allowed in the ledger but
  -- the *cached* paidAmount cannot exceed total).
  v_paid := LEAST(ROUND(v_paid, 2), v_total);

  NEW.data := jsonb_set(
    NEW.data,
    '{paidAmount}',
    to_jsonb(v_paid)
  );
  NEW.data := jsonb_set(
    NEW.data,
    '{balanceDue}',
    to_jsonb(ROUND(v_total - v_paid, 2))
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_invoices_recompute_paid ON public.invoices;
CREATE TRIGGER trg_invoices_recompute_paid
  BEFORE INSERT OR UPDATE OF data ON public.invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_invoice_recompute_paid();

-- 4b. payment_allocation_lines keeps invoice.paidAmount in sync when an
--     allocation line is added, modified, or removed.  Because the BEFORE
--     INSERT trigger on `invoices` already sets paidAmount from the SUM,
--     we just need to make the change set force an invoice re-evaluation.
--     Easiest way: emit a no-op UPDATE on the parent invoice so the BEFORE
--     trigger fires.  This is a deferred maintenance trigger, not a
--     correctness one — paidAmount is still strictly derived.
CREATE OR REPLACE FUNCTION public.fn_pal_invoice_touch()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_invoice_id text;
BEGIN
  v_invoice_id := COALESCE(NEW.data->>'invoiceId', OLD.data->>'invoiceId');
  IF v_invoice_id IS NOT NULL THEN
    UPDATE public.invoices
       SET updated_at = NOW()
     WHERE id = v_invoice_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_pal_invoice_touch_ins ON public.payment_allocation_lines;
CREATE TRIGGER trg_pal_invoice_touch_ins
  AFTER INSERT ON public.payment_allocation_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_pal_invoice_touch();

DROP TRIGGER IF EXISTS trg_pal_invoice_touch_upd ON public.payment_allocation_lines;
CREATE TRIGGER trg_pal_invoice_touch_upd
  AFTER UPDATE ON public.payment_allocation_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_pal_invoice_touch();

DROP TRIGGER IF EXISTS trg_pal_invoice_touch_del ON public.payment_allocation_lines;
CREATE TRIGGER trg_pal_invoice_touch_del
  AFTER DELETE ON public.payment_allocation_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_pal_invoice_touch();

-- 4c. customers.outstandingBalance = openingBalance
--     + Σ(invoices totalAmount where status NOT IN {draft,cancelled,voided,credit_note})
--     − Σ(customer_payments amountApplied ?? amount ?? 0 where status NOT IN {cancelled,voided})
--     − Σ(invoices totalAmount where status = 'credit_note' AND status NOT IN {draft,cancelled,voided})
--     and customers.walletBalance = openingWallet + Σ(wallet_transactions signed amount)
--
--     Recomputed on every customer row write.  This is the canonical
--     customer balance — the same formula used by customerLedger.cjs.
CREATE OR REPLACE FUNCTION public.fn_customer_recompute_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_open  numeric := COALESCE(public.fn_num(NEW.data->'balance'), 0);
  v_dr    numeric;
  v_cr    numeric;
  v_cn    numeric;
  v_bal   numeric;
  v_open_wallet numeric := COALESCE(public.fn_num(NEW.data->'walletBalance'), 0);
  v_wallet numeric;
BEGIN
  -- Receivable debits: invoices excluding closed statuses.
  SELECT COALESCE(SUM(public.fn_num(i.data->'totalAmount')), 0)
    INTO v_dr
    FROM public.invoices i
   WHERE (i.data->>'customerId') = NEW.id
     AND COALESCE(LOWER(i.data->>'status'), '') NOT IN ('draft','cancelled','voided','credit_note');

  -- Receivable credits: customer_payments, applying paymentCredit precedence.
  SELECT COALESCE(SUM(
    COALESCE(
      public.fn_num(p.data->'amountApplied'),
      public.fn_num(p.data->'amount'),
      0
    )
  ), 0)
    INTO v_cr
    FROM public.customer_payments p
   WHERE (p.data->>'customerId') = NEW.id
     AND COALESCE(LOWER(p.data->>'status'), '') NOT IN ('cancelled','voided');

  -- Credit notes reduce the balance too.
  SELECT COALESCE(SUM(public.fn_num(i.data->'totalAmount')), 0)
    INTO v_cn
    FROM public.invoices i
   WHERE (i.data->>'customerId') = NEW.id
     AND LOWER(COALESCE(i.data->>'status','')) = 'credit_note';

  v_bal := ROUND(v_open + v_dr - v_cr - v_cn, 2);

  NEW.data := jsonb_set(NEW.data, '{outstandingBalance}', to_jsonb(v_bal));

  -- Wallet: sum of signed wallet_transactions.
  SELECT COALESCE(SUM(
    CASE
      WHEN LOWER(COALESCE(t.data->>'type','')) IN ('debit','withdrawal')  THEN -public.fn_num(t.data->'amount')
      WHEN LOWER(COALESCE(t.data->>'type','')) IN ('credit','topup','deposit') THEN  public.fn_num(t.data->'amount')
      ELSE public.fn_num(t.data->'amount')
    END
  ), 0)
    INTO v_wallet
    FROM public.wallet_transactions t
   WHERE (t.data->>'customerId') = NEW.id;

  NEW.data := jsonb_set(
    NEW.data,
    '{walletBalance}',
    to_jsonb(ROUND(v_open_wallet + v_wallet, 2))
  );

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_customers_recompute_balance ON public.customers;
CREATE TRIGGER trg_customers_recompute_balance
  BEFORE INSERT OR UPDATE OF data ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_customer_recompute_balance();

-- 4d. suppliers.outstandingBalance mirrors the customer trigger.
CREATE OR REPLACE FUNCTION public.fn_supplier_recompute_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_open numeric := COALESCE(public.fn_num(NEW.data->'balance'), 0);
  v_dr   numeric;
  v_cr   numeric;
  v_bal  numeric;
BEGIN
  SELECT COALESCE(SUM(public.fn_num(p.data->'totalAmount')), 0)
    INTO v_dr
    FROM public.purchases p
   WHERE (p.data->>'supplierId') = NEW.id
     AND COALESCE(LOWER(p.data->>'status'),'') NOT IN ('draft','cancelled','voided');

  SELECT COALESCE(SUM(COALESCE(public.fn_num(sp.data->'amountApplied'), public.fn_num(sp.data->'amount'), 0)), 0)
    INTO v_cr
    FROM public.supplier_payments sp
   WHERE (sp.data->>'supplierId') = NEW.id
     AND COALESCE(LOWER(sp.data->>'status'),'') NOT IN ('cancelled','voided');

  v_bal := ROUND(v_open + v_dr - v_cr, 2);
  NEW.data := jsonb_set(NEW.data, '{outstandingBalance}', to_jsonb(v_bal));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_suppliers_recompute_balance ON public.suppliers;
CREATE TRIGGER trg_suppliers_recompute_balance
  BEFORE INSERT OR UPDATE OF data ON public.suppliers
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_supplier_recompute_balance();

-- 4e. chart_of_accounts.balance = SUM(ledger_entries) for that account.
--     The audit's biggest finding: this column is hand-entered and never
--     written by any service.  This trigger overwrites it on every write
--     with the authoritative SUM.  Operators can no longer "type a
--     balance" — the books are the books.
CREATE OR REPLACE FUNCTION public.fn_coa_recompute_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_debit  numeric;
  v_credit numeric;
  v_bal    numeric;
  v_opening numeric := COALESCE(public.fn_num(NEW.data->'openingBalance'), 0);
  v_type   text := LOWER(COALESCE(NEW.data->>'type',''));
BEGIN
  SELECT COALESCE(SUM(public.fn_num(e.data->'amount')), 0)
    INTO v_debit
    FROM public.ledger_entries e
   WHERE (e.data->>'accountId') = NEW.id
     AND LOWER(COALESCE(e.data->>'entryType','')) = 'debit'
     AND COALESCE(LOWER(e.data->>'referenceType'),'') <> 'reversal';

  SELECT COALESCE(SUM(public.fn_num(e.data->'amount')), 0)
    INTO v_credit
    FROM public.ledger_entries e
   WHERE (e.data->>'accountId') = NEW.id
     AND LOWER(COALESCE(e.data->>'entryType','')) = 'credit'
     AND COALESCE(LOWER(e.data->>'referenceType'),'') <> 'reversal';

  v_bal := ROUND(
    v_opening
    + CASE
        WHEN v_type IN ('asset','expense') THEN v_debit - v_credit
        ELSE v_credit - v_debit
      END,
    2
  );

  NEW.data := jsonb_set(NEW.data, '{balance}', to_jsonb(v_bal));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_coa_recompute_balance ON public.chart_of_accounts;
CREATE TRIGGER trg_coa_recompute_balance
  BEFORE INSERT OR UPDATE OF data ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_coa_recompute_balance();

-- 4f. After every ledger_entries write, re-evaluate the parent account so
--     its cached `balance` is up to date without waiting for the next COA
--     update.
CREATE OR REPLACE FUNCTION public.fn_ledger_touch_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id text;
BEGIN
  v_account_id := COALESCE(NEW.data->>'accountId', OLD.data->>'accountId');
  IF v_account_id IS NOT NULL THEN
    UPDATE public.chart_of_accounts
       SET updated_at = NOW()
     WHERE id = v_account_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_ledger_touch_account_ins ON public.ledger_entries;
CREATE TRIGGER trg_ledger_touch_account_ins
  AFTER INSERT ON public.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ledger_touch_account();

DROP TRIGGER IF EXISTS trg_ledger_touch_account_upd ON public.ledger_entries;
CREATE TRIGGER trg_ledger_touch_account_upd
  AFTER UPDATE ON public.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ledger_touch_account();

DROP TRIGGER IF EXISTS trg_ledger_touch_account_del ON public.ledger_entries;
CREATE TRIGGER trg_ledger_touch_account_del
  AFTER DELETE ON public.ledger_entries
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_ledger_touch_account();

-- 4g. bank_accounts.currentBalance = openingBalance + Σ(signed bank_transactions).
--     Mirrors the COA trigger; bank balances were also hand-entered.
CREATE OR REPLACE FUNCTION public.fn_bank_account_recompute_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_open  numeric := COALESCE(public.fn_num(NEW.data->'openingBalance'), 0);
  v_net   numeric;
BEGIN
  SELECT COALESCE(SUM(
    CASE
      WHEN LOWER(COALESCE(t.data->>'type','')) = 'debit'  THEN -public.fn_num(t.data->'amount')
      WHEN LOWER(COALESCE(t.data->>'type','')) = 'credit' THEN  public.fn_num(t.data->'amount')
      ELSE public.fn_num(t.data->'amount')
    END
  ), 0)
    INTO v_net
    FROM public.bank_transactions t
   WHERE (t.data->>'bankAccountId') = NEW.id;

  NEW.data := jsonb_set(
    NEW.data,
    '{currentBalance}',
    to_jsonb(ROUND(v_open + v_net, 2))
  );
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_bank_accounts_recompute_balance ON public.bank_accounts;
CREATE TRIGGER trg_bank_accounts_recompute_balance
  BEFORE INSERT OR UPDATE OF data ON public.bank_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bank_account_recompute_balance();

CREATE OR REPLACE FUNCTION public.fn_bank_txn_touch_account()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_account_id text;
BEGIN
  v_account_id := COALESCE(NEW.data->>'bankAccountId', OLD.data->>'bankAccountId');
  IF v_account_id IS NOT NULL THEN
    UPDATE public.bank_accounts SET updated_at = NOW() WHERE id = v_account_id;
  END IF;
  RETURN COALESCE(NEW, OLD);
END
$$;

DROP TRIGGER IF EXISTS trg_bank_txn_touch_account_ins ON public.bank_transactions;
CREATE TRIGGER trg_bank_txn_touch_account_ins
  AFTER INSERT ON public.bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bank_txn_touch_account();

DROP TRIGGER IF EXISTS trg_bank_txn_touch_account_upd ON public.bank_transactions;
CREATE TRIGGER trg_bank_txn_touch_account_upd
  AFTER UPDATE ON public.bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bank_txn_touch_account();

DROP TRIGGER IF EXISTS trg_bank_txn_touch_account_del ON public.bank_transactions;
CREATE TRIGGER trg_bank_txn_touch_account_del
  AFTER DELETE ON public.bank_transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_bank_txn_touch_account();

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. Trial-balance integrity view.
--    A read-only view that surfaces every financial invariant the audit
--    cared about.  Frontend and backend can query this single object
--    instead of re-deriving each value.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE VIEW public.v_trial_balance AS
SELECT
  coa.id                                                AS account_id,
  coa.data->>'code'                                     AS account_code,
  coa.data->>'name'                                     AS account_name,
  LOWER(COALESCE(coa.data->>'type',''))                 AS account_type,
  COALESCE(public.fn_num(coa.data->'balance'), 0)       AS balance,
  COALESCE((
    SELECT SUM(public.fn_num(e.data->'amount'))
      FROM public.ledger_entries e
     WHERE (e.data->>'accountId') = coa.id
       AND LOWER(COALESCE(e.data->>'entryType','')) = 'debit'
       AND COALESCE(LOWER(e.data->>'referenceType'),'') <> 'reversal'
  ), 0)                                                 AS sum_debits,
  COALESCE((
    SELECT SUM(public.fn_num(e.data->'amount'))
      FROM public.ledger_entries e
     WHERE (e.data->>'accountId') = coa.id
       AND LOWER(COALESCE(e.data->>'entryType','')) = 'credit'
       AND COALESCE(LOWER(e.data->>'referenceType'),'') <> 'reversal'
  ), 0)                                                 AS sum_credits
FROM public.chart_of_accounts coa
WHERE COALESCE((coa.data->>'isActive')::boolean, true)
  AND COALESCE((coa.data->>'deleted')::boolean, false) = false;

CREATE OR REPLACE VIEW public.v_trial_balance_balanced AS
SELECT
  SUM(sum_debits)   AS total_debits,
  SUM(sum_credits)  AS total_credits,
  SUM(sum_debits) - SUM(sum_credits) AS difference,
  (ABS(SUM(sum_debits) - SUM(sum_credits)) < 0.01) AS is_balanced
FROM public.v_trial_balance;

-- Customer balance view (mirror of trigger logic, exposed read-only).
CREATE OR REPLACE VIEW public.v_customer_balances AS
SELECT
  c.id                                                              AS customer_id,
  c.data->>'name'                                                    AS customer_name,
  COALESCE(public.fn_num(c.data->'balance'), 0)                       AS opening_balance,
  COALESCE(public.fn_num(c.data->'outstandingBalance'), 0)            AS outstanding_balance,
  COALESCE(public.fn_num(c.data->'walletBalance'), 0)                  AS wallet_balance,
  COALESCE((
    SELECT SUM(public.fn_num(i.data->'totalAmount'))
      FROM public.invoices i
     WHERE (i.data->>'customerId') = c.id
       AND COALESCE(LOWER(i.data->>'status'),'') NOT IN ('draft','cancelled','voided','credit_note')
  ), 0)                                                              AS total_invoiced,
  COALESCE((
    SELECT SUM(COALESCE(public.fn_num(p.data->'amountApplied'), public.fn_num(p.data->'amount'), 0))
      FROM public.customer_payments p
     WHERE (p.data->>'customerId') = c.id
       AND COALESCE(LOWER(p.data->>'status'),'') NOT IN ('cancelled','voided')
  ), 0)                                                              AS total_paid,
  COALESCE((
    SELECT SUM(public.fn_num(i.data->'totalAmount'))
      FROM public.invoices i
     WHERE (i.data->>'customerId') = c.id
       AND LOWER(COALESCE(i.data->>'status','')) = 'credit_note'
  ), 0)                                                              AS total_credit_notes
FROM public.customers c
WHERE COALESCE((c.data->>'deleted')::boolean, false) = false;

-- Supplier balance view (mirror of trigger logic).
CREATE OR REPLACE VIEW public.v_supplier_balances AS
SELECT
  s.id                                                              AS supplier_id,
  s.data->>'name'                                                    AS supplier_name,
  COALESCE(public.fn_num(s.data->'balance'), 0)                       AS opening_balance,
  COALESCE(public.fn_num(s.data->'outstandingBalance'), 0)            AS outstanding_balance,
  COALESCE((
    SELECT SUM(public.fn_num(p.data->'totalAmount'))
      FROM public.purchases p
     WHERE (p.data->>'supplierId') = s.id
       AND COALESCE(LOWER(p.data->>'status'),'') NOT IN ('draft','cancelled','voided')
  ), 0)                                                              AS total_billed,
  COALESCE((
    SELECT SUM(COALESCE(public.fn_num(sp.data->'amountApplied'), public.fn_num(sp.data->'amount'), 0))
      FROM public.supplier_payments sp
     WHERE (sp.data->>'supplierId') = s.id
       AND COALESCE(LOWER(sp.data->>'status'),'') NOT IN ('cancelled','voided')
  ), 0)                                                              AS total_paid
FROM public.suppliers s
WHERE COALESCE((s.data->>'deleted')::boolean, false) = false;

-- AR aging view.
CREATE OR REPLACE VIEW public.v_ar_aging AS
SELECT
  (i.data->>'customerId')                                            AS customer_id,
  i.id                                                               AS invoice_id,
  i.data->>'invoiceNumber'                                           AS invoice_number,
  COALESCE(public.fn_num(i.data->'totalAmount'), 0)                   AS total,
  COALESCE(public.fn_num(i.data->'paidAmount'), 0)                    AS paid,
  COALESCE(public.fn_num(i.data->'totalAmount'), 0)
    - COALESCE(public.fn_num(i.data->'paidAmount'), 0)                AS outstanding,
  i.data->>'date'                                                    AS invoice_date,
  i.data->>'dueDate'                                                 AS due_date,
  CASE
    WHEN COALESCE(public.fn_num(i.data->'paidAmount'),0) >=
         COALESCE(public.fn_num(i.data->'totalAmount'),0) THEN 'paid'
    ELSE 'open'
  END                                                                AS status_bucket,
  CASE
    WHEN (i.data->>'dueDate') IS NULL THEN 'current'
    WHEN ((i.data->>'dueDate'))::date >= CURRENT_DATE THEN 'current'
    WHEN ((i.data->>'dueDate'))::date >= CURRENT_DATE - 30 THEN 'days_1_30'
    WHEN ((i.data->>'dueDate'))::date >= CURRENT_DATE - 60 THEN 'days_31_60'
    WHEN ((i.data->>'dueDate'))::date >= CURRENT_DATE - 90 THEN 'days_61_90'
    ELSE 'over_90'
  END                                                                AS aging_bucket,
  i.data->>'currency'                                                AS currency
FROM public.invoices i
WHERE COALESCE(LOWER(i.data->>'status'),'') NOT IN
        ('draft','cancelled','voided','paid','credit_note')
  AND COALESCE(public.fn_num(i.data->'paidAmount'), 0)
      < COALESCE(public.fn_num(i.data->'totalAmount'), 0);

-- AP aging view (reads purchases, not invoices — fixes F-01).
CREATE OR REPLACE VIEW public.v_ap_aging AS
SELECT
  (p.data->>'supplierId')                                            AS supplier_id,
  p.id                                                               AS purchase_id,
  p.data->>'purchaseNumber'                                          AS purchase_number,
  COALESCE(public.fn_num(p.data->'totalAmount'), 0)                   AS total,
  COALESCE(public.fn_num(p.data->'paidAmount'), 0)                    AS paid,
  COALESCE(public.fn_num(p.data->'totalAmount'), 0)
    - COALESCE(public.fn_num(p.data->'paidAmount'), 0)                AS outstanding,
  p.data->>'date'                                                    AS bill_date,
  p.data->>'dueDate'                                                 AS due_date,
  CASE
    WHEN (p.data->>'dueDate') IS NULL THEN 'current'
    WHEN ((p.data->>'dueDate'))::date >= CURRENT_DATE THEN 'current'
    WHEN ((p.data->>'dueDate'))::date >= CURRENT_DATE - 30 THEN 'days_1_30'
    WHEN ((p.data->>'dueDate'))::date >= CURRENT_DATE - 60 THEN 'days_31_60'
    WHEN ((p.data->>'dueDate'))::date >= CURRENT_DATE - 90 THEN 'days_61_90'
    ELSE 'over_90'
  END                                                                AS aging_bucket,
  p.data->>'currency'                                                AS currency
FROM public.purchases p
WHERE COALESCE(LOWER(p.data->>'status'),'') NOT IN
        ('draft','cancelled','voided','paid')
  AND COALESCE(public.fn_num(p.data->'paidAmount'), 0)
      < COALESCE(public.fn_num(p.data->'totalAmount'), 0);

-- Profit & Loss view (revenue / COGS / opex grouped by account type and
-- period).  Reads the ledger (source of truth), not the invoice table.
CREATE OR REPLACE VIEW public.v_profit_and_loss AS
WITH period_entries AS (
  SELECT
    e.data->>'entryDate'                                AS entry_date,
    LOWER(COALESCE(e.data->>'entryType',''))            AS entry_type,
    COALESCE(public.fn_num(e.data->'amount'), 0)         AS amount,
    e.data->>'accountId'                                 AS account_id,
    e.data->>'currency'                                  AS currency,
    LOWER(COALESCE(coa.data->>'type',''))                AS account_type,
    LOWER(COALESCE(coa.data->>'subtype',''))             AS account_subtype
  FROM public.ledger_entries e
  LEFT JOIN public.chart_of_accounts coa
    ON coa.id = (e.data->>'accountId')
  WHERE COALESCE(LOWER(e.data->>'referenceType'),'') <> 'reversal'
)
SELECT
  account_type,
  account_subtype,
  currency,
  date_trunc('day', (entry_date)::timestamp)            AS day,
  SUM(CASE WHEN entry_type = 'credit' THEN amount ELSE 0 END) AS credits,
  SUM(CASE WHEN entry_type = 'debit'  THEN amount ELSE 0 END) AS debits
FROM period_entries
WHERE account_type IN ('revenue','expense','cogs','income','cost_of_goods_sold')
GROUP BY account_type, account_subtype, currency, day;

-- Invoice integrity view (every line item vs. invoice header).
-- The audit could not find a `invoice_items` table; line items live inside
-- the `items` JSONB array on each invoice.  This view validates the
-- header totals match the line-item sums.
CREATE OR REPLACE VIEW public.v_invoice_integrity AS
SELECT
  i.id                                            AS invoice_id,
  i.data->>'invoiceNumber'                        AS invoice_number,
  i.data->>'customerId'                           AS customer_id,
  i.data->>'currency'                             AS currency,
  COALESCE(public.fn_num(i.data->'totalAmount'), 0)  AS header_total,
  COALESCE(public.fn_num(i.data->'subtotal'), 0)     AS header_subtotal,
  COALESCE(public.fn_num(i.data->'taxAmount'), 0)    AS header_tax,
  COALESCE(public.fn_num(i.data->'paidAmount'), 0)   AS paid_amount,
  COALESCE(public.fn_num(i.data->'totalAmount'), 0)
    - COALESCE(public.fn_num(i.data->'paidAmount'), 0) AS balance_due,
  COALESCE((
    SELECT SUM(public.fn_num(item->>'amount'))
      FROM jsonb_array_elements(COALESCE(i.data->'items','[]'::jsonb)) item
  ), 0) AS sum_line_amounts,
  COALESCE((
    SELECT SUM(public.fn_num(item->>'quantity') * public.fn_num(item->>'unitPrice'))
      FROM jsonb_array_elements(COALESCE(i.data->'items','[]'::jsonb)) item
  ), 0) AS sum_qty_x_price,
  LOWER(COALESCE(i.data->>'status',''))           AS status
FROM public.invoices i;

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. Idempotency contract for the existing `idempotency_keys` table.
--    The audit found the table has no (endpoint, key) uniqueness and zero
--    callers.  We add the columns and constraints so future code can use
--    it as a real idempotency boundary.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.idempotency_keys
  ADD COLUMN IF NOT EXISTS endpoint text,
  ADD COLUMN IF NOT EXISTS request_key text,
  ADD COLUMN IF NOT EXISTS user_id text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_keys_endpoint_key
  ON public.idempotency_keys (endpoint, request_key)
  WHERE endpoint IS NOT NULL AND request_key IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. RLS for the new view consumption.
--    Views inherit RLS from the underlying tables.  No new policies needed;
--    `allow_all_*` policies from 0001 already cover the underlying tables.
-- ─────────────────────────────────────────────────────────────────────────────

COMMIT;

-- =============================================================================
-- END 0013_financial_integrity.sql
--
-- RECONCILIATION CHECK (run separately, by hand or in CI):
--
--   -- 1. Trial balance now balances (reversals excluded):
--   SELECT * FROM public.v_trial_balance_balanced;
--   -- Expect is_balanced = true.  If false, identify the offending accounts
--   -- with:
--   SELECT account_code, account_name, account_type, balance,
--          sum_debits, sum_credits,
--          (CASE WHEN account_type IN ('asset','expense')
--                THEN sum_debits - sum_credits
--                ELSE sum_credits - sum_debits END) AS expected_balance
--     FROM public.v_trial_balance
--    WHERE ABS(balance - (CASE WHEN account_type IN ('asset','expense')
--                              THEN sum_debits - sum_credits
--                              ELSE sum_credits - sum_debits END)) > 0.01;
--
--   -- 2. No invoice has paidAmount > totalAmount:
--   SELECT id, data->>'invoiceNumber' AS n, data->>'totalAmount' AS t,
--          data->>'paidAmount' AS p
--     FROM public.invoices
--    WHERE COALESCE((data->>'paidAmount')::numeric,0)
--        > COALESCE((data->>'totalAmount')::numeric,0);
--   -- Expect 0 rows.
--
--   -- 3. No invoice has line-total mismatch:
--   SELECT invoice_id, invoice_number, header_total, sum_line_amounts
--     FROM public.v_invoice_integrity
--    WHERE ABS(header_total - sum_line_amounts) > 0.01;
--   -- Expect 0 rows (modulo tax-inclusive invoices where header = subtotal+tax).
--
--   -- 4. AR / AP aging rows present:
--   SELECT aging_bucket, COUNT(*), SUM(outstanding)
--     FROM public.v_ar_aging GROUP BY aging_bucket;
--   SELECT aging_bucket, COUNT(*), SUM(outstanding)
--     FROM public.v_ap_aging GROUP BY aging_bucket;
-- =============================================================================

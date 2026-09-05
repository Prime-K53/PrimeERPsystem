-- =============================================================================
-- 0013_financial_integrity.sql
-- Prime ERP
--
-- FINAL LIVE-SCHEMA-COMPATIBLE VERSION
--
-- Purpose:
--   Financial integrity hardening for:
--     F-12  Financial balance / ledger reconciliation
--     F-21  Banking integrity support
--     F-25  Document-number uniqueness
--     F-26  Currency / amount validation
--     F-30  Financial lookup indexes
--
-- LIVE ARCHITECTURE CONFIRMED:
--
--   public.accounts
--       id: text
--       data: jsonb
--
--   public.ledger_entries
--       id: text
--       data: jsonb
--
-- ledger_entries account references:
--       data->>'account_id'
--       data->>'entry_type'
--       data->>'entry_date'
--       data->>'reference_type'
--       data->'amount'
--
-- accounts fields:
--       data->>'id'
--       data->>'code'
--       data->>'account_number'
--       data->>'name'
--       data->>'type'
--       data->>'account_type'
--       data->>'subtype'
--       data->>'parent_account_id'
--       data->>'allow_posting'
--       data->>'is_system_account'
--       data->>'is_active'
--
-- IMPORTANT:
--   This migration does NOT:
--     * create accounting entries
--     * create rounding entries
--     * delete ledger entries
--     * rewrite historical ledger entries
--     * migrate ledger schema
--     * reference debit_account_id / credit_account_id
--     * reference chart_of_accounts
--
-- =============================================================================

BEGIN;


-- =============================================================================
-- 1. NUMERIC HELPERS
-- =============================================================================

-- JSONB numeric helper.
CREATE OR REPLACE FUNCTION public.fn_num(v jsonb)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT
        CASE
            WHEN v IS NULL OR v = 'null'::jsonb THEN 0

            WHEN jsonb_typeof(v) = 'number'
                THEN (v::text)::numeric

            WHEN jsonb_typeof(v) = 'string'
                 AND v #>> '{}' ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN (v #>> '{}')::numeric

            ELSE 0
        END;
$$;


-- Text numeric helper.
--
-- Required because PostgreSQL's ->> operator returns text.
CREATE OR REPLACE FUNCTION public.fn_num(v text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT
        CASE
            WHEN v IS NULL OR btrim(v) = '' THEN 0

            WHEN btrim(v) ~ '^-?[0-9]+(\.[0-9]+)?$'
                THEN btrim(v)::numeric

            ELSE 0
        END;
$$;


-- =============================================================================
-- 2. CURRENCY VALIDATION
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_is_iso_currency(code text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT
        code IS NULL
        OR code ~ '^[A-Z]{3}$';
$$;


-- =============================================================================
-- 3. NON-NEGATIVE MONEY VALIDATION
-- =============================================================================
--
-- This helper accepts:
--   NULL
--   integer strings
--   decimal strings
--
-- It rejects:
--   negative values
--   malformed numeric strings
--
-- NOTE:
-- Signed accounting fields such as balance/debit/credit are deliberately
-- NOT included in the non-negative constraint below.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.fn_is_nonneg_money(s text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
    SELECT
        s IS NULL
        OR (
            btrim(s) ~ '^[0-9]+(\.[0-9]+)?$'
            AND btrim(s)::numeric >= 0
        );
$$;


-- =============================================================================
-- 4. JSONB FINANCIAL FIELD CHECKS
-- =============================================================================
--
-- The previous migration attempted to create one constraint repeatedly for
-- every amount path. That meant each iteration dropped the previous constraint.
--
-- This version creates:
--     one currency constraint
--     one money constraint
--
-- per table.
--
-- Only tables that actually exist are processed.
--
-- IMPORTANT:
-- We intentionally exclude:
--     balance
--     openingBalance
--     currentBalance
--     debit
--     credit
--     debit_amount
--     credit_amount
--
-- because those can legitimately be signed accounting values.
-- =============================================================================

DO $$
DECLARE
    tbl text;
    constraint_name text;
BEGIN

    FOREACH tbl IN ARRAY ARRAY[
        'invoices',
        'customer_payments',
        'supplier_payments',
        'payment_allocations',
        'payment_allocation_lines',
        'purchases',
        'sales',
        'sales_orders',
        'quotations',
        'accounts',
        'ledger_entries',
        'expenses',
        'income',
        'bank_accounts',
        'bank_transactions',
        'transfers',
        'cheques',
        'reminders',
        'recurring_invoices',
        'bank_scheduled_payments',
        'scheduled_payments',
        'wallet_transactions',
        'bank_reconciliations',
        'bank_adjustments',
        'rounding_logs',
        'vat_transactions',
        'tax_rates',
        'bank_exchange_rates',
        'financial_years',
        'payroll_runs',
        'payslips',
        'assets',
        'goods_receipts',
        'delivery_notes',
        'purchase_orders',
        'inventory_movements'
    ]
    LOOP

        -- ---------------------------------------------------------------
        -- Skip tables that do not exist.
        -- ---------------------------------------------------------------

        IF to_regclass('public.' || tbl) IS NULL THEN
            CONTINUE;
        END IF;


        -- ---------------------------------------------------------------
        -- Currency
        -- ---------------------------------------------------------------

        constraint_name := 'chk_' || tbl || '_currency_iso';

        EXECUTE format(
            'ALTER TABLE public.%I
             DROP CONSTRAINT IF EXISTS %I',
            tbl,
            constraint_name
        );

        EXECUTE format(
            'ALTER TABLE public.%I
             ADD CONSTRAINT %I
             CHECK (
                 public.fn_is_iso_currency(data->>''currency'')
             ) NOT VALID',
            tbl,
            constraint_name
        );


        -- ---------------------------------------------------------------
        -- Non-negative financial amounts
        --
        -- All fields are checked together.
        -- Missing JSON fields evaluate to NULL and therefore pass.
        -- ---------------------------------------------------------------

        constraint_name := 'chk_' || tbl || '_money_nonneg';

        EXECUTE format(
            'ALTER TABLE public.%I
             DROP CONSTRAINT IF EXISTS %I',
            tbl,
            constraint_name
        );

        EXECUTE format(
            'ALTER TABLE public.%I
             ADD CONSTRAINT %I
             CHECK (
                 public.fn_is_nonneg_money(data->>''totalAmount'')
                 AND public.fn_is_nonneg_money(data->>''subtotal'')
                 AND public.fn_is_nonneg_money(data->>''paidAmount'')
                 AND public.fn_is_nonneg_money(data->>''balanceDue'')
                 AND public.fn_is_nonneg_money(data->>''amount'')
                 AND public.fn_is_nonneg_money(data->>''unitPrice'')
                 AND public.fn_is_nonneg_money(data->>''unit_price'')
                 AND public.fn_is_nonneg_money(data->>''total'')
                 AND public.fn_is_nonneg_money(data->>''taxAmount'')
                 AND public.fn_is_nonneg_money(data->>''tax_amount'')
                 AND public.fn_is_nonneg_money(data->>''discount'')
                 AND public.fn_is_nonneg_money(data->>''discountAmount'')
                 AND public.fn_is_nonneg_money(data->>''discount_amount'')
                 AND public.fn_is_nonneg_money(data->>''otherCharges'')
                 AND public.fn_is_nonneg_money(data->>''shipping'')
                 AND public.fn_is_nonneg_money(data->>''fee'')
                 AND public.fn_is_nonneg_money(data->>''fees'')
                 AND public.fn_is_nonneg_money(data->>''commission'')
                 AND public.fn_is_nonneg_money(data->>''applied'')
                 AND public.fn_is_nonneg_money(data->>''allocated'')
                 AND public.fn_is_nonneg_money(data->>''unallocatedAmount'')
                 AND public.fn_is_nonneg_money(data->>''walletDeposit'')
             ) NOT VALID',
            tbl,
            constraint_name
        );

    END LOOP;
END $$;


-- =============================================================================
-- 5. DOCUMENT NUMBER UNIQUENESS
-- =============================================================================
--
-- NULL and empty numbers are excluded so legacy/incomplete rows do not collide.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    idx_invoices_invoice_number_unique
ON public.invoices ((data->>'invoiceNumber'))
WHERE data->>'invoiceNumber' IS NOT NULL
  AND data->>'invoiceNumber' <> '';


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_customer_payments_payment_number_unique
ON public.customer_payments ((data->>'paymentNumber'))
WHERE data->>'paymentNumber' IS NOT NULL
  AND data->>'paymentNumber' <> '';


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_supplier_payments_payment_number_unique
ON public.supplier_payments ((data->>'paymentNumber'))
WHERE data->>'paymentNumber' IS NOT NULL
  AND data->>'paymentNumber' <> '';


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_purchases_purchase_number_unique
ON public.purchases ((data->>'purchaseNumber'))
WHERE data->>'purchaseNumber' IS NOT NULL
  AND data->>'purchaseNumber' <> '';


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_quotations_quotation_number_unique
ON public.quotations ((data->>'quotationNumber'))
WHERE data->>'quotationNumber' IS NOT NULL
  AND data->>'quotationNumber' <> '';


CREATE UNIQUE INDEX IF NOT EXISTS
    idx_cheques_cheque_number_unique
ON public.cheques ((data->>'chequeNumber'))
WHERE data->>'chequeNumber' IS NOT NULL
  AND data->>'chequeNumber' <> '';


-- sales_orders.order_number is intentionally not duplicated here.
-- Migration 0009 owns that numbering uniqueness.


-- =============================================================================
-- 6. HOT LOOKUP INDEXES
-- =============================================================================

CREATE INDEX IF NOT EXISTS
    idx_invoices_customer_id_lookup
ON public.invoices ((data->>'customerId'));

CREATE INDEX IF NOT EXISTS
    idx_invoices_status_lookup
ON public.invoices ((data->>'status'));

CREATE INDEX IF NOT EXISTS
    idx_invoices_date_lookup
ON public.invoices ((data->>'date'));


CREATE INDEX IF NOT EXISTS
    idx_customer_payments_customer_id_lookup
ON public.customer_payments ((data->>'customerId'));

CREATE INDEX IF NOT EXISTS
    idx_customer_payments_invoice_id_lookup
ON public.customer_payments ((data->>'invoiceId'));

CREATE INDEX IF NOT EXISTS
    idx_customer_payments_date_lookup
ON public.customer_payments ((data->>'date'));


CREATE INDEX IF NOT EXISTS
    idx_supplier_payments_supplier_id_lookup
ON public.supplier_payments ((data->>'supplierId'));

CREATE INDEX IF NOT EXISTS
    idx_purchases_supplier_id_lookup
ON public.purchases ((data->>'supplierId'));

CREATE INDEX IF NOT EXISTS
    idx_purchases_date_lookup
ON public.purchases ((data->>'date'));


-- LIVE ledger architecture:
-- account_id / entry_type / entry_date / reference_type

CREATE INDEX IF NOT EXISTS
    idx_ledger_entries_account_id_lookup
ON public.ledger_entries ((data->>'account_id'));

CREATE INDEX IF NOT EXISTS
    idx_ledger_entries_entry_type_lookup
ON public.ledger_entries ((data->>'entry_type'));

CREATE INDEX IF NOT EXISTS
    idx_ledger_entries_entry_date_lookup
ON public.ledger_entries ((data->>'entry_date'));

CREATE INDEX IF NOT EXISTS
    idx_ledger_entries_reference_type_lookup
ON public.ledger_entries ((data->>'reference_type'));


CREATE INDEX IF NOT EXISTS
    idx_expenses_expense_date_lookup
ON public.expenses ((data->>'expenseDate'));

CREATE INDEX IF NOT EXISTS
    idx_income_income_date_lookup
ON public.income ((data->>'incomeDate'));


CREATE INDEX IF NOT EXISTS
    idx_bank_transactions_bank_account_id_lookup
ON public.bank_transactions ((data->>'bankAccountId'));

CREATE INDEX IF NOT EXISTS
    idx_bank_transactions_date_lookup
ON public.bank_transactions ((data->>'transactionDate'));


-- =============================================================================
-- 7. CANONICAL COA INDEXES
-- =============================================================================
--
-- public.accounts is the canonical Chart of Accounts table.
--
-- PostgreSQL cannot use:
--
--   UNIQUE (data->>'account_number')
--
-- as a normal table constraint.
--
-- Use a unique expression index instead.
-- =============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS
    accounts_account_number_unique
ON public.accounts ((data->>'account_number'))
WHERE data->>'account_number' IS NOT NULL
  AND data->>'account_number' <> '';


CREATE INDEX IF NOT EXISTS
    idx_accounts_account_number
ON public.accounts ((data->>'account_number'));

CREATE INDEX IF NOT EXISTS
    idx_accounts_code
ON public.accounts ((data->>'code'));

CREATE INDEX IF NOT EXISTS
    idx_accounts_parent_account_id
ON public.accounts ((data->>'parent_account_id'));


-- =============================================================================
-- 8. INVOICE PAYMENT INTEGRITY VIEW
-- =============================================================================
--
-- This is read-only.
--
-- It compares stored invoice payment values with allocation data.
--
-- The existing Prime ERP financial migration established:
--
--   payment_allocation_lines.data->>'invoiceId'
--   payment_allocation_lines.data->>'allocationId'
--   payment_allocation_lines.data->'amount'
--
-- and:
--
--   payment_allocations.data->>'status'
--
-- so we retain that existing contract here.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_invoice_payment_integrity AS
SELECT
    i.id AS invoice_id,
    i.data->>'invoiceNumber' AS invoice_number,
    i.data->>'customerId' AS customer_id,
    i.data->>'currency' AS currency,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    ) AS total_amount,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(l.data->'amount')
            )
            FROM public.payment_allocation_lines l
            JOIN public.payment_allocations a
              ON a.id = l.data->>'allocationId'
            WHERE l.data->>'invoiceId' = i.id
              AND LOWER(
                    COALESCE(
                        a.data->>'status',
                        ''
                    )
                  ) NOT IN ('voided', 'cancelled')
        ),
        0
    ) AS calculated_paid_amount,

    COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
    ) AS stored_paid_amount,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    )
    -
    COALESCE(
        (
            SELECT SUM(
                public.fn_num(l.data->'amount')
            )
            FROM public.payment_allocation_lines l
            JOIN public.payment_allocations a
              ON a.id = l.data->>'allocationId'
            WHERE l.data->>'invoiceId' = i.id
              AND LOWER(
                    COALESCE(
                        a.data->>'status',
                        ''
                    )
                  ) NOT IN ('voided', 'cancelled')
        ),
        0
    ) AS calculated_balance_due

FROM public.invoices i;


-- =============================================================================
-- 9. TRIAL BALANCE
-- =============================================================================
--
-- LIVE ledger:
--
--   account_id
--   entry_type
--   amount
--   reference_type
--
-- LIVE COA:
--
--   public.accounts
--
-- Account matching supports both:
--
--   ledger account_id = accounts.id
--   ledger account_id = accounts.data->>'id'
--
-- This is intentional because the migration history contains both forms.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_trial_balance AS
SELECT
    a.id AS account_id,

    a.data->>'code' AS account_code,

    a.data->>'account_number' AS account_number,

    a.data->>'name' AS account_name,

    LOWER(
        COALESCE(
            a.data->>'account_type',
            a.data->>'type',
            ''
        )
    ) AS account_type,

    COALESCE(
        public.fn_num(a.data->'balance'),
        0
    ) AS balance,

    COALESCE(
        public.fn_num(a.data->'openingBalance'),
        0
    ) AS opening_balance,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(e.data->'amount')
            )
            FROM public.ledger_entries e
            WHERE (
                    e.data->>'account_id' = a.id
                    OR e.data->>'account_id' = a.data->>'id'
                  )
              AND LOWER(
                    COALESCE(
                        e.data->>'entry_type',
                        ''
                    )
                  ) = 'debit'
              AND LOWER(
                    COALESCE(
                        e.data->>'reference_type',
                        ''
                    )
                  ) <> 'reversal'
        ),
        0
    ) AS sum_debits,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(e.data->'amount')
            )
            FROM public.ledger_entries e
            WHERE (
                    e.data->>'account_id' = a.id
                    OR e.data->>'account_id' = a.data->>'id'
                  )
              AND LOWER(
                    COALESCE(
                        e.data->>'entry_type',
                        ''
                    )
                  ) = 'credit'
              AND LOWER(
                    COALESCE(
                        e.data->>'reference_type',
                        ''
                    )
                  ) <> 'reversal'
        ),
        0
    ) AS sum_credits

FROM public.accounts a

WHERE COALESCE(
          (a.data->>'is_active')::boolean,
          true
      ) = true

  AND COALESCE(
          (a.data->>'deleted')::boolean,
          false
      ) = false;


-- =============================================================================
-- 10. TRIAL BALANCE SUMMARY
-- =============================================================================

CREATE OR REPLACE VIEW public.v_trial_balance_balanced AS
SELECT
    COALESCE(
        SUM(sum_debits),
        0
    ) AS total_debits,

    COALESCE(
        SUM(sum_credits),
        0
    ) AS total_credits,

    COALESCE(
        SUM(sum_debits),
        0
    )
    -
    COALESCE(
        SUM(sum_credits),
        0
    ) AS difference,

    (
        ABS(
            COALESCE(
                SUM(sum_debits),
                0
            )
            -
            COALESCE(
                SUM(sum_credits),
                0
            )
        ) < 0.01
    ) AS is_balanced

FROM public.v_trial_balance;


-- =============================================================================
-- 11. ACCOUNT BALANCE RECONCILIATION
-- =============================================================================
--
-- READ ONLY.
--
-- This does NOT overwrite accounts.data.balance.
-- It exposes the calculation so existing balances can be audited safely.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_account_balance_integrity AS
SELECT
    a.id AS account_id,

    a.data->>'account_number' AS account_number,

    a.data->>'code' AS account_code,

    a.data->>'name' AS account_name,

    LOWER(
        COALESCE(
            a.data->>'account_type',
            a.data->>'type',
            ''
        )
    ) AS account_type,

    COALESCE(
        public.fn_num(a.data->'balance'),
        0
    ) AS stored_balance,

    COALESCE(
        public.fn_num(a.data->'openingBalance'),
        0
    ) AS opening_balance,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(e.data->'amount')
            )
            FROM public.ledger_entries e
            WHERE (
                    e.data->>'account_id' = a.id
                    OR e.data->>'account_id' = a.data->>'id'
                  )
              AND LOWER(
                    COALESCE(
                        e.data->>'entry_type',
                        ''
                    )
                  ) = 'debit'
              AND LOWER(
                    COALESCE(
                        e.data->>'reference_type',
                        ''
                    )
                  ) <> 'reversal'
        ),
        0
    ) AS debits,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(e.data->'amount')
            )
            FROM public.ledger_entries e
            WHERE (
                    e.data->>'account_id' = a.id
                    OR e.data->>'account_id' = a.data->>'id'
                  )
              AND LOWER(
                    COALESCE(
                        e.data->>'entry_type',
                        ''
                    )
                  ) = 'credit'
              AND LOWER(
                    COALESCE(
                        e.data->>'reference_type',
                        ''
                    )
                  ) <> 'reversal'
        ),
        0
    ) AS credits

FROM public.accounts a;


-- =============================================================================
-- 12. CUSTOMER BALANCE RECONCILIATION
-- =============================================================================
--
-- READ ONLY.
-- Does not rewrite customer balances.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_customer_balances AS
SELECT
    c.id AS customer_id,

    c.data->>'name' AS customer_name,

    COALESCE(
        public.fn_num(c.data->'balance'),
        0
    ) AS opening_balance,

    COALESCE(
        public.fn_num(c.data->'outstandingBalance'),
        0
    ) AS stored_outstanding_balance,

    COALESCE(
        public.fn_num(c.data->'walletBalance'),
        0
    ) AS stored_wallet_balance,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(i.data->'totalAmount')
            )
            FROM public.invoices i
            WHERE i.data->>'customerId' = c.id
              AND LOWER(
                    COALESCE(
                        i.data->>'status',
                        ''
                    )
                  ) NOT IN (
                      'draft',
                      'cancelled',
                      'voided',
                      'credit_note'
                  )
        ),
        0
    ) AS total_invoiced,

    COALESCE(
        (
            SELECT SUM(
                COALESCE(
                    public.fn_num(p.data->'amountApplied'),
                    public.fn_num(p.data->'amount'),
                    0
                )
            )
            FROM public.customer_payments p
            WHERE p.data->>'customerId' = c.id
              AND LOWER(
                    COALESCE(
                        p.data->>'status',
                        ''
                    )
                  ) NOT IN (
                      'cancelled',
                      'voided'
                  )
        ),
        0
    ) AS total_paid,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(i.data->'totalAmount')
            )
            FROM public.invoices i
            WHERE i.data->>'customerId' = c.id
              AND LOWER(
                    COALESCE(
                        i.data->>'status',
                        ''
                    )
                  ) = 'credit_note'
        ),
        0
    ) AS total_credit_notes

FROM public.customers c

WHERE COALESCE(
          (c.data->>'deleted')::boolean,
          false
      ) = false;


-- =============================================================================
-- 13. SUPPLIER BALANCE RECONCILIATION
-- =============================================================================

CREATE OR REPLACE VIEW public.v_supplier_balances AS
SELECT
    s.id AS supplier_id,

    s.data->>'name' AS supplier_name,

    COALESCE(
        public.fn_num(s.data->'balance'),
        0
    ) AS opening_balance,

    COALESCE(
        public.fn_num(s.data->'outstandingBalance'),
        0
    ) AS stored_outstanding_balance,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(p.data->'totalAmount')
            )
            FROM public.purchases p
            WHERE p.data->>'supplierId' = s.id
              AND LOWER(
                    COALESCE(
                        p.data->>'status',
                        ''
                    )
                  ) NOT IN (
                      'draft',
                      'cancelled',
                      'voided'
                  )
        ),
        0
    ) AS total_billed,

    COALESCE(
        (
            SELECT SUM(
                COALESCE(
                    public.fn_num(sp.data->'amountApplied'),
                    public.fn_num(sp.data->'amount'),
                    0
                )
            )
            FROM public.supplier_payments sp
            WHERE sp.data->>'supplierId' = s.id
              AND LOWER(
                    COALESCE(
                        sp.data->>'status',
                        ''
                    )
                  ) NOT IN (
                      'cancelled',
                      'voided'
                  )
        ),
        0
    ) AS total_paid

FROM public.suppliers s

WHERE COALESCE(
          (s.data->>'deleted')::boolean,
          false
      ) = false;


-- =============================================================================
-- 14. AR AGING
-- =============================================================================

CREATE OR REPLACE VIEW public.v_ar_aging AS
SELECT
    i.data->>'customerId' AS customer_id,

    i.id AS invoice_id,

    i.data->>'invoiceNumber' AS invoice_number,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    ) AS total,

    COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
    ) AS paid,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    )
    -
    COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
    ) AS outstanding,

    i.data->>'date' AS invoice_date,

    i.data->>'dueDate' AS due_date,

    CASE
        WHEN COALESCE(
            public.fn_num(i.data->'paidAmount'),
            0
        )
        >= COALESCE(
            public.fn_num(i.data->'totalAmount'),
            0
        )
        THEN 'paid'

        ELSE 'open'
    END AS status_bucket,

    CASE

        WHEN i.data->>'dueDate' IS NULL
            THEN 'current'

        WHEN i.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    i.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE
            THEN 'current'

        WHEN i.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    i.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 30
            THEN 'days_1_30'

        WHEN i.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    i.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 60
            THEN 'days_31_60'

        WHEN i.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    i.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 90
            THEN 'days_61_90'

        WHEN i.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN 'over_90'

        ELSE 'current'

    END AS aging_bucket,

    i.data->>'currency' AS currency

FROM public.invoices i

WHERE LOWER(
          COALESCE(
              i.data->>'status',
              ''
          )
      ) NOT IN (
          'draft',
          'cancelled',
          'voided',
          'paid',
          'credit_note'
      )

  AND COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
      )
      <
      COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
      );


-- =============================================================================
-- 15. AP AGING
-- =============================================================================

CREATE OR REPLACE VIEW public.v_ap_aging AS
SELECT
    p.data->>'supplierId' AS supplier_id,

    p.id AS purchase_id,

    p.data->>'purchaseNumber' AS purchase_number,

    COALESCE(
        public.fn_num(p.data->'totalAmount'),
        0
    ) AS total,

    COALESCE(
        public.fn_num(p.data->'paidAmount'),
        0
    ) AS paid,

    COALESCE(
        public.fn_num(p.data->'totalAmount'),
        0
    )
    -
    COALESCE(
        public.fn_num(p.data->'paidAmount'),
        0
    ) AS outstanding,

    p.data->>'date' AS bill_date,

    p.data->>'dueDate' AS due_date,

    CASE

        WHEN p.data->>'dueDate' IS NULL
            THEN 'current'

        WHEN p.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    p.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE
            THEN 'current'

        WHEN p.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    p.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 30
            THEN 'days_1_30'

        WHEN p.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    p.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 60
            THEN 'days_31_60'

        WHEN p.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
             AND LEFT(
                    p.data->>'dueDate',
                    10
                 )::date >= CURRENT_DATE - 90
            THEN 'days_61_90'

        WHEN p.data->>'dueDate'
             ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN 'over_90'

        ELSE 'current'

    END AS aging_bucket,

    p.data->>'currency' AS currency

FROM public.purchases p

WHERE LOWER(
          COALESCE(
              p.data->>'status',
              ''
          )
      ) NOT IN (
          'draft',
          'cancelled',
          'voided',
          'paid'
      )

  AND COALESCE(
        public.fn_num(p.data->'paidAmount'),
        0
      )
      <
      COALESCE(
        public.fn_num(p.data->'totalAmount'),
        0
      );


-- =============================================================================
-- 16. PROFIT & LOSS
-- =============================================================================
--
-- LIVE ledger fields are used.
-- LIVE COA is public.accounts.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_profit_and_loss AS

WITH period_entries AS (

    SELECT

        CASE
            WHEN e.data->>'entry_date'
                 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN LEFT(
                    e.data->>'entry_date',
                    10
                 )::date
            ELSE NULL
        END AS entry_date,

        LOWER(
            COALESCE(
                e.data->>'entry_type',
                ''
            )
        ) AS entry_type,

        COALESCE(
            public.fn_num(e.data->'amount'),
            0
        ) AS amount,

        e.data->>'account_id' AS account_id,

        e.data->>'currency' AS currency,

        LOWER(
            COALESCE(
                a.data->>'account_type',
                a.data->>'type',
                ''
            )
        ) AS account_type,

        LOWER(
            COALESCE(
                a.data->>'subtype',
                ''
            )
        ) AS account_subtype

    FROM public.ledger_entries e

    LEFT JOIN public.accounts a
      ON (
          a.id = e.data->>'account_id'
          OR a.data->>'id' = e.data->>'account_id'
      )

    WHERE LOWER(
              COALESCE(
                  e.data->>'reference_type',
                  ''
              )
          ) <> 'reversal'
)

SELECT

    account_type,

    account_subtype,

    currency,

    entry_date AS day,

    SUM(
        CASE
            WHEN entry_type = 'credit'
                THEN amount
            ELSE 0
        END
    ) AS credits,

    SUM(
        CASE
            WHEN entry_type = 'debit'
                THEN amount
            ELSE 0
        END
    ) AS debits

FROM period_entries

WHERE account_type IN (
    'revenue',
    'expense',
    'cogs',
    'income',
    'cost_of_goods_sold'
)

GROUP BY
    account_type,
    account_subtype,
    currency,
    entry_date;


-- =============================================================================
-- 17. INVOICE LINE INTEGRITY
-- =============================================================================
--
-- Invoice line items live in invoices.data->'items'.
--
-- IMPORTANT:
-- jsonb_array_elements() returns JSONB.
-- Therefore item->'amount', item->'quantity', item->'unitPrice' are passed
-- to fn_num(jsonb).
--
-- The text overload also exists for any future ->> callers.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_invoice_integrity AS

SELECT

    i.id AS invoice_id,

    i.data->>'invoiceNumber' AS invoice_number,

    i.data->>'customerId' AS customer_id,

    i.data->>'currency' AS currency,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    ) AS header_total,

    COALESCE(
        public.fn_num(i.data->'subtotal'),
        0
    ) AS header_subtotal,

    COALESCE(
        public.fn_num(i.data->'taxAmount'),
        0
    ) AS header_tax,

    COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
    ) AS paid_amount,

    COALESCE(
        public.fn_num(i.data->'totalAmount'),
        0
    )
    -
    COALESCE(
        public.fn_num(i.data->'paidAmount'),
        0
    ) AS balance_due,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(
                    item->'amount'
                )
            )

            FROM jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(
                        COALESCE(
                            i.data->'items',
                            '[]'::jsonb
                        )
                    ) = 'array'
                    THEN COALESCE(
                        i.data->'items',
                        '[]'::jsonb
                    )
                    ELSE '[]'::jsonb
                END
            ) AS item
        ),
        0
    ) AS sum_line_amounts,

    COALESCE(
        (
            SELECT SUM(
                public.fn_num(
                    item->'quantity'
                )
                *
                public.fn_num(
                    item->'unitPrice'
                )
            )

            FROM jsonb_array_elements(
                CASE
                    WHEN jsonb_typeof(
                        COALESCE(
                            i.data->'items',
                            '[]'::jsonb
                        )
                    ) = 'array'
                    THEN COALESCE(
                        i.data->'items',
                        '[]'::jsonb
                    )
                    ELSE '[]'::jsonb
                END
            ) AS item
        ),
        0
    ) AS sum_qty_x_price,

    LOWER(
        COALESCE(
            i.data->>'status',
            ''
        )
    ) AS status

FROM public.invoices i;


-- =============================================================================
-- 18. ORPHAN LEDGER ACCOUNT REFERENCES
-- =============================================================================
--
-- READ ONLY.
--
-- Identifies ledger entries whose account_id cannot be resolved against
-- public.accounts.
--
-- This is particularly important after the COA migration.
-- =============================================================================

CREATE OR REPLACE VIEW public.v_orphan_ledger_account_references AS

SELECT

    e.id AS ledger_entry_id,

    e.data->>'account_id' AS account_id,

    e.data->>'account_code' AS account_code,

    e.data->>'account_name' AS account_name,

    e.data->>'entry_type' AS entry_type,

    e.data->>'amount' AS amount,

    e.data->>'entry_date' AS entry_date,

    e.data->>'reference_id' AS reference_id,

    e.data->>'description' AS description

FROM public.ledger_entries e

LEFT JOIN public.accounts a
  ON (
      a.id = e.data->>'account_id'
      OR a.data->>'id' = e.data->>'account_id'
  )

WHERE e.data->>'account_id' IS NOT NULL

  AND a.id IS NULL;


-- =============================================================================
-- 19. DUPLICATE ACCOUNT NUMBER DIAGNOSTIC VIEW
-- =============================================================================

CREATE OR REPLACE VIEW public.v_duplicate_account_numbers AS

SELECT

    data->>'account_number' AS account_number,

    COUNT(*) AS row_count,

    STRING_AGG(
        id
        || ' = '
        || COALESCE(
            data->>'name',
            ''
        ),
        ' | '
        ORDER BY id
    ) AS accounts

FROM public.accounts

WHERE data->>'account_number' IS NOT NULL

GROUP BY data->>'account_number'

HAVING COUNT(*) > 1;


-- =============================================================================
-- 20. IDEMPOTENCY CONTRACT
-- =============================================================================
--
-- Only modify the table if it exists.
-- This avoids inventing a schema in installations where it is absent.
-- =============================================================================

DO $$
BEGIN

    IF to_regclass('public.idempotency_keys') IS NOT NULL THEN

        ALTER TABLE public.idempotency_keys
            ADD COLUMN IF NOT EXISTS endpoint text;

        ALTER TABLE public.idempotency_keys
            ADD COLUMN IF NOT EXISTS request_key text;

        ALTER TABLE public.idempotency_keys
            ADD COLUMN IF NOT EXISTS user_id text;

        ALTER TABLE public.idempotency_keys
            ADD COLUMN IF NOT EXISTS completed_at timestamptz;

        CREATE UNIQUE INDEX IF NOT EXISTS
            idx_idempotency_keys_endpoint_key
        ON public.idempotency_keys (
            endpoint,
            request_key
        )
        WHERE endpoint IS NOT NULL
          AND request_key IS NOT NULL;

    END IF;

END $$;


-- =============================================================================
-- 21. MIGRATION COMPLETE
-- =============================================================================

COMMIT;


-- =============================================================================
-- POST-MIGRATION RECONCILIATION
--
-- Run these AFTER the migration succeeds.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- A. Trial balance
-- -----------------------------------------------------------------------------
--
-- SELECT *
-- FROM public.v_trial_balance_balanced;


-- -----------------------------------------------------------------------------
-- B. Account balance discrepancies
-- -----------------------------------------------------------------------------
--
-- SELECT
--     account_number,
--     account_name,
--     account_type,
--     stored_balance,
--     opening_balance,
--     debits,
--     credits,
--     (
--         opening_balance
--         +
--         CASE
--             WHEN account_type IN ('asset','expense')
--                 THEN debits - credits
--             ELSE credits - debits
--         END
--     ) AS calculated_balance
-- FROM public.v_account_balance_integrity
-- WHERE ABS(
--     stored_balance -
--     (
--         opening_balance
--         +
--         CASE
--             WHEN account_type IN ('asset','expense')
--                 THEN debits - credits
--             ELSE credits - debits
--         END
--     )
-- ) > 0.01
-- ORDER BY account_number;


-- -----------------------------------------------------------------------------
-- C. Orphan ledger references
-- -----------------------------------------------------------------------------
--
-- SELECT *
-- FROM public.v_orphan_ledger_account_references;


-- -----------------------------------------------------------------------------
-- D. Duplicate account numbers
-- -----------------------------------------------------------------------------
--
-- SELECT *
-- FROM public.v_duplicate_account_numbers;


-- -----------------------------------------------------------------------------
-- E. Invoice payment discrepancies
-- -----------------------------------------------------------------------------
--
-- SELECT
--     invoice_number,
--     total_amount,
--     stored_paid_amount,
--     calculated_paid_amount,
--     calculated_balance_due
-- FROM public.v_invoice_payment_integrity
-- WHERE ABS(
--     stored_paid_amount
--     -
--     calculated_paid_amount
-- ) > 0.01;


-- -----------------------------------------------------------------------------
-- F. Invoice line discrepancies
-- -----------------------------------------------------------------------------
--
-- SELECT
--     invoice_number,
--     header_total,
--     sum_line_amounts,
--     sum_qty_x_price
-- FROM public.v_invoice_integrity
-- WHERE ABS(
--     header_total
--     -
--     sum_line_amounts
-- ) > 0.01;


-- -----------------------------------------------------------------------------
-- G. AR aging
-- -----------------------------------------------------------------------------
--
-- SELECT
--     aging_bucket,
--     COUNT(*) AS invoice_count,
--     SUM(outstanding) AS outstanding
-- FROM public.v_ar_aging
-- GROUP BY aging_bucket
-- ORDER BY aging_bucket;


-- -----------------------------------------------------------------------------
-- H. AP aging
-- -----------------------------------------------------------------------------
--
-- SELECT
--     aging_bucket,
--     COUNT(*) AS bill_count,
--     SUM(outstanding) AS outstanding
-- FROM public.v_ap_aging
-- GROUP BY aging_bucket
-- ORDER BY aging_bucket;
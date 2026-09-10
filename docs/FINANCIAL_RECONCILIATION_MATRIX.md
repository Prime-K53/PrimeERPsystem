# Prime ERP — Financial Reconciliation Matrix

**Date:** 2026-09-09  
**Purpose:** Define the authoritative reconciliation checks for every financial layer, with formulas, sources, and pass/fail criteria.

---

## Reconciliation Rules

### R-01: Invoice Total Reconciliation

**Formula:**
```
subtotal + taxAmount + deliveryFee - discount = totalAmount
```

**Source:** `invoices.data.subtotal`, `invoices.data.taxAmount`, `invoices.data.deliveryFee`, `invoices.data.discount`, `invoices.data.totalAmount`

**Check:**
```sql
SELECT id, data->>'invoiceNumber' AS n,
       ABS((data->>'subtotal')::numeric + (data->>'taxAmount')::numeric + (data->>'deliveryFee')::numeric - (data->>'discount')::numeric - (data->>'totalAmount')::numeric) AS diff
FROM invoices
WHERE ABS((data->>'subtotal')::numeric + (data->>'taxAmount')::numeric + (data->>'deliveryFee')::numeric - (data->>'discount')::numeric - (data->>'totalAmount')::numeric) > 0.01;
```

**Pass criteria:** 0 rows returned

**DB-level enforcement:** `v_invoice_integrity` view validates `header_total` vs `sum_line_amounts`

---

### R-02: Invoice paidAmount = SUM(allocations)

**Formula:**
```
invoices.data.paidAmount = SUM(payment_allocation_lines.data.amount)
    WHERE payment_allocation_lines.invoiceId = invoices.id
    AND payment_allocations.status NOT IN ('voided', 'cancelled')
```

**Source:** `invoices.data.paidAmount`, `payment_allocation_lines.data.amount`, `payment_allocations.data.status`

**Check:**
```sql
SELECT i.id, i.data->>'invoiceNumber' AS n, i.data->>'paidAmount' AS cached,
       COALESCE(SUM(pal.data->>'amount'), 0)::numeric AS actual
FROM invoices i
LEFT JOIN payment_allocation_lines pal ON pal.data->>'invoiceId' = i.id
LEFT JOIN payment_allocations pa ON pa.id = pal.data->>'allocationId'
WHERE COALESCE(LOWER(pa.data->>'status'), '') NOT IN ('voided', 'cancelled')
GROUP BY i.id
HAVING ABS(i.data->>'paidAmount')::numeric - COALESCE(SUM(pal.data->>'amount'), 0)::numeric > 0.01;
```

**Pass criteria:** 0 rows returned

**DB-level enforcement:** `fn_invoice_recompute_paid()` trigger

---

### R-03: Invoice Outstanding = totalAmount - paidAmount

**Formula:**
```
invoices.data.balanceDue = invoices.data.totalAmount - invoices.data.paidAmount
```

**Source:** `invoices.data.balanceDue`, `invoices.data.totalAmount`, `invoices.data.paidAmount`

**Check:**
```sql
SELECT id, data->>'invoiceNumber' AS n,
       ABS((data->>'totalAmount')::numeric - (data->>'paidAmount')::numeric - (data->>'balanceDue')::numeric) AS diff
FROM invoices
WHERE ABS((data->>'totalAmount')::numeric - (data->>'paidAmount')::numeric - (data->>'balanceDue')::numeric) > 0.01;
```

**Pass criteria:** 0 rows returned

---

### R-04: Customer Outstanding Balance = Opening + Invoices - Payments - Credit Notes

**Formula:**
```
customers.data.outstandingBalance = customers.data.balance (opening)
    + SUM(invoices.data.totalAmount WHERE invoices.status NOT IN ('draft','cancelled','voided','credit_note'))
    - SUM(customer_payments.data.amountApplied ?? customer_payments.data.amount WHERE customer_payments.status NOT IN ('cancelled','voided'))
    - SUM(invoices.data.totalAmount WHERE invoices.status = 'credit_note')
```

**Source:** `customers.data.outstandingBalance`, `customers.data.balance`, `invoices`, `customer_payments`

**Check:**
```sql
SELECT c.id, c.data->>'name' AS n, c.data->>'outstandingBalance' AS cached, expected FROM (
  SELECT c.id, c.data->>'outstandingBalance' AS cached,
    COALESCE(public.fn_num(c.data->'balance'), 0)
    + COALESCE((SELECT SUM(public.fn_num(i.data->'totalAmount')) FROM invoices i WHERE i.data->>'customerId' = c.id AND LOWER(COALESCE(i.data->>'status','')) NOT IN ('draft','cancelled','voided','credit_note')), 0)
    - COALESCE((SELECT SUM(COALESCE(public.fn_num(p.data->'amountApplied'), public.fn_num(p.data->'amount'), 0)) FROM customer_payments p WHERE p.data->>'customerId' = c.id AND LOWER(COALESCE(p.data->>'status','')) NOT IN ('cancelled','voided')), 0)
    - COALESCE((SELECT SUM(public.fn_num(i.data->'totalAmount')) FROM invoices i WHERE i.data->>'customerId' = c.id AND LOWER(COALESCE(i.data->>'status','')) = 'credit_note'), 0) AS expected
  FROM customers c
) sub
WHERE ABS(cached - expected) > 0.01;
```

**Pass criteria:** 0 rows returned

**DB-level enforcement:** `fn_customer_recompute_balance()` trigger

---

### R-05: Customer Subledger = AR Control Account

**Formula:**
```
SUM(customers.outstandingBalance WHERE customer_id IS NOT NULL)
    ≈ chart_of_accounts.balance WHERE account_type = 'ASSET' AND subtype = 'RECEIVABLE'
```

**Source:** `customers.data.outstandingBalance`, `chart_of_accounts.data.balance`

**Check:**
```sql
-- AR control account balance
SELECT COALESCE(public.fn_num(coa.data->'balance'), 0) AS ar_balance
FROM chart_of_accounts coa
WHERE LOWER(COALESCE(coa.data->>'subtype','')) = 'receivable';

-- Sum of customer outstanding balances
SELECT COALESCE(SUM(public.fn_num(c.data->'outstandingBalance')), 0) AS customer_ar_sum
FROM customers c;
```

**Pass criteria:** `ABS(ar_balance - customer_ar_sum) < 0.01`

**Note:** This reconciliation includes ALL customers, including those with zero balance. The AR control account may include non-customer receivables (e.g., employee advances) depending on the COA structure.

---

### R-06: Trial Balance = SUM(Debits) = SUM(Credits)

**Formula:**
```
SUM(v_trial_balance.sum_debits) = SUM(v_trial_balance.sum_credits)
```

**Source:** `v_trial_balance_balanced` view

**Check:**
```sql
SELECT * FROM v_trial_balance_balanced;
```

**Pass criteria:** `is_balanced = true`, `difference = 0`

**DB-level enforcement:** View computes difference; no hard constraint

---

### R-07: Individual Journal Balance = 0

**Formula:**
```
For each journal_id:
    SUM(CASE WHEN entry_type = 'debit' THEN amount ELSE -amount END) = 0
```

**Source:** `ledger_entries.data.entry_type`, `ledger_entries.data.amount`, `ledger_entries.data.journal_id`

**Check:**
```sql
SELECT journal_id,
       SUM(CASE WHEN LOWER(COALESCE(data->>'entryType','')) = 'debit' THEN public.fn_num(data->'amount') ELSE -public.fn_num(data->'amount') END) AS net
FROM ledger_entries
WHERE journal_id IS NOT NULL
GROUP BY journal_id
HAVING ABS(SUM(CASE WHEN LOWER(COALESCE(data->>'entryType','')) = 'debit' THEN public.fn_num(data->'amount') ELSE -public.fn_num(data->'amount') END)) > 0.01;
```

**Pass criteria:** 0 rows returned

---

### R-08: No Orphan Ledger Entries

**Formula:**
```
All ledger_entries must have:
    reference_type IS NOT NULL
    reference_id IS NOT NULL
    account_id EXISTS in chart_of_accounts
```

**Source:** `ledger_entries.data.reference_type`, `ledger_entries.data.reference_id`, `ledger_entries.data.accountId`

**Check:**
```sql
-- Orphan by missing reference
SELECT id FROM ledger_entries WHERE reference_type IS NULL OR reference_id IS NULL;

-- Orphan by missing account
SELECT DISTINCT le.id FROM ledger_entries le
LEFT JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE coa.id IS NULL;
```

**Pass criteria:** 0 rows returned

---

### R-09: No Duplicate Document Numbers

**Formula:**
```
Each invoiceNumber, paymentNumber, quotationNumber, salesOrderNumber, purchaseNumber must be unique (non-NULL)
```

**Source:** Unique indexes in migration 0013

**Check:**
```sql
SELECT data->>'invoiceNumber' AS n, COUNT(*) FROM invoices GROUP BY data->>'invoiceNumber' HAVING COUNT(*) > 1 AND data->>'invoiceNumber' IS NOT NULL;
SELECT data->>'paymentNumber' AS n, COUNT(*) FROM customer_payments GROUP BY data->>'paymentNumber' HAVING COUNT(*) > 1 AND data->>'paymentNumber' IS NOT NULL;
SELECT data->>'quotationNumber' AS n, COUNT(*) FROM quotations GROUP BY data->>'quotationNumber' HAVING COUNT(*) > 1 AND data->>'quotationNumber' IS NOT NULL;
```

**Pass criteria:** 0 rows returned

**DB-level enforcement:** Unique partial indexes

---

### R-10: Payment Remaining = payment.amount - SUM(allocations)

**Formula:**
```
For each customer_payment:
    remaining = amount - SUM(payment_allocation_lines.amount)
```

**Source:** `customer_payments.data.amount`, `payment_allocation_lines.data.amount`

**Check:**
```sql
SELECT cp.id, cp.data->>'amount' AS total, COALESCE(SUM(pal.data->>'amount'),0)::numeric AS allocated,
       (cp.data->>'amount')::numeric - COALESCE(SUM(pal.data->>'amount'),0)::numeric AS remaining
FROM customer_payments cp
LEFT JOIN payment_allocations pa ON pa.data->>'paymentId' = cp.id
LEFT JOIN payment_allocation_lines pal ON pal.data->>'allocationId' = pa.id
GROUP BY cp.id
HAVING (cp.data->>'amount')::numeric < COALESCE(SUM(pal.data->>'amount'),0)::numeric - 0.01;
```

**Pass criteria:** 0 rows returned (no over-allocated payments)

---

### R-11: Allocation ≤ Invoice Outstanding

**Formula:**
```
For each payment_allocation_lines:
    amount ≤ (invoices.data.totalAmount - invoices.data.paidAmount)
```

**Source:** `payment_allocation_lines.data.amount`, `invoices.data.totalAmount`, `invoices.data.paidAmount`

**Check:**
```sql
SELECT pal.id, pal.data->>'amount' AS alloc, inv.data->>'totalAmount' AS total, inv.data->>'paidAmount' AS paid,
       (inv.data->>'totalAmount')::numeric - (inv.data->>'paidAmount')::numeric AS outstanding
FROM payment_allocation_lines pal
JOIN invoices inv ON inv.id = pal.data->>'invoiceId'
WHERE (pal.data->>'amount')::numeric > ((inv.data->>'totalAmount')::numeric - (inv.data->>'paidAmount')::numeric) + 0.01;
```

**Pass criteria:** 0 rows returned

**Application-level enforcement:** `paymentAllocationService.allocatePayment()` clamps to invoice total

---

### R-12: No Allocations on Voided/Cancelled Payments

**Formula:**
```
payment_allocations.status NOT IN ('voided', 'cancelled')
    OR payment_allocation_lines does not exist
```

**Source:** `payment_allocations.data.status`, `payment_allocation_lines.data.allocationId`

**Check:**
```sql
SELECT pal.id, pa.data->>'status' AS s
FROM payment_allocation_lines pal
JOIN payment_allocations pa ON pa.id = pal.data->>'allocationId'
WHERE LOWER(COALESCE(pa.data->>'status','')) IN ('voided', 'cancelled');
```

**Pass criteria:** 0 rows returned

---

### R-13: Bank Account Balance = Opening + SUM(transactions)

**Formula:**
```
bank_accounts.data.currentBalance = bank_accounts.data.openingBalance + SUM(signed bank_transactions.data.amount)
```

**Source:** `bank_accounts.data.currentBalance`, `bank_accounts.data.openingBalance`, `bank_transactions`

**Check:**
```sql
SELECT ba.id, ba.data->>'accountName' AS n,
       public.fn_num(ba.data->'openingBalance')
       + COALESCE((
           SELECT SUM(CASE WHEN LOWER(COALESCE(bt.data->>'type','')) IN ('deposit','transfer_in') THEN public.fn_num(bt.data->'amount') ELSE -public.fn_num(bt.data->'amount') END)
           FROM bank_transactions bt WHERE bt.data->>'bankAccountId' = ba.id
       ), 0) AS expected,
       public.fn_num(ba.data->'currentBalance') AS actual
FROM bank_accounts ba
WHERE ABS(
    public.fn_num(ba.data->'openingBalance')
    + COALESCE((
        SELECT SUM(CASE WHEN LOWER(COALESCE(bt.data->>'type','')) IN ('deposit','transfer_in') THEN public.fn_num(bt.data->'amount') ELSE -public.fn_num(bt.data->'amount') END)
        FROM bank_transactions bt WHERE bt.data->>'bankAccountId' = ba.id
    ), 0)
    - public.fn_num(ba.data->'currentBalance')
) > 0.01;
```

**Pass criteria:** 0 rows returned

**DB-level enforcement:** `fn_bank_account_recompute_balance()` trigger

---

### R-14: P&L Revenue = SUM(credit ledger entries to revenue accounts)

**Formula:**
```
revenue = SUM(ledger_entries.data.amount WHERE entry_type = 'credit' AND account_id IN (revenue accounts))
```

**Source:** `ledger_entries`, `chart_of_accounts`

**Check:**
```sql
SELECT COALESCE(SUM(public.fn_num(le.data->'amount')), 0) AS revenue
FROM ledger_entries le
JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE LOWER(COALESCE(le.data->>'entryType','')) = 'credit'
  AND LOWER(COALESCE(coa.data->>'type','')) = 'income'
  AND LOWER(COALESCE(le.data->>'referenceType'),'') <> 'reversal';
```

**Pass criteria:** Matches `v_profit_and_loss` revenue for same period

---

### R-15: P&L COGS = SUM(debit ledger entries to COGS accounts)

**Formula:**
```
cogs = SUM(ledger_entries.data.amount WHERE entry_type = 'debit' AND account_id IN (COGS accounts))
```

**Source:** `ledger_entries`, `chart_of_accounts`

**Check:**
```sql
SELECT COALESCE(SUM(public.fn_num(le.data->'amount')), 0) AS cogs
FROM ledger_entries le
JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE LOWER(COALESCE(le.data->>'entryType','')) = 'debit'
  AND LOWER(COALESCE(coa.data->>'type','')) = 'expense'
  AND LOWER(COALESCE(coa.data->>'subtype','')) = 'cogs'
  AND LOWER(COALESCE(le.data->>'referenceType'),'') <> 'reversal';
```

**Pass criteria:** Matches `v_profit_and_loss` cogs for same period

---

### R-16: P&L Opex = SUM(debit ledger entries to expense accounts)

**Formula:**
```
opex = SUM(ledger_entries.data.amount WHERE entry_type = 'debit' AND account_id IN (expense accounts, subtype != COGS))
```

**Source:** `ledger_entries`, `chart_of_accounts`

**Check:**
```sql
SELECT COALESCE(SUM(public.fn_num(le.data->'amount')), 0) AS opex
FROM ledger_entries le
JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE LOWER(COALESCE(le.data->>'entryType','')) = 'debit'
  AND LOWER(COALESCE(coa.data->>'type','')) = 'expense'
  AND LOWER(COALESCE(coa.data->>'subtype','')) NOT IN ('cogs', 'cost_of_goods_sold')
  AND LOWER(COALESCE(le.data->>'referenceType'),'') <> 'reversal';
```

**Pass criteria:** Matches `v_profit_and_loss` opex for same period

---

### R-17: Balance Sheet = Assets = Liabilities + Equity

**Formula:**
```
total_assets = total_liabilities + total_equity
```

**Source:** `v_trial_balance` view

**Check:**
```sql
SELECT 
    ABS(SUM(CASE WHEN account_type IN ('asset') THEN balance ELSE 0 END)
        - (SUM(CASE WHEN account_type IN ('liability') THEN balance ELSE 0 END)
           + SUM(CASE WHEN account_type IN ('equity') THEN balance ELSE 0 END))) AS diff
FROM v_trial_balance;
```

**Pass criteria:** `diff < 0.01`

**Note:** The balance sheet report computes this and exposes `balanced: true/false`

---

### R-18: No Reverse-Allocated Payments

**Formula:**
```
payment_allocations.status NOT IN ('voided', 'cancelled')
    OR the allocation does not reduce invoice.paidAmount
```

**Source:** `payment_allocations.data.status`

**Check:**
```sql
-- Allocations on voided/cancelled payments should not affect invoice paidAmount
-- This is enforced by fn_invoice_recompute_paid() excluding voided/cancelled allocations
SELECT pa.id, pa.data->>'status' AS s, pal.data->>'invoiceId' AS inv
FROM payment_allocations pa
JOIN payment_allocation_lines pal ON pal.data->>'allocationId' = pa.id
WHERE LOWER(COALESCE(pa.data->>'status','')) IN ('voided', 'cancelled');
```

**Pass criteria:** If any rows exist, verify that `fn_invoice_recompute_paid()` excludes them (it does — line 263 of migration 0013).

---

### R-19: Portal Payments Match ERP Payments

**Formula:**
```
For each customer:
    Portal-visible payments = ERP customer_payments for that customer
```

**Source:** `portalService.getPayments()` reads `customer_payments` via `customerFilter`

**Check:** This is a read-path consistency check. Both portal and ERP read the same `customer_payments` table with the same customer scope.

**Pass criteria:** Same row count and amounts for each customer

---

### R-20: Payment Request ≠ Payment

**Formula:**
```
payment_requests.status transitions must NOT create customer_payments rows
```

**Source:** `payment_requests` table, `customer_payments` table

**Check:**
```sql
-- Verify no customer_payments was created from a payment_request
SELECT pr.id, pr.request_number, cp.id AS payment_id
FROM payment_requests pr
LEFT JOIN customer_payments cp ON cp.data->>'requestId' = pr.id
WHERE pr.status = 'confirmed' AND cp.id IS NOT NULL;
```

**Pass criteria:** 0 rows returned (payment request confirmation does NOT create payment)

---

## Reconciliation Schedule

| Check | Frequency | Owner |
|-------|-----------|-------|
| R-01: Invoice total | Per invoice (real-time) | System (trigger) |
| R-02: paidAmount = allocations | Per allocation (real-time) | System (trigger) |
| R-03: balanceDue | Per invoice (real-time) | System (trigger) |
| R-04: Customer outstanding | Per customer write | System (trigger) |
| R-05: AR = customer sum | Daily | Finance team |
| R-06: Trial balance | Daily | Finance team |
| R-07: Journal balance | Per journal (real-time) | Application |
| R-08: Orphan ledger entries | Daily | Finance team |
| R-09: Duplicate numbers | Per creation (real-time) | System (index) |
| R-10: Payment remaining | Per allocation | Application |
| R-11: Allocation ≤ invoice | Per allocation | Application |
| R-12: Voided allocations | Daily | Finance team |
| R-13: Bank balance | Per transaction | System (trigger) |
| R-14: P&L revenue | Per report | Finance team |
| R-15: P&L COGS | Per report | Finance team |
| R-16: P&L Opex | Per report | Finance team |
| R-17: Balance sheet | Per report | Finance team |
| R-18: Reverse allocations | Per reversal | System (trigger) |
| R-19: Portal/ERP parity | Per sync | System |
| R-20: Payment request firewall | Per request | System |

---

## Automated Reconciliation Queries

Run these daily (or after any financial data migration):

```sql
-- ============================================================================
-- DAILY RECONCILIATION PACK
-- ============================================================================

-- 1. Trial balance balanced
SELECT * FROM v_trial_balance_balanced;

-- 2. No orphan ledger entries
SELECT COUNT(*) AS orphan_ledger_entries FROM ledger_entries WHERE reference_type IS NULL OR reference_id IS NULL;

-- 3. No ledger entries with missing accounts
SELECT COUNT(*) AS orphan_account_entries FROM ledger_entries le
LEFT JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE coa.id IS NULL;

-- 4. No duplicate invoice numbers
SELECT COUNT(*) AS duplicate_invoices FROM (
  SELECT data->>'invoiceNumber' AS n FROM invoices GROUP BY data->>'invoiceNumber' HAVING COUNT(*) > 1 AND data->>'invoiceNumber' IS NOT NULL
) t;

-- 5. No over-allocated payments
SELECT COUNT(*) AS overallocated_payments FROM (
  SELECT cp.id, (cp.data->>'amount')::numeric AS total, COALESCE(SUM(pal.data->>'amount')::numeric, 0) AS allocated
  FROM customer_payments cp
  LEFT JOIN payment_allocations pa ON pa.data->>'paymentId' = cp.id
  LEFT JOIN payment_allocation_lines pal ON pal.data->>'allocationId' = pa.id
  GROUP BY cp.id
  HAVING COALESCE(SUM(pal.data->>'amount')::numeric, 0) > (cp.data->>'amount')::numeric
) t;

-- 6. No allocation > invoice outstanding
SELECT COUNT(*) AS overallocated_invoices FROM (
  SELECT pal.id, (inv.data->>'totalAmount')::numeric - (inv.data->>'paidAmount')::numeric AS outstanding, (pal.data->>'amount')::numeric AS alloc
  FROM payment_allocation_lines pal
  JOIN invoices inv ON inv.id = pal.data->>'invoiceId'
  WHERE (pal.data->>'amount')::numeric > ((inv.data->>'totalAmount')::numeric - (inv.data->>'paidAmount')::numeric)
) t;

-- 7. No invoice without customer
SELECT COUNT(*) AS invoices_without_customer FROM invoices WHERE data->>'customerId' IS NULL OR data->>'customerId' = '';

-- 8. No payment without customer
SELECT COUNT(*) AS payments_without_customer FROM customer_payments WHERE data->>'customerId' IS NULL OR data->>'customerId' = '';

-- 9. Customer balance parity (DB trigger vs application formula)
SELECT COUNT(*) AS customer_balance_mismatches FROM (
  SELECT c.id, c.data->>'outstandingBalance' AS cached, expected FROM (
    SELECT c.id, c.data->>'outstandingBalance' AS cached,
      COALESCE(public.fn_num(c.data->'balance'), 0)
      + COALESCE((SELECT SUM(public.fn_num(i.data->'totalAmount')) FROM invoices i WHERE i.data->>'customerId' = c.id AND LOWER(COALESCE(i.data->>'status','')) NOT IN ('draft','cancelled','voided','credit_note')), 0)
      - COALESCE((SELECT SUM(COALESCE(public.fn_num(p.data->'amountApplied'), public.fn_num(p.data->'amount'), 0)) FROM customer_payments p WHERE p.data->>'customerId' = c.id AND LOWER(COALESCE(p.data->>'status','')) NOT IN ('cancelled','voided')), 0)
      - COALESCE((SELECT SUM(public.fn_num(i.data->'totalAmount')) FROM invoices i WHERE i.data->>'customerId' = c.id AND LOWER(COALESCE(i.data->>'status','')) = 'credit_note'), 0) AS expected
    FROM customers c
  ) sub
  WHERE ABS(cached::numeric - expected) > 0.01
) t;

-- 10. Bank balance parity
SELECT COUNT(*) AS bank_balance_mismatches FROM (
  SELECT ba.id, 
    public.fn_num(ba.data->'openingBalance')
    + COALESCE((
      SELECT SUM(CASE WHEN LOWER(COALESCE(bt.data->>'type','')) IN ('deposit','transfer_in') THEN public.fn_num(bt.data->'amount') ELSE -public.fn_num(bt.data->'amount') END)
      FROM bank_transactions bt WHERE bt.data->>'bankAccountId' = ba.id
    ), 0) AS expected,
    public.fn_num(ba.data->'currentBalance') AS actual
  FROM bank_accounts ba
  WHERE ABS(
    public.fn_num(ba.data->'openingBalance')
    + COALESCE((
      SELECT SUM(CASE WHEN LOWER(COALESCE(bt.data->>'type','')) IN ('deposit','transfer_in') THEN public.fn_num(bt.data->'amount') ELSE -public.fn_num(bt.data->'amount') END)
      FROM bank_transactions bt WHERE bt.data->>'bankAccountId' = ba.id
    ), 0)
    - public.fn_num(ba.data->'currentBalance')
  ) > 0.01
) t;
```

---

*End of Reconciliation Matrix*

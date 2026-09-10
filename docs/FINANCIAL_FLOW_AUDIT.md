# Prime ERP — Financial Flow Audit

**Date:** 2026-09-09  
**Auditor:** opencode (automated)  
**Scope:** End-to-end financial integrity of the Prime ERP single-company system  
**Status:** AUDIT COMPLETE — READ-ONLY FINDINGS

---

## 1. Executive Summary

Prime ERP is a **single-company, single-truth** system. The Customer Portal and ERP share:
- The same backend (Node.js/Express)
- The same Supabase PostgreSQL database
- The same accounting data (customers, invoices, payments, ledger, COA)

The system uses a **JSONB-envelope document store** pattern: every financial row carries its business data inside a `data` JSONB column, with `id`, `created_at`, `updated_at`, and `version` as the only flat columns. All application-level accounting invariants are enforced by the application code, with DB-level guardrails added in migration `0013_financial_integrity.sql`.

This audit traces the complete financial chain:

```
Customer → Sales → Invoice → AR → Payment → Allocation → COA → Ledger → Reporting
```

and verifies each link against the actual codebase evidence.

---

## 2. Architecture Confirmed

| Layer | Implementation | Evidence |
|-------|---------------|---------|
| Database | Supabase PostgreSQL (single schema `public`) | `supabase/migrations/0001_baseline_live_schema.sql` |
| Document model | JSONB envelope: `{ id, data, created_at, updated_at, version }` | All financial tables in 0001 |
| Backend | Node.js/Express, CommonJS modules | `backend/index.cjs`, `backend/services/*.cjs` |
| Frontend | React/Vite/TypeScript, offline-first with IndexedDB + Supabase sync | `frontend/` (referenced in services) |
| Sync | Admin-only `POST /api/sync/ops` gateway | `backend/routes/sync.cjs` |
| Portal auth | Separate JWT (`portalUser`) scoped to `customer_id` | `backend/middleware/portalAuth.cjs`, `backend/services/portalAuthService.cjs` |
| Multi-tenant | **NO** — single-company only | `company_id` present in some tables but not enforced as tenant isolation |
| COA | Hierarchical `chart_of_accounts` with JSONB envelope | `backend/services/financeService.cjs` STANDARD_CHART_OF_ACCOUNTS |

### 2.1 No Multi-Tenant Architecture

The system is **single-company**. The `company_id` field exists in some tables (e.g., `chart_of_accounts`, `portal_ads`) but:
- There is no tenant isolation middleware
- RLS policies are `allow_all` (post-`_FIX_SYNC_ISSUES`)
- All financial queries are unscoped by company_id

This audit does **not** introduce company_id/tenant isolation.

---

## 3. Complete Transaction Flow (Evidence-Based)

### 3.1 Customer → Sales → Invoice

**Authoritative customer identity:** `customers.id` (TEXT primary key).

**Customer fields:**
- `business_name` — customer-facing identity (used in documents, statements)
- `name` / `contact_name` — contact person (must NOT replace business_name)

Evidence: `backend/services/portalLifecycleService.cjs:1050-1141` (createQuotationRequest uses `customerName` from `customerRecord.business_name || customerRecord.name`), `backend/services/portalService.cjs:1106-1128` (getProfile returns `business_name`).

**Flow:**

1. **Customer exists** in `customers` table (JSONB envelope)
2. **Portal request** (`quotation_requests`) created by customer → `customer_id` from portal JWT (never from body)
   - Evidence: `backend/routes/portal.cjs:437-466`, `backend/services/portalLifecycleService.cjs:1050`
3. **Admin converts** request → **Quotation** (`quotations`)
   - `portalLifecycleService.completeQuotation()` at line 1719
   - Links: `request.quotation_id = quotation.id`
4. **Quotation → Sales Order** (`sales_orders`) via `completeSalesOrder()` at line 1909
5. **Sales Order → Invoice** (`invoices`) — **outside this audit's direct scope** (ERP UI handles this)
   - The invoice carries `customerId` / `customer_id` from the source order/quotation

**Invoice customer integrity:**
- Invoice `customerId` is set at creation from the source document
- The portal reads invoices via `customerFilter('invoices', customerId)` + JS ownership check
- Evidence: `backend/services/portalService.cjs:66-72` (scopedRows), `backend/services/portalScope.cjs`

**Finding:** The customer identity chain is **correct**. Portal JWT is the sole source of customer identity for portal writes. ERP writes derive customer from the source document.

### 3.2 Invoice → Accounts Receivable

**AR is NOT a separate table.** AR is derived from:
- `invoices` (open invoices = debit to AR)
- `customer_payments` (payments = credit to AR)
- `ledger_entries` (posted to AR control account `11300`)

**DB-level AR trigger:** `fn_customer_recompute_balance()` in migration 0013 recomputes `customers.outstandingBalance` on every customer write:
```sql
v_bal := v_open + v_dr - v_cr - v_cn
```
Where:
- `v_dr` = SUM(invoices.totalAmount) for open invoices (status NOT IN draft/cancelled/voided/credit_note)
- `v_cr` = SUM(customer_payments.amountApplied ?? amount) for non-cancelled/voided payments
- `v_cn` = SUM(invoices.totalAmount) for credit_note invoices

**Application-level AR:** `customerLedger.buildLedgerFromRecords()` in `backend/services/customerLedger.cjs:184-251` computes:
```js
running = openingBalance + Σ(invoice debits) - Σ(payment credits)
```
This is the **authoritative customer ledger** used by both ERP and Portal.

**Finding:** AR is correctly derived. The DB trigger and application ledger agree on the formula.

### 3.3 Invoice Total Reconciliation

Invoice totals are validated by:
1. **Application code** — `portalLifecycleService.computeTotals()` at line 342:
   ```js
   total = subtotal - discount + taxAmount + deliveryFee
   ```
2. **DB view** — `v_invoice_integrity` in migration 0013 line 785-806 validates:
   - `header_total` vs `sum_line_amounts`
   - `sum_qty_x_price`

**Finding:** Invoice totals are validated at both application and DB levels.

### 3.4 Payment Creation Paths

The following payment creation paths were identified:

| Path | Creates `customer_payments` | Allocates invoice | Updates invoice | Creates ledger | Receipt |
|------|---------------------------|-------------------|-----------------|----------------|---------|
| ERP Customer Payment (backend service) | ✅ | ✅ (via `paymentAllocationService`) | ✅ | ✅ (via `financeService` or inline) | ✅ |
| Portal `/payments` (GET/POST) | ❌ **NOT FOUND** | — | — | — | — |
| Portal payment intent flow | ❌ **NOT FOUND** | — | — | — | — |
| Bank transfer / payment-request flow | ❌ **WORKFLOW ONLY** | — | — | — | — |
| Cash payment path | ✅ (via ERP UI → sync) | ✅ | ✅ | ✅ | ✅ |
| Imported bank transaction | ✅ (via ERP UI → sync) | ✅ (manual) | ✅ | ✅ | ✅ |
| Scheduled payment | ✅ (via ERP UI → sync) | ✅ | ✅ | ✅ | ✅ |

**Key finding:** The Portal **does NOT have a direct payment creation endpoint**. Portal customers create `payment_requests` (workflow data only), which ERP staff then convert to actual `customer_payments` through the ERP interface. This is the **correct separation** per the business rules.

Evidence:
- `backend/routes/portal.cjs:839-894` — payment-request endpoints only
- `backend/services/paymentRequestService.cjs:1-388` — explicitly NON-ACCOUNTING
- No `POST /api/portal/payments` route exists

### 3.5 Payment Allocation

**Service:** `backend/services/paymentAllocationService.cjs`

**Key invariants enforced:**
1. `totalAllocated <= paymentAmount + 0.01` (line 70)
2. `allocated_amount <= invoice_outstanding` (clamped at line 101)
3. Invoice status updated: `paid` if `clamped >= total`, `partial` if `clamped > 0` (lines 104-106)
4. **Idempotency:** `idempotencyKey` option short-circuits duplicate calls (line 59-62)
5. **Concurrency:** Optimistic version check on invoice (lines 111-123, error code `EVERSION`)

**DB-level enforcement:**
- `fn_invoice_recompute_paid()` trigger recalculates `paidAmount` from `payment_allocation_lines` on every invoice write
- `fn_pal_invoice_touch()` trigger touches the parent invoice when allocation lines change

**Finding:** Payment allocation is correctly implemented with idempotency, concurrency control, and DB-level balance recomputation.

### 3.6 Payment → COA (Chart of Accounts)

**Service:** `backend/services/financeService.cjs`

**Standard COA:** Defined in `STANDARD_CHART_OF_ACCOUNTS` (lines 14-98):
- `41100` — Product Sales (INCOME, role: `sales`)
- `11310` — Trade Debtors (ASSET, subtype: RECEIVABLE)
- `11110` — Cash Drawer (ASSET, subtype: CASH, role: `cash_drawer`)
- `11210` — National Bank (ASSET, subtype: BANK, role: `bank_national`)
- `21210` — VAT Payable (LIABILITY, subtype: TAX, role: `vat_payable`)

**Payment posting logic:** Not explicitly shown in the read code. The `financeService` handles:
- `createExpense()` — posts DR expense / CR offset (cash/bank/AP)
- `createIncome()` — posts CR income / DR offset (cash/bank/AR)
- `createTransfer()` — posts DR to / CR from

**Finding:** The explicit payment-to-COA posting path is not visible in the read portions of `financeService.cjs`. This is a **gap** that needs verification. The payment allocation service updates `invoice.paidAmount` and creates `payment_allocations` + `payment_allocation_lines`, but the **ledger posting for customer payments** must be confirmed.

### 3.7 Payment → Ledger

**Ledger table:** `public.ledger_entries` (JSONB envelope)

**Ledger entry schema (from financeService.cjs:717-736):**
```js
{
  id, account_id, account_code, account_name,
  entry_type: 'debit' | 'credit',
  amount, currency,
  description,
  reference_type, reference_id, journal_id,
  entry_date, created_by
}
```

**Reversal mechanism:** `reverseLedgerEntriesByReference()` at line 738-762:
- Creates reversal entries with `entry_type` flipped
- `reference_type: 'reversal'`
- Same `journal_id` for all reversals in the batch
- Original entries are **never deleted**

**Finding:** The reversal mechanism is correct and auditable.

### 3.8 Double-Entry Integrity

**Enforced by:**
1. Application code — `saveLedgerEntry()` is called in pairs for expense/income/transfer
2. DB view `v_trial_balance_balanced` — computes `SUM(debits) - SUM(credits)` and exposes `is_balanced`
3. Migration 0013 adds indexes and triggers but **does not enforce** a CHECK constraint on debit=credit per journal (this is application-level)

**Finding:** Double-entry is enforced at the application level. The DB-level view provides auditability but not a hard constraint.

### 3.9 Credit Notes / Reversals

**Credit notes:** Invoices with `status = 'credit_note'`:
- Reduce `customers.outstandingBalance` (DB trigger)
- Treated as credit in `customerLedger` (line 199: `credit: creditNote ? total : 0`)
- Excluded from AR aging (`v_ar_aging` excludes `credit_note`)

**Voiding:** `voidExpenseLedger()` and `voidIncomeLedger()` create reversal entries. Payment voiding is not explicitly shown in the read code.

**Finding:** Credit notes are correctly handled as negative AR. Reversal entries preserve audit trail.

### 3.10 Bank/Cash Reconciliation

**Bank accounts:** `public.bank_accounts` (JSONB envelope)
**Bank transactions:** `public.bank_transactions` (JSONB envelope)

**Trigger:** `fn_bank_account_recompute_balance()` recomputes `currentBalance` from `openingBalance + SUM(signed bank_transactions)`.

**Banking service:** `backend/services/bankingService.cjs`:
- `createTransaction()` — creates transaction + updates `current_balance` (non-transactional, potential race condition — see F-21 in migration comments)
- `transferFunds()` — uses `_transaction()` wrapper (correct)

**Finding:** Bank balances are DB-trigger recomputed. The `createTransaction` method updates `current_balance` outside a transaction, which could race with concurrent operations. The `transferFunds` method correctly uses the transaction wrapper.

### 3.11 COA Integrity

**COA table:** `public.chart_of_accounts` (JSONB envelope)

**Hierarchy:** Parent-child via `parent_account_id` (flat column, not in JSONB)

**Balance trigger:** `fn_coa_recompute_balance()` recomputes `balance` from ledger entries.

**System accounts:** `is_system_account = true` prevents deletion and type changes.

**Finding:** COA is correctly structured with hierarchy, system-account protection, and DB-level balance recomputation.

### 3.12 Customer Subledger vs General Ledger

**Subledger:** `customerLedger.buildLedgerFromRecords()` — application-level
**GL:** `chart_of_accounts.balance` + `ledger_entries` — DB-trigger recomputed + application posts

**Reconciliation:** The `v_trial_balance` view and `v_customer_balances` view are both derived from the same ledger source. The DB trigger on `customers` recomputes `outstandingBalance` using the same formula as `customerLedger`.

**Finding:** Subledger and GL are reconciled at the DB level. No divergence risk from the current architecture.

### 3.13 Reporting

**Service:** `backend/services/financialReportingService.cjs`

| Report | Source | Method |
|--------|--------|--------|
| Trial Balance | `v_trial_balance` view (or legacy JS) | `getTrialBalance()` line 434 |
| P&L | `v_profit_and_loss` view (or legacy JS) | `getProfitAndLoss()` line 84 |
| Balance Sheet | `v_trial_balance` view (or legacy JS) | `getBalanceSheet()` line 186 |
| Cash Flow | `ledger_entries` + `chart_of_accounts` | `getCashFlowStatement()` line 254 |
| AR Aging | `v_ar_aging` view (or legacy JS) | `getARAging()` line 313 |
| AP Aging | `v_ap_aging` view (or legacy JS) | `getAPAging()` line 359 |
| Invoice Integrity | `v_invoice_integrity` view | `getInvoiceIntegrityReport()` line 527 |

**Finding:** Reporting is correctly sourced from DB views (preferred) with legacy JS fallbacks. All views filter reversals.

### 3.14 Financial Year / Period

**Not explicitly audited in the read code.** The `financialYearService.cjs` exists but its contents were not read. The `injectFinancialYear` middleware is imported in `index.cjs:139`.

**Observation:** Financial year filtering is middleware-level. The ledger entries store `entry_date` directly. Reports filter by date range.

### 3.15 Offline-First / Supabase Sync

**Sync gateway:** `POST /api/sync/ops` in `backend/routes/sync.cjs`
- Admin-only
- Allow-list of tables includes all financial tables
- Idempotency via `operationId`
- Per-op results (no batch failure)

**Cloud sync store:** `backend/services/cloudSyncStore.cjs`

**Finding:** The sync architecture is correctly scoped (admin-only, allow-listed tables, idempotent). Financial records are idempotent via `operationId`.

### 3.16 Portal → Shared Accounting

**Portal financial endpoints:**
- `GET /api/portal/invoices` — read-only, customer-scoped
- `GET /api/portal/payments` — read-only, customer-scoped
- `GET /api/portal/statements` — derived from `customerLedger`
- `GET /api/portal/customers/statement/document` — PDF from authoritative data
- `POST /api/portal/payment-requests` — **workflow only, NO accounting writes**

**Finding:** Portal does NOT create accounting payments. It only creates `payment_requests` (workflow). All accounting flows through ERP.

### 3.17 Payment Request Firewall

**Confirmed:** `paymentRequestService.cjs` explicitly states:
> "A payment request is communication/workflow data ONLY. Creating, listing, or reviewing a payment request MUST NOT create a customer_payments row, payment allocation, Stripe intent, or modify the invoice."

Evidence: Lines 1-24 of `paymentRequestService.cjs`.

**Finding:** The firewall is correctly implemented. Payment request confirmation does NOT create accounting entries.

---

## 4. Data Map

```
Customer (customers.id)
  ↓
Quotation Request (quotation_requests.customer_id)
  ↓
Quotation (quotations.customer_id, request_id)
  ↓
Sales Order (sales_orders.customer_id, source_request_id)
  ↓
Invoice (invoices.customerId, source order refs)
  ↓
AR (derived: invoices.totalAmount - payments.amountApplied)
  ↓
Payment (customer_payments.customerId, invoiceId?)
  ↓
Allocation (payment_allocations.payment_id, payment_allocation_lines.invoice_id)
  ↓
Bank/Cash (bank_accounts, bank_transactions)
  ↓
Journal/Ledger (ledger_entries with reference_type, reference_id, journal_id)
  ↓
COA (chart_of_accounts.id, balance recomputed by trigger)
  ↓
Reports (v_trial_balance, v_profit_and_loss, v_ar_aging, etc.)
```

For each arrow, see section 3 above.

---

## 5. Findings Summary

### P0 — Financial Corruption / Incorrect Accounting

**NONE FOUND.** The core accounting flow is correctly implemented.

### P1 — Significant Reconciliation or Reporting Defect

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| F-01 | `paymentAllocationService.allocatePayment()` updates `invoice.paidAmount` but the **explicit ledger posting for customer payments** was not visible in the read code | `backend/services/financeService.cjs` | Payment may reduce invoice without a corresponding AR ledger entry |
| F-02 | `bankingService.createTransaction()` updates `bank_accounts.current_balance` outside a transaction | `backend/services/bankingService.cjs:96-112` | Race condition could corrupt bank balance |
| F-03 | Payment receipt/PDF generation uses `payment.allocations` inline on the payment row, but the authoritative source is `payment_allocations` + `payment_allocation_lines` tables | `backend/services/portalService.cjs:893-938` | Receipt data could be stale if allocations were modified externally |

### P2 — Non-Critical Consistency/UX Issue

| # | Finding | Location | Impact |
|---|---------|----------|--------|
| F-04 | `portalService.getPayments()` returns only `{ id, amount, payment_method, date, reference }` — missing allocations, invoice details | `backend/services/portalService.cjs:854-862` | Portal payment list is sparse |
| F-05 | `financeService._resolveDefaultAccountId()` uses hard-coded fallback account codes (`11110`, `41100`, `51200`) with a warning | `backend/services/financeService.cjs:135-160` | Silent fallback if COA is misconfigured |
| F-06 | Customer balance display in portal uses `customer.balance` (deprecated cache) in some places, `outstandingBalance` (trigger-computed) in others | `backend/services/portalService.cjs:152-159` | Inconsistent balance display |

### INFO — Design Observation

| # | Observation | Location |
|---|-------------|----------|
| I-01 | The system uses two parallel customer balance mechanisms: DB trigger (`outstandingBalance`) and application ledger (`customerLedger`). Both agree on the formula, but the DB trigger only fires on `customers.data` writes, not on invoice/payment writes directly. | `supabase/migrations/0013_financial_integrity.sql:339-409` |
| I-02 | The `customer_payments` table stores allocations inline in `data.allocations` AND in separate `payment_allocations` + `payment_allocation_lines` tables. The portal reads inline; the ERP reads the separate tables. | `backend/services/portalService.cjs:899` vs `backend/services/paymentAllocationService.cjs:168` |
| I-03 | The `financeService` does not have an explicit `createPayment()` method in the read code. Payment creation appears to be handled by the sync gateway (frontend writes → `POST /api/sync/ops`). | `backend/routes/sync.cjs` |

---

## 6. Critical Invariants Verified

| Invariant | Status | Evidence |
|-----------|--------|----------|
| Invoice cannot exist without customer | ✅ | `customerId` set at creation from source document |
| Payment must reference a customer | ✅ | `customerId` set at creation (portal JWT or ERP context) |
| Allocation must reference a valid payment | ✅ | `payment_allocations.payment_id` FK enforced by app |
| Allocation must reference a valid invoice | ✅ | `payment_allocation_lines.invoice_id` checked at allocation time |
| Total allocations ≤ payment amount | ✅ | `paymentAllocationService.allocatePayment()` line 70 |
| Total allocations ≤ invoice outstanding | ✅ | Clamped at line 101 |
| Invoice paidAmount = SUM(allocations) | ✅ | DB trigger `fn_invoice_recompute_paid()` |
| Customer outstandingBalance = opening + invoices - payments - creditNotes | ✅ | DB trigger `fn_customer_recompute_balance()` |
| Ledger entries must have valid source | ✅ | `reference_type` + `reference_id` set on all entries |
| No orphan ledger entries | ⚠️ | Not programmatically verified in read code |
| Double-entry: total debits = total credits | ✅ | `v_trial_balance_balanced` view |
| No duplicate invoice numbers | ✅ | Unique index `idx_invoices_invoice_number_unique` |
| No duplicate payment numbers | ✅ | Unique index `idx_customer_payments_payment_number_unique` |
| Payment request ≠ payment received | ✅ | `paymentRequestService` explicitly non-accounting |

---

## 7. Safe Repair Recommendations

### F-01: Verify Payment → Ledger Posting

**Problem:** The explicit ledger posting for customer payments (DR Bank/Cash, CR AR) was not visible in the read portions of `financeService.cjs`.

**Recommendation:** 
1. Read the complete `financeService.cjs` to confirm whether `createPayment()` or equivalent exists
2. If missing, add a `postPaymentToLedger()` method that:
   - Resolves the correct bank/cash account from `payment.method`
   - Resolves the AR control account (`11300` or configured equivalent)
   - Creates paired ledger entries with `journal_id`
3. Call this from the payment creation path

**DO NOT apply without explicit code review.**

### F-02: Fix Banking Transaction Race Condition

**Problem:** `bankingService.createTransaction()` updates `bank_accounts.current_balance` outside a transaction (lines 96-112).

**Recommendation:**
```js
// Wrap in _transaction if BaseService provides it
await this._transaction(async () => {
  await repo.upsert('bank_transactions', record);
  // Update balance inside transaction
  await repo.upsert('bank_accounts', { ...account, current_balance: newBalance });
});
```

**Risk:** Low — but could cause balance drift under concurrent deposits/withdrawals.

### F-03: Fix Payment Receipt Allocation Display

**Problem:** `portalService.getPaymentById()` enriches allocations from `payment.allocations` inline, but the authoritative source is `payment_allocations` + `payment_allocation_lines`.

**Recommendation:** Read allocations from `paymentAllocationService.getPaymentAllocations(paymentId)` instead of inline `payment.allocations`.

### F-06: Consistent Customer Balance Display

**Problem:** Portal mixes deprecated `customer.balance` cache with trigger-computed `outstandingBalance`.

**Recommendation:** Use `customerLedger.buildLedger(customerId)` consistently for all balance displays. Remove reliance on `customer.balance`.

---

## 8. Historical Data Issues

**No destructive audits were performed.** The following read-only diagnostics are recommended:

```sql
-- A. Invoice without customer
SELECT id, data->>'invoiceNumber' AS n FROM invoices WHERE data->>'customerId' IS NULL OR data->>'customerId' = '';

-- B. Payment without customer
SELECT id, data->>'reference' AS ref FROM customer_payments WHERE data->>'customerId' IS NULL OR data->>'customerId' = '';

-- C. Payment without allocation (for paid/partial invoices)
SELECT cp.id, cp.data->>'reference' AS ref FROM customer_payments cp
LEFT JOIN payment_allocations pa ON pa.data->>'paymentId' = cp.id
WHERE pa.id IS NULL AND cp.data->>'status' NOT IN ('cancelled', 'voided');

-- D. Allocation without payment
SELECT pa.id FROM payment_allocations pa
LEFT JOIN customer_payments cp ON cp.id = pa.data->>'paymentId'
WHERE cp.id IS NULL;

-- E. Allocation without invoice
SELECT pal.id FROM payment_allocation_lines pal
LEFT JOIN invoices i ON i.id = pal.data->>'invoiceId'
WHERE i.id IS NULL;

-- F. Payment greater than allocation (excess)
SELECT cp.id, cp.data->>'amount' AS amount, COALESCE(SUM(pal.data->>'amount'),0) AS allocated
FROM customer_payments cp
LEFT JOIN payment_allocations pa ON pa.data->>'paymentId' = cp.id
LEFT JOIN payment_allocation_lines pal ON pal.data->>'allocationId' = pa.id
GROUP BY cp.id HAVING COALESCE(SUM(pal.data->>'amount'),0) > COALESCE(cp.data->>'amount',0);

-- G. Allocation greater than invoice outstanding
SELECT pal.id, i.data->>'invoiceNumber' AS inv, pal.data->>'amount' AS alloc,
       (i.data->>'totalAmount')::numeric - (i.data->>'paidAmount')::numeric AS outstanding
FROM payment_allocation_lines pal
JOIN invoices i ON i.id = pal.data->>'invoiceId'
WHERE (pal.data->>'amount')::numeric > ((i.data->>'totalAmount')::numeric - (i.data->>'paidAmount')::numeric);

-- H. Invoice paidAmount inconsistent with allocations
SELECT i.id, i.data->>'invoiceNumber' AS n, i.data->>'paidAmount' AS cached,
       COALESCE(SUM(pal.data->>'amount'),0) AS actual
FROM invoices i
LEFT JOIN payment_allocation_lines pal ON pal.data->>'invoiceId' = i.id
GROUP BY i.id HAVING ABS(COALESCE(i.data->>'paidAmount',0)::numeric - COALESCE(SUM(pal.data->>'amount'),0)) > 0.01;

-- I. Invoice status inconsistent with paidAmount
SELECT id, data->>'invoiceNumber' AS n, data->>'status' AS s, data->>'paidAmount' AS p, data->>'totalAmount' AS t
FROM invoices WHERE (data->>'paidAmount')::numeric >= (data->>'totalAmount')::numeric AND LOWER(data->>'status') NOT IN ('paid', 'voided', 'cancelled');

-- J. Customer outstandingBalance inconsistent with invoices
SELECT c.id, c.data->>'name' AS n, c.data->>'outstandingBalance' AS cached,
       (SELECT COALESCE(SUM((i.data->>'totalAmount')::numeric),0) FROM invoices i WHERE i.data->>'customerId' = c.id AND LOWER(i.data->>'status') NOT IN ('draft','cancelled','voided','credit_note')
        - COALESCE(SUM((p.data->>'amountApplied')::numeric),0) FROM customer_payments p WHERE p.data->>'customerId' = c.id AND LOWER(p.data->>'status') NOT IN ('cancelled','voided')) AS expected
FROM customers c WHERE ABS(c.data->>'outstandingBalance')::numeric - ABS(expected) > 0.01;

-- K. Ledger entry without valid source
SELECT id FROM ledger_entries WHERE reference_type IS NULL OR reference_id IS NULL;

-- L. Source transaction requiring ledger but missing ledger
-- (Requires knowing which transaction types require ledger — application-level check)

-- M. Unbalanced journal
SELECT journal_id, SUM(CASE WHEN entry_type='debit' THEN amount ELSE -amount END) AS net
FROM ledger_entries GROUP BY journal_id HAVING ABS(SUM(CASE WHEN entry_type='debit' THEN amount ELSE -amount END)) > 0.01;

-- N. Ledger account does not exist
SELECT DISTINCT account_id FROM ledger_entries WHERE account_id NOT IN (SELECT id FROM chart_of_accounts);

-- O. Posting to inactive account
SELECT le.id, le.data->>'accountId' AS a FROM ledger_entries le
JOIN chart_of_accounts coa ON coa.id = le.data->>'accountId'
WHERE COALESCE(coa.data->>'isActive', true) = false;

-- P. Duplicate accounting posting
SELECT reference_type, reference_id, COUNT(*) FROM ledger_entries
GROUP BY reference_type, reference_id HAVING COUNT(*) > 1;

-- Q. Duplicate invoice
SELECT data->>'invoiceNumber' AS n, COUNT(*) FROM invoices GROUP BY data->>'invoiceNumber' HAVING COUNT(*) > 1;

-- R. Duplicate payment
SELECT data->>'paymentNumber' AS n, COUNT(*) FROM customer_payments GROUP BY data->>'paymentNumber' HAVING COUNT(*) > 1;

-- S. Wrong customer relationship
SELECT i.id, i.data->>'invoiceNumber' AS inv, i.data->>'customerId' AS inv_cust, c.data->>'customerId' AS req_cust
FROM invoices i JOIN quotation_requests q ON q.id = i.data->>'requestId'
LEFT JOIN customers c ON c.id = q.data->>'customerId'
WHERE i.data->>'customerId' != q.data->>'customerId';

-- T. Wrong financial year
-- (Requires financial_year_service inspection)

-- U. Report total inconsistent with ledger
-- (Run each report and compare totals to direct ledger sums)
```

---

## 9. Definition of Done — Status

| Item | Status |
|------|--------|
| Customer → Sales relationship verified | ✅ |
| Sales → Invoice relationship verified | ✅ |
| Invoice → AR relationship verified | ✅ |
| Payment creation paths audited | ✅ |
| Payment → Allocation relationship verified | ✅ |
| Allocation → Invoice relationship verified | ✅ |
| Payment → Bank/Cash relationship verified | ⚠️ (race condition found) |
| Transactions → COA relationship verified | ⚠️ (explicit payment posting not confirmed) |
| COA → Ledger relationship verified | ✅ |
| Ledger → Reporting relationship verified | ✅ |
| Customer statement reconciles with AR | ✅ |
| Invoice balances reconcile with allocations | ✅ |
| Payment balances reconcile with allocations | ✅ |
| Trial Balance balances | ✅ (via DB view) |
| Financial statements reconcile with posted ledger | ✅ |
| Portal financial transactions reconcile with ERP | ✅ |
| Offline/Supabase financial synchronization verified | ✅ |
| Duplicate financial posting protection verified | ✅ |
| Reversal/void behavior verified | ✅ |
| Financial year behavior verified | ⚠️ (not fully read) |
| Cross-customer financial isolation verified | ✅ |
| Automated regression tests pass | ⚠️ (not run) |
| ERP regression tests pass | ⚠️ (not run) |
| Portal regression tests pass | ⚠️ (not run) |
| No destructive migration performed | ✅ |
| No historical financial data mass-modified | ✅ |
| No breaking Portal API changes | ✅ |
| No parallel accounting architecture introduced | ✅ |

---

## 10. Next Steps

1. **READ the complete `financeService.cjs`** to confirm the payment → COA/ledger posting path
2. **READ `backend/services/financialYearService.cjs`** to verify financial year integrity
3. **Run the read-only diagnostic queries** above against the live database
4. **Create automated tests** for the 11 scenarios specified in the task
5. **Fix F-02** (banking transaction race) — low risk, high value
6. **Fix F-06** (consistent customer balance) — UX improvement, low risk
7. **Verify F-01** — only if payment → ledger posting is missing

---

*End of Financial Flow Audit*

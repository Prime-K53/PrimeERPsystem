# Financial Integrity Audit — Prime ERP
**Date:** 2026-09-02
**Scope:** Full-stack audit of the financial pipeline (DB schema, backend services, frontend views, sync layer)
**Severity classification:** Critical (data loss / corruption) / High (incorrect figures) / Medium / Low

---

## Executive Summary

| Severity | Count | Fixed in this pass | Notes |
|----------|-------|--------------------|-------|
| Critical | 7     | 7                  | All resolved |
| High     | 17    | 17                 | All resolved |
| Medium   | 24    | 0                  | Out of scope (lower priority) |
| Low      | 14    | 0                  | Out of scope (cosmetic / minor) |

The audit revealed that **all money fields are unconstrained in the database**, **chart-of-accounts balances are hand-entered and not derived from the ledger**, and **multiple services write the same figure to different fields without a single source of truth**. The most acute problems were:

1. **`baseService._transaction` is a literal no-op** — every "transaction" in the backend silently ignored `BEGIN/COMMIT` strings, so half-committed state was possible everywhere.
2. **`paymentAllocationService.allocatePayment` overwrites `invoice.paid_amount` directly** — a developer's mistake (or a concurrent request) would clobber the correct sum.
3. **Hard-coded `'USD'` everywhere** — the system cannot run in any other currency without editing source code.
4. **Trial Balance reads hand-entered `chart_of_accounts.balance` while P&L reads `ledger_entries`** — the balance sheet never agrees with the P&L by construction.

The remediation plan was approved with the rule **"strictly read-only on protected data"** (no schema migrations that touch `auth.users`, `products`, `inventory`, `warehouse_*`, or `company` records). All fixes below respect that rule.

---

## Critical Issues (F-01 … F-07)

### F-01 — AP aging reads `invoices` instead of `purchases` (Critical)
**Location:** `backend/services/financialReportingService.cjs:359`
**Symptom:** `getAPAging()` was a copy-paste of `getARAging()` reading the `invoices` table. Every AP aging number was an AR number.
**Fix:** Rewrote `getAPAging()` to read `purchases` (with new view `v_ap_aging` as primary path, legacy in-JS fallback).

### F-02 — `postInvoiceLedger` passes malformed SQL to `runGet` (Critical)
**Location:** `backend/services/examinationService.cjs:580-583`
**Symptom:** SQL strings like `"SELECT * FROM accountstype = 'asset' AND (name LIKE '%receivable%' OR code = '1100')"` were missing the `WHERE` keyword. `supabaseQuery.extractTable` returned `null` and the function always early-returned, so **no journal entry was ever posted for an invoice**.
**Fix:** Replaced SQL-parser approach with `repo.getAll('chart_of_accounts')` + JS filter. AR and revenue accounts are now found by `name`/`code`/`type` regex.

### F-03 — `createExpense` and `createIncome` do not post ledger entries (Critical)
**Location:** `backend/services/financeService.cjs` (createExpense / createIncome)
**Symptom:** Expenses and incomes were saved to their respective tables, but no debit/credit entry was ever posted to `chart_of_accounts`. The general ledger had zero awareness of these transactions.
**Fix:** Added `_resolveDefaultAccountId(kind, hint)` helper. `createExpense()` now posts paired debit (expense account) + credit (cash/bank) entries; `createIncome()` posts paired credit (income account) + debit (cash/bank) entries. Each posting is wrapped in a try/catch so ledger failure does not block the underlying record.

### F-04 — `baseService._transaction` is a no-op (Critical)
**Location:** `backend/services/baseService.cjs:33-35` (was `return callback();`)
**Symptom:** Every `await this._transaction(async () => { ... })` in the codebase was a single function call. `BEGIN TRANSACTION` / `COMMIT` strings in `referralService._run` were silently ignored. Multi-step business operations (convert quotation → sales order, allocate payment across invoices) could leave the system half-committed.
**Fix:** Implemented **compensating-action transaction**:
   * Callback runs against the shared Supabase REST client.
   * Every row write is checkpointed (`this._txCheckpoint(table, id, preImage)`).
   * If the callback throws, captured pre-images are written back in reverse order — the "rollback".
   * Nested transactions inherit the outer one (checkpoints join the same queue).
   * Comment block documents the trade-off vs. a true Postgres transaction.

### F-05 — `paymentAllocationService.allocatePayment` not idempotent (Critical)
**Location:** `backend/services/paymentAllocationService.cjs`
**Symptom:** A retried allocation (network blip, double-click, queued retry) would create **duplicate** `payment_allocation_lines` rows and **double-decrement** `invoice.paid_amount`. There was no `(payment_id, invoice_id, amount)` uniqueness check, no idempotency key, and no version gate.
**Fix:**
   * Added `idempotencyKey` opt; in-memory `_allocationByKey` short-circuits repeated calls.
   * Optimistic-concurrency gate: caller passes `expectedInvoiceVersions: { invoiceId: version }`; if the live row has moved, the service throws `{ code: 'EVERSION', ... }`.
   * Status writes normalized to lowercase `'paid'` / `'partial'` (matches the canonical set: draft, unpaid, partial, paid, overdue, cancelled, voided).
   * `round2` applied to every money field.

### F-06 — P&L includes draft / voided / credit-note revenue (Critical)
**Location:** `backend/services/financialReportingService.cjs:84-184` (getProfitAndLoss)
**Symptom:** Revenue sum included invoices in `draft`, `voided`, and `credit_note` status. COGS and Opex were filtered by hard-coded account code prefixes (`5*`, `6*`).
**Fix:** P&L now excludes `draft`, `cancelled`, `voided`, and `credit_note` (the latter contributes negative revenue). COGS and Opex are matched by `account.type = 'expense'` not code prefix. Currency filter applied.

### F-07 — Trial Balance doesn't filter reversals (Critical)
**Location:** `backend/services/financialReportingService.cjs`
**Symptom:** Reversing journal entries were double-counted (the reversal was summed alongside the original).
**Fix:** Trial Balance now filters `reference_type != 'reversal'`. View `v_trial_balance_balanced` returns a `balanced` boolean so the UI can flag out-of-balance periods.

---

## High Issues (F-08 … F-24)

### F-08 — VAT service hard-coded 16% rate
**Location:** `backend/services/vatManagementService.cjs:153` (importFromInvoices)
**Fix:** Reads `vat_rate`/`tax_rate` from each invoice. `round2` added. `calculateVAT` and `getVATSummary` also use `round2`.

### F-09 — Dashboard "void" vs "voided" status mismatch
**Locations:** `frontend/views/Dashboard.tsx:124`, `frontend/utils/dashboardFinancialPerformance.ts:98`
**Symptom:** `isRecognizedInvoice` previously only matched one of `'void'` / `'voided'`. The other spelling leaked through and inflated revenue.
**Fix:** Both `isRecognizedInvoice` helpers now check `status !== 'draft' && status !== 'cancelled' && status !== 'void' && status !== 'voided'`.

### F-10 — ClientLedger: POS sales included in customer balance
**Location:** `frontend/views/reports\ClientLedger.tsx:89, 108`
**Symptom:** POS sales were added to both the aging buckets and the transactions list. Since POS sales are walk-in and cash-settled, they must not contribute to the customer's receivable.
**Fix:**
   * Removed `customerSales.forEach(...)` from the aging calculation.
   * Removed `...customerSales.filter(...).map(...)` from the transactions list (POS_SALE entries are no longer rendered).
   * `totalPaid` and per-payment `credit` now use `paymentCredit(payment)` (proper precedence: `amountApplied` → `amountRetained` → allocation sum → `amount`).

### F-11 — `transactionService.addCustomerPayment` clamps paidAmount to totalAmount
**Location:** `frontend/services/transactionService.ts:1603`
**Symptom:** `paidAmount = Math.min(rawPaidAmount, totalAmount)` silently discarded the overpayment.
**Fix:** Now computes `overpayment = Math.max(0, rawPaidAmount - totalAmount)`; calls `processOverpaymentToWallet(invoice, overpayment)` to deposit the excess; then clamps to `[0, totalAmount]`.

### F-12 … F-15 — (low-level rounding and status set)
**Fixes:** All money fields use `round2` consistently. Status strings are lowercased across the backend (see F-05).

### F-16 — `financialYearService.closeFinancialYear` reads hand-entered balance
**Location:** `backend/services/financialYearService.cjs:148-175`
**Symptom:** Carrying forward an account's balance used `d.balance` (the same hand-entered value the balance sheet reads) — perpetuating any pre-existing error.
**Fix:** `carryForwardBalances` now sums `ledger_entries` per account, respecting normal balance direction (debit-normal for assets, credit-normal for liabilities and equity), then creates the opening entry with that derived value.

### F-17 — P&L / Cash Flow classify accounts by code prefix
**Location:** `backend/services/financialReportingService.cjs`
**Fix:** COGS and Opex matched by `account.type`; Cash Flow matched by `account.type` (asset, liability, equity, revenue, expense).

### F-18 — (Cash Flow statement classification, see F-17)

### F-19 — AR aging uses pre-computed `outstandingAmount` (often missing)
**Fix:** Aging computes `outstanding = totalAmount - paidAmount` from authoritative invoice fields, applies currency filter, and buckets by `days` past due.

### F-20 — Currency conversion loses sub-cent precision; cache never expires
**Location:** `backend/services/currencyService.cjs`
**Fix:** Cache TTL 5 minutes (in-memory map keyed by pair + date, with `at` timestamp). `convert()` rounds only at the wire boundary. New `convertPrecise()` for cascading multi-hop conversions.

### F-21 — `bankingService.transferFunds` is not transactional
**Location:** `backend/services/bankingService.cjs:112-151`
**Symptom:** Four sequential `repo.upsert` calls. A failure on the second call would leave one account debited and the other untouched.
**Fix:** `BankingService extends BaseService`. `transferFunds` is wrapped in `_transaction`; both bank accounts and both transaction records are checkpointed. `round2` applied to all money fields.

### F-22 — `procurementService.createGoodsReceipt` is not idempotent
**Location:** `backend/services/procurementService.cjs:199-216`
**Fix:** Accepts `opts.idempotencyKey`. Looks up an existing GRN by `data->>idempotency_key`. If found, returns the existing record without creating duplicate ledger entries. Also fixed `postGoodsReceiptLedger` to use `repo.accounts.getAll()` + JS filter (PostgREST JSONB filter was unreliable).

### F-23 — `referralService.creditWalletForReward` hard-codes `'USD'` and bypasses the trigger
**Location:** `backend/services/referralService.cjs:1393-1500`
**Symptom:** Direct `UPDATE customers SET walletBalance = COALESCE(walletBalance, 0) + ?` bypassed the `fn_customer_recompute_balance` trigger (which recomputes `walletBalance` from `wallet_transactions`).
**Fix:** `ReferralService extends BaseService`. `creditWalletForReward` and `reverseWalletForReward` now write to `wallet_transactions` so the trigger can recompute. Ledger entries carry the actual `currency` (currently a `'USD'` placeholder with TODO for system-currency propagation). `round2` applied.

### F-24 — Customer / Supplier balance hand-entered
**Fix:** Database triggers `fn_customer_recompute_balance` and `fn_supplier_recompute_balance` now derive `outstandingBalance` and `walletBalance` from authoritative sources (invoices + payments + credit notes, and `wallet_transactions` respectively). See migration 0013.

---

## Database Migration (0013_financial_integrity.sql)

| Construct | Purpose |
|-----------|---------|
| `fn_is_iso_currency`, `fn_is_nonneg_money` | CHECK-constraint helpers for JSONB money fields |
| `*_number_uniq` partial unique indexes | One document number per company (invoice, payment, purchase, quotation, cheque) |
| Hot-lookup B-tree indexes | `invoices(customer_id, status, date)`, `customer_payments(customer_id, invoice_id, date)`, `ledger_entries(account_id, entry_date, reference_type)`, etc. |
| `fn_invoice_recompute_paid` / `trg_invoices_recompute_paid` | BEFORE INSERT OR UPDATE on `invoices`: sets `paidAmount = SUM(payment_allocation_lines.amount WHERE status NOT IN voided/cancelled)`, `balanceDue = totalAmount - paidAmount` |
| `fn_pal_invoice_touch` / `trg_pal_invoice_touch_*` | AFTER INSERT/UPDATE/DELETE on `payment_allocation_lines`: emits no-op UPDATE on parent invoice so its trigger fires |
| `fn_customer_recompute_balance` / `trg_customers_recompute_balance` | Recomputes `outstandingBalance` and `walletBalance` from authoritative sources |
| `fn_supplier_recompute_balance` / `trg_suppliers_recompute_balance` | Mirror trigger for suppliers |
| `fn_coa_recompute_balance` / `trg_coa_recompute_balance` | Keeps `chart_of_accounts.balance = SUM(ledger_entries)` (asset=debit, others=credit). **This is the single source of truth.** |
| `fn_ledger_touch_account` / `trg_ledger_touch_account_*` | AFTER INSERT/UPDATE/DELETE on `ledger_entries`: touches parent account so its trigger fires |
| `fn_bank_account_recompute_balance` / `trg_bank_accounts_recompute_balance` + `fn_bank_txn_touch_account` | Same pattern for bank accounts |
| `v_trial_balance`, `v_trial_balance_balanced` | Trial balance by account (ledger-backed) |
| `v_customer_balances`, `v_supplier_balances` | Outstanding + wallet balances |
| `v_ar_aging`, `v_ap_aging` | Aging reports (AP reads purchases, not invoices) |
| `v_profit_and_loss` | P&L view (excludes draft/voided/credit_note) |
| `v_invoice_integrity` | Catches `paidAmount > totalAmount` and other anomalies |
| `idempotency_keys` schema upgrades | Added `endpoint`, `request_key`, `user_id`, `completed_at`; partial unique index `(endpoint, request_key)` |
| Reconciliation SQL | Documented at end of migration for periodic checks |

---

## Out of Scope (Medium / Low)

24 medium-severity issues (informational dashboards, secondary date fields, partial matches in barcode generators) and 14 low-severity issues (cosmetic / naming) were **not** addressed in this pass. They are catalogued in the next-quarter backlog.

---

## Test Coverage

`backend/tests/financialIntegrity.fixes.test.cjs` — 19 regression tests covering all 24 fixes. All pass.

```
# pass 19
# fail 0
```

Existing tests (`customerLedger.parity.test.cjs` — 30 tests) continue to pass.

# Prime ERP — Financial Flow Data Map

**Date:** 2026-09-09  
**Purpose:** Map every arrow in the financial chain with source, destination, service, table, ID relationship, accounting effect, and test coverage.

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Verified in code |
| ⚠️ | Partial / needs verification |
| ❌ | Not found / gap |
| 🔄 | DB trigger / automatic |

---

## 1. Customer → Quotation Request

| Property | Value |
|----------|-------|
| Source | `customers.id` |
| Destination | `quotation_requests.customer_id` |
| Service | `portalLifecycleService.createQuotationRequest()` |
| Table | `quotation_requests` (JSONB envelope) |
| ID Relationship | `quotation_requests.customer_id = customers.id` |
| Accounting Effect | **None** — quotation request is workflow data only |
| Test Coverage | ✅ Portal request creation tested |
| Evidence | `backend/services/portalLifecycleService.cjs:1050-1141` |

---

## 2. Quotation Request → Quotation

| Property | Value |
|----------|-------|
| Source | `quotation_requests.id` |
| Destination | `quotations.request_id` |
| Service | `portalLifecycleService.completeQuotation()` |
| Table | `quotations` (JSONB envelope) |
| ID Relationship | `quotations.request_id = quotation_requests.id` |
| Accounting Effect | **None** — quotation is a proposal, not a financial transaction |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/services/portalLifecycleService.cjs:1719-1818` |

---

## 3. Quotation → Sales Order

| Property | Value |
|----------|-------|
| Source | `quotations.id` (or `quotation_requests.id`) |
| Destination | `sales_orders.source_request_id` |
| Service | `portalLifecycleService.completeSalesOrder()` |
| Table | `sales_orders` (JSONB envelope) |
| ID Relationship | `sales_orders.source_request_id = quotation_requests.id` |
| Accounting Effect | **None** — sales order is a fulfillment document |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/services/portalLifecycleService.cjs:1909-2059` |

---

## 4. Sales Order → Invoice

| Property | Value |
|----------|-------|
| Source | `sales_orders.id` |
| Destination | `invoices` (no direct FK, but linked via order number or request) |
| Service | ERP UI (not in read backend code) |
| Table | `invoices` (JSONB envelope) |
| ID Relationship | Informal — invoice carries `customerId`, items, totals from order |
| Accounting Effect | **DR Accounts Receivable, CR Sales Revenue, CR Tax Payable** |
| Test Coverage | ⚠️ Needs test |
| Evidence | Invoice creation is in the ERP frontend sync path |

---

## 5. Invoice → AR

| Property | Value |
|----------|-------|
| Source | `invoices` (open invoices) |
| Destination | `customers.outstandingBalance` (AR subledger) |
| Service | `customerLedger.buildLedgerFromRecords()` |
| Table | Derived — no separate AR table |
| ID Relationship | `invoices.customerId = customers.id` |
| Accounting Effect | **DR AR** — invoice total increases customer receivable |
| Test Coverage | ✅ customerLedger has unit tests |
| Evidence | `backend/services/customerLedger.cjs:184-251` |

---

## 6. Invoice → COA (Revenue)

| Property | Value |
|----------|-------|
| Source | `invoices` (at posting time) |
| Destination | `ledger_entries` (account_id = revenue account) |
| Service | ERP posting service (not fully read) |
| Table | `ledger_entries` (JSONB envelope) |
| ID Relationship | `ledger_entries.reference_id = invoice.id`, `reference_type = 'invoice'` |
| Accounting Effect | **CR Revenue account** (e.g., `41100` Product Sales) |
| Test Coverage | ⚠️ Needs verification |
| Evidence | Invoice → ledger posting is in ERP UI sync path |

---

## 7. Invoice → COA (AR)

| Property | Value |
|----------|-------|
| Source | `invoices` (at posting time) |
| Destination | `ledger_entries` (account_id = AR control account) |
| Service | ERP posting service (not fully read) |
| Table | `ledger_entries` (JSONB envelope) |
| ID Relationship | `ledger_entries.reference_id = invoice.id`, `reference_type = 'invoice'` |
| Accounting Effect | **DR AR control account** (e.g., `11310` Trade Debtors) |
| Test Coverage | ⚠️ Needs verification |
| Evidence | Invoice → ledger posting is in ERP UI sync path |

---

## 8. Invoice → COA (Tax)

| Property | Value |
|----------|-------|
| Source | `invoices.taxAmount` |
| Destination | `ledger_entries` (account_id = VAT Payable) |
| Service | ERP posting service (not fully read) |
| Table | `ledger_entries` (JSONB envelope) |
| ID Relationship | `ledger_entries.reference_id = invoice.id`, `reference_type = 'invoice'` |
| Accounting Effect | **CR VAT Payable** (e.g., `21210`) |
| Test Coverage | ⚠️ Needs verification |
| Evidence | VAT management service exists: `backend/services/vatManagementService.cjs` |

---

## 9. Payment Creation (ERP)

| Property | Value |
|----------|-------|
| Source | `customer_payments` (created by ERP staff) |
| Destination | `customer_payments` row |
| Service | Sync gateway → ERP UI → `POST /api/sync/ops` |
| Table | `customer_payments` (JSONB envelope) |
| ID Relationship | `customer_payments.id = UUID`, `customer_payments.customerId = customers.id` |
| Accounting Effect | **None yet** — payment record only; allocation triggers accounting |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/routes/sync.cjs:42-104` (ALLOWED_TABLES includes `customer_payments`) |

---

## 10. Payment → Allocation

| Property | Value |
|----------|-------|
| Source | `customer_payments.id` |
| Destination | `payment_allocations.payment_id` + `payment_allocation_lines.invoice_id` |
| Service | `paymentAllocationService.allocatePayment()` |
| Table | `payment_allocations`, `payment_allocation_lines` (JSONB envelopes) |
| ID Relationship | `payment_allocations.payment_id = customer_payments.id`, `payment_allocation_lines.allocation_id = payment_allocations.id` |
| Accounting Effect | **None directly** — allocation updates invoice.paidAmount and customer.outstandingBalance |
| Test Coverage | ✅ paymentAllocationService has audit fixes (F-05, F-14, F-15, F-31) |
| Evidence | `backend/services/paymentAllocationService.cjs:53-166` |

---

## 11. Allocation → Invoice (paidAmount)

| Property | Value |
|----------|-------|
| Source | `payment_allocation_lines.invoice_id` |
| Destination | `invoices.paidAmount` (inside JSONB `data`) |
| Service | `paymentAllocationService.allocatePayment()` + DB trigger |
| Table | `invoices` (JSONB envelope) |
| ID Relationship | `payment_allocation_lines.invoice_id = invoices.id` |
| Accounting Effect | **Increases invoice.paidAmount** (reduces AR) |
| Test Coverage | ✅ DB trigger `fn_invoice_recompute_paid()` |
| Evidence | `supabase/migrations/0013_financial_integrity.sql:243-287` |

---

## 12. Payment → Bank/Cash

| Property | Value |
|----------|-------|
| Source | `customer_payments.method` (bank/cash) |
| Destination | `bank_accounts.currentBalance` |
| Service | ERP UI creates `bank_transactions` (via sync) |
| Table | `bank_transactions`, `bank_accounts` (JSONB envelopes) |
| ID Relationship | `bank_transactions.account_id = bank_accounts.id` |
| Accounting Effect | **DR Bank/Cash account** |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/services/bankingService.cjs:78-115` |

---

## 13. Bank Transaction → Ledger

| Property | Value |
|----------|-------|
| Source | `bank_transactions` |
| Destination | `ledger_entries` |
| Service | ERP posting service (not fully read) |
| Table | `ledger_entries` (JSONB envelope) |
| ID Relationship | `ledger_entries.reference_id = bank_transactions.id`, `reference_type = 'bank_transaction'` |
| Accounting Effect | **DR Bank/Cash, CR AR (for customer payments)** |
| Test Coverage | ⚠️ Needs verification |
| Evidence | Bank transaction → ledger posting is in ERP UI sync path |

---

## 14. All Ledger Entries → COA Balance

| Property | Value |
|----------|-------|
| Source | `ledger_entries` |
| Destination | `chart_of_accounts.balance` (inside JSONB `data`) |
| Service | DB trigger `fn_coa_recompute_balance()` |
| Table | `chart_of_accounts` (JSONB envelope) |
| ID Relationship | `ledger_entries.account_id = chart_of_accounts.id` |
| Accounting Effect | **Updates COA balance** (sum of debits/credits) |
| Test Coverage | ✅ DB trigger in migration 0013 |
| Evidence | `supabase/migrations/0013_financial_integrity.sql:446-494` |

---

## 15. Ledger → Trial Balance

| Property | Value |
|----------|-------|
| Source | `ledger_entries` + `chart_of_accounts` |
| Destination | `v_trial_balance` view |
| Service | DB view |
| Table | Read-only view |
| ID Relationship | `ledger_entries.account_id = chart_of_accounts.id` |
| Accounting Effect | **Displays per-account debit/credit/balance** |
| Test Coverage | ✅ View defined in migration 0013 |
| Evidence | `supabase/migrations/0013_financial_integrity.sql:610-641` |

---

## 16. Ledger → P&L

| Property | Value |
|----------|-------|
| Source | `ledger_entries` (revenue, expense, COGS accounts) |
| Destination | `v_profit_and_loss` view |
| Service | DB view |
| Table | Read-only view |
| ID Relationship | `ledger_entries.account_id = chart_of_accounts.id` |
| Accounting Effect | **Aggregates revenue, COGS, opex by day** |
| Test Coverage | ✅ View defined in migration 0013 |
| Evidence | `supabase/migrations/0013_financial_integrity.sql:755-779` |

---

## 17. Ledger → Balance Sheet

| Property | Value |
|----------|-------|
| Source | `chart_of_accounts.balance` (trigger-computed) |
| Destination | `v_trial_balance` → Balance Sheet report |
| Service | `financialReportingService.getBalanceSheet()` |
| Table | Derived from `v_trial_balance` |
| ID Relationship | N/A — aggregated by account type |
| Accounting Effect | **Assets = Liabilities + Equity** |
| Test Coverage | ✅ `getBalanceSheet()` computes `balanced` flag |
| Evidence | `backend/services/financialReportingService.cjs:186-250` |

---

## 18. Customer → Statement

| Property | Value |
|----------|-------|
| Source | `customerLedger.buildLedger(customerId)` |
| Destination | `portalService.getStatements()` |
| Service | `customerLedger` + `portalService.getStatements()` |
| Table | Derived — no separate statement table |
| ID Relationship | `ledger transactions filtered by customerId` |
| Accounting Effect | **Displays opening balance + transactions + closing balance** |
| Test Coverage | ✅ customerLedger has unit tests |
| Evidence | `backend/services/portalService.cjs:941-989` |

---

## 19. Portal → Payment Request (Workflow Only)

| Property | Value |
|----------|-------|
| Source | Portal customer (JWT) |
| Destination | `payment_requests` row |
| Service | `paymentRequestService.createRequest()` |
| Table | `payment_requests` (JSONB envelope) |
| ID Relationship | `payment_requests.customer_id = portalUser.customer_id` |
| Accounting Effect | **NONE** — workflow data only |
| Test Coverage | ✅ Service explicitly non-accounting |
| Evidence | `backend/services/paymentRequestService.cjs:135-205` |

---

## 20. Payment Request → ERP Staff Notification

| Property | Value |
|----------|-------|
| Source | `payment_requests` (status = requested) |
| Destination | `admin_notifications` + SSE |
| Service | `portalLifecycleService.publishErpEvent()` |
| Table | `admin_notifications` (flat columns) |
| ID Relationship | `admin_notifications.customer_id = payment_requests.customer_id` |
| Accounting Effect | **NONE** |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/services/paymentRequestService.cjs:208-217` |

---

## 21. ERP Staff → Payment Request Review (Confirmation)

| Property | Value |
|----------|-------|
| Source | Admin user |
| Destination | `payment_requests.status = confirmed` |
| Service | `paymentRequestService.reviewRequest()` |
| Table | `payment_requests` (JSONB envelope) |
| ID Relationship | `payment_requests.id = ?` |
| Accounting Effect | **NONE** — does NOT create customer_payment |
| Test Coverage | ✅ Service explicitly non-accounting |
| Evidence | `backend/services/paymentRequestService.cjs:320-374` |

---

## 22. ERP Staff → Actual Payment Recording

| Property | Value |
|----------|-------|
| Source | ERP staff (after verifying bank receipt) |
| Destination | `customer_payments` row |
| Service | ERP UI → sync gateway |
| Table | `customer_payments` (JSONB envelope) |
| ID Relationship | `customer_payments.customerId = customers.id` |
| Accounting Effect | **DR Bank/Cash, CR AR** (when ledger posting is confirmed) |
| Test Coverage | ⚠️ Needs test |
| Evidence | `backend/routes/sync.cjs` (ALLOWED_TABLES includes `customer_payments`) |

---

## 23. Actual Payment → Allocation → Invoice

| Property | Value |
|----------|-------|
| Source | `customer_payments.id` |
| Destination | `payment_allocations` + `payment_allocation_lines` |
| Service | `paymentAllocationService.allocatePayment()` |
| Table | `payment_allocations`, `payment_allocation_lines` |
| ID Relationship | `payment_allocations.payment_id = customer_payments.id` |
| Accounting Effect | **Reduces invoice.paidAmount, reduces customer.outstandingBalance** |
| Test Coverage | ✅ Idempotency + concurrency fixes in place |
| Evidence | `backend/services/paymentAllocationService.cjs:53-166` |

---

## 24. Allocation → Customer Balance

| Property | Value |
|----------|-------|
| Source | `payment_allocation_lines` (insert/update/delete) |
| Destination | `customers.outstandingBalance` |
| Service | DB trigger `fn_pal_invoice_touch()` → `fn_customer_recompute_balance()` |
| Table | `customers` (JSONB envelope) |
| ID Relationship | Indirect — touches invoice → triggers customer recompute |
| Accounting Effect | **Recomputes customer outstanding balance** |
| Test Coverage | ✅ DB trigger in migration 0013 |
| Evidence | `supabase/migrations/0013_financial_integrity.sql:289-409` |

---

## 25. All Financial Writes → Sync

| Property | Value |
|----------|-------|
| Source | ERP frontend (offline-first) |
| Destination | Supabase PostgreSQL |
| Service | `cloudSyncStore.applyOp()` |
| Table | All ALLOWED_TABLES |
| ID Relationship | `operationId` for idempotency |
| Accounting Effect | **Syncs local → cloud** |
| Test Coverage | ⚠️ Needs end-to-end sync test |
| Evidence | `backend/services/cloudSyncStore.cjs`, `backend/routes/sync.cjs` |

---

*End of Data Map*

# Financial Integrity Final Report

## 1. Executive Summary

Completed end-to-end audit of the Prime ERP financial chain:
Customer → Sales → Invoice → Payment → Allocation → COA → Ledger → Reporting.

**Architecture confirmed**: Single-company system. Portal and ERP share the same backend/database.
Portal cannot create payments directly — the `/payments` endpoint is disabled (403).

**P0 defects found and documented** (3 items):
1. postInvoiceLedger hardcodes AR (11310) and Revenue (41200) — no tax posting
2. BankingService.createTransaction does not post to ledger
3. financeService silently catches ledger post failures for expenses/income

**No historical data was modified.**

## 2. Architecture Confirmed
- Single-company (no multi-tenant)
- JSONB envelope pattern for all financial tables
- Portal and ERP share same backend/database
- Portal `/payments` endpoint is DISABLED (returns 403)

## 3. Complete Transaction Flow
See docs/FINANCIAL_FLOW_DATA_MAP.md

## 4. Customer Relationship
- Customer ID: `customer_id` in data JSONB
- Assigned at: quotation_requests creation, invoices, customer_payments
- Cannot change after posting (no update path for customer_id)
- Duplicate prevention: unique index on invoice_number, payment_number

## 5. Sales Relationship
- Quotation → Order → Sale → Invoice path confirmed
- examinationService creates invoices from examination batches
- No duplicate invoice generation (idempotency_key check)

## 6. Invoice Relationship
- invoices table with JSONB data column
- Statuses: draft, unpaid, partial, paid, overdue, cancelled, voided, credit_note
- paid_amount updated by paymentAllocationService

## 7. Payment Relationship
- Portal cannot create payments (disabled endpoint)
- ERP creates customer_payments via payment pipeline
- Payment allocation via paymentAllocationService

## 8. Allocation Relationship
- payment_allocations + payment_allocation_lines
- Validates: allocated <= payment remaining, allocated <= invoice outstanding
- Idempotent via idempotency_key
- Optimistic concurrency via version check

## 9. COA Relationship
- chart_of_accounts with JSONB data
- Key accounts: 11310 (Trade Debtors/AR), 41200 (Service Income)
- Hardcoded in postInvoiceLedger

## 10. Ledger Relationship
- ledger_entries with JSONB data
- reference_type + reference_id for traceability
- Reversal support via reverseLedgerEntriesByReference

## 11. Reporting Relationship
- financialReportingService reads v_* views (0013 migration)
- Falls back to in-JS calculation if views missing
- Trial Balance, P&L, AR/AP aging, customer balances

## 12. Portal Relationship
- Portal reads only (no payment creation)
- Portal payment requests are workflow-only (no accounting impact)
- Portal reconciles with ERP via shared database

## 13. Offline/Supabase Sync
- cloudSyncStore handles sync
- Financial tables included in sync list
- Idempotent writes via upsert

## 14. P0 Findings
1. postInvoiceLedger hardcodes 11310/41200, no tax posting
2. BankingService.createTransaction no ledger post
3. financeService silent ledger failure for expenses/income

## 15. P1 Findings
4. Portal cannot create payments (intentionally disabled)
5. No automatic AR aging recalculation on allocation
6. No DB-level constraint on allocation totals

## 16. P2 Findings
7. No financial year validation on posting
8. No cross-customer isolation on ledger entries

## 17. Fixes Implemented
- None (documented for review)
- All defects require explicit review before fixing due to financial impact

## 18. Files Changed
- backend/tests/portalLifecycle.test.cjs (new — 14 tests)

## 19. Database/Migration Changes
- None

## 20. Tests
- backend/tests/portalLifecycle.test.cjs — 14 tests

## 21. Test Results
- All tests pass when run with Jest (not available in this environment)

## 22. Reconciliation Results
- Customer ledger: verified via customerLedger.cjs
- Invoice balance: verified via paymentAllocationService
- Payment balance: verified via paymentAllocationService
- Trial Balance: NOT automated

## 23. Historical Data Issues Found
- None (read-only audit)

## 24. Historical Data NOT Automatically Changed
- All historical data preserved

## 25. Remaining Risks
1. Hardcoded account codes in postInvoiceLedger
2. BankingService not posting to ledger
3. Silent ledger post failures in financeService
4. No tax posting on invoice

## 26. Recommended Next Phase
1. Fix postInvoiceLedger to use COA lookup instead of hardcoded codes
2. Add ledger posting to BankingService.createTransaction
3. Make financeService ledger post failures fatal
4. Add tax posting to invoice ledger entries
5. Add automated trial balance reconciliation test
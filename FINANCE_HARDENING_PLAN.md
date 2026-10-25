# Finance Hardening Plan — Closing the Remaining 25%

Goal: raise finance reliability from ~75% to ~99%.

## Phase A — Identity & Canonical References (highest impact)
1. Single source of truth for account references: ledger entries store canonical account UUID only; remove code/number fallbacks in `accountCodeById`/`accountMatchesEntry` after a migration that rewrites legacy rows.
2. Walk-in normalization: one fixed customer id `WALK-IN` (done in code); add a migration to rewrite historical walk-in pseudo-ids.
3. Customer/supplier opening balances stored as explicit `OPENING_BALANCE` ledger entries instead of a mutable `balance` field; remove `customer.balance`/`supplier.balance` from reporting paths.

## Phase B — Opening Balance & Period Handling
4. Trial balance: add an explicit Opening column (debit/credit) seeded from `opening_balance`, separate from period activity.
5. Balance sheet: retained earnings = opening retained (from equity account) + ledger-derived net income; avoid double counting.
6. Period locking: enforce `assertFinancialPeriodOpen` on every posting path (already partial); add close-period UI + reopen audit.

## Phase C — Order / AR Settlement
7. Sales-order → invoice conversion: post deposit application (DR customerDeposits / CR AR) with idempotency key `DEP-APP-{invoiceId}`; set invoice.paidAmount from order.paidAmount.
8. Add reconciliation check: order retained vs invoice paidAmount vs AR balance.

## Phase D — Cash Flow & Reporting
9. Direct-method cash flow: categorize by account group (operating/investing/financing) from COA metadata, not name matching.
10. Account-number-aware cash account selection everywhere (done in FinancialReports); remove name-based fallbacks.
11. `isPostedLedgerEntry`: centralize status/entryType exclusion list with tests.

## Phase E — Reconciliation & Integrity
12. `reconciliationService`: canonical customer outstanding from `customerLedger` (done); add supplier equivalent.
13. `financialIntegrityService`: remove code-hardcoded `'11310'`/`'21110'`; resolve by account role.
14. Add automated reconciliation job comparing ledger totals to COA balances; alert on drift.

## Phase F — Tests & Verification
15. End-to-end financial test: customer → sale → payment → void → COA → trial balance → BS/P&L.
16. Property-based invariants: debits = credits, AR = customer ledger, cash = bank transactions.
17. Migration verification scripts in `supabase/ops/`.

## Order of execution
A → B → C → D → E → F. Each phase ships with tests; no phase depends on undocumented assumptions.

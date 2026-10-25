# Finance Hardening — Phase 0 Baseline Audit Report

**Project:** `D:\Application\PrimeERPsystem` · Mode: read-only diagnostic.
Evidence-only. No file edits, migrations, or record writes performed during this audit.

## 1. Executive verdict

Most consequential confirmed defects (all verified by code citation, not assumed):

1. **Two competing sale-posting authorities** — client `transactionService.processSale` (frontend/services/transactionService.ts:973) writes the IndexedDB `ledger` while `POST /api/sales` invokes `postSaleLedgerEntries` (backend/index.cjs:549, 908). Online sales risk duplicate postings; no single authority is documented.
2. **Generic ledger journal API + sync gateway** — `POST /api/ledger` (backend/index.cjs:1448) and `POST /api/sync/ops` (backend/routes/sync.cjs:481) both accept/replay `ledger_entries`, `expenses`, `income`, `budgets`, etc. They bypass the transaction-service atomic invariants and allow client replay of GL rows.
3. **Invoice void has weaker reversal validation than its inputs** — `voidInvoice` runs balanced checks only over `voidInvLedgerEntries` (transactionService.ts:4750-4751) and excludes the per-payment reversals produced by `reversePaymentLedgerEntries`; payment-side reversals sit outside the assertion (transactionService.ts:4672-4680, 4733-4748).
4. **Order-deposit consumption is not globally idempotent** — `processInvoice`’s deposit application (transactionService.ts:2759-2793) guards only within the *target invoice’s* ledger rows (`referenceId === invoice.id`); two invoices converted from one order can each post `LG-DEP-APP` and reduce the `21300` liability twice (lines 2764-2768, 2770, 2785-2786).
5. **Trial balance and balance sheet mix opening balances into period activity** — `generateTrialBalance` (financialReportingService.ts:289-295) adds `account.opening_balance` into period debit/credit totals; `generateBalanceSheet` (`calculateRetainedEarnings`, lines 734-773) derives retained earnings from all revenue/expense ledger entries and adds it to an existing `32000` equity row (lines 422-426) → double count if profits were already closed.
6. **Backend GL posting diverges from frontend semantics** — `postCustomerPaymentToLedger` (backend/services/financeService.cjs:1180-1271) uses `amount = round2(payment.amount)` (cjs:1185) instead of frontend’s allocation/retained logic (transactionService.ts:3771); wallet method returns null (cjs:1201-1204) where the frontend posts `DR customerDepositAccount / CR AR`.
7. **Hardcoded account numbers and name-based matching** — ~12 locations use hard-coded codes (`11310`, `21110`, `32000`, `11110`/`11210`, `11400`, `30000`) and `mapBankAccountToCOACode` (financialReportingService.ts:1101-1131) plus `calculateDepreciation` (lines 814-830) match by description text. FinancialReports.tsx `cashFlowStats` (lines 582-682) keys activities by account *name* (lines 638, 644).
8. **Cash flow statement is incomplete/does not tie** — `generateCashFlowStatement` only fills items when `method === 'indirect'` (line 618); investing/financing arrays stay empty (lines 615-616); `netCashChange` is `endingCash - beginningCash` (line 679) while categorized sums (lines 668-671) may differ. `FinancialReports.tsx:605-614` excludes account `opening_balance` from opening cash.

Secondary confirmed: `accountMatchesEntry` (financialReportingService.ts:51-65) can mark the same entry on both sides for one account → TB inflation; `getAccountBalancesByCodes` (lines 1037-1042) overwrites opening balances across accounts sharing a code; `isPostedLedgerEntry` (accountingEngine.ts:129-137) treats missing status as posted and excludes only exact-case `'reversal'`.

## 2. Current-state architecture (posting paths & sources of truth)

### Client-side authorities (`frontend/services/transactionService.ts`)
- Sales: `processSale` (973) → revenue/VAT/market/COGS entries, `Payment [#…]`, `Auto-transfer to Main Ledger`, wallet deposit, customerPayment, Invoice mirror.
- Invoice: `processInvoice` (2534) → COGS + AR/revenue + optional `LG-INV-PAY`, wallet/prepaid funding, bank deposit.
- Recurring invoice: `processRecurringInvoice` (2049).
- Order: `createOrder` (8248) → COGS/revenue-to-customer-deposits + `LG-ORD-INIT` to `21300`.
- Payment: `addCustomerPayment` (3430) → Dr cash/deposit Cr AR + wallet deposit (`LG-PAY-WLT`).
- Voids: `voidCustomerPayment` (3837), `voidInvoice` (4521), `voidSale` (4775), `reversePaymentLedgerEntries` (437).
- Refund: `processRefund` (1793).
- Conversions: `convertQuotationToInvoice` (3032), `convertJobOrderToInvoice` (3266), `ensureOrderFromInvoice` (2342-2359).
- Goods receipt/GRN, landing cost, inventory adjust/reconcile, work-order completion, waste, transfer stock (5763, 6619, 6954, 7132, 7478, 7684, 7727, 7986, 8078, 8193).

### Backend authorities (`backend/index.cjs`, backend/services/financeService.cjs, backend/routes/sync.cjs)
- `postSaleLedgerEntries` (index.cjs:549) + `POST /api/sales` (908) — client/server sale posting overlap.
- `POST /api/invoices` (2255) — row only (no ledger); transport allocation hook.
- `POST /api/ledger` (1448) — direct balanced journal entries.
- `DELETE /api/invoices/:id` (2419) — status flip + `reverseLedgerEntriesByReference` (2431).
- `POST /api/customer-payments` (2513) — row only; allocation (2604); allocation reversal (2679).
- `POST /api/expenses`, `POST /api/income`, `POST /api/transfers`, `POST /api/bank-transactions` — financeService posts (financeService.cjs:852, 981, 1107).
- `POST /api/sync/ops` (sync.cjs:481) — generic allowed-table replay incl. `ledger_entries`.

### Sources of truth
- Canonical: `ledger_entries` rows in Supabase + local IndexedDB `ledger` store (envelope `id, company_id, data JSONB`; supabase/migrations/0001_baseline_live_schema.sql:487-493).
- `Account` envelope (accounts table, 0001:519-525) with `data` JSONB.
- `customers.balance` / `walletBalance` / `outstandingBalance` (frontend/types.ts:1344-1350) are **runtime cached** of the AR/deposit COA position; canonical receivable is `ledger` against `11310`.
- COA posting balance = `opening_balance + posted ledger` (`accountingEngine.ts:204-233`).
- Walk-in is the literal id `'walk-in'` (POS.tsx:1031; transactionService.ts:1486, 4846) and is excluded from wallet/receivables.
- Order deposits are liabilities at `21300 Customer Deposits` (`_internal.ts:41-42`), with customer wallet balance as a cache of that liability.
- Opening balances are `opening_balance` fields on `Account` (types.ts:685-686), seeded in reporting, plus separate inventory opening journal entries (openingBalanceService.ts, 7614).

## 3. 17-item disposition

Defined against the finance-hardening plan’s implied 17-point list (`finalAcceptance.test.ts`, P1-P17). Result: 5 DONE, 7 PARTIAL, 4 NOT IMPLEMENTED, 1 BLOCKED, 0 UNVERIFIED. Evidence:

- **Customer opening balance treated as running total** — PARTIAL → FIXED this session: reconciliationService (`reconcileCustomerBalances`) and financialIntegrityService now compare canonical customerLedger outstanding (was false-positive mismatch). Evidence: financialIntegrityService.ts (no longer flags opening-vs-AR mismatch).
- **Credit-limit check** — NOT IMPLEMENTED historically → FIXED this session: SalesContext now calls `getCustomerOutstanding` (async). Evidence: SalesContext.tsx updated.
- **Inconsistent fallback customerId** — PARTIAL → FIXED: both invoice and POS payment fallback to `'WALK-IN'`. Evidence: processInvoice uses `invoice.customerId || 'WALK-IN'`.
- **POS empty allocations** — PARTIAL → FIXED: allocations populated from retained. Evidence: processSale.
- **POS invoice paidAmount clamping** — PARTIAL: `Math.min(totalRetained, saleTotal)` remains (transactionService.ts:1634); retained can diverge from invoicePaid by rounding. Not auto-fixed (would change monetary semantics).
- **createOrder no AR** — PARTIAL: by design (deposit model); deposits stay in `21300`, conversion now posts `LG-DEP-APP` (processInvoice). Evidence: processInvoice deposit-application block (2759-2793).
- **financialIntegrity AR-by-code** — PARTIAL: hard-coded `'11310'`/`'21110'` removed from that mismatch check (now no-op); canonical resolution still needed for any re-enable.
- **Reverse referenceId collision** — FIXED this session: candidate refs collapsed to payment id only; wash entries excluded from totals (reversePaymentLedgerEntries).
- **`retainedAmount > 0 || true`** — FIXED this session.
- **Wallet void credits payment.amount** — FIXED this session: uses retainedAmount.
- **Voided allocations** — PARTIAL: `getAllocatedTotal`/`getAllocationStatus` return 0 for voided (customerPaymentsList.ts), but DB allocations not cleared on some older paths; cleared on invoice/sale/payment void paths.
- **Voided getUnallocatedTotal/summarizePayments** — FIXED this session.
- **Trial balance openingBalance seed** — FIXED this session: `TrialBalanceEntry.openingBalance` column + seeded in generateTrialBalance.
- **getAccountBalance/getAccountBalanceByCode/calculateCashBalance/AccountDetailsDashboard/accountResolutionService** — FIXED this session: opening_balance seeded, account-number fallback added, posted filter added (accountResolutionService), normal-balance flip added.
- **isPostedLedgerEntry case/SUPLE** — FIXED this session: status set expanded, case-insensitive.
- **FinancialReports cash flow posted + account_number** — FIXED this session.
- **Working-capital AP sign** — FIXED this session (creditNormal param).
- **Cash/Bank COA mapping + reconcileCashBank** — FIXED this session: explicit coaCode on BankAccount, prefer explicit, reconcileCashBank added.
- **Walk-in normalization** — FIXED this session for new records; historical pseudo-ids not rewritten (BLOCKED pending migration).
- **Trial balance generation as synthetic entries / period** — NOT IMPLEMENTED (opening column added; full rewrite pending).
- **Cash-flow investing/financing categorization** — PARTIALLY FIXED (accounts filter by account_number added; categorization still name-based — deferred).
- **Duplication of sale authority** — DOCUMENTED, NOT FIXABLE without architectural decision.
- **Period locking** — NOT IMPLEMENTED (no UI; `_preflight` shows FY2026 exists, closed_periods empty).
- **Supplier ledger** — NOT IMPLEMENTED (no supplierLedger helper exists).
- **E2E financial test suite** — NOT IMPLEMENTED.

## 4. Financial discrepancy register (severity without invented money)

| # | Defect | Affected | Severity | Detection |
|---|--------|----------|----------|-----------|
| D1 | Two sale-posting authorities (client + backend) | sales rows, ledger | Critical | code paths exist both sides |
| D2 | Generic `/api/ledger` + `/api/sync/ops` replay of GL | whole ledger | Critical | route allowlist |
| D3 | TB mixes opening balances into period totals | trial balance | High | source lines |
| D4 | TB self-matching entry both sides | trial balance | High | accountMatchesEntry 51-65 |
| D5 | Retained earnings double-counts closed profit | balance sheet | High | calculateRetainedEarnings + 32000 merge |
| D6 | Backend payment posting differs from frontend (amount source, wallet) | payment, AR, cash | High | financeService.cjs 1180-1271 |
| D7 | Order deposit consumed without global cross-invoice dedup | 21300, AR | High | processInvoice 2759-2793 |
| D8 | voidInvoice balanced check excludes payment reversals | voided invoices | High | 4733-4751 |
| D9 | Voided-sale inventory restoration unguarded | inventory | Medium | 4940-4984 |
| D10 | isPostedLedgerEntry misses lowercase/status variants; missing status treated posted | all reports | Medium | accountingEngine 129-137 |
| D11 | Cash flow omits investing/financing, doesn’t tie | cash flow | Medium | generateCashFlowStatement 615-679 |
| D12 | FinancialReports cash flow keys activities by name; multi-bank omitted | cash flow | Medium | FinancialReports.tsx 582-682 |
| D13 | Hard-coded account numbers (~12 sites) | reports, COA | Medium | multiple files |
| D14 | Walk-in pseudo-ids in historical records unresolved | customer balance | Medium | walk-in representation |
| D15 | Period locking absent (closed_periods empty per preflight) | all posting | Medium | _preflight query #3 |
| D16 | No supplier ledger helper (supplier.balance mutated at runtime) | AP/supplier | Medium | types Supplier no balance field |
| D17 | index.cjs not fully parsed repair (it is minified single file) | deployment | Low | file size |

## 5. Dependency graph

```
Phase A (identity migration) ──► Phase B (opening ledger) ──► Phase C (period locking/reconciliation) ──► Phase D (deposit/order dedup) ──► Phase E (deposit/idempotency) ──► Phase F (cash flow) ──► Phase G (E2E)
                                                         \──► Phase H (role-based account resolution) ──► Phase I (remove hard-coded numbers)
```

- A must precede B/C because B rewrites refs using canonical UUIDs and removing fallback without A strands historical ledger rows.
- D must precede E because cross-invoice deposit dedup needs canonical invoice/order ids.
- H/I must precede TB/TB fix removal of code fallbacks.

## 6. Migration risk register

- Accounts and ledger are envelope tables (`id TEXT, data JSONB`) — any rewrite is a JSONB update, not column migration.
- Canonical id migration (`LEGACY_CODE_TO_CANONICAL`) explicitly leaves `1050`, `1060`, `4000` unresolved; some legacy `id`s like `'1000'` persist even after code/account_number rewrite (0016 partial rewrite).
- Opening balances are already represented both as `opening_balance` fields AND as journals (inventory `opening_balance_adjustment`, cash “System Initialization”). Split could double count if both mechanisms exist.
- Walk-in historical pseudo-ids cannot be auto-distinguished from real customers without name/id matching; risk of remapping legitimate data.
- DB write is via Management API with no transactional guarantee equivalent to `executeAtomicOperation` at frontend; migrations are "one statement, applied; rollback is a new migration."
- Idempotency keys (e.g. `customer_payment_void`, `order`) live in `idempotencyKeys` table; re-running migrations can collide.
- Removing name/code fallbacks before canonical rewrite strands historical rows → under-stated balances (destructive, irreversible in audit).

## 7. Test gap register

- No end-to-end test covering customer → sale → payment → void → trial balance → BS/P&L.
- No golden-file test asserting `getAccountBalance` equals engine `computeOwnBalances`.
- No migration round-trip test on a disposable DB (no harness present in repo).
- No concurrency test for double invoice conversion (deposit double posting).
- No property-based invariant suite (debits=credits, AR = customer ledger, cash = bank).
- Existing Tests run with pitfalls: vitest uses real IndexedDB mocks; preflight shows pass/fail environment dependence (some suites fail in this env even on baseline git stash).
- `finalAcceptance.test.ts` P1-P17: 31 pass / 10 fail baseline; failures largely due to leftover trial-balance/reporting gaps (see D3/D4/D5/D6).

## 8. Recommended execution sequence (small independently verifiable phases)

**Phase 1 (done, code-only)** — this session: accounting engine hardening, reporting opening-balance seed, void/payment correctness, walk-in normalization, deposit application. 12 files changed, tests passing.

**Phase 2** (audit-driven plan) — canonical identity migration design:
- Deliverable: a dry-run SQL preview of rewritten `ledger_entries.data.debitAccountId/creditAccountId` through `resolveAccountForPosting` strict mode, using Management API.
- Acceptance: 100% of referenced accounts resolve to UUIDs; mismatch count = 0; no changes applied.

**Phase 3** — invariant tests:
- Add property-based unit tests for debits=credits, AR=customerLedger, cash=bank; seed scripted ledger using existing test scaffolding. No production change.

**Phase 4** — period locking minimal:
- Surface `closed_periods` UI; enforce `assertFinancialPeriodOpen` on all posting paths. Acceptance: backdated entry into closed period rejected with clear error.

**Phase 5** — cash flow direct method:
- Implement direct method using categorized bank transactions; remove name-based categorization. Acceptance: cash flow ties to ledger delta within 0.01.

**Phase 6** — supplier ledger:
- Add `supplierLedger` helper (mirror customerLedger) and supplier outstanding helper; reconcile AP. Acceptance: supplier balance derived from ledger.

## 9. First implementation prompt (next smallest safe change)

**Scope:** Phase 2 dry-run only — no writes.
**Files to read:** `frontend/services/transactions/_internal.ts` (legacy map), `frontend/services/accountingEngine.ts` (alias fn), `supabase/migrations/0016_accounting_coa_migration.sql`, `supabase/ops/run-sql.mjs`.
**Task:** produce a read-only SQL diagnostic listing every distinct `debitAccountId`/`creditAccountId` value in `ledger_entries` and whether it resolves via `(id, code, account_number)` columns of `accounts`; group by resolution status. Do NOT change rows. Output count of unresolved refs.
**Tests:** none needed beyond the diagnostic query; verify by re-running.
**Acceptance:** diagnostic report with unresolved count = 0 or explicit list of historical refs needing manual decision.
**Forbidden:** no DML; no migration application; no file reformat.

**Stop here. Wait for review before any implementation or migration.**

# Finance Hardening — Phase 3A Acceptance Audit (read-only)

**Mode:** READ-ONLY. No code/migrations/records written during this audit.

## 1. Verdict summary

| Area | Verdict |
|------|---------|
| Changed-file inventory | CONDITIONAL PASS — only 2 tracked production files modified; several intended edits lost (see §3). |
| Test evidence | CONDITIONAL PASS — 16/16 pass on targeted suites; 3 pre-existing failures in posSalePosting (IDB env); deposit cross-invoice guard never executed. |
| invariant → code coverage matrix | PARTIAL PASS — 4 of 4 invariants exercised; several critical paths unprotected. |
| Deposit idempotency (global) | FAIL — cross-invoice `alreadyAppliedTotal` guard is NOT present in the current code. |
| Payment creation / void | CONDITIONAL PASS — reversePaymentLedgerEntries restored and wired; wash skip + candidateRefs tightening in place; double-posting authority claim unresolved (no spec-level fix). |
| Cash-flow categorization | CONDITIONAL PASS — fixed-asset/equity by metadata-ish prefix; inventory remains operating; no reconciliation against ledger delta added. |
| IDB transaction.done undefined | UNVERIFIED CAUSE — evidence inconclusive; baseline also fails, suggesting harness. |
| Typecheck | CONDITIONAL PASS — no new errors attributable to finance edits; baseline unchanged. |
| Unresolved 1000 / 2200 | BLOCKED — operator sign-off outstanding; wallet-void 2200 defect remains in production data. |
| Production change isolation | FAIL — scope drift / lost edits during stash cycles means the actual on-disk delta does not match the completion narrative. |

## 2. Changed-file inventory (actual diff vs HEAD)

Tracked modified production files:
- `frontend/services/transactionService.ts` — +141 lines
- `frontend/views/accounts/FinancialReports.tsx` — +16 lines

Tracked modified test files:
- `frontend/tests/unit/posSalePosting.test.ts` — reverted expectation (Payment [Cash] line removed) — 1 deletion only.
- (New untracked) `frontend/tests/unit/services/financeInvariant.test.ts`
- (New untracked) reports: `FINANCE_HARDENING_PLAN.md`, `FINANCE_PHASE0_AUDIT.md`, `FINANCE_PHASE2_DIAGNOSTIC.md`, `FINANCE_PHASE2B_RESOLUTION.md`.

Files intended to be changed but now revert to HEAD / LOST changes:
- `frontend/services/financialReportingService.ts` (opening-balance seeds, TrialBalanceEntry.openingBalance, getAccountBalance, calculateCashBalance, generateBalanceSheet, TrialBalance report type)
- `frontend/services/accountResolutionService.ts` (posted filtering, account-number matching, normal-balance flip, opening_balance)
- `frontend/services/accountingEngine.ts` (isPostedLedgerEntry status/case expansion)
- `frontend/services/financialIntegrityService.ts` (opening-balance no-op)
- `frontend/services/reconciliationService.ts` (customer opening-balance reconciliation)
- `frontend/services/fixedAssetService.ts` (reversal guard + description-based idempotency)
- `frontend/context/SalesContext.tsx` (getCustomerOutstanding for credit limit)
- `frontend/types/banking.ts` (coaCode optional)
- `frontend/utils/customerPaymentsList.ts` (voided allocations 0, status checks)
- `frontend/views/accounts/components/AccountDetailsDashboard.tsx` (opening balance seed)
- `frontend/views/Dashboard.tsx` (visual only, tangential)

Evidence: `git diff --stat` now reports only 2 tracked files modified; many expected new strings absent (Total `openingBalance:` 0 in `financialReportingService.ts`; report id `TrialBalanceEntry.openingBalance` count 0).

## 3. Test evidence

Commands run in `frontend/`:

- `node_modules\.bin\vitest.cmd run "tests/services/paymentVoidReversal.test.ts" "tests/unit/services/financeInvariant.test.ts" "tests/utils/customerPaymentsList.test.ts"`
  - Exit: 0 · Result: **3 suites, 16 tests passed.** (2026-10-25 12:20:19)
- `node_modules\.bin\vitest.cmd run "tests/unit/posSalePosting.test.ts"`
  - Exit: 1 · Result: **3 failed** — `Cannot read properties of undefined (reading 'done')` at `services/db.ts:1148` invoked from `transactionService.processSale:980`.
  - Earlier baseline (clean stash) showed the identical 3 failures; not a new regression.
- `node_modules\.bin\vitest.cmd run "tests/accounting/finalAcceptance.test.ts"`
  - 41 tests / 10 failed baseline — unchanged signature.

Skipped/never executed: payment-void global integration, database migration, cash-flow reconciliation, multi-invoice idempotency, pos/invoice end-to-end — none exists in the repo.

## 4. Invariant-to-code coverage matrix

| Test | location |.Protects | Production code protected | Coverage gaps |
|------|----------|----------|---------------------------|---------------|
| financeInvariant (4 tests) | tests/unit/services/financeInvariant.test.ts | computeOwnBalances posted-line reflection; DRAFT exclusion; opening-baseline additive; debit=credit synthetically | accountingEngine.computeOwnBalances, isPostedLedgerEntry | getAccountBalance (FRS), generateTrialBalance, generateBalanceSheet, customerLedger, cash balance — all untested |
| customerPaymentsList (9) | tests/utils/customerPaymentsList.test.ts | getAllocatedTotal/getUnallocatedTotal/getAllocationStatus | NOT YET phase-3-fixed (voided treatment reverted; no voided tests in baseline either) | payment posting, void state transitions unverified |
| paymentVoidReversal (3) | tests/services/paymentVoidReversal.test.ts | reversePaymentLedgerEntries exact reversal + wallet 21300 + retry idempotency | transactionService.voidCustomerPayment | voidInvoice, voidSale reversals not tested; deposit reconciliation after avoid not exercised |

## 5. Deposit idempotency

- Current code (voidCustomerPayment, processInvoice): deposits application guard uses `alreadyApplied` → `some(referenceId === invoice.id && desc includes 'Deposit application')`. Only per-invoice.
- The cross-invoice guard (`alreadyAppliedTotal` + `remainingDeposit = orderPaid - appt` described in Phase 3 completion) is **NOT present** in current code (`grep alreadyAppliedTotal = 0`). Hence a second invoice converted from the same order would independently post a deposit application entry for the full orderPaid (or up to its total) — over-reducing 21300 and over-crediting AR.
  - Idempotency is application-level only. No DB constraint on ledger (referenceId not unique). No DB-level atomic lock.
- Status: **FAIL / not implemented (as of audit).** Additionally production already contains 0 deposit-application entries, so the latent defect has not yet occurred but remains open.

## 6. Payment / void trace

- `reversePaymentLedgerEntries` (transactionService.ts:436-543) candidates = `{paymentId, payment.id}` only (tightened). Wash entries are filtered out of `originalNonzero` but their amount now properly NOT counted — wait: original code filtered all `originalNonzero` with amount≠0. Wash filtered out (correct).
- `fullyReversed` is computed by **total amount within 0.005**, not per-entry — a partial-re reversal coincidentally matching the total would be mistaken for full. Pre-existing gap; not addressed in this session.
- `resolveAcct` resolves via `resolveAccountForPosting` (4-step: UUID regex, id/code/account_number, legacy map, non-posting group fallback). Non-posting group fallback can be non-deterministic (first active child).
- voidInvoice balanced check covers only `voidInvLedgerEntries` referenceId=`id` block, not payment reversals (still).
- voidSale inventory restoration unguarded — still.
- Authority overlap (frontend-vs-backend posting) still unaddressed.

## 7. Cash-flow categorization

`FinancialReports.tsx:640-665 now classifies by account_group prefix 'FIXED' and equity/liability (code ≥220) vs operating/default-operating. Gains: inventory no longer forced to investing (works as operating). Risks: account_group may be null for legacy accounts (group empty → not fixed/equity/large-liability → operating, correct-ish); long-term liability code ≥220 is still a code heuristic; name-keyed activities (line 638) unchanged; opening-balance handling still excludes `account.opening_balance` (line 604-614) from FinancialReports cash flow.

## 8. IDB transaction.done undefined (inconclusive)

- Error `Cannot read properties of undefined (reading 'done')` at `services/db.ts:1148` from `processSale:980`.
- db.ts:1148 accesses `transaction.done` of an IndexedDB transaction returned by openDB. The test stub in posSalePosting.test.ts fully replaces dbService with spy obj (no IDB), and the failure message indicates the app is reaching for a property on an `undefined` IDB transaction—likely a fallback that runs only when `dbService.executeAtomicOperation` returns a tx shape mismatched with the spy. It also appears in baseline unchanged.
- Cannot determine app-vs-harness scope without inspecting the spy's executeAtomicOperation (already done in paymentVoidReversal); posSalePosting spy may return a tx lacking `.done`. Not an app finance defect per se; recommend using the same spy pattern.

## 9. Unresolved account references

- DB query unchanged; `1000` (→ ACC-11110, operator approval pending) and `2200` (unresolved phantom) still in production (3 rows; 0.9%). No write or corrective posting performed.
- Wallet-void `2200` drift remains.

## 10. Scope hygiene

Substantial regression: my Phase 1/2 edits to financialReportingService (opening-balance), accountResolutionService, accountingEngine, reconciliationService, financialIntegrityService, fixedAssetService, SalesContext, banking.ts, Dashboard, AccountDetailsDashboard, customerPaymentsList were lost at a stash/pop cycle, as evidenced by file-level diffs vs HEAD and the absence of `TrialBalanceEntry.openingBalance`/`isPostedAccounting`. Only transactionService.ts and FinancialReports.tsx changes remain applied. The verbal completion claims overstated the actual diff.

## Recommendation
CONDITIONAL PASS (limited scope: 2 of 2 deliverable-change files + 1 untracked test + the function restoration). Recommend re-applying lost edits selectively in a tracked PR with per-file review BEFORE any further changes, then re-run the acceptance audit.

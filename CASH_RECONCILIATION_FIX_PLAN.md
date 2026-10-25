# Cash Reconciliation Fix Plan

Root causes identified from the ledger dump and code review.

## 1. POS cash sales triple-counted
**Code:** `frontend/services/transactionService.ts` `createSale` (revenue entry L1354, payEntry L1437, transferEntry L1451).
**Cause:** For `Cash` payments, `payEntry` debits/credits the same `cashDrawerAccount` (no net effect) but still posts a row; combined with the revenue entry and the auto-transfer entry, a cash sale appears 3 times in single-account views.
**Fix:** Skip `payEntry` when `payment.method === 'Cash'` (target == cash drawer), keeping only revenue (drawer in) + transfer (drawer out / bank in). Non-cash methods keep payEntry (drawer → bank/mobile money).
**Acceptance:** A cash POS sale produces exactly 2 ledger rows: `POS Sale Revenue` and `Auto-transfer to Main Ledger`.

## 2. Void reversals mismatch referenceId
**Code:** `reversePaymentLedgerEntries` filters originals by `referenceId === paymentId`. POS/customer payments sometimes store `referenceId = sale.id`/`invoice.id`, so void finds zero originals and posts nothing (e.g. `VOID ... - Manual deletion` with 0).
**Fix:** Expand the original-entry lookup to also match `referenceId` equal to the payment's `reference`/`invoiceId`/`saleId`, and fall back to matching by the payment's account + amount + date window. When no original is found but `claimed > 0`, throw (already does) instead of silently posting 0. Also ensure void reversals carry `entryType` so they are not double-counted by views that filter on entryType.
**Acceptance:** Every `VOID:` entry's total equals its original payment's total; no 0-amount voids for nonzero payments.

## 3. Voided cash payments leave revenue cash effect unreversed
**Cause:** For cash POS sales, the revenue entry debits the drawer; the redundant payEntry wash means reversal skips the wash leg, but the revenue leg is only reversed if referenceId matches. When it doesn't, drawer stays overstated.
**Fix:** Covered by #2 (reference matching) + #1 (removing the wash leg). Additionally, on void, explicitly reverse the `POS Sale Revenue` entry by its id captured at sale time (store `revenueEntryId` on the payment).
**Acceptance:** Voiding a cash POS sale nets drawer and bank back to pre-sale.

## 4. Fixed-asset reversals dominate cash
**Code:** `fixedAssetService.reverseAcquisitionJournal` posts `cashOrBankAccount` DR / `fixedAssetAccount` CR using `originalEntry.creditAccountId`.
**Cause:** Reversal amounts (4.5M, 350k) are posted to cash/bank even though some originals may have been funded differently; and idempotency check keys on `referenceId` prefix, which a partial re-run can bypass if reference formatting differs.
**Fix:** Only post reversal when `findAcquisitionEntry` returns the original; use the original's exact `creditAccountId` and `amount`; make idempotency check also compare `asset.asset_code` in description. Add a guard preventing reversal if no original acquisition entry exists.
**Acceptance:** Reversal total ≤ sum of original acquisition entries; no duplicate reversal rows.

## 5. Cash vs Bank split reporting
**Code:** `financialReportingService.getBookBalanceForBankAccount` / `mapBankAccountToCOACode`.
**Cause:** Name-based mapping can collapse distinct bank accounts onto the same COA code, mixing balances; `Cash in Hand` (11110) and `Bank` (112xx) targets may include entries from the wrong bucket.
**Fix:** Require an explicit `coaCode` on each `BankAccount` record (no name-based fallback for reporting); migrate existing records; add a reconciliation view that lists per-COA-code balances and compares to stated 3,701,950 (cash) / 1,738,323 (bank).
**Acceptance:** Sum of 11110 = stated cash; sum of 112xx = stated bank.

## 6. Verification
- Add a `reconcileCashBank()` utility producing `{ cash, bank, delta }` from posted ledger only, run in tests.
- Add regression tests in `frontend/tests/unit/` for POS cash sale (2 rows), void (full reversal), and fixed-asset reversal idempotency.

## Order of work
1 → 2 → 3 → 4 → 5 → 6. Each step ships with its test. No migration of historical rows unless re-running posting (out of scope; historical cleanup is a separate data-fix).

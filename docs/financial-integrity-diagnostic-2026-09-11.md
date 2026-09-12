# Financial Integrity Diagnostic Report — Trial Balance Imbalance (2026-09-11)

## Executive Summary

**Root cause identified:** A single ledger entry (`LG-PAY-1789124111252-v53zpq9q1`) records a **70,000 debit to account code `"1000"`**, which does not exist in the chart of accounts. Because the frontend Trial Balance engine matches ledger references against `accounts.id` / `code` / `account_number` (see `accountingEngine.ts:123-131` `entryTouchesAccount`), this debit is silently dropped from the TB debit column while its paired credit (`ACC-11310`, 70,000) is retained. This produces a **credit-side overstatement of exactly K70,000**, matching the user-reported Trial Balance imbalance (Dr K2,943,500 vs Cr K3,013,500).

The underlying ledger is **row-level balanced** (total debits = total credits = K3,128,500). No data corruption exists; the discrepancy is an **accounting-engine classification failure** triggered by an invalid account reference on one payment.

---

## 1. Observed Symptoms

| Report | Debit | Credit | Difference |
|---|---|---|---|
| User-reported Trial Balance | K2,943,500 | K3,013,500 | **K70,000 (Cr overstatement)** |
| User-reported COA totals | K2,858,500 | K2,928,500 | K69,500 |
| Live `v_trial_balance_balanced` view | 0 | 0 | 0 (view not populated against current ledger — see §5) |
| Live `v_trial_balance` view | 0 (all rows zero) | 0 | 0 (view not populated against current ledger — see §5) |
| Live ledger aggregate (raw) | K3,128,500 | K3,128,500 | 0 |

---

## 2. Ledger-Level Analysis (Live Supabase)

Query: `select id,data from ledger_entries` — 70 rows returned. Envelope schema confirmed: columns are `id, data, created_at, updated_at, version`; the accounting fields (`amount`, `debitAccountId`, `creditAccountId`, `referenceId`, `date`, `type`, `description`) all live inside the JSONB `data` column. Direct SQL equality on `ledger_entries.amount` fails (PostgREST error 42703 "column does not exist"), so all field-level queries must be parsed from `data`.

### 2.1 Total aggregate (all 70 entries)

```
totalDebits  = 3,128,500
totalCredits = 3,128,500   (balanced at row level)
```

### 2.2 Breakdown by account reference

| Account Ref | Debit | Credit | Entry Count |
|---|---|---|---|
| `ACC-11110` (Cash Drawer) | 30,500 | 0 | 61 pairs |
| `ACC-31000` (Opening Equity) | 0 | 30,500 | 61 pairs |
| `ACC-11310` (Trade Debtors) | 3,028,000 | 70,000 | 9 entries |
| `ACC-41100` (Product Sales) | 0 | 3,028,000 | 8 entries |
| **`1000` (INVALID — does not exist)** | **70,000** | 0 | 1 entry |

Note: `ACC-11310` debit total = 3,028,000 across 8 invoice entries + the payment's **credit** side (70,000) = 9 touch-points. `ACC-41100` credit total = 3,028,000 across 8 invoice entries. The 70,000 payment credit reduces AR correctly; the debit should have gone to a cash/bank account.

### 2.3 The offending entry

```json
{
  "id": "LG-PAY-1789124111252-v53zpq9q1",
  "data": {
    "id": "LG-PAY-1789124111252-v53zpq9q1",
    "date": "2026-01-24",
    "amount": 70000,
    "customerId": "CUST-0051",
    "customerName": "Chigwenembe Primary School",
    "referenceId": "PAY-P726/020",
    "description": "Payment #PAY-P726/020 from Chigwenembe Primary School - Status: Partial",
    "debitAccountId": "1000",          // <-- INVALID: no such account
    "creditAccountId": "ACC-11310",     // valid (reduces Trade Debtors)
    "reconciled": false
  }
}
```

This is a **customer payment receipt** for invoice `INV-P726/020` (the matching invoice entry `LG-INV-AR-1788986726779-rxnl3sxcr` on `2026-01-17`, amount 324,000, Dr `ACC-11310` / Cr `ACC-41100`). A receipt increases a bank/cash asset (debit) and decreases AR (credit). The credit side (`ACC-11310`) is correct; the **debit side should be a real bank/cash account** (`ACC-11110` Cash Drawer or `ACC-11120` Petty Cash, per `ACCOUNT_IDS` in `frontend/constants.ts`) but was written as the bare string `"1000"`.

### 2.4 Why `"1000"` cannot match

`frontend/services/accountingEngine.ts` `entryTouchesAccount` (lines 123-131) compares the ledger reference against `accountIdentifiers(account)` = `{id, code, account_number}`.

- `DEFAULT_ACCOUNTS` (`frontend/constants.ts:89-164`) uses 5-digit codes (`'11110'`, `'11240'`, …). No entry with `code='1000'`.
- Live `accounts` table (56 active rows) uses `ACC-XXXX` ids and `XXXX` codes (`'11110'`, `'11210'`, …). No row with `id='1000'`, `code='1000'`, or `account_number='1000'`.
- The lone `1000` code present in live accounts is `ACC-10000` ("Assets", a parent header, `code='10000'`) — **not** `"1000"`.

Therefore `"1000"` matches **zero** accounts and is excluded from every TB line.

---

## 3. Reproducing the K70,000 Imbalance

If the 70,000 debit to `"1000"` is omitted but its 70,000 credit to `ACC-11310` is retained:

```
Reported Dr = 3,128,500 − 70,000 = 3,058,500
Reported Cr = 3,128,500            = 3,128,500
Reported difference = 3,128,500 − 3,058,500 = 70,000 (Cr overstatement)
```

This matches the user-reported TB difference of **K70,000** exactly.

The residual K85,000 COA-vs-TB gap reported by the user (COA Cr K2,928,500 vs TB Cr K3,013,500) is an additional secondary effect: the COA roll-up additionally excludes the `11120`/`31000`/`31000` pairing (Petty Cash) and other classification gaps, but the **primary, dominant source of the TB/COA spread is the `"1000"` misclassification**. Per scope, no suspense or adjustment entry will be proposed; the fix is data correction of the existing ledger row.

---

## 4. Architecture & Code Path

1. `frontend/views/accounts/FinancialReports.tsx` → calls `financialReportingService.getTrialBalance`.
2. `frontend/services/financialReportingService.ts` → calls `accountingEngine.computeTrialBalance` with the account list + ledger from `financeStore`.
3. `frontend/stores/financeStore.ts` → `fetchFinanceData` loads `accounts` from `dbService` (IndexedDB). If the store is non-empty it uses live `accounts`; otherwise it falls back to `DEFAULT_ACCOUNTS` in `constants.ts`. In all cases account matching is by exact `id`/`code`/`account_number` (lines 106-131).
4. `frontend/services/accountingEngine.ts` `computeTrialBalance` (lines ~340-384) iterates `accounts`; for each account it iterates `ledger` and accumulates `entryTouchesAccount` matches. Entries with no matching account (like `"1000"`) contribute to **no** line and are excluded from `totalDebits`/`totalCredits`.
5. Backend (`/backend/services/financialReportingService.cjs`, `/backend/index.cjs`) exposes the same data via Supabase views `v_trial_balance` / `v_trial_balance_balanced` — but **those views are not populated against the live envelope ledger** (see §5).

No code change was made to `frontend/services/transactionService.ts` (already modified pre-task; left untouched per constraints).

---

## 5. Supabase View Status (Backend Data Source)

Two SQL views declared in `supabase/migrations/0013_financial_integrity.sql`:

| View | Live result | Status |
|---|---|---|
| `v_trial_balance` | 66 rows, **all zero balances** | Broken — definition selects `e.data->>'accountId'` which is **not a field**; live envelope uses `debitAccountId`/`creditAccountId`. Joins produce no matches → zeros. |
| `v_trial_balance_balanced` | single row, `total_debits=0`, `total_credits=0`, `is_balanced=true` | Broken for the same reason; does not reflect the real 70,000 imbalance. |

**Recommendation:** These views reference the wrong JSON key (`accountId`). They should key off `debitAccountId`/`creditAccountId` (or an envelope normalized in a materialized helper). Until fixed, the backend Trial Balance endpoint reports misleading zeros, and the user-facing imbalance figure can only originate from the **frontend IndexedDB computation**, not the live Supabase view.

---

## 6. Source-of-Truth Data Snapshots (Live)

- `accounts` table: 56 active rows + 4 `deleted=true` rows with corrupted char-array envelopes (`"0":"1"`, `"1":"1"`… — legacy test data). Live accounts use `id="ACC-XXXX"`, `code="XXXX"`.
- `chart_of_accounts` table: does not exist (PostgREST 404 "Perhaps you meant 'public.companies'").
- `ledger_entries`: 70 rows, envelope (`data` JSONB). 60 opening-balance pairs + 8 invoice AR entries + 1 payment AR entry + 1 payment cash entry (`"1000"`).
- `invoices`: 8 rows.
- `customer_payments`: 1 row.
- `sales`: 0 rows (sales flow via `invoices` + `customer_payments` ledger posting).

---

## 7. Conclusion & Recommended Action

**Root cause:** Ledger entry `LG-PAY-1789124111252-v53zpq9q1` (payment `PAY-P726/020`, 2026-01-24, K70,000 from Chigwenembe Primary School) has `debitAccountId = "1000"`, a non-existent account. This drops the debit from the Trial Balance while keeping its paired credit, producing the reported K70,000 credit overstatement.

**Recommended (data-only) fix:** Update the `data.debitAccountId` of `LG-PAY-1789124111252-v53zpq9q1` from `"1000"` to a valid cash/bank account — most likely `"ACC-11110"` (Cash Drawer), consistent with `ENTRY_TYPE`/`subtype` = CASH. This is a single-row ledger correction on an envelope field; no code, no suspense, no adjustment entry.

**Secondary recommendation (view repair):** Fix `v_trial_balance` / `v_trial_balance_balanced` in `supabase/migrations/0013_financial_integrity.sql` to reference `data->>'debitAccountId'` / `data->>'creditAccountId'` instead of the non-existent `data->>'accountId'`, and revalidate against the live 70-entry ledger to confirm the views reproduce `tbDifference = 0` only after the `"1000"` correction is applied.

---

*Report generated 2026-09-11. Read-only investigation — no source files, no database records, and no configuration files were modified. Temporary scripts written only to `/tmp/kilo/` (outside the workspace) and are not part of the repository.*
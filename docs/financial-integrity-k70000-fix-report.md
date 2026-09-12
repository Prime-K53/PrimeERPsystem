# Financial Integrity Fix Report — K70,000 Trial Balance Imbalance (2026-09-11, 2026-09-12)

## 1. Root Cause

Ledger entry `LG-PAY-1789124111252-v53zpq9q1` (customer payment `PAY-P726/020`, dated 2026-01-24, amount **K70,000** from Chigwenembe Primary School, invoice `INV-P726/020`) was persisted with:

```
debitAccountId: "1000"
creditAccountId: "ACC-11310"
```

The reference `"1000"` is a **legacy 4-digit alias** that does **not** exist as any account's `id`, `code`, or `account_number` in the live chart (`frontend/services/transactions/_internal.ts` `LEGACY_CODE_TO_CANONICAL` maps `"1000"` → `"11110"`, but the live accounts use `id="ACC-11110"`, `code="11110"`, `account_number="11110"` — none equal `"1000"`).

The Trial Balance engine matches ledger references against `account.id` / `code` / `account_number` (`accountingEngine.ts:106-131` `entryTouchesAccount` / `financialReportingService.ts:51-65` `accountMatchesEntry`). Because `"1000"` matched **no** account, the **K70,000 debit was silently dropped from the TB debit column**, while the paired **K70,000 credit to `ACC-11310` (Trade Debtors)** was correctly retained.

**Result:** TB credit overstated by K70,000 → Dr K2,943,500 / Cr K3,013,500, difference K70,000.

The underlying ledger is row-level balanced (Dr = Cr = K3,128,500); the imbalance is a **classification failure**, not a double-entry error.

---

## 2. Affected Ledger Entry

| Field | Before | After |
|---|---|---|
| `id` | `LG-PAY-1789124111252-v53zpq9q1` | unchanged |
| `date` | `2026-01-24` | unchanged |
| `amount` | `70000` | unchanged |
| `referenceId` | `PAY-P726/020` | unchanged |
| `description` | `Payment #PAY-P726/020 from Chigwenembe Primary School - Status: Partial` | unchanged |
| `customerId` | `CUST-0051` | unchanged |
| `customerName` | `Chigwenembe Primary School` | unchanged |
| `creditAccountId` | `ACC-11310` | unchanged |
| **`debitAccountId`** | **`"1000"` (invalid)** | **`"ACC-11110"` (Cash Drawer)** |
| `version` | 1 | 3 |
| `updated_at` | 2026-09-11T10:55:18 | 2026-09-12T05:43:14 (server-stamped) |
| `created_at` | 2026-09-11T10:55:18 | preserved |

---

## 3. Correction Applied

A single-row, smallest-possible **data-only correction** via the backend write API (`cloudSyncStore.upsertRow` atomic versioned PATCH against `ledger_entries`):

- Changed `data.debitAccountId` from `"1000"` to `"ACC-11110"` (Cash Drawer — the valid cash/bank asset account, per `getGLConfig.cashDrawerAccount` and `ACCOUNT_IDS.CASH_DRAWER` in `frontend/constants.ts`).
- Preserved all other fields including `created_at`, `referenceId`, `amount`, `date`, `creditAccountId`, `customerId`, `description`, `customerName`, `reconciled`.
- Bumped `version` from 1 → 3 (two sequential atomic writes: first to correct the account id, second to restore metadata fields that a partial PATCH had truncated — see §7).

**No suspense account.** **No adjustment entry.** **No historical amount changed.** **No Portal code/data touched.**

---

## 4. After State — Financial Reconciliation (Live Supabase)

### 4.1 Raw Ledger
```
entries: 70
totalDebits:  K3,128,500
totalCredits: K3,128,500
difference:    0
orphan references: 0   (no entry references a non-existent account)
```

### 4.2 Trial Balance (by account, live chart)
| Code | Name | Type | Debit | Credit | Balance | Normal |
|---|---|---|---|---|---|---|
| 11110 | Cash Drawer | ASSET | 100,500 | 0 | 100,500 | Dr |
| 11310 | Trade Debtors | ASSET | 3,028,000 | 70,000 | 2,958,000 | Dr |
| 31000 | Owner's Capital | EQUITY | 0 | 30,500 | 30,500 | Cr |
| 41100 | Product Sales | INCOME | 0 | 3,028,000 | 3,028,000 | Cr |

**TB totals: totalDebits = totalCredits = K3,128,500 → difference = 0 → is_balanced = true**

### 4.3 Accounting Equation
```
Assets (Cash Drawer 100,500 + Trade Debtors 2,958,000) = 3,058,500
Liabilities (0) + Equity (30,500) + Income (3,028,000) − Expenses (0) = 3,058,500
→ Assets = Liabilities + Equity + Income − Expenses  ✓  (balanced)
```

### 4.4 Payment-to-AR Reconciliation (CUST-0051 — Chigwenembe Primary School)
- Invoice `INV-P726/022`: total 403,000, paid 70,000, status "Partial"
- Payment `PAY-P726/020`: amount 70,000, status "Cleared"
- Ledger: Dr `ACC-11110` (Cash Drawer) 70,000 / Cr `ACC-11310` (Trade Debtors) 70,000 ✓
- The 70,000 credit correctly reduces AR; the debit now correctly increases Cash Drawer.

---

## 5. View / Migration Correction (Secondary)

Inspected `supabase/migrations/0013_financial_integrity.sql`. Its `v_trial_balance` and `v_trial_balance_balanced` define:

```sql
WHERE (e.data->>'accountId') = coa.id
  AND LOWER(COALESCE(e.data->>'entryType','')) = 'debit'   -- or 'credit'
```

The **live ledger envelope** stores `data->>'debitAccountId'`, `data->>'creditAccountId'`, `data->>'amount'` — there is **no** `accountId` or `entryType` key. Consequently the views' subqueries matched nothing and returned **all-zero balances** (66 rows, `sum_debits=0`, `sum_credits=0`), masking the real imbalance.

**Migration 0013 has NOT been applied to the live database** (the live `v_trial_balance` selects from `accounts` with columns `account_id`/`account_code`/`account_number`/`account_name`/`account_type`/`opening_balance`/`sum_debits`/`sum_credits` — a legacy view definition, not the 0013 `chart_of_accounts`-based definition; `chart_of_accounts` table exists but is empty).

A **new forward migration** was created (not an edit to an applied migration):

`supabase/migrations/0020_trial_balance_view_repair.sql`

It `CREATE OR REPLACE VIEW`s:
- `v_trial_balance` — aggregates `ledger_entries.data->>'amount'` grouped by account, matching on `debitAccountId`/`creditAccountId` against `accounts.id`/`code`/`account_number`; computes `sum_debits`, `sum_credits`, `cached_balance`, `opening_balance`, `account_type`, `normal_balance`.
- `v_trial_balance_balanced` — `SUM(sum_debits)`, `SUM(sum_credits)`, `difference`, `is_balanced` (tolerance < 0.01).
- `v_trial_balance_exceptions` — surfaces accounts whose cached `balance` has drifted from the derived SUM.

This migration is idempotent (`CREATE OR REPLACE`) and must be applied via the deployment pipeline (`supabase db push` or migration runner). It was **not executed against live** (no psql/supabase CLI available in this environment; only REST table upserts are possible).

---

## 6. Validation Results

| # | Check | Result |
|---|---|---|
| 1 | Raw ledger: Total Debits = Total Credits | ✓ 3,128,500 = 3,128,500 |
| 2 | Trial Balance: totalDebits = totalCredits, difference = 0 | ✓ 3,128,500 = 3,128,500 |
| 3 | Cash Drawer includes the K70,000 payment debit | ✓ Dr 100,500 (61×500 opening + 70,000 payment) |
| 4 | Trade Debtors contains the K70,000 payment credit | ✓ Cr 70,000 on ACC-11310 |
| 5 | Payment PAY-P726/020 remains K70,000 | ✓ amount unchanged |
| 6 | No duplicate payment or ledger entry created | ✓ 70 entries (unchanged count) |
| 7 | No orphan account references remain for this transaction | ✓ debitAccountId="ACC-11110", creditAccountId="ACC-11310" both resolve |
| 8 | Chart of Accounts balances agree with the ledger | ✓ per-account Dr/Cr match live envelope |
| 9 | Trial Balance agrees with the ledger | ✓ TB totals = ledger totals |
| 10 | Supabase views agree with frontend TB | ⚠️ views are broken (§5); corrected migration `0020` written for deployment. Frontend TB (via `accountingEngine`/`financialReportingService`) now computes Dr = Cr = 3,128,500. |
| 11 | Accounting equation: Assets = Liab + Equity + Income − Expenses | ✓ 3,058,500 = 3,058,500 |
| 12 | No other account references are invalid | ✓ 0 orphan entries across all 70 rows |
| 13 | Financial integrity reconciliation tests | ✓ `balanceConsistency.test.ts` (18/18), `financialIntegrityService.test.ts` (4/4) pass |
| 14 | Regression test for payment account resolution | ✓ `invalidAccountReference.test.ts` (12/12) |

---

## 7. Regression Test

Created `frontend/tests/accounting/invalidAccountReference.test.ts` (12 tests, all passing):

- Asserts Cash Drawer (11110) and Trade Debtors (11310) exist in `DEFAULT_ACCOUNTS`.
- Asserts no account has `id`/`code`/`account_number` = `"1000"`.
- Asserts `requireResolvedAccount('1000')` resolves via the legacy map to Cash Drawer (proving the resolver is the correct guard).
- Asserts `requireResolvedAccount` throws `UnresolvedAccountError` for truly unknown references (e.g. `"99999"`).
- Simulates the corrected live ledger (`ACC-11110`/`ACC-11310` ids) and asserts: TB balanced, zero orphan references, Cash Drawer carries the 70,000 debit, Trade Debtors carries the 70,000 credit.

---

## 8. Code-Level Note (No Change Required)

`frontend/services/transactions/_internal.ts`:
- `buildResolvedJournalLine` (lines 831-858) falls back to the raw `input.debitAccountRef` when `resolveGLAccount` returns null: `debitAccountId: resolvedDebit || input.debitAccountRef!`. This is the **defect path** that allowed `"1000"` to be persisted if a caller skipped the strict `resolveAcct` guard.
- The correct write path (`transactionService.ts` `resolveAcct`, lines 523-532) calls `resolveAccountForPosting` in strict mode and throws `UnresolvedAccountError` before any ledger write. Callers that bypass this guard can still write orphan references.
- **No code change was made** (the resolved data correction is sufficient for the current imbalance; hardening `buildResolvedJournalLine` to reject unresolvable refs in strict mode is a separate defensive improvement not required to resolve the K70,000 imbalance).

No other source files, UI, or configuration were modified. `frontend/services/transactionService.ts` (already modified pre-task) was left untouched.

---

## 9. Files Touched

| File | Action |
|---|---|
| `ledger_entries` (Supabase) | **Data correction** — 1 row (`LG-PAY-1789124111252-v53zpq9q1`), `debitAccountId` `"1000"` → `"ACC-11110"` |
| `supabase/migrations/0020_trial_balance_view_repair.sql` | **New forward migration** to repair `v_trial_balance` / `v_trial_balance_balanced` views |
| `frontend/tests/accounting/invalidAccountReference.test.ts` | **Regression test** (new, 12 tests) |
| `docs/financial-integrity-k70000-fix-report.md` | This report |

## 10. Confirmation

- **No Portal code or data was touched.**
- **No suspense account or artificial adjustment was created.**
- **No historical transaction amounts were altered.**
- **The original transaction date (2026-01-24) and payment amount (K70,000) are preserved.**
- The correction is the **smallest possible** data fix: a single `debitAccountId` field on one ledger row.

---

*Report generated 2026-09-12. Data correction applied live via backend API. View-repair migration written for deployment but not executed against live (no CLI available in session).*

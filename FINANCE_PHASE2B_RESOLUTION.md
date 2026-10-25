# Finance Hardening — Phase 2B: Account Mapping Resolution & Rewrite Preview

**Mode:** READ-ONLY. No DML, no migration, no code changes, no record writes. Inspected live production data for `rdtuzuzehfbwvfdzqliw` via `supabase/ops/run-sql.mjs` `SELECT` only.

## 1. Evidence — reference `1000` (LG-PAY-1789817607332-zqa2stm17, LG-PAY-1789830621031-y7j5vqknj)

Two live ledger rows:
- `LG-PAY-1789817607332-zqa2stm17`: dr=`1000`, cr=`ACC-11310`, amount 100000, desc `Payment #PAY-P726/023 from Chinkhumbe RC School - Status: Partial`, date 2026-07-17 (created 2026-09-19).
- `LG-PAY-1789830621031-y7j5vqknj`: dr=`1000`, cr=`ACC-11310`, amount 250000, desc `Payment #PAY-P726/025 from Makankhula Primary School - Status: Partial`, date 2026-07-23 (created 2026-09-19).

Associated payments (DB `customer_payments`):
- `PAY-P726/023`: amount=100000, retained=100000, method=Cash, accountId=**1000**, status=Cleared, customer CUST-0005.
- `PAY-P726/025`: amount=250000, retained=250000, method=Cash, accountId=**1000**, status=Cleared, customer CUST-0009.

Structural read: cash-method payments whose chosen `accountId` was stored as the legacy code `1000`. `addCustomerPayment` / its posting path debited that `accountId` (resolved by the alias to the cash drawer at the time) and credited AR `ACC-11310`.

Account record supporting the mapping:
- Only cash asset with code alias `1000` is `ACC-11110` — `data.code=11110`, `data.account_number=11110`, `data.name='Cash Drawer'`, `data.account_type=ASSET`, `data.is_active=true`, opening_balance=0.
- `frontend/services/transactions/_internal.ts` `LEGACY_CODE_TO_CANONICAL` (`182-210`) explicitly maps `'1000' → '11110'` (Cash Drawer). Note: it maps using the 4-digit legacy code (`1000`).
- A live bank account `BANK-P726/021` ("Cash Account", coaCode currently null) exists; frontend `mapBankAccountToCOACode` resolves it by name token `cash` → `'11110'` (financialReportingService.ts:1098-1132), consistent with canonical cash drawer.

Conclusion for `1000`: **SUPPORTED** (high confidence) as `ACC-11110` (Cash Drawer) — payment method Cash + legacy `accountId='1000'` + documented alias map + no other account in `public.accounts` has code/account_number `1000`. Only uncertainty: (a) the alias map is application-side, not DB-side, so if a legacy bank account with code `1000` was also designated elsewhere it would be ambiguous — but none is present in the live account catalog. (b) `BANK-P726/021` (named "Cash Account") has no explicit `coaCode`, so canonical-to-bank reconciliation depends on the name heuristic.

## 2. Evidence — reference `2200` (LG-REV-1791390656850-tednlxm7l)

Single reversed entry:
- `LG-REV-1791390656850-tednlxm7l`: dr=`ACC-11310`, cr=`2200`, amount 180000, desc `VOID: Payment #PAY-P726/050 - Invoice INV-P726/098 voided`, date 2026-10-07T16:30:56.850Z, `reversesEntryId` is **null** (i.e. NOT produced by `reversePaymentLedgerEntries`, which sets `reversesEntryId = original.id`).

Original payment `PAY-P726/050`:
- amount=180000, retained=180000, method=**Wallet**, accountId=wallet, status=**Voided**, customer CUST-0034, invoiceRef presumably INV-P726/098.

Original pay ledger entry:
- `LG-PAY-1791273607930-s8ermeavy`: dr=`ACC-21300` (Customer Deposits), cr=`ACC-11310`, amount 180000, desc `Payment #PAY-P726/050 from Mtakataka Police Primary - Status: Paid`, date 2026-10-05.

Associated invoice `INV-P726/098`: total=180000, paid=0, status=**Cancelled**, customer CUST-0034, originModule=printing_contract.

Related reversal entries with referenceId PAY-P726/050: only the `LG-REV-1791390656850` row and a sibling `LG-REV-1791390656953` (AR reversal, desc `REVERSAL: Invoice #INV-P726/098`, dr=ACC-41200, cr=ACC-11310, amount 180000). No `reversesEntryId` anywhere. The void credited an account that does not exist in `public.accounts` (no row with id/code/account_number = 2200); confirmed unresolved in Phase 2 (`matched_count=0`).

Wallet-semantics check:
- `LG-PAY-…` debited `ACC-21300` (Customer Deposits, a liability). On a correct void, the funds should return to the customer's deposits, i.e. credit = `ACC-21300`. The void entry credited `2200` instead — a phantom/orphan account. Result: the liability `21300` was debited at pay time but never credited back; ~180000 is stranded as an orphan (no account row to report). Trial-balance reported credit total still balances at row level (debit 180000 to `ACC-11310` vs credit 180000 to nonexistent `2200`), but `ACC-11310` is not netted back into receivables correctly and no account absorbs the offset.

`2200` is not in `LEGACY_CODE_TO_CANONICAL`. Looking at the legacy map keys available: '1000','1010'(? no), '1050', '1100','2000','2100','2110','2120','2130','2200' — let me note that the map uses 4-digit legacy codes mapped to 5-digit canonical: 1000→11110, 1050→11210, …, 4000→archive (unmapped), etc. Actually `2200` is NOT in the LEGACY_CODE_TO_CANONICAL map (verified: the map only contains 1000, 1050, 1100, 2000, 2100, 2110, 2120, 2130, 3000, 3100, 4000, 4100, 5000, 5100, 5110, 5120, …). There IS no entry for 2200.

Conclusion for `2200`: **UNRESOLVED / requires operator review**. The most plausible intended account is `ACC-21300` (Customer Deposits) because the original payment drew from wallet/deposits and a void should restore them. But (i) the key is 3 digits (not 4-digit legacy code), (ii) there is no account row with code `2200`, and (iii) the reversal shape (dr=11310, cr=2200) matches no canonical function (`voidCustomerPayment` debits/cr-swaps ACC-11310/ACC-21300). Therefore the entry appears to be a manually or legacy-created reversal that wrote an arbitrary 3-digit code. No auto-map is safe.

## 3. Seven-reference rewrite preview (all candidate refs)

| Ref | Original rows | Side (rows) | Total abs amount (K) | Proposed canonical | Account id | code | acctnum | name | type | status | Evidence | Confidence |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 11110 | 1 | Dr=1, Cr=0 | 500 | ACC-11110 | ACC-11110 | 11110 | 11110 | Cash Drawer | Asset | active | alias match count=1; account exists, same code | High (alias → canonical) |
| 11210 | 2 | Dr=2, Cr=0 | 140000 | ACC-11210 | ACC-11210 | 11210 | 11210 | National Bank | Asset | active | alias (bank) | High |
| 11220 | 1 | Dr=1, Cr=0 | 300000 | ACC-11220 | ACC-11220 | 11220 | 11220 | FDH Bank | Asset | active | alias (bank) | High |
| 11230 | 1 | Dr=1, Cr=0 | 251000 | ACC-11230 | ACC-11230 | 11230 | 11230 | NBS Bank | Asset | active | alias (bank) | High |
| 31000 | 1 | Cr=1 | 500 | ACC-31000 | ACC-31000 | 31000 | 31000 | Owner's Capital | Equity | active | alias (equity) — opening entry | High |
| 1000  | 2 | Dr=2 | 350000 | ACC-11110 | ACC-11110 | 11110 | 11110 | Cash Drawer | Asset | active | Cash-method payments with accountId='1000'; LEGACY_CODE_TO_CANONICAL '1000'→'11110'; only cash drawer candidate | High (operator still to confirm) |
| 2200  | 1 | Cr=1 | 180000 | UNRESOLVED — operator decision required | (none) | (none) | (none) | (none) | (none) | (none) | No account row; no LEGACY map entry; reversal mismatch; most plausive ACC-21300 (Customer Deposits) restoring a wallet payment | Low (do not auto-map) |

Row/amount totals verified against live production data — `public.ledger_entries` (333 rows), `public.accounts`, `public.customer_payments`, `public.invoices`, `public.bank_accounts`.

## 4. Unresolved-reference register (at the time of capture)

| Ref | Ledger rows | Amount (K) | Reason | Required action |
|---|---|---|---|---|
| 2200 | 1 (LG-REV-1791390656850-tednlxm7l) | 180000 | No account row; void path likely wrote a 3-digit legacy code (not 4-digit legacy, not in LEGACY_CODE_TO_CANONICAL); reversal did not restore ACC-21300 on a wallet void | Operator: open void case, decide whether `2200` should be `ACC-21300` (restore deposit liability) or another account; if restored, log under `reversesEntryId` discipline. Do not auto-rewrite. |

`1000` is provisional rather than unresolved — listed above for operator sign-off prior to any migration.

## 5. Proposed migration preconditions & postconditions (no migration applied)

### Preconditions (must be satisfied before any rewrite migration)
1. **Backup/export** all `public.ledger_entries`, `public.accounts`, `public.customer_payments`, `public.invoices`, `public.bank_accounts` rows (via Management API read-only, or SQL dump) before any write.
2. **Operator sign-off** on `1000 → ACC-11110` and explicit decision for `2200` (or explicit exclusion from rewrite scope).
3. **Read-only dry-run preview** query (provided below) showing proposed old→new for each candidate ref and asserting: `old_ref`, `proposed_new`, `row_count`, `total_abs_amount`, and whether a row would become unmatched/multi-asset/multi-equity.
4. Confirm `accounts` catalog has zero rows with `code/account_number` equal to `1000` or `2200` (so the mapping target is unambiguous). Verified: no account has code/number `2200`; only `1000` is absent from accounts (no account).
5. Strip code-side fallback (`LEGACY_CODE_TO_CANONICAL` + `accountMatchesEntry` alias) only after (4) and after production shows 0 unresolved refs — otherwise historical rows become orphaned (irreversible in this envelope DB).

### Dry-run preview SQL (read-only, not applied)
```sql
WITH mapping AS (
  SELECT '11110'::text AS old_ref, 'ACC-11110'::text AS new_ref UNION ALL
  SELECT '11210','ACC-11210' UNION ALL
  SELECT '11220','ACC-11220' UNION ALL
  SELECT '11230','ACC-11230' UNION ALL
  SELECT '31000','ACC-31000' UNION ALL
  SELECT '1000','ACC-11110'
),
targets AS (
  SELECT DISTINCT (data->>'debitAccountId') AS ref, 'debit' AS side FROM public.ledger_entries
  UNION
  SELECT DISTINCT (data->>'creditAccountId') AS ref, 'credit' FROM public.ledger_entries
)
SELECT m.old_ref, m.new_ref, count(*) AS affected_refs
FROM mapping m JOIN targets t ON t.ref=m.old_ref
GROUP BY m.old_ref, m.new_ref;
```
(For `2200`, no mapping row is supplied — preview lists it separately as unresolved.)

### Postconditions (what success looks like; migration still not applied)
- After a future, separately-approved DML: all `ledger_entries.data.debitAccountId` / `creditAccountId` values resolve to canonical account ids.
- Per-account totals on trial balance / balance sheet unchanged except for the orphaned `2200` (180000) being attached to its chosen canonical target on operator decision.
- `resolveAccountForPosting` strict mode (no legacy map) returns a value for every historical reference.
- `accountMatchesEntry` can drop the alias branch (id-only match).
- `LEGACY_CODE_TO_CANONICAL` deprecation: remove after 0 unresolved in production across 2 release cycles.

### Hard stops (do not)
- Do not auto-map `1000` without operator sign-off.
- Do not auto-map `2200` at all (unresolved; data looks manually voided with a non-existent 3-digit code).
- Do not change `reversesEntryId`/`entryType` on historical rows — append a corrective entry instead (reversal semantics).
- Do not strip alias fallbacks before the migration is verified.
- Do not run DML against production; use the Management API runner only for `SELECT`, and only apply migration in a maintenance window with sign-off.

## 4. Confidence summary
- 1000→ACC-11110: **High** (transaction semantics explicit: Cash method, accountId='1000', legacy alias map, unique candidate).
- 11110/11210/11220/11230/31000→ACC-… : **High** (alias, single candidate each, account row verified).
- 2200: **Low / do-not-auto-map** (unresolved, 3-digit non-legacy phantom, void of a wallet payment; plausible target ACC-21300 but not proven).

Stop here for review.

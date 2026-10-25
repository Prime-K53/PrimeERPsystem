# Finance Hardening — Phase 2 Read-Only Account-Reference Diagnostic

**Date:** 2026-10-25 (audit run) · **Project:** rdtuzuzehfbwvfdzqliw · **Mode:** READ-ONLY (no DML, no migration).

## Scope & files inspected
- `frontend/services/transactions/_internal.ts` (LEGACY_CODE_TO_CANONICAL + resolveAccountForPosting)
- `frontend/services/accountingEngine.ts` (accountIdentifiers, entryTouchesAccount)
- `supabase/migrations/0016_accounting_coa_migration.sql`
- `supabase/ops/run-sql.mjs`
- Live DB tables: `public.accounts`, `public.ledger_entries` (envelope id/text + data JSONB + created_at)

## Execution method
Applied queries via `node supabase/ops/run-sql.mjs <file.sql> --each` with `SUPABASE_ACCESS_TOKEN` from the environment (not persisted). All statements were `SELECT` only. Token is not recorded.

## Results

### Ledger scale
- `public.ledger_entries`: 333 rows.

### Distinct account references
- 22 distinct values appear as `debitAccountId` or `creditAccountId` across the ledger.
- 15 resolved by canonical id (`ACC-*`) — CANONICAL_ID.
- 5 resolved only via code alias (`11110`, `11210`, `11220`, `11230`, `31000`) — backed by an account whose `id` differs from its `code`/`account_number`.
- 2 unresolved (matched_count = 0): `1000`, `2200`.

### Unresolved reference details (3 ledger rows)
| id | created_at | debit | credit | description | amount | date |
|---|---|---|---|---|---|---|
| LG-PAY-1789817607332-zqa2stm17 | 2026-09-19 | 1000 | ACC-11310 | Payment #PAY-P726/023 from Chinkhumbe RC School - Status: Partial | 100000 | 2026-07-17 |
| LG-PAY-1789830621031-y7j5vqknj | 2026-09-19 | 1000 | ACC-11310 | Payment #PAY-P726/025 from Makankhula Primary School - Status: Partial | 250000 | 2026-07-23 |
| LG-REV-1791390656850-tednlxm7l | 2026-10-07 | ACC-11310 | 2200 | VOID: Payment #PAY-P726/050 - Invoice INV-P726/098 voided | 180000 | 2026-10-07 |

### Deposit application
- `ledger_entries` rows whose description contains "Deposit application": 0. (New code path `processInvoice` deposit application has not run against production; the cross-invoice double-consumption risk is latent.)
- `ledger_entries` with `VOID:` or `REVERSAL:` descriptions: 47.

### Alias references (5)
Legacy 4-digit refs present in live ledger. Per `_internal.ts` LEGACY_CODE_TO_CANONICAL, three of these are explicitly mapped: `11110←1000`? No — `1000→11110` is in the map; but none of the 5 alias-code refs equals '1000'. So the 5 (11110/11210/11220/11230/31000) are themselves 5-digit numeric codes used as account refs where id is `ACC-…`. These are NOT legacy 4-digit codes; they are the account's own `code`/`account_number` 5-digit value used directly as a ref. `31000` is an alias (id=ACC-31000, code=31000, acctnum=31000) — included because 11240 etc treated as id's but 31000 as code. Actually all five have id≠ref and code=ref, i.e. `a.id = ACC-xxxx` but `a.code = xxxx` and `ref = xxxx` (code). These are 5-digit-only canonical-ish codes used as refs.

### Historical legacy 4-digit refs present (2): `1000`, `2200`.
- `1000` is in `LEGACY_CODE_TO_CANONICAL` (maps to `11110`). Two live rows (cash receipts / Chinkhumbe, Makankhula) reference it. Recommend operator review before rewrite.
- `2200` is not in `LEGACY_CODE_TO_CANONICAL`. It appears only on one VOID reversal credit side; legacy meaning unclear (could be `21300` Customer Deposits or `11210` Bank depending on origin). Requires manual decision — DO NOT auto-map.

## Conclusion
- 22 distinct refs; 20 (90.9%) resolve deterministically via id/code/account_number. 2 refs (3 rows, 0.9% of 333) do not resolve to any account and require operator review.
- No migration or rewrite performed.
- Code alias matching (5-digit code used as id) explains 5 of the 7 non-canonical refs; these are safe to canonicalise via a strict-mode rewrite because their `code/account_number` field on the account row is identical.

## Recommended next step (still read-only)
Approve or reject a dry-run Preview SQL that would list each proposed rewrite side-by-side, using:
- `CASE ref WHEN '1000' THEN 'ACC-11110' WHEN '2200' THEN <operator decision> ELSE 'ACC-'||ref END` for the 5 alias-code + 2 legacy refs, while leaving `11240`/`ACC-*` rows unchanged. No changes applied until approved.

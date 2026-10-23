# 0048 — Deployment checklist, reconciliation queries and rollback plan

Companion to `0048_printing_contracts_server_atomicity.sql`.

> ## APPLIED — live project `rdtuzuzehfbwvfdzqliw` (PostgreSQL 17.6)
>
> **Step 1 — anonymous exposure closed.** `supabase/ops/revoke_anon_contract_rpcs.sql`
> applied; all six contract functions now return `401 / 42501 permission denied
> for function …` to the `anon` key and still reach their bodies with the
> service-role key.
>
> **Step 2 — 0048 applied.** Rehearsed first in a single transaction that was
> rolled back (`BEGIN; <migration>; <8 assertions>; ROLLBACK;`) — it applied
> cleanly on PostgreSQL 17.6 in the live schema with all assertions holding and
> no net effect. Then applied for real with the same assertions in the same
> transaction (`BEGIN; <migration>; <8 assertions>; COMMIT;`).
>
> Post-apply state, read back from `pg_proc`:
>
> | function | SECURITY DEFINER | search_path | anon | authenticated | service_role |
> |---|---|---|---|---|---|
> | `consume_contract_assessment_atomic` | yes | `pg_catalog, public, pg_temp` | false | false | **true** |
> | `reserve_contract_assessment_atomic` | yes | `pg_catalog, public, pg_temp` | false | false | **true** |
> | `resolve_posting_account` (new) | yes | `pg_catalog, public, pg_temp` | false | false | **true** |
> | `is_contract_date_in_closed_fy` | no | `pg_catalog, public, pg_temp` | false | false | **true** |
> | `is_contract_date_in_closed_period` (new) | no | `pg_catalog, public, pg_temp` | false | false | **true** |
> | `current_erp_rpc_role` (new) | no | `pg_catalog, public, pg_temp` | false | false | **true** |
>
> Verified after the apply: `resolve_posting_account('21300')` → `ACC-21300`,
> `resolve_posting_account('41100')` → `ACC-41100`; both closed-period gates
> resolve without blocking; R1–R6 return no discrepancies; the backend route's
> health probe still reports `rpcDeployed: true`; the empty-id guards and the
> "not found" classification behave exactly as before.
>
> **No business data was written.** The migration creates functions and grants
> only — no table, column, index, trigger, policy or row.
>
> **One deployment-relevant incompatibility was found and fixed during the
> rehearsal:** the deployed `is_contract_date_in_closed_fy` returns
> `TABLE(fy_id, fy_name)`, and both deployed RPCs call it as a table. The
> revision had changed it to a scalar `BOOLEAN`, which `CREATE OR REPLACE`
> refuses outright (`42P13: cannot change return type of existing function`).
> The deployed contract is now preserved exactly; only the body is hardened.
>
> **The end-to-end issuance → payment → assessment consumption flow was NOT
> exercised on production**, because that would write real financial records.
> It was exercised against a database shaped like the live project (envelope
> tables, `ACC-`-prefixed COA, the live FY record, the Supabase roles) — see
> §9 — and against a real PostgreSQL by the concurrency suite.


---

## 1. What this migration changes

| Object | Change |
|---|---|
| `public.current_erp_rpc_role()` | new helper — the verified JWT role of the current request |
| `public.is_contract_date_in_closed_fy(DATE)` | rewritten — the **deployed `TABLE(fy_id, fy_name)` contract is preserved** (a scalar BOOLEAN would be a breaking change: `CREATE OR REPLACE` refuses it with 42P13); the body is hardened: robust `is_closed` parsing and guarded date casts |
| `public.is_contract_date_in_closed_period(DATE)` | **new** — the settings-backed `financial_closed_periods` registry, same set-returning shape as the year gate |
| `public.reserve_contract_assessment_atomic(...)` | rewritten — server authorization, fresh-item guard, entitlement under lock, allocation semantics |
| `public.consume_contract_assessment_atomic(...)` | rewritten — server authorization, real idempotency (insert result inspected), canonical coverage rule, deterministic duplicate guard |
| grants | `EXECUTE` moved from `authenticated, service_role` to **`service_role` only**; `PUBLIC/anon/authenticated` revoked |

No table, column, index or row is created, altered or dropped.

---

## 2. Pre-deployment checklist

- [ ] **Backup.** Take a fresh managed backup and record the restore point.
- [ ] **Confirm the 0048 chain is applied.** `0006`, `0019`, `0039` must be in place
      (`SELECT * FROM supabase_migrations.schema_migrations ORDER BY version;`).
- [ ] **Confirm `public.settings` exists** (the closed-period registry is read
      from it):
      ```sql
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='settings'
      ORDER BY ordinal_position;
      ```
- [ ] **Confirm the envelope shape of `idempotency_keys`.** The RPC writes only
      `id`, `data`, `created_at`, `updated_at`, `version` — it does **not** use
      the `result` column, so the replay payload lives in `data->'result'`.
      ```sql
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='idempotency_keys'
      ORDER BY ordinal_position;
      ```
- [ ] **Confirm the chart of accounts.** The consumption posts Dr `21300`
      (Customer Deposits) / Cr `41100` (Assessment Revenue). 0048 **resolves
      these codes against the `accounts` envelope** (the deployed account ids
      are prefixed — `ACC-21300` / `ACC-41100` — with the code in
      `data->>'code'` / `data->>'account_number'`), and refuses to post if an
      account is missing, inactive or does not allow posting. Verify the
      accounts exist and are postable:
      ```sql
      SELECT id, data->>'code' AS code, data->>'name' AS name,
             data->>'account_type' AS type, data->>'normal_balance' AS normal,
             data->>'is_active' AS active, data->>'allow_posting' AS posting
      FROM public.accounts
      WHERE data->>'code' IN ('21300','41100')
         OR data->>'account_number' IN ('21300','41100');
      -- EXPECTED: 2 rows — one whose resolved id is used as the debit
      -- account, one as the credit account.
      ```
      If either account is missing, **stop** — 0048 fails closed rather than
      posting to a wrong account.
- [ ] **Confirm no other caller needs `authenticated` EXECUTE.** The only
      caller is `backend/routes/printingContracts.cjs`, which uses the
      service-role key. A direct `supabase.rpc('consume_contract_assessment_atomic')`
      from the browser would stop working — that is intended.
- [ ] **Stale grants.** If the draft was ever applied anywhere, the old
      `GRANT ... TO authenticated` may still exist. The new migration revokes
      it, but verify afterwards (step 5).
- [ ] **Accept the replay-contract change.** A repeat of an accepted operation
      now returns the original result instead of raising `DUPLICATE`. The
      browser client (`frontend/services/contractServerClient.ts`) has no
      production caller yet, so no live behaviour changes.

---

## 3. Deployment steps

```bash
# 1. Apply in a transaction so a failure leaves nothing behind.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f supabase/migrations/0048_printing_contracts_server_atomicity.sql

# 2. Confirm all five functions exist.
psql "$DATABASE_URL" -c "
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('consume_contract_assessment_atomic',
                    'reserve_contract_assessment_atomic',
                    'is_contract_date_in_closed_fy',
                    'is_contract_date_in_closed_period',
                    'current_erp_rpc_role')
ORDER BY p.proname;"

# 3. Smoke-test the health probe (proves the function is deployed).
curl -sS -H "Authorization: Bearer $TOKEN" \
  http://localhost:5000/api/printing-contracts/health
```

The migration is idempotent (`CREATE OR REPLACE` + `CREATE OR REPLACE GRANT`),
so re-running it is safe.

---

## 4. Post-deployment verification

```sql
-- 4a. EXECUTE is granted to service_role only.
SELECT p.proname, has_function_privilege('service_role', p.oid, 'EXECUTE')  AS to_service,
       has_function_privilege('authenticated', p.oid, 'EXECUTE')            AS to_authenticated,
       has_function_privilege('anon', p.oid, 'EXECUTE')                    AS to_anon
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
                    'is_contract_date_in_closed_fy','is_contract_date_in_closed_period',
                    'current_erp_rpc_role')
ORDER BY p.proname;
-- EXPECTED: to_service = true, to_authenticated = false, to_anon = false

-- 4b. The functions are SECURITY DEFINER with a pinned search_path.
SELECT p.proname, p.prosecdef AS security_definer, p.proconfig AS settings
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname='public'
  AND p.proname LIKE '%contract_assessment_atomic%';
-- EXPECTED: security_definer = true, settings contains search_path=pg_catalog, public, pg_temp
```

---

## 5. Post-deployment reconciliation queries

Run these before and after any consumption activity, and again after a
reconciliation cycle. They compare the wallet against the ledger.

```sql
-- R1. Every assessment consumption has exactly one wallet debit AND one
--     ledger posting, for the same amount, on the same item.
SELECT wt.data->>'assessment_item_id' AS item_id,
       COUNT(DISTINCT wt.id)          AS wallet_rows,
       COUNT(DISTINCT le.id)          AS ledger_rows,
       SUM((wt.data->>'amount')::numeric) AS wallet_total,
       SUM((le.data->>'amount')::numeric) AS ledger_total
FROM public.wallet_transactions wt
LEFT JOIN public.ledger_entries le ON le.id = 'LG-' || wt.id
WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
GROUP BY 1
HAVING COUNT(DISTINCT wt.id) <> 1
    OR COUNT(DISTINCT le.id) <> 1
    OR SUM((wt.data->>'amount')::numeric) <> SUM((le.data->>'amount')::numeric);
-- EXPECTED: 0 rows

-- R2. The ledger legs are the canonical Dr 21300 / Cr 41100 pair.
SELECT le.data->>'debitAccountId'  AS debit,
       le.data->>'creditAccountId' AS credit,
       COUNT(*) AS n
FROM public.ledger_entries le
WHERE le.data->>'referenceId' IN (
        SELECT wt.data->>'assessment_item_id'
        FROM public.wallet_transactions wt
        WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION')
GROUP BY 1,2;
-- EXPECTED: a single row  debit=21300, credit=41100

-- R3. The customer's wallet balance equals the opening balance minus the
--     total consumption debits (per customer).
SELECT c.id,
       (c.data->>'walletBalance')::numeric AS wallet_balance,
       COALESCE(SUM((wt.data->>'amount')::numeric), 0) AS consumed_total
FROM public.customers c
LEFT JOIN public.wallet_transactions wt
       ON wt.data->>'customer_id' = c.id
      AND wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
GROUP BY c.id, c.data->>'walletBalance'
ORDER BY c.id;
-- COMPARE against the expected balance; a mismatch means a wallet debit
-- happened without its ledger entry (or the reverse).

-- R4. Contract buckets equal the sum of their assessment items.
SELECT ct.id,
       (ct.data->>'reserved_amount')::numeric AS reserved_bucket,
       (ct.data->>'consumed_amount')::numeric AS consumed_bucket,
       COALESCE(SUM((ai.data->>'item_price')::numeric)
                FILTER (WHERE ai.data->>'status' = 'reserved'), 0) AS reserved_items,
       COALESCE(SUM((ai.data->>'item_price')::numeric)
                FILTER (WHERE ai.data->>'status' = 'consumed'), 0) AS consumed_items
FROM public.assessment_contracts ct
LEFT JOIN public.assessment_contract_items ai ON ai.data->>'contract_id' = ct.id
GROUP BY ct.id, ct.data->>'reserved_amount', ct.data->>'consumed_amount'
ORDER BY ct.id;
-- EXPECTED: reserved_bucket >= reserved_items and consumed_bucket = consumed_items
--   (the bucket is the healing value: max(stored, price) - price, so it can
--    exceed the item sum for rows created before reservation accounting)

-- R5. No assessment is consumed without a wallet transaction.
SELECT ai.id
FROM public.assessment_contract_items ai
WHERE ai.data->>'status' = 'consumed'
  AND NOT EXISTS (
        SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.id = 'WTX-' || ai.id || '-CONSUMED');
-- EXPECTED: 0 rows

-- R6. No idempotency key claims a result that no wallet transaction backs.
SELECT k.id, k.data->>'item_id'
FROM public.idempotency_keys k
WHERE k.data->>'scope' = 'contract_assessment_consume'
  AND k.data->>'status' = 'succeeded'
  AND NOT EXISTS (
        SELECT 1 FROM public.wallet_transactions wt
        WHERE wt.id = 'WTX-' || (k.data->>'item_id') || '-CONSUMED');
-- EXPECTED: 0 rows
```

---

## 6. Rollback plan

### 6a. Reverting the SCHEMA (safe, no business data involved)

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/0048_printing_contracts_server_atomicity.rollback.sql
```

That drops the five functions and their grants, inside a transaction.
Verify:

```sql
SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.proname IN
 ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
  'is_contract_date_in_closed_fy','is_contract_date_in_closed_period','current_erp_rpc_role');
-- EXPECTED: 0
```

### 6b. Reversing BUSINESS DATA is a different operation

Rows already written by these RPCs are ordinary financial records:

* `wallet_transactions` where `data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'`
* `ledger_entries` where `id = 'LG-WTX-<item>-CONSUMED'`
* `assessment_contract_items` where `data->>'status' = 'consumed'`
* `assessment_contracts` whose `consumed_amount` was advanced
* `idempotency_keys` where `data->>'scope' = 'contract_assessment_consume'`

**Never remove them.** Reverse them with compensating entries:

| Original | Compensating reversal |
|---|---|
| `Dr 21300 / Cr 41100` (ledger) | `Dr 41100 / Cr 21300` (same amount, same item reference) |
| wallet debit | wallet credit of the same amount, `type = 'Deposit'` |
| item `consumed` | back to `reserved` **only if no later assessment depends on it** |
| contract `consumed_amount` | reduced by the reversed amount; `reserved_amount` restored |

Procedure (human-approved, after running the reconciliation queries in §5):

1. Run R1R6 and record the baseline.
2. Identify the exact assessments to reverse (one contract / one period).
3. Post the reversing ledger entry and wallet credit in ONE transaction.
4. Restore the item and contract buckets in the SAME transaction.
5. Re-run R1R6 and confirm the baseline is restored.
6. Only then consider applying §6a.

The rollback file contains a commented template of steps 15. It is
intentionally not executable as written.

---

## 7. Deployment blockers found against the live project (read-only inspection)

Project ref `rdtuzuzehfbwvfdzqliw`. **Nothing was written** during the
inspection. These were the findings; **B1–B4 and B8 are resolved** by the
remediation plus the 0048 apply (see the header), and **B5–B7 remain open**.

| # | Finding | Consequence for this deployment |
|---|---|---|
| B1 | The **draft** of 0048 is already **deployed** to the live project (its functions are in the live PostgREST schema and its error wording matches the draft), despite the header saying "NOT APPLIED TO PRODUCTION" | The header is wrong; the deployment register must be the source of truth. **Applying the corrected 0048 is an in-place upgrade, not a first install.** — **RESOLVED**: the corrected 0048 is now deployed and the header corrected. |
| B2 | The draft **never revoked EXECUTE from `PUBLIC`**, so the two money-moving RPCs are executable by **`anon`** (confirmed by live probe) | **CRITICAL, live.** 0048 closes it (`REVOKE ... FROM PUBLIC, anon, authenticated`). RESOLVED: the interim revoke was applied to all six functions (anon/authenticated/PUBLIC all false), then 0048 was applied. |
| B3 | The deployed account ids are **prefixed** (`ACC-21300`), not the bare codes | RESOLVED: 0048 resolves the codes against the COA (`resolve_posting_account`); verified live, `resolve_posting_account('21300')` returns `ACC-21300`. |
| B4 | The live `financial_closed_periods` registry is **absent** | `is_contract_date_in_closed_period` returns false — no false blocks. The FY gate still applies (live `FY2026` is open, `is_closed=0`). |
| B5 | `verify_payment_and_activate_contract` and `create_assessment_contract` are granted to **`anon`** | Pre-existing, same domain, **not** modified by 0048. See the security assessment F2/F3. |
| B6 | `customers`, `wallet_transactions`, `ledger_entries`, `idempotency_keys`, `settings`, `financial_years` carry `allow_all_*` RLS for `authenticated` | Pre-existing and systemic. 0048 *depends* on `idempotency_keys` and `financial_years` being un-writable by portal customers. See the security assessment F5. |
| B7 | The live schema contains functions that are **not in the migration chain** (e.g. `rls_auto_enable`, `erp_backfill_variant_identity`, `consume_assessment_items`, `reserve_assessment_items`, `approve_examination_v2_batch`) | The chain is no longer a complete record of the live schema, so "what is deployed" can only be answered from the project itself. The deployment register (§8) must record what is actually applied. |
| B8 | RESOLVED — the live functions' `proowner` / `proconfig` were read through the Management API, and 0048 re-created all six with `SECURITY DEFINER` (where required), a pinned `search_path`, and an explicit grant set. | The observable behaviour was verified (anon executes the function bodies). The corrected 0048 re-creates all six functions with `SECURITY DEFINER`, a pinned `search_path` and an explicit grant set, which normalises the state on apply. |

## 8. Staging runbook (ready; no staging target configured)

> **UPDATE (live project `rdtuzuzehfbwvfdzqliw`):** the anonymous EXECUTE
> exposure (F1–F4) has already been **remediated** on the live project with
> `supabase/ops/revoke_anon_contract_rpcs.sql` — verified: all six functions
> now return `401 / 42501 permission denied for function …` to the anon key
> and still reach their bodies with the service-role key. See the security
> assessment §2.1 for the before/after grant table.
>
> **0048 itself is still NOT applied** — the live project still runs the
> draft, with `search_path=public` and no in-function role check. The
> runbook below remains the way to apply the corrected version.

**There is no staging Supabase project in this repository.** One project ref
appears anywhere (`rdtuzuzehfbwvfdzqliw`, described by the migration chain as
the LIVE project), and there is a single Render service, a single Fly app
(`prime-erp-backend`, `NODE_ENV=production`) and a single Netlify site — no
staging tier. Deploying 0048 to that project would be a **production
deployment**, which is out of scope. The runbook is therefore rehearsed locally
(see §11) and is ready to run unchanged against a staging project.

```bash
# 0. Confirm the target is staging, not production.
#    Expected: a project ref that is NOT the live one, and a backup taken
#    from THAT project in the last hour.
echo "TARGET SUPABASE_URL=$SUPABASE_URL"
supabase db dump --db-url "$SUPABASE_URL" -f "backup-$(date +%Y%m%dT%H%M%SZ).sql"

# 1. Apply (single transaction; idempotent).
psql "$SUPABASE_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -f supabase/migrations/0048_printing_contracts_server_atomicity.sql

# 2. Verify the deployment: function inventory, ownership, grants, the
#    posting accounts, both closed-period gates, and reconciliation R1-R6.
psql "$SUPABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/ops/verify_0048_deployment.sql
```

### Operator scripts (all dry-run verified)

| Script | Purpose |
|---|---|
| `supabase/ops/revoke_anon_contract_rpcs.sql` | Removes the anonymous EXECUTE on the six contract functions (the live exposure). Idempotent, catalogue-resolved signatures, prints what it changed. |
| `supabase/ops/revoke_anon_contract_rpcs.rollback.sql` | Restores the exact previous grant set. |
| `supabase/ops/verify_0048_deployment.sql` | Post-apply verification: functions, ownership, `SECURITY DEFINER`, pinned `search_path`, grants, account resolution, both closed-period gates, and R1–R6. Read-only. |
| `supabase/migrations/0048_…DEPLOYMENT.md` | This document — checklist, runbook, reconciliation queries, rollback plan. |
| `supabase/migrations/0048_…SECURITY-ASSESSMENT.md` | The RLS / grants assessment for the envelope tables (not applied). |

Run any of them in the **Supabase dashboard → SQL Editor**, or with `psql`
against the project. All three were executed end-to-end against a real
PostgreSQL 16.4: the revoke was proven to flip `anon`/`authenticated` to
`false` while `service_role` stays `true`, to be idempotent on a second run,
and to be exactly reversible by the rollback script.


## 9. Staging rehearsal - EXECUTED locally against a live-shaped database

The runbook was rehearsed against a local PostgreSQL 16.4 whose schema mirrors
the live project (envelope tables, `ACC-`-prefixed COA, the live FY record
shape, the Supabase roles). Output:

```
STEP 1  0048 applied to the live-shaped schema
STEP 2  reserve -> {"success":true,"contractId":"PC-REHEARSAL","reservedAmount":2000,"assessmentCount":2}
STEP 3  consume -> {"success":true,"replayed":false,"newBalance":4000,
                    "walletTransactionId":"WTX-A-REHEARSAL-2-CONSUMED",
                    "ledgerEntryId":"LG-WTX-A-REHEARSAL-2-CONSUMED"}
R1  0 rows   (every consumption has exactly one debit + one ledger row, same amount)
R2  1 row    {"debit":"ACC-21300","credit":"ACC-41100","n":"1"}
R3  1 row    {"wallet_balance":"4000.00","consumed_total":"1000"}   (5000 - 1000)
R4  1 row    {"reserved_bucket":"1000","consumed_bucket":"1000",
              "reserved_items":"1000","consumed_items":"1000"}
R5  0 rows   (no assessment consumed without its wallet transaction)
R6  0 rows   (no idempotency key claims a result no wallet transaction backs)
STEP 5  consume/reserve/resolve_posting_account/fy gates:
        service_role=true  authenticated=false  anon=false
STEP 6  schema rollback -> 0 functions left;
        business rows UNTOUCHED: {wallet_rows:1, ledger_rows:1, consumed_items:1}
```

R1R6 are the **verbatim** queries from §5 of this document, so the
reconciliation SQL itself is validated, not just the migration.


## 7a. Schema assumptions that could NOT be verified

* The `allow_all_*` RLS policies on `customers`, `wallet_transactions`,
  `ledger_entries` and `idempotency_keys` are **pre-existing and untouched**
  by this migration. A portal customer can already read and write those
  tables directly through PostgREST. The migration removes the RPC from
  that role, but the underlying table exposure is a separate, pre-existing
  risk that needs its own decision.
* The live database's `assessment_contracts` rows are assumed to carry
  `reserved_amount` / `consumed_amount` / `max_assessments` inside the
  envelope `data` (as the frontend writes them). The top-level SQL columns
  of the same name are legacy since migration 0039 and are **not** updated
  by these RPCs; the generated `available_funds` column therefore stays
  stale for envelope-written rows.
* `idempotency_keys.result` exists in the baseline schema but is **not used**
  by this migration (the replay payload lives in `data->'result'`), so the
  function also works against the minimal table shape used by the live
  integration test.
* The account ids are **resolved from the chart of accounts by code**, not
  hardcoded. Verified against the LIVE project: the account ids are prefixed
  (`ACC-21300`, `ACC-41100`) and the code lives in `data->>'code'` /
  `data->>'account_number'`. The resolver fails closed if an account is
  missing, inactive, or does not allow posting.
* The migration requires the Supabase roles `service_role`, `anon` and
  `authenticated` to exist. A vanilla PostgreSQL does not have them and the
  GRANT statements will fail there. Both database test suites create them
  first, which mirrors the target environment.

---

## 10. What was actually verified, and how


Everything below was EXECUTED. Nothing is claimed on the strength of a
static read.

| Check | How | Result |
|---|---|---|
| 0048 compiles and creates all five functions | real PostgreSQL 16.4 | **PASS** |
| EXECUTE is `service_role` only (`authenticated`/`anon` revoked) | real PostgreSQL | **PASS** |
| SECURITY DEFINER + pinned `search_path` | real PostgreSQL | **PASS** |
| A consumption posts exactly one wallet debit + one ledger row, Dr 21300 / Cr 41100, reconciled, and moves the contract buckets | real PostgreSQL | **PASS** |
| A replay returns the ORIGINAL result and never debits twice | real PostgreSQL | **PASS** |
| A conflicting key on a consumed assessment is refused | real PostgreSQL | **PASS** |
| A rejected consume leaves ZERO partial writes (wallet, ledger, item **and** the idempotency key row) | real PostgreSQL | **PASS** |
| A closed financial year rejects on the BUSINESS date | real PostgreSQL | **PASS** |
| The settings-backed closed-period registry rejects too | real PostgreSQL | **PASS** |
| `authenticated` and `anon` callers are refused with `UNAUTHORIZED`; `service_role` is accepted | real PostgreSQL | **PASS** |
| Entitlement limit, item freshness, invalid price, item/contract linkage, contract lifecycle, item status, coverage rule | real PostgreSQL | **PASS** |
| Wallet/ledger reconciliation, no orphan consumption, no phantom idempotency key | real PostgreSQL | **PASS** |
| The rollback companion removes every function; 0048 re-applies cleanly | real PostgreSQL | **PASS** |
| HTTP authorization (401 unauthenticated, 403 portal customer, admin reaches the RPC) | jest + supertest | **PASS** |
| Server failure markers stay machine-classifiable (DUPLICATE / CLOSED_PERIOD / INSUFFICIENT / lifecycle / entitlement) | jest + supertest | **PASS** |
| The replay result is surfaced as `accepted` with the original payload | jest + supertest | **PASS** |
| Every identifier the RPCs use exists in the migration chain; signatures match every call site | jest (static) | **PASS** |

**26 database scenarios + 4 route/contract suites: 107 passed, 18 skipped.**

The 18 skipped tests are the multi-connection concurrency suite
(`printingContractsConcurrency.integration.test.cjs`): this host cannot fork
PostgreSQL client backends (0xC0000142, DLL init failure), so it skips
cleanly. It is the ONLY thing not exercised, and it covers exactly one
property: that two simultaneous sessions cannot overspend a wallet. The
single-session equivalent (the coverage rule refusing an underfunded
wallet) IS verified above.

`backend/tests/printingContractsSingleUser.integration.test.cjs` runs the
same scenarios through `postgres --single`, which works on this host, and
is the suite that produced the PASS column above. It initialises its own
throwaway cluster under the OS temp directory and never touches any
existing database. Point `POSTGRES_BIN` at a PostgreSQL binaries directory
to run it; without one it skips with an explicit reason.


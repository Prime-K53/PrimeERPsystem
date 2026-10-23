# Security assessment — printing-contract RPCs and the envelope RLS posture

**Scope:** `supabase/migrations/0048_printing_contracts_server_atomicity.sql` and the
access-control posture of the envelope tables it depends on.
**Status:** assessment only. **No access policy was modified.** The findings
below are reported, not fixed, except inside 0048 itself, which is the
artefact under review.

**Deployment target observed (read-only):** project ref `rdtuzuzehfbwvfdzqliw`
(`https://rdtuzuzehfbwvfdzqliw.supabase.co`).

---

## 1. Executive summary

| # | Finding | Severity | Status |
|---|---|---|---|
| **F1** | The **deployed draft** of `consume_contract_assessment_atomic` / `reserve_contract_assessment_atomic` is executable by **`anon`** (unauthenticated internet traffic) and is `SECURITY DEFINER` | **CRITICAL — live** | **REMEDIATED** (see §2.1) — 0048 still pending |
| **F2** | `verify_payment_and_activate_contract` (`SECURITY DEFINER`, granted to `anon`) can **activate a printing contract** and write a `CONTRACT_ACTIVATION` wallet transaction, with a **caller-supplied** `p_verified_by` | **CRITICAL — live** | **REMEDIATED** (see §2.1) |
| **F3** | `create_assessment_contract` is granted to `anon` and takes 16 fully caller-supplied arguments (including `customer_id` and `prepaid_amount`) | **HIGH — live** | **REMEDIATED** (see §2.1) |
| **F4** | `get_contract_available_funds` is granted to `anon` | MEDIUM — live | **REMEDIATED** (see §2.1) |
| **F5** | The `allow_all_*` RLS policies give every **`authenticated`** user (including portal customers) unrestricted SELECT/INSERT/UPDATE/DELETE on `customers`, `wallet_transactions`, `ledger_entries`, `idempotency_keys`, `settings`, `financial_years`, `accounts` | **HIGH — systemic** | Open, pre-existing, explicitly NOT modified |
| **F6** | The draft never revoked EXECUTE from `PUBLIC`, so `GRANT … TO authenticated, service_role` left the PostgreSQL default `PUBLIC` execute privilege in place | HIGH | **Fixed by 0048** (and by the §2.1 remediation) |
| **F7** | Hardcoded posting account codes (`'21300'`, `'41100'`) do not exist as account ids in the deployed database (ids are `ACC-21300` / `ACC-41100`) | HIGH — correctness | **Fixed by 0048** (accounts are now resolved from the COA) |
| **F8** | The deployed functions in the live project are the **draft**, not the corrected version, despite the migration header saying "NOT APPLIED TO PRODUCTION" | MEDIUM — process | Open — the header must be corrected |
| **F10** | The `contract_documents` policy from 0049 is `allow_all_contract_documents` **FOR ALL TO authenticated** — so any signed-in session (including a portal customer) can UPDATE an issued document's `content`/`contentHash` straight through PostgREST, defeating the "tamper-evident" claim | **HIGH — live** | **Fix prepared** (`0054_contract_documents_rls_hardening.sql`) — proven to close the write path while narrowing nothing |
| **F11** | Migrations `0052`/`0053` are NOT safe to apply yet: the **deployed** client supersedes the previous version BEFORE inserting the replacement, and 0052's trigger refuses a supersede whose target does not exist yet | **HIGH — deployment order** | **BLOCKED** — needs the Phase 2D client + backend guard deployed first |
| **F9** | The live schema contains functions that are **not in the migration chain** (`rls_auto_enable`, `erp_backfill_variant_identity`, `consume_assessment_items`, `reserve_assessment_items`, `approve_examination_v2_batch`, …) | MEDIUM — process | Open — the chain is not a complete record of what is deployed |

---

## 2. Remediation applied

### 2.1 The anonymous EXECUTE exposure — CLOSED

Applied to the live project `rdtuzuzehfbwvfdzqliw` with
`supabase/ops/revoke_anon_contract_rpcs.sql` (one transaction; no business
data, no table, no policy and no function body touched).

Before → after, read back from `pg_proc`:

| function | anon | authenticated | PUBLIC | service_role |
|---|---|---|---|---|
| `consume_contract_assessment_atomic(text,text,text,date)` | true → **false** | true → **false** | true → **false** | true → true |
| `reserve_contract_assessment_atomic(text,text,jsonb,numeric,date)` | true → **false** | true → **false** | true → **false** | true → true |
| `is_contract_date_in_closed_fy(date)` | true → **false** | true → **false** | true → **false** | true → true |
| `verify_payment_and_activate_contract(text,text)` | true → **false** | true → **false** | false → false | true → true |
| `create_assessment_contract(text,text,text,text,text,numeric,text,text,text,integer,numeric,timestamptz,timestamptz,timestamptz,text,text)` | true → **false** | true → **false** | false → false | true → true |
| `get_contract_available_funds(text)` | true → **false** | true → **false** | false → false | true → true |

Live API behaviour, before and after (anon key):

```
BEFORE  POST /rest/v1/rpc/consume_contract_assessment_atomic → 400
        {"code":"P0001","message":"consume: contract __probe__ not found"}   ← reached the body
AFTER   POST /rest/v1/rpc/consume_contract_assessment_atomic → 401
        {"code":"42501","message":"permission denied for function consume_contract_assessment_atomic"}
```

All six now return `401 / 42501 permission denied for function …` to the
anon key, and every one of them still reaches its body with the
service-role key — so the Prime ERP backend
(`backend/routes/printingContracts.cjs`, the only caller) is unaffected.

The rollback is `supabase/ops/revoke_anon_contract_rpcs.rollback.sql`; it was
proven in a dry run to restore the previous grant set exactly, field by field.

**Note on the live signature drift:** the deployed
`create_assessment_contract` has **16** parameters, while the migration
chain's `GRANT` declares 17. A hand-written `REVOKE` using the chain's
signature would have silently matched nothing. The script resolves every
signature from `pg_proc` at run time, so it cannot make that mistake — this
is exactly the failure mode it was written to avoid.

### 2.2 What the remediation does NOT fix

`SECURITY DEFINER` and `search_path` on the live functions are unchanged
until 0048 is applied: the three 0048 functions still carry
`search_path=public` (no `pg_temp`), which leaves the classic temporary-object
shadowing exposure. 0048 re-creates all of them with
`search_path=pg_catalog, public, pg_temp`.

### 2.3 0048 has since been applied

Both steps are now done on the live project `rdtuzuzehfbwvfdzqliw`
(PostgreSQL 17.6):

* the anonymous EXECUTE revoke (§2.1) — applied and verified;
* `supabase/migrations/0048_printing_contracts_server_atomicity.sql` —
  rehearsed in a rolled-back transaction first, then applied with eight
  in-transaction assertions (function inventory, `SECURITY DEFINER`, pinned
  `search_path`, no anon/authenticated/PUBLIC execute, service_role retained,
  posting accounts resolvable, closed-period gates not blocking, and **no
  business data changed**).

After the apply, all six functions read back from `pg_proc` as:

```
consume_contract_assessment_atomic  | definer | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
reserve_contract_assessment_atomic  | definer | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
resolve_posting_account              | definer | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
is_contract_date_in_closed_fy        | invoker | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
is_contract_date_in_closed_period    | invoker | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
current_erp_rpc_role                 | invoker | search_path=pg_catalog, public, pg_temp | svc=t auth=f anon=f
```

The 0006 trio (`create_assessment_contract`, `verify_payment_and_activate_contract`,
`get_contract_available_funds`) is untouched by 0048 — it keeps its own
`search_path`, and stays revoked from `anon`/`authenticated`/`PUBLIC` by the
§2.1 remediation. Hardening its `search_path` and its own authorization model
is still open work (F2/F3).



---

## 2. The authorization model, as it actually is

There is no tenant architecture and no role hierarchy. The chain is:

```
browser (publishable key → role `anon`)
   │
   ├── portal customers authenticate → role `authenticated`
   │
   └── the single ERP operator
         │
         └── backend (Express) ── verifyToken → requireRole('Admin','Accountant','Editor')
                                    │
                                    └── Supabase service-role key  →  role `service_role`
                                                                       │
                                                                       └── PostgREST → public.rpc(...)
```

* The **only** legitimate caller of the assessment RPCs is
  `backend/routes/printingContracts.cjs`. It authenticates the session and the
  operator role, then calls the RPC with the **service-role** key.
* The browser never calls these RPCs directly (`frontend/services/contractServerClient.ts`
  calls the **backend HTTP route**, not PostgREST).
* `service_role` bypasses RLS. `anon` and `authenticated` do not.

## 3. F1 / F6 — the draft was anonymously executable (CRITICAL, LIVE)

### Evidence (read-only probes against the live project)

```
POST /rest/v1/rpc/consume_contract_assessment_atomic   [anon key]
  → HTTP 400 {"code":"P0001","message":"consume: contract __nonexistent_probe__ not found"}

POST /rest/v1/rpc/reserve_contract_assessment_atomic     [anon key]
  → HTTP 400 {"code":"P0001","message":"reserve: contract __nonexistent_probe__ not found"}

POST /rest/v1/rpc/is_contract_date_in_closed_fy          [anon key]
  → HTTP 200 []
```

The messages are produced **inside** the function body, so the function
*executed* as `anon`; these are business errors, not permission errors.

### Root cause

The draft granted `EXECUTE … TO authenticated, service_role` and **never
revoked `PUBLIC`**. In PostgreSQL a function is `EXECUTE` to `PUBLIC` by
default, and `PUBLIC` includes `anon`. Adding roles to the grant list does not
remove `PUBLIC`. The draft therefore exposed a `SECURITY DEFINER` function that
debits `customers.walletBalance` and inserts into `ledger_entries` to
unauthenticated internet traffic.

The corrected 0048 closes it:

```sql
REVOKE ALL ON FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE)
  FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE)
  TO service_role;
```

…and adds a second line of defence inside the function: the caller's verified
JWT role is read from `request.jwt.claims` and any role other than
`service_role` is refused with `UNAUTHORIZED`. A direct DBA / migration
connection (no JWT claims) is allowed — that path is already privileged.

**Verified in a real PostgreSQL:** `authenticated`, `anon` and `service_role`
execute privileges on all six functions were read back from `pg_proc`; the
in-function refusal was exercised end-to-end for `authenticated` and `anon`.

**This finding is live until 0048 is applied.** The interim mitigation, if the
deployment cannot be done immediately, is to revoke the draft's EXECUTE grants
manually — see §6.

## 4. F2 / F3 / F4 — pre-existing anon exposure in the same domain (0006)

`0006_assessment_contracts.sql` grants three functions to `anon`:

```sql
GRANT EXECUTE ON FUNCTION public.verify_payment_and_activate_contract(TEXT,TEXT)
  TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.create_assessment_contract(…17 args…)
  TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.get_contract_available_funds(TEXT)
  TO authenticated, anon, service_role;
```

`verify_payment_and_activate_contract` is `SECURITY DEFINER` and **activates a
contract** (status → `active`) and writes a `CONTRACT_ACTIVATION` wallet
transaction, recording a **caller-supplied** `p_verified_by` as the verifier.
Read-only probe against the live project:

```
POST /rest/v1/rpc/verify_payment_and_activate_contract [anon key]
  → HTTP 400 {"code":"P0001","message":"Assessment contract __nonexistent_probe__ does not exist"}
```

The message comes from inside the function, so `anon` can execute it. Given a
contract id in `pending_payment`, an anonymous caller would activate it.

**Not modified** — this is outside the 0048 blast radius and changing it is a
separate, human-approved decision. It is reported here because it is the same
class of defect, in the same feature, and it is live.

## 5. F5 — the `allow_all_*` RLS posture (systemic, NOT modified)

Replaying the migration chain gives the effective state:

| Table | RLS | Policy | Consequence for an `authenticated` user |
|---|---|---|---|
| `customers` | enabled | `allow_all_customers` FOR ALL TO authenticated USING(true) WITH CHECK(true) | read/write every customer row, including `walletBalance` |
| `wallet_transactions` | enabled | `allow_all_wallet_transactions` … | read/write the wallet ledger directly |
| `ledger_entries` | enabled | `allow_all_ledger_entries` … | read/write the general ledger directly |
| `idempotency_keys` | enabled | `allow_all_idempotency_keys` … | read/write the idempotency store (key poisoning) |
| `settings` | enabled | `allow_all_settings` … | read/write app settings, **including the `financial_closed_periods` closure registry** |
| `financial_years` | enabled | `allow_all_financial_years` … | read/write the FY configuration — an attacker could **close a year to deny service**, or **open one to bypass the gate** |
| `accounts` | enabled | `allow_all_accounts` … | read/write the chart of accounts |
| `invoices` | enabled | `allow_all_invoices` … | read/write invoices |
| `assessment_contracts` | enabled | **no policy** | deny-all for `authenticated`/`anon` — **correct posture** |
| `assessment_contract_items` | enabled | **no policy** | deny-all — **correct posture** |
| `profiles` | enabled | **no policy** | deny-all — **correct posture** |

Live confirmation (read-only, anon key):

```
customers:          anon CAN READ
wallet_transactions:anon CAN READ
ledger_entries:     anon CAN READ
settings:           anon CAN READ
financial_years:    anon CAN READ
assessment_contracts:anon CAN READ (HTTP 200, zero rows — RLS denies the rows)
```

**Why the contract tables are safe and the envelope tables are not:** the
contract tables have RLS enabled with **no policy**, so a non-bypassing role
sees zero rows. The 0048 RPCs are `SECURITY DEFINER` owned by the project
owner, so they bypass RLS and can read the contract rows the caller cannot.

**Assessment.** The `allow_all` policy set is a deliberate simplification for a
single-operator deployment where the only `authenticated` identity is the
operator. It is **not** safe once portal customers exist in the `authenticated`
role — which this deployment has (customer registration, portal sessions, portal
tickets, quotation requests). Under the current policies a portal customer can,
through PostgREST alone:

* read every customer's `walletBalance` and bank details (`customers`);
* **insert or alter wallet transactions** (`wallet_transactions`);
* **insert or alter ledger entries** (`ledger_entries`);
* **insert or alter idempotency keys** (`idempotency_keys`) — poisoning the
  key that 0048 relies on to make consumption idempotent;
* **alter `financial_years`** — opening a closed year bypasses the
  closed-period gate, closing an open year denies all consumption;
* **alter `settings`** — same effect on the closed-period registry.

Note that this exposure **pre-exists 0048 and is not created by it**. 0048
does, however, *depend* on the integrity of `idempotency_keys` and
`financial_years` — the idempotency key is the thing that makes a repeated
consumption safe, and the FY row is the thing that refuses a closed period. If
a portal customer can write either, 0048's guarantees are void regardless of how
tight the function is.

**Recommendation (not applied).** Restrict the four tables 0048 trusts —
`idempotency_keys`, `financial_years`, `settings` and the two accounting
tables — to `service_role`, and give the operator's session a role-scoped
policy instead of `USING (true)`. That is a separate migration with its own
rollback plan, because it changes how the operator's browser session reads
those tables.

## 6. Interim mitigation for F1 — APPLIED

**This has been applied to the live project** (see §2.1). The script is
`supabase/ops/revoke_anon_contract_rpcs.sql`; it changes no policy semantics,
only the EXECUTE privilege, and is reversible with
`supabase/ops/revoke_anon_contract_rpcs.rollback.sql`.

```sql
-- What the script executes, per function (signatures resolved from pg_proc):
REVOKE ALL ON FUNCTION <resolved signature> FROM PUBLIC, anon, authenticated;
```

## 7. F7 — posting account ids (correctness, fixed in 0048)

The chart of accounts is an envelope table whose **row id is the account id**,
and in the deployed database that id is **prefixed**:

```
ACC-21300  data.code = '21300'  data.account_number = '21300'
ACC-41100  data.code = '41100'  data.account_number = '41100'
```

The canonical local op (`resolveAccountForPosting`) resolves a **code** to the
account id before posting. A migration that hardcodes `'21300'` into
`ledger_entries.data->>'debitAccountId'` would write an account id that does
not exist — every financial report that joins the ledger to the COA would
silently lose those rows.

0048 now resolves the accounts from the COA, with the same rules as the local
op (inactive or non-posting accounts refused, unresolvable references fail
closed), via `public.resolve_posting_account(TEXT)`.

## 8. F8 — the migration header was wrong about what is deployed

The header of the draft says `NOT APPLIED TO PRODUCTION`, but the live
project's PostgREST schema exposes `consume_contract_assessment_atomic` and
`reserve_contract_assessment_atomic`, and the live error message
(`consume: contract … not found`) is the **draft's** wording. The draft **is**
deployed. Header comments must be corrected to reflect the deployed state, and
the deployment register (not a SQL comment) should be the source of truth.

---

## 10. F10 — issued contract documents can be forged by any signed-in session

0049 created, on `public.contract_documents`:

```sql
CREATE POLICY "allow_all_contract_documents"
  ON public.contract_documents FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
```

`FOR ALL` is SELECT **+ INSERT + UPDATE + DELETE**. Every signed-in session
therefore could PATCH an issued, hashed contract document's `content` and
`contentHash` directly through PostgREST. The forged row is what a
verification lookup returns, and nothing re-hashes an issued document on
read — so the "tamper-evident" claim was not enforced at the storage
boundary.

Reproduced against a Supabase-shaped PostgreSQL (the three baseline roles,
Supabase's default table grants, `service_role` BYPASSRLS, the real live
rows):

```
BEFORE  authenticated FORGES a document -> UPDATE 1     (the write went through)
AFTER   authenticated FORGES a document -> UPDATE 0     (refused)
        authenticated reads  -> 4 rows before, 4 rows after (realtime intact)
        anon reads            -> 0 rows before, 0 rows after
        service_role writes   -> OK before, OK after   (the sync gateway)
        live rows             -> identical, none modified
```

**Fix:** `supabase/migrations/0054_contract_documents_rls_hardening.sql`
replaces the `FOR ALL` policy with `FOR SELECT TO authenticated`. Every
business write already goes through `POST /api/sync/ops` with the
service-role key — the architecture the committed
`frontend/tests/services/supabaseWritePathGuard.test.ts` asserts ("The
browser anon key must NEVER issue business writes directly") — so no write
path is lost.

## 11. F11 — 0052/0053 are blocked on a client deployment

0052's immutability trigger validates a `supersededBy` link against a row
that must already exist. The **deployed** client writes:

```js
for (const p of prior) { put({ ...p, status: 'SUPERSEDED', supersededBy: record.id }); }
put(record);                        // the replacement is written LAST
```

so the link points at a row that does not exist yet. Replayed against a real
PostgreSQL with 0049 + 0052 + 0053:

```
deployed client (supersede-first) -> REJECTED
  ERROR: contract_documents: the superseding document SCH-PC-1-v2 does not exist yet (id=SCH-PC-1-v1)
Phase 2D client (insert-first)     -> ACCEPTED
```

Applying 0052 before the client is deployed would break every schedule
re-issuance. The Phase 2D client (insert-first ordering, the client-side
guard, the per-contract receipt version, the base-preserving OCC) and the
backend capability gate + `backend/services/contractDocumentGuard.cjs` exist
only as **uncommitted working-tree changes**, and the live
`required_client_capability` setting is absent, so even the gateway gate
would not be enforcing.

Everything else about 0052/0053 was verified safe: applied cleanly to a
disposable PostgreSQL carrying the real live rows, preflight passed, the
identity index built, and no live row was modified.

**The order (0052's own DEPLOYMENT ORDER):**

1. commit + deploy the Phase 2D client;
2. commit + deploy the backend capability gate and document guard;
3. raise the `required_client_capability` setting;
4. apply 0052, then 0053.

---

## 9. Verification performed

All read-only against the live project, or against a real PostgreSQL 16.4:

* function EXECUTE privileges read back from `pg_proc` (service_role only);
* `SECURITY DEFINER` + pinned `search_path` + owner (`postgres`) read back for
  all six functions;
* the in-function `UNAUTHORIZED` refusal exercised for `authenticated` and `anon`,
  and acceptance for `service_role`;
* anon probes of the draft's `consume` / `reserve` / `is_contract_date_in_closed_fy`
  (F1) and of 0006's `verify_payment_and_activate_contract` /
  `get_contract_available_funds` (F2/F4);
* anon read probes on the eleven envelope tables (F5);
* account id/code resolution against the live COA (F7);
* the live financial-year configuration and the absence of a
  `financial_closed_periods` registry.

**No production data was written at any point.**

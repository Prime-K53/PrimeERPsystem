# PHASE 1B RECONNAISSANCE

**Date:** 2026-09-05
**Type:** READ-ONLY audit. No source files were modified. No SQL executed.
**Basis:** Commit `d239f8b`/`6dba09d` (Phase 1A) verified; current `HEAD` = `cb58203`.

---

## 1. Executive Summary

**The repository is NOT yet ready to delete or bulk-migrate the legacy Supabase access layers, but it IS ready to begin Phase 1B with small, well-tested wins.** Evidence:

- The **regex SQL shim** (`services/supabaseQuery.cjs`) is still on production call paths with **98 call sites in `index.cjs` alone**, plus 4 other production importers and **zero unit tests**. It cannot be removed in one step.
- The **legacy repository** (`services/supabaseRepository.cjs`) still has ~40 non-test importers across routes, middleware, and services. The canonical repository currently has exactly **2 production consumers** (profit margin, promotions).
- Phase 1A's pattern (targeted service migration + mock-based unit tests + docs) is proven and repeatable, but the audit shows several commit messages **overstate what was done** (e.g. `c3ba2fc` "migrate to canonical" only *dropped supabaseQuery*; `bootstrap.cjs`/`auditService.cjs` still import the legacy repo today).
- Large parts of the legacy surface are explicitly **protected** (auth, `index.cjs`, finance/payment, sync, portal, reset) — those must not move in Phase 1B.

The recommended Phase 1B is therefore: migrate **2–3 small read-path consumers** of the shim/legacy repo with parity tests, retire the shim only if `index.cjs`/`baseService.cjs` remain on it, and leave everything destructive or finance-critical untouched.

---

## 2. Current Repository / Data Architecture

Evidence-based layer map (backend, `index.cjs` entry → data):

```
Express app (backend/index.cjs)
 ├── routes/*.cjs ──────────────► services/*.cjs
 │        │                          │
 │        │  (services use one of:)  ▼
 │        ├──► supabaseQuery.cjs  ── regex SQL shim  ──► supabaseRepository.cjs (legacy) ──┐
 │        ├──► supabaseRepository.cjs (legacy, direct)  ────────────────────────────────────┤
 │        ├──► supabaseCanonicalRepository.cjs (canonical, Phase 1A) ───────────────────────┼──► Supabase
 │        ├──► supabaseStore.cjs (portal catalog cache, portalService only)                  │   (PostgREST REST,
 │        └──► cloudSyncStore.cjs (atomic versioned writes; used by BOTH repos) ─────────────┘    envelope JSONB)
 │
 ├── db.cjs (SQLite, native sqlite3) ──► backupService.cjs (runtime backup) + migration/test runners only
 └── direct axios REST (routes/portalAdmin, routes/system; dev scripts)
```

Key facts established by grep + call tracing:

1. **No `supabase-js` `createClient`/`.from(`/`.rpc(` anywhere in backend CJS.** All server-side Supabase access is PostgREST via axios (`/rest/v1/...`). (Frontend `supabaseClient.ts`/`authSession.ts` are client-side and out of scope.)
2. **SQLite (`db.cjs`, 2753 lines)** is *not* on the mainline runtime data path: `index.cjs`, `bootstrap.cjs`, and all route/service modules do not require it. Runtime consumers: `backupService.cjs` (startup/on-demand backup of the local DB file) plus legacy migration runners (`backend/migrations/*.cjs`) and test/verify scripts.
3. Both repositories write through **`cloudSyncStore.cjs`** (atomic PATCH with version precondition, UUID5 idempotency, tombstones). Reads go straight to PostgREST.
4. The envelope format (`id`, JSONB `data`, `company_id`, `version`, timestamps) is shared by legacy and canonical repositories.

---

## 3. Canonical Repository

- **File:** `backend/services/supabaseCanonicalRepository.cjs` (395 lines)
- **API:** `isConfigured`, `fromSupabaseRow`, `toSupabaseRow`, `request`, `getAll`, `getAllStrict`, `getById`, `upsert`, `softDelete`, `count`, entity registry (`entities`/`entityQueries`), per-entity getters (`financialYears`, `profitMarginSettings`, `purchaseOrders`, `goodsReceipts`, `workCenters`, `productionResources`, `customerPayments`, `supplierPayments`), flat helpers (`getAllFlat`, `getByIdFlat`, `upsertFlat`, `updateFlat`), `portalEntities`.
- **Coverage:** envelope registry of **136 tables** (auto-generated entity queries) + 4 flat portal tables.
- **Writes:** delegated to `cloudSyncStore` (same as legacy repo) → safe drop-in.

### Current consumers (exhaustive, verified — not assumed)

| Consumer | Call path | Status |
|---|---|---|
| `profitMarginService.cjs` | `routes/settings.cjs` (margin GET/list/create/update/delete/bulk) → `profitMarginService` → canonical | **Phase 1A commit `d239f8b` — live** |
| `promotionService.cjs` | `routes/promotions.cjs` (promotions, stats, redemptions) → `promotionService` → canonical | **Phase 1A commit `d239f8b` — live** |

Tests exercising canonical: `backend/tests/profitMargin.unit.test.js`, `backend/tests/supabaseCanonicalRepository.test.js`.

### Migration-honesty finding

Commit `c3ba2fc` is titled *"refactor(audit,bootstrap): migrate to canonical repository, drop supabaseQuery"* but its diff only **removed supabaseQuery** from `auditService.cjs`/`bootstrap.cjs` — both still `require('./services/supabaseRepository.cjs')` (legacy) at `auditService.cjs:11` and `bootstrap.cjs:4`. Commit messages are not reliable evidence of migration state; code is.

---

## 4. Legacy Supabase Access Inventory

Legend — Access: `R` read / `W` write / `RW`. Status: ACTIVE (live runtime), DEV-TOOL, PARTIAL, TEST, DEAD. Risk: how hard it is to migrate later.

| File | Function | Access | Table/Data | Caller | Status | Risk |
|---|---|---|---|---|---|---|
| `services/supabaseQuery.cjs` | `getOne/getAll/run/prepare/extractTable/parseWhere` | RW | regex-parsed SQL over envelope tables | See §5 | ACTIVE | HIGH |
| `index.cjs` (98 `sq.*` sites) | sales/dashboard/ledger/expenses/income/transfers/banks/invoices/payments/work-centers endpoints | RW | `sales`, `invoices`, `ledger_entries`, `expenses`, `income`, `bank_*`, `customer_payments`, `work_centers`, `production_resources`, … | HTTP routes incl. `/health`, `/api/dashboard`, `/api/sales`, `/api/invoices/*` | ACTIVE | HIGH (protected — do not touch) |
| `services/baseService.cjs` | `_run/_get/_all/_transaction` (compensating tx via pre-images) | RW | arbitrary table SQL for subclasses | `bankingService`, `paymentAllocationService`, `referralService` | ACTIVE | HIGH (protected finance/payment) |
| `services/ai/baseService.cjs` | `_get/_all` wrappers | R | arbitrary SQL for AI features | 10 AI services (`anomalyDetector`, `poMatcher`, `reorderOptimizer`, `bomGenerator`, `churnPredictor`, …) | ACTIVE | HIGH (coarse SQL incl. aggregates/joins) |
| `auditMiddleware.cjs` | line 67 `sq.getOne(... WHERE id=? OR logical_number=?)` | R | pre-image for audit | Express audit middleware (writes audit on mutations) | ACTIVE | LOW–MED (single read) |
| `routes/engagement.cjs` | `withDb/getOne/runQuery` wrappers | RW | `engagement_membership_tiers`, engagement activity | mounted at `index.cjs:1060` | ACTIVE | MED |
| `services/supabaseRepository.cjs` (legacy repo) | `getAll/getById/upsert/softDelete/count/getAllFlat/...` | RW | all envelope tables | 40 non-test importers (§6 list) | ACTIVE | HIGH (bulk) |
| `routes/portalAdmin.cjs` | direct axios `rest/v1` + `auth/v1/admin` | W | company delete/reset across tables, auth users | Admin company-lifecycle endpoints | ACTIVE | HIGH — OUT OF SCOPE (reset infra) |
| `routes/system.cjs` | direct axios `rest/v1` | W | workspace delete across tables | `/workspace` endpoints | ACTIVE | HIGH — OUT OF SCOPE (reset infra) |
| `services/supabaseStore.cjs` | cached REST reads (15s TTL) | R | portal catalog (products) | `portalService.cjs` only | ACTIVE | LOW — portal (OUT OF SCOPE) |
| `services/db.cjs` (SQLite) | native sqlite3 singleton + schema init | RW | local SQLite file | `backupService`; `backend/migrations/*`; test/verify scripts | PARTIAL (backup/legacy only) | MED |
| `services/examinationService.cjs` (+`examinationRepository.cjs`, `examinationOrchestrator.cjs`) | legacy repo reads/writes for examinations | RW | examination domain tables | examination routes/workflow | ACTIVE | HIGH (finance-adjacent; integration-tested only) |
| `services/auditService.cjs`, `bootstrap.cjs` | legacy `repo.getAll/getById/count` | RW | `audit_logs`, seeding, first-run | global audit + startup | ACTIVE | LOW–MED (bootstrap/audit reads; commit-claim mismatch) |
| `backend/scripts/*.cjs` (coaReconcile, finalVerification, fix-*, migrateLegacyLedger, phase24/26, runtimeAcceptance, recomputeCustomerBalances, cleanupTestArtifacts) | direct axios `rest/v1` and/or repos | RW | operational data | dev/ops/verification tools | DEV-TOOL | N/A (not runtime) |
| `backend/tmp_mint.cjs` | requires legacy repo | ? | scratch | none (scratch file) | DEAD/scratch | N/A |
| Frontend `services/supabaseClient.ts` / `authSession.ts` / `syncApiClient.ts` / `AuthContext.tsx` | supabase-js client | RW | auth/session/portal | browser | ACTIVE | N/A — OUT OF SCOPE |

No `.insert(/.update(/.delete(/.select(/.rpc(` builder chains exist server-side; the regex shim *is* the "SQL-looking" layer.

---

## 5. Regex SQL Shim Analysis

- **Location:** `backend/services/supabaseQuery.cjs` (163 lines). Exports `{ getOne, getAll, run, prepare, extractTable, parseWhere }`.
- **Mechanism:** regex parsing of SQL strings then PostgREST translation onto the **legacy** repo:
  - `extractTable` — `FROM|INTO|UPDATE <table>`
  - `parseWhere` — splits `WHERE ... AND ...`, supports `col = 'literal'`, `col = ?`, `!=/<>/>/>=/</<=`
  - `parseOrderBy`, `parseLimit`, `COUNT(*)`, `SUM(col)`
  - `run` — `INSERT INTO t (cols) VALUES (?)`, `UPDATE ... SET col=? ... WHERE id=?`, `DELETE FROM t WHERE id=?` (→ `softDelete`), and **`BEGIN TRANSACTION`/`COMMIT`/`ROLLBACK` are no-ops returning `{}`** (transaction semantics are fake at this layer).
- **Callers (production):**
  1. `index.cjs` — **98 call sites** (largest; many legacy endpoints listed in §4). **Protected file.**
  2. `services/baseService.cjs` — `db` getter + `_run/_get/_all`. **Protected (finance/payment consumers).**
  3. `services/ai/baseService.cjs` — `_get/_all` for 10 AI services.
  4. `auditMiddleware.cjs` — 1 read (line 67).
  5. `routes/engagement.cjs` — 3 wrappers used across the engagement router (mounted `index.cjs:1060`).
  6. `bootstrap.cjs` — comment only (require already dropped in `c3ba2fc`).
- **Tests:** **none.** No file under `backend/tests` imports `supabaseQuery`.
- **Replacement status:** no canonical replacement exists for SQL-string call sites. The canonical repo exposes typed `getAll(table, filters)` — replacing the shim means rewriting each SQL string as filter objects (loses `OR` conditions, `JOIN`s, aggregates, arithmetic — none of which the shim supports today anyway).
- **Removal risk:** **HIGH while `index.cjs`/`baseService.cjs`/AI services use it.** Removing it would break POS sales write path, dashboard/sales reads, ledger endpoints, banking/allocation/referral writes, and 10 AI features. Only the auditMiddleware and engagement-GET surfaces look like *near-term* removable slices.

---

## 6. Duplicate / Legacy Abstractions

| Abstraction | Classification | Notes |
|---|---|---|
| `services/supabaseRepository.cjs` (legacy repo) | **ACTIVE** | ~40 non-test importers incl. index, middleware, most services |
| `services/supabaseQuery.cjs` (regex shim) | **ACTIVE** | 5 production importers; 0 tests |
| `services/supabaseCanonicalRepository.cjs` | **ACTIVE** | 2 production consumers (Phase 1A) |
| `services/cloudSyncStore.cjs` | **ACTIVE** | shared write engine for BOTH repos; do not remove |
| `services/baseService.cjs` | **ACTIVE** | 3 finance consumers + compensating-tx logic; protected |
| `services/ai/baseService.cjs` | **ACTIVE** | BaseAIService consumed by all 10 `services/ai/*` modules |
| `services/supabaseStore.cjs` | **ACTIVE** | portal catalog read cache (portalService only) |
| `services/db.cjs` (SQLite) | **PARTIALLY ACTIVE** | runtime = backup only; otherwise migration/test runners |
| `backend/migrations/*.cjs` | **UNKNOWN / legacy** | SQLite-based local migration runners; not wired to startup; live schema is `supabase/migrations/*.sql` |
| `backend/scripts/*.cjs` | **ACTIVE (dev tooling)** | verification/fix scripts w/ direct REST |
| `backend/tmp_mint.cjs` | **DEAD (scratch)** | not required anywhere |
| `examinationRepository.cjs` / `examinationOrchestrator.cjs` | **ACTIVE** | domain layering on legacy repo for examinations |
| `services/migrateToSupabase.cjs` | **TOOL** | code-transform generator (text rewrite), not runtime |

---

## 7. Phase 1B Candidate Changes

### SAFE (can likely be changed in Phase 1B)

1. **`auditMiddleware.cjs:67`** — replace the single `sq.getOne` pre-image read with a `repo.getById('…', id)` two-step fallback (id, then `logical_number`). Smallest isolated shim consumer; audit behavior unchanged if tested.
2. **`routes/engagement.cjs` read endpoints** (`GET /tiers` etc. that only SELECT whole tables) — swap `sq.getAll('SELECT * FROM t')` → `repo.getAll('t')` with identical in-code mapping.

### NEEDS TESTS (additional verification first)

3. **`routes/engagement.cjs` write endpoints** — shim `run` INSERT/UPDATE column extraction is lossy; rewrite needs per-endpoint parity tests first.
4. **`auditService.cjs` / `bootstrap.cjs`** — actually finish the canonical migration the `c3ba2fc` commit message claims (drop legacy repo require → canonical). Reads only in bootstrap; audit logs currently `repo.getAll('audit_logs')`.
5. **`services/ai/baseService.cjs` + its 10 consumers** — only after auditing each SQL string for unsupported constructs; no current unit tests.

### HIGH RISK (should remain untouched for now)

6. **`index.cjs` shim usage (98 sites)** — POS sales/dashboard/ledger/finance endpoints. Protected.
7. **`services/baseService.cjs`** — banking/payment-allocation/referral writes + compensating transactions. Protected.
8. **`examinationService`/`examinationRepository`** — finance-adjacent, integration-tested only.
9. Any migration that would leave `supabaseQuery.cjs` or `supabaseRepository.cjs` with a partial in-between state without parity tests.

### OUT OF SCOPE (explicitly excluded from Phase 1B)

- `index.cjs`, auth (`authService`, `portalAuth*`, routes/auth), finance/payment (`financeService`, `bankingService`, `paymentAllocationService`, `paymentRequestService`, `vatManagementService`), sync (`routes/sync.cjs`, `cloudSyncStore`, sync middleware), reset/workspace (`routes/portalAdmin`, `routes/system`), portal (`portalService`, `portalAuthService`, `supabaseStore`), `db.cjs`/SQLite migration runners, `backend/scripts/*`, `backend/migrations/*`, frontend.

---

## 8. Required Tests Before Implementation

| Change | Tests that must exist & pass first |
|---|---|
| auditMiddleware shim swap (#1) | New unit test (jest, mock canonical repo, mirror `profitMargin.unit.test.js` pattern): middleware resolves old row by id then by `logical_number`; existing route tests still green |
| engagement reads (#2) | Existing engagement route integration coverage against live Supabase (none currently unit-level); add unit parity tests with a canonical-repo mock asserting filter mapping + JSON field normalization (`benefits_json` etc.) |
| engagement writes (#3) | Per-endpoint parity test: shim result vs canonical result for tier create/update (idempotency of generated ids, JSON columns) |
| audit/bootstrap finish (#4) | `supabaseCanonicalRepository` mock unit test for the two calls; bootstrap first-run seeding test |
| AI baseService (#5) | Snapshot of every SQL string used by the 10 AI services + contract tests per query type (eq, range, order, limit); no aggregates/JOINs may regress |
| General gate | Before deleting `supabaseQuery.cjs` or `supabaseRepository.cjs`: zero remaining production importers (grep gate in CI), full unit suite green, targeted live integration suite green |

---

## 9. Proposed Phase 1B Implementation Sequence (NOT executed)

1. Add canonical-repo mock unit tests for `auditMiddleware` pre-image read (pattern: `profitMargin.unit.test.js`). Verify.
2. Migrate `auditMiddleware.cjs` off the shim. Verify (unit + audit endpoint smoke).
3. Finish the canonical migration of `auditService.cjs` + `bootstrap.cjs` (complete `c3ba2fc`'s stated intent). Verify.
4. Migrate `routes/engagement.cjs` reads to legacy→canonical with parity tests; then writes with parity tests. Verify.
5. Audit + rewrite AI `baseService` SQL strings to canonical filters with contract tests — only if AI queries are all simple; otherwise leave HIGH RISK.
6. Re-run full unit suite (`npm test --workspace=backend` unit subset + frontend vitest).
7. Verify worktree (no unrelated changes), update `SUPABASE_ACCESS_INVENTORY.md`/docs.
8. Commit per concern (small commits). Do NOT delete `supabaseQuery.cjs`/`supabaseRepository.cjs` until step 6 has zero production importers — which this audit shows is not achievable while `index.cjs`/`baseService.cjs` remain protected.

---

## 10. Protected / Untouched Areas

Confirmed NOT modified, NOT executed, NOT read-edited by this audit:

- `supabase/controlled_business_data_reset.sql` — untouched (remains uncommitted in the worktree, as before this audit)
- Authentication, `baseService.cjs`, `index.cjs`, financial/payment infrastructure, sync-generation logic, `cloudSyncStore`, complex SQL, reset functionality, portal functionality, frontend architecture, tests
- No SQL executed, no reset scripts run, no Supabase/`rest/v1` calls made, no destructive git commands used

---

## 11. Git / Worktree Verification

```
$ git diff --stat
(no tracked files modified by this audit)

$ git status --short
 M supabase/controlled_business_data_reset.sql   ← PRE-EXISTING, untouched (was already uncommitted before this audit)
?? docs/CURRENT_WORKTREE_VERIFICATION.md         ← PRE-EXISTING untracked report from Phase 1A verification
?? docs/PHASE_1B_RECONNAISSANCE.md               ← THE ONLY file created by this audit
```

The only intentional change from this audit is the creation of `docs/PHASE_1B_RECONNAISSANCE.md`. The two other entries (`controlled_business_data_reset.sql`, `docs/CURRENT_WORKTREE_VERIFICATION.md`) were present before this task began and were left exactly as found. Nothing was staged, committed, or pushed.

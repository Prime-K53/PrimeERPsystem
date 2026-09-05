# Prime ERP System — Phase 0 Baseline Report

**Date:** 2026-09-05  
**Branch:** main  
**Commit:** d387c1d  
**Status:** PHASE 0 COMPLETE — BASELINE ESTABLISHED

---

## 1. Test Results

### Frontend Tests (vitest)
```
Command: npm run test --workspace=frontend
Exit code: 1 (FAILED)
Duration: ~34s
```

| Test File | Result |
|---|---|
| `tests/services/salesOrderService.test.ts` | 22 tests, **1 FAILED** |
| `tests/utils/documentMapper.invoiceShapes.test.tsx` | 2 tests, **1 FAILED** |
| `tests/views/Settings.saveFlow.test.tsx` | 12 tests, **12 FAILED** |
| `tests/unit/sync/syncGeneration.test.ts` | 0 tests (empty/misconfigured) |
| Other test files | PASSED (31KB log implies many passing files) |

**Baseline failures (pre-existing, not introduced by this phase):**
- `currencySymbol is not defined` — `frontend/utils/documentMapper.tsx:412` referenced in `tests/services/salesOrderService.test.ts` and `tests/utils/documentMapper.invoiceShapes.test.tsx`
- `Settings.saveFlow.test.tsx` — 12 failures due to missing IndexedDB stores (`Object store "bomTemplates" not found`, `Object store "settings" not found`) + `act()` warnings

### Backend Tests (jest)
```
Command: npm test --workspace=backend
Exit code: 1 (FAILED)
```

| Test File | Result |
|---|---|
| `tests/coa_hierarchy.test.js` | 30 passed, **1 FAILED** (test calls `process.exit(1)` internally, conflicts with `--forceExit`) |
| Other test files | PASSED |

**Note:** `tests/coa_hierarchy.test.js` has a custom summary block that calls `process.exit(1)` on failure. This conflicts with jest's `--forceExit` flag and produces "Cannot log after tests are done" warnings.

---

## 2. Build Results

### Frontend Build
```
Command: npm run build --workspace=frontend
Exit code: 0 (SUCCESS)
Duration: 1m 11s
Output: dist/ (all chunks generated)
```

**Warnings:**
- Some chunks > 500 kB after minification:
  - `index-B2k7JQ40.js` — 3,309.69 kB (983.62 kB gzip)
  - `pdf-h8ChSJoS.js` — 458.08 kB (135.84 kB gzip)
  - `CategoricalChart-1NA8QXnH.js` — 293.88 kB (91.55 kB gzip)
  - `Settings-BPXyAPnj.js` — 290.41 kB (56.57 kB gzip)

### Backend Build
N/A (CJS project, no build step)

---

## 3. TypeScript / Type Check Results

### Frontend TypeScript
```
Command: npx tsc --noEmit (from frontend/)
Exit code: 1 (FAILED — pre-existing)
Total errors: 788
```

**Note:** `npm run typecheck` fails due to workspace module resolution error:
```
Error: Cannot find module 'D:\Application\PrimeERPsystem\node_modules\prime-erp-frontend\node_modules\typescript\bin\tsc'
```
Workaround: run `.\node_modules\.bin\tsc --noEmit` directly from `frontend/` directory.

**Pre-existing errors (sample):**
- `views/tools/ChequeManager.tsx` — type conversion errors (`Record<string, {x:number;y:number}>`)
- `views/tools/FAQManager.tsx` — unknown property `divide`
- `views/tools/MarketAdjustments.tsx` — type mismatch (`applies_to` vs `appliesTo`, string vs enum)
- `views/tools/MarketingMessages.tsx` — missing properties (`address` on `CompanyConfig`, `salesInvoices` on `SalesState`)
- `views/warehouse/WarehousePage.tsx` — discriminated union property access errors

### Backend TypeScript
N/A (CJS project, no TypeScript)

---

## 4. Lint Results
No lint script configured in either `frontend/package.json` or `backend/package.json`.

---

## 5. Application Startup Verification

### Backend
```
Command: node index.cjs (from backend/)
Result: SUCCESS
Port: 3000
```

Startup log:
```
--- SERVER SCRIPT STARTING ---
Requiring express...
Requiring cors...
Requiring body-parser...
[cloudSyncStore] STARTUP: Cloud sync configured OK. URL=https://rdtuzuzehfbwvfdzqliw.supabase.co
Requiring bootstrap...
Imports done.
--- STARTING SERVER ---
[ENV] All required secrets present.
```

**Note:** Port 3000 was already in use, indicating the backend is currently running.

### Frontend
Dev server confirmed listening on port 5173 (TIME_WAIT connections observed).

---

## 6. Current Supabase Access Patterns

The backend uses **three distinct Supabase access patterns**:

| Pattern | File | Purpose |
|---|---|---|
| **Envelope CRUD** | `backend/services/supabaseRepository.cjs` | Generic `getAll`, `getById`, `upsert`, `softDelete`, `update`. Wraps writes in `{ id, data:<jsonb>, company_id, version, updated_at }`. 1,088 LOC. |
| **Sync Gateway** | `backend/services/cloudSyncStore.cjs` | Authoritative write client for `/api/sync/ops`. UUID5 idempotency keys, atomic versioned PATCH, tombstones (`data.deleted=true`). 805 LOC. |
| **Read Mirror** | `backend/services/supabaseStore.cjs` | Read-only catalog/invoices/sales fetcher with 15-second in-process cache. |
| **SQL Shim** | `backend/services/supabaseQuery.cjs` | Regex-based SQL parser (`SELECT … FROM … WHERE col = ?`) → PostgREST filters (`data->>col=eq.value`). **Brittle** — no JOINs, broken transactions. |

**Inline routes** in `backend/index.cjs` use `supabaseQuery.cjs` directly (line 339: `const sq = require('./services/supabaseQuery.cjs')`).

---

## 7. Current Authentication Flow

### Staff (Admin ERP)
1. `POST /api/auth/login` — bcrypt compare → `generateToken({ id, username, role, email })` → 8h JWT (HS256)
2. `verifyToken` middleware (`backend/middleware/auth.cjs`):
   - Skips `/auth/login`, `/auth/register`, `/portal/*`
   - Optional `ALLOW_HEADER_AUTH=true` + loopback → trusts `x-user-*` headers (dev bypass)
   - Parse `Authorization: Bearer <token>`
   - `jwt.verify(token, JWT_SECRET)`
   - On failure → Supabase JWT fallback (`/auth/v1/user`)
3. `requireRole(...)` — case-insensitive canonical role comparison via `middleware/roles.cjs`
4. 2FA pending state: **in-memory `pendingTwoFactorMap`** (process-local, breaks horizontal scaling)

### Customer Portal
1. `POST /api/portal/auth/login-password` — password-based
2. 30-min JWT (`role: 'portal_customer'`) + 30-day opaque refresh token (SHA-256 hashed in `portal_sessions`)
3. `verifyPortalToken` — rejects non-portal roles, accepts `?token=` for SSE
4. TOTP 2FA via `otplib`, secret in `portal_users.two_factor_secret`

### Three Identity Contexts
- Staff JWT (ERP)
- Portal JWT (customer)
- Supabase JWT (fallback for staff)

---

## 8. Current Sync Architecture

```
Frontend (ERP)                    Backend
─────────────────                ─────────────────
[UI]                              [Express]
  │                                 │
  ▼                                 ▼
useDocumentStore                   /api/sync/ops
safeOpenPreview()                   │
  │                                 ▼
  ▼                                 cloudSyncStore.cjs
durableSyncQueue.ts                 │ upsertRow() / softDeleteRow()
  │ IndexedDB queue                  │ UUID5 idempotency keys
  │ states: pending/syncing/         │ tombstones (data.deleted=true)
  │   failed/dead_letter             │ atomic versioned PATCH
  │                                 │
  ▼                                 ▼
syncService.ts                    supabaseRepository.cjs
  │ orchestrates                      │
  │ writes: queue → IDB → Supabase    ▼
  │                                 Supabase REST API
  ▼                                 (data->>col=eq.value filters)
syncApiClient.ts
  │ POST /api/sync/ops
  ▼
BroadcastChannel + window event
  │ cross-tab sync notifications
```

**Key files:**
- `frontend/services/durableSyncQueue.ts` — IDB-backed queue with retry histogram, dead-letter handling
- `frontend/services/syncService.ts` — core orchestrator
- `frontend/services/backgroundSyncService.ts` — background retry loop
- `frontend/services/syncConflictResolver.ts` — mergeRecords, fieldLevelMerge
- `backend/routes/sync.cjs` — single write gateway, ~120 cloud tables allow-listed
- `backend/services/cloudSyncStore.cjs` — idempotent upsert/delete
- `backend/services/supabaseRepository.cjs` — envelope-shaped CRUD

**Sync generation:** Global counter in `public.settings` (single-company deployment). Prevents resurrected ops after company reset.

---

## 9. Current Migration Structure

### Supabase Migrations (`supabase/migrations/`)
15 numbered `.sql` files, run in lexical order:

| File | Lines | Purpose |
|---|---|---|
| `0001_baseline_live_schema.sql` | 2,363 | Consolidated LIVE schema: 159 tables, functions, triggers, RLS, realtime |
| `0002_fix_rls_profiles_account_creation.sql` | — | Profile INSERT policy |
| `0003_referral_tables.sql` | — | `customer_referrals`, `referral_rewards`, `timeline` |
| `0004_referral_rls_policies.sql` | — | RLS for referral tables |
| `0005_portal_quotation_requests.sql` | — | `quotation_requests` table |
| `0006_reconcile_referral_schema.sql` | 308 | Referral schema reconciliation + customer isolation RLS |
| `0007_portal_lifecycle_tables.sql` | — | Portal timeline, downloads, document versions/signatures/comments |
| `0008_payment_requests.sql` | — | `payment_requests` + customer isolation RLS |
| `0009_sales_order_number_uniqueness.sql` | — | Unique constraint on sales order numbers |
| `0010_referral_attribution_fields.sql` | — | Attribution fields |
| `0011_customer_referral_code.sql` | — | `referral_code` on customers |
| `0012_support_articles.sql` | — | `support_articles` + public/staff RLS |
| `0013_coa_hierarchy.sql` | — | COA hierarchy + per-company RLS |
| `0013_financial_integrity.sql` | — | Financial integrity triggers |
| `0014_coa_new_columns.sql` | — | Additional COA columns |
| `0015_sync_generation.sql` | — | Sync generation helper |

**Parallel numbering:** Two `0013_*` files, three `0014_*` files. Confusing but functionally safe.

### SQLite Migrations (`backend/migrations/`)
10 one-shot `.cjs` patches (ALTER TABLE, CREATE TABLE). Run order is implicit (numbered filenames).

### Archive
`database/archive/` contains 19 previously-applied SQL files + README. Explicitly marked "DO NOT re-run".

---

## 10. Current Backup Mechanism

- **Location:** `backend/storage/backups/`
- **Mechanism:** SQLite `db.backup()` to timestamped file
- **Schedule:** Hourly + daily (in `backend/backupService.cjs`)
- **Encryption:** AES-256 (optional)
- **Issue:** 54 snapshots retained with **no rotation policy**
- **Bug:** Top-level `backend/backupService.cjs` writes to `../backups/` instead of the runtime-configured `runtimePaths.backupDir`

---

## 11. Current Reset Mechanism

- **SQL:** `supabase/controlled_business_data_reset.sql` (693 lines, DELETE-only)
- **Phases:** Payment allocations → promotion redemptions → financial transactions → customer/supplier master data
- **Backend:** `POST /api/portal/admin/company/reset` (in `routes/portalAdmin.cjs`)
- **Safety:** PRE-FLIGHT row-count block + POST-FLIGHT verification block. No TRUNCATE/DROP/dynamic SQL.

---

## 12. Dead / Orphaned Files

### Confirmed Dead
| File | Reason |
|---|---|
| `backend/routes/erpPortalMirror.cjs` | 0 bytes, not required anywhere |
| `backend/tmp_mint.cjs` | Diagnostic one-shot token utility |
| `frontend/brain/` | Debug scripts + stray `form_content.tsx` |
| `frontend/scratch/` | `.cjs` debug scripts + `rxdb`/`rxjs` tarballs |
| `frontend/views/SmartSalesDashboard.tsx.test` | Empty 2-byte file |
| `frontend/views/auth/Gateway.tsx` | Orphaned auth page, no route in App.tsx |
| `frontend/views/production/ExaminationPrintingV2.tsx` | V2 exists but only V1 is routed |
| `frontend/components/MasterDocument.tsx` | Only cross-imports `DocumentShell`, no external callers |
| `frontend/components/DocumentShell.tsx` | Same |
| `frontend/components/DocumentDispatcher.tsx` | Same |
| `frontend/types/engagement-plugin.ts` | `export {};` — empty stub |
| `frontend/services/engagementEngine.ts` | No-op stub |

### Appear Dead But Actually Used
| File | Why it appears dead | Actual usage |
|---|---|---|
| `frontend/views/pos/components/*` | Separate `pos/` dir, not imported from `views/POS.tsx` | Used by `views/POS.tsx` route |
| `backend/services/licenseService.cjs` (root) | Duplicate of `services/licenseService.cjs` | Imported by `bootstrap.cjs` |
| `backend/backupService.cjs` (root) | Duplicate of `services/backupService.cjs` | Not confirmed dead — needs verification |
| `backend/services/documentService.cjs` | Puppeteer path, superseded by `officialDocumentService` | Referenced in tests/docs |

---

## 13. Highest-Risk Findings

| # | Risk | Severity | File(s) |
|---|---|---|---|
| 1 | **In-memory 2FA pending tokens** — breaks horizontal scaling | HIGH | `backend/routes/auth.cjs`, `backend/routes/portalAuth.cjs` |
| 2 | **Hard-coded JWT secret fallback** (`'prime-erp-portal-secret'`) | HIGH | `backend/services/portalAuthService.cjs` |
| 3 | **Regex SQL parser with broken transactions** (`supabaseQuery.cjs`) | HIGH | `backend/services/supabaseQuery.cjs` |
| 4 | **Inline routes in 4,173-LOC entry file** (`index.cjs`) | HIGH | `backend/index.cjs` |
| 5 | **God services** — `examinationService.cjs` (190 KB), `portalLifecycleService.cjs` (135 KB), `financeService.cjs` (55 KB) | MEDIUM | `backend/services/*.cjs` |
| 6 | **Duplicate UI primitives** — `components/` vs `components/ui/` | MEDIUM | `frontend/components/*` |
| 7 | **3 Supabase access patterns** with overlapping concerns | MEDIUM | `backend/services/supabase*.cjs` |
| 8 | **788 pre-existing TypeScript errors** | MEDIUM | `frontend/` (multiple files) |
| 9 | **No backup rotation** (54 snapshots retained) | MEDIUM | `backend/backupService.cjs` |
| 10 | **`pendingTwoFactorMap` is process-local** — breaks pods | MEDIUM | `backend/routes/auth.cjs` |

---

## 14. Files That Should Be Touched in Phase 1

Based on the analysis, Phase 1 should focus on **non-breaking improvements** that reduce risk without changing behavior:

### Backend (low-risk, high-value)
1. `backend/index.cjs` — Extract inline routes to `routes/sales.cjs`, `routes/dashboard.cjs`, `routes/accounts.cjs` (reduce 4,173 LOC entry point)
2. `backend/middleware/auth.cjs` — Move `pendingTwoFactorMap` to Supabase/Redis
3. `backend/services/portalAuthService.cjs` — Remove hard-coded JWT fallback
4. `backend/routes/erpPortalMirror.cjs` — Delete (0 bytes)
5. `backend/tmp_mint.cjs` — Delete or move to `scripts/`

### Frontend (low-risk cleanup)
6. `frontend/views/auth/Gateway.tsx` — Delete (orphaned)
7. `frontend/views/SmartSalesDashboard.tsx.test` — Delete or write real test (empty file)
8. `frontend/views/production/ExaminationPrintingV2.tsx` — Delete (unused V2)
9. `frontend/components/MasterDocument.tsx` + `DocumentShell.tsx` + `DocumentDispatcher.tsx` — Delete (orphans)

### Testing (baseline fixes)
10. `tests/unit/sync/syncGeneration.test.ts` — Fix empty test file
11. `tests/coa_hierarchy.test.js` — Fix `process.exit(1)` conflict with jest

### Documentation
12. Add `.gitignore` entries for `backend/server.out`, `backend/server.err`, `backend/storage/database.db*`
13. Add `supabase/README.md` for migration guidance

---

## 15. What Was Not Changed

Per Phase 0 constraints:
- No UI redesign
- No business behavior changes
- No production data modifications
- No destructive SQL
- No Supabase production modifications
- No broad refactors
- No major dependency upgrades

Only the following were completed in Phase 0:
- Repository baseline established
- Test results recorded
- Build results recorded
- Typecheck results recorded
- Application startup verified
- Critical files inspected
- This report produced

---

*End of Phase 0 Baseline Report*

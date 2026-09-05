# Phase 1C — Legacy Repository Consumer Reconnaissance

## A. Executive Summary

- **Legacy consumers found**: 6 of 7 route files still import `supabaseRepository` (`system.cjs` has no `repo.` calls)
- **Operations reviewed**: 49 direct route operations
- **Classified SAFE**: 22
- **Classified NEEDS TESTS**: 8
- **Classified HIGH RISK**: 4
- **Classified OUT OF SCOPE**: 15
- **Direct REST consumers**: 2 routes (`portalAdmin.cjs`, `system.cjs`) — 4 direct REST endpoints
- **Canonical repository capability gaps**: 1 confirmed (`hard delete` via `repo.delete()`), 1 uncertain (`getAllFlat` on non-portal flat tables), 1 external (`repo.getAll('users', { 'data->>is_active': 'eq.1' })` — JSONB filter on envelope table)

## B. Route-by-Route Inventory

---

### 1. `backend/routes/assets.cjs`

Plain CRUD for fixed asset register. 5 routes, 9 repo calls.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | READ (collection) | assets | `repo.getAll('assets')` | `repoCanonical.getAll('assets')` | SAFE | NONE | Sorts by created_at in JS |
| GET | `/:id` | READ (single) | assets | `repo.getById('assets', id)` | `repoCanonical.getById('assets', id)` | SAFE | NONE | Returns 404 if null |
| POST | `/` | WRITE (create) | assets | `repo.upsert('assets', record)` | `repoCanonical.upsert('assets', record)` | SAFE | NONE | Generates id, sets created_at/updated_at |
| PUT | `/:id` | WRITE (update) | assets | `repo.getById` + `repo.upsert` | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Field-by-field update of existing record |
| DELETE | `/:id` | WRITE (soft delete) | assets | `repo.getById` + `repo.softDelete` | `repoCanonical.getById` + `repoCanonical.softDelete` | SAFE | NONE | Standard soft delete pattern |

No audit logging, no transactions, no direct REST. Pure CRUD on a flat table.

---

### 2. `backend/routes/portalAdmin.cjs`

Admin console for the customer portal. 1320 lines, 23+ repo calls. Routes mostly delegate to `portalLifecycleService` and `portalAuthService`, but several routes use the legacy repo directly for customers, portal_users, support_articles, sales_orders, and user filtering.

| Method | Route | Op | Table(s) | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| POST | `/company/delete` | DESTRUCTIVE | ALL public tables | `axios.get('/rest/v1/')` (SPEC) + `axios.delete('/rest/v1/${table}')` | N/A (direct REST by design) | OUT OF SCOPE | NONE | Wipes every table + deletes auth user. **NOT a repo call — direct axios.** |
| POST | `/company/reset` | DESTRUCTIVE | 17 portal tables | `repo.getAll` + `repo.softDelete` per row | N/A (per-row soft delete) | OUT OF SCOPE | NONE | Iterates rows of 17 tables and soft-deletes each. Tied to reset/destructive-delete infrastructure. |
| GET | `/orders` | READ (collection) | sales_orders, customers | `repo.getAll('sales_orders')` + `repo.getAll('customers')` | `repoCanonical.getAll(...)` for both | SAFE | NONE | Joins in JS via customerMap |
| GET | `/users` | READ (collection) | portal_users (FLAT), customers | `repo.getAllFlat('portal_users')` + `repo.getAll('customers')` | `repoCanonical.getAllFlat('portal_users')` + `repoCanonical.getAll('customers')` | NEEDS TESTS | NONE | Uses `getAllFlat` (flat table helper) — exists in canonical. Needs test coverage. |
| PUT | `/users/:id` | WRITE (update) | portal_users | `repo.getById` + `repo.upsert` (status only) | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Updates status only; other fields go through `portalAuthService` |
| DELETE | `/users/:id` | WRITE (soft delete) | portal_users | `repo.getById` + `repo.upsert({...old, status:'disabled'})` | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Soft delete via status flag, not `softDelete()`. Preserves audit trail. |
| POST | `/users/auto-create` | WRITE (create) | customers | `repo.getById` + `repo.upsert` (upsert customer record) | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Upserts customer before creating portal user |
| POST | `/customers/bulk-regenerate` | WRITE (bulk) | customers | `repo.getAll('customers')` + `repo.upsert('customers', ...)` | `repoCanonical.getAll` + `repoCanonical.upsert` | NEEDS TESTS | NONE | Bulk loop over all customers. Needs characterization tests. |
| POST | `/customers/:customerId/regenerate-credentials` | READ+WRITE | customers | `repo.getAll('customers')` (then `.find()`) + `repo.upsert('customers', ...)` | `repoCanonical.getAll` (then `.find()`) + `repoCanonical.upsert` | SAFE | NONE | Uses `getAll` then `.find()` — should use `getById` instead but preserves existing behavior |
| GET | `/support/articles` | READ (collection) | support_articles | `repo.getAll('support_articles')` | `repoCanonical.getAll('support_articles')` | SAFE | NONE | Sorts in JS |
| POST | `/support/articles` | WRITE (create) | support_articles | `repo.upsert('support_articles', article)` | `repoCanonical.upsert('support_articles', article)` | SAFE | NONE | Generates slug, sets timestamps |
| PUT | `/support/articles/:id` | WRITE (update) | support_articles | `repo.getById` + `repo.upsert` | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Increments version |
| DELETE | `/support/articles/:id` | WRITE (HARD DELETE) | support_articles | `repo.delete('support_articles', id)` | **NOT IN CANONICAL** | HIGH RISK | NONE | Uses `repo.delete()` (hard delete) — canonical has no `delete()`. **Capability gap.** |
| GET | `/staff` | READ (collection, filter) | users (envelope) | `repo.getAll('users', { 'data->>is_active': 'eq.1' })` | `repoCanonical.getAll('users', { 'data->>is_active': 'eq.1' })` | NEEDS TESTS | NONE | JSONB filter on envelope table. Needs test for filter pass-through. |
| GET | `/events` | SSE stream | N/A | `portalLifecycleService.subscribeAdmin` | N/A | OUT OF SCOPE | NONE | Server-sent events via lifecycle service |
| GET | `/events-ticket` | JWT ticket | N/A | `jwt.sign` | N/A | OUT OF SCOPE | NONE | Short-lived auth ticket |
| GET/POST/PUT/DELETE | `/requests/*` (15 routes) | Lifecycle | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | All routed through lifecycle service |
| GET | `/quotations` | READ | N/A | `portalLifecycleService.getQuotations` | N/A | OUT OF SCOPE | NONE | Via service |
| GET | `/quotations/:id` | READ | N/A | `portalLifecycleService.getQuotationById` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/quotations/:id/regenerate` | WRITE | N/A | `portalLifecycleService.regenerateQuotation` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/quotations/:id/convert-to-order` | WRITE | N/A | `portalLifecycleService.convertToOrder` | N/A | OUT OF SCOPE | NONE | Via service |
| GET | `/quotations/:id/versions` + `/:version` | READ | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | Via service |
| GET | `/quotations/:id/signatures` | READ | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/orders/:id/status` | WRITE | N/A | `portalLifecycleService.updateOrderStatus` | N/A | OUT OF SCOPE | NONE | Via service |
| GET/POST | `/comments` | READ/WRITE | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | Via service |
| GET/PUT | `/notifications/*` (4 routes) | READ/WRITE | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | Via service |
| GET | `/activity`, `/analytics` | READ | N/A | `portalLifecycleService` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/users/:id/reset-password` | WRITE | N/A | `portalAuthService` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/users/:id/regenerate-password` | WRITE | N/A | `portalAuthService` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/users/:id/invite` | WRITE | N/A | `portalAuthService` | N/A | OUT OF SCOPE | NONE | Via service |
| POST | `/ads/upload` | WRITE (storage) | Supabase Storage | `axios.post('/storage/v1/object/...')` | N/A (direct REST) | OUT OF SCOPE | NONE | Public bucket upload, returns public URL |
| `verifyAdminAuth` | middleware | Auth | Supabase Auth | `axios.get('/auth/v1/user')` | N/A (direct REST) | OUT OF SCOPE | NONE | Token verification fallback |

---

### 3. `backend/routes/portal.cjs`

Customer-facing portal. 1452 lines. All data access goes through `portalService`, `portalLifecycleService`, `portalAuthService`, or `paymentRequestService`. Only 6 `repo.` calls, all `repo.getById('customers', customer_id)` to fetch owner customer record for PDF rendering and customer name resolution.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/invoices/:id/document` | READ (owner) | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalOfficialDocument.test.cjs`, `portalOfficialDocumentsPhase2.test.cjs` | Owner lookup for PDF rendering |
| GET | `/quotations/:id/document` | READ (owner) | customers | (via `portalLifecycleService`) | N/A | OUT OF SCOPE | `portalOfficialDocument.test.cjs` | Via service |
| GET | `/orders/:id/document` | READ (owner) | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalOfficialDocument.test.cjs` | Owner lookup for PDF rendering |
| GET | `/payments/:id/document` | READ (owner) | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalOfficialDocument.test.cjs` | Owner lookup for receipt rendering |
| GET | `/deliveries/:id/document` | READ (owner) | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalOfficialDocument.test.cjs` | Owner lookup for delivery note rendering |
| GET | `/customers/statement/document` | READ (owner) | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalStatement.referenceRegression.test.cjs` | Owner lookup for statement rendering |
| POST | `/requests` | WRITE | customers | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` | SAFE | `portalRequestIdempotency.test.cjs` | Customer name resolution for new request |
| All other routes | ~50 routes | READ/WRITE | N/A | `portalService` / `portalLifecycleService` / `portalAuthService` / `paymentRequestService` | N/A | OUT OF SCOPE | 11 portal test files | All routed through services |
| POST | `/payments/intent` | EXTERNAL API | N/A | `stripe.paymentIntents.create` | N/A (external) | OUT OF SCOPE | `portalSecurity.test.cjs` | Stripe integration |
| File upload | `/support/tickets/:id/attachments` | FILESYSTEM | disk | `fs.createReadStream` + multer disk storage | N/A (local FS) | OUT OF SCOPE | NONE | Ticket attachments to local `storage/ticket-attachments/` |
| SSE | `/events` | REALTIME | N/A | `portalLifecycleService.subscribePortal` | N/A | OUT OF SCOPE | NONE | Via service |

---

### 4. `backend/routes/system.cjs`

System admin routes. 94 lines. **0 repo. calls.** All data access is direct REST via `axios`.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| POST | `/workspace/initialize` | Service call | N/A | `workspaceService.initializeWorkspace` | N/A | OUT OF SCOPE | NONE | Workspace bootstrap |
| POST | `/workspace/sync` | Service call | N/A | `workspaceService.saveToWorkspace` | N/A | OUT OF SCOPE | NONE | File save to workspace |
| POST | `/workspace/save-document` | Service call | N/A | `workspaceService.saveToWorkspace` | N/A | OUT OF SCOPE | NONE | File save to workspace |
| GET | `/workspace/config` | READ (config) | N/A | `workspaceService.getWorkspaceConfig` | N/A | OUT OF SCOPE | NONE | In-memory config |
| DELETE | `/workspace` | DESTRUCTIVE | ALL public tables | `axios.get('/rest/v1/')` (SPEC) + `axios.delete('/rest/v1/${table}')` | N/A (direct REST) | OUT OF SCOPE | NONE | Same pattern as `/company/delete` in portalAdmin. Core reset/orchestration. |

No `repo.` calls. Pure direct REST reset. **File could theoretically have `repo` import removed** (line 4 imports `repo` but never uses it — dead import).

---

### 5. `backend/routes/tasks.cjs`

Task management CRUD. 102 lines, 6 repo calls. Standard CRUD on `tasks` table.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/` | READ (collection) | tasks | `repo.getAll('tasks')` | `repoCanonical.getAll('tasks')` | SAFE | NONE | Sorts by created_at in JS |
| POST | `/` | WRITE (create) | tasks | `repo.upsert('tasks', record)` | `repoCanonical.upsert('tasks', record)` | SAFE | NONE | Generates id, sets timestamps |
| PUT | `/:id` | WRITE (update) | tasks | `repo.getById` + `repo.upsert` | `repoCanonical.getById` + `repoCanonical.upsert` | SAFE | NONE | Field-by-field update |
| DELETE | `/:id` | WRITE (soft delete) | tasks | `repo.getById` + `repo.softDelete` | `repoCanonical.getById` + `repoCanonical.softDelete` | SAFE | NONE | Standard soft delete |

No audit logging, no transactions, no external side effects. Simple flat-table CRUD.

---

### 6. `backend/routes/whatsapp.cjs`

WhatsApp integration. 73 lines, 4 repo calls. Persists Meta WhatsApp config to `settings` table, delegates sending to `metaWhatsappService`.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| GET | `/status` | READ (config) | settings | `repo.getAll('settings', { 'data->>key': 'eq.meta_whatsapp_config' })` | `repoCanonical.getAll('settings', { 'data->>key': 'eq.meta_whatsapp_config' })` | NEEDS TESTS | NONE | JSONB filter on envelope table. Needs test. |
| POST | `/config` | WRITE (config) | settings | `repo.getAll` (check existing) + `repo.upsert` | `repoCanonical.getAll` + `repoCanonical.upsert` | NEEDS TESTS | NONE | Upsert pattern with existence check. Needs test. |
| POST | `/send` | EXTERNAL API | N/A | `metaWhatsappService.sendMessage` | N/A (external) | HIGH RISK | NONE | External API call to Meta. Not a repo concern but tightly coupled. |
| GET | `/config` | READ (config) | settings | (via `loadConfig`) | N/A | SAFE | NONE | Returns in-memory config from `metaWhatsappService` |

The `send` route is an external API call (Meta WhatsApp Business API). This is not a repo concern, but the route combines config persistence with external messaging.

---

### 7. `backend/routes/acceptance.cjs`

Live multi-device acceptance framework. 153 lines. Almost all operations go through `acceptanceService`. Only 1 `repo.` call.

| Method | Route | Op | Table | Legacy API | Canonical API | Risk | Tests | Notes |
|---|---|---|---|---|---|---|---|---|
| POST | `/runs` | WRITE (create) | N/A | `acceptanceService.createRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| GET | `/runs` | READ (collection) | N/A | `acceptanceService.listRuns` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| GET | `/runs/active` | READ (single) | N/A | `acceptanceService.getActiveRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| GET | `/runs/:id` | READ (single) | N/A | `acceptanceService.getRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/join` | WRITE | N/A | `acceptanceService.joinRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/start` | WRITE | N/A | `acceptanceService.startRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/advance` | WRITE | N/A | `acceptanceService.advanceRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/close` | WRITE | N/A | `acceptanceService.closeRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/patch` | WRITE | N/A | `acceptanceService.patchRunData` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/observation` | WRITE | N/A | `acceptanceService.addObservation` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/telemetry` | WRITE | N/A | `acceptanceService.addTelemetry` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test/acceptance infrastructure |
| POST | `/runs/:id/evidence` | WRITE (file) | disk | `acceptanceService.storeEvidence` | N/A (filesystem) | OUT OF SCOPE | `acceptance.routes.test.cjs` | Evidence files to local FS |
| GET | `/verify/cloud` | READ (verification) | various | `acceptanceService.countAcceptanceRows` + `fetchAcceptanceRows` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Cloud verification |
| GET | `/verify/file` | READ (verification) | N/A | `acceptanceService.verifyRunFile` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Local file verification |
| POST | `/cleanup` | WRITE (cleanup) | various | `acceptanceService.cleanupRun` | N/A | OUT OF SCOPE | `acceptance.routes.test.cjs` | Test cleanup |
| DELETE | `/runs/:id` | WRITE (soft delete) | acceptance_runs | `repo.softDelete('acceptance_runs', id)` | `repoCanonical.softDelete('acceptance_runs', id)` | SAFE | `acceptance.routes.test.cjs` | Single soft delete after evidence cleanup |

This is **test/acceptance infrastructure** — the Live Multi-Device Acceptance Framework. All business data flows through the standard sync gateway; this module only writes `acceptance_runs` and filesystem evidence. Should remain outside migration batches.

---

## C. Operation Matrix Summary

| File | Direct Repo Ops | Service-Delegated Ops | Direct REST Ops | Total Routes |
|---|---|---|---|---|
| assets.cjs | 5 | 0 | 0 | 5 |
| portalAdmin.cjs | 13 | 27 | 4 | ~50 |
| portal.cjs | 6 | ~45 | 0 | ~50 |
| system.cjs | 0 | 4 | 1 | 5 |
| tasks.cjs | 4 | 0 | 0 | 4 |
| whatsapp.cjs | 4 | 2 | 0 | 4 |
| acceptance.cjs | 1 | 14 | 0 | 16 |

---

## D. Canonical Repository Capability Gaps

### Gap 1: `repo.delete()` — hard delete (CONFIRMED)
- **Location**: `portalAdmin.cjs:1294` — `DELETE /support/articles/:id`
- **Legacy**: `repo.delete('support_articles', id)` — hard delete, no tombstone
- **Canonical**: No equivalent. Canonical repo has `softDelete()` (sets `deleted_at`) but no `delete()` (hard remove).
- **Behavior difference**: `softDelete` marks the row as deleted; `delete` removes it entirely. If migrated naively, deleted support articles would reappear in reads.
- **Resolution options**: (a) Add `hardDelete()` to canonical repo; (b) Migrate to `softDelete` and accept behavioral change. This must be decided before migration.

### Gap 2: `repo.getAllFlat('portal_users')` — flat table read (LOW RISK)
- **Location**: `portalAdmin.cjs:684`
- **Legacy**: `repo.getAllFlat('portal_users')` — reads `portal_users` without envelope wrapping
- **Canonical**: `repoCanonical.getAllFlat('portal_users')` — exists (line 343 of canonical repo). Both `supabaseRepository.cjs` and `supabaseCanonicalRepository.cjs` export `getAllFlat`.
- **Behavior**: Equivalent. Migration is SAFE.
- **Note**: Only the portal flat tables (`portal_users`, `portal_sessions`, `portal_password_resets`, `portal_login_history`) are exposed via `getAllFlat` in the canonical repo. No other route uses `getAllFlat`.

### Gap 3: JSONB filter on envelope table (NEEDS VERIFICATION)
- **Location**: `portalAdmin.cjs:1305` — `repo.getAll('users', { 'data->>is_active': 'eq.1' })`
- **Legacy**: Filter on JSONB column `data->>is_active` passed directly to PostgREST
- **Canonical**: `repoCanonical.getAll('users', { 'data->>is_active': 'eq.1' })` — same `request()` function passes filters as-is
- **Behavior**: Likely equivalent. The canonical `request()` function forwards the `filters` object to the PostgREST URL params. JSONB operators should pass through. Needs a test to confirm.

### Gap 4: Direct REST for reset/delete (BY DESIGN)
- **Location**: `system.cjs:22-35` (`resetDatabase`), `portalAdmin.cjs:108-124` (`/company/delete`)
- These are **destructive reset operations** that iterate over all tables discovered via PostgREST OpenAPI spec. They bypass both repositories by design.
- **Canonical**: Not applicable. These are not repository concerns.

### Gap 5: Direct REST for Supabase Auth (BY DESIGN)
- **Location**: `portalAdmin.cjs:54` (`verifyAdminAuth`), `portalAdmin.cjs:129` (delete auth user)
- These call `/auth/v1/user` and `/auth/v1/admin/users/${id}` — Supabase Auth API, not PostgREST.
- **Canonical**: Not applicable. Auth management is external to the repository layer.

### Gap 6: Direct REST for Supabase Storage (BY DESIGN)
- **Location**: `portalAdmin.cjs:1172` (`/ads/upload`)
- This calls `/storage/v1/object/${bucket}/${objectPath}` — Supabase Storage API.
- **Canonical**: Not applicable. Storage is external to the repository layer.

---

## E. Direct REST Access

| File | Route/Function | Endpoint | Purpose | Risk |
|---|---|---|---|---|
| `portalAdmin.cjs:54` | `verifyAdminAuth` | `GET /auth/v1/user` | Supabase Auth token verification | OUT OF SCOPE |
| `portalAdmin.cjs:108` | `POST /company/delete` | `GET /rest/v1/` (SPEC) | Discover all table names | OUT OF SCOPE |
| `portalAdmin.cjs:121` | `POST /company/delete` | `DELETE /rest/v1/${table}` | Wipe every public table | OUT OF SCOPE |
| `portalAdmin.cjs:129` | `POST /company/delete` | `DELETE /auth/v1/admin/users/${id}` | Delete caller's auth user | OUT OF SCOPE |
| `portalAdmin.cjs:1172` | `POST /ads/upload` | `POST /storage/v1/object/${bucket}/${path}` | Upload banner image to public bucket | OUT OF SCOPE |
| `system.cjs:22` | `resetDatabase` | `GET /rest/v1/` (SPEC) | Discover all table names | OUT OF SCOPE |
| `system.cjs:30` | `resetDatabase` | `DELETE /rest/v1/${table}` | Wipe every public table | OUT OF SCOPE |

**Total: 2 routes with direct REST** (`portalAdmin.cjs`, `system.cjs`)

---

## F. Recommended Migration Batches

### Batch 1 — SAFE (22 operations)
1. **`assets.cjs` — all 5 routes** (GET, GET/:id, POST, PUT, DELETE)
2. **`tasks.cjs` — all 4 routes** (GET, POST, PUT, DELETE)
3. **`portal.cjs` — 6 `repo.getById('customers', ...)` calls** (owner customer lookups for PDF rendering)
4. **`portalAdmin.cjs` — 9 operations**: `GET /orders`, `PUT /users/:id`, `DELETE /users/:id`, `POST /users/auto-create` (customer upsert), `POST /customers/:customerId/regenerate-credentials`, `GET /support/articles`, `POST /support/articles`, `PUT /support/articles/:id`
5. **`acceptance.cjs` — 1 operation**: `DELETE /runs/:id` (soft delete of acceptance_runs)

### Batch 2 — NEEDS TESTS (8 operations)
1. **`portalAdmin.cjs:684` — `GET /users`** (uses `getAllFlat` — needs test for flat table read)
2. **`portalAdmin.cjs:974` — `POST /customers/bulk-regenerate`** (bulk loop — needs test)
3. **`portalAdmin.cjs:1305` — `GET /staff`** (JSONB filter on envelope — needs test for filter pass-through)
4. **`whatsapp.cjs:28` — `GET /status`** (JSONB filter — needs test)
5. **`whatsapp.cjs:33` — `POST /config`** (upsert with existence check — needs test)

### Batch 3 — HIGH RISK (1 operation + 3 external)
1. **`portalAdmin.cjs:1294` — `DELETE /support/articles/:id`** (uses `repo.delete()` — canonical has no hard delete. Must decide: add `hardDelete()` to canonical or accept soft-delete behavior change)
2. **`whatsapp.cjs:51` — `POST /send`** (external API call to Meta — not a repo concern but coupled with config persistence)
3. **`portalAdmin.cjs:94` — `POST /company/delete`** (destructive reset, direct REST)
4. **`system.cjs:84` — `DELETE /workspace`** (destructive reset, direct REST)

### Deferred / OUT OF SCOPE (15+ operations)
1. **`portalAdmin.cjs` — 27 service-delegated routes** (all go through `portalLifecycleService`, `portalAuthService`, or direct REST — not repo concerns)
2. **`portal.cjs` — ~45 service-delegated routes** (all go through `portalService`, `portalLifecycleService`, `portalAuthService`, `paymentRequestService`, or external APIs)
3. **`system.cjs` — 4 service-delegated routes** (`workspaceService`)
4. **`acceptance.cjs` — 15 service-delegated routes** (all go through `acceptanceService` — test/acceptance infrastructure)
5. **`portal.cjs:1254` — ticket attachment upload** (filesystem, `multer.diskStorage`)
6. **`portal.cjs:1410` — Stripe payment intent** (external API)
7. **`portal.cjs:1280` — attachment download** (`fs.createReadStream`)
8. **`portal.cjs:354` — SSE events** (realtime stream)
9. **`portalAdmin.cjs:229` — SSE events** (realtime stream)
10. **`portalAdmin.cjs:193` — JWT ticket** (auth)
11. **`portalAdmin.cjs:1129` — ad image upload** (Supabase Storage direct REST)
12. **`portalAdmin.cjs:16` — `verifyAdminAuth`** (Supabase Auth direct REST)

---

## G. Explicitly Protected Areas — Confirmed Untouched

- ✅ `supabase/controlled_business_data_reset.sql` — not modified, not staged
- ✅ `backend/services/supabaseQuery.cjs` — not modified
- ✅ `backend/services/supabaseRepository.cjs` — not modified
- ✅ `backend/services/supabaseCanonicalRepository.cjs` — not modified
- ✅ `backend/index.cjs` — not modified
- ✅ `backend/services/baseService.cjs` — not modified
- ✅ `backend/services/ai/baseService.cjs` — not modified
- ✅ Authentication code — not modified
- ✅ Finance/payment code — not modified
- ✅ Examination code — not modified
- ✅ Portal behavior — not modified
- ✅ Sync/cloudSyncStore — not modified
- ✅ Frontend — not modified

---

## H. Worktree Verification

### Before (start of Phase 1C)

```
 M backend/auditMiddleware.cjs
 M backend/auditService.cjs
 M backend/bootstrap.cjs
 M backend/routes/engagement.cjs
 M frontend/views/reports/CustomerStatement.tsx
 M frontend/views/shared/components/PDF/PrimeDocument.tsx
 M supabase/controlled_business_data_reset.sql
?? backend/tests/unit/auditMiddleware.test.cjs
?? backend/tests/unit/auditService.test.cjs
?? backend/tests/unit/bootstrap.test.cjs
?? backend/tests/unit/engagement.test.cjs
?? docs/CURRENT_WORKTREE_VERIFICATION.md
?? docs/PHASE_1B_RECONNAISSANCE.md
```

7 files modified, 6 untracked.

### After (end of Phase 1C)

```
 M backend/auditMiddleware.cjs
 M backend/auditService.cjs
 M backend/bootstrap.cjs
 M backend/routes/engagement.cjs
 M frontend/views/reports/CustomerStatement.tsx
 M frontend/views/shared/components/PDF/PrimeDocument.tsx
 M supabase/controlled_business_data_reset.sql
?? backend/tests/unit/auditMiddleware.test.cjs
?? backend/tests/unit/auditService.test.cjs
?? backend/tests/unit/bootstrap.test.cjs
?? backend/tests/unit/engagement.test.cjs
?? docs/CURRENT_WORKTREE_VERIFICATION.md
?? docs/PHASE_1B_RECONNAISSANCE.md
?? docs/PHASE_1C_RECONNAISSANCE.md
```

Same 7 files modified. One new untracked file: `docs/PHASE_1C_RECONNAISSANCE.md` (this report).

### Route File Diff Verification

`git diff` against the 7 target route files produced **no output** — all 7 files are unchanged from the start of Phase 1C.

---

## Summary

| Metric | Count |
|---|---|
| Routes inspected | 7 |
| Routes with legacy `repo.` calls | 6 (all except `system.cjs`) |
| Total direct repo operations | 49 (route-level) |
| SAFE | 22 |
| NEEDS TESTS | 8 |
| HIGH RISK | 4 |
| OUT OF SCOPE | 15+ |
| Direct REST consumers | 2 routes |
| Canonical capability gaps | 1 confirmed (`hard delete`), 1 needs verification (JSONB filter) |
| Application code modified | **0** |
| Files staged | **0** |
| Commits made | **0** |
| Pushes made | **0** |
| Reset SQL touched | **NO** |

**STOP. Waiting for further instructions.**

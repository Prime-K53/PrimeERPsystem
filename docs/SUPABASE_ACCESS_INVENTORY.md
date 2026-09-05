# Supabase Access Inventory — Phase 1A

**Generated:** 2026-09-05  
**Baseline commit:** f8d43cd  
**Scope:** All callers of the four Supabase access layers in `backend/services/`

---

## 1. Access Layer Summary

| Layer | File | LOC | Purpose | Callers |
|---|---|---|---|---|
| **SQL shim** | `supabaseQuery.cjs` | 163 | Regex SQL parser → PostgREST filters | 7 direct importers (9 before migration) |
| **Envelope CRUD** | `supabaseRepository.cjs` | 1088 | Generic `{id, data:<jsonb>, company_id, version, updated_at}` CRUD | 30+ services, 10+ routes, 10+ tests |
| **Canonical CRUD** | `supabaseCanonicalRepository.cjs` | ~260 | Table-registry pattern, auto-generated CRUD, same API as `supabaseRepository.cjs` | `auditService.cjs`, `bootstrap.cjs` (migrated) |
| **Sync gateway** | `cloudSyncStore.cjs` | 805 | Authoritative writes for `/api/sync/ops`; UUID5 idempotency, tombstones, atomic versioned PATCH | `supabaseRepository.cjs`, `supabaseCanonicalRepository.cjs`, `routes/sync.cjs`, 5 test files |
| **Read mirror** | `supabaseStore.cjs` | 237 | Portal-specific reads (catalog, invoices, sales, customers) with 15s in-process cache | `portalService.cjs` only |

---

## 2. Caller Inventory — `supabaseQuery.cjs` (SQL shim)

### 2.1 `backend/services/baseService.cjs`
| Field | Value |
|---|---|
| **Import** | `const sq = require('./supabaseQuery.cjs')` |
| **Usage** | Wraps `sq` as `this.db`, exposes `_run(sql, params)`, `_get(sql, params)`, `_all(sql, params)` |
| **Pattern** | SQL strings with `?` placeholders → parsed by `extractTable`/`parseWhere` → `data->>col=eq.value` filters |
| **Tables accessed** | ALL tables (generic wrapper) |
| **Read/Write** | Both (INSERT/UPDATE/DELETE/SELECT) |
| **Business-critical** | Yes — used by `convertToQuotation`, `createInvoiceFromOrder`, etc. |
| **Sync-related** | No — direct Supabase writes bypass sync gateway |
| **Transactions** | Compensating-action (pre-image capture + rollback). `BEGIN/COMMIT` are no-ops. |
| **Company isolation** | No — raw SQL, no company_id filter |
| **JSONB filtering** | Yes — `data->>col=eq.value` for WHERE clauses |
| **Proposed replacement** | Migrate to `supabaseRepository.cjs` `entityQueries[table]` or new canonical repo. Keep `baseService.cjs` as compensating-action wrapper but swap the SQL parser for typed calls. |

### 2.2 `backend/index.cjs`
| Field | Value |
|---|---|
| **Import** | `const sq = require('./services/supabaseQuery.cjs')` (line 339) |
| **Usage** | Direct `sq.run()`, `sq.getOne()`, `sq.getAll()` for inline sales/accounts/dashboard routes |
| **Tables accessed** | `sales`, `invoices`, `customers`, `accounts`, `ledger_entries`, `expenses`, `income`, `inventory`, `products`, `suppliers` |
| **Read/Write** | Both |
| **Business-critical** | Yes — core sales CRUD, ledger posting, account management |
| **Sync-related** | No — direct Supabase writes bypass sync gateway |
| **Transactions** | None — individual operations |
| **Company isolation** | No — raw SQL, no company_id filter |
| **JSONB filtering** | Yes — WHERE clauses map to `data->>col=eq.value` |
| **Proposed replacement** | Extract routes to `routes/sales.cjs`, `routes/accounts.cjs`, etc., and migrate to `supabaseRepository.cjs` `entityQueries`. HIGH PRIORITY for Phase 1B. |

### 2.3 `backend/routes/engagement.cjs`
| Field | Value |
|---|---|
| **Import** | `const sq = require('../services/supabaseQuery.cjs')` (line 3) |
| **Usage** | Direct `sq.getAll()` for engagement queries |
| **Tables accessed** | `engagement_*`, `customer_referrals`, `referral_*` |
| **Read/Write** | Read |
| **Business-critical** | Medium — engagement reads |
| **Sync-related** | No |
| **Transactions** | N/A |
| **Company isolation** | No |
| **JSONB filtering** | Yes |
| **Proposed replacement** | `supabaseRepository.cjs` `entityQueries.engagement_promotions.getAll()` etc. |

### 2.4 `backend/routes/sync.cjs`
| Field | Value |
|---|---|
| **Import** | Not directly — uses `cloudSyncStore` |
| **Usage** | N/A for sq |
| **Tables accessed** | N/A |
| **Proposed replacement** | N/A |

### 2.5 `backend/auditService.cjs`
| Field | Value |
|---|---|
| **Import** | ~~`const sq = require('./services/supabaseQuery.cjs')`~~ **MIGRATED** |
| **Usage** | ~~`sq.getAll()`, `sq.getOne()`~~ → `repo.getAll('audit_logs')`, `repo.getById('audit_logs', id)` |
| **Tables accessed** | `audit_logs` |
| **Read/Write** | Both |
| **Business-critical** | Medium — audit trail |
| **Sync-related** | No |
| **Company isolation** | No |
| **JSONB filtering** | No |
| **Proposed replacement** | ✅ **DONE** — migrated to canonical repo in commit `c3ba2fc` |

### 2.6 `backend/auditMiddleware.cjs`
| Field | Value |
|---|---|
| **Import** | `const sq = require('./services/supabaseQuery.cjs')` (line 12) |
| **Usage** | `sq.getOne()` for audit CRUD with complex WHERE clauses (`OR` conditions) |
| **Tables accessed** | `audit_logs` |
| **Read/Write** | Both |
| **Business-critical** | Medium |
| **Sync-related** | No |
| **Company isolation** | No |
| **JSONB filtering** | No |
| **Proposed replacement** | Defer to Phase 1B — uses complex SQL with `OR` conditions not easily expressed via canonical repo filters |

### 2.7 `backend/bootstrap.cjs`
| Field | Value |
|---|---|
| **Import** | ~~`const sq = require('./services/supabaseQuery.cjs')`~~ **MIGRATED** |
| **Usage** | ~~`sq.getOne('SELECT 1 AS alive')`, `sq.getOne('SELECT COUNT(*)...')`~~ → `repo.getAll('settings')`, `repo.count('schools')` |
| **Tables accessed** | `settings`, `schools` |
| **Read/Write** | Both |
| **Business-critical** | Low — one-time bootstrap |
| **Sync-related** | No |
| **Company isolation** | No |
| **JSONB filtering** | No |
| **Proposed replacement** | ✅ **DONE** — migrated to canonical repo in commit `c3ba2fc` |

### 2.8 `backend/services/ai/baseService.cjs`
| Field | Value |
|---|---|
| **Import** | `const sq = require('../supabaseQuery.cjs')` (line 1) |
| **Usage** | `sq.getAll()` for AI queries |
| **Tables accessed** | Various (AI-specific) |
| **Read/Write** | Read |
| **Business-critical** | Low — AI features |
| **Sync-related** | No |
| **Company isolation** | No |
| **JSONB filtering** | Yes |
| **Proposed replacement** | Defer to Phase 2 — AI features, low priority |

### 2.9 `backend/middleware/validation.cjs`
| Field | Value |
|---|---|
| **Import** | `const repo = require('../services/supabaseRepository.cjs')` (line 742) |
| **Usage** | `repo.getAll()` for validation lookups |
| **Tables accessed** | Various (lookup tables) |
| **Read/Write** | Read |
| **Business-critical** | Medium — input validation |
| **Sync-related** | No |
| **Company isolation** | No |
| **JSONB filtering** | Yes |
| **Proposed replacement** | Already uses `supabaseRepository.cjs` — safe |

### 2.10 `backend/middleware/idempotency.cjs`
| Field | Value |
|---|---|
| **Import** | `const repo = require('../services/supabaseRepository.cjs')` (line 2) |
| **Usage** | `repo.getAll()`, `repo.upsert()` for idempotency keys |
| **Tables accessed** | `idempotency_keys` |
| **Read/Write** | Both |
| **Business-critical** | High — prevents duplicate sync ops |
| **Sync-related** | Yes |
| **Company isolation** | No |
| **JSONB filtering** | No |
| **Proposed replacement** | Already uses `supabaseRepository.cjs` — safe |

---

## 3. Caller Inventory — `supabaseRepository.cjs` (Envelope CRUD)

### 3.1 Services (27 direct importers)

| Service | Tables Used | Operations | Business-Critical | Sync-Related | Notes |
|---|---|---|---|---|---|
| `acceptanceService.cjs` | `acceptance_runs` | CRUD | Medium | No | Acceptance framework |
| `authService.cjs` | `users` | CRUD | High | No | Staff auth |
| `bankingService.cjs` | `bank_accounts`, `bank_transactions`, `bank_reconciliations`, etc. | CRUD | High | No | Banking |
| `companyConfigService.cjs` | `settings` | CRUD | High | No | Company config |
| `customerLedger.cjs` | `ledger_entries`, `customers` | CRUD | High | No | Authoritative balance |
| `currencyService.cjs` | `settings` | Read | Medium | No | Currency resolver |
| `documentService.cjs` | `documents` | CRUD | Medium | No | Document lifecycle |
| `emailVerificationService.cjs` | `email_verifications` | CRUD | Medium | No | Email verification |
| `examinationService.cjs` | `examinations`, `examination_batches`, etc. | CRUD | High | No | God service (190KB) |
| `financialReportingService.cjs` | `accounts`, `ledger_entries`, `transfers`, etc. | CRUD | High | No | Financial reports |
| `financeService.cjs` | `accounts`, `ledger_entries`, `transfers`, etc. | CRUD | High | No | God service (55KB) |
| `financialYearService.cjs` | `financial_years` | CRUD | High | No | FY management |
| `hrService.cjs` | `employees`, `payroll_runs`, `payslips` | CRUD | High | No | HR |
| `paymentAllocationService.cjs` | `payment_allocations`, `payment_allocation_lines` | CRUD | High | No | Payment allocation |
| `paymentRequestService.cjs` | `payment_requests` | CRUD | High | No | Payment requests |
| `portalAuthService.cjs` | `portal_users`, `portal_sessions`, `portal_password_resets` | CRUD | High | No | Portal auth |
| `portalLifecycleService.cjs` | `portal_timeline_events`, `portal_downloads`, `document_versions`, etc. | CRUD | High | No | God service (135KB) |
| `portalService.cjs` | `customers`, `invoices`, `sales`, `quotations`, `orders`, etc. | CRUD | High | No | Portal data |
| `pricingEngine.cjs` | `products`, `profit_margin_settings` | Read | High | No | Pricing validation |
| `procurementService.cjs` | `purchase_orders`, `suppliers`, `goods_receipts` | CRUD | High | No | Procurement |
| `productionService.cjs` | `work_orders`, `production_batches`, `job_tickets` | CRUD | High | No | Production |
| `profitMarginService.cjs` | `profit_margin_settings` | CRUD | Medium | No | Profit margins |
| `promotionService.cjs` | `engagement_promotions` | CRUD | Medium | No | Promotions |
| `referralNotificationService.cjs` | `customer_referrals`, `referral_rewards` | CRUD | Medium | No | Referrals |
| `referralService.cjs` | `customer_referrals`, `referral_rewards`, `referral_timeline`, etc. | CRUD | High | No | Referrals (59KB) |
| `vatManagementService.cjs` | `vat_transactions`, `tax_rates` | CRUD | High | No | VAT |
| `workflowEngine.cjs` | `workflows` | CRUD | Medium | No | Workflows |

### 3.2 Routes (8 direct importers)

| Route File | Tables Used | Operations | Business-Critical | Sync-Related |
|---|---|---|---|---|
| `routes/portal.cjs` | All portal tables | CRUD | High | No |
| `routes/portalAdmin.cjs` | All admin portal tables | CRUD | High | No |
| `routes/acceptance.cjs` | `acceptance_runs` | CRUD | Medium | No |
| `routes/assets.cjs` | `assets` | CRUD | Medium | No |
| `routes/system.cjs` | `settings` | CRUD | High | No |
| `routes/tasks.cjs` | `tasks` | CRUD | Medium | No |
| `routes/whatsapp.cjs` | `whatsapp_chats`, `whatsapp_templates`, etc. | CRUD | Medium | No |
| `routes/engagement.cjs` | `engagement_*` | CRUD | Medium | No |

### 3.3 Middleware (2 direct importers)

| Middleware | Tables Used | Operations | Business-Critical |
|---|---|---|---|
| `middleware/validation.cjs` | Various lookup tables | Read | Medium |
| `middleware/idempotency.cjs` | `idempotency_keys` | CRUD | High |

### 3.4 Top-level scripts (3 direct importers)

| Script | Tables Used | Operations |
|---|---|---|
| `index.cjs` | All ERP tables via inline routes | CRUD |
| `bootstrap.cjs` | `settings`, `users`, `customers`, `products` | CRUD |
| `tmp_mint.cjs` | `users` | Read/Write |

### 3.5 Tests (10 direct importers)

| Test File | Tables Used |
|---|---|
| `tests/idempotencyPersistence.test.cjs` | `idempotency_keys` |
| `tests/paymentRequests.test.cjs` | `payment_requests` |
| `tests/portalRequestIdempotency.test.cjs` | Portal tables |
| `tests/financialIntegrity.fixes.test.cjs` | Finance tables |
| `tests/portalPricing.test.cjs` | `products`, `customers` |
| `tests/phase25_accounting_acceptance.cjs` | Finance tables |
| `tests/phase251_acc_reconciliation.test.cjs` | Finance tables |
| `tests/referralIdempotency.test.cjs` | Referral tables |
| `tests/portalVariantCatalog.test.cjs` | `product_variants` |
| `tests/coa_hierarchy.test.js` | `accounts` |

---

## 4. Caller Inventory — `cloudSyncStore.cjs` (Sync Gateway)

### 4.1 Production callers

| Caller | Functions Used | Purpose |
|---|---|---|
| `backend/services/supabaseRepository.cjs` | `upsertRow()`, `softDeleteRow()` | ALL writes go through cloudSyncStore |
| `backend/routes/sync.cjs` | `applyOp()`, `getSyncGeneration()`, `incrementSyncGeneration()`, `countTombstones()`, `purgeTombstones()`, `isConfigured()` | Sync gateway endpoint + admin reset |

### 4.2 Test callers

| Test File | Functions Used |
|---|---|
| `tests/unit/sync.generation.test.cjs` | `applyOp()` |
| `tests/unit/sync.errorClassification.test.cjs` | `applyOp()` |
| `tests/unit/cloudSyncStore.versionGate.test.cjs` | `upsertRow()`, `softDeleteRow()`, `applyOp()` |
| `tests/unit/cloudSyncStore.tombstone.test.cjs` | `upsertRow()`, `softDeleteRow()`, `countTombstones()` |
| `tests/quotationRequestsIssues.test.cjs` | `pickSalesOrderNumber()` |
| `tests/portalRequestIdempotency.test.cjs` | Comments only (no direct calls) |
| `tests/portalPricing.test.cjs` | Comments only (no direct calls) |

### 4.3 Key properties preserved

| Property | Implementation | Status |
|---|---|---|
| UUID5 idempotency | `stringToUuid5(operationId)` → SHA-1 of namespace+operationId | ✅ Active |
| Version checks | Atomic PATCH with `WHERE version = expected` | ✅ Active |
| Tombstones | `data.deleted = true` + `data.deletedAt` | ✅ Active |
| Sync generation | `public.settings` row with `id='sync_generation'` | ✅ Active |
| Atomicity | Single PATCH for versioned writes | ✅ Active |
| Duplicate prevention | `idempotency_keys` table + `checkIdempotency()` | ✅ Active |
| Error classification | `isRetryable` based on HTTP status | ✅ Active |

---

## 5. Caller Inventory — `supabaseStore.cjs` (Read Mirror)

### 5.1 Production callers

| Caller | Functions Used | Tables | Purpose |
|---|---|---|---|
| `backend/services/portalService.cjs` | `listCatalogItems()`, `getCustomer()`, `listInvoices()`, `getInvoice()`, `listSales()`, `cloudAvailable()` | `products`, `customers`, `invoices`, `sales` | Portal reads with 15s cache |

### 5.2 Notes
- `supabaseStore.cjs` uses `PUBLISHABLE_KEY` (anon key) for reads, while other layers use `SECRET_KEY` (service role).
- 15-second in-process cache via `Map()`.
- Only `portalService.cjs` imports this file.

---

## 6. Data Flow Diagram (Current)

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (ERP)                            │
│                                                                   │
│  ┌──────────────┐    ┌───────────────┐    ┌─────────────────┐  │
│  │ useDocument  │    │ durableSync   │    │ backgroundSync  │  │
│  │ Store        │───▶│ Queue         │───▶│ Service         │  │
│  │ (Zustand)    │    │ (IndexedDB)    │    │ (retry loop)    │  │
│  └──────────────┘    └───────────────┘    └─────────────────┘  │
│         │                    │                      │            │
│         │                    │                      ▼            │
│         │                    │              ┌─────────────────┐  │
│         │                    │              │ syncApiClient   │  │
│         │                    │              │ (HTTP POST)     │  │
│         │                    │              └─────────────────┘  │
│         │                    │                      │            │
│         ▼                    ▼                      ▼            │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  BroadcastChannel('primeerp-data-sync') + window events  │   │
│  │  Cross-tab sync notifications                            │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      BACKEND (Express)                           │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  POST /api/sync/ops                                       │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │ cloudSyncStore.applyOp()                            │ │   │
│  │  │  1. checkStaleOperation() — sync generation guard    │ │   │
│  │  │  2. checkIdempotency() — UUID5 lookup                │ │   │
│  │  │  3. upsertRow() / softDeleteRow() — atomic PATCH     │ │   │
│  │  │     • version check (WHERE version = expected)       │ │   │
│  │  │     • tombstone on delete                             │ │   │
│  │  │     • sales order number minting                     │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  supabaseRepository.cjs (envelope CRUD)                   │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐ │   │
│  │  │ entityQueries │  │ portalEntities│  │ flat helpers   │ │   │
│  │  │ (60+ tables)  │  │ (5 portal    │  │ (portal_users, │ │   │
│  │  │               │  │   tables)    │  │  sessions, etc)│ │   │
│  │  └──────┬────────┘  └──────┬───────┘  └───────┬────────┘ │   │
│  │         │                  │                    │          │   │
│  │         ▼                  ▼                    ▼          │   │
│  │  cloudSyncStore.upsertRow()  │         upsertFlat()        │   │
│  │  cloudSyncStore.softDeleteRow()│         updateFlat()       │   │
│  │         │                  │                    │          │   │
│  │         └──────────────────┼────────────────────┘          │   │
│  │                            ▼                                │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │  supabaseQuery.cjs (SQL shim — DEPRECATED)           │  │   │
│  │  │  Used by: baseService, index.cjs inline routes,      │  │   │
│  │  │  auditService, bootstrap, ai/baseService             │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                    │
│                              ▼                                    │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  supabaseStore.cjs (read mirror, 15s cache)              │   │
│  │  Used by: portalService only                            │   │
│  │  Tables: products, customers, invoices, sales            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              │                                    │
│                              ▼                                    │
│                    ┌──────────────────┐                          │
│                    │   Supabase REST   │                          │
│                    │   (PostgREST)     │                          │
│                    └──────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 7. Reverse / Read Paths

### 7.1 Admin ERP reads
- **Primary path:** `supabaseRepository.cjs` `getAll()` / `getById()` → direct PostgREST GET with optional `data->>col=eq.value` filters
- **Fallback path:** None — failures propagate to caller

### 7.2 Portal reads
- **Primary path:** `supabaseStore.cjs` (cached, 15s TTL) → PostgREST GET
- **Fallback path:** `supabaseRepository.cjs` `getAllFlat()` / `getByIdFlat()` for portal_users, portal_sessions, etc.

### 7.3 Realtime / polling
- **Backend:** No push from backend to frontend for business data changes
- **Frontend:** Cross-tab `BroadcastChannel('primeerp-data-sync')` + `window` `CustomEvent('primeerp:data-changed')`
- **Portal:** SSE via `GET /api/portal/events` (EventSource with `?token=` query param)

---

## 8. JSONB Field Filtering Patterns

### 8.1 Envelope tables (`supabaseRepository.cjs`)
All business tables use the envelope pattern:
```sql
-- PostgREST filter translated from:
repo.getAll('customers', { 'data->>status': 'eq.Active' })
-- becomes:
GET /rest/v1/customers?data->>status=eq.Active
```

### 8.2 Flat tables (`supabaseRepository.cjs` `portalEntities`)
Portal tables use direct columns:
```sql
-- No JSONB wrapping:
repo.getAllFlat('portal_users', { email: 'eq.user@example.com' })
-- becomes:
GET /rest/v1/portal_users?email=eq.user@example.com
```

### 8.3 SQL shim (`supabaseQuery.cjs`)
```sql
-- Input SQL:
SELECT * FROM customers WHERE status = 'Active' AND city = 'Lilongwe'
-- Parsed to:
GET /rest/v1/customers?data->>status=eq.Active&data->>city=eq.Lilongwe
```

---

## 9. Company Isolation

**Current state:** NO company isolation in any Supabase access layer.

- `supabaseRepository.cjs` envelope includes `company_id` column but NO queries filter by it
- `supabaseQuery.cjs` SQL shim has no company scoping
- `cloudSyncStore.cjs` uses service-role key (bypasses RLS)
- `supabaseStore.cjs` has no company filtering

**Note:** The baseline report documented that `company_id` exists on most tables but is not used for access control. This is a single-company deployment, so this is acceptable for now but must be addressed before multi-tenant support.

---

## 10. Sync Generation (Company Reset Safety)

### Current implementation
- **Location:** `public.settings` table, row with `id = 'sync_generation'`
- **Value:** Numeric counter (starts at 1)
- **Increment:** `POST /api/sync/reset` → `cloudSyncStore.incrementSyncGeneration()`
- **Check:** `cloudSyncStore.checkStaleOperation(op)` in `applyOp()` BEFORE any write

### Client-side
- `frontend/services/durableSyncQueue.ts` — `syncGeneration` field on queued ops
- `frontend/services/syncService.ts` — fetches server generation on auth resume
- `frontend/context/AuthContext.tsx` — invalidates stale ops on generation mismatch

### Status
✅ **Active and correct for single-company deployment.**  
⚠️ **Global scope** — if multi-company is ever needed, this must become per-company.

---

## 11. Migration Safety Checklist

| Safety Property | Status | Implementation |
|---|---|---|
| No destructive SQL in Phase 1A | ✅ | Only additive changes |
| No production data modification | ✅ | Read-only analysis + new files |
| No Supabase schema changes | ✅ | No migrations executed |
| No business rule changes | ✅ | No logic changes |
| Sync generation preserved | ✅ | Not touched |
| UUID5 idempotency preserved | ✅ | Not touched |
| Tombstone handling preserved | ✅ | Not touched |
| Version checks preserved | ✅ | Not touched |
| Dead-letter behavior preserved | ✅ | Not touched |

---

## 12. Recommended Migration Order

### Phase 1A (this phase — SAFE)
1. ✅ Create canonical repository (`services/supabaseCanonicalRepository.cjs`)
2. Migrate `auditService.cjs` → canonical repo (low-risk, read-mostly)
3. Migrate `auditMiddleware.cjs` → canonical repo
4. Migrate `bootstrap.cjs` → canonical repo
5. Migrate `baseService.cjs` → canonical repo (replace `sq` with repo calls)
6. Add tests for canonical repo
7. Document all callers (this file)

### Phase 1B (requires more testing)
8. Migrate `index.cjs` inline routes → canonical repo
9. Migrate `routes/engagement.cjs` → canonical repo
10. Migrate `services/ai/baseService.cjs` → canonical repo
11. Migrate `middleware/validation.cjs` → canonical repo (already uses repo, verify)
12. Replace `supabaseQuery.cjs` with thin wrapper delegating to canonical repo

### Phase 2 (requires Phase 1B completion)
13. Migrate remaining services to canonical repo
14. Remove `supabaseQuery.cjs` entirely
15. Add company scoping to canonical repo
16. Add pagination/ordering helpers to canonical repo

---

## 13. Open Questions

1. **Should `baseService.cjs` compensating-action transactions be preserved?** They protect against partial writes but don't protect against concurrent modifications. The canonical repo should support them as an opt-in wrapper.

2. **Should `supabaseStore.cjs` be merged into `supabaseRepository.cjs`?** It has a different key (publishable vs secret) and caching semantics. Keep separate for now.

3. **Should `cloudSyncStore.cjs` be the ONLY write path?** Currently, `supabaseRepository.cjs` `upsert()` calls `cloudSyncStore.upsertRow()`, but `baseService.cjs` and `index.cjs` write directly via `sq.run()` bypassing cloudSyncStore. This is a data-safety risk that Phase 1B should address.

4. **What is the canonical JSONB filter format?** Currently three formats exist: `data->>col=eq.value` (repo), `data->>col` in params (shim), and flat columns (portal). The canonical repo should standardize on one.

---

*End of Supabase Access Inventory*

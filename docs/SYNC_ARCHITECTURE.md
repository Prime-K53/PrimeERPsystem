# Sync Architecture — Phase 1A

**Generated:** 2026-09-05  
**Baseline commit:** f8d43cd  
**Scope:** Complete data flow from frontend UI → IndexedDB → Express backend → Supabase cloud

---

## 1. Architecture Overview

Prime ERP uses an **offline-first sync architecture** with three tiers:

1. **Frontend (browser):** Zustand stores + IndexedDB durable queue
2. **Backend (Express):** Single sync gateway endpoint
3. **Cloud (Supabase):** PostgREST REST API with service-role key

### Key Properties
- **Offline-first:** Frontend works without network; sync happens when online
- **Idempotent:** UUID5 deterministic keys prevent duplicate writes
- **Versioned:** Optimistic concurrency control (OCC) with atomic PATCH
- **Tombstoned:** Soft deletes preserve data for cross-device reconciliation
- **Generation-guarded:** Global sync generation counter detects company resets

---

## 2. Frontend Sync Flow

### 2.1 Data Sources

```
┌─────────────────────────────────────────────────────────────────┐
│  ZUSTAND STORES (in-memory)                                     │
│  - useDocumentStore                                             │
│  - useInventoryStore                                            │
│  - useAccountingStore                                           │
│  - etc.                                                         │
└─────────────────────────────────────────────────────────────────┘
         │                    │                      │
         │ (mutations)        │ (background sync)    │ (realtime)
         ▼                    ▼                      ▼
┌─────────────────┐  ┌──────────────────┐  ┌───────────────────┐
│ DurableSyncQueue │  │ BackgroundSync   │  │ RealtimeChannel   │
│ (IndexedDB)      │  │ Service          │  │ (Supabase)        │
│ - pending        │  │ - push timer     │  │ - onInsert/Update │
│ - syncing        │  │ - retry loop     │  │ - postgresChanges │
│ - failed         │  │ - dead-letter    │  │                   │
│ - completed      │  │ - jitter (TODO)  │  │                   │
└─────────────────┘  └──────────────────┘  └───────────────────┘
```

### 2.2 Write Path (Push)

1. **User action** → Zustand store mutation
2. **Store writes to IndexedDB** via `durableSyncQueue.enqueue()`
3. **Queue entry** includes:
   - `operationId` — UUID5 deterministic idempotency key
   - `table` — target Supabase table
   - `recordId` — row UUID
   - `operation` — `insert` | `update` | `delete` | `upsert`
   - `payload` — domain data (JSONB fields)
   - `userId` — who made the change
   - `syncGeneration` — server generation at time of creation
   - `dependsOn` — ordered dependencies for multi-op transactions
   - `fileRef` — optional file attachment reference

4. **BackgroundSyncService** picks up pending ops:
   - Concurrency: 6 parallel pushes
   - Push interval: 60s
   - Retry: exponential backoff with jitter (TODO)
   - Dead-letter: ops that fail permanently

5. **POST to backend**:
   ```http
   POST /api/sync/ops
   Content-Type: application/json
   Authorization: Bearer <token>
   
   {
     "operations": [
       {
         "operationId": "uuid5(...)",
         "table": "sales_orders",
         "recordId": "uuid",
         "operation": "upsert",
         "payload": { "id": "uuid", "data": {...} },
         "syncGeneration": 5
       }
     ]
   }
   ```

### 2.3 Read Path (Pull)

1. **Initial pull** on auth resume / app load
2. **Per-table pull** with cursor pagination:
   - Page size: 2000 rows
   - Max per table per pass: 50000 rows
   - Cursor: `last_synced_at` metadata in IndexedDB
3. **Realtime subscription** via Supabase `postgresChanges`:
   - INSERT/UPDATE/DELETE events
   - Writes to IndexedDB
   - Emits `primeerp:data-changed` event
4. **Cross-tab sync** via `BroadcastChannel('primeerp-data-sync')`

### 2.4 Conflict Resolution

- **Optimistic concurrency control (OCC):** Version numbers on every row
- **Field-level merge:** `syncConflictResolver.ts` merges disjoint changes
- **LWW resolution:** Last-write-wins for same-field conflicts
- **Auto-merge cap:** Configurable threshold before flagging for review
- **Conflict counters:** Persisted in IndexedDB metrics

---

## 3. Backend Sync Flow

### 3.1 Endpoint

```
POST /api/sync/ops
```

**Authentication:** Bearer token (Supabase auth session)

**Request body:**
```json
{
  "operations": [
    {
      "operationId": "string (UUID5)",
      "table": "string",
      "recordId": "string | null",
      "operation": "insert | update | delete | upsert",
      "payload": { "id": "uuid", "data": {...}, "_version": 3 },
      "syncGeneration": 5
    }
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "operationId": "string",
      "status": "success | conflict | error",
      "id": "uuid",
      "version": 4,
      "updatedAt": "ISO-8601",
      "conflictType": "version_conflict | version_required | null",
      "server": { ... } // present only on conflict
    }
  ]
}
```

### 3.2 Processing Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│  POST /api/sync/ops                                             │
│                                                                  │
│  1. checkStaleOperation()                                       │
│     └─ Compare request.syncGeneration with server generation   │
│        from public.settings (id='sync_generation')             │
│     └─ Reject if mismatch (company reset detected)             │
│                                                                  │
│  2. For each operation:                                         │
│     a. checkIdempotency()                                       │
│        └─ UUID5(operationId) lookup in idempotency_keys        │
│        └─ Return cached result if already processed            │
│                                                                  │
│     b. upsertRow() / softDeleteRow()                            │
│        └─ Atomic versioned PATCH (see Section 3.3)             │
│        └─ Tombstone on delete                                   │
│        └─ Sales order number minting                            │
│                                                                  │
│     c. recordIdempotency()                                      │
│        └─ Store result in idempotency_keys (24h TTL)           │
│                                                                  │
│  3. Return aggregated results                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 3.3 Atomic Versioned Write

**The core write primitive is a single PATCH with version precondition:**

```http
PATCH /rest/v1/<table>?id=eq.<uuid>&version=eq.<expected>
{
  "id": "<uuid>",
  "data": { ...domain fields... },
  "updated_at": "<server-now>",
  "version": <expected + 1>
}
```

**Success path:**
- PostgREST returns updated row(s)
- Frontend receives `{ id, version, updatedAt }`
- Frontend increments local version to match

**Failure paths:**

| Condition | HTTP | Result |
|---|---|---|
| Version mismatch (another client wrote) | 200 + empty array | `version_conflict` with server snapshot |
| Row doesn't exist (create with version) | 200 + empty array | Fallback to POST with `version: 1` |
| Network/transport failure | Throws axios error | `error` (retryable) |
| Tombstone resurrection with version | — | Overwrites tombstone atomically |

### 3.4 Soft Delete (Tombstone)

```http
PATCH /rest/v1/<table>?id=eq.<uuid>&version=eq.<baseVersion>
{
  "id": "<uuid>",
  "data": { ...existing data..., deleted: true, deletedAt: "<now>" },
  "updated_at": "<now>",
  "version": <baseVersion + 1>
}
```

**Rationale:**
- Physical row preserved so realtime subscribers observe UPDATE
- Cross-device caches reconcile tombstones
- Periodic purge removes old tombstones (retention policy)

### 3.5 Tombstone Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│  countTombstones(table)                                         │
│  └─ GET /rest/v1/<table>?data->>deleted=eq.true                 │
│     └─ Returns count from Content-Range header                  │
│                                                                  │
│  purgeTombstones(table, retentionDays, archiveFn)               │
│  └─ Phase 1: Collect IDs (paginated, max 10000 rows)           │
│  └─ Phase 2: For each ID:                                       │
│     ├─ archiveFn(row, table) — best-effort JSONL export         │
│     └─ DELETE FROM <table> WHERE id = eq.<id>                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Backend Write Paths (Non-Sync)

### 4.1 Direct Supabase Writes (Bypassing Sync Gateway)

**These paths write directly to Supabase without going through `/api/sync/ops`:**

| File | Method | Tables | Risk |
|---|---|---|---|
| `backend/services/baseService.cjs` | `sq.run()` (SQL shim) | ALL | HIGH — no sync, no versioning |
| `backend/index.cjs` (inline routes) | `sq.run()` | `sales`, `invoices`, `accounts`, etc. | HIGH — no sync, no versioning |
| `backend/auditService.cjs` | `sq.run()` | `audit_logs` | LOW — audit trail only |
| `backend/auditMiddleware.cjs` | `sq.run()` | `audit_logs` | LOW — audit trail only |
| `backend/bootstrap.cjs` | `sq.run()` | `settings`, `users`, etc. | LOW — one-time setup |

**Impact:** These writes are NOT replicated to other devices. They exist only in the cloud database. If the ERP is used offline, these writes are lost on device switch.

### 4.2 Repository Writes (Through Sync Gateway)

**These paths write through `cloudSyncStore` via `supabaseRepository.cjs`:**

| File | Method | Tables | Risk |
|---|---|---|---|
| `supabaseRepository.cjs` `upsert()` | `cloudSyncStore.upsertRow()` | 60+ envelope tables | LOW — versioned, idempotent |
| `supabaseRepository.cjs` `upsertFlat()` | `cloudSyncStore.upsertRow()` | 5 portal flat tables | LOW |
| `supabaseRepository.cjs` `softDelete()` | `cloudSyncStore.softDeleteRow()` | Envelope tables | LOW |

**Impact:** These writes are properly synced, versioned, and idempotent.

### 4.3 Data Safety Gap

**The direct SQL shim writes (`supabaseQuery.cjs`) are a data-safety risk:**
- No versioning → silent overwrites possible
- No idempotency → duplicate ops on retry
- No sync generation check → stale ops may apply after reset
- No tombstone → hard deletes break cross-device reconciliation

**Phase 1A goal:** Migrate all critical paths to use `cloudSyncStore` exclusively.

---

## 5. Read Paths

### 5.1 Backend Reads

| Layer | Method | Tables | Caching |
|---|---|---|---|
| `supabaseRepository.cjs` `getAll()` | `GET /rest/v1/<table>` | 60+ envelope tables | None |
| `supabaseRepository.cjs` `getById()` | `GET /rest/v1/<table>?id=eq.<uuid>` | 60+ envelope tables | None |
| `supabaseStore.cjs` | `GET /rest/v1/<table>` | `products`, `customers`, `invoices`, `sales` | 15s in-process cache |
| `supabaseQuery.cjs` (SQL shim) | `GET /rest/v1/<table>?data->>col=eq.val` | ALL | None |

### 5.2 Frontend Reads

| Source | Method | Caching |
|---|---|---|
| IndexedDB (local) | `durableSyncQueue` + Zustand | Persistent |
| Supabase Realtime | `postgresChanges` channel | In-memory (ephemeral) |
| Backend API | `GET /api/...` routes | None (stateless) |

---

## 6. Data Formats

### 6.1 Envelope Pattern (Primary)

All business tables use the envelope pattern:

```typescript
{
  id: "uuid",
  data: {
    // Domain fields (customer name, invoice total, etc.)
    customerName: "Acme Corp",
    totalAmount: 150000,
    status: "paid"
    // ... up to ~1000 fields per row
  },
  company_id: "uuid | null",
  version: 3,           // Optimistic concurrency counter
  updated_at: "2026-09-05T12:00:00.000Z",  // Server timestamp
  created_at: "2026-09-01T08:00:00.000Z"   // DB default NOW()
}
```

**Why envelope?** JSONB `data` column avoids schema migrations for field changes, allows heterogeneous records per table, and simplifies sync (entire row = one version bump).

### 6.2 Flat Pattern (Portal Auth)

Portal authentication tables use flat columns:

```typescript
{
  id: "uuid",
  email: "user@example.com",
  password_hash: "...",
  role: "customer",
  created_at: "2026-09-05T12:00:00.000Z"
}
```

**Why flat?** These tables are not synced via the sync gateway; they're only read/written by portal auth routes.

### 6.3 Sync Metadata

Operations in flight carry additional metadata:

```typescript
{
  operationId: "uuid5(sha1(namespace, table+id+timestamp))",
  _version: 3,           // Base version for OCC
  _cloudSource: true,    // Marks row as cloud-originated
  _operationId: "...",   // Tracks which op created this row
  _updatedAt: "...",     // Client-side timestamp
  dependsOn: ["uuid1"],  // Ordered dependencies
  fileRef: "file-uuid"   // Optional attachment
}
```

---

## 7. Cross-Cutting Concerns

### 7.1 Sync Generation (Company Reset)

**Purpose:** Detect when the cloud database has been reset (all data wiped) so clients don't apply stale operations to fresh data.

**Implementation:**
- Single row in `public.settings` with `id = 'sync_generation'`
- Numeric counter (starts at 1)
- Incremented by `POST /api/sync/reset`
- Checked by `cloudSyncStore.checkStaleOperation()` before every write

**Client-side:**
- `durableSyncQueue` stores `syncGeneration` on each queued op
- On auth resume, client fetches server generation
- Mismatch → invalidate local queue, force fresh pull

**Status:** ✅ Active, single-company scope only.

### 7.2 Idempotency

**Purpose:** Prevent duplicate writes when network retries occur.

**Implementation:**
- `idempotency_keys` table in Supabase
- Key: UUID5(operationId) — deterministic from operation content
- Value: `{ result, expires_at }`
- Checked before every write in `/api/sync/ops`
- Recorded after every write (24h TTL)

**Status:** ✅ Active.

### 7.3 Tombstone Retention

**Purpose:** Balance cross-device reconciliation against storage bloat.

**Current:** No automatic purge (tombstones accumulate indefinitely).

**Planned:** `POST /api/sync/admin/purge-tombstones` with configurable retention.

**Status:** ⏳ Not implemented (Phase 1B+).

### 7.4 Error Classification

| Error Type | HTTP Status | Retry Behavior |
|---|---|---|
| Network failure | N/A (axios throw) | Retry with backoff |
| Version conflict | 200 + empty PATCH | Field-merge + retry |
| Version required | N/A (no version) | Fetch snapshot + retry with base |
| Auth failure | 401/403 | Dead-letter (permanent) |
| Rate limit | 429 | Retry after `Retry-After` |
| Server error | 500/502/503 | Retry with backoff |

---

## 8. Realtime Integration

### 8.1 Supabase Realtime Channel

```typescript
const channel = supabase
  .channel(`table-changes:<table>`)
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: '<table>'
  }, (payload) => {
    // Write to IndexedDB
    durableSyncQueue.writeRealtimeEvent(payload);
    // Notify React layer
    emitDataChanged(table, payload.eventType);
  })
  .subscribe();
```

### 8.2 Cross-Tab Sync

```typescript
// Same tab
window.dispatchEvent(new CustomEvent('primeerp:data-changed', { detail }));

// Other tabs
new BroadcastChannel('primeerp-data-sync').postMessage({ type: 'data-changed' });
```

---

## 9. File Reference

### Frontend
- `frontend/services/durableSyncQueue.ts` — IndexedDB queue (818 LOC)
- `frontend/services/syncService.ts` — Push/pull orchestrator (668 LOC)
- `frontend/services/backgroundSyncService.ts` — Retry loop + jitter
- `frontend/services/syncConflictResolver.ts` — Field-level merge
- `frontend/context/AuthContext.tsx` — Generation-aware auth resume
- `frontend/stores/useDocumentStore.ts` — Zustand + sync triggers

### Backend
- `backend/services/cloudSyncStore.cjs` — Sync gateway (805 LOC)
- `backend/services/supabaseRepository.cjs` — Envelope CRUD (1088 LOC)
- `backend/services/supabaseQuery.cjs` — SQL shim (163 LOC) — DEPRECATED
- `backend/services/supabaseStore.cjs` — Read mirror (237 LOC)
- `backend/routes/sync.cjs` — `/api/sync/ops` endpoint
- `backend/services/baseService.cjs` — Compensating-action transactions

### Database
- `supabase/migrations/0015_sync_generation.sql` — Sync generation tracking
- `idempotency_keys` table — 24h TTL idempotency cache

---

## 10. Migration Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Direct SQL writes bypass sync | HIGH | Phase 1B: Migrate to `cloudSyncStore` |
| No company isolation | MEDIUM | Acceptable for single-company; address before multi-tenant |
| Supabase REST key rotation | MEDIUM | `isConfigured()` checks at startup; env var validation |
| IndexedDB quota exhaustion | LOW | Monitor queue size; implement LRU eviction |
| Tombstone accumulation | LOW | Implement purge with retention policy |
| Stale operation replay | LOW | Sync generation check + idempotency |

---

*End of Sync Architecture Document*

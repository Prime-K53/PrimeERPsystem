# Supabase Canonical Repository Contract

**Documented:** 2026-09-05  
**Status:** Verified — Phase 1A  
**File:** `backend/services/supabaseCanonicalRepository.cjs`

---

## 1. Purpose

The canonical repository (`supabaseCanonicalRepository.cjs`) provides a safer, drop-in replacement for the legacy `supabaseRepository.cjs`. It uses the same envelope pattern and delegates writes to `cloudSyncStore.cjs` for versioned, idempotent operations.

**Key properties:**
- Same API surface as legacy repository for core CRUD operations
- All writes go through `cloudSyncStore.cjs` (versioned, atomic)
- Table-registry pattern for entity-specific queries
- Supports both envelope tables (60+) and flat portal tables (5)

---

## 2. Supported Methods

### 2.1 Core CRUD

| Method | Arguments | Returns | Description |
|--------|-----------|---------|-------------|
| `getAll(table, filters?)` | `table: string`, `filters: object?` | `Array<domainObject>` | Read all rows with optional PostgREST filters |
| `getById(table, id)` | `table: string`, `id: string` | `domainObject | null` | Read single row by ID |
| `upsert(table, domainObject)` | `table: string`, `domainObject: object` | `domainObject | null` | Upsert via cloudSyncStore |
| `softDelete(table, id)` | `table: string`, `id: string` | `domainObject | null` | Soft-delete via cloudSyncStore (tombstone) |
| `count(table, filters?)` | `table: string`, `filters: object?` | `number` | Count rows using Content-Range header |

### 2.2 Strict Read (Error-Sensitive)

| Method | Arguments | Returns | Description |
|--------|-----------|---------|-------------|
| `getAllStrict(table, filters?)` | `table: string`, `filters: object?` | `Array<domainObject>` | Same as `getAll` but throws on error instead of returning empty array |

### 2.3 Flat Helpers (Portal Tables)

| Method | Arguments | Returns | Description |
|--------|-----------|---------|-------------|
| `getAllFlat(table, filters?)` | `table: string`, `filters: object?` | `Array<object>` | Read flat table rows (no envelope unwrapping) |
| `getByIdFlat(table, id)` | `table: string`, `id: string` | `object | null` | Read single flat row |
| `upsertFlat(table, record)` | `table: string`, `record: object` | `object | null` | Direct upsert to flat table |
| `updateFlat(table, id, updates)` | `table: string`, `id: string`, `updates: object` | `object | null` | Direct update to flat table |

### 2.4 Configuration

| Method | Arguments | Returns | Description |
|--------|-----------|---------|-------------|
| `isConfigured()` | none | `boolean` | Check if SUPABASE_URL and SECRET_KEY are valid |

### 2.5 Internal Helpers (Exported for Testing/Compatibility)

| Method | Arguments | Returns | Description |
|--------|-----------|---------|-------------|
| `fromSupabaseRow(row)` | `row: object` | `domainObject` | Convert Supabase row to domain object |
| `toSupabaseRow(domain)` | `domain: object` | `object` | Convert domain object to Supabase row format |
| `request(table, params?, options?)` | `table: string`, `params: object?`, `options: object?` | `Array | null` | Low-level GET request to Supabase |

---

## 3. Return Shapes

### 3.1 Domain Object (Envelope Tables)

```javascript
{
  id: 'uuid-string',
  // ... data fields spread from JSONB `data` column ...
  customer_name: 'Acme Corp',     // example data field
  address: { street: '...' },     // example nested field
  company_id: 'uuid-string | null',
  version: 1,                     // number (defaults to 0 if missing)
  updated_at: '2026-01-01T00:00:00.000Z' | null,
  created_at: '2026-01-01T00:00:00.000Z' | null,  // from data envelope or DB column
}
```

**Notes:**
- The `data` JSONB column is **spread** into the domain object (not nested under `data`)
- `created_at` prefers the in-envelope value if present (legacy row compatibility)
- `version` is always a number (defaults to 0)
- Timestamps are normalized to strict ISO-8601

### 3.2 Flat Object (Portal Tables)

```javascript
{
  id: 'uuid-string',
  email: 'user@example.com',
  password_hash: '...',
  role: 'customer',
  created_at: '2026-01-01T00:00:00.000Z',
  // ... direct columns, no envelope unwrapping ...
}
```

---

## 4. Envelope Format

The canonical repository uses the same envelope pattern as the legacy repository:

```sql
-- Supabase table structure
[id] UUID PRIMARY KEY,
[data] JSONB,           -- domain fields
[company_id] UUID,      -- company reference (NOT used for filtering)
[version] INTEGER,      -- optimistic concurrency counter
[updated_at] TIMESTAMPTZ,
[created_at] TIMESTAMPTZ  -- DB DEFAULT NOW()
```

**Wire format (what Supabase returns):**
```javascript
{
  id: 'uuid',
  data: { customer_name: 'Acme', status: 'active' },
  company_id: 'uuid',
  version: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z'
}
```

**Domain format (what callers receive):**
```javascript
{
  id: 'uuid',
  customer_name: 'Acme',    // from data.customer_name
  status: 'active',         // from data.status
  company_id: 'uuid',
  version: 1,
  updated_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z'
}
```

---

## 5. Company Scoping

**Current behavior:** NO automatic company_id filtering.

- The `company_id` column is preserved in the domain object
- The canonical repository does NOT inject `company_id` filters automatically
- Callers can provide explicit `company_id` filters if needed: `repo.getAll('customers', { company_id: 'eq.company-1' })`
- This is a single-company deployment; multi-tenant isolation is deferred to Phase 2

**Why:** The baseline report documented that `company_id` exists on most tables but is not used for access control. This is acceptable for the current single-company deployment.

---

## 6. Version Handling

### 6.1 Reading Versions

- `version` is always returned as a number
- Missing or null `version` defaults to `0`
- String versions are converted to numbers

### 6.2 Writing Versions

- The canonical repository delegates writes to `cloudSyncStore.cjs`
- `cloudSyncStore.upsertRow()` handles version increment atomically
- New rows are stamped with `version: 1`
- Updates increment the version by 1

**Important:** The canonical repository's `upsert()` does NOT call `toSupabaseRow()`. It passes the raw domain object to `cloudSyncStore`, which handles the envelope conversion and version management.

---

## 7. Tombstones (Soft Delete)

### 7.1 Soft Delete Behavior

- `softDelete(table, id)` delegates to `cloudSyncStore.softDeleteRow()`
- `cloudSyncStore` writes a tombstone: `data.deleted = true` + `data.deletedAt = <now>`
- The physical row is preserved (no hard DELETE)
- Version is bumped by 1

### 7.2 Reading Tombstones

- Tombstoned rows are returned like any other row
- The domain object includes `deleted: true` and `deletedAt: <timestamp>`
- Callers can filter or handle tombstones as needed

### 7.3 Tombstone Lifecycle (Managed by cloudSyncStore)

- `countTombstones(table)` — count soft-deleted rows
- `purgeTombstones(table, retentionDays, archiveFn)` — archive and hard-delete old tombstones

---

## 8. Error Behavior

### 8.1 Read Errors

| Scenario | `getAll()` | `getById()` | `getAllStrict()` | `count()` |
|----------|------------|-------------|------------------|-----------|
| Supabase error (any status) | Returns `[]` | Returns `null` | **Throws** | Returns `0` |
| Network error | Returns `[]` | Returns `null` | **Throws** | Returns `0` |
| Empty result | Returns `[]` | Returns `null` | Returns `[]` | Returns `0` |
| Not configured | Returns `[]` | Returns `null` | **Throws** | Returns `0` |

### 8.2 Write Errors

| Scenario | `upsert()` | `softDelete()` |
|----------|------------|----------------|
| Not configured | Returns `null` (logs warning) | Returns `null` |
| No ID on domain object | Returns `null` (logs warning) | N/A |
| cloudSyncStore error | Returns `null` (logs warning) | Returns `null` (logs warning) |

### 8.3 Error Philosophy

- The canonical repository **fails clearly** rather than silently returning incorrect data
- Read errors return safe defaults (`[]`, `null`, `0`) to avoid crashing callers
- `getAllStrict()` is provided for critical reads that must fail visibly
- Write errors are logged but don't throw (caller handles the null result)

---

## 9. Relationship with cloudSyncStore.cjs

### 9.1 Write Path

```
supabaseCanonicalRepository.upsert()
  └── cloudSyncStore.upsertRow(table, id, domainObject)
        └── Atomic PATCH with version precondition
        └── OR POST for new records
```

### 9.2 Delete Path

```
supabaseCanonicalRepository.softDelete()
  └── cloudSyncStore.softDeleteRow(table, id)
        └── Atomic PATCH with version precondition
        └── Writes tombstone (data.deleted = true)
```

### 9.3 What cloudSyncStore Provides

- UUID5 idempotency (via separate idempotency_keys table)
- Atomic versioned writes (single PATCH with WHERE version = expected)
- Tombstone handling (soft delete, not hard delete)
- Sync generation checking (stale operation rejection)
- Error classification (retryable vs non-retryable)

---

## 10. Relationship with Legacy supabaseRepository.cjs

### 10.1 Compatibility

The canonical repository is designed as a **drop-in replacement** for the legacy repository:

| Feature | Legacy (`supabaseRepository.cjs`) | Canonical (`supabaseCanonicalRepository.cjs`) |
|---------|-----------------------------------|-----------------------------------------------|
| `getAll()` | ✓ | ✓ |
| `getById()` | ✓ | ✓ |
| `upsert()` | ✓ | ✓ |
| `softDelete()` | ✓ | ✓ |
| `count()` | ✓ | ✓ |
| `getAllStrict()` | ✓ | ✓ |
| `isConfigured()` | ✓ | ✓ |
| `fromSupabaseRow()` | ✓ | ✓ |
| `toSupabaseRow()` | ✓ | ✓ |
| Table registry (`entityQueries`) | Partial (hand-written per table) | Full (auto-generated for 60+ tables) |
| Flat helpers | ✗ | ✓ (added for portal tables) |
| Portal entities | ✗ | ✓ (portal_users, sessions, etc.) |

### 10.2 Key Differences

1. **Table registry pattern:** Canonical uses `buildEntityQueries(ENVELOPE_TABLES)` to auto-generate entity queries for 60+ tables, while legacy has hand-written queries for ~60 tables.

2. **Flat helpers:** Canonical adds `getAllFlat()`, `getByIdFlat()`, `upsertFlat()`, `updateFlat()` for portal tables.

3. **Portal entities:** Canonical exposes `portalEntities` with pre-configured CRUD for portal_users, portal_sessions, portal_password_resets, portal_login_history.

4. **Entity getters:** Canonical exposes direct getters for commonly accessed tables: `financialYears`, `profitMarginSettings`, `purchaseOrders`, `goodsReceipts`, `workCenters`, `productionResources`, `customerPayments`, `supplierPayments`.

### 10.3 Migration Safety

- The canonical repository does NOT introduce incompatible method names
- The canonical repository does NOT change return shapes for core methods
- The canonical repository does NOT modify business behavior
- Migration is safe because both repositories delegate writes to `cloudSyncStore`

---

## 11. Entity Queries (Table Registry)

### 11.1 Pre-registered Tables

The canonical repository pre-registers 60+ envelope tables:

```javascript
const ENVELOPE_TABLES = [
  'accounts', 'acceptance_runs', 'assets', 'audit_logs',
  'bank_accounts', 'bank_adjustments', 'bank_alerts', /* ... */
  'customers', 'delivery_notes', 'departments', 'documents',
  /* ... */
  'warehouses', 'wallet_transactions',
  'work_centers', 'work_orders',
];
```

### 11.2 Accessing Entity Queries

```javascript
// Direct access
const customers = repo.customers;
const invoices = repo.invoices;

// Via entities object
const allEntities = repo.entities;
const customers = repo.entities.customers;

// Specific getters
const fy = repo.financialYears;
const pms = repo.profitMarginSettings;
```

### 11.3 Entity Query Interface

Each entity query exposes:
```javascript
{
  getAll: (filters = {}) => getAll(table, filters),
  getById: (id) => getById(table, id),
  upsert: (record) => upsert(table, record),
  softDelete: (id) => softDelete(table, id),
}
```

---

## 12. Portal Entities (Flat Tables)

### 12.1 Supported Tables

```javascript
const portalEntities = {
  portal_users: { getAll, getById, getByEmail, getByCustomerId, upsert, update },
  portal_sessions: { getAll, getById, upsert, update },
  portal_password_resets: { getAll, getById, upsert, update },
  portal_login_history: { getAll, getById, upsert },
};
```

### 12.2 Flat Table Characteristics

- No envelope wrapping (direct columns)
- No `data` JSONB column
- No `version` or `company_id` handling
- Direct PostgREST queries

---

## 13. Limitations (Not Implemented)

The following are NOT part of the canonical repository contract:

- **Direct SQL queries** — The canonical repository only supports PostgREST REST API calls
- **Automatic company_id filtering** — Must be provided by caller if needed
- **Pagination helpers** — Callers must handle pagination via filters
- **Ordering helpers** — Callers must provide `order` filter
- **Transactions** — Not supported; use compensating actions in service layer
- **update() method** — Use `upsert()` instead (same behavior via cloudSyncStore)

---

## 14. Verified Behavior (Phase 1A)

The following behaviors have been verified by unit tests:

### Read Operations
- ✓ `getAll()` returns array of domain objects
- ✓ `getAll()` returns empty array for no rows
- ✓ `getAll()` returns empty array on error
- ✓ `getById()` returns domain object when exists
- ✓ `getById()` returns null when not found
- ✓ `getById()` returns null on error
- ✓ `count()` returns count from Content-Range header
- ✓ `count()` returns 0 on error or missing header

### Write Operations
- ✓ `upsert()` delegates to cloudSyncStore
- ✓ `upsert()` returns null when not configured
- ✓ `upsert()` returns null when no ID
- ✓ `upsert()` returns null on cloudSyncStore error
- ✓ `softDelete()` delegates to cloudSyncStore
- ✓ `softDelete()` returns null when not configured
- ✓ `softDelete()` returns null on cloudSyncStore error

### Data Contract
- ✓ JSONB data envelope is spread into domain object (not nested)
- ✓ `created_at` prefers in-envelope value
- ✓ Handles null data gracefully
- ✓ Handles missing data field gracefully

### Company Isolation
- ✓ `company_id` is preserved in domain object
- ✓ No automatic company_id filter injection
- ✓ Callers can provide explicit company_id filters

### Versioning
- ✓ Version is preserved as number
- ✓ Version defaults to 0 when missing
- ✓ String versions are converted to numbers

### Tombstones
- ✓ Tombstone data (deleted, deletedAt) is preserved when reading
- ✓ Soft delete does NOT physically delete rows
- ✓ Tombstoned records are returned like any other record

### Error Handling
- ✓ Supabase read errors return safe defaults
- ✓ Supabase write errors return null
- ✓ Missing records return null (getById) or empty array (getAll)
- ✓ Malformed responses are handled gracefully
- ✓ Empty results return safe defaults

### Configuration
- ✓ `isConfigured()` returns true when URL and key are valid
- ✓ `isConfigured()` returns false for placeholder values
- ✓ `isConfigured()` returns false when env vars missing

### Compatibility
- ✓ Same public method signatures as legacy repository
- ✓ Same envelope format as legacy repository
- ✓ Delegates writes to cloudSyncStore (same as legacy)
- ✓ No incompatible method names introduced

---

*End of Canonical Repository Contract Documentation*

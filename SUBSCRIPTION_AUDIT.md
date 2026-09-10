# Subscription Feature Audit Report

**Date:** 2026-09-09  
**Scope:** Subscription (Recurring Invoice) feature across frontend, backend, database, and sync layers  
**Auditor:** Kilo (AI Code Review Agent)

---

## Executive Summary

The subscription feature in Prime ERP is implemented as "Recurring Invoices" — a single `recurring_invoices` table storing subscription metadata, line items, and billing configuration in a JSONB `data` column. The feature spans the frontend Orders module, a finance store, a scheduler in SalesContext, and a cloud sync gateway. While the core data flow works end-to-end, the audit reveals **several critical security, data integrity, and architectural concerns** that require immediate attention.

---

## 1. Architecture Overview

### 1.1 Data Model

| Layer | Store/Table | Key Fields |
|-------|------------|------------|
| **Cloud (Supabase)** | `recurring_invoices` | `id TEXT PK`, `company_id TEXT`, `data JSONB`, `created_at`, `updated_at` |
| **Local (IndexedDB)** | `recurringInvoices` | Full `RecurringInvoice` object |
| **No separate line items table** | — | Items stored inline in `data.items` array |

**Schema definition** (`database/archive/supabase-create-all-tables.sql:251`):
```sql
CREATE TABLE IF NOT EXISTS public.recurring_invoices (
    id TEXT PRIMARY KEY, 
    company_id TEXT, 
    data JSONB DEFAULT '{}', 
    created_at TIMESTAMPTZ DEFAULT NOW(), 
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 1.2 Frontend Data Flow

```
OrderForm.tsx (type='Recurring')
  → Orders.tsx handleSave()
    → financeStore.addRecurringInvoice() / updateRecurringInvoice()
      → api.finance.saveRecurringInvoice(r)
        → dbService.put('recurringInvoices', r)
          → durableSyncQueue.enqueue({table:'recurring_invoices', operation:'upsert', payload:r})
            → sync.cjs POST /api/sync/ops
              → cloudSyncStore.applyOp()
                → upsertRow() → Supabase PATCH/POST
```

### 1.3 Scheduler (Recurring Billing Engine)

Located in `frontend/context/SalesContext.tsx:288` (`runRecurringBilling`):
- Runs every 5 minutes via `useModuleRefresh` hook
- Filters `finance.recurringInvoices` for `status === 'Active'`
- Checks if `nextRunDate` or `scheduledDates` matches today
- Creates a new `Invoice` with `status: 'Paid'` and `paidAmount: roundedTotal`
- Updates subscription `nextRunDate` or marks as `Expired`
- Calls `transactionService.processRecurringInvoice()` for atomic persistence

### 1.4 Sync Gateway

`backend/routes/sync.cjs` — `POST /api/sync/ops`:
- **Admin-only** (portal customers rejected)
- Table allow-list includes `recurring_invoices`, `scheduled_payments`, `wallet_transactions`
- Per-operation idempotency via `operationId` + UUID5 keys
- Optimistic concurrency control via `_version`/`version` field
- Soft deletes via tombstones (`data.deleted = true`)
- Sync generation check (stale operations after company reset rejected)

---

## 2. Critical Findings

### 2.1 🔴 CRITICAL: Permissive RLS Policy on `recurring_invoices`

**Location:** `database/archive/_FIX_SYNC_ISSUES.sql:130`

```sql
CREATE POLICY allow_all_recurring_invoices ON recurring_invoices 
FOR ALL TO authenticated 
USING (true) WITH CHECK (true)
```

**Impact:** Any authenticated user (including non-Admin portal customers) can SELECT, INSERT, UPDATE, and DELETE any recurring invoice record. There is no `company_id` or `user_id` filtering. This means:
- A customer can read all subscriptions across all companies
- A customer can modify or delete subscriptions they don't own
- A customer can insert new subscriptions into any company's data

**Recommendation:** Replace with row-level security policies that filter by `company_id` and enforce ownership. Example:
```sql
CREATE POLICY subscription_access ON recurring_invoices
FOR ALL TO authenticated
USING (company_id = current_setting('app.current_company_id')::TEXT)
WITH CHECK (company_id = current_setting('app.current_company_id')::TEXT);
```

### 2.2 🔴 CRITICAL: Scheduler Creates Invoices as "Paid" Without Payment Processing

**Location:** `frontend/context/SalesContext.tsx:325-337`

```javascript
const invoice: Invoice = {
    id: invId,
    customerId: sub.customerId,
    customerName: sub.customerName,
    totalAmount: roundedTotal,
    paidAmount: roundedTotal,  // ← Full amount marked as paid
    date: new Date().toISOString(),
    dueDate: sub.nextRunDate,
    status: 'Paid',           // ← Immediately paid
    items: sub.items,
    ...
};
```

**Impact:**
- Subscriptions auto-generate invoices that are immediately marked as **Paid** with `paidAmount === totalAmount`
- No actual payment transaction is processed (no wallet deduction, no payment record)
- The `autoDeductWallet` checkbox in OrderForm is **never checked** by the scheduler
- Wallet balance is not decremented when subscriptions auto-bill
- This creates a discrepancy between the invoice ledger and actual wallet balance

**Recommendation:** 
- The scheduler should create invoices with `status: 'Unpaid'` or `status: 'Partial'` 
- If `autoDeductWallet` is enabled, the scheduler should process the wallet deduction via `transactionService`
- Otherwise, invoices should be created as unpaid and sent for collection

### 2.3 🔴 CRITICAL: `executeAtomicOperation` Is Not Truly Atomic

**Location:** `frontend/services/db.ts:960-972`

```javascript
async executeAtomicOperation<T>(stores: (keyof NexusDB)[], operation: (tx: any) => Promise<T>): Promise<T> {
    const cloudTx = {
        objectStore: (storeName: string) => ({
            put: (item: any) => this.put(storeName as keyof NexusDB, item),
            ...
        }),
        done: Promise.resolve(),
    };
    return operation(cloudTx);
}
```

**Impact:**
- `transactionService.processRecurringInvoice()` claims to be an "atomic transaction" but each `put()` call independently enqueues a sync operation to the cloud
- If the invoice is saved but the subscription update fails, the system is left in an inconsistent state
- There is no rollback mechanism — each store write is independent
- The IndexedDB transaction (`tx`) is simulated, not a real ACID transaction across stores

**Recommendation:**
- Implement a two-phase commit or saga pattern for cross-store operations
- Use a local transaction log that can be replayed/rolled back
- At minimum, add compensating transactions for failed steps

### 2.4 🟠 HIGH: Financial Year Middleware Not Applied to Sync Gateway

**Location:** `backend/middleware/financialYearMiddleware.cjs` vs `backend/routes/sync.cjs`

The `financialYearMiddleware` provides `injectFinancialYear`, `addFyDateFilter`, and `requireFyNotClosed` functions. However, the sync gateway (`sync.cjs`) does **not** apply these middleware functions to subscription write operations.

**Impact:**
- Subscriptions can be created/modified during a closed financial year
- Subscription-generated invoices are not scoped to the financial year
- `addFyDateFilter` is never applied to `recurring_invoices` queries
- The `requireFyNotClosed` guard is never checked before subscription writes

**Recommendation:**
- Apply `injectFinancialYear` middleware to the `/api/sync/ops` route
- Add `requireFyNotClosed` check before processing subscription operations
- Filter subscription queries by financial year date range

### 2.5 🟠 HIGH: No `recurring_invoice_items` Table — Items Stored Inline

**Finding:** There is no separate `recurring_invoice_items` table. Subscription line items are stored as an array inside the `recurring_invoices.data` JSONB column.

**Impact:**
- Cannot query individual line items independently (no SQL filtering on item-level data)
- No foreign key constraints or referential integrity for items
- Cannot apply RLS policies at the item level
- Updates to the entire subscription record are required even for a single item change
- The `recurring_invoice_items` table is referenced in the sync allow-list (`sync.cjs:52`) but does not exist in the database schema

**Recommendation:**
- Either create a proper `recurring_invoice_items` table with foreign keys, or remove it from the sync allow-list to avoid confusion
- If keeping inline items, add validation to ensure item data integrity

### 2.6 🟠 HIGH: `autoDeductWallet` Checkbox Not Processed by Scheduler

**Location:** `frontend/views/sales/components/OrderForm.tsx:2468-2476`

The OrderForm has an `autoDeductWallet` checkbox for subscriptions, but the scheduler (`runRecurringBilling`) never reads or acts on this field.

**Impact:**
- Users who enable auto-deduct from wallet will never have their wallet charged
- The feature is effectively broken — users may believe subscriptions are paid from their wallet when they are not
- No error or warning is shown when the subscription generates an invoice

**Recommendation:**
- The scheduler must check `sub.autoDeductWallet` and process wallet deductions
- If wallet balance is insufficient, the invoice should be created as unpaid with a notification

### 2.7 🟡 MEDIUM: Idempotency Key Generation in Durable Sync Queue

**Location:** `frontend/services/durableSyncQueue.ts:120` (`generateOperationId`)

The operation ID is generated using `generateOperationId()` which creates a UUID. The idempotency check in `cloudSyncStore.cjs:690-702` uses UUID5 (deterministic) based on the operation ID.

**Impact:**
- If the same subscription is saved twice with the same ID (e.g., due to a retry), the second operation is a no-op
- However, if the payload changes between retries (e.g., user edits the subscription while a sync is in progress), the merged payload may not reflect the latest changes
- The `upsert` deduplication logic in `durableSyncQueue.ts:361-378` merges payloads for the same recordId, but this only works for identical operation types

**Recommendation:**
- Ensure the operation ID includes a timestamp or version component to distinguish between different saves of the same record
- The merge logic should preserve the most recent fields, not just concatenate them

### 2.8 🟡 MEDIUM: No Financial Year Validation on Subscription Creation

**Location:** `frontend/views/sales/components/OrderForm.tsx:2456-2466`

The OrderForm has `startDate`, `endDate`, and `nextRunDate` fields for subscriptions, but there is no validation that these dates fall within an open financial year.

**Impact:**
- Subscriptions can be created with dates in closed financial years
- The scheduler may generate invoices in closed periods
- No error is shown to the user

**Recommendation:**
- Add client-side validation to check dates against the current financial year
- Add server-side validation in the sync gateway using `requireFyNotClosed`

---

## 3. Moderate Findings

### 3.1 The `recurring_invoices` Table Has `company_id` Column But No RLS Enforcement

**Location:** `database/archive/supabase-rls-hardening-migration.sql:171`

The `company_id` column was added via migration, but the RLS policy (`allow_all_recurring_invoices`) uses `USING (true)` which ignores `company_id` entirely. The column exists but is not used for access control.

### 3.2 Portal Customer Dashboard Shows Wallet Balance But No Subscription Management

**Location:** `frontend/views/portal/CustomerDashboard.tsx:785-789`

The portal shows wallet balance and allows navigation to `/portal/wallet`, but there is no subscription management interface in the portal. Customers cannot view, pause, or manage their subscriptions from the portal.

### 3.3 `recurringConversion.ts` Converts Subscriptions to Orders But Lacks Financial Year Check

**Location:** `frontend/utils/recurringConversion.ts`

The `recurringConversion.ts` service converts subscriptions to orders, but the conversion does not validate the financial year. If the subscription's dates fall in a closed FY, the converted order may also be invalid.

### 3.4 Bulk Delete for Subscriptions Uses Soft Delete (Audit Compliance)

**Location:** `frontend/views/sales/Orders.tsx:455`

```javascript
else if (activeView === 'Subscriptions') deleteRecurringInvoice(id);
```

The `deleteRecurringInvoice` function performs a soft delete (tombstone). This is correct for audit compliance, but the `RecurringBilling.tsx` handleDelete also uses `finance.deleteRecurringInvoice(id)` which also soft-deletes. However, there is no confirmation dialog for bulk delete of subscriptions.

### 3.5 The `InvoiceDetails` Modal Is Reused for Subscription Detail View

**Location:** `frontend/views/sales/Orders.tsx:1844-1855`

```jsx
<InvoiceDetails
    invoice={selectedInvoiceForDetail}
    isSubscription={activeView === 'Subscriptions'}
    ...
/>
```

The `InvoiceDetails` component is reused for subscription detail with an `isSubscription` prop. This works but may lead to inconsistent UX if the component doesn't fully handle subscription-specific fields.

---

## 4. Sync Architecture Analysis

### 4.1 Sync Direction

The sync is **bidirectional** but primarily **client-to-cloud** for subscriptions:
- **Upload:** Client writes → `durableSyncQueue.enqueue()` → `POST /api/sync/ops` → Cloud Supabase
- **Download:** Cloud changes → Supabase realtime → `dbService.getAll()` → Local IndexedDB
- **No cloud-initiated writes** to subscription data (Admin-only gateway)

### 4.2 Idempotency

- Each operation has a unique `operationId` (UUID)
- Server checks `idempotency_keys` table before applying
- If already processed, returns `{ ok: true, replayed: true }`
- Best-effort recording of idempotency key (failure doesn't block the write)

### 4.3 Optimistic Concurrency Control (OCC)

- Client sends `_version` with each update
- Server uses atomic `PATCH ... WHERE version = expected`
- If 0 rows updated → conflict detected
- Server returns current row for client field-merge
- Tombstone resurrection supported with version

### 4.4 Sync Generation

- Each operation stamped with `syncGeneration` at creation time
- Server rejects operations with stale generation (after company reset)
- Legacy operations without generation are quarantined

### 4.5 Gap: No Financial Year in Sync Operation

The sync operation envelope (`QueuedOperation`) includes `syncGeneration` but **no financial year ID**. This means:
- Sync operations cannot be filtered by financial year
- A subscription created in FY2024 can be synced even if FY2024 is closed
- The server has no way to reject operations based on financial year

---

## 5. Data Integrity Analysis

### 5.1 Subscription → Invoice Generation

The scheduler creates invoices from subscriptions with these fields:
- `id`: Generated as `INV-REC` prefix
- `status: 'Paid'`: Immediately paid
- `paidAmount: roundedTotal`: Full amount
- `items: sub.items`: Copied from subscription items
- `dueDate: sub.nextRunDate`: Next billing date

**Issue:** The invoice is created as paid without any payment transaction. The `customerPayments` table is not updated. This creates a ledger inconsistency.

### 5.2 Subscription Status Transitions

```
Draft → Active → Paused → Active (resume)
Draft → Active → Expired (endDate exceeded)
Draft → Active → Cancelled (manual)
```

The `normalizeSubscriptionStatus` function ensures only valid statuses are used. The scheduler automatically transitions to `Expired` when `endDate` is exceeded.

### 5.3 Next Run Date Calculation

The scheduler calculates the next run date based on frequency:
- Daily: +1 day
- Weekly: +7 days
- Quarterly: +3 months
- Annually: +1 year
- Monthly: +1 month (default)

**Issue:** No handling for month-end dates (e.g., January 31 → February 28). The `addMonths` function from `date-fns` may produce unexpected results.

---

## 6. Security Analysis

### 6.1 Authentication

- Sync gateway requires Admin role (portal customers rejected)
- `saveRecurringInvoice` API requires `Admin` or `Accountant` role
- `deleteRecurringInvoice` API requires `Admin` role only
- RLS policy allows ALL authenticated users (critical gap)

### 6.2 Authorization

- No row-level authorization on `recurring_invoices` (permissive RLS)
- No company_id-based filtering in any query
- The `company_id` column exists but is never used for access control

### 6.3 Audit Logging

- `addAuditLog` is called for recurring invoice generation in the scheduler
- Audit logs are stored in the `audit_logs` table
- No audit trail for subscription creation, updates, or deletion (only for invoice generation)

---

## 7. Recommendations Summary

| Priority | Finding | Recommendation |
|----------|---------|----------------|
| 🔴 CRITICAL | Permissive RLS policy | Implement company_id-based RLS policies |
| 🔴 CRITICAL | Scheduler creates paid invoices without payment | Create unpaid invoices; process wallet deduction if enabled |
| 🔴 CRITICAL | `executeAtomicOperation` not truly atomic | Implement saga pattern or two-phase commit |
| 🟠 HIGH | Financial year middleware not applied to sync | Apply FY middleware to `/api/sync/ops` |
| 🟠 HIGH | No `recurring_invoice_items` table | Create proper table or remove from allow-list |
| 🟠 HIGH | `autoDeductWallet` not processed by scheduler | Implement wallet deduction in scheduler |
| 🟡 MEDIUM | No FY validation on subscription creation | Add client and server-side FY validation |
| 🟡 MEDIUM | No audit trail for subscription CRUD | Add audit logging for all subscription operations |
| 🟡 MEDIUM | Portal lacks subscription management | Add subscription management to customer portal |

---

## 8. Files Audited

### Frontend
- `frontend/views/sales/Orders.tsx` — Main Orders/Subscriptions view, handleSave, handleEdit, handleDelete, handleAction
- `frontend/views/sales/components/OrderForm.tsx` — Subscription form (type='Recurring'), isRecurring logic, subscription settings UI
- `frontend/stores/financeStore.ts` — addRecurringInvoice, updateRecurringInvoice, deleteRecurringInvoice
- `frontend/services/api.ts` — saveRecurringInvoice, deleteRecurringInvoice API calls
- `frontend/services/db.ts` — put(), delete(), executeAtomicOperation(), durableSyncQueue enqueue
- `frontend/services/durableSyncQueue.ts` — Operation enqueue, idempotency, sync generation, deduplication
- `frontend/context/SalesContext.tsx` — runRecurringBilling scheduler, transactionService.processRecurringInvoice
- `frontend/context/FinanceContext.tsx` — Finance context with recurring invoice methods
- `frontend/components/subscriptions/RecurringBilling.tsx` — Subscription management UI, handleAction, handleSave
- `frontend/views/sales/components/SubscriptionView.tsx` — Subscription list view with RecurringList
- `frontend/utils/recurringConversion.ts` — Subscription-to-order conversion
- `frontend/views/portal/CustomerDashboard.tsx` — Portal wallet display

### Backend
- `backend/routes/sync.cjs` — Sync gateway, POST /api/sync/ops, table allow-list, idempotency
- `backend/services/cloudSyncStore.cjs` — applyOp, upsertRow, softDeleteRow, checkIdempotency, recordIdempotency, checkStaleOperation
- `backend/middleware/financialYearMiddleware.cjs` — injectFinancialYear, addFyDateFilter, requireFyNotClosed
- `frontend/services/transactionService.ts` — processRecurringInvoice, executeAtomicOperation

### Database
- `database/archive/supabase-create-all-tables.sql` — recurring_invoices table definition
- `database/archive/supabase-rls-hardening-migration.sql` — RLS enable, company_id column
- `database/archive/_FIX_SYNC_ISSUES.sql` — Permissive RLS policy creation
- `database/archive/supabase-migration-cloud-first.sql` — Cloud migration with recurring_invoices
- `database/archive/supabase-create-all-tables.sql` — Full table schema

---

## 9. Conclusion

The subscription feature has a functional end-to-end data flow but suffers from **critical security vulnerabilities** (permissive RLS), **data integrity issues** (scheduler creates paid invoices without payment processing, non-atomic transactions), and **missing financial year enforcement**. The `autoDeductWallet` feature is non-functional. These issues should be addressed as top-priority items before the subscription feature is used in production environments with real financial data.

---

*End of Audit Report*

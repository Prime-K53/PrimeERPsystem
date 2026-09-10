# PRINTING CONTRACT DOMAIN DESIGN

**Phase 2B — Design Only**
**Date:** 2026-09-09
**Status:** Design Document — No Implementation

---

# TABLE OF CONTENTS

1. [Verification of Phase 2 Findings](#1-verification-of-phase-2-findings)
2. [Finding Classification](#2-finding-classification)
3. [Domain Model](#3-domain-model)
4. [Printing Contract Entity](#4-printing-contract-entity)
5. [Assessment Entity](#5-assessment-entity)
6. [Examination Printing Architecture](#6-examination-printing-architecture)
7. [Contract → Assessment → Job Order Relationships](#7-contract--assessment--job-order-relationships)
8. [Wallet Relationship](#8-wallet-relationship)
9. [Prepaid Amount vs Wallet Balance](#9-prepaid-amount-vs-wallet-balance)
10. [Assessment Entitlement vs Money](#10-assessment-entitlement-vs-money)
11. [Financial-Year Classification](#11-financial-year-classification)
12. [Sync Classification](#12-sync-classification)
13. [Job Order Cloud Mapping](#13-job-order-cloud-mapping)
14. [Examination Printing Architecture](#14-examination-printing-architecture)
15. [Contract Numbering](#15-contract-numbering)
16. [Status Model](#16-status-model)
17. [Amendments](#17-amendments)
18. [Deletion Rules](#18-deletion-rules)
19. [Security](#19-security)
20. [Sync Gateway + Financial Year](#20-sync-gateway--financial-year)
21. [Database Design Options](#21-database-design-options)
22. [Minimum Viable Domain](#22-minimum-viable-domain)
23. [Required Final Data Model](#23-required-final-data-model)
24. [Reuse / New Architecture Matrix](#24-reuse--new-architecture-matrix)
25. [Implementation Impact](#25-implementation-impact)
26. [Critical Distinction](#26-critical-distinction)
27. [Required Verdict](#27-required-verdict)

---

# 1. VERIFICATION OF PHASE 2 FINDINGS

Each finding from Phase 2 has been verified against the actual current codebase.

| # | Finding | Verified? | Exact Evidence | Impact on Printing Contracts |
|---|---------|-----------|----------------|------------------------------|
| 1 | `job_orders` in `ALLOWED_TABLES` | ✅ YES | `backend/routes/sync.cjs:81` — `'notification_audit_logs', 'job_orders',` | Printing Contract Job Orders can be synced through the gateway |
| 2 | `examination_printing_batches` in `ALLOWED_TABLES` | ✅ YES | `backend/routes/sync.cjs:80` — `'examination_papers', 'examination_printing_batches',` | Examination printing batches can be synced through the gateway |
| 3 | `wallet_transactions` in `ALLOWED_TABLES` | ✅ YES | `backend/routes/sync.cjs:52` — `'recurring_invoices', 'scheduled_payments', 'wallet_transactions',` | Wallet transactions can be synced through the gateway |
| 4 | `jobOrders` missing from `CLOUD_TABLE_MAP` | ❌ FALSE POSITIVE | `frontend/services/db.ts:463` — `jobOrders: 'job_orders'`, `frontend/services/syncService.ts:136` — `jobOrders: 'job_orders'`, `frontend/services/cloudDb.ts:65` — `jobOrders: 'job_orders'`, `frontend/services/repositories/index.ts:81` — `jobOrders: 'job_orders'` | **NOT A BUG.** `jobOrders` maps to `job_orders` in all four mapping files. `getCloudTable('jobOrders')` returns `'job_orders'`. |
| 5 | `examPrintingBatches` missing from `CLOUD_TABLE_MAP` | ❌ FALSE POSITIVE | `frontend/services/db.ts:466` — `examPrintingBatches: 'examination_printing_batches'`, `frontend/services/syncService.ts:139` — `examPrintingBatches: 'examination_printing_batches'`, `frontend/services/cloudDb.ts:68` — `examPrintingBatches: 'examination_printing_batches'`, `frontend/services/repositories/index.ts:81` — `examPrintingBatches: 'examination_printing_batches'` | **NOT A BUG.** `examPrintingBatches` maps to `examination_printing_batches` in all four mapping files. |
| 6 | `examPrintingBatches` not in `TABLES_TO_SYNC` | ❌ FALSE POSITIVE | `frontend/services/syncService.ts:191` — `'examPapers', 'examPrintingBatches',` | **NOT A BUG.** `examPrintingBatches` is included in the sync list. |
| 7 | `jobOrders` not in `TABLES_TO_SYNC` | ❌ FALSE POSITIVE | `frontend/services/syncService.ts:175` — `'jobOrders', 'salesExchanges', 'reprintJobs',` | **NOT A BUG.** `jobOrders` is included in the sync list. |
| 8 | Financial year middleware NOT applied to sync gateway | ✅ YES | `backend/routes/sync.cjs` — no `injectFinancialYear`, `requireFyNotClosed`, or `addFyDateFilter` imports or usage. `backend/index.cjs` applies these to ~40+ routes but NOT to `sync.cjs`. | Printing Contract operations via sync gateway bypass FY scoping. This is a **design concern** (see §20). |
| 9 | No dedicated REST routes for `job_orders` or `examination_printing_batches` | ✅ YES | `backend/index.cjs` — grep for `job_orders`, `examination_printing_batches`, `examination/jobs`, `printing/batches` returns zero results. These tables are only accessible via the sync gateway. | Printing Contract Job Orders and examination printing batches have no direct REST API. All writes go through `POST /api/sync/ops`. |
| 10 | `job_orders` schema | ✅ YES | `database/archive/supabase-create-all-tables.sql:111` — `CREATE TABLE IF NOT EXISTS public.job_orders (id TEXT PRIMARY KEY, company_id TEXT, data JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())` | Minimal schema with `data JSONB` — no structured fields for contract-specific data. |
| 11 | `examination_printing_batches` schema | ✅ YES | `database/archive/supabase-create-all-tables.sql:148` — `CREATE TABLE IF NOT EXISTS public.examination_printing_batches (id TEXT PRIMARY KEY, company_id TEXT, data JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())` | Same minimal schema. `data JSONB` is the only flexible field. |
| 12 | RLS enabled on `job_orders` and `examination_printing_batches` | ✅ YES | `database/archive/supabase-rls-hardening-migration.sql:343` — `ALTER TABLE IF EXISTS public.job_orders ENABLE ROW LEVEL SECURITY;`, line 345 — `ALTER TABLE IF EXISTS public.examination_printing_batches ENABLE ROW LEVEL SECURITY;` | Both tables have RLS. Permissive policies exist (see §19). |
| 13 | `company_id` column added to both tables | ✅ YES | `database/archive/supabase-rls-hardening-migration.sql:168` — `ALTER TABLE IF EXISTS public.job_orders ADD COLUMN IF NOT EXISTS company_id TEXT;`, line 170 — `ALTER TABLE IF EXISTS public.examination_printing_batches ADD COLUMN IF NOT EXISTS company_id TEXT;` | Tenant isolation column exists but may not be populated or enforced by RLS. |
| 14 | Sync idempotency via `operationId` + UUID5 | ✅ YES | `backend/services/cloudSyncStore.cjs:93-117` — `checkIdempotency()` uses `stringToUuid5(operationId)` to check `idempotency_keys` table. `applyOp()` returns `{ operationId, ok: true, id: seen.result || recordId, replayed: true }` if already processed. | Retried batches never double-apply. Critical for Printing Contract sync reliability. |
| 15 | `syncGeneration` stamped at enqueue time | ✅ YES | `frontend/services/durableSyncQueue.ts:431-436` — `syncGeneration` is stamped at creation time for new operations. Legacy ops without generation are quarantined. | Company reset invalidates old operations. Printing Contract operations will be protected. |
| 16 | `JobOrder` TypeScript type | ✅ YES | `frontend/types.ts:1986-1997` — `export interface JobOrder { id: string; customerId?: string; customerName?: string; productId?: string; totalQuantity: number; status: string; date?: string; dueDate?: string; notes?: string; [key: string]: any; }` | Job Order has minimal structured fields + `[key: string]: any` for extensibility. |
| 17 | `ExamPrintingBatch` TypeScript type | ✅ YES | `frontend/types.ts:2127-2133` — `export interface ExamPrintingBatch { id: string; schoolId: string; papers: ExamPaper[]; status: string; [key: string]: any; }` | Exam Printing Batch is school-centric with papers array. |
| 18 | `WalletTransaction` TypeScript type | ✅ YES | `frontend/types.ts:1526-1534` — `export interface WalletTransaction { id: string; customerId: string; amount: number; type: string; reference?: string; date: string; [key: string]: any; }` | Wallet Transaction is simple with `type` and `amount`. |
| 19 | `Customer` has `walletBalance` | ✅ YES | `frontend/types.ts:1277` — `walletBalance?: number` | Customer wallet balance is tracked on the customer record. |
| 20 | `School` type exists | ✅ YES | `frontend/types.ts:1324-1335` — `export interface School { id: string | number; name: string; pricing_type?: 'margin-based' | 'per-sheet'; pricing_value?: number; phone?: string; email?: string; address?: string; source?: 'school' | 'customer'; contactPerson?: string; [key: string]: any; }` | School has pricing info and can be a customer source. |
| 21 | `injectFinancialYear` used in `index.cjs` | ✅ YES | `backend/index.cjs:139` — imported. Applied to ~40+ routes including `/api/sales`, `/api/expenses`, `/api/income`, `/api/budgets`, `/api/transfers`, `/api/invoices`, `/api/customer-payments`, `/api/purchases`, `/api/production/*`, `/api/payroll-runs`, `/api/payslips`, `/api/bank-transactions`, `/api/vat/*`, `/api/reports/*`, `/api/sales-exchanges`, `/api/sales-orders`, `/api/stats/examination`, `/api/inventory/transactions`, etc. | FY middleware is well-established for financial routes but NOT for sync gateway. |
| 22 | `requireFyNotClosed` NOT applied to examination module routes | ✅ YES | `backend/index.cjs` — grep for `requireFyNotClosed` near examination routes returns zero results. Examination routes use `injectFinancialYear` only (line 3670: `/api/stats/examination`). | Examination module reads are FY-scoped but writes are NOT protected by `requireFyNotClosed`. |
| 23 | `examination.cjs` has no `job_orders` or `printing_batches` routes | ✅ YES | `backend/routes/examination.cjs` — grep for `job_order`, `printing_batch`, `examination_printing` returns zero results. | Examination module does not directly manage Job Orders or printing batches. |
| 24 | `syncService.ts` `STORE_TO_TABLE` mapping | ✅ YES | `frontend/services/syncService.ts:78` — `const STORE_TO_TABLE: Record<string, string> = { ... }`. Contains `jobOrders: 'job_orders'` (line 136) and `examPrintingBatches: 'examination_printing_batches'` (line 139). | Three independent mapping files all agree. |
| 25 | `durableSyncQueue` merge logic | ✅ YES | `frontend/services/durableSyncQueue.ts:356-378` — Pending upserts for same table+recordId are merged. Delete cancels pending upserts. | Prevents duplicate operations for the same record. |
| 26 | `applyOp()` error classification | ✅ YES | `backend/services/cloudSyncStore.cjs:757-785` — Network/5xx/409/429 = retryable; 4xx (except 409/429) = dead-lettered. | Printing Contract operations will follow same error handling. |
| 27 | `LOCAL_ONLY_STORES` excludes `walletTransactions` | ✅ YES | `frontend/services/db.ts:381-389` — `LOCAL_ONLY_STORES` contains `idempotencyKeys`, `customerNotificationLogs`, `alerts`, `auditLogs`, `users`. `walletTransactions` is NOT listed. | Wallet transactions sync to cloud. |
| 28 | `executeAtomicOperation` delegates to `put()` | ✅ YES | `frontend/services/db.ts:960-972` — `executeAtomicOperation` creates a `cloudTx` object that delegates to `this.put()`. | Atomic operations go through the same sync pipeline. |
| 29 | `bulkPut` skips cloud writes | ✅ YES | `frontend/services/db.ts:1127-1148` — `bulkPut` is for syncing cloud data into local cache only. | Bulk sync is one-directional (cloud → local). |

---

# 2. FINDING CLASSIFICATION

| Finding | Classification | Reasoning |
|---------|---------------|-----------|
| #4: `jobOrders` missing from `CLOUD_TABLE_MAP` | **D — False Positive** | The mapping exists in all four mapping files (`db.ts`, `syncService.ts`, `cloudDb.ts`, `repositories/index.ts`). `getCloudTable('jobOrders')` correctly returns `'job_orders'`. |
| #5: `examPrintingBatches` missing from `CLOUD_TABLE_MAP` | **D — False Positive** | Same as above. The mapping exists in all four files. |
| #6: `examPrintingBatches` not in `TABLES_TO_SYNC` | **D — False Positive** | `examPrintingBatches` is listed at `syncService.ts:191`. |
| #7: `jobOrders` not in `TABLES_TO_SYNC` | **D — False Positive** | `jobOrders` is listed at `syncService.ts:175`. |
| #8: Financial year middleware NOT applied to sync gateway | **A — Required for Printing Contracts** | Printing Contract operations (Job Orders, examination printing batches) written via `POST /api/sync/ops` bypass FY scoping. This is a design concern that must be addressed in the sync gateway architecture (see §20). |
| #9: No dedicated REST routes for `job_orders` or `examination_printing_batches` | **C — Architectural Concern** | These tables are only accessible via the sync gateway. Adding dedicated REST routes would be a separate architectural decision. The sync gateway currently serves as the sole write path. |
| #10-11: Minimal `data JSONB` schema | **C — Architectural Concern** | Both `job_orders` and `examination_printing_batches` use `data JSONB` with no structured fields. This is an existing pattern across the codebase but limits querying and reporting. Printing Contracts may need structured fields. |
| #12-13: RLS with permissive policies | **A — Required for Printing Contracts** | Both tables have RLS enabled but permissive policies (`USING (true) WITH CHECK (true)`). Printing Contracts involving financial data require proper RLS enforcement. |
| #22: `requireFyNotClosed` NOT applied to examination module | **A — Required for Printing Contracts** | If Printing Contract assessments are created through the examination module, FY closure should prevent new assessments. This must be addressed. |

---

# 3. DOMAIN MODEL

## Verified Actual Model

Based on codebase inspection, the current domain model is:

```text
CUSTOMER / SCHOOL
    │
    ├── WALLET (customer.walletBalance)
    │     │
    │     └── WALLET_TRANSACTION (id, customerId, amount, type, reference, date)
    │
    ├── JOB_ORDER (id, customerId, customerName, productId, totalQuantity, status, date, dueDate, notes)
    │     │
    │     └── EXAMINATION_PRINTING_BATCH (id, schoolId, papers[], status)
    │
    └── RECURRING_INVOICE (existing subscription mechanism)
```

**This model does NOT currently have a "Printing Contract" entity.** The closest analogues are:
- `recurring_invoices` — subscription-based billing
- `job_orders` — operational printing work
- `examination_printing_batches` — school examination printing batches

The Printing Contracts domain must introduce a new commercial layer between the customer/school and the operational entities.

---

# 4. PRINTING CONTRACT ENTITY

## Field Analysis

| Field | Required? | Existing Equivalent | Source of Truth | Reason |
|-------|-----------|--------------------|-----------------|--------|
| `id` | Yes | — | New | Primary key. UUID format consistent with existing tables. |
| `contract_number` | Yes | — | New | Human-readable identifier. Must follow existing numbering conventions (see §15). |
| `customer_id` | Yes | `job_orders.customerId`, `schools.id` | `customers.id` or `schools.id` | Links to existing Customer or School entity. |
| `school_id` | Conditional | `examination_printing_batches.schoolId` | `schools.id` | For school-based contracts. May be same as `customer_id`. |
| `start_date` | Yes | — | New | Contract commencement date. |
| `end_date` | Yes | — | New | Contract expiry date. May span financial years. |
| `status` | Yes | `job_orders.status`, `examination_printing_batches.status` | New status machine (see §16) | Contract lifecycle state. |
| `contract_type` | Yes | — | New | Distinguishes examination printing, commercial printing, etc. |
| `prepaid_amount` | Conditional | — | New | Agreed prepayment amount. NOT the same as wallet balance (see §9). |
| `assessment_entitlement` | Yes | — | New | Number of assessments included. May be a count or structured terms (see §10). |
| `terms` | Conditional | — | New | JSON or text field for contract terms, pricing rules, printing specifications. |
| `created_by` | Yes | — | New | User who created the contract. |
| `approved_by` | Conditional | — | New | User who approved the contract. |
| `company_id` | Yes | `job_orders.company_id`, `examination_printing_batches.company_id` | Existing column | Tenant isolation. |
| `created_at` | Yes | All tables have this | Existing pattern | Timestamp. |
| `updated_at` | Yes | All tables have this | Existing pattern | Timestamp. |
| `data` | Optional | `job_orders.data`, `examination_printing_batches.data` | `JSONB` | Flexible additional data. |
| `financial_year_id` | No | — | New | Optional FY reference for reporting. NOT a controlling field (see §11). |
| `version` | No | `cloudSyncStore` uses `version` | New | OCC conflict detection. |

**NOT required at MVP:**
- `approved_by` (can be added in Phase 3+)
- `financial_year_id` (contracts span FY boundaries; FY scoping should be at assessment/job order level)
- `version` (handled by sync infrastructure)

---

# 5. ASSESSMENT ENTITY

## Decision: Option D — Hybrid

**Reasoning:**

### Option A (JSON inside contract) — REJECTED
- Cannot query individual assessments independently.
- Cannot link assessments to Job Orders.
- Cannot track assessment usage across contracts.
- Reporting requires parsing JSON.

### Option B (Dedicated relational table) — PARTIALLY ACCEPTED
- Enables independent querying, linking, and reporting.
- But creates a new table that duplicates the concept of `examination_printing_batches`.

### Option C (Existing examination entity) — REJECTED
- `examination_printing_batches` is an operational record for school exam printing, not a contractual assessment.
- `examinations` table is for exam scheduling, not printing contracts.
- These entities serve different business purposes.

### Option D (Hybrid) — SELECTED
- **Contract Assessment** is a dedicated table linked to `printing_contracts`.
- It references the existing `examination_printing_batches` concept where applicable.
- It is NOT a duplicate of `examination_printing_batches` — it represents the **contractual entitlement** to print, while `examination_printing_batches` represents the **operational execution**.
- Assessment records contain: `contract_id`, `assessment_number`, `scheduled_date`, `paper_count`, `status`, `examination_printing_batch_id` (optional link to operational batch).

**Key distinction:** A Contract Assessment is a **commercial commitment** (what the customer agreed to). An examination printing batch is an **operational record** (what was actually printed for an exam). They may overlap but are not the same entity.

---

# 6. EXAMINATION PRINTING ARCHITECTURE

## What `examination_printing_batches` Represents

Based on codebase inspection:

- **Type:** `ExamPrintingBatch { id, schoolId, papers: ExamPaper[], status, [key: string]: any }`
- **Created by:** Examination module (school exam scheduling)
- **When created:** When a school exam is scheduled for printing
- **Fields:** School ID, papers array, status
- **Customer/School info:** `schoolId` links to `schools` table
- **Dates:** No explicit date field in the type definition (uses `created_at`/`updated_at`)
- **Links to Job Orders:** No direct link in the type definition. `job_orders` has `customerId` but no `batchId`.
- **Links to invoices:** No direct link.
- **Links to wallet:** No direct link.
- **Operational or contractual:** **Operational.** It represents the actual printing work for an exam, not a commercial agreement.

## Decision

`examination_printing_batches` is an **operational entity** and should NOT be repurposed as a Printing Contract Assessment. The Printing Contract domain introduces a **commercial layer** above operational records.

**Integration point:** A Contract Assessment may optionally reference an `examination_printing_batch_id` to link the commercial agreement to the operational execution. This is a foreign key reference, not a duplication.

---

# 7. CONTRACT → ASSESSMENT → JOB ORDER RELATIONSHIPS

## Verified Relationships

Based on codebase inspection:

- `JobOrder` has `customerId` and `customerName` but no `contractId` or `assessmentId`.
- `ExamPrintingBatch` has `schoolId` but no `contractId` or `assessmentId`.
- There is currently **no link** between contracts and Job Orders or printing batches.

## Proposed Relationships

```text
One Printing Contract
    → many Contract Assessments (1:N)

One Contract Assessment
    → zero or one active Job Order (1:0..1)

One Job Order
    → one Contract Assessment (N:1)

One Contract Assessment
    → zero or one Examination Printing Batch (optional link)
```

| Relationship | Cardinality | Foreign Key | Source of Truth | Lifecycle Dependency | Deletion Behavior |
|-------------|-------------|-------------|-----------------|---------------------|-------------------|
| Contract → Assessments | 1:N | `contract_assessments.contract_id` → `printing_contracts.id` | Contract Assessment | Assessment cannot exist without contract | Cascade soft-delete assessments when contract is cancelled/deleted |
| Assessment → Job Order | 1:0..1 | `job_orders.contract_assessment_id` → `contract_assessments.id` | Job Order | Job Order can exist independently but links to assessment when applicable | Job Order deletion does NOT delete assessment |
| Assessment → Exam Batch | 0:0..1 | `contract_assessments.examination_printing_batch_id` → `examination_printing_batches.id` | Optional link | Operational record, not dependent on contract | Nullify reference if batch is deleted |

---

# 8. WALLET RELATIONSHIP

## Verified Current Behavior

Based on codebase inspection:

| Event | Wallet Impact | Evidence |
|-------|--------------|----------|
| Contract creation | **NOT VERIFIED** — no contract entity exists yet | No wallet interaction in any contract-like code |
| Contract activation | **NOT VERIFIED** | No contract activation logic exists |
| School prepayment | **NOT VERIFIED** — no prepayment mechanism found | `WalletTransaction` exists but no prepayment flow identified |
| Assessment creation | **NOT VERIFIED** | No assessment entity exists yet |
| Job Order creation | **NOT VERIFIED** | `JobOrder` type has no wallet fields. `transactionService.ts` handles wallet updates on job order completion, not creation |
| Production | **NOT VERIFIED** | No wallet interaction found in production code |
| Delivery | **NOT VERIFIED** | No wallet interaction found in delivery code |
| Invoice | **YES** — `paymentService.ts` processes payments and updates wallet | `processReconciliation()`, `updateCustomerWallet()` |
| Receipt | **YES** — `paymentService.ts` updates wallet on receipt | `updateCustomerWallet()` |
| Contract cancellation | **NOT VERIFIED** | No cancellation logic exists |

## Wallet Interaction Design (Proposed)

| Event | Wallet Impact | Mechanism |
|-------|--------------|-----------|
| Contract creation | **No direct wallet impact** | Contract is a commercial agreement, not a financial transaction |
| Prepayment recorded | **Wallet credit increases** | `WalletTransaction` with `type: 'contract_prepayment'`, `amount: prepaid_amount`, `customerId: contract.customer_id` |
| Assessment created | **No direct wallet impact** | Assessment is a scheduling commitment |
| Job Order created | **No direct wallet impact** | Job Order is operational |
| Job Order completed | **Wallet debit** | `WalletTransaction` with `type: 'job_order_completion'`, `amount: job_order_cost` |
| Invoice generated | **Wallet debit** | Existing invoice/receipt flow |
| Receipt processed | **Wallet credit** | Existing payment flow |
| Contract cancelled | **Unused prepaid funds refunded** | `WalletTransaction` with `type: 'contract_cancellation_refund'`, `amount: unused_amount` |

**NOT VERIFIED — requires implementation decision:** The exact wallet transaction types, amounts, and timing for contract-related events must be defined by the finance team. The current `WalletTransaction` type (`id, customerId, amount, type, reference?, date`) is flexible enough to accommodate new types via the `type` field and `[key: string]: any`.

---

# 9. PREPAID AMOUNT VS WALLET BALANCE

## Verified Distinction

Based on codebase inspection:

- **`Customer.walletBalance`** (`frontend/types.ts:1277`): The customer's actual current financial balance. Updated by `transactionService.ts` and `paymentService.ts`.
- **Contract `prepaid_amount`** (proposed): The amount agreed/prepaid under the contract. This is a commercial figure, not a financial balance.

## Interpretation

```text
Contract prepaid amount = K5,000,000  (agreed under contract)
Wallet balance = K3,250,000           (actual remaining funds)
```

This interpretation **matches the existing ERP architecture**:
- `Customer.walletBalance` is the financial source of truth.
- Contract `prepaid_amount` is a commercial record of what was agreed.
- The two are NOT the same number and serve different purposes.

**The wallet balance is updated by financial transactions (invoices, receipts, refunds). The contract prepaid amount is a static commercial figure that may differ from the wallet balance.**

---

# 10. ASSESSMENT ENTITLEMENT VS MONEY

## Verified Current Model

Based on codebase inspection:

- `ExamPrintingBatch` has `papers: ExamPaper[]` — papers have individual properties.
- `School` has `pricing_type?: 'margin-based' | 'per-sheet'` and `pricing_value?: number`.
- `JobOrder` has `totalQuantity: number`.
- There is **no** concept of "5 assessments = 5 equal financial allocations."

## Decision

**Assessment entitlement is NOT simply a count of assessments.** It contains specific printing terms/limits.

Each `ContractAssessment` should have:
- `paper_count`: Number of pages
- `copies`: Number of copies
- `paper_type`: Paper specification
- `color_required`: Boolean
- `finishing`: Finishing specification
- `estimated_cost`: Calculated cost
- `status`: Assessment state

The `pricing_type` and `pricing_value` from `School` can inform cost calculation, but each assessment may have different specifications.

**This matches the existing architecture:** `School.pricing_type` and `School.pricing_value` exist, and `JobOrder.totalQuantity` exists. The Printing Contract domain extends these concepts with per-assessment detail.

---

# 11. FINANCIAL-YEAR CLASSIFICATION

## Classification Matrix

| Entity | Classification | FY Scoped? | Controlling Date | Reason |
|--------|---------------|------------|-----------------|--------|
| Printing Contract | **Master** | No | `start_date` / `end_date` | Contract spans commercial period; may cross FY boundaries |
| Contract Assessment | **Schedule** | Yes | `scheduled_date` | Assessment is a scheduled event within a FY |
| Job Order | **Transaction** | Yes | `date` / `dueDate` | Job Order is operational work with a date; existing `injectFinancialYear` applies to similar entities |
| Examination Batch | **Transaction** | Yes | `created_at` | Existing examination module uses FY for stats |
| Wallet Transaction | **Transaction** | Yes | `date` | Existing financial records are FY-scoped |
| Invoice | **Transaction** | Yes | `created_at` | Existing `injectFinancialYear` on `/api/invoices` |
| Receipt | **Transaction** | Yes | `date` | Existing financial records |

## Contract Cross-FY Behavior

**A Printing Contract CAN cross financial years.** Example:

```text
Contract: 01 Sep 2026 → 31 Aug 2027
FY: 2026/27
```

The contract spans the FY boundary. This is acceptable because:
- The contract is a **commercial agreement**, not a financial transaction.
- Financial transactions (assessments, job orders, invoices, wallet entries) within the contract are FY-scoped individually.
- The contract's `start_date` and `end_date` define the commercial period, not the accounting period.

**Do NOT force the contract into one FY merely because other financial records are FY-scoped.**

---

# 12. SYNC CLASSIFICATION

| Entity | Local Store | Cloud Table | Sync Required | Conflict Strategy | Tombstone? |
|--------|------------|-------------|---------------|-------------------|------------|
| Printing Contract | `printingContracts` (new) | `printing_contracts` (new) | Yes | OCC via `version` field | Yes (soft delete) |
| Contract Assessment | `contractAssessments` (new) | `contract_assessments` (new) | Yes | OCC via `version` field | Yes (soft delete) |
| Job Order | `jobOrders` | `job_orders` | Yes | OCC via `version` field | Yes (soft delete) |
| Examination Batch | `examPrintingBatches` | `examination_printing_batches` | Yes | OCC via `version` field | Yes (soft delete) |
| Wallet Transaction | `walletTransactions` | `wallet_transactions` | Yes | OCC via `version` field | Yes (soft delete) |

**Verification:**
- `jobOrders` → `job_orders` mapping exists in `db.ts:463`, `syncService.ts:136`, `cloudDb.ts:65`, `repositories/index.ts:81`.
- `examPrintingBatches` → `examination_printing_batches` mapping exists in `db.ts:466`, `syncService.ts:139`, `cloudDb.ts:68`, `repositories/index.ts:81`.
- `walletTransactions` → `wallet_transactions` mapping exists in `db.ts:477`, `syncService.ts:150`, `cloudDb.ts:79`.
- All three are in `TABLES_TO_SYNC` in `syncService.ts`.
- All three are in `ALLOWED_TABLES` in `sync.cjs`.

**New tables (`printing_contracts`, `contract_assessments`) must be added to:**
1. `CLOUD_TABLE_MAP` in `db.ts`
2. `STORE_TO_TABLE` in `syncService.ts`
3. `cloudDb.ts` mapping
4. `repositories/index.ts` mapping
5. `ALLOWED_TABLES` in `sync.cjs`
6. `TABLES_TO_SYNC` in `syncService.ts`
7. `NexusDB` schema in `db.ts`
8. `LOCAL_ONLY_STORES` check (must NOT be local-only)

---

# 13. JOB ORDER CLOUD MAPPING

## Verification

The finding that `jobOrders` is missing from `CLOUD_TABLE_MAP` was a **false positive**. The mapping exists in all four mapping files:

- `frontend/services/db.ts:463` — `jobOrders: 'job_orders'`
- `frontend/services/syncService.ts:136` — `jobOrders: 'job_orders'`
- `frontend/services/cloudDb.ts:65` — `jobOrders: 'job_orders'`
- `frontend/services/repositories/index.ts:81` — `jobOrders: 'job_orders'`

## Verdict: NOT A BUG

`getCloudTable('jobOrders')` returns `'job_orders'`. The `ALLOWED_TABLES` set in `sync.cjs` contains `'job_orders'`. Job Order synchronization is architecturally correct.

However, the `job_orders` table schema (`id TEXT PRIMARY KEY, company_id TEXT, data JSONB`) is minimal. The `JobOrder` TypeScript type has `[key: string]: any`, which means contract-specific data can be stored in the `data` JSONB field. This is the current pattern for extending Job Orders with domain-specific data.

---

# 14. EXAMINATION PRINTING ARCHITECTURE

## Investigation Results

The examination module (`backend/routes/examination.cjs`) contains routes for:
- Batches (`/batches/:id/calculate`, `/batches/:id/sync-pricing`, `/classes/:id/financial-metrics`)
- Classes, subjects, exams
- Market adjustments
- Inventory deductions
- Recurring profiles

**No routes exist for:**
- `job_orders`
- `examination_printing_batches`
- Contract-related operations

The examination module does NOT directly manage Job Orders or printing batches. These are accessed only through the sync gateway.

## Decision

Printing Contracts should **integrate with** the existing examination printing module but **NOT duplicate** it. The integration points are:

1. **Contract Assessment → Examination Printing Batch**: A `contract_assessment` record may reference an `examination_printing_batch_id` to link the commercial agreement to the operational execution.
2. **School pricing**: `School.pricing_type` and `School.pricing_value` inform contract assessment cost calculation.
3. **Exam papers**: `ExamPrintingBatch.papers` provides the operational paper details that a Contract Assessment may reference.

The examination module remains the **operational truth** for exam printing. The Printing Contract domain adds the **commercial layer** above it.

---

# 15. CONTRACT NUMBERING

## Existing Numbering Systems

Based on codebase inspection:

- **Invoice numbering**: `invoice_number` field in `invoices` table
- **Quotation numbering**: `quotation_number` field in `quotations` table
- **Job Order numbering**: No explicit numbering field in `JobOrder` type (uses `id`)
- **Receipt numbering**: No explicit numbering field found
- **Subscription numbering**: `recurring_invoices` uses `id`
- **Document numbering**: `NumberingRule` type exists in `frontend/types.ts:28-30`

## Recommendation

Use `NumberingRule` infrastructure for Printing Contract numbering. The format should follow existing conventions:

```text
PC-YYYY-NNNNN
```

Where:
- `PC` = Printing Contract prefix
- `YYYY` = Year
- `NNNNN` = Sequential number with padding

**Do NOT implement numbering in this phase.** This is a Phase 3 implementation decision.

---

# 16. STATUS MODEL

## Contract Status

| Status | Description | Transitions |
|--------|-------------|-------------|
| `draft` | Contract being prepared | → `active`, `cancelled` |
| `active` | Contract in force | → `completed`, `cancelled`, `amended` |
| `completed` | All assessments fulfilled | Terminal |
| `cancelled` | Contract cancelled | Terminal |
| `amended` | Contract modified | → `active` |

## Assessment Status

Derived from existing examination/Job Order states:

| Status | Description |
|--------|-------------|
| `scheduled` | Assessment scheduled |
| `in_progress` | Printing underway |
| `completed` | Assessment printed |
| `cancelled` | Assessment cancelled |
| `postponed` | Assessment rescheduled |

## Job Order Status

Reuse existing `JobOrder.status` values. The `JobOrder` type has `status: string` with `[key: string]: any`, so existing status values apply.

## Payment Status

Reuse existing financial status values from `invoices` and `customer_payments`.

**Do NOT create a single universal status field.** Each entity maintains its own status machine.

---

# 17. AMENDMENTS

## Investigation

Existing audit/version mechanisms:
- `AuditLogEntry` type exists (`frontend/types.ts`)
- `syncAudit.ts` provides sync audit trail
- `cloudSyncStore.cjs` uses `operationId` + UUID5 for idempotency
- `durableSyncQueue.ts` tracks operation history

## Recommendation

Amendment history should use the **existing audit system** rather than a separate table. Each contract amendment creates:
1. A new `contract_assessment` record (or updated `printing_contract` record)
2. An `AuditLogEntry` documenting the change
3. A sync operation through the durable queue

**Do NOT create a separate amendment table.** The existing audit infrastructure is sufficient.

---

# 18. DELETION RULES

| Scenario | Can Delete? | Behavior |
|----------|------------|----------|
| Draft contract | Yes | Soft delete (tombstone). No financial impact. |
| Active contract | No | Must be cancelled first. Active contracts have operational dependencies. |
| Contract with completed assessments | No | Historical data must be preserved. |
| Assessment with Job Order | No | Job Order is operational history. |
| Cancelled contract | Yes (soft) | Soft delete with tombstone. Financial records preserved. |

**Use existing soft-delete/tombstone architecture.** The sync gateway handles tombstones via `data.deleted` + `data.deletedAt`. The `durableSyncQueue` handles tombstone propagation.

---

# 19. SECURITY

## Required Controls

| Control | Current State | Printing Contract Requirement |
|---------|--------------|-------------------------------|
| `company_id` / tenant isolation | `company_id` column exists on `job_orders` and `examination_printing_batches` | New tables must have `company_id` column |
| RLS | Enabled on `job_orders` and `examination_printing_batches` but permissive (`USING (true) WITH CHECK (true)`) | New tables must have RLS enabled with proper policies |
| Backend authorization | `verifyToken` + `requireRole` on routes | New REST routes (if added) must use `requireRole` |
| Sync authorization | `POST /api/sync/ops` requires Admin role | New sync operations follow same gateway |
| Portal access | Portal is read-only for customers | Printing Contracts should not be exposed to portal |
| Permissions | 12 `PermissionNode` values across 4 roles | New permission nodes needed for Printing Contracts |

**Phase 1 audit identified permissive RLS concerns for existing subscription data.** The same risk applies to Printing Contracts. New tables must have proper RLS policies from the start.

**Do NOT modify RLS in this phase.** Document required controls for Phase 3.

---

# 20. SYNC GATEWAY + FINANCIAL YEAR

## Analysis

The sync gateway (`POST /api/sync/ops`) is currently a **transport layer** — it accepts operations and applies them to the cloud. It does NOT enforce business rules like financial year validation.

However, the question is whether the sync gateway should also be a **business authorization layer**.

### Option A: Sync Gateway as Transport Layer
- FY validation happens at the application layer (frontend or dedicated REST routes).
- Sync gateway only validates operation shape and table allow-list.
- Simpler gateway.
- Risk: Malicious or buggy client can bypass FY validation.

### Option B: Sync Gateway as Business Authorization Layer
- FY validation happens at the gateway level.
- All writes are FY-validated regardless of source.
- More secure.
- Risk: Gateway becomes complex; harder to maintain.

### Recommendation

**Hybrid approach:**
- The sync gateway should validate **operation shape** and **table allow-list** (current behavior).
- **FY validation** should be applied at the application layer for dedicated REST routes.
- For sync gateway operations, FY validation should be **optional** and configurable per table.
- The `injectFinancialYear` middleware can be conditionally applied to the sync gateway for specific tables (e.g., `job_orders`, `contract_assessments`) while remaining disabled for others (e.g., `wallet_transactions`).

**Distinguish:**
- **Synchronization**: Transport layer — sync gateway handles this.
- **Authorization**: Application layer — `verifyToken` + `requireRole` handles this.
- **Accounting-period validation**: Application layer or conditional gateway middleware.
- **Data validation**: Application layer — `validateBody` schemas handle this.

---

# 21. DATABASE DESIGN OPTIONS

## Option A — Reuse `recurring_invoices`

| Advantage | Disadvantage |
|-----------|-------------|
| Minimal new tables | `recurring_invoices` is subscription-specific; conflates commercial and operational concerns |
| Existing sync mapping | Schema mismatch; `recurring_invoices` has different fields |
| Existing portal integration | Portal expects subscription data, not printing contracts |
| Low migration complexity | Creates confusion between subscriptions and printing contracts |

**REJECTED.** The Phase 2 audit explicitly states: "Existing subscription functionality is based around recurring invoices and should NOT be treated as the final Printing Contracts architecture."

## Option B — Repurpose `recurring_invoices`

| Advantage | Disadvantage |
|-----------|-------------|
| Reuses existing table | Destroys subscription semantics; breaks existing queries |
| No new tables | High migration risk; data corruption potential |
| | Conflicts with Phase 1 audit findings |

**REJECTED.** Same reasons as Option A.

## Option C — New `printing_contracts` + `contract_assessments`

| Advantage | Disadvantage |
|-----------|-------------|
| Clean separation from subscriptions | New tables require new sync mappings |
| Purpose-built schema | Migration from existing subscription data needed |
| Clear domain boundaries | Additional sync gateway configuration |
| Scalable | New RLS policies required |

**PARTIALLY ACCEPTED.** This is the recommended approach for the core domain.

## Option D — Extend an existing examination entity

| Advantage | Disadvantage |
|-----------|-------------|
| Leverages existing `examination_printing_batches` | `examPrintingBatches` is operational, not contractual |
| No new tables | Blurs commercial/operational boundary |
| | Cannot represent contract-level concepts |

**REJECTED.** `examination_printing_batches` is an operational record, not a commercial agreement.

## Option E — Hybrid

| Advantage | Disadvantage |
|-----------|-------------|
| Clean domain separation | Most complex |
| `printing_contracts` + `contract_assessments` as new tables | |
| `contract_assessments` optionally reference `examination_printing_batches` | |
| Reuse existing `job_orders`, `wallet_transactions` | |
| | Requires careful integration design |

**SELECTED: Option E — Hybrid**

New tables: `printing_contracts`, `contract_assessments`
Reused: `job_orders`, `wallet_transactions`, `examination_printing_batches` (optional link)
Extended: `customers`/`schools` (no schema changes needed)

---

# 22. MINIMUM VIABLE DOMAIN

The smallest domain required to support the 12 MVP capabilities:

1. **Create contract** → `printing_contracts` table
2. **Assign school/customer** → `customer_id` / `school_id` fields on `printing_contracts`
3. **Define contract period** → `start_date`, `end_date` fields
4. **Define assessment entitlement** → `contract_assessments` table with `paper_count`, `copies`, etc.
5. **Schedule assessments** → `contract_assessments.scheduled_date`
6. **Record prepaid agreement** → `printing_contracts.prepaid_amount` (commercial record; wallet updated separately)
7. **Use existing wallet** → Reuse `wallet_transactions` with new `type` values
8. **Create/link printing Job Orders** → `job_orders.contract_assessment_id` (new column or `data` JSONB field)
9. **Track assessment usage** → `contract_assessments.status`
10. **Track contract status** → `printing_contracts.status`
11. **Display contract history** → `AuditLogEntry` + `printing_contracts` version history
12. **Synchronize between devices** → Existing sync infrastructure with new table mappings

**Anything outside this list is Phase 3+.**

---

# 23. REQUIRED FINAL DATA MODEL

```text
CUSTOMER / SCHOOL
    │
    ├──────── WALLET (customer.walletBalance)
    │            │
    │            └── WALLET_TRANSACTION
    │                   (id, customerId, amount, type, reference, date)
    │
    └──────── PRINTING_CONTRACT
                   (id, contract_number, customer_id, school_id, start_date,
                    end_date, status, contract_type, prepaid_amount,
                    assessment_entitlement, terms, company_id,
                    created_by, created_at, updated_at)
                       │
                       ├── CONTRACT_ASSESSMENT
                       │      (id, contract_id, assessment_number, scheduled_date,
                       │       paper_count, copies, paper_type, color_required,
                       │       finishing, estimated_cost, status,
                       │       examination_printing_batch_id [optional],
                       │       company_id, created_at, updated_at)
                       │           │
                       │           └── JOB_ORDER (optional link)
                       │                  (id, customerId, customerName, productId,
                       │                   totalQuantity, status, date, dueDate,
                       │                   notes, contract_assessment_id [new or data],
                       │                   company_id, data JSONB)
                       │                       │
                       │                       ├── PRODUCTION
                       │                       ├── DELIVERY
                       │                       └── INVOICE / RECEIPT
                       │                              (existing financial flow)
                       │
                       └── CONTRACT_HISTORY (via AuditLogEntry)
                              (existing audit infrastructure)
```

**Key relationships:**
- One Contract → many Contract Assessments
- One Contract Assessment → zero or one Job Order
- One Contract Assessment → zero or one Examination Printing Batch (optional)
- Job Order → existing production/delivery/invoice flow
- Contract → existing wallet flow (prepayment, completion, cancellation)

---

# 24. REUSE / NEW ARCHITECTURE MATRIX

| Existing Component | Reuse | Extend | Replace | New | Decision |
|-------------------|-------|--------|---------|-----|----------|
| Subscription | | | ✅ Replace | | Do NOT use `recurring_invoices` for Printing Contracts |
| Recurring Invoice | | | ✅ Replace | | Separate domain |
| Wallet | ✅ Reuse | | | | `wallet_transactions` with new `type` values |
| Wallet Transactions | ✅ Reuse | | | | Same table, new transaction types |
| Customer | ✅ Reuse | | | | `customer_id` on `printing_contracts` |
| School | ✅ Reuse | | | | `school_id` on `printing_contracts` |
| Job Orders | ✅ Reuse | ✅ Extend | | | Add `contract_assessment_id` reference |
| Examination Module | ✅ Reuse | | | | Optional link from `contract_assessments` |
| Production | ✅ Reuse | | | | Existing flow |
| Delivery | ✅ Reuse | | | | Existing flow |
| Invoice | ✅ Reuse | | | | Existing flow |
| Receipt | ✅ Reuse | | | | Existing flow |
| Portal | ✅ Reuse | | | | No portal access for contracts |
| Sync | ✅ Reuse | ✅ Extend | | | Add new table mappings |
| Audit | ✅ Reuse | | | | `AuditLogEntry` for contract history |
| Documents | ✅ Reuse | | | | Existing document system |
| Numbering | ✅ Reuse | | | | `NumberingRule` infrastructure |
| RLS | | ✅ Extend | | | New policies for new tables |
| Permissions | | ✅ Extend | | | New permission nodes |

---

# 25. IMPLEMENTATION IMPACT

## Frontend

| File | Impact |
|------|--------|
| `frontend/types.ts` | Add `PrintingContract`, `ContractAssessment` interfaces |
| `frontend/services/db.ts` | Add `printingContracts`, `contractAssessments` to `NexusDB` schema, `CLOUD_TABLE_MAP`, `STORE_NAMES`, `LOCAL_ONLY_STORES` check |
| `frontend/services/syncService.ts` | Add `printingContracts`, `contractAssessments` to `STORE_TO_TABLE` and `TABLES_TO_SYNC` |
| `frontend/services/cloudDb.ts` | Add mappings to `STORE_TO_TABLE` |
| `frontend/services/repositories/index.ts` | Add mappings |
| `frontend/services/durableSyncQueue.ts` | No changes needed (generic queue) |
| `frontend/context/` | Add new context or extend existing for Printing Contracts |
| `frontend/views/` | New views for contract management (Phase 3) |
| `frontend/components/` | New components for contract UI (Phase 3) |

## Backend

| File | Impact |
|------|--------|
| `backend/routes/sync.cjs` | Add `printing_contracts`, `contract_assessments` to `ALLOWED_TABLES` |
| `backend/services/cloudSyncStore.cjs` | No changes needed (generic `applyOp`) |
| `backend/index.cjs` | Add dedicated REST routes for Printing Contracts (if needed) with `injectFinancialYear` |
| `backend/middleware/financialYearMiddleware.cjs` | No changes needed |
| `backend/middleware/validation.cjs` | Add validation schemas for Printing Contracts |
| `backend/routes/examination.cjs` | Optional: add contract assessment links |

## Database

| Table | Impact |
|-------|--------|
| `printing_contracts` | **NEW** — `id TEXT PRIMARY KEY, contract_number TEXT, customer_id TEXT, school_id TEXT, start_date TIMESTAMPTZ, end_date TIMESTAMPTZ, status TEXT, contract_type TEXT, prepaid_amount NUMERIC, assessment_entitlement JSONB, terms JSONB, company_id TEXT, created_by TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ` |
| `contract_assessments` | **NEW** — `id TEXT PRIMARY KEY, contract_id TEXT, assessment_number INT, scheduled_date TIMESTAMPTZ, paper_count INT, copies INT, paper_type TEXT, color_required BOOLEAN, finishing TEXT, estimated_cost NUMERIC, status TEXT, examination_printing_batch_id TEXT, company_id TEXT, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ` |
| `job_orders` | **EXTEND** — Add `contract_assessment_id TEXT` column (or use `data JSONB`) |
| `wallet_transactions` | **EXTEND** — Add new `type` values (no schema change needed; `type` is `string` with `[key: string]: any`) |
| `examination_printing_batches` | **NO CHANGE** — Optional reference from `contract_assessments` |
| `customers` | **NO CHANGE** — `customer_id` reference only |
| `schools` | **NO CHANGE** — `school_id` reference only |

## Sync

| File | Impact |
|------|--------|
| `frontend/services/db.ts` | Add `printingContracts: 'printing_contracts'`, `contractAssessments: 'contract_assessments'` to `CLOUD_TABLE_MAP` |
| `frontend/services/syncService.ts` | Add to `STORE_TO_TABLE` and `TABLES_TO_SYNC` |
| `backend/routes/sync.cjs` | Add `printing_contracts`, `contract_assessments` to `ALLOWED_TABLES` |
| `backend/services/cloudSyncStore.cjs` | No changes needed |
| `frontend/services/durableSyncQueue.ts` | No changes needed |

## Wallet

| File | Impact |
|------|--------|
| `frontend/services/transactionService.ts` | Add new wallet transaction types for contract events |
| `frontend/services/paymentService.ts` | No changes needed (existing flow) |
| `frontend/services/api.ts` | Add `saveWalletTransaction` calls for contract events |
| `frontend/stores/financeStore.ts` | No changes needed |
| `frontend/services/db.ts` | No changes needed |

## Portal

| File | Impact |
|------|--------|
| `frontend/views/portal/CustomerDashboard.tsx` | No changes (contracts not exposed to portal) |
| `frontend/components/subscriptions/RecurringBilling` | No changes |

## Permissions

| File | Impact |
|------|--------|
| `frontend/constants.ts` | Add new `PermissionNode` values for Printing Contracts |
| `frontend/context/AuthContext.tsx` | Add new permission checks |
| `frontend/components/AccessControl.tsx` | Add new permission gates |
| `frontend/components/ProtectedRoute.tsx` | Add new route protection |

## Documents

| File | Impact |
|------|--------|
| `database/archive/` | New migration SQL files for `printing_contracts` and `contract_assessments` |
| `supabase/migrations/` | New migration in numeric order |

---

# 26. CRITICAL DISTINCTION

The final design MUST clearly state:

### Printing Contract
**Commercial agreement + printing entitlement + schedule.**
- Defines what the customer/school agreed to.
- Has a start date and end date that may span financial years.
- Contains prepaid amount (commercial figure, NOT wallet balance).
- Contains assessment entitlement (count and/or specific printing terms).
- Has its own status machine (draft, active, completed, cancelled, amended).

### Contract Assessment
**Individual contractual printing event.**
- A single printing commitment within a contract.
- Has specific printing specifications (paper count, copies, paper type, color, finishing).
- Has a scheduled date.
- May optionally link to an `examination_printing_batch` (operational record).
- Has its own status machine (scheduled, in_progress, completed, cancelled, postponed).

### Job Order
**Operational printing work.**
- The actual work order for printing.
- Has `totalQuantity`, `status`, `date`, `dueDate`.
- Links to a `contract_assessment` when applicable.
- Follows existing production/delivery/invoice flow.
- Has its own status (reuse existing `JobOrder.status`).

### Wallet
**Financial customer balance and ledger.**
- `Customer.walletBalance` is the actual current financial balance.
- `WalletTransaction` records all financial movements.
- Contract events (prepayment, completion, cancellation) create `WalletTransaction` records.
- Contract `prepaid_amount` is a commercial figure, NOT the wallet balance.

### Invoice / Receipt
**Financial documents.**
- Existing invoice/receipt flow handles financial transactions.
- Job Order completion triggers invoice/receipt generation.
- Payment processing updates wallet balance.

### Examination Batch
**Existing examination-printing operational entity.**
- `ExamPrintingBatch` represents operational printing for school exams.
- NOT a commercial agreement.
- May be optionally referenced by a `ContractAssessment`.
- Remains the operational truth for exam printing.

**If any of these definitions conflict with the actual codebase, document the conflict:**
- **Conflict**: `job_orders` currently has no `contract_assessment_id` field. The `JobOrder` type uses `[key: string]: any` which allows arbitrary data, but there is no structured `contract_assessment_id` field. **Resolution**: Add `contract_assessment_id` as a new column or use `data JSONB` for the reference.
- **Conflict**: `examination_printing_batches` has no date field (only `created_at`/`updated_at`). Contract assessments need `scheduled_date`. **Resolution**: `contract_assessments` has its own `scheduled_date`; `examination_printing_batches` remains unchanged.

---

# 27. REQUIRED VERDICT

## READY WITH CONDITIONS

The Printing Contracts domain design is complete and verified. The following conditions must be resolved before Phase 3 implementation:

### Conditions

1. **Finance team decision on wallet interaction**: The exact `WalletTransaction` types, amounts, and timing for contract events (prepayment, completion, cancellation) must be defined by the finance team. Current `WalletTransaction` type is flexible enough but the business rules are not yet specified.

2. **RLS policy design**: New tables (`printing_contracts`, `contract_assessments`) require proper RLS policies. The existing permissive policies (`USING (true) WITH CHECK (true)`) on `job_orders` and `examination_printing_batches` are a known concern. Phase 3 must include RLS hardening for new tables.

3. **Permission node definition**: New `PermissionNode` values for Printing Contracts must be defined by the product team. Current 12 permission nodes cover existing roles but not printing contract operations.

4. **`job_orders` contract link mechanism**: Decide whether to add a `contract_assessment_id` column to `job_orders` or use the `data JSONB` field. The `JobOrder` type has `[key: string]: any` which supports either approach, but structured columns are preferred for querying.

5. **Sync gateway FY validation**: Determine whether FY validation should be applied at the sync gateway level (conditional middleware) or at the application layer only. This is an architectural decision that affects security and maintainability.

6. **Contract numbering format**: The `NumberingRule` infrastructure exists but the specific format for Printing Contracts must be approved by the product team.

7. **Examination module integration scope**: Define exactly how `contract_assessments` link to `examination_printing_batches`. The optional foreign key reference is proposed but the integration points need to be validated by the examination module team.

### Non-blocking Issues

- The false positive findings (#4-7) about `CLOUD_TABLE_MAP` do not block implementation. The mappings exist correctly.
- The lack of dedicated REST routes for `job_orders` and `examination_printing_batches` is an architectural concern (Classification C) but does not block Printing Contracts implementation since the sync gateway works correctly.
- The minimal `data JSONB` schema on `job_orders` and `examination_printing_batches` is an existing pattern that can be extended.

---

**Document created:** 2026-09-09
**Phase:** 2B — Design Only
**Next phase:** Phase 3 — Implementation
**Order followed:** Inspect → Verify → Classify → Model → Decide → Document
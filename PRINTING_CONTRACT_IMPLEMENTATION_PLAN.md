# PRINTING CONTRACT IMPLEMENTATION PLAN

**Phase 3A — Implementation Planning Only**
**Date:** 2026-09-09
**Status:** Planning Document — No Code Changes
**Prerequisites:** Phase 2B Design Document (`PRINTING_CONTRACT_DOMAIN_DESIGN.md`)

---

# TABLE OF CONTENTS

1. [Design Re-Verification](#1-design-re-verification)
2. [Condition 1 — Wallet Interaction](#2-condition-1--wallet-interaction)
3. [Wallet Source of Truth](#3-wallet-source-of-truth)
4. [Condition 2 — RLS Design](#4-condition-2--rls-design)
5. [Condition 3 — Permission Nodes](#5-condition-3--permission-nodes)
6. [Condition 4 — Job Order Link](#6-condition-4--job-order-link)
7. [Condition 5 — Sync Gateway FY Validation](#7-condition-5--sync-gateway-fy-validation)
8. [Condition 6 — Contract Numbering](#8-condition-6--contract-numbering)
9. [Condition 7 — Examination Integration](#9-condition-7--examination-integration)
10. [Portal Decision](#10-portal-decision)
11. [Contract Data Model](#11-contract-data-model)
12. [Contract Assessment Schema](#12-contract-assessment-schema)
13. [Data Integrity Constraints](#13-data-integrity-constraints)
14. [Migration from Subscription](#14-migration-from-subscription)
15. [Frontend Implementation Map](#15-frontend-implementation-map)
16. [Backend Implementation Map](#16-backend-implementation-map)
17. [Sync Implementation Map](#17-sync-implementation-map)
18. [Financial Flow](#18-financial-flow)
19. [Offline / Multi-Device Plan](#19-offline--multi-device-plan)
20. [UI Implementation Plan](#20-ui-implementation-plan)
21. [Testing Strategy](#21-testing-strategy)
22. [Rollback Strategy](#22-rollback-strategy)
23. [Exact Phase 3 Work Packages](#23-exact-phase-3-work-packages)
24. [Dependency Order](#24-dependency-order)
25. [Blocking Decisions](#25-blocking-decisions)
26. [No-Guessing Rule](#26-no-guessing-rule)
27. [Required Final Verdict](#27-required-final-verdict)

---

# 1. DESIGN RE-VERIFICATION

The Phase 2B design document (`PRINTING_CONTRACT_DOMAIN_DESIGN.md`) has been re-verified against the current codebase. All conclusions hold:

- **Hybrid architecture** is correct: NEW `printing_contracts` + `contract_assessments`, REUSE existing `job_orders`, `wallet_transactions`, `examination_printing_batches`
- **`jobOrders` and `examPrintingBatches` mappings** exist in all four mapping files (`db.ts`, `syncService.ts`, `cloudDb.ts`, `repositories/index.ts`) — no duplicate mappings needed
- **Financial year middleware** is NOT applied to the sync gateway
- **RLS** on `job_orders` and `examination_printing_batches` uses permissive policies (`USING (true) WITH CHECK (true)`)
- **`ExamPrintingBatch` type** is `{ id, schoolId, papers: ExamPaper[], status, [key: string]: any }` — operational, not contractual
- **`JobOrder` type** is `{ id, customerId, customerName, productId, totalQuantity, status, date, dueDate, notes, [key: string]: any }` — no `contract_assessment_id` field
- **`WalletTransaction` type** is `{ id, customerId, amount, type, reference?, date, [key: string]: any }` — flexible enough for new types

---

# 2. CONDITION 1 — WALLET INTERACTION

## 2.1 Wallet Transaction Trace

### Existing Wallet Transaction Types (Verified from Code)

| Type Value | Source | Effect on `walletBalance` | File |
|------------|--------|--------------------------|------|
| `'Deposit'` | POS Sale overpayment | `+= amount` | `transactionService.ts:926-934` |
| `'Deposit'` | Payment overpayment (excess handling) | `+= amount` | `transactionService.ts:2691-2699` |
| `'Debit'` | `paymentService.updateCustomerWallet()` | `+= amount` (positive = credit, negative = debit) | `paymentService.ts:36-59` |
| `'deposit'` | `transactionService.processOverpaymentToWallet()` | `+= amount` | `transactionService.ts:5840-5857` |
| `'Deduction'` | Order wallet payment | `-= amount` | `transactionService.ts:5048-5056` |
| `'Credit'` | `paymentService.updateCustomerWallet()` | `+= amount` | `paymentService.ts:56` |
| `'Debit'` | `paymentService.updateCustomerWallet()` | `+= amount` (negative) | `paymentService.ts:56` |

### Critical Finding: Potential Double-Charging

The Phase 2 design proposed:
```text
Job Order completed → wallet debit
Invoice generated → wallet debit
```

**This is a BLOCKING issue.** The codebase shows:

1. **Order wallet payment** (`transactionService.ts:5040-5056`): When a `SalesOrder` is paid via wallet, `customer.walletBalance -= order.paidAmount` and a `WalletTransaction` with `type: 'Deduction'` is created.

2. **Invoice payment** (`paymentService.ts:36-59`): When a payment is processed, `updateCustomerWallet()` updates `customer.walletBalance` and creates a `WalletTransaction` with `type: 'Credit'` or `type: 'Debit'`.

3. **`processOverpaymentToWallet`** (`transactionService.ts:5840-5857`): Creates a `walletTransaction` with `type: 'deposit'` and updates `customer.walletBalance`.

**The question is whether Job Order completion and invoice generation are the same financial event or separate ones.**

### Analysis

In the existing ERP:
- A `SalesOrder` (which is the closest analogue to a Job Order) has `paidAmount` and `paymentMethod`
- When paid via wallet, the wallet is deducted at **order payment time**, not at completion time
- The `transactionService.ts:5040-5056` code deducts from wallet when the order is paid, not when it's completed
- Invoice generation creates a separate financial record but the wallet deduction happens at payment time

**Conclusion:**

```text
Job Order completion
→ does NOT directly cause a wallet debit
→ The wallet debit happens at PAYMENT TIME, not completion time

Invoice generation
→ does NOT directly cause a wallet debit
→ The wallet debit happens when the invoice is PAID
```

**The Phase 2 design's proposed sequence was incorrect.** The correct financial flow is:

```text
Contract created → no wallet impact (commercial agreement)
Prepayment recorded → wallet credit (Deposit)
Assessment scheduled → no wallet impact
Job Order created → no wallet impact
Job Order paid → wallet deduction (Deduction) at payment time
Invoice generated → financial record, wallet impact at payment
Receipt processed → wallet credit (if overpayment)
Contract cancelled → refund (Credit) for unused prepaid amount
```

### Wallet Transaction Types for Printing Contracts

Based on verified code patterns, the following `WalletTransaction.type` values should be used:

| Type | Event | Sign | Source Pattern |
|------|-------|------|----------------|
| `'Deposit'` | School prepayment | `+` | `transactionService.ts:926` |
| `'Deduction'` | Job Order payment | `-` | `transactionService.ts:5048` |
| `'Credit'` | Refund/cancellation | `+` | `paymentService.ts:56` |
| `'Debit'` | Adjustment | `±` | `paymentService.ts:56` |

**BLOCKED — finance/business decision required:** The exact `type` string values for contract-specific events (e.g., `'contract_prepayment'`, `'contract_cancellation_refund'`) must be approved by the finance team. The existing patterns use `'Deposit'`, `'Deduction'`, `'Credit'`, `'Debit'` — new types should follow this convention.

---

# 3. WALLET SOURCE OF TRUTH

## Verified Architecture

The existing wallet remains the **sole financial source of truth**:

- `Customer.walletBalance` (`frontend/types.ts:1277`) is the authoritative balance
- `WalletTransaction` records all movements
- `paymentService.updateCustomerWallet()` updates both `customer.walletBalance` AND creates a `WalletTransaction`
- `transactionService` creates `WalletTransaction` records and updates `customer.walletBalance`

## Prepayment Entry Point

The existing ERP already has a payment mechanism:
- `paymentService.processPayment()` handles invoice payments
- `paymentService.processReconciliation()` handles overpayments and wallet deposits
- `transactionService._executeDeductInventory()` and related methods handle POS payments with wallet deposits

**Reuse the existing payment flow.** Do NOT create a second payment mechanism.

## Contract `prepaid_amount` vs `Customer.walletBalance`

| Concept | Location | Meaning | Source |
|---------|----------|---------|--------|
| `Contract.prepaid_amount` | `printing_contracts` table | Agreed prepayment (commercial figure) | Contract creation |
| `Customer.walletBalance` | `customers` table | Actual current financial balance | Wallet transactions |

These are **NOT the same number**. The contract stores the commercial agreement; the wallet stores the actual balance.

---

# 4. CONDITION 2 — RLS DESIGN

## Current RLS Architecture

Based on `database/archive/supabase-rls-hardening-migration.sql`:

### Standard Pattern (Correct)
```sql
CREATE POLICY tenant_isolation_policy ON table_name
    AS RESTRICTIVE FOR ALL
    USING (company_id = public.get_user_company_id())
    WITH CHECK (company_id = public.get_user_company_id());
```

### Permissive Pattern (Problematic — existing on `job_orders`, `examination_printing_batches`)
```sql
CREATE POLICY allow_all ON table_name
    FOR ALL TO authenticated
    USING (true) WITH CHECK (true);
```

### Verified Patterns for Tenant-Scoped Tables

| Table | Policy Pattern | Reference |
|-------|---------------|-----------|
| `companies` | `company_id = public.get_user_company_id()` | `supabase-rls-hardening-migration.sql:361-378` |
| `profiles` | `user_id = auth.uid() OR company_id = public.get_user_company_id()` | `supabase-rls-hardening-migration.sql:386-398` |
| `idempotency_keys` | `company_id = public.get_user_company_id()` | `supabase-rls-hardening-migration.sql:402-405` |
| `tax_rates` | `company_id = public.get_user_company_id()` | `supabase-rls-hardening-migration.sql:409-427` |
| `engagement_timeline` | `company_id = get_current_company_id()` | `supabase-engagement-tables.sql:48-53` |
| `promotion_redemptions` | `company_id = get_current_company_id()` | `supabase-promotions-engine.sql:217-222` |

## Proposed RLS Policies for New Tables

### `printing_contracts`

```sql
-- Enable RLS
ALTER TABLE public.printing_contracts ENABLE ROW LEVEL SECURITY;

-- Select: tenant isolation
CREATE POLICY "Tenant isolation select"
    ON public.printing_contracts FOR SELECT
    TO authenticated
    USING (company_id = public.get_user_company_id());

-- Insert: tenant isolation + must belong to user's company
CREATE POLICY "Tenant isolation insert"
    ON public.printing_contracts FOR INSERT
    TO authenticated
    WITH CHECK (company_id = public.get_user_company_id());

-- Update: tenant isolation
CREATE POLICY "Tenant isolation update"
    ON public.printing_contracts FOR UPDATE
    TO authenticated
    USING (company_id = public.get_user_company_id())
    WITH CHECK (company_id = public.get_user_company_id());

-- Delete: tenant isolation (soft delete only)
CREATE POLICY "Tenant isolation delete"
    ON public.printing_contracts FOR DELETE
    TO authenticated
    USING (company_id = public.get_user_company_id());
```

### `contract_assessments`

```sql
-- Enable RLS
ALTER TABLE public.contract_assessments ENABLE ROW LEVEL SECURITY;

-- Select: tenant isolation + must belong to contract's company
CREATE POLICY "Tenant isolation select"
    ON public.contract_assessments FOR SELECT
    TO authenticated
    USING (company_id = public.get_user_company_id());

-- Insert: tenant isolation
CREATE POLICY "Tenant isolation insert"
    ON public.contract_assessments FOR INSERT
    TO authenticated
    WITH CHECK (company_id = public.get_user_company_id());

-- Update: tenant isolation
CREATE POLICY "Tenant isolation update"
    ON public.contract_assessments FOR UPDATE
    TO authenticated
    USING (company_id = public.get_user_company_id())
    WITH CHECK (company_id = public.get_user_company_id());

-- Delete: tenant isolation (soft delete only)
CREATE POLICY "Tenant isolation delete"
    ON public.contract_assessments FOR DELETE
    TO authenticated
    USING (company_id = public.get_user_company_id());
```

### `job_orders` (Existing — Should be hardened)

```sql
-- Currently permissive: USING (true) WITH CHECK (true)
-- Should be hardened to:
CREATE POLICY "Tenant isolation"
    ON public.job_orders FOR ALL
    TO authenticated
    USING (company_id = public.get_user_company_id())
    WITH CHECK (company_id = public.get_user_company_id());
```

**Note:** Hardening existing RLS is a separate task. This document documents the target state.

## Do NOT modify existing RLS in this phase. Document the required policies for Phase 3.

---

# 5. CONDITION 3 — PERMISSION NODES

## Current Permission Architecture

### `AVAILABLE_PERMISSIONS` (`frontend/constants.ts:166-209`)

Current permissions follow the pattern `module.action` with `module` and `label` fields:

```typescript
{ id: 'dashboard.view', label: 'View Dashboard', module: 'Analytics' },
{ id: 'sale.process', label: 'Process Sales', module: 'Sales' },
{ id: 'inventory.adjust', label: 'Adjust Stock', module: 'Inventory' },
{ id: 'ledger.post', label: 'Post Journal Entries', module: 'Finance' },
```

### `INITIAL_USER_GROUPS` (`frontend/constants.ts:211-`)

Four roles: Super Admin, Admin, Editor, Viewer. Each group has a set of permissions.

### Backend Authorization

- `verifyToken` middleware authenticates all requests
- `requireRole('Admin', 'Manager', ...)` enforces role-based access
- `checkPermission('view_stats')` enforces permission-based access
- `requireFyNotClosed` enforces financial period validation

## Proposed Permission Nodes

Following the existing `module.action` naming convention:

| Permission ID | Label | Module | Required Roles |
|---------------|-------|--------|----------------|
| `printing_contracts.view` | View Printing Contracts | Printing Contracts | Admin, Editor, Viewer |
| `printing_contracts.create` | Create Printing Contracts | Printing Contracts | Admin, Editor |
| `printing_contracts.edit` | Edit Printing Contracts | Printing Contracts | Admin, Editor |
| `printing_contracts.activate` | Activate Printing Contracts | Printing Contracts | Admin |
| `printing_contracts.amend` | Amend Printing Contracts | Printing Contracts | Admin, Editor |
| `printing_contracts.cancel` | Cancel Printing Contracts | Printing Contracts | Admin |
| `printing_contracts.manage_assessments` | Manage Contract Assessments | Printing Contracts | Admin, Editor |
| `printing_contracts.view_financials` | View Contract Financials | Printing Contracts | Admin, Accountant |
| `printing_contracts.create_job` | Create Job Orders from Contracts | Printing Contracts | Admin, Editor |

**Do NOT automatically use these names.** The exact IDs must be approved by the product team. These are candidates only.

### Mapping to Existing Roles

| Role | Default Permissions |
|------|-------------------|
| Super Admin | All permissions |
| Admin | All Printing Contracts permissions |
| Editor | `view`, `create`, `edit`, `manage_assessments`, `create_job` |
| Viewer | `view`, `view_financials` |

**Do NOT modify permissions yet.** This is a Phase 3 implementation decision.

---

# 6. CONDITION 4 — JOB ORDER LINK

## Current State

- `JobOrder` type: `{ id, customerId, customerName, productId, totalQuantity, status, date, dueDate, notes, [key: string]: any }`
- `job_orders` table schema: `id TEXT PRIMARY KEY, company_id TEXT, data JSONB`
- No `contract_assessment_id` field exists

## Analysis: Structured Column vs `data JSONB`

### Option A: Add `contract_assessment_id` as structured column

**Advantages:**
- Queryable: `SELECT * FROM job_orders WHERE contract_assessment_id = ?`
- Indexable: B-tree index for fast lookups
- Foreign key constraint possible
- Sync gateway can validate the reference
- Reporting tools can join directly

**Disadvantages:**
- Requires `ALTER TABLE job_orders ADD COLUMN contract_assessment_id TEXT`
- Migration needed
- Must handle existing rows (nullable)

### Option B: Store in `job_orders.data JSONB`

**Advantages:**
- No schema migration needed
- Flexible: can store any reference data
- Existing pattern (all tables use `data JSONB`)

**Disadvantages:**
- Not queryable without JSONB operators
- Cannot enforce foreign key constraints
- Cannot index efficiently for joins
- Reporting tools cannot easily join
- Sync gateway cannot validate the reference

### Recommendation: Option A — Structured Column

**Reasoning:**
1. The `job_orders` table already has `company_id` as a structured column (added by `supabase-rls-hardening-migration.sql`)
2. The `data JSONB` field is used for domain-specific flexible data, not for core relationships
3. `contract_assessment_id` is a core relationship that will be queried frequently
4. The existing RLS pattern uses structured `company_id` — adding `contract_assessment_id` follows the same pattern
5. Reporting and sync both benefit from structured columns

**Implementation Details:**

| Property | Value |
|----------|-------|
| Column name | `contract_assessment_id` |
| Data type | `TEXT` |
| Nullable | Yes (`NULL` for Job Orders not linked to a contract) |
| Default | `NULL` |
| Index | Yes — `CREATE INDEX idx_job_orders_contract_assessment_id ON job_orders(contract_assessment_id)` |
| Foreign key | `REFERENCES contract_assessments(id)` (optional, for referential integrity) |
| Backward compatibility | Existing Job Orders without this column continue to work; `NULL` means no contract link |
| Sync implications | `job_orders` is already in `ALLOWED_TABLES`; the new column syncs automatically via the existing `data` JSONB or as a new column |

**Migration requirement:** `ALTER TABLE job_orders ADD COLUMN contract_assessment_id TEXT;`

**Do NOT modify `job_orders` yet.** This is a Phase 3 implementation decision.

---

# 7. CONDITION 5 — SYNC GATEWAY FY VALIDATION

## Architectural Analysis

The sync gateway (`POST /api/sync/ops`) is currently a **transport layer**. It:
1. Authenticates the user (`verifyToken`)
2. Validates operation shape and table allow-list
3. Applies operations to the cloud via `cloudSyncStore.applyOp()`
4. Returns per-op results

It does NOT enforce business rules like financial year validation.

## Classification of Entities

| Entity | Type | FY Scoped? | FY Rule |
|--------|------|------------|---------|
| `printing_contracts` | Master/Commercial | No | Contract may span FY boundaries |
| `contract_assessments` | Schedule | Yes | Assessment has `scheduled_date`; should be FY-scoped |
| `job_orders` | Transaction | Yes | Existing `injectFinancialYear` applies to similar entities |
| `wallet_transactions` | Transaction | Yes | Existing financial records are FY-scoped |
| `invoices` | Transaction | Yes | Existing `injectFinancialYear` on `/api/invoices` |
| `receipts` | Transaction | Yes | Existing financial records |

## Recommendation

**Do NOT add `injectFinancialYear` + `requireFyNotClosed` to every sync operation.**

Instead, use a **hybrid approach**:

### Transport Layer (Sync Gateway)
- Continue to validate operation shape and table allow-list
- Do NOT add FY validation to the gateway itself
- The gateway is a transport mechanism, not a business authorization layer

### Application Layer (Dedicated REST Routes)
- If dedicated REST routes are created for Printing Contracts, apply `injectFinancialYear` + `requireFyNotClosed` to write routes
- Follow the existing pattern used for `/api/sales`, `/api/invoices`, `/api/expenses`, etc.

### Sync Gateway — Conditional FY Validation (Optional)
- For specific tables (`contract_assessments`, `job_orders`, `wallet_transactions`), the sync gateway COULD check `req.financialYearId` from the operation payload
- This is optional and should be evaluated in Phase 3
- The `operation` payload can include `financial_year_id` as metadata

**What Phase 3 should change:**
1. If dedicated REST routes are created → apply FY middleware to write routes
2. If sync-only → consider adding FY validation to the operation payload schema
3. Do NOT modify the sync gateway's core transport logic

---

# 8. CONDITION 6 — CONTRACT NUMBERING

## Existing Numbering Architecture

### `NumberingRule` Type (`frontend/types.ts:28-36`)

```typescript
export interface NumberingRule {
  prefix: string;
  padding: number;
  extension?: string;
  startNumber: number;
  currentNumber?: number;
  suffix?: string;
  resetInterval?: 'Never' | 'Daily' | 'Monthly' | 'Yearly';
}
```

### `PREFIX_DEFINITIONS` (`frontend/utils/numbering.ts:21-44`)

Existing prefixes: `INV`, `QTN`, `WO`, `PO`, `DN`, `PAY`, `SP`, `GRN`, `LED`, `EXP`, `REF`, `ITM`, `RAW`, `STA`, `SRV`, `CUST`, `SUP`, `BAT`, `BTC`, `ES`, `EXM`, `AUD`

### `generateNextId(type, collection, config)` (`frontend/utils/helpers.ts:54`)

Generates sequential IDs based on the type prefix and `NumberingRule`.

### `financeStore.ts` wallet transaction numbering

```typescript
const newTx = { ...tx, id: tx.id || generateNextId('WTX', get().walletTransactions) };
```

### `salesStore.ts` Job Order numbering

```typescript
const newJob = { ...jobOrder, id: jobOrder.id || generateNextId('JO', get().jobOrders) };
```

## Recommendation

Add `PC` prefix to `PREFIX_DEFINITIONS` in `numbering.ts`:

```typescript
{ prefix: 'PC', aliases: ['printingcontract', 'printing_contract', 'pc'] },
```

**Numbering format:** `PC-0001`, `PC-0002`, etc. (following the existing `generateNextId` pattern with `padding: 4`).

**Do NOT implement numbering yet.** This is a Phase 3 implementation decision. The `NumberingRule` infrastructure exists and can be reused.

---

# 9. CONDITION 7 — EXAMINATION INTEGRATION

## What `examination_printing_batches` Represents

Based on codebase inspection:

- **Type:** `ExamPrintingBatch { id, schoolId, papers: ExamPaper[], status, [key: string]: any }`
- **Created by:** Examination module (school exam scheduling)
- **When created:** When a school exam is scheduled for printing
- **Fields:** School ID, papers array, status
- **Customer/School info:** `schoolId` links to `schools` table
- **Dates:** No explicit date field (uses `created_at`/`updated_at`)
- **Links to Job Orders:** No direct link
- **Links to invoices:** No direct link
- **Links to wallet:** No direct link
- **Operational or contractual:** **Operational** — represents actual printing work for an exam

## Relationship Design

```text
Contract Assessment (contractual)
    │
    └─── optional reference ───→ Examination Printing Batch (operational)
```

| Property | Value |
|----------|-------|
| Relationship | Optional (0:0..1) |
| Foreign key | `contract_assessments.examination_printing_batch_id` → `examination_printing_batches.id` |
| Creation order | Contract Assessment created first, then optionally linked to Exam Printing Batch |
| Ownership | Contract Assessment is owned by the contract; Exam Printing Batch is owned by the examination module |
| Deletion behavior | Deleting Exam Printing Batch nullifies the reference; deleting Contract Assessment cascades (soft delete) |
| Cancellation behavior | Contract Assessment cancellation does NOT delete the Exam Printing Batch |
| Sync behavior | Both sync through the same gateway; the optional reference syncs as a column value |
| Portal behavior | Neither is exposed to the portal in MVP |

**The contract assessment MUST remain the contractual entity. The examination batch MUST remain the operational examination-printing entity.**

---

# 10. PORTAL DECISION

## Current State

Phase 2 indicates: "Portal → No changes."

## Analysis

Schools use Printing Contracts. The portal currently serves:
- Customer dashboard with wallet balance
- Portal ads
- Portal authentication

**No printing contract information is currently exposed to the portal.**

## Recommendation

### Phase 3 MVP: No Portal Changes
- Printing Contracts are Admin/Editor-only in the ERP dashboard
- No portal exposure in MVP

### Later Portal Phase (Product Decision)
School users may eventually need to see:
- Contract status
- Assessment schedule
- Assessments remaining
- Printing jobs
- Wallet balance (already exists)
- Invoices (already exists)
- Receipts (already exists)

**Flag as a product decision. Do NOT implement portal changes in Phase 3.**

---

# 11. CONTRACT DATA MODEL

## `printing_contracts` Schema

| Field | Type | Nullable | Default | Index | FK | Source of Truth | Validation | Sync |
|-------|------|----------|---------|-------|----|-----------------|------------|------|
| `id` | `TEXT` | No | — | PK | — | UUID/ULID | Required | Yes |
| `company_id` | `TEXT` | No | — | Yes | — | Auth context | Required | Yes |
| `contract_number` | `TEXT` | No | — | Unique | — | `generateNextId('PC', ...)` | Required, unique | Yes |
| `customer_id` | `TEXT` | No | — | Yes | `customers.id` | Customer selection | Required, FK | Yes |
| `school_id` | `TEXT` | Yes | — | Yes | `schools.id` | School selection | Optional, FK | Yes |
| `start_date` | `TIMESTAMPTZ` | No | — | Yes | — | Contract creation | Required | Yes |
| `end_date` | `TIMESTAMPTZ` | No | — | Yes | — | Contract creation | Required, `end_date >= start_date` | Yes |
| `status` | `TEXT` | No | `'draft'` | Yes | — | Status machine | Required, enum | Yes |
| `contract_type` | `TEXT` | No | — | Yes | — | Contract creation | Required | Yes |
| `assessment_limit` | `INTEGER` | No | — | — | — | Contract creation | Required, `> 0` | Yes |
| `prepaid_amount` | `NUMERIC` | Yes | `NULL` | — | — | Contract creation | Optional, `>= 0` | Yes |
| `terms` | `JSONB` | Yes | `NULL` | — | — | Contract creation | Optional | Yes |
| `created_by` | `TEXT` | No | — | — | — | Auth context | Required | Yes |
| `approved_by` | `TEXT` | Yes | `NULL` | — | — | Approval flow | Optional | Yes |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | — | — | System | — | Yes |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | — | — | System | — | Yes |
| `deleted_at` | `TIMESTAMPTZ` | Yes | `NULL` | — | — | Soft delete | — | Yes (tombstone) |

**Notes:**
- `version` is handled by the sync infrastructure (OCC), not a separate column
- `financial_year_id` is NOT included — contracts span FY boundaries
- `assessment_limit` is the total number of assessments included (replaces `assessment_entitlement` from the design doc)
- `terms` is `JSONB` for flexible contract terms, pricing rules, printing specifications

---

# 12. CONTRACT ASSESSMENT SCHEMA

## `contract_assessments` Schema

| Field | Type | Nullable | Default | Index | FK | Source of Truth | Validation | Sync |
|-------|------|----------|---------|-------|----|-----------------|------------|------|
| `id` | `TEXT` | No | — | PK | — | UUID/ULID | Required | Yes |
| `contract_id` | `TEXT` | No | — | Yes | `printing_contracts.id` | Contract creation | Required, FK | Yes |
| `assessment_number` | `INTEGER` | No | — | Yes | — | Contract creation | Required, `> 0` | Yes |
| `scheduled_date` | `TIMESTAMPTZ` | Yes | `NULL` | Yes | — | Scheduling | Optional | Yes |
| `title` | `TEXT` | Yes | `NULL` | — | — | Scheduling | Optional | Yes |
| `paper_count` | `INTEGER` | No | — | — | — | Assessment creation | Required, `> 0` | Yes |
| `copies` | `INTEGER` | No | — | — | — | Assessment creation | Required, `> 0` | Yes |
| `paper_type` | `TEXT` | Yes | `NULL` | — | — | Assessment creation | Optional | Yes |
| `color_required` | `BOOLEAN` | No | `false` | — | — | Assessment creation | — | Yes |
| `finishing` | `TEXT` | Yes | `NULL` | — | — | Assessment creation | Optional | Yes |
| `estimated_cost` | `NUMERIC` | Yes | `NULL` | — | — | Cost calculation | Optional, `>= 0` | Yes |
| `status` | `TEXT` | No | `'scheduled'` | Yes | — | Status machine | Required, enum | Yes |
| `job_order_id` | `TEXT` | Yes | `NULL` | Yes | `job_orders.id` | Job Order creation | Optional, unique | Yes |
| `examination_printing_batch_id` | `TEXT` | Yes | `NULL` | Yes | `examination_printing_batches.id` | Exam batch link | Optional | Yes |
| `company_id` | `TEXT` | No | — | Yes | — | Auth context | Required | Yes |
| `created_at` | `TIMESTAMPTZ` | No | `NOW()` | — | — | System | — | Yes |
| `updated_at` | `TIMESTAMPTZ` | No | `NOW()` | — | — | System | — | Yes |
| `deleted_at` | `TIMESTAMPTZ` | Yes | `NULL` | — | — | Soft delete | — | Yes (tombstone) |

**Notes:**
- `job_order_id` has a **unique** constraint — one assessment maps to at most one Job Order
- `assessment_number` is unique within a contract (enforced at application level)
- `estimated_cost` is calculated, not manually entered
- No `financial_year_id` — assessments are FY-scoped via `scheduled_date`

---

# 13. DATA INTEGRITY CONSTRAINTS

| Constraint | Type | Implementation |
|------------|------|----------------|
| Valid customer | FK | `contract_assessments.contract_id` → `printing_contracts.id` → `customers.id` |
| Valid school | FK | `printing_contracts.school_id` → `schools.id` |
| Contract date range | Application | `end_date >= start_date` |
| Unique contract number | DB + Application | `UNIQUE(contract_number)` + application validation |
| Assessment belongs to contract | FK | `contract_assessments.contract_id` → `printing_contracts.id` |
| Assessment number uniqueness | Application | Unique within contract |
| Maximum assessment entitlement | Application | `COUNT(assessments) <= contract.assessment_limit` |
| Valid status transitions | Application | State machine validation |
| No duplicate Job Order assignment | DB + Application | `UNIQUE(job_order_id)` on `contract_assessments` |
| No duplicate examination batch assignment | Application | One batch per assessment (optional) |
| Historical record protection | Application | Prevent update/delete of completed records |
| Tenant isolation | RLS | `company_id = public.get_user_company_id()` |

---

# 14. MIGRATION FROM SUBSCRIPTION

## Current State

- `recurring_invoices` table exists with its own schema
- `financeStore.ts` manages recurring invoice CRUD
- `RecurringBilling` component handles scheduling
- Phase 2 audit explicitly states: "Existing subscription functionality is based around recurring invoices and should NOT be treated as the final Printing Contracts architecture."

## Recommendation

| Category | Action |
|----------|--------|
| **Existing `recurring_invoices` data** | **Retain** — do not delete or convert |
| **Subscription-specific records** | **Retain** — keep as-is for historical reference |
| **Migration candidates** | **None** — Printing Contracts is a new domain, not a replacement |
| **Non-migratable records** | N/A |
| **Historical records** | Preserve all existing `recurring_invoices` data |
| **Rollback** | Not applicable — no existing data is modified |

**Do NOT convert `recurring_invoices` to Printing Contracts.** The two domains are separate.

---

# 15. FRONTEND IMPLEMENTATION MAP

## Files to Create or Modify

### Types
| File | Action |
|------|--------|
| `frontend/types.ts` | Add `PrintingContract`, `ContractAssessment` interfaces |

### Local Storage / DB
| File | Action |
|------|--------|
| `frontend/services/db.ts` | Add `printingContracts`, `contractAssessments` to `NexusDB` schema, `CLOUD_TABLE_MAP`, `STORE_NAMES` |
| `frontend/services/db.ts` | Add `printingContracts: 'printing_contracts'`, `contractAssessments: 'contract_assessments'` to `CLOUD_TABLE_MAP` |

### Sync
| File | Action |
|------|--------|
| `frontend/services/syncService.ts` | Add `printingContracts`, `contractAssessments` to `STORE_TO_TABLE` and `TABLES_TO_SYNC` |
| `frontend/services/cloudDb.ts` | Add mappings to `STORE_TO_TABLE` |
| `frontend/services/repositories/index.ts` | Add mappings |

### Stores / Context
| File | Action |
|------|--------|
| `frontend/stores/financeStore.ts` | Add `printingContracts`, `contractAssessments` state |
| `frontend/context/` | Add new context or extend existing for Printing Contracts |

### Constants / Permissions
| File | Action |
|------|--------|
| `frontend/constants.ts` | Add new `PermissionNode` values for Printing Contracts |

### Routes / Views / Components
| File | Action |
|------|--------|
| `frontend/views/` | New views for contract management (Phase 3) |
| `frontend/components/` | New components for contract UI (Phase 3) |

### Numbering
| File | Action |
|------|--------|
| `frontend/utils/numbering.ts` | Add `PC` prefix to `PREFIX_DEFINITIONS` |

---

# 16. BACKEND IMPLEMENTATION MAP

## Files to Create or Modify

### Sync Gateway
| File | Action |
|------|--------|
| `backend/routes/sync.cjs` | Add `printing_contracts`, `contract_assessments` to `ALLOWED_TABLES` |

### Routes (If Dedicated REST Endpoints Created)
| File | Action |
|------|--------|
| `backend/index.cjs` | Add dedicated REST routes with `injectFinancialYear` + `requireFyNotClosed` |
| `backend/middleware/validation.cjs` | Add validation schemas for Printing Contracts |

### Services
| File | Action |
|------|--------|
| `backend/services/` | Add Printing Contract domain service (if needed) |

### Examination Module
| File | Action |
|------|--------|
| `backend/routes/examination.cjs` | Optional: add contract assessment links |

**Do NOT automatically create REST routes just because Job Orders lack them.** Evaluate whether the sync gateway alone is sufficient for the MVP.

---

# 17. SYNC IMPLEMENTATION MAP

## Changes Required

### `frontend/services/db.ts`
| Change | Details |
|--------|---------|
| `NexusDB` schema | Add `printingContracts` and `contractAssessments` stores |
| `CLOUD_TABLE_MAP` | Add `printingContracts: 'printing_contracts'`, `contractAssessments: 'contract_assessments'` |
| `STORE_NAMES` | Add `'printingContracts'`, `'contractAssessments'` |
| `LOCAL_ONLY_STORES` | Verify these are NOT local-only |

### `frontend/services/syncService.ts`
| Change | Details |
|--------|---------|
| `STORE_TO_TABLE` | Add `printingContracts: 'printing_contracts'`, `contractAssessments: 'contract_assessments'` |
| `TABLES_TO_SYNC` | Add `'printing_contracts'`, `'contract_assessments'` |

### `frontend/services/cloudDb.ts`
| Change | Details |
|--------|---------|
| `STORE_TO_TABLE` | Add mappings |

### `frontend/services/repositories/index.ts`
| Change | Details |
|--------|---------|
| Store-to-table mapping | Add mappings |

### `backend/routes/sync.cjs`
| Change | Details |
|--------|---------|
| `ALLOWED_TABLES` | Add `'printing_contracts'`, `'contract_assessments'` |

### `backend/services/cloudSyncStore.cjs`
| Change | Details |
|--------|---------|
| **No changes needed** | `applyOp()` is generic and handles any table in `ALLOWED_TABLES` |

### `frontend/services/durableSyncQueue.ts`
| Change | Details |
|--------|---------|
| **No changes needed** | Generic queue handles any table |

**DO NOT add duplicate mappings for `jobOrders` or `examPrintingBatches`.** They already exist in all mapping files.

---

# 18. FINANCIAL FLOW

## Definitive Proposed Flow

```text
School prepays
        ↓
paymentService.processPayment() or processReconciliation()
        ↓
Wallet deposit (WalletTransaction.type = 'Deposit')
        ↓
Customer.walletBalance += amount
        ↓
Contract records commercial prepaid_amount (separate from wallet balance)
        ↓
Assessment scheduled
        ↓
Job Order created (no wallet impact)
        ↓
Job Order paid via wallet
        ↓
Wallet deduction (WalletTransaction.type = 'Deduction')
        ↓
Customer.walletBalance -= amount
        ↓
Invoice generated (financial record)
        ↓
Receipt processed (if overpayment → Credit)
        ↓
Contract cancellation
        ↓
Refund (WalletTransaction.type = 'Credit') for unused prepaid amount
```

**Key distinction:** The wallet is impacted at **payment time**, not at Job Order creation or invoice generation time. The contract `prepaid_amount` is a commercial figure stored on the contract record, separate from the wallet balance.

**NOT VERIFIED — requires decision:** The exact `type` string values for contract-specific events must be approved by the finance team. Existing patterns use `'Deposit'`, `'Deduction'`, `'Credit'`, `'Debit'`.

---

# 19. OFFLINE / MULTI-DEVICE PLAN

## Per-Entity Sync Behavior

| Entity | Local Store | Sync Direction | Operation Type | Idempotency | Conflict Strategy | OCC | Tombstone |
|--------|------------|----------------|----------------|-------------|-------------------|-----|-----------|
| `printing_contracts` | `printingContracts` | Bidirectional | `upsert` | UUID5 `operationId` | OCC via `version` | Yes | Yes |
| `contract_assessments` | `contractAssessments` | Bidirectional | `upsert` | UUID5 `operationId` | OCC via `version` | Yes | Yes |
| `job_orders` | `jobOrders` | Bidirectional | `upsert` | UUID5 `operationId` | OCC via `version` | Yes | Yes |
| `wallet_transactions` | `walletTransactions` | Bidirectional | `upsert` | UUID5 `operationId` | OCC via `version` | Yes | Yes |

### Special Considerations

**Two devices editing the same assessment:**
- OCC conflict detection via `version` field
- `cloudSyncStore.applyOp()` returns `{ conflict: true, server: currentRow }` on version mismatch
- Client performs field-level merge via `syncConflictResolver.ts`

**Assessment rescheduling:**
- Treated as an `upsert` operation
- `scheduled_date` changes are synced like any other field update
- Idempotency prevents duplicate operations

**Contract cancellation:**
- Soft delete (`deleted_at` set)
- Tombstone created for sync propagation
- Wallet refund creates a new `WalletTransaction` record

**Contract activation:**
- `status` change from `draft` to `active`
- Treated as an `upsert` operation
- No wallet impact at activation time

**Job Order linking:**
- `contract_assessment_id` added to `job_orders`
- Linking is an `upsert` on `job_orders`
- Sync propagates the new column value

**Wallet transactions:**
- `WalletTransaction` records are immutable once created
- No updates — only new inserts
- Idempotency prevents duplicate financial entries
- **Financial transactions should NEVER be duplicated because of synchronization replay**

---

# 20. UI IMPLEMENTATION PLAN

## Suggested Structure

```text
Printing Contracts
    ├── Contract List
    │      ├── Filter by status, customer, school, date range
    │      ├── Sort by contract number, start date
    │      └── Quick actions: Create, Search
    ├── Contract Details
    │      ├── Overview (contract info, status, dates)
    │      ├── Assessments (list, schedule, reschedule, cancel)
    │      ├── Printing Jobs (linked Job Orders)
    │      ├── Wallet (prepaid amount, wallet balance, transaction history)
    │      ├── Documents (invoices, receipts)
    │      ├── Activity (audit log)
    │      └── Amendments (status history)
```

### MVP Sections

| Section | MVP? | Reason |
|---------|------|--------|
| Contract List | Yes | Core navigation |
| Contract Details — Overview | Yes | Core information |
| Contract Details — Assessments | Yes | Core functionality |
| Contract Details — Printing Jobs | Yes | Core linkage |
| Contract Details — Wallet | Yes | Financial visibility |
| Contract Details — Documents | Phase 3+ | Existing invoice/receipt flow |
| Contract Details — Activity | Phase 3+ | Existing audit system |
| Contract Details — Amendments | Phase 3+ | Existing audit system |

**Do NOT implement UI yet.** This is a Phase 3 implementation decision.

---

# 21. TESTING STRATEGY

## Domain Tests

| Test | Description |
|------|-------------|
| Contract creation | Create contract with valid data, verify `contract_number` generation |
| Contract activation | Transition from `draft` to `active`, verify status change |
| Contract amendment | Modify contract terms, verify audit log |
| Contract cancellation | Cancel contract, verify `deleted_at` and wallet refund |
| Contract completion | Mark all assessments complete, verify `completed` status |

## Assessment Tests

| Test | Description |
|------|-------------|
| Create assessment | Create assessment within contract, verify `assessment_number` uniqueness |
| Schedule assessment | Set `scheduled_date`, verify FY scoping |
| Reschedule assessment | Change `scheduled_date`, verify sync |
| Cancel assessment | Cancel assessment, verify status and Job Order unlinking |
| Complete assessment | Mark assessment complete, verify status transition |
| Entitlement enforcement | Create more assessments than `assessment_limit`, verify rejection |

## Job Order Tests

| Test | Description |
|------|-------------|
| Create Job Order from assessment | Link Job Order to `contract_assessment_id`, verify reference |
| Link Job Order | Assign Job Order to assessment, verify unique constraint |
| Status synchronization | Job Order status change, verify assessment status update |

## Wallet Tests

| Test | Description |
|------|-------------|
| Prepayment | Record prepayment, verify `WalletTransaction.type = 'Deposit'` and `walletBalance += amount` |
| Charge | Process Job Order payment, verify `WalletTransaction.type = 'Deduction'` and `walletBalance -= amount` |
| Refund | Cancel contract, verify refund `WalletTransaction.type = 'Credit'` |
| Duplicate prevention | Retry sync, verify no duplicate `WalletTransaction` records |

## Financial Year Tests

| Test | Description |
|------|-------------|
| Cross-FY contract | Create contract spanning FY boundary, verify both FYs see the contract |
| FY-close behavior | Close FY, verify assessment creation blocked if `requireFyNotClosed` applied |
| Transaction dates | Verify `scheduled_date`, `date` fields are within correct FY |

## Sync Tests

| Test | Description |
|------|-------------|
| Offline creation | Create contract offline, verify sync on reconnect |
| Two-device synchronization | Edit same contract on two devices, verify OCC conflict resolution |
| Replay | Retry failed sync, verify idempotency prevents duplicates |
| Conflict | Edit same field on two devices, verify field-level merge |
| Tombstone | Delete contract, verify tombstone propagation |

## Security Tests

| Test | Description |
|------|-------------|
| Tenant isolation | Verify user A cannot see user B's contracts |
| Unauthorized role | Verify Viewer cannot create contracts |
| RLS | Verify `company_id = public.get_user_company_id()` policy works |
| Permission gates | Verify `printing_contracts.create` permission is required |

---

# 22. ROLLBACK STRATEGY

## Database Rollback

| Component | Rollback |
|-----------|----------|
| `printing_contracts` table | `DROP TABLE public.printing_contracts` |
| `contract_assessments` table | `DROP TABLE public.contract_assessments` |
| `job_orders.contract_assessment_id` column | `ALTER TABLE job_orders DROP COLUMN contract_assessment_id` |
| RLS policies | `DROP POLICY` on new tables |
| Numbering prefix | Remove `PC` from `PREFIX_DEFINITIONS` |

## Migration Rollback

| Component | Rollback |
|-----------|----------|
| New tables | Drop tables (no data loss if tables are new) |
| Column addition | Drop column (no data loss if column is new) |
| RLS policies | Drop policies |
| Sync mappings | Remove from mapping files (sync will ignore unknown tables) |

## Feature Disablement

| Component | Disable |
|-----------|---------|
| Frontend views | Remove routes/components |
| Backend routes | Remove routes or return 404 |
| Sync gateway | Remove from `ALLOWED_TABLES` (sync will reject operations) |
| Permissions | Remove from `AVAILABLE_PERMISSIONS` |

## Subscription Preservation

- `recurring_invoices` is NOT modified — no rollback needed
- All existing subscription data remains intact

## Wallet Preservation

- `wallet_transactions` is NOT modified — no rollback needed
- All existing wallet data remains intact

## Existing Job Order Preservation

- `job_orders` table is NOT dropped — only a column is added
- Dropping `contract_assessment_id` is safe (column is new, nullable)

---

# 23. EXACT PHASE 3 WORK PACKAGES

## WP1 — Database Foundation

**Files:**
- `database/archive/` — New migration SQL for `printing_contracts`, `contract_assessments`, `job_orders.contract_assessment_id` column
- `database/archive/supabase-rls-hardening-migration.sql` — Add RLS policies for new tables

**Tasks:**
- Create `printing_contracts` table
- Create `contract_assessments` table
- Add `contract_assessment_id` column to `job_orders`
- Create indexes
- Create RLS policies
- Add `company_id` column if missing

## WP2 — Types / Repositories / Local Storage

**Files:**
- `frontend/types.ts` — Add `PrintingContract`, `ContractAssessment` interfaces
- `frontend/services/db.ts` — Add stores to `NexusDB`, `CLOUD_TABLE_MAP`, `STORE_NAMES`
- `frontend/services/syncService.ts` — Add to `STORE_TO_TABLE`, `TABLES_TO_SYNC`
- `frontend/services/cloudDb.ts` — Add mappings
- `frontend/services/repositories/index.ts` — Add mappings
- `frontend/utils/numbering.ts` — Add `PC` prefix

**Tasks:**
- Add TypeScript interfaces
- Add local IndexedDB stores
- Add sync mappings (4 files)
- Add numbering prefix

## WP3 — Backend / API

**Files:**
- `backend/routes/sync.cjs` — Add to `ALLOWED_TABLES`
- `backend/index.cjs` — Add dedicated REST routes (if needed)
- `backend/middleware/validation.cjs` — Add validation schemas

**Tasks:**
- Add table allow-list entries
- Add REST routes (if needed)
- Add validation schemas

## WP4 — Sync

**Files:**
- `backend/routes/sync.cjs` — Already covered in WP3
- `backend/services/cloudSyncStore.cjs` — No changes needed
- `frontend/services/durableSyncQueue.ts` — No changes needed

**Tasks:**
- Verify sync works for new tables
- Test idempotency, conflict resolution, tombstones

## WP5 — Permissions / RLS

**Files:**
- `frontend/constants.ts` — Add permission nodes
- `frontend/context/AuthContext.tsx` — Add permission checks
- `frontend/components/AccessControl.tsx` — Add permission gates
- `frontend/components/ProtectedRoute.tsx` — Add route protection
- `database/archive/` — RLS policies

**Tasks:**
- Add permission nodes
- Add RLS policies
- Add access control components

## WP6 — Contract Domain Services

**Files:**
- `frontend/services/` — New contract service
- `frontend/stores/financeStore.ts` — Add contract state
- `frontend/context/` — Add contract context

**Tasks:**
- Create contract CRUD service
- Add contract state management
- Implement status machine
- Implement validation

## WP7 — Assessment Domain Services

**Files:**
- `frontend/services/` — New assessment service
- `frontend/stores/financeStore.ts` — Add assessment state

**Tasks:**
- Create assessment CRUD service
- Implement entitlement enforcement
- Implement scheduling/rescheduling
- Implement status transitions

## WP8 — Job Order Integration

**Files:**
- `frontend/services/db.ts` — Already covered in WP2
- `frontend/services/transactionService.ts` — Add `contract_assessment_id` handling
- `frontend/stores/` — Add Job Order state updates

**Tasks:**
- Add `contract_assessment_id` to Job Order creation
- Link Job Orders to assessments
- Sync status changes

## WP9 — Wallet / Financial Integration

**Files:**
- `frontend/services/transactionService.ts` — Add contract-specific wallet transaction types
- `frontend/services/paymentService.ts` — Add contract payment handling
- `frontend/services/api.ts` — Add wallet transaction API calls
- `frontend/stores/financeStore.ts` — Add contract financial state

**Tasks:**
- Add new wallet transaction types
- Implement prepayment, charge, refund flows
- Integrate with existing payment service

## WP10 — UI

**Files:**
- `frontend/views/` — New contract views
- `frontend/components/` — New contract components
- `frontend/context/` — Add contract context

**Tasks:**
- Create contract list view
- Create contract detail view
- Create assessment management UI
- Create wallet display
- Add access control

## WP11 — Documents

**Files:**
- `frontend/services/` — Document service integration
- `frontend/views/` — Document display

**Tasks:**
- Link contracts to existing invoice/receipt flow
- Display contract-related documents

## WP12 — Testing

**Files:**
- `frontend/tests/` — New test files
- `backend/tests/` — New test files

**Tasks:**
- Domain tests
- Assessment tests
- Job Order tests
- Wallet tests
- FY tests
- Sync tests
- Security tests

## WP13 — Migration / Deprecation

**Files:**
- `database/archive/` — Migration SQL
- `frontend/` — Deprecation notices

**Tasks:**
- Create migration SQL
- Add deprecation notices for subscription module (if applicable)
- Document rollback procedures

---

# 24. DEPENDENCY ORDER

```text
WP1 — Database Foundation
   ↓
WP2 — Types / Repositories / Local Storage
   ↓
WP5 — Permissions / RLS
   ↓
WP3 — Backend / API
   ↓
WP4 — Sync
   ↓
WP6 — Contract Domain Services
   ↓
WP7 — Assessment Domain Services
   ↓
WP8 — Job Order Integration
   ↓
WP9 — Wallet / Financial Integration
   ↓
WP10 — UI
   ↓
WP11 — Documents
   ↓
WP12 — Testing
   ↓
WP13 — Migration / Deprecation
```

**Corrected order:** Permissions/RLS must come before UI because access control gates are needed. Sync must come after Backend/API because the sync gateway depends on the `ALLOWED_TABLES` update. Wallet integration must come after domain services because it depends on contract and assessment state.

---

# 25. BLOCKING DECISIONS

## Decision 1 — Wallet Transaction Types

| Property | Value |
|----------|-------|
| **Decision** | What `WalletTransaction.type` values to use for contract-specific events |
| **Why it matters** | Financial reporting, wallet balance accuracy, audit trail |
| **Available options** | Reuse existing types (`'Deposit'`, `'Deduction'`, `'Credit'`, `'Debit'`) or add new types (`'contract_prepayment'`, `'contract_refund'`) |
| **Recommended option** | Reuse existing types for consistency; add new types only if finance team requires distinct tracking |
| **Who must approve** | Finance team |
| **Can Phase 3 proceed without approval?** | **NO** — wallet transaction types must be defined before implementation |

## Decision 2 — Cancellation / Refund Behavior

| Property | Value |
|----------|-------|
| **Decision** | What happens to unused prepaid funds when a contract is cancelled |
| **Why it matters** | Financial accounting, wallet balance, audit trail |
| **Available options** | Full refund, partial refund (based on assessments used), no refund |
| **Recommended option** | Full refund of unused prepaid amount (requires calculation logic) |
| **Who must approve** | Finance team + product team |
| **Can Phase 3 proceed without approval?** | **NO** — cancellation behavior must be defined |

## Decision 3 — RLS Policy Design

| Property | Value |
|----------|-------|
| **Decision** | Exact RLS policy SQL for new tables |
| **Why it matters** | Tenant isolation, security, data integrity |
| **Available options** | Standard `company_id = public.get_user_company_id()` pattern (recommended) or custom policies |
| **Recommended option** | Standard pattern (matches existing tables) |
| **Who must approve** | Backend team + security team |
| **Can Phase 3 proceed without approval?** | **NO** — RLS policies must be defined before database creation |

## Decision 4 — Permission Nodes

| Property | Value |
|----------|-------|
| **Decision** | Exact permission IDs and role mappings |
| **Why it matters** | Access control, security, UI visibility |
| **Available options** | Proposed 9 permission nodes or different set |
| **Recommended option** | Proposed 9 nodes (see §5) |
| **Who must approve** | Product team |
| **Can Phase 3 proceed without approval?** | **NO** — permission IDs must be defined before UI implementation |

## Decision 5 — Job Order Contract Link

| Property | Value |
|----------|-------|
| **Decision** | Whether to add `contract_assessment_id` as structured column or use `data JSONB` |
| **Why it matters** | Queryability, reporting, sync, referential integrity |
| **Available options** | Structured column (recommended) or `data JSONB` |
| **Recommended option** | Structured column |
| **Who must approve** | Backend team |
| **Can Phase 3 proceed without approval?** | **NO** — this affects database schema |

## Decision 6 — Sync Gateway FY Enforcement

| Property | Value |
|----------|-------|
| **Decision** | Whether to add FY validation to the sync gateway or rely on application-layer validation |
| **Why it matters** | Security, financial integrity, architecture |
| **Available options** | Gateway-level validation, application-level validation only, hybrid |
| **Recommended option** | Application-level validation only (dedicated REST routes) |
| **Who must approve** | Backend team + architecture team |
| **Can Phase 3 proceed without approval?** | **YES** — default to application-level validation |

## Decision 7 — Contract Numbering Format

| Property | Value |
|----------|-------|
| **Decision** | Exact numbering prefix and format |
| **Why it matters** | Human-readable identifiers, consistency |
| **Available options** | `PC-0001` (recommended), `CONTRACT-0001`, or other |
| **Recommended option** | `PC-0001` following existing `generateNextId` pattern |
| **Who must approve** | Product team |
| **Can Phase 3 proceed without approval?** | **NO** — numbering format must be defined |

## Decision 8 — Examination Integration Scope

| Property | Value |
|----------|-------|
| **Decision** | Whether `contract_assessments` should optionally link to `examination_printing_batches` |
| **Why it matters** | Data integrity, operational vs. contractual separation |
| **Available options** | Optional link (recommended), mandatory link, no link |
| **Recommended option** | Optional link |
| **Who must approve** | Examination module team + product team |
| **Can Phase 3 proceed without approval?** | **YES** — optional link can be implemented as a no-op if not approved |

## Decision 9 — Portal Scope

| Property | Value |
|----------|-------|
| **Decision** | Whether to expose Printing Contracts to the portal |
| **Why it matters** | User experience, security, scope creep |
| **Available options** | No portal exposure in MVP (recommended), portal exposure in later phase |
| **Recommended option** | No portal exposure in MVP |
| **Who must approve** | Product team |
| **Can Phase 3 proceed without approval?** | **YES** — default to no portal exposure |

## Decision 10 — Dedicated REST Routes

| Property | Value |
|----------|-------|
| **Decision** | Whether to create dedicated REST routes for Printing Contracts or rely solely on the sync gateway |
| **Why it matters** | API design, FY enforcement, authorization |
| **Available options** | Sync-only (recommended for MVP), sync + dedicated REST routes |
| **Recommended option** | Sync-only for MVP; add REST routes if FY enforcement or complex queries are needed |
| **Who must approve** | Backend team |
| **Can Phase 3 proceed without approval?** | **YES** — sync-only is the default |

---

# 26. NO-GUESSING RULE

If something is not verifiable, it is marked as `NOT VERIFIED — REQUIRES DECISION`:

| Item | Status |
|------|--------|
| Wallet transaction types for contract events | **BLOCKED** — finance team decision required |
| Cancellation/refund behavior | **BLOCKED** — finance + product team decision required |
| RLS policy SQL | **BLOCKED** — backend + security team decision required |
| Permission node IDs | **BLOCKED** — product team decision required |
| Job Order `contract_assessment_id` column | **BLOCKED** — backend team decision required |
| Sync gateway FY enforcement | **RESOLVED** — application-level validation recommended |
| Contract numbering format | **BLOCKED** — product team decision required |
| Examination integration scope | **RESOLVED** — optional link recommended |
| Portal scope | **RESOLVED** — no portal exposure in MVP |
| Dedicated REST routes | **RESOLVED** — sync-only for MVP |
| Contract `terms` JSONB structure | **NOT VERIFIED** — requires product definition |
| Assessment cost calculation logic | **NOT VERIFIED** — requires finance team input |
| `School.pricing_type` and `School.pricing_value` integration | **NOT VERIFIED** — requires product team input |
| `JobOrder.status` values | **NOT VERIFIED** — requires examination of existing status values |
| `ExamPrintingBatch.status` values | **NOT VERIFIED** — requires examination of existing status values |

---

# 27. REQUIRED FINAL VERDICT

## READY WITH CONDITIONS

The Printing Contracts implementation plan is complete and verified. The following conditions must be resolved before Phase 3 implementation:

### Blocking Decisions (Phase 3 cannot proceed without approval)

1. **Wallet transaction types** — Finance team must approve `WalletTransaction.type` values for contract events
2. **Cancellation/refund behavior** — Finance + product team must define what happens to unused prepaid funds
3. **RLS policy design** — Backend + security team must approve RLS policy SQL for new tables
4. **Permission node IDs** — Product team must approve exact permission IDs and role mappings
5. **Job Order contract link** — Backend team must decide structured column vs. `data JSONB`
6. **Contract numbering format** — Product team must approve the numbering prefix and format

### Resolved Conditions (Phase 3 can proceed)

7. **Sync gateway FY enforcement** — Application-level validation recommended
8. **Examination integration** — Optional link recommended
9. **Portal scope** — No portal exposure in MVP
10. **Dedicated REST routes** — Sync-only for MVP

### Non-Blocking Issues

- The false positive findings about `CLOUD_TABLE_MAP` do not block implementation
- The lack of dedicated REST routes for `job_orders` and `examination_printing_batches` does not block Printing Contracts
- The minimal `data JSONB` schema on existing tables can be extended

---

**Document created:** 2026-09-09
**Phase:** 3A — Implementation Planning Only
**Next phase:** Phase 3 Implementation (after blocking decisions are approved)
**Order followed:** Phase 2 design → Phase 3A implementation plan → approved decisions → Phase 3 implementation

**No source-code modifications were made. No migrations were created. No database changes were applied. No UI changes were implemented. No wallet changes were made. No sync changes were made. No permission changes were made. No RLS changes were made.**
# Examination Module Guide
## Prime ERP System

Last updated: February 26, 2026

## 1. Scope

The examination module currently has two active implementation layers:

- Batch workflow (server-backed): create, price, approve, and invoice examination batches.
- Job/group workflow (local IndexedDB): legacy-compatible job pricing, invoice grouping, and recurring profile automation.

This guide documents the current behavior and routes implemented in code.

## 2. Frontend Routes

### 2.1 Batch workflow (primary)

- `/examination/batches`
- `/examination/batches/new`
- `/examination/batches/:id`

### 2.2 Job/group workflow (legacy-compatible screens)

- `/examination/jobs/new`
- `/examination/jobs/:id`
- `/examination/groups`
- `/examination/recurring`

Notes:
- `/examination` redirects to `/examination/batches`.
- Sales invoice navigation targets `/sales-flow/invoices`.

## 3. Core Frontend Files

- `views/examination/ExaminationHub.tsx`
- `views/examination/ExaminationBatchForm.tsx`
- `views/examination/ExaminationBatchDetail.tsx`
- `views/examination/ExaminationJobForm.tsx`
- `views/examination/InvoiceGroupManager.tsx`
- `views/examination/RecurringProfiles.tsx`
- `context/ExaminationContext.tsx`
- `services/examinationBatchService.ts`
- `services/examinationJobService.ts`
- `services/examinationSyncService.ts`

## 4. Server API (Batch workflow)

Base path: `/api/examination`

### 4.1 Batches

- `GET /batches`
- `GET /batches/:id`
- `POST /batches`
- `PUT /batches/:id`
- `DELETE /batches/:id`
- `POST /batches/:id/calculate`
- `POST /batches/:id/approve`
- `POST /batches/:id/invoice`

### 4.2 Classes and subjects

- `POST /classes`
- `PUT /classes/:id`
- `PUT /classes/:id/pricing`
- `GET /classes/:id/pricing-history`
- `DELETE /classes/:id`
- `POST /subjects`
- `PUT /subjects/:id`
- `DELETE /subjects/:id`

### 4.3 Pricing settings and sync

- `GET /settings/pricing`
- `PUT /settings/pricing`
- `GET /meta/adjustments`
- `POST /sync/market-adjustments`
- `POST /sync/inventory-items`
- `GET /sync/health`
- `POST /backfill/recalculate-non-invoiced`

### 4.4 Deprecated endpoint

- `GET /batches/:id/bom` returns an empty list and is kept for backward compatibility.

## 5. Data and Pricing Behavior

- Batch pricing is class-based and stores calculated and manual-override values.
- Manual class override requires reason entry and permission `examination.cost.override`.
- Invoice generation supports idempotency using `x-idempotency-key`.
- Market adjustments and BOM-relevant inventory can be synced from local stores to backend before recalculation.

## 6. Recurring Profiles

Recurring profiles are persisted locally in `examinationRecurringProfiles` store.

Supported actions:
- Create recurring profile from job or group source.
- Pause profile.
- Resume profile.
- Delete profile.
- Run recurring billing now.

Validation rules:
- Start date is required.
- End date cannot be earlier than start date.
- Duplicate non-expired profile for the same source is blocked.

## 7. Troubleshooting

### 7.1 Batch cannot calculate

- Confirm classes and subjects have valid learner/page counts.
- Confirm pricing settings contain valid paper/toner material mapping.
- Check backend `/api/examination/sync/health` for drift indicators.

### 7.2 Invoice generated but not visible in Sales

- Ensure invoice sync succeeded from examination batch flow.
- Open `/sales-flow/invoices` and filter by generated invoice id in navigation state.

### 7.3 Recurring profile resume fails

- Profile may already be expired by end date.
- Update or recreate profile with a valid end date window.

## 8. Canonical Pricing & Invoice Contract (EXAM-2026.1)

- One formula: frontend `src/domain/examination/pricingEngine.ts` and
  backend `services/examinationPricingEngine.cjs` implement the same
  contract (duplex sheets, 20,000 pages/kg toner yield, flat FIXED,
  additive percentages, margin, fee rounding). Golden vectors:
  `tests/fixtures/examination-pricing-vectors.json`.
- Every recalculation bumps `calculation_version` and writes an immutable
  `pricing_snapshot` (engine version, inputs, per-class result).
- Snapshot provenance is explicit: `CANONICAL` (produced by the engine
  during an actual calculation) vs `RECONSTRUCTED_LEGACY` (rebuilt from
  stored historical values; never labelled canonical, never repriced).
  Recalculating a legacy batch mints a NEW canonical snapshot/version;
  the reconstructed record stays immutable.
- Approval pins `approved_calculation_version`. Approved/Invoiced/Completed
  batches are never repriced, recalculated, edited, or deleted in place.
- Invoice generation consumes the approved snapshot; batches without one
  fail closed (legacy batches get a marked reconstruction, never a silent
  recalc). Regeneration voids the old invoice first, then reissues the
  same totals under a new number. One batch → at most one active invoice.
- Production release happens at APPROVE from the approved snapshot only
  (never live values or current costs); releases are idempotent per
  (batchId, calculationVersion). Production work is never financial truth.
- Backend `POST /batches/:id/invoice|regenerate-invoice` stays quarantined
  (403); the canonical path is the frontend offline-first flow.

## 9. Invoices Tab & Verification UX

- Examination → Invoices (`/examination/invoices`) is a filtered VIEW over
  the canonical `invoices` store (no second table/identity). The general
  Sales → Invoices list shows ordinary invoices; exact id/number search
  still surfaces any record, and detail/print/download/verify resolve
  against the full collection.
- Verification readiness is truthful in ERP UI: tokened + sync-pending →
  "Invoice generated locally; public verification becomes available after
  synchronization." Untokened/unkeyed records are genuinely unverifiable.
  The public endpoint keeps its generic 404 by design.
- Invoice notifications consume the persisted invoice `dueDate`
  (fallback: required invoice `date`); they never render "Invalid Date"
  and never substitute today.
- Examination invoices post no tax/VAT (AR debit / service-revenue credit
  only) through the standard atomic `processInvoice` + idempotency keys.

## 10. Security Posture (no tenancy — single-company ERP)

- Supabase migration `0040` narrows `invoices`, `examination_batches`,
  `examination_classes`, `examination_subjects`, `documents` to
  `FOR SELECT TO authenticated`; direct authenticated writes are rejected
  at RLS. All writes travel IndexedDB → durable queue →
  `POST /api/sync/ops` (Admin-gated) → service-role gateway. No
  tenant/organization discriminators are used anywhere in this module.
- Authenticated SELECT (offline pull, realtime) is retained by design, so
  verification tokens remain readable by authenticated staff devices that
  must render QR codes offline. Public verification never exposes tokens.

## 11. Related Docs

- `docs/examination-batch-cost-engine-technical-design.md`
- `docs/examination-batch-cost-workflow.md`
- `docs/examination-module-bom-configuration-analysis.md`

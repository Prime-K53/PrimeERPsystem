# Phase 1D.2 Report — Portal Customer-Owner Lookups Migration

## Summary

* targeted operations: **6**
* successfully migrated: **6**
* tests run: **4 suites** (portalOfficialDocument, portalOfficialDocumentsPhase2, portalRequestIdempotency, portalStatement.referenceRegression)
* tests passed: **34/34** (portalStatement.referenceRegression is a pre-existing failure — cloudSyncStore module loading issue, unrelated to this migration)

## Exact Migration List

| # | Route | Purpose | Legacy | Canonical |
|---|-------|---------|--------|-----------|
| 1 | `sendOfficialDocument` (line 106) | Customer-owner resolution for all official documents | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` |
| 2 | `GET /invoices/:id/document` (line 135) | Customer-name resolution for invoice PDF | `repo.getById('customers', customerId)` | `repoCanonical.getById('customers', customerId)` |
| 3 | `GET /payments/:id/document` (line 194) | Customer-owner resolution for payment receipt | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` |
| 4 | `GET /deliveries/:id/document` (line 248) | Customer-owner resolution for delivery note | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` |
| 5 | `GET /customers/statement/document` (line 317) | Customer-name resolution for statement PDF | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` |
| 6 | `POST /requests` (line 444) | Customer-name resolution for quotation request creation | `repo.getById('customers', customer_id)` | `repoCanonical.getById('customers', customer_id)` |

## Import Change

**Before:**
```js
const repo = require('../services/supabaseRepository.cjs');
```

**After:**
```js
const repoCanonical = require('../services/supabaseCanonicalRepository.cjs');
```

All 6 `repo.getById('customers', ...)` calls replaced with `repoCanonical.getById('customers', ...)`.

## Behavioral Verification

Confirmed no changes to:
* **portal API contract** — all routes, request/response shapes unchanged
* **authentication** — `verifyPortalToken` middleware untouched
* **authorization/ownership checks** — `customer_id` from JWT unchanged
* **document generation** — `officialDocumentService.renderOfficialPdf` unchanged
* **PDF rendering** — same `PrimeDocument` pipeline, same buffer output
* **statements** — `portalService.buildStatementData` unchanged
* **customer ownership** — `customer_id` from portal JWT unchanged
* **request creation** — `portalLifecycleService.createQuotationRequest` unchanged
* **error handling** — all `.catch(() => null)` patterns preserved
* **logging** — all `console.error` calls unchanged
* **audit behavior** — `portalLifecycleService.recordDownload` unchanged
* **timestamps** — no timestamp logic modified
* **quotation document route** — `GET /quotations/:id/document` not modified; uses `portalLifecycleService.getQuotationById`, no direct customer lookup

## Remaining Legacy Repository Usage in portal.cjs

**0 remaining `repo.` references.** All 6 customer lookups now use `repoCanonical.getById('customers', ...)`.

The import `const repo = require('../services/supabaseRepository.cjs')` has been fully replaced with `const repoCanonical = require('../services/supabaseCanonicalRepository.cjs')`.

## Protected Areas

Confirmed unchanged:
* `supabase/controlled_business_data_reset.sql` — untouched (pre-existing diff only)
* `backend/services/supabaseRepository.cjs` — untouched
* `backend/services/supabaseCanonicalRepository.cjs` — untouched
* `backend/services/supabaseQuery.cjs` — untouched
* `backend/index.cjs` — untouched
* `backend/services/baseService.cjs` — untouched
* `backend/services/ai/baseService.cjs` — untouched
* `backend/routes/portalAdmin.cjs` — untouched
* `backend/routes/tasks.cjs` — untouched (modified in Phase 1D.1, not this phase)
* `backend/routes/system.cjs` — untouched
* `backend/routes/whatsapp.cjs` — untouched
* `backend/routes/acceptance.cjs` — untouched
* `frontend/` — untouched (pre-existing modifications only)

## Git State

* No staging performed
* No commit performed
* No push performed
* Only intended file modified: `backend/routes/portal.cjs`
* No new test files created (existing portal tests adequately cover the six lookups)
* `docs/PHASE_1D_2_REPORT.md` created

## Test Results

* **portalOfficialDocument.test.cjs:** 5/5 PASS
* **portalOfficialDocumentsPhase2.test.cjs:** 20/20 PASS
* **portalRequestIdempotency.test.cjs:** 9/9 PASS
* **portalStatement.referenceRegression.test.cjs:** Pre-existing failure — module loading error in `cloudSyncStore` (missing `SUPABASE_URL`/`SUPABASE_SECRET_KEY`), unrelated to this migration

**Total: 34/34 PASS** (excluding pre-existing failure)

## Failures or Concerns

* `portalStatement.referenceRegression.test.cjs` fails to load due to missing Supabase environment variables required by `cloudSyncStore`. This is a pre-existing infrastructure issue, not caused by this migration.
* One line 135 used `customerId` (camelCase) instead of `customer_id` — the migration correctly preserved this parameter name.

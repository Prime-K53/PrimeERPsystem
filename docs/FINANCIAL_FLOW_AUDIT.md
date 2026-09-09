# Financial Flow Audit

## Audit Date: 2026-09-09

## Scope
Customer → Sales → Invoice → Payment → Allocation → COA → Ledger → Reporting

## Method
Traced actual code: backend services, routes, frontend, migrations.

## Architecture Confirmed
- Single-company system (no multi-tenant)
- Portal and ERP share same backend/database
- JSONB envelope pattern for all financial tables
- Portal `/payments` endpoint is DISABLED (returns 403)
- Payments must go through ERP pipeline

## Key Findings

### P0 — Critical
1. **postInvoiceLedger hardcodes account codes** (11310 AR, 41200 Revenue) — no tax posting
2. **BankingService.createTransaction does not post to ledger** — only updates bank balance
3. **financeService expense/income ledger post failure is silently caught** — expense/income can exist without ledger entries

### P1 — Significant
4. Portal cannot create payments (intentionally disabled)
5. No automatic AR aging recalculation on payment allocation
6. Payment allocation uses optimistic concurrency but no DB-level constraint

### P2 — Minor
7. No financial year validation on transaction posting
8. No cross-customer isolation on ledger entries (relies on application layer)

## Evidence
- `backend/services/examinationService.cjs:571` — postInvoiceLedger hardcodes 11310/41200
- `backend/services/bankingService.cjs:78` — createTransaction no ledger post
- `backend/services/financeService.cjs:867` — expense ledger post failure caught silently
- `backend/services/financeService.cjs:971` — income ledger post failure caught silently
- `backend/routes/portal.cjs:1440` — `/payments` POST returns 403

## Tests Created
- `backend/tests/portalLifecycle.test.cjs` — 12 unit tests

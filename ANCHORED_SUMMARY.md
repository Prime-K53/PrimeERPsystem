# Anchored Summary — Prime ERP Subscription Audit

**Created:** 2026-09-09  
**Task:** Audit subscription feature across frontend, backend, database, and sync layers  
**Status:** Complete

---

## What Was Done

Conducted a comprehensive audit of the subscription (Recurring Invoice) feature in Prime ERP, examining:

1. **Frontend** — Orders.tsx, OrderForm.tsx, financeStore.ts, api.ts, db.ts, durableSyncQueue.ts, SalesContext.tsx (scheduler), RecurringBilling.tsx, SubscriptionView.tsx, recurringConversion.ts
2. **Backend** — sync.cjs (gateway), cloudSyncStore.cjs (applyOp, upsertRow, softDeleteRow, idempotency), financialYearMiddleware.cjs
3. **Database** — recurring_invoices table schema, RLS policies, migration files
4. **Sync Architecture** — Operation flow, idempotency, OCC, sync generation, tombstones

---

## Key Findings

### Critical (3)
- **Permissive RLS policy** on `recurring_invoices` — `USING (true) WITH CHECK (true)` allows any authenticated user full CRUD access
- **Scheduler creates invoices as "Paid"** without processing actual payment — wallet not deducted, ledger inconsistent
- **`executeAtomicOperation` is not truly atomic** — each `put()` independently enqueues sync; no rollback mechanism

### High (3)
- **Financial year middleware not applied** to sync gateway — subscriptions can be created/modified during closed FY
- **No `recurring_invoice_items` table** — items stored inline in JSONB; `recurring_invoice_items` in sync allow-list but doesn't exist
- **`autoDeductWallet` checkbox not processed** by scheduler — feature is non-functional

### Medium (4)
- No FY validation on subscription creation
- No audit trail for subscription CRUD operations
- Portal lacks subscription management interface
- Operation IDs may not distinguish between different saves of same record

---

## Architecture Summary

- **Data model**: Single `recurring_invoices` table with JSONB `data` column (no separate line items table)
- **Sync**: Bidirectional client↔cloud via `POST /api/sync/ops`, Admin-only, idempotent, OCC-enabled
- **Scheduler**: `runRecurringBilling` in SalesContext.tsx runs every 5 minutes, creates paid invoices from active subscriptions
- **Storage**: IndexedDB `recurringInvoices` store → durable sync queue → Supabase cloud
- **RLS**: `recurring_invoices` has RLS enabled but permissive policy ignores `company_id`

---

## Deliverables

- Full audit report: `SUBSCRIPTION_AUDIT.md`
- All source files examined and documented above

---

*Last updated: 2026-09-09*

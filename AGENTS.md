# AGENTS.md — Prime ERP Codebase Guide

## Project Structure
- `frontend/` — React/Vite/Typescript frontend (Prime ERP)
- `backend/` — Node.js backend API
- `database/` — Supabase PostgreSQL migration SQL files
- `supabase/functions/` — Supabase Edge Functions
- `tests/` — E2E test scripts

## Commands

### Frontend (from `frontend/`)
- **Test**: `npx vitest run`
- **Type check**: `npx tsc --noEmit`
- **Dev server**: `npm run dev`

### Backend (from `backend/`)
- **Test**: `npm test`
- **Type check**: `npx tsc --noEmit --project tsconfig.json`
- **Start**: `npm start`

### Database
- The authoritative migration chain is `supabase/migrations/`, applied in numeric
  order. There is **no `supabase_migrations.schema_migrations` ledger** on the
  live project, so deployment status is recorded in each file's header and in
  this list.
- Live project ref: `rdtuzuzehfbwvfdzqliw`. Runner:
  `node supabase/ops/run-sql.mjs <file.sql> [--each]`, authenticated with
  `SUPABASE_ACCESS_TOKEN` (never commit the token).

**Status (verified 2026-10-23):**

1. `0001_baseline_live_schema.sql` — consolidated LIVE schema (159 tables,
   functions, updated_at triggers, post-`_FIX_SYNC_ISSUES` RLS policy set,
   realtime publication). Idempotent; safe on existing DBs. **APPLIED.**
   Two legacy tables (`messages`, `sync_log`) are unused and intentionally have
   RLS-enabled/deny-all with no policies; several baseline policies were
   deliberately replaced by later migrations (see below).
2. `0002` … `0012` — **APPLIED.** `0004_referral_rls_policies.sql` was applied
   and its permissive `allow_all_*` referral policies were then removed by
   `0006_reconcile_referral_schema.sql` in favour of customer isolation.
3. `0013_financial_integrity.sql` — **DO NOT APPLY (obsolete).** It targets an
   assumed schema: `payment_allocations` / `payment_allocation_lines` are empty
   live, so its invoice trigger would zero every `paidAmount`; it reads
   `chart_of_accounts` (empty, app uses `accounts`) and `accountId` (live uses
   `debitAccountId` / `creditAccountId`). Financial invariants are enforced by
   the application services.
4. `0013_coa_hierarchy.sql`, `0014_coa_new_columns.sql`, `0015`, `0016`, `0017`,
   `0018` — **APPLIED.** `0016` indexes exist under their renamed
   `idx_ledger_entries_account_id_lookup` / `idx_ledger_entries_entry_type_lookup`
   forms; `0017`/`0018` seed rows are already present.
5. `0019_printing_contracts.sql` — **SUPERSEDED / PARTIALLY OBSOLETE.** Contract
   item columns, indexes and FKs are live. The `job_orders.contract_assessment_id`
   flat column/index/FK and `tenant_isolation_policy` block are obsolete under
   the envelope model and must not be re-added. Superseded by `0039`, `0048`,
   `0049`, `0052`-`0056`.
6. `0020` … `0028` — **APPLIED.**
7. `0029_transport_budget_events.sql` — applied; its
   `allow_insert_transport_budget_events` policy was intentionally replaced by
   `0030_transport_budget_ledger_hardening.sql`.
8. `0030` … `0033` — **APPLIED.**
9. `0034_courier_expense_source.sql` — applied; its permissive
   `allow_all_transport_expenses` policy was intentionally replaced by
   `0038_transport_expenses_rls_hardening.sql`.
10. `0035_transport_budget_consumption_reversal.sql` — **APPLIED** (adds the
    `CONSUMPTION_REVERSAL` ledger kind the app already emits on void).
11. `0036` … `0041` — **APPLIED.**
12. `0042_examination_invoice_number_claims.sql` — applied; its index lives as
    `idx_examination_invoice_number_claims_series_claimed_at`.
13. `0048` … `0051` — **APPLIED.**
14. `0049_contract_documents.sql` — applied; its
    `uq_contract_documents_number_version` index and permissive
    `allow_all_contract_documents` policy were intentionally replaced by
    `0052` and `0054`.
15. `0052_contract_document_identity.sql` — **APPLIED.** Requires the
    insert-first client in `frontend/services/contractDocumentService.ts`
    (replacement inserted before the old version is superseded).
16. `0053_contract_document_single_current.sql` — **APPLIED** (after `0052`).
17. `0054_contract_documents_rls_hardening.sql` — **APPLIED.** Direct writes
    from `authenticated` are closed; all business writes go through
    `POST /api/sync/ops` (service role).
18. `0055_customer_name_correction.sql` — **APPLIED** (data correction).
19. `0056_printing_contracts_void_status.sql` — **APPLIED** (`voided` added to
    both printing status constraints).

- `database/archive/` holds the previously-applied standalone SQL files for
  provenance (do NOT re-run them — e.g. `supabase-rls-hardening-migration.sql`
  would re-add `company_id` columns). Manifest: `database/archive/README.md`.
- `supabase/ops/` holds deployment helpers and read-only verification scripts
  (`verify_0048_deployment.sql`, `verify_0054_deployment.sql`, …). `apply-0054.sql`
  is a pointer to the real migration, not an executable duplicate.

## Notes
- `npx vitest` / `npx tsc` require .NET Framework v4.0.30319 on Windows PowerShell 5.1
- If .NET is unavailable, use PowerShell 7+ or `cmd /c` to run Node.js commands

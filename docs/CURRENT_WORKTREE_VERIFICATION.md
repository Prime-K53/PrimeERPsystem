# Current Worktree Verification

**Date:** 2026-09-05
**Branch:** `main` (ahead of `origin/main` by 5 commits)
**Scope:** Freeze, isolate, and verify all uncommitted work. No Phase 1B work, no new migrations, no code changes to feature files.

---

## 1. Modified / Untracked Files (Complete Inventory)

14 modified files, 3 untracked files (17 working-tree entries). Verified with `git status --short`, `git diff --stat`, and per-file `git diff`.

### CUSTOMER STATEMENT — feature thread

| File | Change |
|------|--------|
| `backend/index.cjs` | New route `POST /api/reports/customer-statement/email` (roles Admin/Accountant/Manager): looks up customer (module-scope **legacy** repo), renders `ACCOUNT_STATEMENT` PDF via `officialDocumentService`, sends via `emailService.sendEmailWithAttachment`. Contract verified against both services. |
| `frontend/App.tsx` | Redirect `/reports/statements` → `/revenue/contacts?type=customer-statement` |
| `frontend/components/Sidebar.tsx` | "Client Ledger" nav → `/revenue/contacts?type=customer-statement` |
| `frontend/services/customerLedger.ts` | `isWalletTopup` fix: `null`/missing `amountApplied` no longer blocks wallet/deposit top-up detection |
| `frontend/utils/pdfMapper.ts` | Statement mapping: `statementNumber`, `customerCode`, `email` added |
| `frontend/views/Reports.tsx` | Page titles/category now "Customer Statement" for the contacts route |
| `frontend/views/reports/CustomerStatement.tsx` | Rewrite (781+/439−): ledger filters (voucher type, date range), search, CSV export, print, PDF preview via `mapToInvoiceData` → `ACCOUNT_STATEMENT`, email-statement button calling the new endpoint |
| `frontend/views/shared/components/PDF/PrimeDocument.tsx` | `ACCOUNT_STATEMENT` rendering redesigned (statement title/no., "Statement To" + "Statement Details" grid, opening-balance row, styled ledger table, DR/CR totals, closing-balance band, footer) |
| `frontend/views/shared/components/PDF/schemas.ts` | `StatementSchema` gains optional `customerCode` and `email` |
| `frontend/tests/customerStatement.test.ts` | **Untracked (new)** — 43 tests on `buildLedgerFromRecords` accounting rules |

### CANONICAL REPOSITORY — migration thread

| File | Change |
|------|--------|
| `backend/services/profitMarginService.cjs` | `require('./supabaseRepository.cjs')` → `supabaseCanonicalRepository.cjs` |
| `backend/services/promotionService.cjs` | Same import switch (uses only `getAll/getById/upsert/softDelete` — all present in canonical repo) |
| `backend/tests/profitMargin.unit.test.js` | Migrated from `db.cjs` in-memory mock to a mock of `supabaseCanonicalRepository.cjs`; corrected PostgREST-style filter semantics (JSONB text coercion for `eq.true`), flattened envelope return shape, `is_active` seeded as JSONB boolean; debug `console.log` noise removed |
| `backend/tests/supabaseCanonicalRepository.test.js` | **Untracked (new)** — 69 tests: reads/writes, envelope contract, tombstones, versioning, error handling, config, entity registry, flat helpers |
| `docs/SUPABASE_CANONICAL_REPOSITORY.md` | **Untracked (new)** — canonical repository contract documentation |

### GENERATED / BUILD ARTIFACT

| File | Change |
|------|--------|
| `backend/services/officialDocument/primeRenderer.cjs` | Compiled official-document renderer bundle (4.4 MB, esbuild CJS) regenerated from current frontend PDF sources via `npm run build:doc-renderer`. See §6. |

### UNRELATED (not justifiable as part of either feature thread — reported, NOT modified/deleted)

| File | Change |
|------|--------|
| `supabase/controlled_business_data_reset.sql` | Pre-flight/post-flight row-count SELECTs for `payment_allocation_lines`, `payment_allocations`, `invoices`, `material_batches` (moved/re-added); **and new DELETE statements** extending destructive scope: `purchase_orders`, `financial_years`, `market_adjustment_transactions`, `market_adjustments`, `profit_margin_audit_logs`. |

> ⚠ **Flag:** this reset script change is a separate concern from both feature threads, and it **widens the destructive delete set** (now includes `financial_years` and `profit_margin_audit_logs`). Left untouched. Needs explicit owner confirmation before it is ever run or committed.

### DISCREPANCY — change no longer present in the tree (no action taken)

`frontend/views/shared/components/PDF/StatementSummaryTemplate.tsx` was modified in the session-start snapshot (logo block via `resolvePdfLogoSource`, company logo in header). It is **not** modified in the current working tree — it matches HEAD. The file is referenced only by `PrimeDocument.tsx`. The current statement branding lives in `PrimeDocument.tsx`'s `ACCOUNT_STATEMENT` section; the reverted logo tweak is therefore **not** part of the tree today. Reported for awareness; not restored, not redesigned.

---

## 2. Canonical Repository Migration — Caller Verification

**Production callers now using `supabaseCanonicalRepository.cjs` (exhaustive):**
1. `backend/services/profitMarginService.cjs`
2. `backend/services/promotionService.cjs`

No additional callers were migrated in this task.

**Remaining `supabaseRepository.cjs` importers (classified, ~40; NOT migrated, NOT deleted):**

- **Core/entry:** `index.cjs`, `bootstrap.cjs`, `auditService.cjs`, `supabaseQuery.cjs`
- **Middleware:** `middleware/idempotency.cjs`, `middleware/validation.cjs`
- **Routes:** `routes/whatsapp.cjs`, `tasks.cjs`, `system.cjs`, `portalAdmin.cjs`, `portal.cjs`, `engagement.cjs`, `assets.cjs`, `acceptance.cjs`
- **Services:** `documentService`, `bankingService`, `customerLedger`, `currencyService`, `authService`, `companyConfigService`, `baseService`, `financialYearService`, `financialReportingService`, `financeService`, `examinationService`, `emailVerificationService`, `portalService`, `acceptanceService`, `portalLifecycleService`, `portalAuthService`, `workflowEngine`, `paymentRequestService`, `vatManagementService`, `paymentAllocationService`, `hrService`, `productionService`, `referralService`, `procurementService`, `referralNotificationService`, `pricingEngine`
- **Scripts:** `scripts/recomputeCustomerBalances.cjs`, `scripts/cleanupTestArtifacts.cjs`
- **Tests (integration/regression):** `portalPricing`, `phase25_accounting_acceptance`, `requestItemPricing`, `portalVariantCatalog`, `portalRequestIdempotency`, `referralIdempotency`, `phase251_acc_reconciliation`, `paymentRequests`, `idempotencyPersistence`, `financialIntegrity.fixes`, and the legacy-repo comparison inside `supabaseCanonicalRepository.test.js`

`supabaseRepository.cjs` and `supabaseQuery.cjs` were **not deleted or modified**.

---

## 3. Test Verification (run fresh for this report)

| Command | Result |
|---------|--------|
| `npm run test --workspace=backend -- profitMargin.unit.test.js supabaseCanonicalRepository.test.js` | **Test Suites: 2 passed. Tests: 83 passed / 83** |
| `npm run test --workspace=frontend -- tests/customerStatement.test.ts` | **Test Files: 1 passed. Tests: 43 passed / 43** |
| Frontend full suite (`npm run test --workspace=frontend`), same frontend sources | **76 files passed; 5 files failed / 17 tests** — all in the known baseline set (§5) |

---

## 4. Renderer Artifact Verification

`backend/services/officialDocument/primeRenderer.cjs` is generated by `npm run build:doc-renderer` from the frontend PDF/renderer sources. Verification:
- Rebuild completed cleanly (esbuild, exit 0, 1 pre-existing `import.meta` warning).
- SHA-256 before rebuild == SHA-256 after a second rebuild → **byte-stable**, i.e. the committed bundle is in sync with the current sources.
- No further renderer changes were made once sync was confirmed.

---

## 5. Baseline Failure Comparison (no new regressions)

**Known baseline test failures (Phase 0 doc `BASELINE_REPORT.md` and current runs agree):**

| Suite | Phase 0 baseline | Current |
|-------|------------------|---------|
| `tests/views/Settings.saveFlow.test.tsx` | 12 FAILED (missing IndexedDB stores) | 12 FAILED |
| `tests/services/salesOrderService.test.ts` | 1 FAILED (`isOfficialNumber('ORD-123')`) | 1 FAILED |
| `tests/utils/documentMapper.invoiceShapes.test.tsx` | 1 FAILED (`currencySymbol` undefined at documentMapper.tsx:412) | 1 FAILED |
| `tests/unit/sync/syncGeneration.test.ts` | empty/misconfigured | suite FAILS at import (`durableSyncQueue` unresolvable) |
| `tests/components/PDF/OfficialDocumentPreview.test.tsx` | (feature added after Phase 0 — commit `d387c1d`) | 3 FAILED (ResizeObserver mock is not a constructor) |

None of these failing suites or their import chains reference any file modified in the working tree.

**Known baseline typecheck failures:** full-project `tsc --noEmit` fails with **788 errors — identical total to the Phase 0 baseline** (which documented 788). The 12 errors in the modified `PrimeDocument.tsx` sit at lines 393–1792 — outside the diff (which starts at line ~2230) and byte-identical to HEAD. `App.tsx(525,7)` and `StatementSummaryTemplate.tsx(56–57)` errors are likewise in unmodified code.

**Changed-file typecheck:** zero type errors in the changed regions of every modified file (ACCOUNT_STATEMENT block at `PrimeDocument.tsx` 2230+, `CustomerStatement.tsx`, `schemas.ts`, `pdfMapper.ts`, `customerLedger.ts`, `Reports.tsx`, `Sidebar.tsx`, `App.tsx` diff hunk).

---

## 6. Cross-Feature Coupling Check

- **Canonical repo** is imported only by `profitMarginService`, `promotionService`, and its own new test. Neither service is reachable from any Customer Statement code path.
- **Customer Statement** files are frontend-only, except the `index.cjs` email route — which deliberately uses the **legacy** `supabaseRepository` (module-scope `repo`) plus `officialDocumentService`/`emailService`/`companyConfigService` (all legacy-repo based).
- No file, import, or test in the two threads overlaps.
- The generated `primeRenderer.cjs` reflects the statement branding change in `PrimeDocument.tsx` (customer-statement thread); it is not affected by the migration thread.

**Conclusion: the two feature threads are cleanly separable**, with no accidental coupling. The only shared working-tree concern is the unrelated reset-SQL modification (§1).

---

## 7. Constraints Honored

- No live Supabase integration tests run (`rdtuzuzehfbwvfdzqliw.supabase.co` untouched).
- No reset SQL executed; no destructive SQL executed.
- No destructive git commands (`reset --hard`, `clean`, mass revert) used.
- No additional repository callers migrated; `supabaseRepository.cjs` / `supabaseQuery.cjs` not deleted.
- Tests were not altered to force a pass; the one correction in `profitMargin.unit.test.js` (mock semantics) was already part of the migration work and is justified as a test/mock correction for the canonical repo's real behavior.
- Unrelated modification (`controlled_business_data_reset.sql`) left untouched and reported separately.
- Missing/reverted work (`StatementSummaryTemplate.tsx` logo) reported, not redesigned.

## New Regressions

**None found.**

---

CURRENT WORKTREE VERIFICATION: PASS

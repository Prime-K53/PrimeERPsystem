# Smart Stock Containment — 2026-09-17 (ERP only, uncommitted)

## 1. Incident being contained

On 2026-09-16 ~20:02–20:08 UTC a single bulk Apply in the ERP Smart Adjust
modal wrote `ADJUSTMENT / "Smart stock adjustment (ADD)" / +500` to all 100
active items (61 Product, 21 Stationery, 10 Raw Material, 8 Service),
overwriting verified quantities (A4 1000→500) via stale local state +
last-write-wins sync. Full forensics:
`docs/smart-stock-seeding-forensic-audit-2026-09-17.md`.

## 2. Root cause established by forensic audit

`no selection → all items selected` (`SmartAdjustModal` open-effect +
`items={selectedItems.length > 0 ? selectedItems : allItems}` caller
fallback), no confirmation, no type filter, hand-typed 500 applied to 100
sequential `adjustStock` calls. Mechanism: human UI action, not automation.

## 3. Current production risk (before this task)

Any authenticated ERP user could repeat it in one click. The 2026-09-17
eligibility guard rejects Product/Service at the service layer, but
Raw/Stationery bulk corruption with clean-looking balanced GL remained
one click away, with no review, no limit, no sync check, and no permission
check on the entry point.

## 4. Safeguards implemented

All gates live in one pure, tested module —
`frontend/views/inventory/InventoryList/services/smartAdjustSafety.ts` —
wired into `SmartAdjustModal` (preview → review → applying) and the
`InventoryListPage` entry point. Mutation still flows through the unchanged
`updateStock → transactionService.adjustStock` path (idempotent bulk ids,
OPERATIONAL_ADJUSTMENT intent, eligibility guard authoritative).

1. **Explicit selection only.** Modal opens with zero rows selected; the
   low-stock/all-items auto-select is deleted. Empty selection disables
   Continue and shows "Select at least one inventory item before applying
   an adjustment." Caller passes `selectedItems` only (the `allItems`
   fallback is deleted).
2. **Explicit confirmation.** Continue builds a review screen (type,
   quantity, selected/eligible/excluded counts, per-line prev → new with
   names + SKUs, estimated K impact, inventory accounts, sync-pending
   warning, large-impact checkbox when tripped). Mutations fire only from
   Confirm, which re-validates against fresh sync state.
3. **Eligibility first.** Selection is partitioned by authoritative
   `isInventoryBearingItem` (no duplicated rules); Product/Service/unknown
   rows are badged "excluded — non-stock", listed separately, and never
   passed to the service. Unknown/blank types fail closed.
4. **Bulk limit.** `SMART_ADJUST_MAX_ITEMS = 20` eligible items per run
   (conservative cap for cycle-count-sized corrections; documented in
   code). Over-limit is a hard block with a controlled-batches message. No
   automatic batching exists anywhere in the flow.
5. **Magnitude tripwire.** `SMART_ADJUST_LARGE_VALUE_THRESHOLD =
   K1,000,000` total impact or any line beyond 10× current stock requires
   ticking a large-impact acknowledgement naming the amount. Documented as
   a review tripwire, not business/accounting policy; ordinary work is
   never blocked.
6. **Sync safety.** Confirm-time snapshot from the existing
   `backgroundSyncService.getState()` + `navigator.onLine`. Blocks when
   offline, syncing, recent sync failures, or dead letters exist; pending
   queue alone only warns. Honest limitation documented in code: the client
   cannot prove cloud freshness, so only clearly-unsafe states block.
7. **Permission.** Entry button and modal execution require the existing
   `inventory.adjust` permission (`checkPermission`, Administrators +
   Managers hold it; Cashiers/Sales/Operators/Standard do not). No new RBAC.
   Service-level eligibility guard remains authoritative if the UI is
   bypassed.

## 5. Exact files changed

- `frontend/views/inventory/InventoryList/services/smartAdjustSafety.ts`
  (new — all gates, pure)
- `frontend/views/inventory/components/SmartAdjustModal.tsx` (selection,
  review step, eligibility display, limit/sync/permission/magnitude wiring;
  mutation loop now iterates confirm-time eligible items only)
- `frontend/views/inventory/InventoryList/InventoryListPage.tsx`
  (permission-gated button; explicit-selection passthrough)
- `frontend/tests/views/smartAdjustSafety.test.ts` (new — 25 tests)

## 6. Exact functions changed

- `SmartAdjustModal`: open-effect (selection reset), `handleContinueToReview`
  (new), `handleConfirmAdjustment` (was `handleApplyAdjustments`; now
  re-validates then mutates), new `ReviewStep` component; `getStockChange`
  delegates to shared `getSmartAdjustDelta`.
- `InventoryListPage`: `canBulkAdjust` + conditional Smart Adjust button +
  `items={selectedItems}`.
- New: `resolveSmartAdjustTargets`, `partitionSmartAdjustTargets`,
  `checkSmartAdjustBulkLimit`, `getSmartAdjustDelta`,
  `estimateSmartAdjustImpact`, `checkSmartAdjustMagnitude`,
  `checkSmartAdjustSync`, `readSmartAdjustSyncSnapshot`,
  `decideSmartAdjustApply`.

## 7. Selection behavior before/after

Before: open → low-stock auto-select, else select-all; caller fell back to
`allItems`. After: open → nothing selected; only explicitly ticked rows
enter; empty → disabled Continue + validation message.

## 8. Eligibility behavior before/after

Before: every selected row mutated (Product/Service included). After: only
`isInventoryBearingItem` rows mutate; the rest are shown as excluded with
reasons; unknown types fail closed; service guard unchanged and
authoritative.

## 9. Confirmation behavior

Two-step (preview → review → Confirm), per-line prev → new, value impact in
K, accounts listed, sync-pending warning, large-impact checkbox when
tripped, Cancel at every step with zero mutations. Confirm re-checks sync +
eligibility before releasing mutations.

## 10. Bulk limit

20 eligible items per run (`SMART_ADJUST_MAX_ITEMS`). Over → hard block,
manual batches only.

## 11. Sync-safety behavior

Blocks on offline / syncing / consecutive failures / dead letters using
existing `backgroundSyncService.getState()`; pending>0 warns. Limitation
documented: freshness itself is unprovable client-side.

## 12. Authorization behavior

Existing `inventory.adjust` permission gates button + execution; no new
roles. Outstanding (not built per scope): supervisor-only restriction and
second-approver flow remain future controls.

## 13. Tests added

`frontend/tests/views/smartAdjustSafety.test.ts` — 25 tests: selection (3),
eligibility incl. unknown fail-closed (4), confirmation/permission/quantity
(5), bulk scope incl. no-auto-batching (2), sync states (6), magnitude ack
(2), incident reproduction (3: 100-item/no-selection → EMPTY_SELECTION zero
release; 100 explicit → LIMIT_EXCEEDED with 31 eligible/69 excluded; 20
stocked → releasable).

## 14. Tests run

- New suite: **25/25 pass.**
- `tsc --noEmit` on touched files: **zero errors.**
- Regression: `tests/accounting` + inventory/reconciliation/diagnostic/list
  suites — **431 passed, 13 failed**, where the 13 are byte-identical
  pre-existing HEAD failures (K4,828 ProfitMargin `finalAcceptance` 10,
  `enterpriseAccountingAcceptance` 2, `openingCashDuplicates` 1 — unrelated
  areas, verified identical before this change set in the prior task).

## 15. Historical data deliberately left untouched

100 ADD txns, 91 idempotency rows, all quantities, warehouse rows, invoices,
orders, ledger, COA, openings: unchanged (verified — no data calls were
made; tests are pure/in-memory).

## 16. Remaining risks

1. Raw/Stationery bulk error still possible (by design — legitimate path);
   now reviewed, capped at 20, acknowledged when large, sync-checked.
2. Permission model is coarse (`inventory.adjust` holders can still bulk);
   supervisor-only / dual-approval not built.
3. Sync gate blocks only provably-unsafe states; a fully-synced-but-stale
   browser (the incident's root enabler) cannot be detected client-side —
   structural limitation, needs server-side generation guard (future).
4. Single-item modals/steppers share the service guard (verified) but have
   no review step — acceptable blast radius (one item), unchanged by design.
5. Historical incident data + K222,498 still await their separate tasks.

## 17. Next recommended task

Physical recount + frozen-data opening recomputation (the K41,868,000
figure is stale; live masters are uncounted seeding) — only after this
containment is reviewed and merged.

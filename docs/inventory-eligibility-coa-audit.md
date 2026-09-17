# Inventory Eligibility & COA Audit — Prime Printing (Prime ERP only)

> READ-ONLY audit + preventive code change. No journals posted. No inventory
> adjustments created. No historical records modified. No Supabase business
> data altered. Portal untouched (all portal files restored byte-identical;
> `git status` shows zero portal changes).

## 1. Business rule (authoritative)

Prime Printing's business model, now enforced as an explicit ERP rule:

| Item Type    | Supports Stock? | Inventory Asset? | `isInventoryBearingItem` |
| ------------ | --------------: | ---------------: | -----------------------: |
| Raw Material |             YES |              YES | `true`                   |
| Stationery   |             YES |              YES | `true`                   |
| Product      |              NO |               NO | `false`                  |
| Service      |              NO |               NO | `false`                  |

Conceptual flow (enforced):

```text
ITEM TYPE → INVENTORY ELIGIBILITY → INVENTORY ACCOUNT → ACCOUNTING TREATMENT
```

Business examples:

- **Chalk (Stationery, stocked):** school orders 100 → Stationery stock −100 →
  inventory decreases → COGS. Fixture: `50 × K2,800 = K140,000` in 11420.
- **School Board (Product, non-stock):** school orders 5 → BOM → Raw Material
  consumption → Raw Material inventory decreases → production cost / COGS.
  The Product itself is never deducted from stock and never valued.
- **Service:** no stock quantity, no inventory asset; sells to revenue
  (41200 when service-only) with no COGS inventory leg.

## 2. Existing implementation found

**Item types** — canonical types in `frontend/utils/pricing.ts`
(`normalizeInventoryItemType`, `ITEM_TYPE_ALIASES`): `Raw Material`
(`raw/material/consumable` aliases), `Stationery`, `Product`
(`finished good(s)/finished product/printing product` collapse here),
`Service` (`printing service` alias). Unknown types default to
`'Raw Material'` for *display* — eligibility deliberately does NOT use the
normalized type (see below).

**Eligibility (before)** — none. There was no `isInventoryBearingItem`.
Stock applicability was inferred per call-site: `type !== 'Service'` checks,
`Stock: 50` rendered for any row with a `stock` field, valuation summed
`stock × cost` over all non-service items.

**New authoritative rule** — `frontend/utils/inventoryNormalization.ts`:

- `isInventoryBearingItem(item)` reads the **raw** type/classification
  (`_rawType`/`_rawClassification`, preserved by `normalizeInventoryItems`
  before pricing normalization), so the `'Raw Material'` display default and
  the `Finished Good → Product` collapse can never launder an item into or
  out of eligibility. Service token vetoes first; then
  stationery/raw/material/consumable → `true`; everything else (Product,
  Finished Good, merchandise, unknown, empty) → `false`.
- `getInventoryAccountForItem(item)` — eligibility-first wrapper:
  non-stock → `null` (no account, no value, stock N/A).
- `classifyInventoryItem` — new `NON_STOCK_TYPE` exclusion (after
  deleted/service, before quantity/cost checks), value forced to 0.

**`resolveInventoryGLAccountCode`** — pure type→account map (unchanged
semantics, now documented as map-only): service → `null`, finished
good/product → `11430`, product/merchandise → `11410`, raw/material/
consumable/stationery → `11420`, else `null`. Used at:
`openingBalanceService` (diagnostic + `buildOpeningInventoryPlan` via
`classifyInventoryItem`), `transactionService` GRN/PO paths (via
`resolveInventoryAccountFromItems`, now eligibility-first),
`_internal.calculateCogsLegsPerInventoryAccount` /
`calculateItemsCost` (eligibility-gated), `inventoryAdjustmentAccounting`
(reached only after the `adjustStock` eligibility guard),
`inventoryReconciliationDiagnostic` (GL-side account resolution only;
physical side gated).

**`resolveInventoryAccountByItemType`** (`services/transactions/_internal.ts`)
— same map keyed by account id; `resolveInventoryAccountFromItems` now
filters to eligible lines first and returns `null` when none are
stock-bearing (PO/GRN with only Product/Service lines debit Purchases
`51100`, never inventory).

## 3. Root cause of Product/Service stock visibility

Three compounding causes, all stemming from "no explicit eligibility rule":

1. **Valuation without eligibility** — every aggregator summed
   `stock × cost` for all non-service rows (`computeInventoryReconciliation`,
   `reconcileInventoryValuation`, `computeOpeningInventoryDiagnostic`,
   `buildOpeningInventoryPlan`, dashboard KPIs, list stats, both report
   pages, year-end check, reconciliation diagnostic). Any Product row with
   legacy `stock`/`cost` fields therefore valued as inventory.
2. **Product → 11410 mapping treated as proof of stock** — the legacy
   `product/merchandise → 11410 Merchandise Inventory` map gave every Product
   a "home" in inventory, and consumers treated a mapping result as
   inventory-bearing. Merely being mapped to 11410 made Products inventory.
3. **UI rendered `stock` unconditionally** — list cells, steppers,
   low/out-of-stock badges, detail KPIs, warehouse/storage sections, and
   creation-form stock fields keyed off record fields, never off item type.

Services were partially excluded (`type !== 'Service'` sprinkles) but could
still acquire stock/value through creation-form `trackStock`, POS display,
and any path that missed a sprinkle. Products had no exclusion at all.

## 4. COA mapping findings

- **11410 Merchandise Inventory** — legacy bucket for `product/merchandise`
  types. Retired in practice: the map is kept (so history stays
  interpretable) but `getInventoryAccountForItem` / `classifyInventoryItem`
  gate it — no NEW Product value can enter 11410. It has no other legitimate
  purpose under the confirmed business model (Prime Printing holds no resale
  merchandise); historical 11410 balances, if any post, require separate
  controlled remediation — NOT done here.
- **11420 Raw Materials** — holds stock-bearing Raw Materials AND Stationery
  (existing architecture; Stationery explicitly maps here). All K41,868,000
  of opening value lives here, including Chalk (`50 × 2,800 = K140,000`)
  and A4 Paper (`1000 × 17,000 = K17,000,000`).
- **11430 Finished Goods** — K0 and stays K0 by construction: the only types
  mapping to 11430 (`finished good(s)/finished product`) are non-stock under
  the rule, so `classifyInventoryItem` excludes them before bucketing. Live
  data contains zero `finished` types (verified in the opening-inventory
  verification). An `FG-` prefix never overrides type: `FG-BC-014 Arch File`
  (Stationery → 11420, eligible) vs `FG-BC-009 Administration Records`
  (Product → excluded). Populating 11430 requires an explicit future rule
  change if the business ever stocks finished goods.
- No COA accounts were deleted, renamed, restructured, or rebalanced.

## 5./6. Current Product / Service inventory valuation

After the rule (live-verified before-totals from
`docs/financial-opening-inventory-final-verification.md`, after-totals by
applying the rule through the same code path):

| Account | Before (verified) | After | Δ (removed) |
| ------- | ----------------: | ----: | ----------: |
| 11410 Merchandise | K9,914,854 (61 Product items) | **K0** | −K9,914,854 |
| 11420 Raw Materials | K41,868,000 (30 Raw/Stationery) | **K41,868,000** | K0 |
| 11430 Finished Goods | K0 | **K0** | K0 |
| **TOTAL** | **K51,782,854** | **K41,868,000** | **−K9,914,854** |

- **Product value removed from inventory valuation: K9,914,854** (100% of
  the 11410 bucket; all 61 items are type Product, excluded as
  `NON_STOCK_TYPE`). The 10 zero-qty Active Products were K0 either way.
- **Service value removed: K0** — services were already valued at 0
  (8 live services excluded as `SERVICE_ITEM`); the rule now also blocks
  them from all mutation/display paths.
- Nothing was posted: this is a preview comparison only
  (`buildOpeningInventoryPlan` / `computeOpeningInventoryDiagnostic` are
  read-only until an approved `openInventory()` call).

## 7. Historical Product/Service inventory records discovered

- 61 live Product rows carry legacy `stock`/`cost` contributing K9,914,854
  of *preview* value (now excluded from valuation, NOT deleted/modified).
- 8 live Service rows (excluded, K0).
- 3 deleted-with-value pairs (~K1.58M) + 3 other deleted with value
  (~K3.5M) documented in the verification report — untouched.
- 1 posted `CR 11420 K28,000` Chalk COGS (`LG-COGS-1789352994628`,
  `INV-P726/021`, 10× Chalk) — legitimate, untouched.
- No historical ledger/inventory-transaction/invoice-line rewrite was
  performed. Whether the 61 Product rows' legacy quantities need
  zeroing/archiving is flagged for **separate controlled remediation**
  (accountant decision; out of scope here).

## 8. New authoritative rule (files)

Core: `frontend/utils/inventoryNormalization.ts`
(`isInventoryBearingItem`, `getInventoryAccountForItem`,
`NON_STOCK_TYPE` in `classifyInventoryItem`).

Enforcement points (all fail-safe, existing error conventions kept):

- `services/transactions/_internal.ts` — `calculateItemsCost`,
  `calculateCogsLegsPerInventoryAccount`, `resolveInventoryAccountFromItems`
  skip non-stock lines (line type governs; stored record governs when the
  line is untyped).
- `services/transactionService.ts` — sale/BOM deduction (BOM components AND
  direct lines), GRN receive (non-stock value → DR Purchases/CR AP, payable
  whole), PO approve/reversal, `adjustStock`, `transferStock`, `reconcile`
  (eligible-only variance), work-order consume/complete (output only added
  for stock-bearing items), waste (rejected), order reserve/fulfil-deduct
  (skipped for non-stock).
- `services/inventoryTransactionService.ts` — deduct/add rejected for
  non-stock with explanatory error.
- `context/InventoryContext.tsx` — reconciliation filters to eligible.
- Valuation aggregators — `openingBalanceService` (diagnostic + plan),
  `_internal.computeInventoryReconciliation`, `reconcileInventoryValuation`,
  `inventoryReconciliationDiagnostic`, `inventoryYearEndService`,
  `FinancialReports`, `InventoryReports`, `useInventoryDashboard`,
  `inventoryListService.calculateStats` (productValue pinned 0;
  material/consumable aliases bucketed to raw) — all eligible-only.

## 9. Files changed

Production code (28):

- `frontend/utils/inventoryNormalization.ts` (rule + gate)
- `frontend/services/transactions/_internal.ts`
- `frontend/services/transactionService.ts`
- `frontend/services/openingBalanceService.ts`
- `frontend/services/inventoryTransactionService.ts`
- `frontend/services/inventoryReconciliationDiagnostic.ts`
- `frontend/services/inventoryYearEndService.ts`
- `frontend/context/InventoryContext.tsx`
- `frontend/views/inventory/InventoryList/InventoryListPage.tsx`
- `frontend/views/inventory/InventoryList/components/InventoryTable.tsx`
- `frontend/views/inventory/InventoryList/components/RowIndicators.tsx`
- `frontend/views/inventory/InventoryList/hooks/useInventoryDashboard.ts`
- `frontend/views/inventory/InventoryList/services/inventoryListService.ts`
- `frontend/views/inventory/InventoryReports.tsx`
- `frontend/views/inventory/ItemDetail/ItemDetailPage.tsx`
- `frontend/views/inventory/ItemDetail/hooks/useItemDetail.ts`
- `frontend/views/inventory/ItemDetail/tabs/OverviewTab.tsx`
- `frontend/views/inventory/ItemDetail/tabs/WarehousesTab.tsx`
- `frontend/views/inventory/components/ProductDetails.tsx`
- `frontend/views/accounts/FinancialReports.tsx`
- `frontend/views/pos/components/PosModals.tsx`
- `frontend/views/pos/components/ProductGrid.tsx`
- `frontend/components/data-table/ResponsiveDataTable.tsx`
  (+ `types.ts`: per-row `hidden` for row actions)
- `frontend/components/items/ItemModal/ItemModal.tsx` (Service stock
  controls removed; Product already forces stock 0 / reorder 0)

Tests (8): `inventoryEligibility` (new),
`inventoryValuation`, `openingBalance`, `inventoryReconciliation`,
`stockAdjustmentAccounting`, `phase2.4-inventory-coa`,
`inventoryReconciliationDiagnostic`, `endToEndAccounting`,
`invoicePostingLifecycle`, `invoiceProcessPosting`.

## 10. UI changes (minimum, layout/density preserved)

- **Item list** — Product rows: Stock cell → muted `Not stocked`, no
  stepper, no summed footer quantity, no Adjust/Transfer actions, no
  low-stock highlight. Service rows: no stock column content, no Adjust
  action. Raw/Stationery rows unchanged (steppers, reorder, actions).
  `InventoryTable` stock/available/reserved/value/warehouse cells render
  `Not stocked` for non-stock; Adjust/Transfer actions hidden per row;
  low/out-of-stock badges suppressed; stock filters never match non-stock.
- **Item detail** — `isStockTracked` now delegates to the authoritative
  helper (covers `Material`/classification aliases). Non-stock: Inventory
  tab hidden, Storage section hidden, `Stock Applicability` field added
  ("non-stock product produced against orders/BOM" / "non-stock service"),
  header badge `No Stock Tracking`, KPIs show price/margin only, AI panel
  states the non-stock fact. Raw/Stationery detail unchanged.
- **Creation/edit** — Service: `Track Stock` toggle + stock/reorder inputs
  removed (forced 0). Product: already non-stock (stock forced 0,
  reorder 0; `productStock`/`productReorder` are dead state, left
  untouched). Raw/Stationery stock fields preserved. BOM/production
  functionality unchanged.
- **POS** — stock counts shown for stock-bearing items only.

## 11. Accounting/valuation changes

- Only Raw Material/Stationery contribute `quantity × authoritative cost`
  (existing rounding/cost-preference logic untouched).
- Product/Service lines generate **no** COGS inventory-credit leg; revenue
  still posts (Product → 41100; service-only → 41200). Non-stock GRN value
  → DR Purchases (51100)/CR AP.
- Production consumes/posts only stock-bearing inputs; Product output adds
  no stock and no WAC. No Finished-Goods layer created. The separate
  UOM/production-conversion issue was NOT touched.
- Opening preview now yields a single 11420 line (K41,868,000); posting
  itself was NOT executed.

## 12. Tests executed

- New `tests/accounting/inventoryEligibility.test.ts`: 13/13 pass
  (rule matrix, aliases, FG- prefixes, fail-safe unknowns, Chalk/Board/
  Service/A4 anchors, mixed-batch totals).
- Updated suites (old tests encoded Product-as-inventory):
  `inventoryValuation`, `openingBalance`, `inventoryReconciliation`,
  `stockAdjustmentAccounting` (+ new Product-reject test),
  `phase2.4-inventory-coa` (+ null-when-no-stock-bearing test),
  `inventoryReconciliationDiagnostic` (+ Product-exclusion test),
  `endToEndAccounting` (+ revenue-without-COGS test),
  `invoicePostingLifecycle`, `invoiceProcessPosting`,
  `inventoryItemNormalization`, `inventoryListService`,
  `stockAdjustmentCorrection` — all pass.
- `npx vitest run tests/accounting`: **362 passed, 13 failed** — the 13
  failures (`finalAcceptance` 10, `enterpriseAccountingAcceptance` 2,
  `openingCashDuplicates` 1) are **pre-existing at HEAD** (verified via
  `git stash`: identical 13 failures on unmodified HEAD; they concern
  K4,828 ProfitMargin reversal / trial-balance / opening-cash decision
  logic untouched by this task).
- `tsc --noEmit`: repo has extensive pre-existing errors; none of the
  errors in touched files are introduced by this change (verified the only
  touched-file diagnostics — `inventoryNormalization` display-type cast,
  `ItemDetailPage` pre-existing missing tab imports, `ProductDetails`
  duplicate key, `PosModals`/`FinancialReports`/`_internal` pre-existing
  type mismatches — exist identically at HEAD).
- Production/Service sales paths verified unbroken: service-only → 41200
  no-COGS test, Product revenue-without-COGS test, stocked AR+COGS+deduct
  test, BOM/production tests in `inventoryValuation`.

## 13. Before/after inventory totals

See §5/§6 table. **K9,914,854 of Product value removed from valuation;
11410 → K0; 11420 unchanged K41,868,000; 11430 K0; total K41,868,000.**

## 14. Opening-balance impact

- Next approved opening preview will propose **DR 11420 K41,868,000 /
  CR equity K41,868,000** (31000 vs 32000 still requires accountant
  approval, as does date/cutoff) instead of the previous K51,782,854.
- No opening journal was created; no balances moved. The K9,914,854 delta
  is a *valuation exclusion*, not a write-off posting — historical 11410
  balances (if any post) still need the separate controlled remediation
  in §7.

## 15. Unresolved historical data issues (separate review required)

1. 61 Product rows with legacy stock/cost (K9,914,854 preview value) —
   zero-out vs archive vs keep-for-reference (accountant + operations).
2. Deleted-with-value rows (~K5.08M if counted) — genuine vs obsolete.
3. Chalk 50-vs-40 physical count (K28,000 difference — GL correct either way
   as legitimate COGS; system qty needs physical count).
4. A4 cost-basis invoice evidence (K17M stands under the business-UOM
   interpretation; procurement-document proof still wanted for audit).
5. Toner/Cartridge K70,000 and Printing-all-Subjects K44,444.44 cost
   evidence; Stapler zero-cost proof.
6. Pre-existing test failures (§12) in unrelated ProfitMargin/opening-cash
   areas.

## 16. Confirmations

- **No historical financial records were modified** — no ledger writes, no
  inventory-transaction writes, no invoice-line/cost/quantity/status
  changes, no journals, no adjustments, no opening post. `git status`
  shows only frontend code + test + this doc file.
- **Portal untouched** — every `frontend/views/portal/**` file restored to
  HEAD; no portal data touched; no `portal.*` host/route/branding change
  ships in this task.
- **A4 Paper remains `1000 × K17,000 = K17,000,000`** in 11420
  (valuation never divides by 500; K34/K35 used for consumption only).
- **K28,000 Chalk COGS (`LG-COGS-1789352994628`) untouched.**
- System is **NOT yet ready** for the physical-verification/opening-balance
  stage on this task alone: physical counts (Chalk, A4, top-10),
  deleted/duplicate ID resolution, equity-account + date/cutoff approval,
  and the §15 historical-data decisions remain outstanding blockers.

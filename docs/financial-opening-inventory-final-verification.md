# Final Controlled Verification — Canonical Opening Inventory (READ-ONLY, NOT POSTED)

> Generated read-only 2026-09-16 from live Supabase via GET-only.
> No opening posted. No journal created. No data modified.
> Portal untouched.

## 1. Executive result

- Independently recalculated live canonical `products` valuation using ERP authoritative logic (`resolveInventoryCostPerUnit` / `resolveInventoryQuantity` / `resolveInventoryGLAccountCode`, `inventoryValue=round2(qty×cost)`):
- **11410 Merchandise Inventory: K9,914,854 (61 included, incl. 10×K0 zero-qty)**
- **11420 Raw Materials: K41,868,000 (30 included, incl. Chalk 50×2800 and A4 Paper 1000×17000)**
- **11430 Finished Goods: K0 (0)**
- **Total: K51,782,854**
- Matches prior K51,782,854 exactly. Hard tests pass (see §9).
- Existing `CR 11420 K28,000` (`LG-COGS-1789352994628`, `INV-P726/021`, 10× Chalk) is legitimate COGS, untouched.
- A4 Paper `1000 reams × K17,000 = K17,000,000` confirmed under business UOM (usage 500 sheets/ream for consumption only, never for valuation).
- Legacy `inventory` K175,250 excluded.
- Conclusion: **NOT READY — PHYSICAL/DATA/ACCOUNTING VERIFICATION STILL REQUIRED** (physical counts + equity/date approval still outstanding). Ready for accountant approval process, but no posting.

## 2. Canonical inventory valuation (recalculated live)

Method: `frontend/utils/inventoryNormalization.ts:112-143,175-192,229-281` + `frontend/utils/pricing.ts:139-149 resolveStoredCost` (baseCost→cost_price→cost_per_unit→cost→costPrice, never SP) × `stock??quantity`. `frontend/services/openingBalanceService.ts:276-350 buildOpeningInventoryPlan` groups by 11410/11420/11430.

- Live `products` 106 rows: 91 included (81 positive value + 10 zero-qty K0), 15 excluded (6 deleted, 8 service, 1 zero-cost).
- No duplicate IDs. No negative qty. No missing-cost. No unmapped type.
- Full per-product table available via same logic; summary totals above. Excluded detail in §6. Deleted/duplicates in §6. Zero-qty Active Products (10, all 11410, K0): `INV-PRD-069/083/072/036/063/075/057/0107/0108/ITM-MU3H6QKV` — included at zero, no value impact.
- Legacy `inventory` (2 rows: `INV-PAPER 5000×35=K175,000`, `INV-TONER 1000×0.25=K250`, total K175,250) explicitly excluded — separate placeholder subsystem (`CLOUD_TABLE_MAP inventory→products`, `portalLifecycleService:354-360`), zero TX/invoice/GL use, no exact overlap with `products`.

## 3. Top-10 physical verification worksheet (system ≠ physical until counted)

| # | ID | Name / type | System qty / UOM | Cost | Value | Acct | Recent TX evidence | Physical still required |
|---|---|---|---|---:|---:|---:|---|---|---|
|1|INV-MAT-008|A4 Paper 80gsm / Raw Material Active|1000 Sheet (purchase Ream, conv 500)|17000|K17,000,000|11420|No purchase/PO/GRN (all 0 rows)|Yes — count reams, confirm Ream cost via invoice, confirm UOM|
|2|INV-MAT-031|Cartlage 05A/55A / Raw Active|50 pcs|70000|K3,500,000|11420|No procurement|Yes|
|3|INV-MAT-010|HP LaserJet Toner / Raw Active|50 Sheet (purchase Kilogram, conv 20000)|70000|K3,500,000|11420|No procurement|Yes|
|4|INV-PRD-021|Printing all Subjects / Product Active|50 pcs|44444.44|K2,222,222|11410|No procurement|Yes|
|5|INV-STA-077|Portable Board / Stationery Active|50 pcs|40000|K2,000,000|11420|No procurement|Yes|
|6|INV-MAT-009|Cover Page / Raw Active|200 Sheet (purchase Ream, conv 100)|9500|K1,900,000|11420|No procurement|Yes|
|7|FG-BC-014|Arch File / Stationery Active|500 pcs|3800|K1,900,000|11420|No procurement|Yes + confirm Stationery type (FG- prefix cosmetic)|
|8|INV-STA-0098|Bic Pens (Original) / Stationery Active|50 Piece|32000|K1,600,000|11420|No procurement|Yes|
|9|INV-MAT-079|Printer Greese / Raw Active|50 pcs|30000|K1,500,000|11420|No procurement|Yes|
|10|INV-MAT-056|Fuser Paper / Raw Active|50 pcs|25000|K1,250,000|11420|No procurement|Yes|
Top-10 total K36,372,222 (~70% of opening). Do not assume system=physical.

## 4. Chalk investigation (INV-STA-011)

- System: `50 Piece, cost 2800, price 4000, Stationery Active, val K140,000`.
- Last OUT: `TXN-1789352994621 OUT -10, previous 50 → new 40, total -28000, 2026-09-14T02:29:54Z, ref INV-P726/021, System`.
- Ledger: `LG-COGS-… DR51200/CR11420 28000` + `LG-INV-AR-… DR11310/CR41100 40000` seconds later — atomic invoice flow.
- Subsequent: master still 50 (`serverUpdatedAt 05:56:27Z 09-14`, row `updated_at 09-15`, `updatedBy 3a4b95…`), no second TX/movement/purchase/GRN, `audit_logs 0`. Stale-sync overwrite vs manual edit indistinguishable from server data — marked `REQUIRES PHYSICAL COUNT`.
- If physical 50: no qty adjustment indicated (GL -28k remains as legitimate COGS against opening).
- If physical 40: system differs by `10 units / K28,000` (master overstated).
- No adjustment posted in this task.

## 5. A4 Paper valuation confirmation

- Business: `1000 reams × K17,000/ream = K17,000,000`, `1 ream=500 sheets` for usage only.
- Live supports numbers (`stock 1000, cost 17000`); `unit Sheet` label is cosmetic tension but valuation/planning treat cost as per stock unit (`inventoryValue=stock×cost`, no conversion; `costPerSheet=cost/500` derived only for consumption/pricing: `pricingEngineShared:190`, `pricing:545`, `NewBatch:61-67`, `PosModals:380`, `examinationService:4589`).
- Do NOT value as `1000 sheets ×34/35 = K34,000/K35,000`. 34/35 are per-sheet usage costs. 500k sheets (`1000×500`) is usage equivalent, not valuation.
- Procurement evidence: purchases 0, POs 0, GRNs 0 — cost basis confirmed by business/UOM interpretation but lacks live procurement-document evidence (explicit).
- Included as K17,000,000 in 11420 above.

## 6. Deleted / duplicate analysis (do not merge/delete)

Pairs (each Deleted qty>0 + Active qty 0 — no double-count as deleted excluded + active K0, but physical owner unknown, human ID required):

- Scheme Pad: deleted `INV-PRD-088 550×2172=K1,194,600` vs active `INV-PRD-0107 0×3163.5=K0`
- Receipt Book: deleted `INV-PRD-085 50×4444.44=K222,222` vs active `INV-PRD-0108 0×3163.5=K0`
- Time Book: deleted `INV-PRD-101 50×3173.5=K158,675` vs active `ITM-MU3H6QKV 0×3163.5=K0`

Other deleted with value (excluded): `INV-MAT-039 50×15000=K750,000`, `INV-STA-027 50×36000=K1,800,000`, `INV-MAT-004 80×12000=K960,000`. Total deleted value ~K5.08M if counted — must stay excluded until verified (genuine vs obsolete vs belongs to active).

## 7. Stapler cost investigation (INV-STA-095)

- `50 Piece, cost 0/costPrice 0/cost_price 0, price/sellingPrice 20000, Stationery Active, val K0`.
- K20,000 is selling price (`price/sellingPrice`), forbidden as cost (`never SP` rule). No valid purchase/invoice cost elsewhere (purchases/PO/GRN 0; no lots). Correctly excluded as `ZERO_COST`. Do not assign cost. Requires purchase-invoice proof.

## 8. Finished Goods classification (type-based, not ID-based)

Rule: `resolveInventoryGLAccountCode` — `finished good/product→11430`, `product/merchandise→11410`, `raw/material/stationery→11420`, `service→null`.

- `FG-BC-005 A4 Exercise Books Stationery 500×240=K120,000 →11420`
- `FG-BC-014 Arch File Stationery 500×3800=K1,900,000 →11420`
- `FG-BC-022 Bantley Pens Stationery 50×13000=K650,000 →11420`
- `FG-BC-009 Administration Records Product 501×2172=K1,088,172 →11410`
- Zero products contain `finished` type. **11430 remains K0 correctly.** FG- prefix alone insufficient.

## 9. Inventory-to-ledger reconciliation

Live `ledger_entries` 3 rows only:

- `LG-COGS-… DR ACC-51200 / CR ACC-11420 28000 COGS INV-P726/021` — legitimate, intact.
- `LG-INV-AR-… DR ACC-11310 / CR ACC-41100 40000 Invoice INV-P726/021` — intact.
- `LG-OPENING-BALANCE DR 11110 / CR 31000 500 Opening Cash` — bare-code form, invisible to `v_trial_balance` (`11110 0/0, 31000 0/0`; totals 68k/68k balanced without 500) — known bare-code gap, not repaired here.
- `v_trial_balance: 11410 0/0, 11420 0/28000, 11430 0/0, 32000 0/0`.
- No opening inventory rows. No unexplained inventory debits. No unmapped inventory TX (single TX maps to 11420 via Stationery).
- Bare `1000` issue checked: historic `LG-PAY-… debit 1000 K70,000` defect (`docs/financial-integrity-*`, `buildResolvedJournalLine` fallback) — **zero live rows use `1000` now** (all 3 use `ACC-*`/bare valid codes for cash/opening). K28,000 is not an opening error and not offset.

GL vs physical: `11410 0 vs 9,914,854`, `11420 -28,000 vs 41,868,000`, `11430 0 vs 0` — variance is uncapitalized stock, to be closed by opening (preview below), not by editing COGS.

## 10. Proposed opening journal PREVIEW — NOT POSTED

Debits (verified §2):

- DR 11410 Merchandise Inventory K9,914,854
- DR 11420 Raw Materials K41,868,000
- DR 11430 Finished Goods K0 (no line)
- Total DR K51,782,854

Credit (show both, do not select):

- Option A: CR 31000 Owner's Capital K51,782,854 (code path `getGLConfig ownerCapital||retained||32000` →31000; opening-cash precedent; tests expect 31000)
- Option B: CR 32000 Retained Earnings K51,782,854 (saved `glMapping.retained:32000`, no ownerCapital saved)

Balanced either way. Accountant must approve: opening date, cutoff, 31000 vs 32000. If Chalk counted at 40, alternate debits `11420 K41,840,000 / Total K51,754,854` (same credit amount adjusted). No posting performed.

## 11. Remaining blockers (human/accountant)

[ ] Chalk physical count (40 vs 50) + qty approval
[ ] A4 Paper count (reams) + Ream-cost invoice + UOM sign-off (17M stands under interpretation, but invoice proof still required for audit)
[ ] Top-10 counts/invoices (especially Toner/Cartlage 70k, Printing 44k)
[ ] Deleted/duplicate physical ID (which master is real)
[ ] Stapler cost proof
[ ] FG K0 confirmation
[ ] Products-only source + legacy excluded/archived approval
[ ] Equity 31000/32000 + date/cutoff approval

## 12. Conclusion

**NOT READY — PHYSICAL/DATA/ACCOUNTING VERIFICATION STILL REQUIRED**

No posting performed. Awaiting physical verification + accounting approval above.

---
Verification: GET-only `products/accounts/ledger_entries/invoices/inventory_transactions/inventory/v_trial_balance/settings`; code reads `inventoryNormalization/openingBalanceService/pricing/transactions/_internal/accountingEngine/db CLOUD_TABLE_MAP/docs financial-integrity`. Portal untouched. No writes except this report file.

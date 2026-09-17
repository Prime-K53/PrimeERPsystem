# Smart Stock Seeding Forensic Audit — 2026-09-17 (READ-ONLY, Prime ERP only)

> Method: repository code inspection (pinned to incident-time commit
> `9891d32` where behavior matters), git history, and GET-only reads of live
> Supabase (analysis ran locally on saved snapshots). Nothing was modified,
> posted, reversed, cleaned, disabled, migrated, or committed. Portal
> untouched.

## 1. Executive Summary

The +500 event was a **single human click** on the ERP's own **"Smart
Adjust" bulk-stock modal** (`SmartAdjustModal`) at **2026-09-16
20:02:20.379Z UTC**: type ADD, quantity **500** (hand-typed; the field
defaults to 0), no custom reason, all 100 active items selected. The modal
looped 100 sequential `adjustStock` calls (~3 s apart, 20:02:28–20:07:01Z),
each writing master stock, warehouse row, `ADJUSTMENT` audit txn, idempotency
key, and — proven by 91 surviving idempotency `result` fields — a
`LG-ADJ-SMART-…` **GL posting that was later wiped** with the rest of the
ledger rebuild. Mutation semantics are **strictly additive**
(`stock + 500`); the uniform 500 masters prove the operator's browser held
stale/empty local quantities (0 for 99 items, 50 for Chalk), which
last-write-wins sync pushed to cloud — destroying the verified A4 1000.
The modal remains **production-reachable today**; the 2026-09-17 eligibility
guard now rejects Product/Service lines, but a one-click +500 to all
Raw/Stationery is still possible. **RISK C.**

## 2. Incident Description

100 active items (61 Product, 21 Stationery, 10 Raw Material, 8 Service)
each gained exactly one `ADJUSTMENT / "Smart stock adjustment (ADD)" /
quantity +500` transaction on 2026-09-16 ~20:02–20:08 UTC, mirrored by
`warehouse_inventory` = 500 rows. A4 Paper fell 1000→500; Chalk passed
through 550 on its way to 431; Services gained 500 despite being non-stock.
Current Raw+Stationery valuation (K222,306,800) is seeding, not counts.

## 3. Exact Trigger — PROVEN: authenticated human UI action

- **PROVEN — one bulk Apply click.** All 91 surviving idempotency rows share
  a single `bulkId = SMART-1789588940379-egoshg`
  (`SMART-<Date.now()>-<rand>`, `SmartAdjustModal.tsx:160`), created
  20:02:28–20:07:01Z in ~3 s steps — the signature of the modal's
  sequential `for … await updateStock(…)` loop (`SmartAdjustModal.tsx:162`),
  not a script (a script would not mint the modal's bulkId format, per-item
  `operationId = <bulkId>-<itemId>`, *and* run at human-loop latency).
- **PROVEN — defaults accepted.** All 100 txns carry the fall-through
  reason `Smart stock adjustment (ADD)` (empty custom reason,
  `SmartAdjustModal.tsx:153`); quantity 500 was hand-typed (field defaults
  to 0 and Apply is disabled at 0; default has been 0 since the first
  commit). Selection was either Select-All or the automatic low-stock
  pre-selection over zero-read local state (`SmartAdjustModal.tsx:99-113`).
- **RULED OUT — startup hook, cron, migration, seed script, import, sync
  recovery, backend job:** the *only* writer of this txn shape in the repo
  is `transactionService.adjustStock` (`transactionService.ts:4814`), called
  for bulk use solely by `SmartAdjustModal`; backend has zero "smart stock"
  references; no startup/cron/import caller exists (full-repo string sweep,
  §4). Pre-selection + defaults explain the blast radius without any
  automation.
- **POSSIBLE but unneeded — which browser/profile:** unknown operator
  device; immaterial to mechanism and recurrence.

## 4. Exact Code Path (incident-time commit `9891d32`)

```text
TRIGGER  InventoryListPage.tsx:525-532 "Smart Adjust" button
           (visible dashboard toolbar; items = selectedItems or ALL items,
            InventoryListPage.tsx:1292-1297 — unchanged at incident time)
   ↓
CALLER   SmartAdjustModal.tsx:140-189 handleApplyAdjustments
           (ADD → stockChange = +|quantity| per item, :126-134;
            bulkId + per-item operationId, :160-172)
   ↓
SERVICE  InventoryContext.tsx:278-328 updateStock
           → transactionService.adjustStock (atomic IDB op)
   ↓
WRITES   (a) products.stock += qtyChange          (transactionService, pre-image line ~item.stock…+params.qtyChange)
         (b) warehouse_inventory same-delta upsert (existing row += Δ; else create with max(0,Δ))
         (c) inventoryTransactions ADJUSTMENT row  (id ADJ-<ts>-<rand>, notes=referenceId=reason)
         (d) idempotency_keys stock_adjustment:<opId> (91 SMART-* rows survive → PROOF)
         (e) ledger LG-ADJ-<opId> gain posting      (result recorded in (d); rows since wiped → §9/§13)
   ↓
MIRROR   local-IDB → Supabase sync (last-write-wins; cloudSync enabled,
         15-min interval + op-driven pushes per companyConfig in settings)
```

`+500`/`500`/`adjustStock`/seed sweeps: no other creator, caller, script,
endpoint, or startup path exists. `StockAdjustmentModal`,
`StockCountModal`, and `stores/inventoryStore.ts:268` share the same
guarded service path (single-item / count-variance use).

## 5. Exact Quantity Source

**Hand-typed UI input.** The `500` originates in the modal's Quantity
`<input>` (`SmartAdjustModal.tsx:341-349`, default 0, `min="0"`); it flows
`quantity state → getStockChange → updateStock(item.id, +500, …) →
adjustStock(qtyChange: 500) → master += 500 / WH += 500 / txn.quantity =
500`. No constant, config, fixture, default, derivation, or fallback `500`
exists anywhere in source (sweeps for `500`, `seed`, `demo`, `sample`,
`mock`, `bootstrap`, `populate`, `bulk stock` return only this input and
unrelated hits). Which 500 seeded the incident is therefore identified by
elimination **and** by the idempotency record: the operator's keystrokes.

## 6. Mutation Semantics — PROVEN additive (`newQty = oldQty + 500`)

Code: `storedItem.stock = (storedItem.stock || 0) + params.qtyChange`
(identical before/after `a4fd259`; unchanged by `006a9d9`). The `ADD` label
is accurate; there is no SET/overwrite branch in this path (SET is a
separate modal mode that would have written `(SET)` txns with negative
deltas — zero such txns exist).

- **Chalk 50(stale)→550: PROVEN.** Local pre-read 50 + 500 = 550, matching
  the 20:07 OUT `previousQuantity: 550` exactly.
- **A4 1000→500: local pre-read was 0** (0 + 500 = 500). Cloud showed 1000
  hours earlier the same day ⇒ the operator's browser local state diverged
  from cloud (stale/empty IDB); see §7.
- **99 uniform 500s ⇒ 99 local pre-reads of 0.** Only Chalk's local copy
  was non-zero (50, itself stale — true cloud value was 40).

## 7. Stale-Read / Concurrency Analysis

Architecture: modal reads React state ← local IndexedDB; `adjustStock`
does read-before-write **against the same local store**, then sync pushes
up; conflict handling is effectively **last-write-wins** (envelope
`version` fields exist but encode sync traffic, versions 2–32 observed —
no vector/compare-and-swap on stock). Sequence for the incident:

1. Operator browser holds divergent local catalog (0 for 99 items, 50 for
   Chalk — consistent with a fresh/stale profile that had synced catalog
   metadata and costs but not the 09-14–09-16 quantity layer; the 09-14
   Chalk OUT 50→40 demonstrably never reached that browser).
2. 20:02:20Z Apply → 100 local additive writes → sync up → cloud masters
   overwritten (A4 1000→500 destroyed; Chalk 40→550 corrupted).
3. Negative `reserved` (−112 INV-PRD-063, −4 ITM-MU3H6QKV-FTBFB) shows order
   flows concurrently touch reservations — same last-write-wins substrate,
   no locking.

Why local was 0 is **UNKNOWN** (fresh profile, failed sync-down, and local
reset are all consistent; no 0-stock seed code exists to blame). That the
writes won over newer cloud state is **PROVEN** by the A4/Chalk arithmetic.

## 8. Warehouse Inventory Analysis

Written **directly by the same `adjustStock` atomic op** (WH put precedes
the audit put; WH `_updated` 20:02:24 slightly predates the first txn
`created_at` 20:02:28 — same loop iteration order). Not independent, not a
second process, not derived-view: for the 100 items the rows were created
at quantity 500 by this event (0 WH rows exist for deleted items). WH is
**derived-mirror, adjustStock-owned**; it can diverge from `products.stock`
via any other writer path (invoice OUT, transfer, GRN) or partial sync —
no divergence was found for the seeded set (WH total 30,500 = masters
30,500 − Chalk's post-seeding −69 movement… precisely: 100×500 − 69 = 49,931
for seeded set; verified equal per-item except Chalk 431/431).

## 9. Accounting Analysis — mechanism POSTED; wipe removed the proof

Incident-time `adjustStock` (commit `9891d32`) posted a gain journal for
every non-service line with `|qty×cost|>0` (fail-closed *before* mutation):
`LG-ADJ-<operationId>`, `DR Inventory / CR COGS(51200)`,
`referenceType: stock_adjustment`, amount `|500×cost|`. Expected postings:
**91** (100 − 8 Services skipped by the `isServiceItem` rule − 1 Stapler
zero-cost skipped by the `previewAmount>0` rule). **Observed survivors: 91
idempotency rows whose `result` is exactly the `LG-ADJ-SMART-…` entry id**
(e.g. `LG-ADJ-SMART-1789588940379-egoshg-INV-MAT-031`). Current ledger holds
**zero** of them. Verdict: **`Inventory transactions exist but their
accounting postings do not — because the postings were wiped, not because
the mechanism bypasses accounting.** The prior audit's "zero GL" reading is
corrected: it is an artifact of the later ledger rebuild (§13), and the
mechanism is accounting-coupled by construction (pre-`a4fd259` it posted
`DR Inventory / CR 42000→42100`, the Sept-12 defect).

## 10. Item-Type Guard Analysis (read-only walkthrough, no change)

Incident-time code knew only `service` (skip GL, still move quantity) —
**Product/Stationery/Raw all adjusted with postings; Services adjusted
without postings.** Current code (`transactionService.ts:4704-4710`,
commit `006a9d9`) rejects Product/Service before any mutation/posting, so
today the same click would adjust **only the 31 Raw/Stationery items**
(with balanced postings) and fail-safe the other 69. The modal itself still
lists and pre-selects all types (no type filter) — guard lives one layer
down.

## 11. Reachability Analysis (no mutation executed)

| Path | Status | Evidence |
|------|--------|----------|
| Smart Adjust button → all-items bulk ADD | **Production reachable** (auth-gated ERP only; unauthenticated access closed per `0c8c3f1`) | `InventoryListPage.tsx:525-532,1292-1297` present at HEAD |
| StockAdjustmentModal (single item) | Production reachable, same guarded service | `:58` → `updateStock` |
| StockCountModal (count variances) | Production reachable, same guarded service | `:45` → `updateStock` |
| List steppers / inventoryStore | Production reachable, same guarded service | `inventoryStore.ts:268` |
| Backend adjust/stock endpoint | **None found** (no route mutates stock; `sync.cjs` is op-gateway) | route sweep |
| Startup / cron / import / migration caller | **None found** (sole bulk caller is the modal) | repo-wide sweep |
| Browser-console direct DB write | Possible in principle (local IDB), **no evidence**; txn/id shape matches `adjustStock` exactly | shape forensics |
| `POST /company/delete` full wipe (`backend/routes/portalAdmin.cjs:121`) | Staff-auth only; **RULED OUT for this incident** (would have emptied all tables; 106 products survive) | code + row counts |

## 12. Recurrence Risk — **YES (human-action; no automation found)**

A recurrence needs only: an authenticated ERP session → Inventory List →
Smart Adjust → (no selection = all items, or low-stock auto-select) → type
a quantity → Apply. **No automated path** (startup, schedule, sync,
migration, import) can fire it — none exists in source. Since `006a9d9`,
blast radius is reduced to Raw/Stationery (69 Product/Service lines now
fail-safe), but an uncounted bulk change with auto-balanced GL remains one
click away.

## 13. Incident Timeline (observed vs inferred)

| Time (UTC 2026-09-16) | Event | Standing |
|---|---|---|
| daytime | Verification snapshot: heterogeneous qtys (A4 1000, …) | Observed (prior report) |
| 20:02:20.379 | Apply click (`bulkId` timestamp) | Observed (idempotency) |
| 20:02:20–20:07:01 | 100 sequential +500 adjustStock commits (~3 s each) | Observed (91 idem-keys + 100 txns + WH stamps) |
| 20:02:48 | A4 master written 500 (local 0 + 500) | Observed (serverUpdatedAt) |
| ~20:02–20:03 | Chalk master written 550 (stale local 50 + 500) | Observed (OUT previousQty) |
| 20:07:39 | Chalk OUT −55 (ref INV-P726/023 — ref mismatched, qty unexplained) | Observed |
| 20:08:49 | SO-P726/021 created from invoice | Observed |
| 21:03–21:21 | Invoice demo flows 021–025 (backdated Jan dates): 5 AR + 8 COGS; Chalk −55/−4/−10 → 431 | Observed |
| evening | **Ledger wipe + reseed**: 3 verified rows (incl. K500 opening cash) gone; 13 invoice rows present; ~91 LG-ADJ rows gone | Observed delta; **wipe actor/moment UNKNOWN** |
| 2026-09-17 02:44Z | `006a9d9` eligibility guard committed | Observed (git) |

## 14. Git / Source-History Findings

- Mechanism born in first commit `5cf071d` (2026-08-15) as bulk-adjust UI;
  quantity default **always 0**, select-all/low-stock-preselect since
  inception — the foot-gun is original, not regressed.
- `a4fd259` (2026-09-13): fail-closed GL (never 42100), bulkId +
  idempotency, OPERATIONAL_ADJUSTMENT intent — the very instrumentation
  that now proves the incident.
- `9891d32` (2026-09-16 05:00 +0200): market-adjustment/revenue work; Smart
  Adjust creation path untouched.
- No commit on/after 09-13 altered the +500 path before the incident; the
  incident required no code change — only a click.

## 15. Evidence Tables

### Required finding table

| Question | Finding | Evidence | Confidence |
|---|---|---|---|
| What created +500? | SmartAdjustModal Apply → updateStock → adjustStock, one click | Single bulkId ×91 idem-rows; sole ADJUSTMENT writer `transactionService.ts:4814` | **Proven** |
| Why 500? | Operator-typed modal input (default 0) | Input `:341-349`; no 500 constant/fixture in repo | **Proven** |
| What triggered it? | Authenticated human Apply, defaults accepted | BulkId format, ~3 s loop cadence, default reason string | **Proven** |
| Additive or overwrite? | Additive (`stock+500`) | Code line + Chalk 50+500=550 exact | **Proven** |
| Why A4 1000→500? | Stale/empty local pre-read (0) + 500, synced up | 0+500=500 arithmetic; cloud 1000 hrs earlier | **Proven** (mechanism); local-why **Unknown** |
| Why Chalk became 550? | Stale local 50 (true 40) + 500 | OUT `previousQuantity: 550`; doc §4 stale-sync | **Proven** |
| Why Services received stock? | No type filter; services skipped GL only | Incident code `isServiceItem` gating; 8 ADDs, 0 postings | **Proven** |
| Warehouse mechanism? | Same atomic op, mirrored | WH stamps + code order + 1:1 rows | **Proven** |
| GL impact? | 91 LG-ADJ postings made, then wiped with ledger rebuild | Idempotency `result` fields; 0 LG-ADJ in 13-row ledger | **Proven** |
| Production reachable? | Yes, auth-gated ERP button today | `InventoryListPage.tsx:525-532` at HEAD | **Proven** |
| Can recur? | Yes (human); no automation exists | Reachability + negative sweep | **Proven** |
| Stale-read/concurrency? | Yes — divergent local catalog won via last-write-wins | A4/Chalk arithmetic; no compare-and-swap | **Proven** |
| Ledger rebuild related? | Rebuild real; Smart Adjust cannot delete rows — separate actor | No delete path in mechanism; `/company/delete` ruled out (products survive) | Rebuild **Proven**; actor **Unknown** |

### K222,498 separation (per §22)

The 11410 Product COGS (5 invoice-line legs, line-cost-driven, master-independent)
is **causally unrelated** to the +500 seeding (which posted 11410/11420
*debits* via gain adjustments, since wiped). Distinct sources, distinct
directions, distinct timestamps — treated separately (R1 vs R2–R4).

## 16. Risk Classification — **RISK C**

**Production-reachable corruption mechanism.** Exact path:
authenticated ERP user → `/supply-chain/inventory` (any tab) → **Smart
Adjust** → no selection defaults to **all items** (or auto low-stock set) →
type quantity → Apply → uncounted additive overwrite of every selected
master + WH + txn + balanced GL. No count verification, no approval, no
type filter in the modal, no anomaly threshold. Mitigated since 2026-09-17
*only* in that Product/Service lines now fail-safe; Raw/Stationery bulk
corruption with clean-looking GL remains one click away. Not dormant (A),
not merely admin-controlled-safe (B: any inventory user, not just admins —
no role check beyond ERP login), evidence sufficient (not D).

## 17. Recommended Remediation — NOT EXECUTED (ordered)

1. **Containment:** gate the Smart Adjust entry (explicit multi-select
   required — never all-items default), add per-run confirmation showing
   computed deltas, restrict to a supervisor role, add magnitude anomaly
   block (>X% or >N units needs second approval).
2. **Preservation:** export/pin the 100 ADD txns + 91 idempotency rows as
   immutable audit exhibits before any cleanup.
3. **Seeded txns:** mark (never delete) the 100 ADDs as voided-by-remediation
   with reversal references once quantities are recounted.
4. **Masters:** recount-driven correction of all 100 stocks (physical count,
   not arithmetic reversal — post-incident movements like Chalk's exist).
5. **Warehouse:** rebuild WH from recounted masters (single source of truth).
6. **R1 (prior report):** controlled remediation of the K222,498 11410
   credits (accountant approval required).
7. **Recount:** full physical inventory before any opening.
8. **Opening:** recompute from recount; never post K41,868,000.
9. **Safeguards:** type-filter + delta-preview + approval threshold on every
   bulk-write path (Smart/Count/single), sync divergence alerts
   (local-vs-cloud guard before bulk Apply).
10. **Tests:** bulk-ADD integration test asserting per-type gating, delta
    preview, threshold block, and GL symmetry; idempotency replay test.

## 18. Outstanding Unknowns

1. Why the operator browser held 0-quantities (fresh profile vs failed
   sync-down vs reset) — no evidence retrievable read-only.
2. Who/what wiped + reseeded the ledger (selective delete has no in-repo
   path; `/company/delete` ruled out) and its exact moment.
3. Whether the ~91 LG-ADJ postings fully synced before the wipe (assumed
   yes; immaterial post-wipe).
4. Identity/intent of the operator (rightly out of scope for code forensics).

## 19. Final Conclusion — **OPTION A**

**SMART STOCK SEEDING MECHANISM IDENTIFIED AND CONTAINMENT REQUIRED**

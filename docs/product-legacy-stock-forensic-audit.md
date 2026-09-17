# Product Legacy-Stock Forensic Audit — READ-ONLY (Prime ERP only)

> Method: GET-only reads of live Supabase (`products`, `inventory_transactions`,
> `ledger_entries`, `invoices`, `sales_orders`, `delivery_notes`,
> `warehouse_inventory`, `production_resources`, `inventory`, `accounts`,
> plus zero-row confirmation of `purchases`, `purchase_orders`,
> `goods_receipts`, `sales`, `orders`, `work_orders`, `production_batches`,
> `boms`, `bom_templates`, …) on 2026-09-17. Analysis ran locally on saved
> snapshots. No code, data, migration, journal, adjustment, COA, or Portal
> artifact was created, modified, or deleted for this audit.

## 0. Executive conclusion

**HISTORICAL ACCOUNTING IMPACT FOUND — CONTROLLED ACCOUNTING REMEDIATION REQUIRED**

Two separable findings:

1. **The 61 Product `stock` fields themselves (currently a uniform 500 each,
   legacy value K99,883,570) are seeded artifacts with no accounting
   substance** — one bulk `"Smart stock adjustment (ADD)" +500` transaction
   per active item on 2026-09-16 ~20:02–20:08 UTC, zero procurement /
   production / GRN history in-system, zero GL postings from the seeding.
   The fields can be handled as data cleanup separately (Category A, with
   one Category B exception below).
2. **Five historical Product COGS legs crediting 11410 (K222,498 total) DID
   enter the ledger** through the old invoice-posting path, with no opening
   debit behind them — 11410 currently carries a **negative (credit)
   balance of −K222,498**, an anomalous negative inventory asset that needs
   a controlled, accountant-approved remediation (Category C, tracked to
   invoice lines — not to the master stock fields).

A further critical observation: **live data moved under our feet.** The
K9,914,854 figure and the K41,868,000 opening proposal are pinned to the
2026-09-16 verification snapshot. Since then a bulk seeding job overwrote
*every* active item's stock to 500 (including A4 1000→500 and Services→500)
and demo invoice flows added 10 ledger rows and 4 Chalk deductions. **The
K41,868,000 opening figure is therefore STALE and must never be posted
without a fresh physical re-verification and a live-data freeze.**

## 1. All 61 Products (live as of 2026-09-17)

Type is `Product` and status `Active` for every row. Under the OLD resolver
each mapped to **11410**; under the NEW eligibility rule each maps to
**no account** with **current inventory value K0**. Stored cost is the
canonical ERP cost (baseCost → cost_price → cost_per_unit → cost →
costPrice; all rows resolve through `cost`/`costPrice`).

| ID | SKU | Name | Stock | Cost | Legacy value (K) | Status |
|----|-----|------|------:|-----:|---------------:|:------:|
| INV-PRD-021 | INV-PRD-021 | Printing all Subjects | 500 | 44444.44 | 22,222,220 | Active |
| INV-PRD-041 | INV-PRD-041 | Criminal law | 500 | 5925.93 | 2,962,965 | Active |
| INV-PRD-029 | INV-PRD-029 | Basic Biology | 500 | 5185.19 | 2,592,595 | Active |
| INV-PRD-047 | INV-PRD-047 | English Literature | 500 | 5185.19 | 2,592,595 | Active |
| INV-PRD-092 | INV-PRD-092 | Social Studies | 500 | 5185.19 | 2,592,595 | Active |
| INV-PRD-019 | INV-PRD-019 | Agriculture P | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-035 | INV-PRD-035 | Chichewa Literature | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-037 | INV-PRD-037 | Community policing | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-038 | INV-PRD-038 | Constitutional law notes | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-042 | INV-PRD-042 | Criminal procedure | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-050 | INV-PRD-050 | Expressive Arts | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-090 | INV-PRD-090 | Science and technology | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-104 | INV-PRD-104 | Transfer Book | 500 | 4444.44 | 2,222,220 | Active |
| INV-PRD-016 | INV-PRD-016 | Administration Record Book | 500 | 3788.5 | 1,894,250 | Active |
| INV-PRD-018 | INV-PRD-018 | Admission Book | 500 | 3788.5 | 1,894,250 | Active |
| INV-PRD-040 | INV-PRD-040 | Criminal investigations | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-051 | INV-PRD-051 | Field craft-ft edits | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-060 | INV-PRD-060 | Intro to law enforcement | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-068 | INV-PRD-068 | Minor field tactics | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-076 | INV-PRD-076 | Police procedure-ft edits | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-082 | INV-PRD-082 | Public order Management | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-098 | INV-PRD-098 | Statutory Law | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-103 | INV-PRD-103 | Traffic management | 500 | 3703.7 | 1,851,850 | Active |
| INV-PRD-075 | INV-PRD-075 | CID Investigation Procedure | 500 | 3324 | 1,662,000 | Active |
| ITM-P726/003 | INV-PRD-0112 | Visitors Book | 500 | 3173.5 | 1,586,750 | Active |
| INV-PRD-0107 | INV-PRD-0114 | Scheme Pad | 500 | 3163.5 | 1,581,750 | Active |
| INV-PRD-0108 | INV-PRD-0116 | Receipt Book | 500 | 3163.5 | 1,581,750 | Active |
| INV-PRD-063 | INV-PRD-063 | Lesson Plans | 500 | 3163.5 | 1,581,750 | Active |
| ITM-MU3H6QKV-FTBFB | INV-PRD-0117 | Time Book | 500 | 3163.5 | 1,581,750 | Active |
| INV-PRD-046 | INV-PRD-046 | Education standard book | 500 | 2962.96 | 1,481,480 | Active |
| INV-PRD-048 | INV-PRD-048 | Ethics | 500 | 2962.96 | 1,481,480 | Active |
| INV-PRD-062 | INV-PRD-062 | Learners Book | 500 | 2962.96 | 1,481,480 | Active |
| INV-PRD-091 | INV-PRD-091 | Skill Charts | 500 | 2962.96 | 1,481,480 | Active |
| INV-PRD-100 | INV-PRD-100 | Teachers Guides | 500 | 2962.96 | 1,481,480 | Active |
| INV-PRD-036 | INV-PRD-036 | Class Records Book | 500 | 2958.5 | 1,479,250 | Active |
| INV-PRD-043 | INV-PRD-043 | Custody management | 500 | 2592.59 | 1,296,295 | Active |
| INV-PRD-061 | INV-PRD-061 | Law of evidence | 500 | 2517.5 | 1,258,750 | Active |
| INV-PRD-044 | INV-PRD-044 | Customer care | 500 | 2222.22 | 1,111,110 | Active |
| INV-PRD-059 | INV-PRD-059 | Human rights | 500 | 2222.22 | 1,111,110 | Active |
| FG-BC-009 | FG-BC-009 | Administration Records | 500 | 2172 | 1,086,000 | Active |
| INV-PRD-020 | INV-PRD-020 | Agriculture S level | 500 | 2172 | 1,086,000 | Active |
| INV-PRD-057 | INV-PRD-057 | Grammar | 500 | 2162 | 1,081,000 | Active |
| INV-PRD-083 | INV-PRD-083 | Question and Answer | 500 | 1929 | 964,500 | Active |
| INV-PRD-078 | INV-PRD-078 | Practical Book | 500 | 1851.85 | 925,925 | Active |
| INV-PRD-069 | INV-PRD-069 | Nyimbo Za Mulungu | 500 | 1785 | 892,500 | Active |
| INV-PRD-033 | INV-PRD-033 | Certificate Of Recognition | 500 | 370.37 | 185,185 | Active |
| INV-PRD-024 | INV-PRD-024 | Authorization Forms | 500 | 222.22 | 111,110 | Active |
| INV-PRD-032 | INV-PRD-032 | Certificate Of Attendance | 500 | 222.22 | 111,110 | Active |
| INV-PRD-052 | INV-PRD-052 | Finacial Report | 500 | 222.22 | 111,110 | Active |
| INV-PRD-065 | INV-PRD-065 | Liqudation | 500 | 222.22 | 111,110 | Active |
| INV-PRD-086 | INV-PRD-086 | Report Cards | 500 | 185.19 | 92,595 | Active |
| INV-PRD-106 | INV-PRD-106 | Wedding Card | 500 | 185.19 | 92,595 | Active |
| INV-PRD-025 | INV-PRD-025 | Auxilliary Attendance forms | 500 | 111.11 | 55,555 | Active |
| INV-PRD-071 | INV-PRD-071 | Order Form | 500 | 111.11 | 55,555 | Active |
| INV-PRD-084 | INV-PRD-084 | Quotation Evaluiation Matrix | 500 | 111.11 | 55,555 | Active |
| INV-PRD-087 | INV-PRD-087 | Request Form | 500 | 111.11 | 55,555 | Active |
| INV-PRD-093 | INV-PRD-093 | Staff Return | 500 | 111.11 | 55,555 | Active |
| INV-PRD-097 | INV-PRD-097 | Stark Card | 500 | 111.11 | 55,555 | Active |
| INV-PRD-102 | INV-PRD-102 | Time tables | 500 | 111.11 | 55,555 | Active |
| INV-PRD-015 | INV-PRD-015 | Activity Form | 500 | 83 | 41,500 | Active |
| INV-PRD-072 | INV-PRD-072 | Payment Voucher | 500 | 37.5 | 18,750 | Active |

Current legacy aggregate at these uniform 500s: **K99,883,570**.

### On the K9,914,854 figure

K9,914,854 is the verified 2026-09-16 snapshot figure (61 included: 51 with
value + 10 zero-qty K0). It **cannot be re-derived to the kwacha from live
rows** because every active row was overwritten minutes-to-hours later by
the bulk seeding described in §2 (all stocks now uniformly 500; A4 Paper
itself moved 1000→500). A uniform-50 reconstruction with current costs
yields K8,748,029 (Δ −K1,166,825), consistent with the snapshot's documented
heterogeneous quantities (e.g. Cover Page 200, Arch File 500, FG-BC-009 501,
A4 1000 on the 11420 side) and possible status flips since. The figure
stands as verified *for its snapshot*; the live position has moved on (see
§9, §13).

## 2. What "stock" actually represents — evidence

The single decisive fact: **all 100 active items (61 Product + 21
Stationery + 10 Raw Material + 8 Service) carry exactly one
`ADJUSTMENT / "Smart stock adjustment (ADD)" / quantity +500` transaction,
all stamped 2026-09-16T20:02:20Z–20:03:50Z**, with a matching
`warehouse_inventory` row of 500 each (100 WH rows; 0 for deleted items).
`serverUpdatedAt` clusters 87/106 products inside 20:02–20:07. No count
sheets, no GRNs, no supplier documents exist anywhere in the system. The
500s are a bulk seeding artifact, not counted, purchased, or produced
stock. (Chalk corroborates the mechanism: its master read a stale 50 while
truth was 40, and the job's +500 landed it at 550 — see §4 of the opening
verification report's stale-sync hypothesis playing out live.)

Summary categories (§1 request):

```text
Product stock with genuine inventory transaction history .... 0 of 61
Product stock with production history only ................. 0 of 61
Product stock with sales/order fulfilment movement ......... 0 of 61
  (zero OUT/fulfilment txns reference any Product master)
Product stock with opening-balance history ................. 0 of 61
  (zero OPENING-ledger references exist at all)
Product stock with seeding-adjustment history only ......... 61 of 61
  (one +500 "Smart stock adjustment (ADD)" each; no GL posted)
Product stock with no supporting history ................... 0 of 61
Unknown/unresolved (exact pre-seeding per-item deltas) ..... noted as
  limitation — overwritten, not recoverable from live evidence
```

Supporting negatives (all confirmed zero-row or absent): `purchases` 0,
`purchase_orders` 0, `goods_receipts` 0, `sales` 0, `orders` 0,
`work_orders` 0, `production_batches` 0, `boms` 0, `bom_templates` 0,
`service_recipes`/`service_jobs`/`service_consumptions` tables do not exist,
`material_batches`/`material_reservations` 0, `audit_logs` 0. The only
production data in-system is 3 press-machine resources (Heidelberg
Speedmaster, Horizon Binder, Polar Cutter) — equipment, not material flow.
The 5 `OUT / Invoice Sale` transactions are **all Chalk (Stationery)**;
none reference a Product. Invoice Product lines carry **no productId**
(name/type/qty/price/cost only) so the old deduction path could never
resolve — and never moved — a Product master. One `sales_orders` row
(SO-P726/021, Confirmed, from INV-P726/025) references `INV-PRD-0107`
(Scheme Pad − M, 20 × 6000) by productId: order association without any
stock movement. Two Products carry negative `reserved` (−112 on
INV-PRD-063, −4 on ITM-MU3H6QKV-FTBFB) and FG-BC-009 carries `reserved: 1` —
reservation-system artifacts of order flows, further proof orders touch
reservations, never Product stock.

## 3. Accounting effects — did the fields enter the GL?

The 61 master stock fields did **not**: the seeding posted no ledger rows
(live `ledger_entries` contains only 8 COGS + 5 AR rows; zero adjustment,
zero opening rows). **But Product invoice lines did**, through the old
line-cost COGS path (which relieved "inventory" per line without needing a
master):

| Invoice | Product lines (qty × line cost) | 11410 credit |
|---------|-------------------------------:|-------------:|
| INV-P726/021 | Lesson Plans-L 19×3778.5 + Time Book-L 1×3778.5 | 75,570 |
| INV-P726/022 | Scheme Pad-M 6×3163.5 | 18,981 |
| INV-P726/023 | Scheme Pad-M 14×3163.5 | 44,289 |
| INV-P726/024 | Scheme Pad-S 8×2548.5 | 20,388 |
| INV-P726/025 | Scheme Pad-M 20×3163.5 | 63,270 |
| **Total** | | **222,498** |

Companion 11420 legs (legitimate stocked Stationery relief): 199,000 +
11,200 + 28,000 = **K238,200** (Chalk 55/4/10 × 2800 + Bic lines). AR legs:
K768,050 total to 41100. No 51100 Purchases, no production journals, no
opening journals exist anywhere.

## 4. Reconciliation of K9,914,854

The snapshot figure describes master-field value, and master fields never
entered the GL — so the reconciliation is dominated by one line, with the
GL impact tracked separately to invoice lines:

```text
Legacy Product stock valuation (2026-09-16 snapshot)
        K9,914,854
              │
              ├── backed by accounting transactions = K0
              │     (no Product master movement ever posted; seeding posted nothing)
              ├── backed by inventory transactions = K0 commercial substance
              │     (61 × +500 seeding ADDs; originative, not evidential)
              ├── production-related = K0 (no BOMs, WOs, batches in-system)
              ├── order/sales-master movement = K0 (lines unlinked; 1 order
              │     reference INV-PRD-0107 with no movement)
              ├── unsupported legacy/seeded fields = K9,914,854
              └── unresolved = K0 (categories; exact pre-seeding deltas unknowable — limitation, §2)
```

Separately, invoice-line-driven Product COGS credited **K222,498** to 11410
(§3) — real GL impact, distinct source, remediated separately (R1).

## 5. 11410 analysis

- **Current Product field value mappable to 11410 (old rule):** K99,883,570
  (61 × 500 × cost) — correctly valued at **K0** under the new rule.
- **Historical inventory-transaction value in 11410:** K0 (no Product txn
  moved stock; seeding posted no GL).
- **Historical GL value:** **K222,498 of credits, K0 debits** (5 legs, §3).
- **Current GL balance:** **−K222,498** (debit-normal asset showing a credit
  balance — anomalous negative inventory asset; no trial-balance view is
  REST-exposed so visibility is computed, not observed — same arithmetic the
  verification report used).
- No correction applied.

## 6. Production/BOM analysis

There is **no finished-goods stock model in evidence and no BOM/production
execution in-system**: `boms`, `bom_templates`, `work_orders`,
`production_batches` are all 0-row; service-recipe tables don't exist;
Product masters show `productType: MANUFACTURED` / `inventoryRole:
sellable` as static labels only. The uniform 500s with zero OUT movements
prove Product `stock` is **an incorrect artifact of the old system
(seeding + unguarded fields), not finished goods held in inventory**. Had a
school ordered 5 boards, the old code path would have tried
`Board stock −5`, but live evidence shows it never successfully did (lines
unlinked). No `Board stock +5` output postings exist either.

## 7. Cost vs price vs valuation (per-Product distinction)

Spot-checked masters show the full stack kept side-by-side, e.g.
FG-BC-009: cost/costPrice/cost_price 2172 (production/BOM-derived unit
cost) vs price/sellingPrice 7000; INV-PRD-021: cost 44444.44 vs price
60000. Invoice lines echo the same split (Scheme Pad-M cost 3163.5 vs
price 6000). Under the confirmed model, `cost × stock` on a Product is a
production-cost reference, **never an accounting asset** — the new rule
enforces exactly this (value K0, COGS only via Raw consumption).

## 8. Risk classification (61 Products)

- **A — Harmless legacy field: 60.** Seeding-only history, no order
  reference, no GL from the field. (Includes FG-BC-009 and the
  Lesson/Receipt/Time masters whose invoice namesakes match by name only —
  association too weak to classify as history, noted in R6.)
- **B — Historical non-accounting artifact: 1** (`INV-PRD-0107 Scheme Pad`
  — explicitly referenced by Confirmed sales order SO-P726/021; no stock
  movement, no GL).
- **C — Historical accounting impact (via master field): 0.** The K222,498
  of 11410 credits came from invoice-line logic, tracked as remediation
  candidate R1, not attributed to any master field.
- **D — Unresolved: 0** (evidence sufficient for the classification;
  pre-seeding deltas unknowable but immaterial to it).

Totals: A=60, B=1, C=0, D=0. Value in A-fields (current): K98,301,820;
in B-field: K1,581,750; C-via-fields: K0.

## 9. Opening-balance special check

**None of the K9,914,854 was ever included in an opening journal**: zero
ledger rows carry opening references of any kind (the old K500 opening-cash
row itself is gone from the rebuilt ledger). There is no existing 11410
debit to duplicate — the only 11410 history is the K222,498 of COGS
credits. The proposed **DR 11420 K41,868,000 is STALE regardless**: current
Raw+Stationery master value is **K222,306,800** (seeded 500s; A4 alone fell
17.0M→8.5M, Toner/Cartlage each 3.5M→35M). Posting the old figure now would
understate by K180,438,800 against live masters — and live masters are
uncounted seeding, so **no opening may be posted until a fresh physical
count and a live-data freeze** (R3/R4).

## 10. Deleted-product analysis (6 rows, all zero txns, zero WH rows)

| ID | Name | Type | Stock | Cost | Value (K) | Accounting txns |
|----|------|------|------:|-----:|----------:|:---------------:|
| INV-MAT-004 | Black Ink (1L) | Raw Material | 80 | 12000 | 960,000 | 0 |
| INV-MAT-039 | Plastic Cover | Raw Material | 50 | 15000 | 750,000 | 0 |
| INV-PRD-085 | Receipt Book | Product | 50 | 4444.44 | 222,222 | 0 |
| INV-PRD-088 | Scheme Pad | Product | 550 | 2172 | 1,194,600 | 0 |
| INV-PRD-101 | Time Book | Product | 50 | 3173.5 | 158,675 | 0 |
| INV-STA-027 | Bic Pens Original | Stationery | 50 | 36000 | 1,800,000 | 0 |

Total K5,085,497 (≈ the prior report's ~K5.08M). **No historical accounting
transactions for any of them.** Do not restore/delete/merge — keep excluded.

## 11. New-rule verification against real data (read-only)

Applied the shipped ERP rule to the live snapshot locally, plus the repo
test suites (in-memory, nothing posted):

```text
Product (61 live) → non-stock: all excluded (NON_STOCK_TYPE), value K0
Service (8 live) → non-stock: all excluded (SERVICE_ITEM), value K0
Raw Material (10 live) → stock: valued qty × cost
Stationery (21 live) → stock: valued qty × cost
FG-BC-009 (Product, FG- prefix) → excluded (prefix never overrides type)
FG-BC-014 (Stationery, FG- prefix) → included in 11420
```

Current-live result under the rule: **11410 = K0; 11420 = K222,306,800
(seeding-inflated, uncounted — NOT an opening figure); 11430 = K0.**
The snapshot-pinned **K41,868,000** (11420) / K9,914,854 (excluded Product)
pair from the 2026-09-16 verification is reproduced by the rule *for that
snapshot's quantities* and remains the last physically-meaningful
reference — superseded live by seeding, hence R4. Repo suites:
`inventoryEligibility` 13/13, `inventoryValuation`,
`openingBalance`, `invoicePostingLifecycle`, `invoiceProcessPosting`
— 85/85 pass, proving Product/Service sales still post revenue with no
inventory relief while stocked lines still relieve 11420 + deduct.

## 12. Remediation candidates (DO NOT execute here)

| # | Record(s) | Problem | Evidence | Accounting impact | Recommended remediation | Accountant approval |
|---|-----------|---------|----------|-------------------|-------------------------|---------------------|
| R1 | 5 COGS legs K222,498 → 11410 (INV-P726/021–025) | Product sales relieved inventory with no opening debit; 11410 now −K222,498 (negative asset) | §3 table; GL net §2-drift | 11410 overstated-credit K222,498; COGS composition misstated (should not have touched inventory) | Controlled reclassification (reverse 11410 credits; rebook Product cost to non-inventory production/Purchases treatment per accountant's call) | **REQUIRED** |
| R2 | 61 Product masters, stock=500 | Seeded quantities, no substance; UI already suppresses display | 61 ADD txns 20:02–20:08; uniformity; §2 | None from fields | Data cleanup (zero/suppress) after R1; operations sign-off | Required for zeroing; display already safe |
| R3 | "Smart stock adjustment" job + all-500 seeding (incl. A4 1000→500, Services→500, stale-sync Chalk 550) | Destroyed verified quantities; uncounted figures now live | Timestamp clustering; Chalk 550 stale-read arithmetic; WH mirror | None posted, but all downstream valuations corrupted | Freeze live inventory writes; investigate job; full physical recount | Required (process + recount scope) |
| R4 | Proposed opening DR 11420 K41,868,000 | Stale vs live K222,306,800; posting either misstates | §9 | Would misstate by K180.4M vs live | Recompute from recount; never post stale figure | **REQUIRED** (account, date, cutoff) |
| R5 | Missing opening history entirely | No opening rows; nothing absorbs R1's credits | 0 opening refs in 13-row ledger | Structural gap for any future opening | Include in opening plan after recount | Required |
| R6 | Unlinked Product invoice lines (name-only; 1 order ref INV-PRD-0107) | No master traceability for sold Products | §2 invoice dump; SO-P726/021 | None (no master movement) | Enforce productId linkage going forward | No (hygiene) |
| R7 | 6 deleted rows K5,085,497 | Stale values, correctly excluded | 0 txns each | None | Keep excluded; archive-vs-purge decision | Recommended |

## 13. Exact current inventory valuation (rule applied to live, 2026-09-17)

11410 = **K0** · 11420 = **K222,306,800** (uncounted seeding — not usable) ·
11430 = **K0** · Product legacy excluded **K99,883,570** · Service excluded
K0 (8 services, all currently seeded 500 × cost but SERVICE_ITEM-excluded).

## 14. Tests performed

- Repo (read-only, in-memory): `inventoryEligibility` 13/13,
  `inventoryValuation`, `openingBalance`, `invoicePostingLifecycle`,
  `invoiceProcessPosting` — **85/85 pass**.
- Live-data rule application (local script on GET snapshots): §11 matrix —
  all pass.

## 15. Files inspected (repo, read-only)

`frontend/utils/inventoryNormalization.ts`,
`frontend/utils/pricing.ts`, `frontend/services/db.ts` (table map),
`frontend/services/transactions/_internal.ts`,
`frontend/services/transactionService.ts`,
`frontend/services/openingBalanceService.ts`,
`docs/financial-opening-inventory-final-verification.md`,
`docs/inventory-eligibility-coa-audit.md`. Live tables enumerated in the
header. No file was modified.

## 16./17. Confirmations

- No journal posted; no inventory adjustment created; no product modified;
  no ledger modified; no COA modified; no Supabase business data modified
  (only HTTP GET via a temp-dir script; credentials never altered/printed);
  no migration touched.
- **Portal untouched** — no portal file read or written for this audit; no
  portal data queried (`git status` shows zero portal paths).

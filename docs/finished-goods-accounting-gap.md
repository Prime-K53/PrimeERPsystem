# Finished Goods Accounting Gap — Documentation

**Date:** 2026-09-20  
**Status:** DOCUMENTED — NOT IMPLEMENTED  
**Related references:** `frontend/services/transactionService.ts` (~line 5230 `completeWorkOrder`), `backend/services/productionService.cjs` (`postWipLedger`, `postCogsLedger`)

---

## 1. Current Finding

`completeWorkOrder` in `frontend/services/transactionService.ts` (around line 5230) updates `product.stock` when a work order is completed, but does **not** create any Finished Goods GL output.

Specifically:
- Raw Material consumption **does** post to ledger (DR COGS / CR Inventory).
- Production output updates `product.stock` and recalculates `normalizedCP`.
- No GL entry is created for the Finished Goods output.
- No WIP (Work in Progress) account is used in the frontend production flow.

Meanwhile, the backend `productionService.cjs` contains:
- `postWipLedger` — attempts to post DR WIP / CR Inventory when a work order moves to "In Progress".
- `postCogsLedger` — attempts to post DR COGS / CR WIP when a work order moves to "Completed".

These backend functions exist but are **not wired into the frontend production flow**. The frontend `completeWorkOrder` does not call them.

---

## 2. The Gap

There is no coherent, end-to-end production accounting model implemented in Prime ERP:

```
Raw Materials → WIP → Finished Goods → COGS
```

or any alternative model.

The current state is:
- 11430 Finished Goods **exists** in the COA.
- `resolveInventoryAccountByItemType` maps `finished good` / `finished goods` types to 11430.
- `resolveInventoryGLAccountCode` in `inventoryNormalization.ts` also maps finished goods to 11430.
- **However**, no production path actually posts to 11430.

The backend `postWipLedger` and `postCogsLedger` attempt to find WIP and inventory accounts by **name search** (`name.includes('wip')`, `name.includes('inventory')`), not by canonical code. This is fragile and not aligned with the canonical 11400/11410/11420/11430 structure.

---

## 3. Why 11430 Exists Does NOT Justify Implementation

The presence of account 11430 in the COA does **not** mean:
- A production accounting workflow is required.
- The system should automatically post Finished Goods entries.
- The backend `postWipLedger` / `postCogsLedger` functions are correct or complete.

11430 may exist because:
- It was pre-seeded in the canonical COA template.
- It is a placeholder for a future production accounting model.
- It was added during a previous COA migration without corresponding workflow implementation.

---

## 4. Required Decision Before Implementation

Before implementing Finished Goods accounting, the following must be determined:

### 4.1 Intended Accounting Model

Which model does Prime ERP intend to use?

| Model | Description | Accounts Required |
|-------|-------------|-------------------|
| **A: Direct** | Raw Materials → COGS (no WIP, no FG) | 11420, 51200 |
| **B: WIP only** | Raw Materials → WIP → COGS (no separate FG) | 11420, 114xx WIP, 51200 |
| **C: Full flow** | Raw Materials → WIP → Finished Goods → COGS | 11420, WIP, 11430, 51200 |
| **D: Simplified** | Raw Materials → Finished Goods → COGS (no WIP) | 11420, 11430, 51200 |

The current backend code loosely resembles Model C but is incomplete and name-based.

### 4.2 WIP Account Definition

If WIP is part of the model:
- What is the canonical WIP account code? (Not currently defined in `getGLConfig`)
- Is WIP a sub-account of 11400 or a separate code?
- Should WIP balance be reported as an asset?

### 4.3 When Does FG Valuation Occur?

- At work order completion? (as implied by `postCogsLedger` timing)
- At sale? (FIFO/weighted average from FG stock)
- Both?

### 4.4 Cost Flow

- Does FG carry a separate cost layer from Raw Materials?
- Is `normalizedCP` on the product record sufficient for FG valuation?
- Should production overhead/labor be included?

### 4.5 Scope

- Which item types trigger production accounting?
- `Product` only? `Finished Good` type? Both?
- Services and Stationery must remain excluded.

---

## 5. Current Backend Production Functions (Reference Only)

### `postWipLedger` (backend/services/productionService.cjs)

```javascript
async postWipLedger(workOrder, currency = 'USD') {
    const accounts = await repo.accounts.getAll({ 'data->>type': 'eq.asset' });
    const wipAccount = accounts.find((a) => {
        const d = a.data || a;
        const name = String(d.name || '').toLowerCase();
        return name.includes('wip') || name.includes('work in progress');
    });
    const invAccount = accounts.find((a) => {
        const d = a.data || a;
        const name = String(d.name || '').toLowerCase();
        return name.includes('inventory') || name.includes('stock');
    });
    // ... posts DR WIP / CR Inventory
}
```

**Issues:**
- Uses name search instead of canonical code.
- Does not handle the case where WIP account is not found (silently returns).
- Posts to the first account matching "inventory" or "stock" — could be 11410, 11420, or 11400.
- No company/context filtering.

### `postCogsLedger` (backend/services/productionService.cjs)

```javascript
async postCogsLedger(workOrder, currency = 'USD') {
    const accounts = await repo.accounts.getAll({ 'data->>type': 'eq.expense' });
    const cogsAccount = accounts.find((a) => {
        const d = a.data || a;
        const name = String(d.name || '').toLowerCase();
        return name.includes('cogs') || name.includes('cost of goods') || d.code === '51200';
    });
    const assetAccounts = await repo.accounts.getAll({ 'data->>type': 'eq.asset' });
    const wipAccount = assetAccounts.find((a) => {
        const d = a.data || a;
        const name = String(d.name || '').toLowerCase();
        return name.includes('wip') || name.includes('work in progress');
    });
    // ... posts DR COGS / CR WIP
}
```

**Issues:**
- Same name-search fragility.
- If WIP account not found, silently returns (no COGS posted either — silent failure).
- No link to the specific work order's output item or FG account.
- Does not verify that the work order actually produced inventory-bearing output.

---

## 6. Frontend `completeWorkOrder` Reference (line ~5230)

```typescript
async completeWorkOrder(orderId: string, consumedMaterials: ...) {
    // 1. Update status
    wo.status = 'Completed';
    wo.endDate = new Date().toISOString();
    await woStore.put(wo);

    // 2. Consume Materials (BOM) — stock-bearing inputs only.
    for (const mat of consumedMaterials) {
        const item = await invStore.get(mat.materialId);
        if (item && isInventoryBearingItem(item)) {
            item.stock -= mat.quantity;
            await invStore.put(item);
            // DR COGS / CR Inventory for material cost
            const entry: LedgerEntry = { ... };
            await ledgerStore.put(entry);
        }
    }

    // 3. Production output: only a stock-bearing item is added to stock.
    const product = await invStore.get(wo.productId);
    if (product && isInventoryBearingItem(product)) {
        product.stock += qtyProduced;
        // update normalizedCP weighted average
        await invStore.put(product);
    }
    // NO FG GL ENTRY CREATED HERE
}
```

**What is missing:**
- No WIP account used.
- No Finished Goods GL entry for the output.
- No link between material consumption and FG output in the GL.
- Backend `postWipLedger` / `postCogsLedger` are never called from the frontend flow.

---

## 7. Recommendation

**DO NOT implement Finished Goods accounting until:**

1. The intended accounting model (A/B/C/D above) is formally selected and documented.
2. The WIP account (if needed) is defined in `getGLConfig` with a canonical code.
3. Account resolution uses canonical codes (e.g., `11420`, `11430`, `51200`) via `resolveAccountForPosting`, not name search.
4. The production flow (frontend `completeWorkOrder`) is updated to call the production accounting functions **only after** the model is approved.
5. Tests are written that verify:
   - Non-inventory-bearing Products do NOT generate COGS/Inventory entries.
   - Inventory-bearing items follow the selected model correctly.
   - No production accounting is invented merely because 11430 exists.

---

## 8. Constraints

Per project rules:
- **Never silently fall back to raw unresolved account reference.**
- **Non-inventory-bearing Products must NOT generate DR COGS / CR Inventory.**
- **Finished Goods must NOT receive production accounting unless a real production accounting workflow exists.**
- **Do NOT invent production accounting merely because 11430 exists.**

This documentation is filed so that the gap is visible, traceable, and gated — not to trigger premature implementation.

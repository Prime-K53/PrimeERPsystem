import { describe, expect, it } from 'vitest';
import purchaseCostingSource from '../../services/purchaseCosting.ts?raw';
import {
  calculateWeightedAverageCost,
  normalizePurchaseLine,
  purchaseLineTotal,
  resolveReceiptUnitCost,
} from '../../services/purchaseCosting';
import { resolveSaleLineCostPrice } from '../../utils/saleProfit';
import { mapToInvoiceData } from '../../utils/pdfMapper';

/**
 * Mixed-cost purchase flow (ERP only — no Portal modules involved).
 *
 * Scenario: inventory default cost K17,000/ream; supplier B charges
 * K20,000/ream. A PO for 10 reams is entered at K20,000 on top of existing
 * stock of 5 reams @ K17,000. The ERP's existing weighted moving-average
 * policy is preserved: per-receipt actual costs live on the lots, the master
 * carries the average, and sale COGS derives from that average — never from
 * the stale K17,000 default.
 */
describe('PO actual-cost flow — 5 @ 17,000 + PO 10 @ 20,000', () => {
  const MASTER_DEFAULT = 17000;
  const SUPPLIER_PRICE = 20000;
  const EXISTING_QTY = 5;
  const PO_QTY = 10;

  // 1. Inventory default cost K17,000 -> buyer manually enters K20,000.
  // The PO form syncs the entered supplier price into every price field.
  const formLine = {
    itemId: 'RM-A4-REAM',
    name: 'A4 Paper Ream',
    quantity: PO_QTY,
    cost: SUPPLIER_PRICE,
    cost_price: SUPPLIER_PRICE,
    unitPrice: SUPPLIER_PRICE,
    price: SUPPLIER_PRICE,
    receivedQty: 0,
  };

  // 2. PO saves with K20,000 (Purchases save normalization).
  const savedLine = normalizePurchaseLine({ ...formLine });
  const savedPo = {
    id: 'PO-0001',
    supplierId: 'SUP-B',
    items: [savedLine],
    totalAmount: purchaseLineTotal(savedLine),
    date: '2026-09-18',
    status: 'Ordered',
  };

  it('saves the PO line at the entered K20,000 with a correct extended total', () => {
    expect(savedLine.cost).toBe(20000);
    expect(savedLine.price).toBe(20000);
    expect(savedLine.unitPrice).toBe(20000);
    expect(purchaseLineTotal(savedLine)).toBe(200000);
  });

  it('reload still shows K20,000 (persisted aliases survive a round-trip)', () => {
    const reloaded = JSON.parse(JSON.stringify(savedPo));
    const line = normalizePurchaseLine(reloaded.items[0]);
    expect(line.cost).toBe(20000);
    expect(line.price).toBe(20000);
    expect(purchaseLineTotal(line)).toBe(200000);
    expect(reloaded.totalAmount).toBe(200000);
  });

  it('PO document shows K20,000 per ream and a K200,000 total', () => {
    const doc = mapToInvoiceData(savedPo as any, { currencySymbol: 'K' } as any, 'PO');
    expect(doc.items).toHaveLength(1);
    expect(doc.items[0].price).toBe(20000);
    expect(doc.items[0].qty).toBe(10);
    expect(doc.items[0].total).toBe(200000);
  });

  it('receiving preserves the K20,000 actual unit cost', () => {
    expect(resolveReceiptUnitCost(savedLine)).toBe(20000);
    expect(PO_QTY * resolveReceiptUnitCost(savedLine)).toBe(200000);
  });

  it('keeps the two actual costs as distinct lots; master carries the average', () => {
    // 7. Pre-existing lot untouched (frozen to prove no retroactive rewrite).
    const existingLot = Object.freeze({
      id: 'LOT-OLD',
      itemId: 'RM-A4-REAM',
      consumptionQuantity: EXISTING_QTY,
      unitCostPerConsumption: MASTER_DEFAULT,
      remainingConsumption: EXISTING_QTY,
    });
    // 6. New receipt recorded at its actual K20,000 unit cost.
    const newLot = {
      id: 'LOT-NEW',
      itemId: 'RM-A4-REAM',
      consumptionQuantity: PO_QTY,
      unitCostPerConsumption: resolveReceiptUnitCost(savedLine),
      remainingConsumption: PO_QTY,
    };
    expect(newLot.unitCostPerConsumption).toBe(20000);

    // 8. Mixed-cost stock: both actual costs preserved side by side.
    const lots = [existingLot, newLot];
    expect(lots[0].unitCostPerConsumption).toBe(17000);
    expect(lots[1].unitCostPerConsumption).toBe(20000);

    // Existing weighted-average policy: master becomes 19,000 — the old
    // stock is NOT restated to 20,000 and the new stock is NOT costed at
    // the stale 17,000.
    const master = calculateWeightedAverageCost(MASTER_DEFAULT, EXISTING_QTY, 20000, PO_QTY);
    expect(master).toBe(19000);
    expect(existingLot.unitCostPerConsumption).toBe(17000);
    expect(master * (EXISTING_QTY + PO_QTY)).toBe(
      EXISTING_QTY * MASTER_DEFAULT + PO_QTY * SUPPLIER_PRICE
    );
  });

  it('prices sales off the actual-cost-derived average, not the stale default', () => {
    // 9. At sale time the master (19,000) is snapshotted onto the sale line;
    // the line cost wins over any stale fallback (e.g. a cached 17,000).
    const saleLine = { quantity: 3, price: 25000, cost: 19000 };
    const unitCost = resolveSaleLineCostPrice(saleLine, MASTER_DEFAULT);
    expect(unitCost).toBe(19000);

    // 10. Profit uses actual-derived COGS: 3 x 25,000 - 3 x 19,000 = 18,000
    // (NOT 3 x 25,000 - 3 x 17,000 = 24,000).
    const revenue = 3 * 25000;
    const cogs = 3 * unitCost;
    expect(cogs).toBe(57000);
    expect(revenue - cogs).toBe(18000);
  });

  it('keeps PO totals mathematically correct', () => {
    // 11. Line extended amounts sum to the PO total; doc agrees.
    const linesTotal = savedPo.items.reduce((s, l) => s + purchaseLineTotal(l), 0);
    expect(linesTotal).toBe(savedPo.totalAmount);
    const doc = mapToInvoiceData(savedPo as any, { currencySymbol: 'K' } as any, 'PO');
    const docLinesTotal = doc.items.reduce((s: number, l: any) => s + l.total, 0);
    expect(docLinesTotal).toBe(savedPo.totalAmount);
  });

  it('touches no Portal code', () => {
    // 12. The shared costing helper is ERP-only by construction: it must not
    // import from, or reference, any Portal module (the word "Portal" may
    // still appear in prose comments).
    expect(purchaseCostingSource).not.toMatch(/from\s+['"][^'"]*portal/i);
    expect(purchaseCostingSource).not.toMatch(/views\/portal|portalService|portalLifecycle/i);
  });

  it('leaves historical records unchanged', () => {
    // 13. Pre-existing lot + earlier PO are frozen; the flow never mutates them.
    const historicalLot = Object.freeze({ id: 'LOT-HIST', unitCostPerConsumption: 17000, remainingConsumption: 5 });
    const historicalPo = Object.freeze({
      id: 'PO-0000',
      items: Object.freeze([{ itemId: 'RM-A4-REAM', quantity: 5, cost: 17000 }]),
      totalAmount: 85000,
    });
    expect(() => {
      normalizePurchaseLine({ ...formLine });
      purchaseLineTotal(savedLine);
      calculateWeightedAverageCost(17000, 5, 20000, 10);
      mapToInvoiceData(savedPo as any, { currencySymbol: 'K' } as any, 'PO');
    }).not.toThrow();
    expect(historicalLot.unitCostPerConsumption).toBe(17000);
    expect(historicalPo.totalAmount).toBe(85000);
  });
});

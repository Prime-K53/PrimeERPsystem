/**
 * pricingDisplayConsistency.test.ts — Invoice Financial panel and Order Form
 * display the SAME authoritative cost/profit for the same sale.
 *
 * Authoritative source (established consensus: POS + Order Form + View
 * Details modal via utils/saleProfit.ts):
 *   lineCost   = quantity x CP   (CP = cost/cost_price/costPrice/unitCost)
 *   lineProfit = lineRevenue - lineCost   (OrderItem netted totals respected)
 *   profit     = sum(lineProfit) - unallocated document discount
 *
 * Root cause fixed here (INV-P726/023 drilling): OrderForm stamps
 * basePrice = SP at add time; pricingBreakdown derived baseMaterialCost
 * from basePrice ahead of CP, fossilized it on saved lines/roots, and the
 * panel trusted it — K129,854 of selling price displayed as material cost.
 *
 * Presentation/data-source consistency only. No accounting, ledger, payment,
 * database, Portal, or backend-posting behavior is touched by these tests.
 */
import { describe, expect, it } from 'vitest';
import {
  isStalePricingBreakdown,
  resolveTransactionPricingSummary,
} from '../../utils/pricingBreakdown';
import {
  calculateTransactionProfit,
  resolveSaleLineCostPrice,
} from '../../utils/saleProfit';

// ─── Shared authoritative accessors (what both views must consume) ────
const orderFormCost = (items: any[]) =>
  items.reduce((s, l) => s + resolveSaleLineCostPrice(l, 0) * Number(l.quantity || 0), 0);

const orderFormProfit = (tx: any) => calculateTransactionProfit(tx);

const panelCost = (tx: any) => resolveTransactionPricingSummary(tx).materialTotal;
const panelProfit = (tx: any) => resolveTransactionPricingSummary(tx).profitMarginTotal;

const expectViewsAgree = (tx: any) => {
  expect(panelCost(tx)).toBe(orderFormCost(tx.items));
  expect(panelProfit(tx)).toBe(orderFormProfit(tx));
  for (const v of [panelCost(tx), panelProfit(tx)]) {
    expect(Number.isFinite(v)).toBe(true);
  }
};

describe('pricing display consistency (Invoice Financial == Order Form)', () => {
  it('1. simple sale: CP=100 SP=150 qty=1 -> cost 100 profit 50', () => {
    const tx = { items: [{ price: 150, cost: 100, quantity: 1 }], totalAmount: 150, discount: 0 };
    expect(orderFormCost(tx.items)).toBe(100);
    expect(orderFormProfit(tx)).toBe(50);
    expectViewsAgree(tx);
  });

  it('2. multiple quantity: CP=100 SP=150 qty=10 -> cost 1000 profit 500', () => {
    const tx = { items: [{ price: 150, cost: 100, quantity: 10 }], totalAmount: 1500, discount: 0 };
    expect(orderFormCost(tx.items)).toBe(1000);
    expect(orderFormProfit(tx)).toBe(500);
    expectViewsAgree(tx);
  });

  it('3. multiple line items agree across both views', () => {
    const tx = {
      items: [
        { price: 4000, cost: 2800, quantity: 20 },
        { price: 6500, cost: 4800, quantity: 6 },
        { price: 20000, cost: 16800, quantity: 2 },
      ],
      totalAmount: 152000,
      discount: 0,
    };
    expect(orderFormCost(tx.items)).toBe(20 * 2800 + 6 * 4800 + 2 * 16800);
    expectViewsAgree(tx);
  });

  it('4a. fixed document discount reduces profit identically in both views', () => {
    const tx = {
      items: [
        { price: 4000, cost: 2800, quantity: 20 },
        { price: 6500, cost: 4800, quantity: 6 },
      ],
      totalAmount: 119000,
      discount: 5000,
      discountType: 'fixed',
    };
    // Order-Form rule: line economics minus the unallocated document discount.
    expect(orderFormProfit(tx)).toBe((80000 - 56000) + (39000 - 28800) - 5000);
    expectViewsAgree(tx);
    // Cost is unaffected by discount in both views.
    expect(panelCost(tx)).toBe(orderFormCost(tx.items));
  });

  it('4b. percentage document discount stays consistent', () => {
    const gross = 80000 + 39000;
    const tx = {
      items: [
        { price: 4000, cost: 2800, quantity: 20 },
        { price: 6500, cost: 4800, quantity: 6 },
      ],
      totalAmount: gross - 0.1 * gross,
      // Persisted orders store the computed discount amount.
      discount: 0.1 * gross,
      discountType: 'percentage',
    };
    expectViewsAgree(tx);
    expect(panelProfit(tx)).toBe(orderFormProfit(tx));
  });

  it('5. market adjustment shown separately; profit consistent', () => {
    const tx = {
      items: [
        {
          price: 500, cost: 300, quantity: 2,
          adjustmentSnapshots: [{ id: 'transport', name: 'Transport', type: 'FIXED', calculatedAmount: 50 }],
        },
      ],
      totalAmount: 1100,
      discount: 0,
    };
    const summary = resolveTransactionPricingSummary(tx);
    expect(summary.adjustmentTotal).toBe(100);
    expectViewsAgree(tx);
    expect(panelProfit(tx)).toBe(2 * (500 - 300));
  });

  it('6. rounding affects rounding tile only, never cost/profit', () => {
    const tx = {
      items: [{ price: 500, cost: 300, quantity: 2, roundingDifference: 0.4 }],
      totalAmount: 1000.8,
      discount: 0,
    };
    const summary = resolveTransactionPricingSummary(tx);
    expect(summary.roundingTotal).toBeCloseTo(0.8, 5);
    expectViewsAgree(tx);
    expect(panelCost(tx)).toBe(600);
    expect(panelProfit(tx)).toBe(400);
  });

  it('7. zero/edge values: no NaN, undefined, or Infinity', () => {
    const tx = {
      items: [
        { price: 500, cost: 0, quantity: 2 },          // zero cost
        { price: 400, cost: 400, quantity: 3 },        // zero profit
        {
          price: 500, cost: 300, quantity: 1,          // negative adjustment
          adjustmentSnapshots: [{ id: 'promo', name: 'Promo', type: 'FIXED', calculatedAmount: -50 }],
        },
      ],
      totalAmount: 2700,
      discount: 0,
    };
    const summary = resolveTransactionPricingSummary(tx);
    for (const v of [summary.materialTotal, summary.adjustmentTotal, summary.profitMarginTotal, summary.roundingTotal]) {
      expect(typeof v).toBe('number');
      expect(Number.isFinite(v)).toBe(true);
    }
    expectViewsAgree(tx);
    expect(panelCost(tx)).toBe(0 * 2 + 400 * 3 + 300 * 1);
  });

  it('8. K575,500 sale (INV-P726/023 pattern): panel matches Order Form from the authoritative source', () => {
    // Line shapes reconstructed from the live record: persisted
    // pricingBreakdowns derived from stale basePrice (= SP at add time),
    // current prices (two lines edited after add), stable CPs, stored roots
    // materialTotal 512300 / profitMarginTotal 63200, discount 0.
    // Expected values are COMPUTED via saleProfit (the authoritative
    // source), never hard-coded: they equal the Order Form's Cost/Profit.
    const items = [
      { name: 'Chalk (box)', quantity: 40, price: 4000, unitPrice: 4000, cost: 2800, discount: 0, lineTotalNet: 160000, pricingBreakdown: { baseMaterialCost: 2800, costPrice: 2800, sellingPrice: 4000, profitAmount: 1200, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'A4 Hardcover', quantity: 6, price: 6500, unitPrice: 6500, cost: 4800, discount: 0, lineTotalNet: 39000, pricingBreakdown: { baseMaterialCost: 4800, costPrice: 4800, sellingPrice: 6500, profitAmount: 1700, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Office Paste', quantity: 3, price: 6500, unitPrice: 6500, cost: 4800, discount: 0, lineTotalNet: 19500, pricingBreakdown: { baseMaterialCost: 4800, costPrice: 4800, sellingPrice: 6500, profitAmount: 1700, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'A4 Plain Paper', quantity: 2, price: 20000, unitPrice: 20000, cost: 16800, discount: 0, lineTotalNet: 40000, pricingBreakdown: { baseMaterialCost: 16800, costPrice: 16800, sellingPrice: 20000, profitAmount: 3200, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Stapler machine', quantity: 1, price: 20000, unitPrice: 20000, cost: 16500, discount: 0, lineTotalNet: 20000, pricingBreakdown: { baseMaterialCost: 16500, costPrice: 16500, sellingPrice: 20000, profitAmount: 3500, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Student Management Journal', quantity: 12, price: 7000, unitPrice: 7000, cost: 3173.5, basePrice: 7000, discount: 0, lineTotalNet: 84000, pricingBreakdown: { baseMaterialCost: 7000, costPrice: 7000, sellingPrice: 7000, profitAmount: 0, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Bic Pens Original', quantity: 2, price: 46000, unitPrice: 45000, cost: 36000, basePrice: 45000, discount: 0, lineTotalNet: 92000, pricingBreakdown: { baseMaterialCost: 45000, costPrice: 45000, sellingPrice: 46000, profitAmount: 1000, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Fly paper', quantity: 1, price: 23000, unitPrice: 23000, cost: 17000, basePrice: 23000, discount: 0, lineTotalNet: 23000, pricingBreakdown: { baseMaterialCost: 23000, costPrice: 23000, sellingPrice: 23000, profitAmount: 0, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Lesson Plan', quantity: 12, price: 5000, unitPrice: 6000, cost: 2172, basePrice: 6000, discount: 0, lineTotalNet: 60000, pricingBreakdown: { baseMaterialCost: 6000, costPrice: 6000, sellingPrice: 5000, profitAmount: -1000, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Flip chart', quantity: 2, price: 14000, unitPrice: 14000, cost: 9500, basePrice: 14000, discount: 0, lineTotalNet: 28000, pricingBreakdown: { baseMaterialCost: 14000, costPrice: 14000, sellingPrice: 14000, profitAmount: 0, adjustmentTotal: 0, roundingDifference: 0 } },
      { name: 'Staples 26/6', quantity: 2, price: 5000, unitPrice: 5000, cost: 2500, basePrice: 5000, discount: 0, lineTotalNet: 10000, pricingBreakdown: { baseMaterialCost: 5000, costPrice: 5000, sellingPrice: 5000, profitAmount: 0, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const tx: any = {
      items,
      totalAmount: 575500,
      discount: 0,
      materialTotal: 512300,      // stale persisted roots (as saved)
      profitMarginTotal: 63200,
      adjustmentTotal: 0,
      roundingTotal: 0,
    };

    // The six SP-sourced lines are detected as poisoned; the CP lines are fresh.
    expect(items.filter(isStalePricingBreakdown).length).toBe(6);

    // Authoritative expectations (computed, not hard-coded).
    const expectedCost = orderFormCost(items);
    const expectedProfit = orderFormProfit(tx);
    expect(panelCost(tx)).toBe(expectedCost);
    expect(panelProfit(tx)).toBe(expectedProfit);
    // Cross-check against the Order Form's displayed figures.
    expect(expectedCost).toBe(382446);
    expect(expectedProfit).toBe(193054);
    // Reconciliation under existing pricing rules (discount 0).
    expect(expectedCost + expectedProfit).toBe(575500);
  });

  it('add-time pattern without later edits no longer hides margin', () => {
    // Journal line as first saved (basePrice = SP, no persisted breakdown):
    // previously displayed material 84000 / profit 0.
    const tx = {
      items: [{ price: 7000, cost: 3173.5, basePrice: 7000, quantity: 12 }],
      totalAmount: 84000,
      discount: 0,
    };
    expectViewsAgree(tx);
    expect(panelCost(tx)).toBe(12 * 3173.5);
    expect(panelProfit(tx)).toBe(12 * (7000 - 3173.5));
  });
});

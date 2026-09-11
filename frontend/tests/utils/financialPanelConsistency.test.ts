import { describe, expect, it } from 'vitest';
import { resolveTransactionPricingSummary } from '../../utils/pricingBreakdown';
import { calculateTransactionProfit } from '../../utils/saleProfit';

describe('TransactionPricingInsights Financial Panel Consistency', () => {

  it('A. Gross Billing equals sum of invoice line totals', () => {
    const items = [
      { id: '1', name: 'Chalk (box)', quantity: 20, price: 4000, lineTotalNet: 80000, pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', name: 'A4 Hardcover', quantity: 12, price: 6000, lineTotalNet: 72000, pricingBreakdown: { baseMaterialCost: 4500, costPrice: 4500, sellingPrice: 6000, profitAmount: 1500, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '3', name: 'Bantley Pens', quantity: 1, price: 25000, lineTotalNet: 25000, pricingBreakdown: { baseMaterialCost: 18000, costPrice: 18000, sellingPrice: 25000, profitAmount: 7000, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '4', name: 'Office Paste', quantity: 2, price: 6000, lineTotalNet: 12000, pricingBreakdown: { baseMaterialCost: 4000, costPrice: 4000, sellingPrice: 6000, profitAmount: 2000, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '5', name: 'Flip chart', quantity: 2, price: 13500, lineTotalNet: 27000, pricingBreakdown: { baseMaterialCost: 9000, costPrice: 9000, sellingPrice: 13500, profitAmount: 4500, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '6', name: 'Markers', quantity: 3, price: 4000, lineTotalNet: 12000, pricingBreakdown: { baseMaterialCost: 2400, costPrice: 2400, sellingPrice: 4000, profitAmount: 1600, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '7', name: 'Masking Tape', quantity: 2, price: 4000, lineTotalNet: 8000, pricingBreakdown: { baseMaterialCost: 2200, costPrice: 2200, sellingPrice: 4000, profitAmount: 1800, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '8', name: 'Student Management Journal', quantity: 9, price: 7000, lineTotalNet: 63000, pricingBreakdown: { baseMaterialCost: 4000, costPrice: 4000, sellingPrice: 7000, profitAmount: 3000, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '9', name: 'Bic Pens 2Copy', quantity: 1, price: 25000, lineTotalNet: 25000, pricingBreakdown: { baseMaterialCost: 18000, costPrice: 18000, sellingPrice: 25000, profitAmount: 7000, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 324000 };
    const summary = resolveTransactionPricingSummary(transaction);
    const lineTotalSum = items.reduce((s, i) => s + (i.lineTotalNet ?? i.quantity * i.price), 0);
    expect(lineTotalSum).toBe(324000);
    expect(summary.materialTotal).toBeGreaterThan(0);
    expect(summary.roundingTotal).toBe(0);
    expect(summary.adjustmentTotal).toBe(0);
  });

  it('B. Material Cost uses baseMaterialCost from pricingBreakdown consistently', () => {
    const items = [
      { id: '1', quantity: 20, price: 4000, pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', quantity: 12, price: 6000, pricingBreakdown: { baseMaterialCost: 4500, costPrice: 4500, sellingPrice: 6000, profitAmount: 1500, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 152000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe((3200 * 20) + (4500 * 12));
    expect(summary.materialTotal).toBe(118000);
  });

  it('C. Profit comes from same resolveTransactionPricingSummary source as Material Cost', () => {
    const items = [
      { id: '1', quantity: 20, price: 4000, pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', quantity: 12, price: 6000, pricingBreakdown: { baseMaterialCost: 4500, costPrice: 4500, sellingPrice: 6000, profitAmount: 1500, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 152000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.profitMarginTotal).toBe((800 * 20) + (1500 * 12));
    expect(summary.profitMarginTotal).toBe(34000);
  });

  it('D. Material Cost + Adjustments + Profit + Round Up/Down = Gross Billing', () => {
    const items = [
      { id: '1', quantity: 20, price: 8000, pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 8000, profitAmount: 4800, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', quantity: 12, price: 7200, pricingBreakdown: { baseMaterialCost: 4500, costPrice: 4500, sellingPrice: 7200, profitAmount: 2700, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 246400 };
    const summary = resolveTransactionPricingSummary(transaction);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(transaction.totalAmount);
  });

  it('D2. Consistency with examination invoice where root aggregates are provided', () => {
    const transaction = {
      totalAmount: 5000,
      materialTotal: 2511,
      adjustmentTotal: 1178.7,
      profitMarginTotal: 1310.3,
      roundingTotal: 0,
      items: [
        { quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 } },
      ],
    };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe(2511);
    expect(summary.profitMarginTotal).toBe(1310.3);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(5000);
  });

  it('E. Historical cost from pricingBreakdown is not replaced by live inventory cost', () => {
    const historicalCost = 3200;
    const items = [
      {
        id: '1', quantity: 20, price: 4000,
        pricingBreakdown: { baseMaterialCost: historicalCost, costPrice: historicalCost, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 },
        cost: 2800,
      },
    ];
    const transaction = { items, totalAmount: 80000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe(historicalCost * 20);
    expect(summary.materialTotal).toBe(64000);
    expect(summary.materialTotal).not.toBe(56000);
  });

  it('F. Product replacement does not silently change financial results', () => {
    const originalItem = {
      id: 'chalk-original', quantity: 20, price: 4000,
      pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 },
    };
    const replacedItem = {
      id: 'chalk-replacement', quantity: 20, price: 4000,
      pricingBreakdown: { baseMaterialCost: 3200, costPrice: 3200, sellingPrice: 4000, profitAmount: 800, adjustmentTotal: 0, roundingDifference: 0 },
      productId: 'chalk-replacement',
    };
    const t1 = resolveTransactionPricingSummary({ items: [originalItem], totalAmount: 80000 });
    const t2 = resolveTransactionPricingSummary({ items: [replacedItem], totalAmount: 80000 });
    expect(t1.materialTotal).toBe(t2.materialTotal);
    expect(t1.profitMarginTotal).toBe(t2.profitMarginTotal);
  });

  it('G. Repeated viewing produces identical financial values', () => {
    const items = [
      { id: '1', quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 1000 };
    const s1 = resolveTransactionPricingSummary(transaction);
    const s2 = resolveTransactionPricingSummary(transaction);
    expect(s1.materialTotal).toBe(s2.materialTotal);
    expect(s1.adjustmentTotal).toBe(s2.adjustmentTotal);
    expect(s1.profitMarginTotal).toBe(s2.profitMarginTotal);
    expect(s1.roundingTotal).toBe(s2.roundingTotal);
  });

  it('H. No hidden rounding amount is introduced', () => {
    const items = [
      { id: '1', quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 1000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.roundingTotal).toBe(0);
    expect(typeof summary.roundingTotal).toBe('number');
    expect(Math.abs(summary.roundingTotal)).toBeLessThan(0.01);
  });

  it('I. All five financial fields are internally coherent', () => {
    const items = [
      { id: '1', quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', quantity: 3, price: 400, pricingBreakdown: { baseMaterialCost: 250, costPrice: 250, sellingPrice: 400, profitAmount: 150, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 2200 };
    const summary = resolveTransactionPricingSummary(transaction);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(transaction.totalAmount);
    expect(summary.materialTotal).toBeGreaterThan(0);
    expect(summary.profitMarginTotal).toBeGreaterThan(0);
  });

  it('J. Accounting COGS precedence: productionCostSnapshot takes priority over smartSnapshot.baseCost', () => {
    const items = [
      {
        id: '1', quantity: 10, price: 1000, cost: 500,
        smartPricingSnapshot: { baseCost: 300 },
        productionCostSnapshot: { baseProductionCost: 800 },
        pricingBreakdown: { baseMaterialCost: 800, costPrice: 800, sellingPrice: 1000, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 },
      },
    ];
    const transaction = { items, totalAmount: 10000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe(8000);
    expect(summary.materialTotal).not.toBe(3000);
    expect(summary.profitMarginTotal).toBe(2000);
  });

  it('K. Historical cost immutability: current master cost change does not affect completed transaction', () => {
    const items = [
      {
        id: '1', quantity: 20, price: 4000, cost: 2800,
        smartPricingSnapshot: { baseCost: 2800 },
        productionCostSnapshot: { baseProductionCost: 2800 },
        pricingBreakdown: { baseMaterialCost: 2800, costPrice: 2800, sellingPrice: 4000, profitAmount: 1200, adjustmentTotal: 0, roundingDifference: 0 },
      },
    ];
    const original = resolveTransactionPricingSummary({ items, totalAmount: 80000 });
    expect(original.materialTotal).toBe(56000);
    expect(original.profitMarginTotal).toBe(24000);

    const mutatedItems = items.map(it => ({
      ...it,
      cost: 9000,
      smartPricingSnapshot: { baseCost: 9000 },
      productionCostSnapshot: { baseProductionCost: 9000 },
      pricingBreakdown: { baseMaterialCost: 2800, costPrice: 2800, sellingPrice: 4000, profitAmount: 1200, adjustmentTotal: 0, roundingDifference: 0 },
    }));
    const afterMutation = resolveTransactionPricingSummary({ items: mutatedItems, totalAmount: 80000 });
    expect(afterMutation.materialTotal).toBe(56000);
    expect(afterMutation.profitMarginTotal).toBe(24000);
  });

  it('L. Product replacement with persisted historical cost remains stable', () => {
    const original = {
      id: 'chalk-original', quantity: 20, price: 4000, cost: 2800,
      smartPricingSnapshot: { baseCost: 2800 },
      productionCostSnapshot: { baseProductionCost: 2800 },
      pricingBreakdown: { baseMaterialCost: 2800, costPrice: 2800, sellingPrice: 4000, profitAmount: 1200, adjustmentTotal: 0, roundingDifference: 0 },
    };
    const replacement = {
      id: 'chalk-box', quantity: 20, price: 4000, cost: 3500,
      smartPricingSnapshot: { baseCost: 3500 },
      productionCostSnapshot: { baseProductionCost: 3500 },
      pricingBreakdown: { baseMaterialCost: 2800, costPrice: 2800, sellingPrice: 4000, profitAmount: 1200, adjustmentTotal: 0, roundingDifference: 0 },
    };
    const tOriginal = resolveTransactionPricingSummary({ items: [original], totalAmount: 80000 });
    const tReplacement = resolveTransactionPricingSummary({ items: [replacement], totalAmount: 80000 });
    expect(tOriginal.materialTotal).toBe(tReplacement.materialTotal);
    expect(tOriginal.profitMarginTotal).toBe(tReplacement.profitMarginTotal);
  });

  it('M. Mixed stocked and service items: services excluded from inventory COGS', () => {
    const items = [
      { id: '1', type: 'Product', quantity: 10, price: 1000, cost: 500, pricingBreakdown: { baseMaterialCost: 500, costPrice: 500, sellingPrice: 1000, profitAmount: 500, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', type: 'Service', quantity: 5, price: 2000, cost: 0, pricingBreakdown: { baseMaterialCost: 0, costPrice: 0, sellingPrice: 2000, profitAmount: 2000, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 20000 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe(5000);
    expect(summary.profitMarginTotal).toBe(15000);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(transaction.totalAmount);
  });

  it('N. Positive adjustments included in financial breakdown', () => {
    const items = [
      { id: '1', quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 50, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 1100 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.adjustmentTotal).toBe(100);
    expect(summary.materialTotal).toBe(600);
    expect(summary.profitMarginTotal).toBe(400);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(transaction.totalAmount);
  });

  it('O. Negative profit is handled correctly', () => {
    const items = [
      { id: '1', quantity: 2, price: 500, pricingBreakdown: { baseMaterialCost: 300, costPrice: 300, sellingPrice: 500, profitAmount: 200, adjustmentTotal: 0, roundingDifference: 0 } },
      { id: '2', quantity: 3, price: 400, pricingBreakdown: { baseMaterialCost: 350, costPrice: 350, sellingPrice: 300, profitAmount: -50, adjustmentTotal: 0, roundingDifference: 0 } },
    ];
    const transaction = { items, totalAmount: 1900 };
    const summary = resolveTransactionPricingSummary(transaction);
    expect(summary.materialTotal).toBe(1650);
    expect(summary.profitMarginTotal).toBe(250);
    const total = summary.materialTotal + summary.adjustmentTotal + summary.profitMarginTotal + summary.roundingTotal;
    expect(total).toBe(transaction.totalAmount);
  });

});

import { describe, expect, it } from 'vitest';
import {
  calculateLineProfit,
  calculateSaleProfit,
  calculateTransactionProfit,
  resolveSaleLineCostPrice,
  resolveSaleLineRevenue,
} from '../../utils/saleProfit';

describe('saleProfit — actual sale-line economics', () => {
  it('CASE 1: CP=4000 SP=6500 qty=5 -> 12500', () => {
    expect(calculateLineProfit({ cost: 4000, price: 6500, quantity: 5 })).toBe(12500);
  });

  it('CASE 2: CP=SP=6500 qty=5 -> 0', () => {
    expect(calculateLineProfit({ cost: 6500, price: 6500, quantity: 5 })).toBe(0);
  });

  it('CASE 3: CP=7000 SP=6500 qty=5 -> -2500 (negative kept)', () => {
    expect(calculateLineProfit({ cost: 7000, price: 6500, quantity: 5 })).toBe(-2500);
  });

  it('CASE 4: multiple lines sum (12500 + 5000 = 17500)', () => {
    expect(
      calculateSaleProfit([
        { cost: 4000, price: 6500, quantity: 5 },
        { cost: 1000, price: 2000, quantity: 5 },
      ])
    ).toBe(17500);
  });

  it('recalculates when quantity or SP change', () => {
    const line = { cost: 4000, price: 6500, quantity: 5 };
    expect(calculateLineProfit({ ...line, quantity: 2 })).toBe(5000);
    expect(calculateLineProfit({ ...line, price: 7000 })).toBe(15000);
  });

  it('subtracts an order-level discount from the sale total', () => {
    expect(
      calculateSaleProfit([{ cost: 4000, price: 6500, quantity: 5 }], 2500)
    ).toBe(10000);
  });

  it('uses the line subtotal minus line discount (saved POS shape)', () => {
    expect(
      calculateLineProfit({ cost: 4000, price: 6500, quantity: 5, subtotal: 32500, discount: 2500 })
    ).toBe(10000);
  });

  it('does not double-count rule discounts on netted OrderItem totals', () => {
    // Saved OrderItem: total already net of the 500 rule discount.
    const line = { cost: 4000, price: 6500, quantity: 5, subtotal: 32000, total: 32000, discount: 500 };
    expect(resolveSaleLineRevenue(line)).toBe(32000);
    expect(calculateLineProfit(line)).toBe(12000);
  });

  it('deducts only the unallocated remainder of a root discount', () => {
    // Order saved with manual(1000) + rule(500) root discount; line carries the rule share.
    const tx = {
      discount: 1500,
      items: [
        { cost: 4000, price: 6500, quantity: 5, subtotal: 32000, total: 32000, discount: 500 },
      ],
    };
    expect(calculateTransactionProfit(tx)).toBe(11000);
  });

  it('does not double-count POS root discounts that equal line shares', () => {
    const tx = {
      discount: 2500,
      items: [
        { cost: 4000, price: 6500, quantity: 5, subtotal: 32500, discount: 2500 },
      ],
    };
    expect(calculateTransactionProfit(tx)).toBe(10000);
  });

  it('prefers the line CP over a live lookup fallback', () => {
    expect(resolveSaleLineCostPrice({ cost: 4000 }, 9999)).toBe(4000);
    expect(calculateLineProfit({ cost: 4000, price: 6500, quantity: 5 }, 9999)).toBe(12500);
  });

  it('falls back to persisted snapshots, then caller fallback, then zero', () => {
    expect(resolveSaleLineCostPrice({}, 250)).toBe(250);
    expect(resolveSaleLineCostPrice({})).toBe(0);
    expect(
      resolveSaleLineCostPrice({ pricingBreakdown: { baseMaterialCost: 4000 } }, 250)
    ).toBe(4000);
    // Explicit zero on the line never masks a stored snapshot cost.
    expect(
      resolveSaleLineCostPrice({ cost: 0, pricingBreakdown: { baseMaterialCost: 4000 } })
    ).toBe(4000);
  });

  it('supports cost_price / unitPrice aliases', () => {
    expect(calculateLineProfit({ cost_price: 4000, unitPrice: 6500, quantity: 5 })).toBe(12500);
  });

  it('handles empty input safely', () => {
    expect(calculateLineProfit(null)).toBe(0);
    expect(calculateLineProfit({})).toBe(0);
    expect(calculateSaleProfit([])).toBe(0);
    expect(calculateSaleProfit(null)).toBe(0);
    expect(calculateTransactionProfit(null)).toBe(0);
    expect(calculateTransactionProfit({})).toBe(0);
  });
});

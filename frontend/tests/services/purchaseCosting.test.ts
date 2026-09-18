import { describe, expect, it } from 'vitest';
import {
  calculateWeightedAverageCost,
  normalizePurchaseLine,
  purchaseLineTotal,
  resolvePoLineQuantity,
  resolvePoLineUnitCost,
  resolveReceiptUnitCost,
} from '../../services/purchaseCosting';

describe('purchaseCosting — PO actual purchase price resolution', () => {
  it('uses the line cost when all aliases agree (saved PO: 10 reams @ K20,000)', () => {
    const line = { quantity: 10, cost: 20000, cost_price: 20000, unitPrice: 20000, price: 20000 };
    expect(resolvePoLineUnitCost(line)).toBe(20000);
    expect(purchaseLineTotal(line)).toBe(200000);
  });

  it('never lets a display price shadow a recorded cost; save syncs the entered price', () => {
    // A recorded cost always wins over display `price` (which may embed
    // margin), so resolution can never silently swap in a selling price.
    expect(resolvePoLineUnitCost({ cost: 17000, price: 20000 })).toBe(17000);
    // The PO form therefore syncs the buyer-entered supplier price into the
    // cost fields at edit time; the save path then persists 20,000.
    const formSynced = { quantity: 10, cost: 20000, price: 20000 };
    const normalized = normalizePurchaseLine(formSynced);
    expect(normalized.cost).toBe(20000);
    expect(normalized.price).toBe(20000);
    expect(normalized.unitPrice).toBe(20000);
    expect(normalized.cost_price).toBe(20000);
    expect(purchaseLineTotal(normalized)).toBe(200000);
  });

  it('prefers recorded cost aliases over a margin-bearing display price', () => {
    // Sales-side `price` may embed margin; the recorded purchase `cost` wins.
    expect(resolvePoLineUnitCost({ cost: 20000, price: 25000, quantity: 1 })).toBe(20000);
    expect(resolvePoLineUnitCost({ cost_price: 20000, price: 25000 })).toBe(20000);
    expect(resolvePoLineUnitCost({ unitPrice: 20000, price: 25000 })).toBe(20000);
  });

  it('falls back to price for legacy lines that only carry a price', () => {
    expect(resolvePoLineUnitCost({ price: 20000, quantity: 2 })).toBe(20000);
    expect(purchaseLineTotal({ price: 20000, quantity: 2 })).toBe(40000);
  });

  it('resolves zero for empty/non-object lines (never NaN)', () => {
    expect(resolvePoLineUnitCost(null)).toBe(0);
    expect(resolvePoLineUnitCost(undefined)).toBe(0);
    expect(resolvePoLineUnitCost({})).toBe(0);
    expect(resolvePoLineUnitCost({ cost: 0, price: 0 })).toBe(0);
    expect(purchaseLineTotal(null)).toBe(0);
  });

  it('ignores non-positive and non-numeric values', () => {
    expect(resolvePoLineUnitCost({ cost: -5, price: 20000 })).toBe(20000);
    expect(resolvePoLineUnitCost({ cost: 'abc', price: 20000 })).toBe(20000);
    expect(resolvePoLineQuantity({ quantity: -3 })).toBe(0);
    expect(resolvePoLineQuantity({ qty: 10 })).toBe(10);
  });

  it('receiving uses the same PO actual-cost rule', () => {
    const poLine = { quantity: 10, cost: 20000, unitPrice: 20000, price: 20000 };
    expect(resolveReceiptUnitCost(poLine)).toBe(20000);
  });

  it('normalizePurchaseLine preserves non-price fields and item identity', () => {
    const line = { itemId: 'RM-REAM', name: 'A4 Ream', quantity: 10, unit: 'ream', cost: 20000, receivedQty: 4 };
    const normalized = normalizePurchaseLine(line);
    expect(normalized.itemId).toBe('RM-REAM');
    expect(normalized.name).toBe('A4 Ream');
    expect(normalized.unit).toBe('ream');
    expect(normalized.receivedQty).toBe(4);
    expect(normalized.cost).toBe(20000);
  });
});

describe('purchaseCosting — weighted moving-average carrying cost', () => {
  it('averages existing 5 @ 17,000 with received 10 @ 20,000 to 19,000', () => {
    expect(calculateWeightedAverageCost(17000, 5, 20000, 10)).toBe(19000);
  });

  it('takes the receipt cost in full when there is no prior stock', () => {
    expect(calculateWeightedAverageCost(17000, 0, 20000, 10)).toBe(20000);
    expect(calculateWeightedAverageCost(0, 0, 20000, 10)).toBe(20000);
  });

  it('leaves the carrying cost unchanged when nothing is received', () => {
    expect(calculateWeightedAverageCost(17000, 5, 20000, 0)).toBe(17000);
  });

  it('never restates old stock to the new price (no global overwrite)', () => {
    const averaged = calculateWeightedAverageCost(17000, 5, 20000, 10);
    expect(averaged).not.toBe(20000);
    expect(averaged).not.toBe(17000);
    // Existing 5 reams still valued at 17,000 inside the average:
    // (5 x 17,000 + 10 x 20,000) / 15 = 19,000.
    expect(averaged * 15).toBe(5 * 17000 + 10 * 20000);
  });
});

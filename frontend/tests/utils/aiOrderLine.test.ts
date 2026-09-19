import { describe, expect, it } from 'vitest';
import {
  buildAiOrderFormLine,
  matchAiLineToProduct,
  withManualUnitPrice,
} from '../../utils/aiOrderLine';
import {
  calculateLineProfit,
  calculateSaleProfit,
  resolveSaleLineCostPrice,
  resolveSaleLineRevenue,
} from '../../utils/saleProfit';
import { resolveStoredCost, resolveStoredSellingPrice } from '../../utils/pricing';

const NOW = 1720000000000;

const standardProduct = {
  id: 'P1',
  name: 'Scheme Pad',
  sku: 'SP-001',
  cost: 100,
  price: 150,
  type: 'Product',
  category: 'Stationery',
};

// Canonical CP/SP stored under alternate aliases only.
const aliasProduct = {
  id: 'P2',
  name: 'A4 Paper',
  sku: 'A4-001',
  cost_price: 100,
  selling_price: 150,
  type: 'Product',
  category: 'Stationery',
};

const camelProduct = {
  id: 'P3',
  name: 'Blue Pen',
  sku: 'BP-001',
  costPrice: 100,
  sellingPrice: 150,
  type: 'Product',
  category: 'Stationery',
};

const unpricedMaster = {
  id: 'P4',
  name: 'Custom Banner',
  sku: 'CB-001',
  cost: 100,
  price: 0,
  type: 'Product',
  category: 'Printing',
};

const INVENTORY = [standardProduct, aliasProduct, camelProduct, unpricedMaster] as any;

describe('aiOrderLine — AI Invoice to Order Form canonical pricing state', () => {
  it('TEST 1 — AI matched product resolves authoritative CP and SP', () => {
    // AI carries no price (the reported 0/missing case).
    const line = buildAiOrderFormLine(
      { description: 'scheme pads', quantity: 2, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;

    expect(line.productId).toBe('P1');
    expect(line.id).toBe('P1');
    expect(line.cost).toBe(100);
    expect(line.cost_price).toBe(100);
    expect(line.price).toBe(150);
    expect(line.unitPrice).toBe(150);
    expect(line.selling_price).toBe(150);
    expect(line.quantity).toBe(2);
    expect(line.lineTotalNet).toBe(300);
    // Displayed profit: (150 - 100) * 2 = 100 via the single profit engine.
    expect(calculateLineProfit(line, 0)).toBe(100);
  });

  it('TEST 1b — matched product resolves CP/SP stored under alternate aliases', () => {
    const fromCostPrice = buildAiOrderFormLine(
      { description: 'a4 paper', quantity: 1, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(fromCostPrice.productId).toBe('P2');
    expect(fromCostPrice.cost).toBe(100);
    expect(fromCostPrice.price).toBe(150);
    expect(calculateLineProfit(fromCostPrice, 0)).toBe(50);

    const fromCamel = buildAiOrderFormLine(
      { description: 'blue pen', quantity: 1, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(fromCamel.productId).toBe('P3');
    expect(fromCamel.cost).toBe(100);
    expect(fromCamel.price).toBe(150);
  });

  it('TEST 1c — master SP wins over the AI-extracted price; AI price is fallback only', () => {
    const masterWins = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 1, unitPrice: 999, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(masterWins.price).toBe(150);

    const fallback = buildAiOrderFormLine(
      { description: 'Custom Banner', quantity: 1, unitPrice: 175, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(fallback.productId).toBe('P4');
    expect(fallback.cost).toBe(100);
    expect(fallback.price).toBe(175);
  });

  it('TEST 2 — manual SP edit keeps CP and recalculates profit from canonical state', () => {
    const line = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 2, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(line.price).toBe(150);

    const edited = withManualUnitPrice(line, 200) as any;
    expect(edited.cost).toBe(100);
    expect(edited.cost_price).toBe(100);
    expect(edited.price).toBe(200);
    // No stale alias: every canonical SP field observes the edit.
    expect(edited.unitPrice).toBe(200);
    expect(edited.selling_price).toBe(200);

    expect(resolveSaleLineRevenue(edited)).toBe(400);
    expect(resolveSaleLineCostPrice(edited, 0) * edited.quantity).toBe(200);
    expect(calculateLineProfit(edited, 0)).toBe(200);
    // Original line object is untouched (no shared-state mutation).
    expect(line.price).toBe(150);
  });

  it('TEST 3 — AI unmatched item fabricates no CP and no SP', () => {
    const line = buildAiOrderFormLine(
      { description: 'Unobtainium Widget', quantity: 3, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      1,
      NOW
    ) as any;

    expect(line.productId).toBe('');
    expect(line.cost).toBe(0);
    expect(line.price).toBe(0);
    expect(line.unitPrice).toBe(0);
    expect(line.selling_price).toBe(0);
    // No false positive/negative profit from an invalid zero price.
    expect(calculateLineProfit(line, 0)).toBe(0);
  });

  it('TEST 3b — unmatched item preserves its extracted document price (not invented)', () => {
    const line = buildAiOrderFormLine(
      { description: 'Unobtainium Widget', quantity: 2, unitPrice: 500, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    expect(line.productId).toBe('');
    expect(line.cost).toBe(0);
    expect(line.price).toBe(500);
    expect(line.lineTotalNet).toBe(1000);
  });

  it('TEST 4 — unmatched item profit recalculates immediately after manual SP entry', () => {
    const line = buildAiOrderFormLine(
      { description: 'Unobtainium Widget', quantity: 1, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;

    const priced = withManualUnitPrice(line, 250) as any;
    expect(resolveSaleLineRevenue(priced)).toBe(250);
    expect(calculateLineProfit(priced, 0)).toBe(250);

    // A second edit observes current state, never a stale price.
    const repriced = withManualUnitPrice(priced, 300) as any;
    expect(calculateLineProfit(repriced, 0)).toBe(300);
  });

  it('TEST 5 — quantity changes scale cost, revenue and profit', () => {
    const base = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 10, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;

    expect(resolveSaleLineCostPrice(base, 0) * base.quantity).toBe(1000);
    expect(resolveSaleLineRevenue(base)).toBe(1500);
    expect(calculateLineProfit(base, 0)).toBe(500);

    const doubled = { ...base, quantity: 20 };
    expect(resolveSaleLineCostPrice(doubled, 0) * doubled.quantity).toBe(2000);
    expect(resolveSaleLineRevenue(doubled)).toBe(3000);
    expect(calculateLineProfit(doubled, 0)).toBe(1000);
  });

  it('TEST 6 — decimal and string price input stays numeric (no concat/NaN/stale)', () => {
    const line = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 2, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;

    const decimal = withManualUnitPrice(line, '150.25') as any;
    expect(typeof decimal.price).toBe('number');
    expect(decimal.price).toBe(150.25);
    expect(decimal.unitPrice).toBe(150.25);
    expect(decimal.selling_price).toBe(150.25);
    expect(resolveSaleLineRevenue(decimal)).toBe(300.5);
    expect(calculateLineProfit(decimal, 0)).toBe(100.5);

    const invalid = withManualUnitPrice(line, 'abc') as any;
    expect(invalid.price).toBe(0);
    expect(Number.isFinite(calculateLineProfit(invalid, 0))).toBe(true);

    // String quantities flow through the profit engine numerically.
    const stringQty = { ...line, quantity: '2' } as any;
    expect(calculateLineProfit(stringQty, 0)).toBe(100);
  });

  it('TEST 7 — AI path and normal selection resolve identical canonical state', () => {
    for (const master of [standardProduct, aliasProduct, camelProduct]) {
      const aiLine = buildAiOrderFormLine(
        { description: (master as any).name, quantity: 1, unitPrice: 0, taxRate: 0 },
        INVENTORY,
        0,
        NOW
      ) as any;

      // Same product identity.
      expect(aiLine.productId).toBe((master as any).id);
      // Same CP resolution as the authoritative resolver used by
      // getInventoryPrices / normal product selection.
      expect(aiLine.cost).toBe(resolveStoredCost(master as any));
      // Same SP resolution as handleAddItem's storedPrice path.
      expect(aiLine.price).toBe(resolveStoredSellingPrice(master as any));
      // Same calculation behavior for the same quantity.
      const normalShaped = {
        ...(master as any),
        quantity: 1,
        price: resolveStoredSellingPrice(master as any),
      } as any;
      expect(calculateLineProfit(aiLine, 0)).toBe(calculateLineProfit(normalShaped, 0));
    }
  });

  it('TEST 8 — existing discount rules still apply without changing profit semantics', () => {
    const line = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 2, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;

    // Line-level discount reduces revenue, never cost.
    const discounted = { ...line, subtotal: 300, discount: 20 } as any;
    expect(resolveSaleLineRevenue(discounted)).toBe(280);
    expect(calculateLineProfit(discounted, 0)).toBe(80);

    // Order-level discount comes out of total profit (established rule).
    expect(calculateSaleProfit([line], 50)).toBe(50);
    expect(calculateSaleProfit([line], 0)).toBe(100);
  });

  it('matching — exact, substring and fuzzy hits; null when nothing matches', () => {
    expect(matchAiLineToProduct('Scheme Pad', INVENTORY)?.id).toBe('P1');
    expect(matchAiLineToProduct('scheme pads', INVENTORY)?.id).toBe('P1');
    expect(matchAiLineToProduct('pad', INVENTORY)?.id).toBe('P1');
    expect(matchAiLineToProduct('Totally Unknown Thing XYZ', INVENTORY)).toBeNull();
  });

  it('line identity — matched lines carry the master id, unmatched lines stay unique', () => {
    const a = buildAiOrderFormLine(
      { description: 'Scheme Pad', quantity: 1, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      0,
      NOW
    ) as any;
    const b = buildAiOrderFormLine(
      { description: 'Mystery Item', quantity: 1, unitPrice: 0, taxRate: 0 },
      INVENTORY,
      1,
      NOW
    ) as any;
    expect(a.id).toBe('P1');
    expect(b.id).toContain('AI-');
    expect(a.id).not.toBe(b.id);
  });
});

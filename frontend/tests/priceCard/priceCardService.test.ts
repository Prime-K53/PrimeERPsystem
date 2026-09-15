import { describe, it, expect } from 'vitest';
import type { Customer, Item } from '../../types';
import {
  PRICE_CARD_MAX_LINES,
  PriceCardError,
  assessPriceAvailability,
  buildPriceCardData,
  buildPriceCardFileName,
  formatPriceCardAmount,
  formatPriceCardTimestamp,
  generatePriceCardReference,
  sanitizeFileNameSegment,
  type PriceCardBusiness,
} from '../../services/priceCardService';

const BUSINESS: PriceCardBusiness = {
  name: 'Prime Printing Services',
  phone: '0992 528 222',
  address: 'Along M5 Road, Mtakataka',
  currency: 'K',
};

const makeItem = (overrides: Record<string, any> = {}): Item => ({
  id: 'ITEM-1',
  name: 'A4 Hardcover',
  sku: 'A4-HC',
  type: 'Product',
  description: 'Premium hardcover notebook',
  unit: 'piece',
  cost: 4000,
  costPrice: 4000,
  price: 6500,
  selling_price: 6500,
  sellingPrice: 6500,
  profitAmount: 2500,
  profitMargin: 38,
  minimumMargin: 10,
  pricingValidated: true,
  stock: 100,
  ...overrides,
} as unknown as Item);

const REF = 'PC-2026-0001';

describe('priceCardService — authoritative pricing reuse', () => {
  it('uses the stored selling price (same source as POS / Order Form)', async () => {
    const data = await buildPriceCardData({
      lines: [{ item: makeItem({ price: 6500, selling_price: 6500, sellingPrice: 6500 }) }],
      business: BUSINESS,
      reference: REF,
    });
    expect(data.lines[0].unitPrice).toBe(6500);
    expect(data.lines[0].lineTotal).toBe(6500);
    expect(data.unitOnly).toBe(true);
  });

  it('prefers the SmartPricing rounded price exactly like resolveStoredSellingPrice', async () => {
    const data = await buildPriceCardData({
      lines: [{
        item: makeItem({
          price: 6000,
          selling_price: 6000,
          smartPricingSnapshot: { roundedPrice: 6499.75, originalPrice: 6480, baseCost: 4000, roundingDifference: 19.75 },
        }),
      }],
      business: BUSINESS,
      reference: REF,
    });
    expect(data.lines[0].unitPrice).toBe(6499.75);
  });

  it('resolves variant prices', async () => {
    const item = makeItem({
      variants: [{ id: 'v1', name: 'A4 Hardcover — Gold', selling_price: 7500, price: 7500 }],
    });
    const data = await buildPriceCardData({
      lines: [{ item, variantId: 'v1' }],
      business: BUSINESS,
      reference: REF,
    });
    expect(data.lines[0].unitPrice).toBe(7500);
  });

  it('applies volume tiers through getUnitPrice', async () => {
    const item = makeItem({
      selling_price: 6500,
      allowVolumePricing: true,
      volumePricing: [{ minQty: 5, price: 6000 }],
    });
    const data = await buildPriceCardData({
      lines: [{ item, quantity: 5 }],
      business: BUSINESS,
      reference: REF,
    });
    expect(data.lines[0].unitPrice).toBe(6000);
    expect(data.lines[0].lineTotal).toBe(30000);
    expect(data.unitOnly).toBe(false);
  });

  it('applies the customer-tier multiplier exactly like POS', async () => {
    const customer = { id: 'CUST-1', businessName: 'Maupo Primary School', segment: 'wholesale' } as Customer;
    const data = await buildPriceCardData(
      { lines: [{ item: makeItem({ selling_price: 10000 }) }], customer, business: BUSINESS, reference: REF },
      { fetchCustomerTier: async () => ({ markupMultiplier: 0.85 } as any) },
    );
    expect(data.lines[0].unitPrice).toBe(8500);
    expect(data.customerName).toBe('Maupo Primary School');
  });

  it('falls back to the standard price when tier lookup fails (offline-safe)', async () => {
    const customer = { id: 'CUST-1', businessName: 'Maupo Primary School' } as Customer;
    const data = await buildPriceCardData(
      { lines: [{ item: makeItem({ selling_price: 6500 }) }], customer, business: BUSINESS, reference: REF },
      { fetchCustomerTier: async () => { throw new Error('offline'); } },
    );
    expect(data.lines[0].unitPrice).toBe(6500);
  });

  it('computes quantity totals and multi-line grand total', async () => {
    const data = await buildPriceCardData({
      lines: [
        { item: makeItem({ selling_price: 6500 }), quantity: 5 },
        { item: makeItem({ id: 'ITEM-2', name: 'A4 Softcover', selling_price: 4500 }), quantity: 2 },
      ],
      business: BUSINESS,
      reference: REF,
    });
    expect(data.lines[0].lineTotal).toBe(32500);
    expect(data.grandTotal).toBe(32500 + 9000);
  });
});

describe('priceCardService — zero / missing price safety', () => {
  it("distinguishes missing from zero and blocks K0 generation", async () => {
    expect(assessPriceAvailability({} as any)).toBe('missing');
    expect(assessPriceAvailability({ price: 0, selling_price: 0 } as any)).toBe('zero');
    expect(assessPriceAvailability({ selling_price: 6500 } as any)).toBe('ok');

    await expect(buildPriceCardData({
      lines: [{ item: makeItem({ price: 0, selling_price: 0, sellingPrice: 0, cost: 4000, costPrice: 4000 }) }],
      business: BUSINESS,
      reference: REF,
    })).rejects.toMatchObject({ code: 'zero-price' });

    await expect(buildPriceCardData({
      lines: [{ item: { id: 'X', name: 'Mystery', type: 'Product', stock: 1 } as unknown as Item }],
      business: BUSINESS,
      reference: REF,
    })).rejects.toMatchObject({ code: 'missing-price' });
  });

  it('blocks empty and overcrowded cards', async () => {
    await expect(buildPriceCardData({ lines: [], business: BUSINESS, reference: REF }))
      .rejects.toMatchObject({ code: 'no-lines' });
    const many = Array.from({ length: PRICE_CARD_MAX_LINES + 1 }, (_, i) =>
      ({ item: makeItem({ id: `I-${i}`, name: `P${i}` }) }));
    await expect(buildPriceCardData({ lines: many, business: BUSINESS, reference: REF }))
      .rejects.toMatchObject({ code: 'too-many-lines' });
    expect(PriceCardError).toBeDefined();
  });
});

describe('priceCardService — customer-safe DTO', () => {
  it('exposes only allowed fields (no cost, profit, balances, ids)', async () => {
    const customer = {
      id: 'CUST-9', businessName: 'Chiwana Primary School', contactName: 'John Banda',
      balance: 999, walletBalance: 888, outstandingBalance: 777, creditLimit: 666,
    } as unknown as Customer;
    const data = await buildPriceCardData({
      lines: [{ item: makeItem() }],
      customer,
      business: BUSINESS,
      reference: REF,
    });
    for (const line of data.lines) {
      expect(Object.keys(line).sort()).toEqual(
        ['description', 'imageUrl', 'lineTotal', 'productName', 'quantity', 'unit', 'unitPrice'].filter((k) => (line as any)[k] !== undefined).sort(),
      );
    }
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain('999');
    expect(serialized).not.toContain('888');
    expect(serialized).not.toContain('777');
    expect(serialized).not.toContain('profit');
    expect(serialized).not.toContain('cost');
    expect(serialized).not.toContain('CUST-9');
    expect(data.customerName).toBe('Chiwana Primary School');
  });
});

describe('priceCardService — reference, filename, formatting', () => {
  it('sequences PC-YYYY-NNNN references within local history', () => {
    const year = new Date().getFullYear();
    expect(generatePriceCardReference([])).toBe(`PC-${year}-0001`);
    expect(generatePriceCardReference([
      { reference: `PC-${year}-0001`, issuedAt: '', productNames: [], grandTotal: 0, currency: 'K' },
      { reference: `PC-${year}-0002`, issuedAt: '', productNames: [], grandTotal: 0, currency: 'K' },
      { reference: 'INV-0009', issuedAt: '', productNames: [], grandTotal: 0, currency: 'K' },
      { reference: `PC-${year - 1}-0041`, issuedAt: '', productNames: [], grandTotal: 0, currency: 'K' },
    ])).toBe(`PC-${year}-0003`);
  });

  it('builds sanitized professional filenames', async () => {
    const data = await buildPriceCardData({
      lines: [{ item: makeItem({ name: 'A4 Hardcover (Gold) / deluxe' }) }],
      business: BUSINESS,
      reference: 'PC-2026-0001',
    });
    const fileName = buildPriceCardFileName(data);
    expect(fileName).toBe('Prime-Printing-Services-Price-Card-A4-Hardcover-Gold-deluxe-PC-2026-0001.png');
    expect(fileName).not.toMatch(/[\\/:*?"<>|]/);
    expect(sanitizeFileNameSegment('')).toBe('Price-Card');
  });

  it('formats amounts and timestamps like the ERP', () => {
    expect(formatPriceCardAmount(6500, 'K')).toBe('K 6,500.00');
    expect(formatPriceCardAmount(6499.75, 'K')).toBe('K 6,499.75');
    expect(formatPriceCardTimestamp('2026-09-15T05:12:00')).toContain('•');
    expect(formatPriceCardTimestamp('2026-09-15T05:12:00')).toContain('2026');
  });
});

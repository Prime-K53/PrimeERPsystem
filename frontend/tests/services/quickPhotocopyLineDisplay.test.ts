import { describe, expect, it } from 'vitest';
import {
  calculateBillableSheets,
  calculateQuickPhotocopyAmount,
  getQuickPhotocopyLineDisplay,
  getQuickPhotocopyTotals,
  isQuickPhotocopyItem,
  resolveQuickPhotocopyDisplayName,
} from '../../services/quickPhotocopyService';

const PRICE_150 = 150;

/**
 * Production-shaped Quick Photocopy line (mirrors OrderForm/POS creation):
 * 13 entered pages, 1 copy, K150/sheet → 7 billable sheets → K1,050.
 */
const makeQP13 = () => ({
  id: `QUICK-PHOTO-TEST-13x1`,
  itemId: 'SVC-PHOTOCOPY',
  sku: 'QUICK-PHOTO',
  name: 'Quick Photocopy',
  desc: 'Quick Photocopy',
  price: PRICE_150,
  quantity: 7,
  unit: 'sheet',
  category: 'Service',
  type: 'Service',
  billableSheets: 7,
  qpPages: 13,
  qpCopies: 1,
  serviceDetails: {
    pages: 13,
    copies: 1,
    totalPages: 13,
    billableSheets: 7,
    pricePerSheet: PRICE_150,
  },
});

describe('Quick Photocopy compact line display (acceptance)', () => {
  it('renders Quick Photocopy | 13 pgs | K 150.00/sht | K 1,050.00', () => {
    const display = getQuickPhotocopyLineDisplay(makeQP13(), 'K');
    expect(display.name).toBe('Quick Photocopy');
    expect(display.qty).toBe('13 pgs');
    expect(display.rate).toBe('K 150.00/sht');
    expect(display.amount).toBe(1050);
  });

  it('rate appears exactly once across the composed line', () => {
    const display = getQuickPhotocopyLineDisplay(makeQP13(), 'K');
    const composed = `${display.name} ${display.qty} ${display.rate} ${display.amount}`;
    expect(composed.match(/\/sht/g)?.length ?? 0).toBe(1);
    expect(composed.match(/150\.00/g)?.length ?? 0).toBe(1);
    expect(display.name).not.toContain('/sht');
    expect(display.name).not.toContain('/sheet');
    expect(display.name).not.toContain('—');
  });

  it('uses "pgs", never "pages", in the compact presentation', () => {
    const display = getQuickPhotocopyLineDisplay(makeQP13(), 'K');
    expect(display.qty).toContain('pgs');
    expect(display.qty).not.toContain('pages');
    expect(display.rate).not.toContain('pages');
    expect(display.name).not.toContain('pages');
  });

  it('strips a legacy persisted rate suffix from the display name only', () => {
    const legacy = { ...makeQP13(), name: 'Quick Photocopy — K150.00/sheet' };
    expect(resolveQuickPhotocopyDisplayName(legacy)).toBe('Quick Photocopy');
    expect(legacy.name).toBe('Quick Photocopy — K150.00/sheet');
  });

  it('normal products/services are unaffected', () => {
    const pen = { id: 'PROD-001', sku: 'PEN-001', name: 'Pen', price: 500, quantity: 3, type: 'Product' };
    expect(isQuickPhotocopyItem(pen)).toBe(false);
    const print = {
      id: 'QUICK-PRINT-123',
      sku: 'QUICK-PRINT',
      itemId: 'SVC-TYPE-PRINT',
      name: 'Type & Printing',
      price: 5,
      quantity: 10,
      serviceDetails: { pages: 10, copies: 1 },
    };
    expect(isQuickPhotocopyItem(print)).toBe(false);
  });

  it('quantity and amount calculations are unchanged (display is read-only)', () => {
    const item: any = makeQP13();
    const before = JSON.parse(JSON.stringify(item));
    const display = getQuickPhotocopyLineDisplay(item, 'K');
    expect(item).toEqual(before);
    expect(item.price).toBe(150);
    expect(item.quantity).toBe(7);
    expect(display.amount).toBe(7 * 150);
    expect(display.amount).toBe(1050);
  });

  it('1 sheet = 2 pages conversion is unchanged', () => {
    expect(calculateBillableSheets(13, 1)).toBe(7);
    expect(calculateQuickPhotocopyAmount(13, 1, PRICE_150)).toBe(1050);
    const t = getQuickPhotocopyTotals(makeQP13());
    expect(t.totalPages).toBe(13);
    expect(t.billableSheets).toBe(7);
    expect(t.unitPrice).toBe(150);
    expect(t.lineTotal).toBe(1050);
  });
});

import { describe, expect, it } from 'vitest';
import {
  calculateBillableSheets,
  calculateQuickPhotocopyAmount,
  calculateQuickPhotocopyLine,
  calculateTotalPages,
  formatQuickPhotocopyPriceLabel,
  formatQuickPhotocopyQty,
  getQuickPhotocopyDocumentLine,
  getQuickPhotocopyLineDisplay,
  getQuickPhotocopyPricePerSheet,
  getQuickPhotocopyTotals,
  isQuickPhotocopyItem,
} from '../../services/quickPhotocopyService';
import { buildPosReceiptDoc } from '../../services/receiptCalculationService';
import { mapToInvoiceData } from '../../utils/pdfMapper';

const PRICE_150 = 150;

const makeQPItem = (pagesPerCopy: number, copies: number, pricePerSheet = PRICE_150) => {
  const billableSheets = copies * Math.ceil(pagesPerCopy / 2);
  return {
    id: `QUICK-PHOTO-TEST-${pagesPerCopy}x${copies}`,
    itemId: 'SVC-PHOTOCOPY',
    sku: 'QUICK-PHOTO',
    name: 'Quick Photocopy',
    desc: 'Quick Photocopy',
    price: pricePerSheet,
    quantity: billableSheets,
    unit: 'sheet',
    category: 'Service',
    type: 'Service',
    billableSheets,
    qpPages: pagesPerCopy,
    qpCopies: copies,
    serviceDetails: {
      pages: pagesPerCopy,
      copies,
      totalPages: pagesPerCopy * copies,
      billableSheets,
      pricePerSheet,
    },
  };
};

describe('Quick Photocopy billing-unit', () => {
  // Calculation 1-7
  it('1 page → 1 sheet', () => {
    expect(calculateBillableSheets(1, 1)).toBe(1);
  });
  it('2 pages → 1 sheet', () => {
    expect(calculateBillableSheets(2, 1)).toBe(1);
  });
  it('3 pages → 2 sheets (ceiling)', () => {
    expect(calculateBillableSheets(3, 1)).toBe(2);
  });
  it('4 pages → 2 sheets', () => {
    expect(calculateBillableSheets(4, 1)).toBe(2);
  });
  it('50 pages → 25 sheets → K3,750 at K150/sheet', () => {
    expect(calculateBillableSheets(50, 1)).toBe(25);
    expect(calculateQuickPhotocopyAmount(50, 1, PRICE_150)).toBe(3750);
    expect(calculateQuickPhotocopyLine({ pagesPerCopy: 50, copies: 1, pricePerSheet: PRICE_150 })).toMatchObject({
      totalPages: 50,
      billableSheets: 25,
      unitPrice: 150,
      lineTotal: 3750,
    });
  });
  it('51 pages → 26 sheets → K3,900 at K150/sheet', () => {
    expect(calculateBillableSheets(51, 1)).toBe(26);
    expect(calculateQuickPhotocopyAmount(51, 1, PRICE_150)).toBe(3900);
  });
  it('100 pages → 50 sheets → K7,500 at K150/sheet', () => {
    expect(calculateBillableSheets(100, 1)).toBe(50);
    expect(calculateQuickPhotocopyAmount(100, 1, PRICE_150)).toBe(7500);
  });

  // Settings 8-11
  it('price K175 → 50 pages = K4,375 (no hard-coded K150)', () => {
    expect(calculateQuickPhotocopyAmount(50, 1, 175)).toBe(4375);
  });
  it('price K200 → 50 pages = K5,000', () => {
    expect(calculateQuickPhotocopyAmount(50, 1, 200)).toBe(5000);
  });
  it('reads configured price from Settings (source of truth)', () => {
    const config = { transactionSettings: { pos: { photocopyPrice: 175 } } };
    expect(getQuickPhotocopyPricePerSheet(config)).toBe(175);
    const config200 = { transactionSettings: { pos: { photocopyPrice: 200 } } };
    expect(getQuickPhotocopyPricePerSheet(config200)).toBe(200);
    const config150 = { transactionSettings: { pos: { photocopyPrice: 150 } } };
    expect(getQuickPhotocopyPricePerSheet(config150)).toBe(150);
  });
  it('never mutates the configured price', () => {
    const config: any = { transactionSettings: { pos: { photocopyPrice: 150 } } };
    calculateQuickPhotocopyLine({ pagesPerCopy: 50, copies: 1, pricePerSheet: getQuickPhotocopyPricePerSheet(config) });
    expect(config.transactionSettings.pos.photocopyPrice).toBe(150);
  });

  // Data semantics 12-15
  it('entered quantity remains 50 pages; billable sheets are 25', () => {
    const item = makeQPItem(50, 1);
    const t = getQuickPhotocopyTotals(item);
    expect(t.totalPages).toBe(50);
    expect(t.billableSheets).toBe(25);
    expect(formatQuickPhotocopyQty(t.totalPages)).toBe('50 pgs');
  });
  it('amount is based on 25 sheets, not 50 pages', () => {
    const item = makeQPItem(50, 1);
    const t = getQuickPhotocopyTotals(item);
    expect(t.lineTotal).toBe(25 * 150);
    expect(t.lineTotal).not.toBe(50 * 150);
  });
  it('odd page counts use ceiling division', () => {
    expect(calculateTotalPages(5, 1)).toBe(5);
    expect(calculateBillableSheets(5, 1)).toBe(3);
    expect(calculateQuickPhotocopyAmount(5, 1, PRICE_150)).toBe(450);
    expect(calculateQuickPhotocopyAmount(10, 1, PRICE_150)).toBe(750);
  });

  // Documents 16-22
  it('document line shows 50 pgs, K 150.00/sht, K3,750', () => {
    const item = makeQPItem(50, 1);
    const line = getQuickPhotocopyDocumentLine(item, 'K');
    expect(line.qtyLabel).toBe('50 pgs');
    expect(line.priceLabel).toBe('K 150.00/sht');
    expect(line.amount).toBe(3750);
  });
  it('POS receipt shows plain name; qty/rate compose 50 pgs, K 150.00/sht, K3,750', () => {
    const qp = makeQPItem(50, 1);
    const sale: any = {
      id: 'SALE-QP-TEST',
      date: new Date().toISOString(),
      customerName: 'Walk-in Customer',
      items: [qp],
      subtotal: 3750,
      discount: 0,
      totalAmount: 3750,
      paymentMethod: 'Cash',
      payments: [{ method: 'Cash', amount: 3750 }],
    };
    // Production receipt desc is the plain item name (rate lives only in
    // the qty × rate line composed by the receipt template).
    const receipt: any = buildPosReceiptDoc({
      sale,
      cashierName: 'Cashier',
      itemDescriptionFormatter: (lineItem: any) =>
        getQuickPhotocopyLineDisplay(lineItem, 'K').name,
    });
    expect(receipt.items[0].desc).toBe('Quick Photocopy');
    expect(receipt.items[0].desc).not.toContain('/sht');
    expect(receipt.items[0].desc).not.toContain('/sheet');
    const display = getQuickPhotocopyLineDisplay(qp, 'K');
    expect(`${display.qty} x ${display.rate}`).toBe('50 pgs x K 150.00/sht');
    expect(receipt.items[0].total).toBe(3750);
    expect(receipt.totalAmount).toBe(3750);
  });
  it('invoice mapping preserves QP totals (sheets × price)', () => {
    const qp = makeQPItem(50, 1);
    const invoice: any = {
      id: 'INV-QP-TEST',
      customerName: 'Test Customer',
      totalAmount: 3750,
      items: [qp],
    };
    const mapped: any = mapToInvoiceData(invoice, { currencySymbol: 'K' } as any, 'INVOICE');
    expect(mapped.items[0].desc).toContain('50 pages');
    expect(mapped.items[0].price).toBe(150);
    expect(mapped.items[0].total).toBe(3750);
  });
  it('quotation mapping preserves QP totals', () => {
    const qp = makeQPItem(51, 1);
    const quotation: any = {
      id: 'QUO-QP-TEST',
      customerName: 'Test Customer',
      totalAmount: 3900,
      items: [qp],
    };
    const mapped: any = mapToInvoiceData(quotation, { currencySymbol: 'K' } as any, 'QUOTATION');
    expect(mapped.items[0].total).toBe(3900);
  });
  it('no document shows K7,500 for 50 pages at K150/sheet', () => {
    const item = makeQPItem(50, 1);
    const line = getQuickPhotocopyDocumentLine(item, 'K');
    expect(line.amount).not.toBe(7500);
    expect(line.amount).toBe(3750);
  });

  // Regression 23-25
  it('normal products still use quantity × price', () => {
    const normal = { id: 'PROD-001', sku: 'PEN-001', name: 'Pen', price: 500, quantity: 3, type: 'Product' };
    expect(isQuickPhotocopyItem(normal)).toBe(false);
    expect(Number(normal.price) * Number(normal.quantity)).toBe(1500);
  });
  it('QUICK-PRINT is not treated as Quick Photocopy', () => {
    const qpPrint = {
      id: 'QUICK-PRINT-123',
      sku: 'QUICK-PRINT',
      itemId: 'SVC-TYPE-PRINT',
      name: 'Type & Printing',
      price: 5,
      quantity: 10,
      unit: 'page',
      serviceDetails: { pages: 10, copies: 1 },
    };
    expect(isQuickPhotocopyItem(qpPrint)).toBe(false);
  });
  it('price label uses compact "/sht" form with existing 2-decimal convention', () => {
    expect(formatQuickPhotocopyPriceLabel(175, 'K')).toBe('K 175.00/sht');
    expect(formatQuickPhotocopyPriceLabel(200, 'K')).toBe('K 200.00/sht');
    expect(formatQuickPhotocopyPriceLabel(150, 'K')).toBe('K 150.00/sht');
  });
});

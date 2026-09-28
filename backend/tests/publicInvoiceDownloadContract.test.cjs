/**
 * Public verification invoice PDF contract — INV-P726/063 regression.
 *
 * Pins normalizeRecordForRenderer + toCanonicalRendererType so the public
 * download carries the same substantive invoice fields as the canonical ERP
 * invoice. Hermetic: imports only the pure normalization helpers by
 * evaluating the service file's pure section (no renderer, no DB).
 */
const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadPureHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'officialDocumentService.cjs'), 'utf8');
  const start = src.indexOf('function resolveItemDescription');
  const end = src.indexOf('async function renderOfficialPdf');
  const prelude = src.slice(0, src.indexOf('/**'));
  const pure = src.slice(start, end);
  const sandbox = { module: { exports: {} }, require: () => { throw new Error('no requires in pure section'); } };
  vm.runInNewContext(`${pure}\nmodule.exports = { normalizeRecordForRenderer, toCanonicalRendererType, resolveItemDescription };`, sandbox);
  return sandbox.module.exports;
}

const { normalizeRecordForRenderer, toCanonicalRendererType } = loadPureHelpers();

const RAW = {
  id: 'INV-P726/063',
  date: '2026-09-25',
  invoice_number_date: '2026-09-08',
  due_date: '2027-09-08',
  customerName: 'Mandamula Primary School',
  totalAmount: 20850,
  paidAmount: 0,
  subtotal: 20850,
  status: 'Unpaid',
  items: [
    { description: 'Quick Photocopy', quantity: 80, sellingPrice: 150, amount: 12000 },
    { description: 'Quick Photocopy', quantity: 47, sellingPrice: 150, amount: 7050 },
    { description: 'Printing L I Numbers', quantity: 4, rate: 450, extendedPrice: 1800 },
  ],
};

describe('public invoice download contract INV-P726/063', () => {
  it('type invoice canonicalizes to INVOICE', () => {
    assert.equal(toCanonicalRendererType('invoice'), 'INVOICE');
    assert.equal(toCanonicalRendererType('INVOICE'), 'INVOICE');
  });
  it('all public slugs canonicalize', () => {
    assert.equal(toCanonicalRendererType('sales_order'), 'SALES_ORDER');
    assert.equal(toCanonicalRendererType('purchase_order'), 'PO');
    assert.equal(toCanonicalRendererType('delivery_note'), 'DELIVERY_NOTE');
    assert.equal(toCanonicalRendererType('supplier_payment'), 'SUPPLIER_PAYMENT');
    assert.equal(toCanonicalRendererType('statement'), 'ACCOUNT_STATEMENT');
    assert.equal(toCanonicalRendererType('quotation'), 'QUOTATION');
    assert.equal(toCanonicalRendererType('receipt'), 'RECEIPT');
  });
  it('date uses canonical source, ignoring invoice_number_date', () => {
    const n = normalizeRecordForRenderer(RAW, 'INVOICE');
    assert.equal(n.date, '2026-09-25');
    assert.equal(n.invoiceDate, '2026-09-25');
  });
  it('due date reaches renderer', () => {
    const n = normalizeRecordForRenderer(RAW, 'INVOICE');
    assert.equal(n.dueDate, '2027-09-08');
    assert.equal(n.due_date, '2027-09-08');
  });
  it('line prices reach renderer', () => {
    const n = normalizeRecordForRenderer(RAW, 'INVOICE');
    assert.equal(n.items[0].price, 150);
    assert.equal(n.items[1].price, 150);
    assert.equal(n.items[2].price, 450);
  });
  it('line totals reach renderer', () => {
    const n = normalizeRecordForRenderer(RAW, 'INVOICE');
    assert.equal(n.items[0].total, 12000);
    assert.equal(n.items[1].total, 7050);
    assert.equal(n.items[2].total, 1800);
  });
  it('totals and status preserved', () => {
    const n = normalizeRecordForRenderer(RAW, 'INVOICE');
    assert.equal(Number(n.totalAmount), 20850);
    assert.equal(Number(n.paidAmount), 0);
    assert.equal(Number(n.subtotal), 20850);
    assert.equal(String(n.status).toLowerCase(), 'unpaid');
  });
  it('empty items does not shadow line_items', () => {
    const n = normalizeRecordForRenderer({ items: [], line_items: [{ description: 'A', quantity: 1, price: 100, total: 100 }] });
    assert.equal(n.items.length, 1);
  });
  it('other document types preserved (quotation validUntil)', () => {
    const n = normalizeRecordForRenderer({ validUntil: '2027-01-01', items: [] }, 'QUOTATION');
    assert.equal(n.dueDate, '2027-01-01');
  });
});

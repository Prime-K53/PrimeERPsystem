/**
 * documentVerification.test.cjs
 *
 * Generic framework tests: one suite per supported document type
 * (token valid/missing/wrong, wrong number, wrong type, void/cancelled,
 * statuses, allow-list, read-only, no-auth) plus invoice compatibility
 * (old endpoint + old service delegate byte-identical behavior).
 *
 * Local stub HTTP store — no network, no credentials, no writes.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOK = 'd'.repeat(64);
const BAD = 'e'.repeat(64);

const TABLES = {
  invoices: [
    { data: { id: 'INV-G001', invoiceNumber: 'INV-G001', date: '2026-09-01', customerName: 'Acme School', currency: 'MWK', subtotal: 100000, tax: 0, totalAmount: 100000, paidAmount: 100000, status: 'Paid', verificationToken: TOK } },
    { data: { id: 'INV-G002', date: '2026-09-02', customerName: 'Void School', totalAmount: 5000, paidAmount: 0, status: 'Cancelled', verificationToken: TOK } },
  ],
  customer_payments: [
    { data: { id: 'PAY-G001', date: '2026-09-03', customerName: 'Acme School', currency: 'MWK', amount: 70000, paymentMethod: 'Cash', reference: 'INV-G001', status: 'Cleared', verificationToken: TOK } },
  ],
  quotations: [
    { data: { id: 'QTN-G001', date: '2026-09-04', customerName: 'Quote School', currency: 'MWK', subtotal: 50000, tax: 0, totalAmount: 50000, validUntil: '2026-09-11', status: 'Sent', verificationToken: TOK } },
  ],
  sales_orders: [
    { id: 'SO-G001', orderNumber: 'SO-G001', orderDate: '2026-09-05', customerName: 'Order School', currency: 'MWK', total: 324000, status: 'Confirmed', verificationToken: TOK },
  ],
  purchases: [
    { data: { id: 'PO-G001', order_number: 'PO-G001', order_date: '2026-09-06', supplierName: 'Paper Supplier', currency: 'MWK', total_amount: 90000, status: 'approved', verificationToken: TOK } },
  ],
  delivery_notes: [
    { id: 'DN-G001', dnNumber: 'DN-G001', date: '2026-09-07', customerName: 'Delivered School', invoiceId: 'INV-G001', status: 'Delivered', verificationToken: TOK },
  ],
};

function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const table = url.pathname.split('/').pop();
    if (req.method !== 'GET' || !TABLES[table]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const or = url.searchParams.get('or') || '';
    const m = or.match(/eq\.([^,)]+)/);
    const wanted = m ? decodeURIComponent(m[1]) : '';
    const rows = TABLES[table].filter((r) => {
      const d = r.data || r;
      return Object.values(d).some((v) => String(v ?? '') === wanted);
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let stub;
let app;
const good = (type, n, t) => `/api/public/documents/verify/${type}/${encodeURIComponent(n)}?t=${t}`;

before(async () => {
  stub = await startStub();
  const port = stub.address().port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.COMPANY_NAME = 'Prime Printing Service';
  app = express();
  app.use('/api/public/documents', require('../routes/documentVerify.cjs'));
  const legacy = express();
  legacy.use('/api/public/invoices', require('../routes/portalVerify.cjs'));
  app.use(legacy);
});

after(() => new Promise((resolve) => stub.close(resolve)));

describe('generic document verification', () => {
  it('invoice verifies with invoice number + status', async () => {
    const res = await request(app).get(good('invoice', 'INV-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.status, 'PAID');
    assert.equal(res.body.balanceDue, 0);
  });

  it('receipt verifies with safe receipt shape', async () => {
    const res = await request(app).get(good('receipt', 'PAY-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.receiptNumber, 'PAY-G001');
    assert.equal(res.body.amount, 70000);
    assert.equal(res.body.paymentMethod, 'Cash');
    assert.equal(res.body.status, 'PAID');
  });

  it('quotation verifies with validity data', async () => {
    const res = await request(app).get(good('quotation', 'QTN-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.quotationNumber, 'QTN-G001');
    assert.equal(res.body.total, 50000);
    assert.equal(res.body.status, 'Sent');
  });

  it('sales order verifies (flat row shape)', async () => {
    const res = await request(app).get(good('sales_order', 'SO-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.orderNumber, 'SO-G001');
    assert.equal(res.body.status, 'Confirmed');
  });

  it('purchase order verifies (legacy purchases source)', async () => {
    const res = await request(app).get(good('purchase_order', 'PO-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.purchaseOrderNumber, 'PO-G001');
    assert.equal(res.body.supplierName, 'Paper Supplier');
  });

  it('delivery note verifies with reference', async () => {
    const res = await request(app).get(good('delivery_note', 'DN-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryNoteNumber, 'DN-G001');
    assert.equal(res.body.reference, 'INV-G001');
    assert.equal(res.body.status, 'Delivered');
  });

  it('unknown type, missing/wrong token, wrong number all 404 generic', async () => {
    const bad1 = await request(app).get(good('nope', 'INV-G001', TOK));
    assert.equal(bad1.status, 404);
    const bad2 = await request(app).get('/api/public/documents/verify/invoice/INV-G001');
    assert.equal(bad2.status, 404);
    const bad3 = await request(app).get(good('invoice', 'INV-G001', BAD));
    assert.equal(bad3.status, 404);
    const bad4 = await request(app).get(good('receipt', 'INV-G001', TOK));
    assert.equal(bad4.status, 404); // right token, wrong table
    for (const r of [bad1, bad2, bad3, bad4]) {
      assert.equal(r.body.verified, false);
      assert.ok(!JSON.stringify(r.body).includes(TOK));
    }
  });

  it('cancelled invoice verifies as VOID via generic route', async () => {
    const res = await request(app).get(good('invoice', 'INV-G002', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'VOID');
  });

  it('read-only: non-GET methods are not routed', async () => {
    for (const method of ['post', 'put', 'delete', 'patch']) {
      const res = await request(app)[method](good('invoice', 'INV-G001', TOK));
      assert.equal(res.status, 404, method);
    }
  });

  it('no-auth: succeeds with zero credentials', async () => {
    const res = await request(app).get(good('quotation', 'QTN-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
  });

  it('allow-list: no sensitive keys on any type', async () => {
    const allowed = new Set([
      'verified', 'documentType', 'invoiceNumber', 'invoiceDate', 'receiptNumber', 'receiptDate',
      'quotationNumber', 'quotationDate', 'orderNumber', 'orderDate', 'purchaseOrderNumber',
      'deliveryNoteNumber', 'deliveryDate', 'companyName', 'customerName', 'supplierName',
      'currency', 'subtotal', 'tax', 'total', 'amount', 'amountPaid', 'balanceDue',
      'paymentMethod', 'reference', 'validUntil', 'status',
    ]);
    const forbidden = ['password', 'email', 'phone', 'address', 'audit', 'journal', 'ledger', 'verificationToken', 'token', 'secret', 'supabase', 'user_id', 'sync'];
    const cases = [
      ['invoice', 'INV-G001'], ['receipt', 'PAY-G001'], ['quotation', 'QTN-G001'],
      ['sales_order', 'SO-G001'], ['purchase_order', 'PO-G001'], ['delivery_note', 'DN-G001'],
    ];
    for (const [type, num] of cases) {
      const res = await request(app).get(good(type, num, TOK));
      assert.equal(res.status, 200, type);
      for (const key of Object.keys(res.body)) assert.ok(allowed.has(key), `${type}: unexpected key ${key}`);
      const blob = JSON.stringify(res.body).toLowerCase();
      for (const bad of forbidden) assert.ok(!blob.includes(bad), `${type} leaked: ${bad}`);
    }
  });

  it('invoice compatibility endpoint delegates byte-identically', async () => {
    const legacy = await request(app).get(`/api/public/invoices/verify/INV-G001?t=${TOK}`);
    const generic = await request(app).get(good('invoice', 'INV-G001', TOK));
    assert.equal(legacy.status, 200);
    assert.ok(!('documentType' in legacy.body), 'legacy shape has no documentType');
    assert.equal(generic.body.documentType, 'invoice');
    const { documentType: _dropped, ...genericRest } = generic.body;
    assert.deepEqual(legacy.body, genericRest);
    assert.equal(legacy.body.invoiceNumber, 'INV-G001');
    const legacyBad = await request(app).get(`/api/public/invoices/verify/INV-G001?t=${BAD}`);
    assert.equal(legacyBad.status, 404);
    assert.equal(legacyBad.body.verified, false);
  });
});

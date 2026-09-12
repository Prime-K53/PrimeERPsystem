/**
 * invoiceVerification.test.cjs
 *
 * Covers spec items 8–18 against the real Express router + service, with the
 * Supabase REST layer replaced by a local stub HTTP server (no network, no
 * credentials, no database writes anywhere).
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

const ROWS = {
  paid: {
    id: 'INV-VERIFY-001',
    invoiceNumber: 'INV-VERIFY-001',
    date: '2026-09-01',
    customerId: 'CUST-1',
    customerName: 'Chiwana Primary School',
    businessName: 'Chiwana Primary School',
    currency: 'MWK',
    subtotal: 100000,
    tax: 0,
    totalAmount: 100000,
    paidAmount: 100000,
    status: 'Paid',
    verificationToken: TOKEN_A,
  },
  partial: {
    id: 'INV-VERIFY-002',
    date: '2026-09-02',
    customerName: 'Makankhula Primary School',
    currency: 'MWK',
    subtotal: 80000,
    totalAmount: 80000,
    paidAmount: 30000,
    status: 'Partial',
    verificationToken: TOKEN_A,
  },
  unpaid: {
    id: 'INV-VERIFY-003',
    date: '2026-09-03',
    customerName: 'Chiitana Primary School',
    totalAmount: 50000,
    paidAmount: 0,
    status: 'Unpaid',
    verificationToken: TOKEN_A,
  },
  void: {
    id: 'INV-VERIFY-004',
    date: '2026-09-04',
    customerName: 'Nsalu Primary School',
    totalAmount: 20000,
    paidAmount: 0,
    status: 'Cancelled',
    verificationToken: TOKEN_A,
  },
  untokened: {
    id: 'INV-VERIFY-005',
    date: '2026-09-05',
    customerName: 'No Token School',
    totalAmount: 1000,
    paidAmount: 0,
    status: 'Unpaid',
  },
};

function startStubStore() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    if (!url.pathname.endsWith('/invoices') || req.method !== 'GET') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const or = url.searchParams.get('or') || '';
    const m = or.match(/eq\.([^,)]+)/);
    const wanted = m ? decodeURIComponent(m[1]) : '';
    const rows = Object.values(ROWS)
      .filter((d) => d.id === wanted || d.invoiceNumber === wanted)
      .map((data) => ({ data }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let stub;
let app;

before(async () => {
  stub = await startStubStore();
  const port = stub.address().port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.COMPANY_NAME = 'Prime Printing Service';
  app = express();
  app.use('/api/public/invoices', require('../routes/portalVerify.cjs'));
});

after(() => new Promise((resolve) => stub.close(resolve)));

const good = (n, t) => `/api/public/invoices/verify/${encodeURIComponent(n)}?t=${t}`;
const FORBIDDEN_KEYS = [
  'password_hash', 'password', 'email', 'phone', 'address', 'audit',
  'journal', 'ledger', 'verificationToken', 'token', 'secret', 'supabase',
];

describe('invoice verification endpoint', () => {
  it('Test 8 — correct token verifies successfully', async () => {
    const res = await request(app).get(good('INV-VERIFY-001', TOKEN_A));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'INV-VERIFY-001');
  });

  it('Test 9 — missing token fails generically', async () => {
    const res = await request(app).get('/api/public/invoices/verify/INV-VERIFY-001');
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
  });

  it('Test 10 — wrong token fails generically', async () => {
    const res = await request(app).get(good('INV-VERIFY-001', TOKEN_B));
    assert.equal(res.status, 404);
    assert.deepEqual(res.body, (await request(app).get('/api/public/invoices/verify/NOPE')).body);
  });

  it('Test 11 — valid token + wrong number fails', async () => {
    const res = await request(app).get(good('INV-VERIFY-999', TOKEN_A));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
  });

  it('Test 12 — void invoice returns VOID (authentic but voided)', async () => {
    const res = await request(app).get(good('INV-VERIFY-004', TOKEN_A));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.status, 'VOID');
  });

  it('Test 13/14/15 — PAID / PARTIALLY PAID / UNPAID statuses', async () => {
    const paid = await request(app).get(good('INV-VERIFY-001', TOKEN_A));
    assert.equal(paid.body.status, 'PAID');
    assert.equal(paid.body.amountPaid, 100000);
    assert.equal(paid.body.balanceDue, 0);
    const partial = await request(app).get(good('INV-VERIFY-002', TOKEN_A));
    assert.equal(partial.body.status, 'PARTIALLY PAID');
    assert.equal(partial.body.balanceDue, 50000);
    const unpaid = await request(app).get(good('INV-VERIFY-003', TOKEN_A));
    assert.equal(unpaid.body.status, 'UNPAID');
    assert.equal(unpaid.body.total, 50000);
  });

  it('untokened invoice never verifies', async () => {
    const res = await request(app).get(good('INV-VERIFY-005', TOKEN_A));
    assert.equal(res.status, 404);
  });

  it('Test 16 — read-only: POST/PUT/DELETE are not routed', async () => {
    for (const method of ['post', 'put', 'delete', 'patch']) {
      const res = await request(app)[method](good('INV-VERIFY-001', TOKEN_A));
      assert.equal(res.status, 404, method);
    }
  });

  it('Test 17 — no admin authentication required', async () => {
    // No Authorization header anywhere in this file — a 200 here proves it.
    const res = await request(app).get(good('INV-VERIFY-001', TOKEN_A));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
  });

  it('Test 18 — response exposes only the safe allow-list', async () => {
    const res = await request(app).get(good('INV-VERIFY-001', TOKEN_A));
    const allowed = new Set([
      'verified', 'invoiceNumber', 'invoiceDate', 'companyName', 'customerName',
      'currency', 'subtotal', 'tax', 'total', 'amountPaid', 'balanceDue', 'status',
    ]);
    for (const key of Object.keys(res.body)) {
      assert.ok(allowed.has(key), `unexpected key: ${key}`);
    }
    const blob = JSON.stringify(res.body).toLowerCase();
    for (const bad of FORBIDDEN_KEYS) {
      assert.ok(!blob.includes(bad), `leaked: ${bad}`);
    }
  });
});

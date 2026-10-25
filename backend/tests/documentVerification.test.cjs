/**
 * documentVerification.test.cjs
 *
 * Generic framework tests: one suite per supported document type
 * (token valid/missing/wrong, wrong number, wrong type, void/cancelled,
 * statuses, allow-list, read-only, no-auth) plus invoice compatibility
 * (old endpoint + old service delegate byte-identical behavior).
 *
 * Local stub HTTP store â€” no network, no credentials, no writes.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOK = 'd'.repeat(64);
const BAD = 'e'.repeat(64);
// Per-version schedule tokens (distinct from the parent contract token TOK).
const S1 = '1'.repeat(64);
const S2 = '2'.repeat(64);
const S3 = '3'.repeat(64);
const S5 = '5'.repeat(64);
const S4 = '4'.repeat(64);
// Tables toggled to return a PostgREST 404 (missing table) during a test.
const MISSING_TABLES = new Set();
const integrity = require('../services/documentIntegrity.cjs');

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
    { data: { id: 'PO-G003', order_number: 'PO-G003', order_date: '2026-09-06', supplierName: 'Legacy Supplier', currency: 'MWK', total_amount: 1000, status: 'approved', verificationToken: TOK } },
  ],
  purchase_orders: [
    { id: 'PO-G002', data: { id: 'PO-G002', order_number: 'PO-G002', order_date: '2026-09-06', supplierName: 'Canonical Supplier', currency: 'MWK', total_amount: 120000, status: 'approved', verificationToken: TOK } },
    { id: 'PO-G003', data: { id: 'PO-G003', order_number: 'PO-G003', order_date: '2026-09-06', supplierName: 'Canonical Supplier', currency: 'MWK', total_amount: 2000, status: 'approved', verificationToken: TOK } },
  ],
  delivery_notes: [
    { id: 'DN-G001', dnNumber: 'DN-G001', date: '2026-09-07', customerName: 'Delivered School', invoiceId: 'INV-G001', status: 'Delivered', verificationToken: TOK },
  ],
  supplier_payments: [
    { id: 'SPAY-G001', data: { id: 'SPAY-G001', paymentNumber: 'SPAY-G001', paymentDate: '2026-09-10', supplierName: 'Paid Supplier', currency: 'MWK', amount: 25000, paymentMethod: 'Bank Transfer', accountId: '11110', glAccountId: '21110', reference: 'PO-G001', status: 'Cleared', verificationToken: TOK } },
    { id: 'SPAY-G002', data: { id: 'SPAY-G002', paymentDate: '2026-09-10', supplierName: 'Void Supplier', currency: 'MWK', amount: 5000, paymentMethod: 'Cash', status: 'Voided', verificationToken: TOK } },
  ],
  statement_snapshots: [
    { id: 'STMT-G001', data: { id: 'STMT-G001', statementNumber: 'STMT-G001', statementDate: '2026-09-12', periodStart: '2026-08-01', periodEnd: '2026-08-31', customerId: 'CUST-1', customerName: 'Stmt School', email: 'private@example.com', phone: '+265000', currency: 'MWK', openingBalance: 100, transactions: [{ date: '2026-08-05', reference: 'INV-1', debit: 500, credit: 0, runningBalance: 600 }], totalInvoiced: 500, totalReceived: 200, closingBalance: 400, status: 'VALID', verificationToken: TOK } },
    { id: 'STMT-G002', data: { id: 'STMT-G002', statementNumber: 'STMT-G002', statementDate: '2026-08-12', periodStart: '2026-07-01', periodEnd: '2026-07-31', customerId: 'CUST-1', customerName: 'Stmt School', currency: 'MWK', openingBalance: 0, transactions: [], totalInvoiced: 0, totalReceived: 0, closingBalance: 0, status: 'SUPERSEDED', supersededBy: 'STMT-G001', verificationToken: TOK } },
    // Branch-scoped statement: the snapshot carries the canonical scope key so
    // the verifier can tell it apart from the customer's Main statement.
    { id: 'STMT-G003', data: { id: 'STMT-G003', statementNumber: 'STMT-G003', statementDate: '2026-09-12', periodStart: '2026-08-01', periodEnd: '2026-08-31', customerId: 'CUST-1', customerName: 'Stmt School', currency: 'MWK', openingBalance: 0, transactions: [], totalInvoiced: 10, totalReceived: 0, closingBalance: 10, branchKey: 'id:SUB-A', branchLabel: 'Exam Centre', status: 'VALID', verificationToken: TOK } },
  ],
  assessment_contracts: [
    { data: { id: 'c-g001', contract_number: 'PC-G001', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Contract School', currency: 'MWK', prepaid_amount: 5000, max_assessments: 4, status: 'active', verificationToken: TOK } },
    { data: { id: 'c-g002', contract_number: 'PC-G002', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Void School', currency: 'MWK', prepaid_amount: 1000, max_assessments: 4, status: 'cancelled', verificationToken: TOK } },
    { data: { id: 'c-g003', contract_number: 'PC-G003', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Complete School', currency: 'MWK', prepaid_amount: 8000, max_assessments: 4, status: 'active', verificationToken: TOK } },
    { data: { id: 'c-g004', contract_number: 'PC-G004', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'New School', currency: 'MWK', prepaid_amount: 8000, max_assessments: 4, status: 'active', verificationToken: TOK } },
    { data: { id: 'c-g005', contract_number: 'PC-G005', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Mixed School', currency: 'MWK', prepaid_amount: 8000, max_assessments: 4, status: 'active', verificationToken: TOK } },
    { data: { id: 'c-g006', contract_number: 'PC-G006', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Zero School', currency: 'MWK', prepaid_amount: 0, max_assessments: 0, status: 'active', verificationToken: TOK } },
    { data: { id: 'c-g007', contract_number: 'PC-G007', starts_at: '2026-01-05', customer_id: 'CUST-1', customerName: 'Missing Total School', currency: 'MWK', prepaid_amount: 0, status: 'active', verificationToken: TOK } },
    // PC-P726/024 regression: a stored placeholder name must never be echoed.
    // The customer reference is the bare id, so the school name is the only
    // usable party name left.
    { data: { id: 'c-g008', contract_number: 'PC-G008', starts_at: '2026-01-05', customer_id: 'CUST-0035', customerName: '_', schoolName: 'Placeholder Primary', currency: 'MWK', prepaid_amount: 1000, max_assessments: 4, status: 'active', verificationToken: TOK } },
  ],
  assessment_contract_items: [
    { id: 'i-g001-1', data: { id: 'i-g001-1', contract_id: 'c-g001', status: 'consumed', item_price: 1250 } },
    { id: 'i-g001-2', data: { id: 'i-g001-2', contract_id: 'c-g001', status: 'reserved', item_price: 1250 } },
    { id: 'i-g001-3', data: { id: 'i-g001-3', contract_id: 'c-g001', status: 'reserved', item_price: 1250 } },
    { id: 'i-g001-4', data: { id: 'i-g001-4', contract_id: 'c-g001', status: 'reserved', item_price: 1250 } },
    { id: 'i-g002-1', data: { id: 'i-g002-1', contract_id: 'c-g002', status: 'consumed', item_price: 250 } },
    { id: 'i-g003-1', data: { id: 'i-g003-1', contract_id: 'c-g003', status: 'consumed' } },
    { id: 'i-g003-2', data: { id: 'i-g003-2', contract_id: 'c-g003', status: 'CONSUMED' } },
    { id: 'i-g003-3', data: { id: 'i-g003-3', contract_id: 'c-g003', status: 'consumed' } },
    { id: 'i-g003-4', data: { id: 'i-g003-4', contract_id: 'c-g003', status: 'consumed' } },
    { id: 'i-g005-1', data: { id: 'i-g005-1', contract_id: 'c-g005', status: 'consumed' } },
    // Duplicate delivery of the same canonical item must not be counted twice.
    { id: 'i-g005-1', data: { id: 'i-g005-1', contract_id: 'c-g005', status: 'consumed' } },
    { id: 'i-g005-2', data: { id: 'i-g005-2', contract_id: 'c-g005', status: 'reserved' } },
    { id: 'i-g005-3', data: { id: 'i-g005-3', contract_id: 'c-g005', status: 'cancelled' } },
    { id: 'i-g005-4', data: { id: 'i-g005-4', contract_id: 'c-g005', status: 'reversed' } },
    { id: 'i-g005-5', data: { id: 'i-g005-5', contract_id: 'c-g005', status: 'released' } },
    { id: 'i-g005-6', data: { id: 'i-g005-6', contract_id: 'c-g005', status: 'pending' } },
    { id: 'i-g005-7', data: { id: 'i-g005-7', contract_id: 'c-g005', status: 'consumed', deleted: true } },
    { id: 'i-g006-1', data: { id: 'i-g006-1', contract_id: 'c-g006', status: 'consumed' } },
    { id: 'i-g007-1', data: { id: 'i-g007-1', contract_id: 'c-g007', status: 'consumed' } },
  ],
  // Immutable per-version schedule snapshots (Phase 3 Â§4). One row per issue,
  // each with its OWN token/status â€” the token alone identifies the version.
  // PC-G001 also exists in assessment_contracts above, which is exactly the
  // legacy-fallback case the verifier must distinguish.
  contract_documents: [
    {
      id: 'SCH-PC-G001-v1',
      data: {
        id: 'SCH-PC-G001-v1', documentType: 'printing_contract_schedule', documentNumber: 'PC-G001',
        documentVersion: 1, contractVersion: 1, contentHash: 'a'.repeat(64), hashVersion: 2,
        verificationToken: S1, issuedAt: '2026-01-05T08:00:00.000Z', status: 'SUPERSEDED',
        content: { contractNumber: 'PC-G001', customerName: 'Contract School', currency: 'MWK', periodStart: '2026-01-05', periodEnd: '2026-12-31', schedule: [{ sequence: 1 }] },
      },
    },
    {
      id: 'SCH-PC-G001-v2',
      data: {
        id: 'SCH-PC-G001-v2', documentType: 'printing_contract_schedule', documentNumber: 'PC-G001',
        documentVersion: 2, contractVersion: 2, contentHash: 'b'.repeat(64), hashVersion: 2,
        verificationToken: S2, issuedAt: '2026-02-10T09:30:00.000Z', status: 'VALID',
        content: { contractNumber: 'PC-G001', customerName: 'Contract School', currency: 'MWK', periodStart: '2026-01-05', periodEnd: '2026-12-31', schedule: [{ sequence: 1 }, { sequence: 2 }] },
      },
    },
    {
      id: 'SCH-PC-G001-v3',
      data: {
        id: 'SCH-PC-G001-v3', documentType: 'printing_contract_schedule', documentNumber: 'PC-G001',
        documentVersion: 3, contractVersion: 3, contentHash: 'c'.repeat(64), hashVersion: 2,
        verificationToken: S3, issuedAt: '2026-03-01T10:00:00.000Z', status: 'VOID',
        content: { contractNumber: 'PC-G001', customerName: 'Contract School', currency: 'MWK', periodStart: '2026-01-05', periodEnd: '2026-12-31', schedule: [{ sequence: 1 }] },
      },
    },
    // Integrity failure fixture: contentHash is deliberately wrong (set in
    // before()). A row whose frozen content no longer matches its digest must
    // never verify or download.
    {
      id: 'SCH-PC-G001-tampered',
      data: {
        id: 'SCH-PC-G001-tampered', documentType: 'printing_contract_schedule', documentNumber: 'PC-TAMPER',
        documentVersion: 1, contractVersion: 1, contentHash: '', hashVersion: 2,
        verificationToken: S4, issuedAt: '2026-04-01T10:00:00.000Z', status: 'VALID',
        content: { contractNumber: 'PC-TAMPER', customerName: 'Contract School', currency: 'MWK', schedule: [{ sequence: 1 }] },
      },
    },
    // A schedule whose content ALSO carries the issued version's identity
    // (`documentId` / `documentVersion`). A client injects the identity into
    // the content after hashing it, so the digest excludes it - the server must
    // accept that shape, or every schedule issued by a newer client fails its
    // integrity check and reads as "document not found".
    {
      id: 'SCH-PC-G001-v3',
      data: {
        id: 'SCH-PC-G001-v3', documentType: 'printing_contract_schedule', documentNumber: 'PC-G001',
        documentVersion: 3, contractVersion: 3, contentHash: 'c'.repeat(64), hashVersion: 2,
        verificationToken: S3, issuedAt: '2026-03-01T09:00:00.000Z', status: 'VALID',
        content: {
          documentId: 'SCH-PC-G001-v3', documentVersion: 3,
          contractNumber: 'PC-G001', customerName: 'Contract School', currency: 'MWK',
          periodStart: '2026-01-05', periodEnd: '2026-12-31', schedule: [{ sequence: 1 }],
        },
      },
    },
    // A completion receipt is its OWN issued version: its own number, token,
    // hash and frozen content. The receipt must verify as the receipt, never
    // as the parent contract.
    {
      id: 'PCR-PC-G001-v1',
      data: {
        id: 'PCR-PC-G001-v1', documentType: 'printing_contract_completion_receipt',
        documentNumber: 'PCR-PC-G001', contractNumber: 'PC-G001', assessmentItemId: 'A-G001-1',
        documentVersion: 1, contentHash: 'e'.repeat(64),
        verificationToken: S5, issuedAt: '2026-03-05T07:45:00.000Z', status: 'VALID',
        content: {
          receiptNumber: 'PCR-PC-G001', contractNumber: 'PC-G001', customerName: 'Contract School',
          schoolName: 'Contract School', date: '2026-03-05', currency: 'MWK',
          item: { assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', unitPrice: 5000 },
          amountDebited: 5000, completedToDate: 1, totalConsumedToDate: 5000, totalAssessments: 2,
          remainingAssessments: 1, contractValue: 10000, remainingReservedFunds: 5000,
          unallocatedFunds: 0, walletBalanceAfter: 5000, status: 'VALID',
        },
      },
    },
  ],
};

function startStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const table = url.pathname.split('/').pop();
    if (req.method !== 'GET' || !TABLES[table] || MISSING_TABLES.has(table)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"code":"PGRST205","message":"Could not find the table in the schema cache"}');
      return;
    }
    // PostgREST `or` grammar: `(a.eq."1",b.eq."2")` â€” EVERY item in the list
    // counts, and a row matches when ANY of its fields equals ANY of the
    // values. The stub honours the whole list (a document may be reachable
    // under more than one number form).
    const or = url.searchParams.get('or') || '';
    const directContractId = url.searchParams.get('data->>contract_id') || '';
    const wanted = Array.from(or.matchAll(/eq\."([^"]*)"/g)).map((m) => m[1]);
    const wantedUnquoted = wanted.length
      ? wanted
      : Array.from(or.matchAll(/eq\.([^,)]+)/g)).map((m) => decodeURIComponent(m[1]));
    const direct = directContractId.match(/^eq\.(.+)$/);
    if (direct) wantedUnquoted.push(decodeURIComponent(direct[1]));
    const rows = TABLES[table].filter((r) => {
      const d = r.data || r;
      return Object.values(d).some((v) => wantedUnquoted.includes(String(v ?? '')));
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
  // Give every versioned schedule fixture a REAL digest, and leave the tampered
  // fixture with a digest that does not match its content.
  for (const row of TABLES.contract_documents) {
    const d = row.data;
    if (d.documentType === 'printing_contract_schedule') {
      d.contentHash = integrity.hashScheduleV2(d.content);
      d.content.contentHash = d.contentHash;
    }
    if (d.documentType === 'printing_contract_completion_receipt') {
      d.contentHash = integrity.hashReceiptContent(d.content);
      d.content.contentHash = d.contentHash;
    }
  }
  const tampered = TABLES.contract_documents.find((r) => r.data.id === 'SCH-PC-G001-tampered');
  if (tampered) tampered.data.contentHash = 'f'.repeat(64);

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

  it('purchase order verifies from the canonical purchase_orders table', async () => {
    const res = await request(app).get(good('purchase_order', 'PO-G002', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.purchaseOrderNumber, 'PO-G002');
    assert.equal(res.body.supplierName, 'Canonical Supplier');
    assert.equal(res.body.total, 120000);
  });

  it('canonical purchase_orders wins over legacy purchases for the same number', async () => {
    const res = await request(app).get(good('purchase_order', 'PO-G003', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.supplierName, 'Canonical Supplier');
    assert.equal(res.body.total, 2000);
  });

  it('supplier payment verifies with safe payment shape', async () => {
    const res = await request(app).get(good('supplier_payment', 'SPAY-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.paymentNumber, 'SPAY-G001');
    assert.equal(res.body.amount, 25000);
    assert.equal(res.body.paymentMethod, 'Bank Transfer');
    assert.equal(res.body.status, 'PAID');
  });

  it('voided supplier payment verifies as VOID', async () => {
    const res = await request(app).get(good('supplier_payment', 'SPAY-G002', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'VOID');
  });

  it('statement verifies the snapshot summary only (no transactions, no contacts)', async () => {
    const res = await request(app).get(good('statement', 'STMT-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.statementNumber, 'STMT-G001');
    assert.equal(res.body.closingBalance, 400);
    assert.equal(res.body.status, 'VALID');
    assert.ok(!('transactions' in res.body), 'transaction history must not be exposed');
  });

  it('superseded statement verifies as authentic with SUPERSEDED status (flat data.status contract)', async () => {
    const res = await request(app).get(good('statement', 'STMT-G002', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.status, 'SUPERSEDED');
    assert.equal(res.body.statementNumber, 'STMT-G002');
  });

  it('delivery note verifies with reference', async () => {
    const res = await request(app).get(good('delivery_note', 'DN-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.deliveryNoteNumber, 'DN-G001');
    assert.equal(res.body.reference, 'INV-G001');
    assert.equal(res.body.status, 'Delivered');
  });

  it('printing contract verifies with safe contract shape', async () => {
    const res = await request(app).get(good('printing_contract', 'PC-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.documentType, 'printing_contract');
    assert.equal(res.body.contractNumber, 'PC-G001');
    assert.equal(res.body.customerName, 'Contract School');
    assert.equal(res.body.prepaidTotal, 5000);
    assert.equal(res.body.status, 'ACTIVE');
  });

  it('printing contract never echoes a placeholder customer name or bare id', async () => {
    const res = await request(app).get(good('printing_contract', 'PC-G008', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.contractNumber, 'PC-G008');
    // Contract PC-P726/024 regression: stored "_" must resolve to the school,
    // never be printed as a placeholder or as the CUST-0035 reference.
    assert.equal(res.body.customerName, 'Placeholder Primary');
    assert.notEqual(res.body.customerName, '_');
    assert.doesNotMatch(String(res.body.customerName), /^CUST-/);
  });

  it('hyphenated QR slugs verify (printing-contract, sales-order)', async () => {
    const hyphen = await request(app).get(good('printing-contract', 'PC-G001', TOK));
    assert.equal(hyphen.status, 200);
    assert.equal(hyphen.body.contractNumber, 'PC-G001');
    const so = await request(app).get(good('sales-order', 'SO-G001', TOK));
    assert.equal(so.status, 200);
    assert.equal(so.body.orderNumber, 'SO-G001');
  });

  it('contract schedule verifies as the EXACT issued version, not the parent contract', async () => {
    // The QR token identifies the version. v2 is the current one.
    const current = await request(app).get(good('printing_contract_schedule', 'PC-G001', S2));
    assert.equal(current.status, 200);
    assert.equal(current.body.verified, true);
    assert.equal(current.body.documentType, 'printing_contract_schedule');
    assert.equal(current.body.verificationScope, 'version');
    assert.equal(current.body.contractNumber, 'PC-G001');
    assert.equal(current.body.scheduleVersion, 2);
    assert.equal(current.body.status, 'VALID');
    assert.equal(current.body.integrity, 'sha256-verified');
    // The scan result carries the version's OWN identity and the digest of
    // its frozen content: the document id is NOT printed on the schedule, so
    // this is where the customer reads it, and the digest is what the printed
    // "Content hash" can be compared against.
    assert.equal(current.body.documentId, 'SCH-PC-G001-v2');
    assert.match(String(current.body.contentHash || ''), /^[0-9a-f]{64}$/);

    // Same number, different token â†’ a DIFFERENT version, reported honestly.
    const superseded = await request(app).get(good('printing_contract_schedule', 'PC-G001', S1));
    assert.equal(superseded.status, 200);
    assert.equal(superseded.body.scheduleVersion, 1);
    assert.equal(superseded.body.status, 'SUPERSEDED');

    const voided = await request(app).get(good('printing_contract_schedule', 'PC-G001', S3));
    assert.equal(voided.status, 200);
    assert.equal(voided.body.scheduleVersion, 3);
    assert.equal(voided.body.status, 'VOID');

    // Hyphenated QR slug (what the printed QR actually encodes).
    const hyphenSchedule = await request(app).get(good('printing-contract-schedule', 'PC-G001', S2));
    assert.equal(hyphenSchedule.status, 200);
    assert.equal(hyphenSchedule.body.documentType, 'printing_contract_schedule');
    assert.equal(hyphenSchedule.body.scheduleVersion, 2);
  });

  it('legacy contract-token schedule QR resolves as contract-scope, never as a version', async () => {
    // Schedules printed before per-version documents encoded the CONTRACT token.
    // They must still verify â€” but they must not claim to be a version match.
    const legacy = await request(app).get(good('printing_contract_schedule', 'PC-G001', TOK));
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.verified, true);
    assert.equal(legacy.body.verificationScope, 'contract');
    assert.equal(legacy.body.contractNumber, 'PC-G001');
    assert.equal(legacy.body.status, 'ACTIVE');
    assert.equal(legacy.body.scheduleVersion, undefined);
    // No fund amounts are disclosed to an unauthenticated caller.
    assert.equal(legacy.body.prepaidTotal, undefined);
    assert.equal(legacy.body.totalAssessments, undefined);
  });

  it('rejects a version whose frozen content no longer matches its digest', async () => {
    // The row's token is valid and its status is VALID, but the content hash is
    // wrong: integrity fails closed rather than reporting a tampered document.
    const res = await request(app).get(good('printing_contract_schedule', 'PC-TAMPER', S4));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
    assert.ok(!JSON.stringify(res.body).includes(S4));
  });

  it('keeps legacy verification working when contract_documents is not deployed', async () => {
    MISSING_TABLES.add('contract_documents');
    try {
      // The contract still verifies at contract scope from assessment_contracts.
      const legacy = await request(app).get(good('printing_contract_schedule', 'PC-G001', TOK));
      assert.equal(legacy.status, 200);
      assert.equal(legacy.body.verificationScope, 'contract');
      assert.equal(legacy.body.status, 'ACTIVE');

      // A per-version token cannot resolve without the version table: fail
      // closed, never fall back to presenting live contract data as a version.
      const version = await request(app).get(good('printing_contract_schedule', 'PC-G001', S2));
      assert.equal(version.status, 404);
      assert.equal(version.body.verified, false);
    } finally {
      MISSING_TABLES.delete('contract_documents');
    }
  });

  it('distinguishes a missing schema from an invalid token internally', async () => {
    // Direct service call (the public route intentionally collapses both into a
    // generic 404). `reason` is internal diagnostics only.
    const { verifyDocument } = require('../services/documentVerificationService.cjs');
    const missingGet = async () => {
      const err = new Error('missing');
      err.response = { status: 404, data: { code: 'PGRST205' } };
      throw err;
    };
    const missing = await verifyDocument('printing_contract_schedule', 'PC-G001', S2, { httpGet: missingGet });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'table_missing');

    // Schema present, rows found, token wrong â†’ token_mismatch, not table_missing.
    const stubGet = async (url, config) => {
      const table = String(url).split('/').pop();
      return { data: (TABLES[table] || []).filter((r) => {
        const d = r.data || r;
        return Object.values(d).some((v) => String(v ?? '').includes('PC-G001'));
      }) };
    };
    const mismatch = await verifyDocument('printing_contract_schedule', 'PC-G001', BAD, { httpGet: stubGet });
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.reason, 'token_mismatch');
  });

  it('contract schedule rejects a wrong token or a mismatched number', async () => {
    const badTok = await request(app).get(good('printing_contract_schedule', 'PC-G001', BAD));
    assert.equal(badTok.status, 404);
    // A valid version token presented against a different number must not leak.
    const mismatched = await request(app).get(good('printing_contract_schedule', 'PC-9999', S2));
    assert.equal(mismatched.status, 404);
    for (const r of [badTok, mismatched]) {
      assert.equal(r.body.verified, false);
      assert.ok(!JSON.stringify(r.body).includes(S2));
    }
  });

  it('a schedule whose content carries the issued identity still verifies', async () => {
    // The client injects `documentId` / `documentVersion` into the content
    // AFTER hashing it (the version number is allocated once the digest is
    // known), so the digest EXCLUDES them. The server must accept that shape:
    // otherwise every schedule issued by a newer client fails its integrity
    // check and a scanner is told "document not found".
    const res = await request(app).get(good('printing_contract_schedule', 'PC-G001', S3));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.documentId, 'SCH-PC-G001-v3');
    assert.equal(res.body.scheduleVersion, 3);
    assert.equal(res.body.integrity, 'sha256-verified');
  });

  it('completion receipt verifies as ITS OWN issued receipt, not as the contract', async () => {
    const res = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G001', S5));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.documentType, 'printing_contract_completion_receipt');
    assert.equal(res.body.verificationScope, 'version');
    assert.equal(res.body.documentId, 'PCR-PC-G001-v1');
    assert.equal(res.body.receiptNumber, 'PCR-PC-G001');
    assert.equal(res.body.contractNumber, 'PC-G001');
    assert.equal(res.body.integrity, 'sha256-verified');
    // The RECEIPT's own facts, not the parent contract's.
    assert.equal(res.body.amountDebited, 5000);
    assert.equal(res.body.completedToDate, 1);
    assert.equal(res.body.remainingAssessments, 1);
    assert.equal(res.body.remainingReservedFunds, 5000);
    assert.equal(res.body.assessmentName, 'Assessment - Standard 8 - All');
    // The parent contract's prepaid total is NOT the receipt's story.
    assert.equal(res.body.prepaidTotal, undefined);
  });

  it('completion receipt verifies against the parent contract', async () => {
    // The LEGACY shape: a receipt printed before per-version documents existed
    // encoded the contract's number and token, so the contract is affirmed and
    // no receipt version is claimed.
    const receipt = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G001', TOK));
    assert.equal(receipt.status, 200);
    assert.equal(receipt.body.verified, true);
    assert.equal(receipt.body.documentType, 'printing_contract_completion_receipt');
    assert.equal(receipt.body.receiptNumber, 'PCR-PC-G001');
    assert.equal(receipt.body.contractNumber, 'PC-G001');
    assert.equal(receipt.body.verificationScope, 'contract');

    const hyphenReceipt = await request(app).get(good('printing-contract-completion-receipt', 'PCR-PC-G001', TOK));
    assert.equal(hyphenReceipt.status, 200);
    assert.equal(hyphenReceipt.body.documentType, 'printing_contract_completion_receipt');

    // Wrong token stays a generic 404.
    const badTok = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G001', BAD));
    assert.equal(badTok.status, 404);
  });

  it('completion receipt reports 1 / 4 completed and 3 remaining from assessment records', async () => {
    const res = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAssessments, 4);
    assert.equal(res.body.completedToDate, 1);
    assert.equal(res.body.remainingAssessments, 3);
    assert.equal(res.body.prepaidTotal, undefined);
  });

  it('completion receipt reports 4 / 4 and 0 remaining when every assessment is consumed', async () => {
    const res = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G003', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAssessments, 4);
    assert.equal(res.body.completedToDate, 4);
    assert.equal(res.body.remainingAssessments, 0);
    assert.equal(res.body.prepaidTotal, undefined);
  });

  it('completion receipt reports 0 / 4 and 4 remaining when nothing is consumed', async () => {
    const res = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G004', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAssessments, 4);
    assert.equal(res.body.completedToDate, 0);
    assert.equal(res.body.remainingAssessments, 4);
    assert.equal(res.body.prepaidTotal, undefined);
  });

  it('completion progress excludes cancelled, reversed, released, pending, deleted and duplicate rows', async () => {
    const res = await request(app).get(good('printing_contract_completion_receipt', 'PCR-PC-G005', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.totalAssessments, 4);
    assert.equal(res.body.completedToDate, 1);
    assert.equal(res.body.remainingAssessments, 3);
    assert.equal(res.body.prepaidTotal, undefined);
  });

  it('completion progress handles a zero or missing contractual total safely', async () => {
    for (const number of ['PCR-PC-G006', 'PCR-PC-G007']) {
      const res = await request(app).get(good('printing_contract_completion_receipt', number, TOK));
      assert.equal(res.status, 200, number);
      assert.equal(res.body.totalAssessments, 0, number);
      assert.equal(res.body.completedToDate, 0, number);
      assert.equal(res.body.remainingAssessments, 0, number);
      assert.ok(!/NaN|Infinity/i.test(JSON.stringify(res.body)), number);
      assert.equal(res.body.prepaidTotal, undefined, number);
    }
  });

  it('ordinary printing contract keeps its prepaid total', async () => {
    const res = await request(app).get(good('printing_contract', 'PC-G001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.prepaidTotal, 5000);
    assert.equal(res.body.totalAssessments, 4);
  });

  it('cancelled printing contract verifies as authentic with CANCELLED status', async () => {
    const res = await request(app).get(good('printing_contract', 'PC-G002', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.status, 'CANCELLED');
  });

  it('printing contract rejects wrong token and wrong number', async () => {
    const badTok = await request(app).get(good('printing_contract', 'PC-G001', BAD));
    assert.equal(badTok.status, 404);
    const badNum = await request(app).get(good('printing_contract', 'PC-9999', TOK));
    assert.equal(badNum.status, 404);
    for (const r of [badTok, badNum]) {
      assert.equal(r.body.verified, false);
      assert.ok(!JSON.stringify(r.body).includes(TOK));
    }
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
      'deliveryNoteNumber', 'deliveryDate', 'paymentNumber', 'paymentDate',
      'statementNumber', 'statementDate', 'statementPeriodStart', 'statementPeriodEnd',
      'contractNumber', 'contractDate', 'prepaidTotal', 'totalAssessments',
      'completedToDate', 'remainingAssessments',
      'companyName', 'customerName', 'supplierName',
      'currency', 'subtotal', 'tax', 'total', 'amount', 'amountPaid', 'balanceDue',
      'openingBalance', 'totalInvoiced', 'totalReceived', 'closingBalance',
      'paymentMethod', 'reference', 'validUntil', 'status',
      // Schedule version identity: which issued version the QR points at, and
      // whether that reference is a version or a legacy parent-contract link.
      'verificationScope', 'scheduleVersion', 'issuedAt', 'periodStart', 'periodEnd',
      // The issued version's own identity and the digest of its frozen
      // content. Both are what the customer reads AFTER scanning the QR (they
      // are deliberately not printed on the schedule), and the digest is the
      // one printed on the document, so the two can be compared.
      'documentId', 'contentHash',
      // Completion receipt: what the receipt closed and the position it left
      // behind. The receipt is its own issued version, never the parent
      // contract.
      'assessmentName', 'amountDebited', 'completedToDate', 'totalConsumedToDate',
      'remainingAssessments', 'remainingReservedFunds', 'unallocatedFunds',
      'contractValue', 'walletBalanceAfter', 'schoolName', 'receiptNumber',
      // Server-side content integrity of the exact frozen version.
      'integrity',
      // Statement account scope (branch isolation). These three keys let a
      // verifier distinguish a BRANCH statement from the Main statement. The
      // stable branch id travels inside `branchKey` (`id:<branchId>`), so no
      // raw `subAccountId` field is exposed.
      'branchKey', 'branchLabel', 'scopeAmbiguous',
    ]);
    const forbidden = ['password', 'email', 'phone', 'address', 'audit', 'journal', 'ledger', 'verificationToken', 'token', 'secret', 'supabase', 'user_id', 'sync', 'accountid', 'glaccount', 'transactions', 'customerid', 'supersededby'];
    const cases = [
      ['invoice', 'INV-G001'], ['receipt', 'PAY-G001'], ['quotation', 'QTN-G001'],
      ['sales_order', 'SO-G001'], ['purchase_order', 'PO-G001'], ['delivery_note', 'DN-G001'],
      ['supplier_payment', 'SPAY-G001'], ['statement', 'STMT-G001'], ['statement', 'STMT-G003'], ['printing_contract', 'PC-G001'],
      ['printing_contract_schedule', 'PC-G001'], ['printing_contract_schedule', 'PC-G001', S2],
      ['printing_contract_completion_receipt', 'PCR-PC-G001'],
    ];
    for (const [type, num, tok = TOK] of cases) {
      const res = await request(app).get(good(type, num, tok));
      assert.equal(res.status, 200, type);
      for (const key of Object.keys(res.body)) assert.ok(allowed.has(key), `${type}: unexpected key ${key}`);
      const blob = JSON.stringify(res.body).toLowerCase();
      for (const bad of forbidden) assert.ok(!blob.includes(bad), `${type} leaked: ${bad}`);
    }
  });

  it('statement: a branch statement is never presented as the Main statement', async () => {
    const branch = await request(app).get(good('statement', 'STMT-G003', TOK));
    assert.equal(branch.status, 200);
    assert.equal(branch.body.branchKey, 'id:SUB-A');
    assert.equal(branch.body.branchLabel, 'Exam Centre');
    assert.equal(branch.body.scopeAmbiguous, false);

    // A legacy snapshot with no branch field predates account scope: it is
    // presented as Main but explicitly flagged, never assumed tagged.
    const legacy = await request(app).get(good('statement', 'STMT-G001', TOK));
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.branchKey, null);
    assert.equal(legacy.body.branchLabel, null);
    assert.equal(legacy.body.scopeAmbiguous, true);
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

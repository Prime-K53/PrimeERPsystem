/**
 * publicDocumentDownload.test.cjs
 *
 * GET /api/public/documents/download/:documentType/:documentNumber?t=<token>
 *
 * Regression cover for the reported failure: a document that verifies (the
 * stub page renders it) but whose download returned
 * "Document data is invalid: Statement is missing required field: Start date",
 * which the route collapsed into the same generic 404 as "not found".
 *
 * Local stub HTTP store + mocked renderer — no network, no credentials,
 * no writes. The canonical renderer itself is covered by
 * officialDocumentRendererAliases.test.cjs and the verify*.cjs scripts.
 */
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOK = 'b'.repeat(64);
const BAD = 'c'.repeat(64);
const PDF = Buffer.from('%PDF-1.4 stub\n%%EOF\n');

const renderOfficialPdf = jest.fn(async () => ({ buffer: PDF, contentType: 'application/pdf' }));

jest.mock('../services/officialDocumentService.cjs', () => {
  const actual = jest.requireActual('../services/officialDocumentService.cjs');
  return {
    ...actual,
    renderOfficialPdf: (...args) => renderOfficialPdf(...args),
  };
});

// Stored ERP record shapes exactly as the ERP persists them.
const TABLES = {
  invoices: [
    { data: { id: 'INV-P726/093', invoiceNumber: 'INV-P726/093', date: '2026-09-01', customerName: 'Acme School', currency: 'MWK', subtotal: 100000, tax: 0, totalAmount: 100000, paidAmount: 100000, status: 'Paid', verificationToken: TOK } },
  ],
  statement_snapshots: [
    { id: 'STMT-P726/021', data: { id: 'STMT-P726/021', statementNumber: 'STMT-P726/021', statementDate: '2026-10-03', periodStart: '2026-01-01', periodEnd: '2026-10-03', customerName: 'Mlunduni Primary School', currency: 'MWK', openingBalance: 0, transactions: [{ date: '2026-10-01', reference: 'INV-P726/093', debit: 65000, credit: 0, runningBalance: 65000 }], totalInvoiced: 65000, totalReceived: 0, closingBalance: 65000, status: 'VALID', verificationToken: TOK } },
    { id: 'STMT-P726/022', data: { id: 'STMT-P726/022', statementNumber: 'STMT-P726/022', statementDate: '2026-09-01', periodStart: '2026-06-01', periodEnd: '2026-08-31', customerName: 'Mlunduni Primary School', currency: 'MWK', openingBalance: 10, transactions: [{ date: '2026-07-01', reference: 'INV-OLD', debit: 5, credit: 0, runningBalance: 15 }], totalInvoiced: 5, totalReceived: 0, closingBalance: 15, status: 'SUPERSEDED', supersededBy: 'STMT-P726/021', verificationToken: TOK } },
  ],
  customer_payments: [
    { data: { id: 'PAY-P726/021', date: '2026-09-03', customerName: 'Acme School', amount: 70000, paymentMethod: 'Bank', status: 'Cleared', verificationToken: TOK } },
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
    let wanted = m ? decodeURIComponent(m[1]) : '';
    if (wanted.startsWith('"') && wanted.endsWith('"')) wanted = wanted.slice(1, -1);
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
const dl = (type, n, t) => `/api/public/documents/download/${type}/${encodeURIComponent(n)}${t === null ? '' : `?t=${t}`}`;

beforeAll(async () => {
  stub = await startStub();
  process.env.SUPABASE_URL = `http://127.0.0.1:${stub.address().port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.COMPANY_NAME = 'Prime Printing Service';
  app = express();
  app.use('/api/public/documents', require('../routes/documentVerify.cjs'));
  app.use('/api/public/documents', require('../routes/publicDocumentDownload.cjs'));
});

afterAll(() => new Promise((resolve) => stub.close(resolve)));
beforeEach(() => renderOfficialPdf.mockClear());

describe('public document download — the verified document downloads', () => {
  it('downloads a statement whose number contains "/" (percent-encoded)', async () => {
    const res = await request(app).get(dl('statement', 'STMT-P726/021', TOK));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="STMT-P726_021.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('resolves the statement through the canonical renderer as ACCOUNT_STATEMENT with the portal channel', async () => {
    await request(app).get(dl('statement', 'STMT-P726/021', TOK));
    expect(renderOfficialPdf).toHaveBeenCalledTimes(1);
    const arg = renderOfficialPdf.mock.calls[0][0];
    expect(arg.type).toBe('statement');
    expect(arg.channel).toBe('portal');
    expect(arg.rawData.statementNumber).toBe('STMT-P726/021');
    expect(arg.rawData.verificationToken).toBe(TOK);
  });

  it('downloads an invoice (no regression)', async () => {
    const res = await request(app).get(dl('invoice', 'INV-P726/093', TOK));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="INV-P726_093.pdf"');
  });

  it('downloads a customer receipt', async () => {
    const res = await request(app).get(dl('receipt', 'PAY-P726/021', TOK));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('still serves a SUPERSEDED statement (authentic-but-terminal snapshot, not an expiry mechanism)', async () => {
    const res = await request(app).get(dl('statement', 'STMT-P726/022', TOK));
    expect(res.status).toBe(200);
    expect(res.body.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const arg = renderOfficialPdf.mock.calls[0][0];
    expect(arg.rawData.statementNumber).toBe('STMT-P726/022');
  });

  it('accepts the hyphenated URL slug and normalizes it like the verify route', async () => {
    const res = await request(app).get(`/api/public/documents/download/sales-order/SO-1?t=${TOK}`);
    expect(res.status).toBe(404);
    expect(res.body.verified).toBe(false);
  });
});

describe('public document download — security contract unchanged', () => {
  it('rejects invalid token, missing token, unknown number, wrong type and foreign token', async () => {
    const cases = [
      ['invalid token', dl('statement', 'STMT-P726/021', BAD)],
      ['missing token', dl('statement', 'STMT-P726/021', null)],
      ['unknown number', dl('statement', 'STMT-NOPE', TOK)],
      ['unsupported type', dl('bogus', 'STMT-P726/021', TOK)],
      ['right token wrong table', dl('receipt', 'STMT-P726/021', TOK)],
    ];
    for (const [label, url] of cases) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.body.verified).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain(TOK);
      expect(res.headers['content-type']).toMatch(/application\/json/);
    }
  });

  it('never renders a PDF for an unverified request', async () => {
    await request(app).get(dl('statement', 'STMT-P726/021', BAD));
    await request(app).get(dl('statement', 'STMT-NOPE', TOK));
    await request(app).get(dl('statement', 'STMT-P726/021', null));
    expect(renderOfficialPdf).not.toHaveBeenCalled();
  });

  it('does not fall back to another document with a similar number', async () => {
    const res = await request(app).get(dl('statement', 'STMT-P726/0211', TOK));
    expect(res.status).toBe(404);
    expect(renderOfficialPdf).not.toHaveBeenCalled();
  });

  it('is read-only: non-GET methods are not routed', async () => {
    for (const method of ['post', 'put', 'delete', 'patch']) {
      const res = await request(app)[method](dl('statement', 'STMT-P726/021', TOK));
      expect(res.status).toBe(404);
    }
    expect(renderOfficialPdf).not.toHaveBeenCalled();
  });

  it('reports a renderer failure without leaking whether the token was valid', async () => {
    renderOfficialPdf.mockImplementationOnce(async () => { throw new Error('Document data is invalid: Statement is missing required field: Start date'); });
    const res = await request(app).get(dl('statement', 'STMT-P726/021', TOK));
    expect(res.status).toBe(404);
    expect(res.body.verified).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('Start date');
    expect(JSON.stringify(res.body)).not.toContain(TOK);
  });
});
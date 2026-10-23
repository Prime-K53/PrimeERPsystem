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
// Per-version schedule tokens (deliberately different from the contract token).
const SV = 'd'.repeat(64);
const SV_OLD = 'f'.repeat(64);
const SV_LEGACY = '9'.repeat(64);
// Tables toggled to return a PostgREST 404 (missing table) during a test.
const MISSING_TABLES = new Set();
const PDF = Buffer.from('%PDF-1.4 stub\n%%EOF\n');
const integrity = require('../services/documentIntegrity.cjs');

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
  // Parent contract: this is what a LEGACY schedule QR encoded. It has no
  // frozen content, so the exact printed version cannot be reproduced.
  assessment_contracts: [
    { data: { id: 'c-p726', contract_number: 'PC-P726/001', starts_at: '2026-01-05', customerName: 'Mlunduni Primary School', currency: 'MWK', prepaid_amount: 319200, status: 'active', verificationToken: TOK } },
  ],
  // Per-version schedule snapshots: the download must render the FROZEN
  // content of the exact version the QR points at.
  contract_documents: [
    {
      id: 'SCH-P726-v1',
      data: {
        id: 'SCH-P726-v1', documentType: 'printing_contract_schedule', documentNumber: 'PC-P726/001',
        documentVersion: 1, contentHash: 'a'.repeat(64), hashVersion: 2,
        verificationToken: SV_OLD, issuedAt: '2026-02-01T08:00:00.000Z', status: 'SUPERSEDED',
        content: {
          documentType: 'CONTRACT_SCHEDULE', contractNumber: 'PC-P726/001', contractVersion: 1,
          customerName: 'Mlunduni Primary School', currency: 'MWK',
          periodStart: '2026-01-05', periodEnd: '2026-12-31', date: '2026-02-01',
          // Historical defect being regressed: the frozen content embeds the
          // PARENT contract token instead of this version's token.
          verificationToken: TOK,
          schedule: [{ sequence: 1, assessmentDate: '2026-02-10', amount: 79800, status: 'reserved' }],
          contentHash: 'a'.repeat(64), hashVersion: 2,
        },
      },
    },
    {
      id: 'SCH-P726-v2',
      data: {
        id: 'SCH-P726-v2', documentType: 'printing_contract_schedule', documentNumber: 'PC-P726/001',
        documentVersion: 2, contentHash: 'b'.repeat(64), hashVersion: 2,
        verificationToken: SV, issuedAt: '2026-03-01T08:00:00.000Z', status: 'VALID',
        content: {
          documentType: 'CONTRACT_SCHEDULE', contractNumber: 'PC-P726/001', contractVersion: 2,
          customerName: 'Mlunduni Primary School', currency: 'MWK',
          periodStart: '2026-01-05', periodEnd: '2026-12-31', date: '2026-03-01',
          // Same historical defect: the frozen token is the contract token, not
          // this version's. The download must overlay the matched row's token.
          verificationToken: TOK,
          schedule: [
            { sequence: 1, assessmentDate: '2026-02-10', amount: 79800, status: 'reserved' },
            { sequence: 2, assessmentDate: '2026-03-10', amount: 79800, status: 'reserved' },
          ],
          contentHash: 'b'.repeat(64), hashVersion: 2,
        },
      },
    },
    // A LEGACY (pre-Phase-2) schedule: no hashVersion marker, so it was
    // hashed by the old builder, whose `undefined` optionals JSONB dropped.
    // It must still verify and download.
    {
      id: 'SCH-P726-legacy-v1',
      data: {
        id: 'SCH-P726-legacy-v1', documentType: 'printing_contract_schedule', documentNumber: 'PC-P726/002',
        documentVersion: 1,
        verificationToken: SV_LEGACY, issuedAt: '2026-04-02T08:00:00.000Z', status: 'VALID',
        content: {
          documentType: 'CONTRACT_SCHEDULE', contractNumber: 'PC-P726/002', contractVersion: 4,
          customerName: 'Mlunduni Primary School', currency: 'MWK',
          periodStart: '2026-01-05', periodEnd: '2026-12-31', date: '02/04/2026',
          schedule: [{ sequence: 1, assessmentDate: '10/04/2026', amount: 79800, status: 'reserved' }],
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
  // Real v2 digests for the frozen fixtures (integrity is enforced server-side).
  for (const row of TABLES.contract_documents) {
    const d = row.data;
    if (d.documentType !== 'printing_contract_schedule') continue;
    // A row without a hashVersion marker was hashed by the LEGACY builder.
    d.contentHash = d.hashVersion
      ? integrity.hashScheduleV2(d.content)
      : integrity.hashScheduleContent(d.content, d.hashVersion);
    d.content.contentHash = d.contentHash;
  }
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

describe('public document download — contract schedule renders the exact issued version', () => {
  it('downloads the frozen content of the versioned schedule', async () => {
    const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.headers['content-disposition']).toBe('attachment; filename="PC-P726_001.pdf"');
    expect(res.headers['cache-control']).toBe('no-store');

    expect(renderOfficialPdf).toHaveBeenCalledTimes(1);
    const arg = renderOfficialPdf.mock.calls[0][0];
    expect(arg.type).toBe('printing_contract_schedule');
    expect(arg.channel).toBe('portal');
    // The frozen snapshot — not a live contract row.
    expect(arg.rawData.contractNumber).toBe('PC-P726/001');
    const v2Hash = TABLES.contract_documents.find((r) => r.data.id === 'SCH-P726-v2').data.contentHash;
    expect(arg.rawData.contentHash).toBe(v2Hash);
    // The QR token is the MATCHED VERSION's token, overlaid for rendering. The
    // frozen content still embeds the historical contract token (TOK); it is
    // never mutated, only overlaid in the render payload.
    expect(arg.rawData.verificationToken).toBe(SV);
    expect(arg.rawData.schedule).toHaveLength(2);
    expect(arg.rawData.schedule[1].assessmentDate).toBe('2026-03-10');
    expect(arg.rawData.prepaid_amount).toBeUndefined();
  });

  it('re-downloads a historical version with a token that verifies at version scope', async () => {
    // End-to-end: download the stored version, inspect the token the renderer
    // would encode in the QR, verify THAT token, then download the same version
    // again. This is the reported defect: the frozen content embedded the parent
    // contract token, so the re-download verified at contract scope and 404'd.
    const first = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV_OLD));
    expect(first.status).toBe(200);
    const rendered = renderOfficialPdf.mock.calls[0][0].rawData;
    expect(rendered.verificationToken).toBe(SV_OLD);

    const verified = await request(app).get(
      `/api/public/documents/verify/printing_contract_schedule/${encodeURIComponent('PC-P726/001')}?t=${rendered.verificationToken}`,
    );
    expect(verified.status).toBe(200);
    expect(verified.body.verificationScope).toBe('version');
    expect(verified.body.scheduleVersion).toBe(1);
    expect(verified.body.status).toBe('SUPERSEDED');
    expect(verified.body.integrity).toBe('sha256-verified');

    renderOfficialPdf.mockClear();
    const again = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV_OLD));
    expect(again.status).toBe(200);
    expect(renderOfficialPdf).toHaveBeenCalledTimes(1);
  });

  it('accepts the hyphenated slug like the verify route', async () => {
    const res = await request(app).get(dl('printing-contract-schedule', 'PC-P726/001', SV));
    expect(res.status).toBe(200);
    expect(renderOfficialPdf).toHaveBeenCalledTimes(1);
  });

  it('renders a superseded version from its own frozen snapshot', async () => {
    const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV_OLD));
    expect(res.status).toBe(200);
    expect(renderOfficialPdf).toHaveBeenCalledTimes(1);
    const arg = renderOfficialPdf.mock.calls[0][0];
    // The OLD printed hash travels with the OLD printed schedule: the download
    // reproduces what was issued, it does not silently upgrade to the current one.
    const v1Hash = TABLES.contract_documents.find((r) => r.data.id === 'SCH-P726-v1').data.contentHash;
    expect(arg.rawData.contentHash).toBe(v1Hash);
    expect(arg.rawData.verificationToken).toBe(SV_OLD);
    expect(arg.rawData.schedule).toHaveLength(1);
  });

  it('fails closed when a stored version no longer matches its digest', async () => {
    const row = TABLES.contract_documents.find((r) => r.data.id === 'SCH-P726-v1');
    const original = row.data;
    row.data = {
      ...original,
      content: {
        ...original.content,
        schedule: [{ ...original.content.schedule[0], amount: 1 }], // frozen hash now stale
      },
    };
    try {
      const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV_OLD));
      expect(res.status).toBe(404);
      expect(res.body.verified).toBe(false);
      // A tampered row is never handed to the renderer.
      expect(renderOfficialPdf).not.toHaveBeenCalled();
    } finally {
      row.data = original;
    }
  });

  it('does not serve a version when contract_documents is not deployed', async () => {
    MISSING_TABLES.add('contract_documents');
    try {
      const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', SV));
      expect(res.status).toBe(404);
      expect(res.body.verified).toBe(false);
      expect(renderOfficialPdf).not.toHaveBeenCalled();
    } finally {
      MISSING_TABLES.delete('contract_documents');
    }
  });

  it('serves and verifies a LEGACY (pre-Phase-2) schedule', async () => {
    // A historical row has no hashVersion marker: it was hashed by the old
    // builder, whose `undefined` optionals JSONB dropped. The server must
    // recompute it with the LEGACY rule, not report it as altered.
    const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/002', SV_LEGACY));
    expect(res.status).toBe(200);
    const arg = renderOfficialPdf.mock.calls[0][0];
    expect(arg.rawData.contractNumber).toBe('PC-P726/002');
    // The row's own token is overlaid so the re-downloaded copy verifies at
    // version scope.
    expect(arg.rawData.verificationToken).toBe(SV_LEGACY);
    const legacyHash = TABLES.contract_documents.find((r) => r.data.id === 'SCH-P726-legacy-v1').data.contentHash;
    expect(arg.rawData.contentHash).toBe(legacyHash);

    const verified = await request(app).get(
      `/api/public/documents/verify/printing_contract_schedule/${encodeURIComponent('PC-P726/002')}?t=${SV_LEGACY}`,
    );
    expect(verified.status).toBe(200);
    expect(verified.body.verificationScope).toBe('version');
    expect(verified.body.integrity).toBe('sha256-verified');
  });

  it('fails closed (404) for a legacy contract-token schedule QR instead of rendering live data', async () => {
    const res = await request(app).get(dl('printing_contract_schedule', 'PC-P726/001', TOK));
    expect(res.status).toBe(404);
    expect(res.body.verified).toBe(false);
    // Critically: the live contract row is never handed to the renderer.
    expect(renderOfficialPdf).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(TOK);
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
      ['schedule: legacy contract token (no frozen version)', dl('printing_contract_schedule', 'PC-P726/001', TOK)],
      ['schedule: version token on a different number', dl('printing_contract_schedule', 'PC-NOPE', SV)],
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
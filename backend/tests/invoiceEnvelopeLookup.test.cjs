/**
 * invoiceEnvelopeLookup.test.cjs
 *
 * Regression for the EXM-P726/021 production outage.
 *
 * Root cause: fetchDocumentRows() issued a flat-column fallback
 *   or=(id.eq."...",invoiceNumber.eq."...")
 * against envelope-shaped tables. No verification table has a top-level
 * `invoiceNumber` (or order_number/dnNumber/...) column — see
 * supabase/migrations/0001 (all tables are `(id PK, data JSONB, ...)`).
 * Production PostgREST rejected it with 42703
 * ("column invoices.invoiceNumber does not exist"), so verification could
 * never reach matchRow() for any envelope-miss.
 *
 * The lookup is now envelope-only (`data->>` filters, which can never
 * 42703). This suite uses a STRICT stub that emulates that production
 * behavior: bare fields other than the real `id` PK column answer HTTP 400
 * with 42703, exactly like production PostgREST.
 *
 * Local stub HTTP store — no network, no credentials, no writes.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOK = '67ac0c47521f23f48a058728237eadc60e59703062f0fa249585788486f774e7';
const BAD = '0'.repeat(64);

// Production-shaped rows: canonical JSONB envelopes as committed by the
// sync gateway ({ id, data: { id, invoiceNumber, verificationToken, ... } }).
const TABLES = {
  invoices: [
    {
      id: 'EXM-P726/021',
      data: {
        id: 'EXM-P726/021',
        invoiceNumber: 'EXM-P726/021',
        date: '2026-09-20',
        customerName: 'Slash School',
        currency: 'MWK',
        subtotal: 2500,
        totalAmount: 2500,
        paidAmount: 0,
        status: 'Unpaid',
        verificationToken: TOK,
      },
    },
    {
      id: 'INV-ORD-001',
      data: {
        id: 'INV-ORD-001',
        invoiceNumber: 'INV-ORD-001',
        date: '2026-09-21',
        customerName: 'Ordinary School',
        currency: 'MWK',
        subtotal: 1000,
        totalAmount: 1000,
        paidAmount: 0,
        status: 'Unpaid',
        verificationToken: 'd'.repeat(64),
      },
    },
    {
      id: 'EXM-NOTOKEN-001',
      data: {
        id: 'EXM-NOTOKEN-001',
        invoiceNumber: 'EXM-NOTOKEN-001',
        date: '2026-09-22',
        customerName: 'Untokened School',
        totalAmount: 500,
        paidAmount: 0,
        status: 'Unpaid',
      },
    },
  ],
};

// Only top-level column that really exists on envelope tables.
const REAL_TOP_LEVEL_COLUMNS = new Set(['id']);

function parseOr(or) {
  if (!or || !or.startsWith('(') || !or.endsWith(')')) {
    const err = new Error('PGRST100');
    err.status = 400;
    throw err;
  }
  const inner = or.slice(1, -1);
  const items = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  items.push(cur);
  return items.map((item) => {
    if (item.startsWith('(')) {
      const err = new Error('PGRST100');
      err.status = 400;
      throw err;
    }
    const m = item.match(/^(data->>)?([A-Za-z_]+)\.eq\.(.*)$/);
    if (!m) {
      const err = new Error('PGRST100');
      err.status = 400;
      throw err;
    }
    const [, envelope, field, raw] = m;
    let value = raw;
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    return { envelope: Boolean(envelope), field, value };
  });
}

let requestCount = 0;
const seenOrs = [];

function startStrictStub() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const table = url.pathname.split('/').pop();
    if (req.method !== 'GET' || !TABLES[table]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    requestCount += 1;
    const or = url.searchParams.get('or') || '';
    seenOrs.push(or);
    let conds;
    try {
      conds = parseOr(or);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST100', message: 'failed to parse logic tree' }));
      return;
    }
    // Production behavior: a bare (non data->>) field that is not a real
    // top-level column fails with Postgres 42703.
    for (const c of conds) {
      if (!c.envelope && !REAL_TOP_LEVEL_COLUMNS.has(c.field)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: '42703', message: `column ${table}.${c.field} does not exist` }));
        return;
      }
    }
    const rows = TABLES[table].filter((r) => {
      const d = r.data || r;
      return conds.some((c) => {
        const source = c.envelope ? d : r;
        return String(source[c.field] ?? '') === c.value;
      });
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let stub;
let app;
const good = (n, t) => `/api/public/documents/verify/invoice/${encodeURIComponent(n)}?t=${t}`;
const legacy = (n, t) => `/api/public/invoices/verify/${encodeURIComponent(n)}?t=${t}`;

before(async () => {
  stub = await startStrictStub();
  const port = stub.address().port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.COMPANY_NAME = 'Prime Printing Service';
  app = express();
  app.use('/api/public/documents', require('../routes/documentVerify.cjs'));
  const legacyApp = express();
  legacyApp.use('/api/public/invoices', require('../routes/portalVerify.cjs'));
  app.use(legacyApp);
});

after(() => new Promise((resolve) => stub.close(resolve)));

describe('envelope-only invoice lookup (EXM-P726/021 regression)', () => {
  it('canonical envelope EXM-P726/021 verifies with its token', async () => {
    const res = await request(app).get(good('EXM-P726/021', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'EXM-P726/021');
  });

  it('slash-bearing number round-trips encoded then decoded', async () => {
    const res = await request(app).get(good('EXM-P726/021', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.invoiceNumber, 'EXM-P726/021');
  });

  it('never queries a nonexistent top-level invoiceNumber column', async () => {
    assert.ok(seenOrs.length > 0);
    for (const or of seenOrs) {
      for (const item of parseOr(or)) {
        // `invoiceNumber` may only appear as a JSONB envelope key, never bare.
        if (item.field === 'invoiceNumber') assert.equal(item.envelope, true);
      }
      assert.ok(!/(^|,)invoiceNumber\.eq\./.test(or));
    }
  });

  it('envelope-miss is a single clean lookup (no flat fallback round-trip)', async () => {
    const beforeCount = requestCount;
    const res = await request(app).get(good('EXM-NOPE-999', BAD));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
    assert.equal(requestCount - beforeCount, 1);
  });

  it('wrong token fails generically', async () => {
    const res = await request(app).get(good('EXM-P726/021', BAD));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
  });

  it('missing token fails generically', async () => {
    const res = await request(app).get(`/api/public/documents/verify/invoice/${encodeURIComponent('EXM-P726/021')}`);
    assert.equal(res.status, 404);
  });

  it('untokened envelope row never verifies', async () => {
    const res = await request(app).get(good('EXM-NOTOKEN-001', BAD));
    assert.equal(res.status, 404);
  });

  it('ordinary envelope invoice still verifies (no regression)', async () => {
    const res = await request(app).get(good('INV-ORD-001', 'd'.repeat(64)));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'INV-ORD-001');
  });

  it('legacy invoice endpoint still verifies EXM-P726/021', async () => {
    const res = await request(app).get(legacy('EXM-P726/021', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'EXM-P726/021');
  });
});

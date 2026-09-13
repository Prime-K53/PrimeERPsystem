/**
 * documentVerificationSlashNumbers.test.cjs
 *
 * Regression for the INV-P726/023 outage: the service built a PostgREST
 * `or` filter with individually-parenthesized items —
 *   or=((data->>id.eq.X),(data->>invoiceNumber.eq.X))
 * which PostgREST rejects with PGRST100/400, failing EVERY lookup at that
 * layer (the lenient stubs elsewhere cannot catch this class). This suite
 * uses a STRICT stub that emulates PostgREST `or` grammar, then proves the
 * full chain for slash-bearing numbers:
 *   build URL -> Express route param decoding -> service lookup
 *   -> timing-safe token compare -> verified response.
 *
 * Local stub HTTP store — no network, no credentials, no writes.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const request = require('supertest');

const TOK = 'f'.repeat(64);
const BAD = '0'.repeat(64);

// Production-shaped rows: number lives at data.id (no invoiceNumber field,
// exactly like the live INV-P726/023 record).
const TABLES = {
  invoices: [
    { data: { id: 'INV-P726/023', date: '2026-09-11', customerName: 'Slash School', currency: 'MWK', subtotal: 575500, tax: 0, totalAmount: 575500, paidAmount: 0, status: 'Unpaid', verificationToken: TOK } },
    { data: { id: 'INV-TEST-001', invoiceNumber: 'INV-TEST-001', date: '2026-09-12', customerName: 'Plain School', currency: 'MWK', subtotal: 1000, tax: 0, totalAmount: 1000, paidAmount: 0, status: 'Unpaid', verificationToken: TOK } },
  ],
};

/**
 * Strict PostgREST `or` emulation: top-level `or=(a,b)` with BARE
 * `field.op.value` items. A parenthesized item (`(a.eq.1)`) is a PGRST100
 * parse error, mirrored here as HTTP 400, exactly like production.
 */
function parseOr(or) {
  if (!or || !or.startsWith('(') || !or.endsWith(')')) throw new Error('PGRST100');
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
    if (item.startsWith('(')) throw new Error('PGRST100');
    const m = item.match(/^(data->>)?([A-Za-z_]+)\.eq\.(.*)$/);
    if (!m) throw new Error('PGRST100');
    return { field: m[2], value: m[3] };
  });
}

function startStrictStub(seen) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    const table = url.pathname.split('/').pop();
    if (req.method !== 'GET' || !TABLES[table]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    const or = url.searchParams.get('or') || '';
    seen.push(or);
    let conds;
    try {
      conds = parseOr(or);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'PGRST100', message: 'failed to parse logic tree' }));
      return;
    }
    const rows = TABLES[table].filter((r) => {
      const d = r.data || r;
      return conds.some((c) => String(d[c.field] ?? '') === c.value);
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let stub;
let app;
const seenOrs = [];
const good = (type, n, t) => `/api/public/documents/verify/${type}/${encodeURIComponent(n)}?t=${t}`;

before(async () => {
  stub = await startStrictStub(seenOrs);
  const port = stub.address().port;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SECRET_KEY = 'test-secret';
  process.env.COMPANY_NAME = 'Prime Printing Service';
  app = express();
  app.use('/api/public/documents', require('../routes/documentVerify.cjs'));
});

after(() => new Promise((resolve) => stub.close(resolve)));

describe('slash-bearing invoice numbers verify end-to-end', () => {
  it('INV-P726/023 verifies (encoded slash, id-only record shape)', async () => {
    const res = await request(app).get(good('invoice', 'INV-P726/023', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'INV-P726/023');
    assert.equal(res.body.total, 575500);
    assert.equal(res.body.status, 'UNPAID');
  });

  it('plain INV-TEST-001 verifies (control)', async () => {
    const res = await request(app).get(good('invoice', 'INV-TEST-001', TOK));
    assert.equal(res.status, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.invoiceNumber, 'INV-TEST-001');
  });

  it('every emitted `or` filter parses under strict PostgREST grammar', async () => {
    assert.ok(seenOrs.length > 0);
    for (const or of seenOrs) {
      parseOr(or); // throws on parenthesized items
      assert.ok(!or.includes('(('));
    }
  });

  it('wrong token fails generically (number + token both required)', async () => {
    const res = await request(app).get(good('invoice', 'INV-P726/023', BAD));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
  });

  it('wrong number fails generically', async () => {
    const res = await request(app).get(good('invoice', 'INV-P726/999', TOK));
    assert.equal(res.status, 404);
    assert.equal(res.body.verified, false);
  });

  it('random number + random token fails generically (no oracle)', async () => {
    const res = await request(app).get(good('invoice', 'NOPE-1', BAD));
    assert.equal(res.status, 404);
    assert.deepEqual(Object.keys(res.body).sort(), ['error', 'verified']);
  });
});

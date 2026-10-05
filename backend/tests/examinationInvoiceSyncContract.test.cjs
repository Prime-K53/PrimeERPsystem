/**
 * examinationInvoiceSyncContract.test.cjs
 *
 * Full sync persistence contract for examination invoices (BTC-style batches):
 *   Device-A queue op → shared backend gateway → Supabase envelope →
 *   public verification.
 *
 * Covers:
 *   Test 4 — backend accepts the sync op and persists the invoice correctly
 *            (envelope { id, data }, token inside data, version 1).
 *   Test 5 — idempotency: replaying the same operationId does NOT duplicate.
 *   Test 7 — valid EXM number + valid token verifies (incl. slash numbers).
 *   Test 8 — wrong token still returns NOT FOUND.
 *   Test 9 — ordinary INV invoices behave exactly as before.
 *
 * Single-company: asserts no tenant/company/organization discriminator is
 * introduced. No network, no credentials, no writes outside the in-memory stub.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://supabase.test';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret';

const EXAM_TOKEN = 'e'.repeat(64);
const ORD_TOKEN = 'd'.repeat(64);
const BAD = '0'.repeat(64);

const EXAM_NUMBER = 'EXM-P726/023';
const EXAM_BATCH = 'BTC-P726/023';
const ORD_NUMBER = 'INV-P726/023';

// ---- in-memory PostgREST surface (envelope tables) --------------------------
const invoiceStore = new Map(); // id -> { id, data, updated_at, version }
const idempotencyStore = new Map();
let generationValue = 1;

const ok = (data) => Promise.resolve({ data });
const fail = (status, data) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data };
  return Promise.reject(err);
};

const matchEq = (value, expected) => String(value || '') === String(expected || '');

const axiosMock = {
  create: () => axiosMock,
  get: async (url, options = {}) => {
    const params = options.params || {};
    if (String(url).endsWith('/rest/v1/settings')) {
      if (params.id === 'eq.sync_generation') {
        return ok([{ id: 'sync_generation', data: { value: generationValue } }]);
      }
      return ok([]);
    }
    if (String(url).endsWith('/rest/v1/idempotency_keys')) {
      if (params.limit === 0) return ok([]);
      const idEq = String(params.id || '').replace(/^eq\./, '');
      const row = idempotencyStore.get(idEq);
      return ok(row ? [row] : []);
    }
    if (String(url).endsWith('/rest/v1/invoices')) {
      if (params.id) {
        const idEq = String(params.id).replace(/^eq\./, '');
        const row = invoiceStore.get(idEq);
        return ok(row ? [row] : []);
      }
      // verification lookup: or=(data->>id.eq."X",data->>invoiceNumber.eq."Y")
      if (params.or) {
        const or = String(params.or);
        const wanted = Array.from(or.matchAll(/"((?:[^"]|"")*)"/g)).map((m) => m[1].replace(/""/g, '"'));
        const rows = Array.from(invoiceStore.values()).filter((r) => {
          const d = r.data || {};
          return wanted.some((w) => matchEq(d.id, w) || matchEq(d.invoiceNumber, w));
        });
        return ok(rows.slice(0, Number(params.limit || 5)));
      }
      return ok(Array.from(invoiceStore.values()));
    }
    return ok([]);
  },
  post: async (url, body) => {
    if (String(url).endsWith('/rest/v1/idempotency_keys')) {
      if (body && body.id) idempotencyStore.set(body.id, body);
      return ok(body);
    }
    if (String(url).endsWith('/rest/v1/invoices')) {
      if (!body || !body.id) return fail(400, { code: '23502', message: 'id required' });
      if (!invoiceStore.has(body.id)) {
        const row = {
          id: body.id,
          data: body.data || {},
          updated_at: body.updated_at || new Date().toISOString(),
          version: body.version != null ? Number(body.version) : 1,
        };
        invoiceStore.set(body.id, row);
        return ok([row]);
      }
      return ok([invoiceStore.get(body.id)]);
    }
    return ok([]);
  },
  patch: async (url, body, options = {}) => {
    if (String(url).endsWith('/rest/v1/invoices')) {
      const params = options.params || {};
      const idEq = String(params.id || '').replace(/^eq\./, '');
      const verEq = String(params.version || '').replace(/^eq\./, '');
      const existing = invoiceStore.get(idEq);
      if (existing && (params.version === undefined || String(existing.version) === verEq)) {
        const updated = {
          ...existing,
          data: body.data !== undefined ? body.data : existing.data,
          updated_at: body.updated_at || existing.updated_at,
          version: body.version != null ? Number(body.version) : existing.version,
        };
        invoiceStore.set(idEq, updated);
        return ok([updated]);
      }
      return ok([]);
    }
    return ok([]);
  },
};

jest.mock('axios', () => axiosMock);

const cloudSyncStore = require('../services/cloudSyncStore.cjs');
const { verifyDocument } = require('../services/documentVerificationService.cjs');

const examPayload = (overrides = {}) => ({
  id: EXAM_NUMBER,
  invoiceNumber: EXAM_NUMBER,
  date: '2026-09-20T00:00:00.000Z',
  dueDate: '2026-10-20T00:00:00.000Z',
  customerId: 'SCH-1',
  customerName: 'Contract School',
  totalAmount: 575500,
  paidAmount: 0,
  status: 'Unpaid',
  items: [{ id: 'CLS-1', name: 'Class 1', quantity: 10, price: 100, total: 1000 }],
  batchId: EXAM_BATCH,
  originBatchId: EXAM_BATCH,
  origin_batch_id: EXAM_BATCH,
  originModule: 'examination',
  origin_module: 'examination',
  category: 'Examination',
  reference: `EXAM-BATCH-${EXAM_BATCH}`,
  currency: 'MWK',
  verificationToken: EXAM_TOKEN,
  ...overrides,
});

const examOp = (overrides = {}) => ({
  operationId: 'op-exam-1',
  table: 'invoices',
  recordId: EXAM_NUMBER,
  operation: 'upsert',
  payload: examPayload(),
  syncGeneration: 1,
  ...overrides,
});

// Verification reads through the same stub store (gateway-write → verify-read).
const stubHttpGet = async () => ({
  data: Array.from(invoiceStore.values()),
});

describe('examination invoice sync persistence contract (BTC-P726/023 shape)', () => {
  test('Test 4 — backend accepts exam sync op and persists envelope with token', async () => {
    const result = await cloudSyncStore.applyOp(examOp());
    expect(result.ok).toBe(true);
    const row = invoiceStore.get(EXAM_NUMBER);
    expect(row).toBeDefined();
    expect(row.id).toBe(EXAM_NUMBER);
    expect(row.data.id).toBe(EXAM_NUMBER);
    expect(row.data.invoiceNumber).toBe(EXAM_NUMBER);
    expect(row.data.verificationToken).toBe(EXAM_TOKEN);
    expect(row.version).toBe(1);
    expect('tenant_id' in row.data).toBe(false);
    expect('organization_id' in row.data).toBe(false);
    expect('company_id' in row.data).toBe(false);
  });

  test('Test 5 — idempotency: replaying the same operationId does not duplicate', async () => {
    const before = invoiceStore.size;
    const replay = await cloudSyncStore.applyOp(examOp());
    expect(replay.ok).toBe(true);
    expect(replay.replayed).toBe(true);
    expect(invoiceStore.size).toBe(before);
    expect(Array.from(invoiceStore.values()).filter((r) => r.id === EXAM_NUMBER)).toHaveLength(1);
  });

  test('Test 7 — valid EXM number + valid token verifies (slash-safe)', async () => {
    const result = await verifyDocument('invoice', EXAM_NUMBER, EXAM_TOKEN, { httpGet: stubHttpGet });
    expect(result.ok).toBe(true);
    expect(result.data.invoiceNumber).toBe(EXAM_NUMBER);
  });

  test('Test 8 — wrong token still returns NOT FOUND', async () => {
    expect((await verifyDocument('invoice', EXAM_NUMBER, BAD, { httpGet: stubHttpGet })).ok).toBe(false);
    expect((await verifyDocument('invoice', 'EXM-P726/999', EXAM_TOKEN, { httpGet: stubHttpGet })).ok).toBe(false);
  });

  test('Test 9 — ordinary INV invoices behave exactly as before', async () => {
    const saved = await cloudSyncStore.applyOp({
      operationId: 'op-ord-1',
      table: 'invoices',
      recordId: ORD_NUMBER,
      operation: 'upsert',
      payload: {
        id: ORD_NUMBER,
        invoiceNumber: ORD_NUMBER,
        date: '2026-09-20T00:00:00.000Z',
        customerName: 'Ordinary Customer',
        totalAmount: 1000,
        paidAmount: 0,
        status: 'Unpaid',
        currency: 'MWK',
        verificationToken: ORD_TOKEN,
      },
      syncGeneration: 1,
    });
    expect(saved.ok).toBe(true);
    const good = await verifyDocument('invoice', ORD_NUMBER, ORD_TOKEN, { httpGet: stubHttpGet });
    expect(good.ok).toBe(true);
    expect(good.data.invoiceNumber).toBe(ORD_NUMBER);
    expect((await verifyDocument('invoice', ORD_NUMBER, BAD, { httpGet: stubHttpGet })).ok).toBe(false);
  });

  test('verification uses the invoice type contract (EXAMINATION_INVOICE is not a lookup type)', async () => {
    expect((await verifyDocument('EXAMINATION_INVOICE', EXAM_NUMBER, EXAM_TOKEN, { httpGet: stubHttpGet })).ok).toBe(
      false
    );
  });
});

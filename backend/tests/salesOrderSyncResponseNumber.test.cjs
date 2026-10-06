/**
 * Sync-gateway response-number contract (cloudSyncStore.applyOp ::
 * sales_orders order_number write-back).
 *
 * The online Sales Order fast-path depends on the gateway returning the
 * EXACT authoritative number it persisted, so the creator adopts it
 * immediately instead of waiting for the next pull cycle:
 *   genuine create  → minted ORD returned (adopt-or-mint, incl. 409 re-mint)
 *   replayed op     → SAME persisted number, no new sequence consumed
 *   existing row    → preserved server number, no mint
 *   other tables    → no order_number key at all (never fabricated)
 *   mint failure    → ok:true with order_number:null (fail-open, retry later)
 *
 * Hermetic: axios + companyConfigService are mocked; no network, no Supabase.
 */

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
  instance.create = jest.fn(() => instance);
  return instance;
});

jest.mock('../services/companyConfigService.cjs', () => ({
  getCompanyConfig: jest.fn(async () => ({
    transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
  })),
}));

const axios = require('axios');
const cloudSyncStore = require('../services/cloudSyncStore.cjs');

const BASE = 'https://test.supabase.co/rest/v1';
const isSalesOrders = (url) => url === `${BASE}/sales_orders`;
const isInvoices = (url) => url === `${BASE}/invoices`;
const isClaimRpc = (url) => url === `${BASE}/rpc/claim_next_sales_order_number`;
const isIdempotency = (url) => url === `${BASE}/idempotency_keys`;
const isSettings = (url) => url === `${BASE}/settings`;

function makeHttpError(status, data) {
  const err = new Error(`Request failed with status ${status}`);
  err.response = { status, data };
  return err;
}

// Stateful fakes: cloud rows keyed `${table}/${id}`, idempotency by uuid.
let cloudRows;
let idempotencyRows;
let claimCalls;

function resetState() {
  cloudRows = new Map();
  idempotencyRows = new Map();
  claimCalls = 0;
  jest.clearAllMocks();

  axios.get.mockImplementation(async (url, options = {}) => {
    const params = options.params || {};
    if (isIdempotency(url)) {
      // ensureIdempotencyTable probe (no id param) vs checkIdempotency (id param).
      if (typeof params.id !== 'string') return { data: [] };
      const uuid = String(params.id).slice('eq.'.length);
      const result = idempotencyRows.get(uuid);
      return { data: result !== undefined ? [{ id: uuid, result }] : [] };
    }
    if (isSettings(url)) {
      return { data: [{ id: 'sync_generation', data: { value: 1 } }] };
    }
    if ((isSalesOrders(url) || isInvoices(url)) && typeof params.id === 'string') {
      const table = isSalesOrders(url) ? 'sales_orders' : 'invoices';
      const id = String(params.id).slice('eq.'.length);
      const row = cloudRows.get(`${table}/${id}`);
      return { data: row ? [row] : [] };
    }
    if ((isSalesOrders(url) || isInvoices(url)) && typeof params.or === 'string') {
      return { data: [] }; // taken-check: nothing taken
    }
    throw new Error(`unexpected GET ${url} ${JSON.stringify(params)}`);
  });

  axios.post.mockImplementation(async (url, body) => {
    if (isIdempotency(url)) {
      idempotencyRows.set(body.id, body.result || null);
      return { data: {} };
    }
    if (isClaimRpc(url)) {
      claimCalls += 1;
      return { data: 26 + claimCalls - 1 }; // 26, 27, 28, ...
    }
    if (isSalesOrders(url) || isInvoices(url)) {
      const table = isSalesOrders(url) ? 'sales_orders' : 'invoices';
      const prev = cloudRows.get(`${table}/${body.id}`);
      const row = {
        id: body.id,
        data: body.data,
        updated_at: '2026-01-01T00:00:00.000Z',
        created_at: '2026-01-01T00:00:00.000Z',
        version: (prev?.version || 0) + 1,
      };
      cloudRows.set(`${table}/${body.id}`, row);
      return { data: [row] };
    }
    throw new Error(`unexpected POST ${url}`);
  });

  axios.patch.mockImplementation(async (url, body, options = {}) => {
    const params = options.params || {};
    const table = isSalesOrders(url) ? 'sales_orders' : isInvoices(url) ? 'invoices' : null;
    if (!table || typeof params.id !== 'string') throw new Error(`unexpected PATCH ${url}`);
    const id = String(params.id).slice('eq.'.length);
    const row = cloudRows.get(`${table}/${id}`);
    if (!row) return { data: [] };
    row.version += 1;
    row.updated_at = '2026-01-01T00:00:01.000Z';
    return { data: [row] };
  });
}

const salesOp = (payload, operationId = 'op-1') => ({
  operationId,
  table: 'sales_orders',
  recordId: payload.id,
  operation: 'upsert',
  payload,
  syncGeneration: 1,
});

const provisionalDirect = (overrides = {}) => ({
  id: 'local-1',
  orderNumber: null,
  orderNumberProvisional: false,
  customer_id: 'cust-1',
  total: 100,
  ...overrides,
});

describe('applyOp sales_orders order_number write-back', () => {
  beforeEach(resetState);

  it('genuine create returns the exact minted ORD number with version', async () => {
    const result = await cloudSyncStore.applyOp(salesOp(provisionalDirect({ id: 'new-1' })));
    expect(result.ok).toBe(true);
    expect(result.order_number).toBe('ORD-P726/026');
    expect(result.version).toBe(1);
    expect(result.updatedAt).toBe('2026-01-01T00:00:00.000Z');
    // The persisted row carries the same number — returned === persisted.
    const row = cloudRows.get('sales_orders/new-1');
    expect(row.data.order_number).toBe('ORD-P726/026');
  });

  it('replay of the same operationId returns the SAME number without consuming a new sequence value', async () => {
    const first = await cloudSyncStore.applyOp(salesOp(provisionalDirect({ id: 'new-1' })));
    expect(first.ok).toBe(true);
    expect(first.order_number).toBe('ORD-P726/026');
    expect(claimCalls).toBe(1);

    const replayed = await cloudSyncStore.applyOp(salesOp(provisionalDirect({ id: 'new-1' })));
    expect(replayed.ok).toBe(true);
    expect(replayed.replayed).toBe(true);
    expect(replayed.id).toBe('new-1');
    expect(replayed.order_number).toBe('ORD-P726/026');
    expect(claimCalls).toBe(1); // no second sequence value consumed
  });

  it('existing numbered row update returns the preserved number and mints nothing', async () => {
    cloudRows.set('sales_orders/so-1', {
      id: 'so-1',
      data: { id: 'so-1', order_number: 'ORD-P726/026' },
      updated_at: '2026-01-01T00:00:00.000Z',
      version: 3,
    });
    const result = await cloudSyncStore.applyOp(salesOp({
      id: 'so-1',
      order_number: 'ORD-P726/026',
      orderNumber: 'SO-P726/001',
      _version: 3,
    }));
    expect(result.ok).toBe(true);
    expect(result.order_number).toBe('ORD-P726/026');
    expect(claimCalls).toBe(0);
  });

  it('non-sales_orders results carry no order_number key', async () => {
    const result = await cloudSyncStore.applyOp({
      operationId: 'op-inv',
      table: 'invoices',
      recordId: 'inv-1',
      operation: 'upsert',
      payload: { id: 'inv-1', invoiceNumber: 'INV-P726/001' },
      syncGeneration: 1,
    });
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('order_number');
  });

  it('mint failure still persists the row with order_number null (fail-open, retry later)', async () => {
    // Force the claim RPC to fail while letting everything else through.
    const basePost = axios.post.getMockImplementation();
    axios.post.mockImplementation(async (url, body, options) => {
      if (isClaimRpc(url)) throw makeHttpError(500, { message: 'sequence store down' });
      return basePost(url, body, options);
    });
    const result = await cloudSyncStore.applyOp(salesOp(provisionalDirect({ id: 'new-9' }), 'op-9'));
    expect(result.ok).toBe(true);
    expect(result.order_number).toBeNull();
    // Durable and retryable: the row exists unnumbered for the next push.
    expect(cloudRows.get('sales_orders/new-9')).toBeDefined();
  });

  it('409 unique race re-mint returns the fresh number actually persisted', async () => {
    claimCalls = 1; // next claim yields 27, so the re-mint visibly differs from the adopted 026
    let posts = 0;
    const basePost = axios.post.getMockImplementation();
    axios.post.mockImplementation(async (url, body, options) => {
      if (isSalesOrders(url)) {
        posts += 1;
        if (posts === 1) {
          throw makeHttpError(409, { code: '23505', message: 'duplicate key value violates unique constraint "idx_sales_orders_official_number_unique"' });
        }
      }
      return basePost(url, body, options);
    });
    const result = await cloudSyncStore.applyOp(salesOp({
      id: 'so-race',
      order_number: 'ORD-P726/026',
      orderNumberProvisional: false,
    }, 'op-race'));
    expect(result.ok).toBe(true);
    expect(result.order_number).toBe('ORD-P726/027');
    expect(cloudRows.get('sales_orders/so-race').data.order_number).toBe('ORD-P726/027');
  });
});

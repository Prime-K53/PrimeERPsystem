/**
 * Sync-gateway creation_source contract (cloudSyncStore.ensureSalesOrderNumber).
 *
 *   DIRECT_ERP       → mints ORD-P726/NNN
 *   PORTAL_CONVERSION→ mints SO-P726/NNN
 *   INVOICE_DERIVED  → mints ORD-P726/NNN (chain preserved, never portal SO)
 * Existing rows keep their official numbers untouched (history immutable).
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

const stubs = { get: [], post: [] };

function resetStubs() {
  stubs.get.length = 0;
  stubs.post.length = 0;
  jest.clearAllMocks();
  axios.get.mockImplementation(async (url, options = {}) => {
    for (const [match, respond] of stubs.get) {
      if (match(url, options)) return respond(url, options);
    }
    throw new Error(`unexpected GET ${url} ${JSON.stringify(options.params || {})}`);
  });
  axios.post.mockImplementation(async (url, body) => {
    for (const [match, respond] of stubs.post) {
      if (match(url, body)) return respond(url, body);
    }
    throw new Error(`unexpected POST ${url}`);
  });
}

const BASE = 'https://test.supabase.co/rest/v1';
const isSalesOrders = (url) => url === `${BASE}/sales_orders`;
const isClaimRpc = (url) => url === `${BASE}/rpc/claim_next_sales_order_number`;

function stubGetRow(rowsById) {
  stubs.get.push([
    (url, options) => isSalesOrders(url) && typeof (options.params || {}).id === 'string',
    (url, options) => {
      const id = String(options.params.id).slice('eq.'.length);
      const row = rowsById[id];
      return { data: row ? [row] : [] };
    },
  ]);
}

function stubTakenCheckEmpty() {
  stubs.get.push([
    (url, options) => isSalesOrders(url) && typeof (options.params || {}).or === 'string',
    () => ({ data: [] }),
  ]);
}

function stubClaimRpc(sequence) {
  stubs.post.push([(url) => isClaimRpc(url), () => ({ data: [sequence] })]);
}

describe('ensureSalesOrderNumber — creation_source routing', () => {
  beforeEach(resetStubs);

  it('DIRECT_ERP genuine create mints ORD-', async () => {
    stubGetRow({});
    stubTakenCheckEmpty();
    stubClaimRpc(11);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'tmp-1',
      orderNumber: 'TMP-0001',
      orderNumberProvisional: true,
      creation_source: 'DIRECT_ERP',
      customer_id: 'c-1',
    });
    expect(out).toBe('ORD-P726/011');
  });

  it('PORTAL_CONVERSION genuine create mints SO-', async () => {
    stubGetRow({});
    stubTakenCheckEmpty();
    stubClaimRpc(12);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'tmp-2',
      orderNumber: 'TMP-0002',
      orderNumberProvisional: true,
      creation_source: 'PORTAL_CONVERSION',
      source_request_id: 'req-1',
    });
    expect(out).toBe('SO-P726/012');
  });

  it('INVOICE_DERIVED genuine create mints ORD- (never portal SO)', async () => {
    stubGetRow({});
    stubTakenCheckEmpty();
    stubClaimRpc(13);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'tmp-3',
      orderNumber: 'TMP-0003',
      orderNumberProvisional: true,
      creation_source: 'INVOICE_DERIVED',
      invoiceId: 'inv-1',
    });
    expect(out).toBe('ORD-P726/013');
  });

  it('invoice-derived SO candidate is rejected and re-minted ORD-', async () => {
    stubGetRow({});
    stubTakenCheckEmpty();
    stubClaimRpc(14);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'tmp-4',
      order_number: 'SO-P726/014',
      orderNumberProvisional: false,
      creation_source: 'INVOICE_DERIVED',
    });
    // prefixMismatch → fresh mint by explicit source (ORD), not adoption.
    expect(out).toBe('ORD-P726/014');
  });

  it('existing rows keep history untouched regardless of source', async () => {
    stubGetRow({
      'so-keep': {
        id: 'so-keep',
        data: { id: 'so-keep', order_number: 'SO-P726/009', creation_source: 'PORTAL_CONVERSION' },
        version: 2,
      },
    });
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-keep',
      order_number: 'ORD-P726/099',
      creation_source: 'DIRECT_ERP',
    });
    expect(out).toBe('SO-P726/009');
    expect(axios.post).not.toHaveBeenCalledWith(
      expect.stringContaining('/rpc/claim_next_sales_order_number'),
      expect.anything(),
      expect.anything()
    );
  });
});

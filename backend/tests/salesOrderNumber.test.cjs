/**
 * Unified P726 official Sales Order numbering — gateway contract tests.
 *
 * Model under test (backend/services/cloudSyncStore.cjs :: ensureSalesOrderNumber,
 * backed by backend/services/salesOrderNumbering.cjs):
 *   DIRECT_ERP origin (no source_request_id/number, no quotation_id) → ORD-P726/NNN
 *   QUOTATION_REQUEST origin (request/quotation linkage persisted)   → SO-P726/NNN
 * One shared atomic sequence (RPC claim); existing rows keep numbers untouched;
 * provisionals and legacy shapes are minted, never adopted; mint failures fail
 * open (row saved unnumbered, retried later).
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
const companyConfigService = require('../services/companyConfigService.cjs');

const BASE = 'https://test.supabase.co/rest/v1';
const P726_CONFIG = {
  transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
};

function makeHttpError(status, data) {
  const err = new Error(`Request failed with status ${status}`);
  err.response = { status, data };
  return err;
}

// Mutable stub state, reset per test. handlers.get/post are tried in order.
const stubs = { get: [], post: [] };

function resetStubs() {
  stubs.get.length = 0;
  stubs.post.length = 0;
  jest.clearAllMocks();
  companyConfigService.getCompanyConfig.mockResolvedValue(P726_CONFIG);
  axios.get.mockImplementation(async (url, options = {}) => {
    for (const [match, respond] of stubs.get) {
      if (match(url, options)) return respond(url, options);
    }
    throw new Error(`unexpected GET ${url} ${JSON.stringify(options.params || {})}`);
  });
  axios.post.mockImplementation(async (url, body, options = {}) => {
    for (const [match, respond] of stubs.post) {
      if (match(url, body, options)) return respond(url, body, options);
    }
    throw new Error(`unexpected POST ${url}`);
  });
  axios.patch.mockImplementation(async () => {
    throw new Error('unexpected PATCH');
  });
}

const isSettings = (url) => url === `${BASE}/settings`;
const isIdempotency = (url) => url === `${BASE}/idempotency_keys`;
const isSalesOrders = (url) => url === `${BASE}/sales_orders`;
const isClaimRpc = (url) => url === `${BASE}/rpc/claim_next_sales_order_number`;
const hasParam = (key, value) => (url, options = {}) =>
  (options.params || {})[key] === value;

function stubInfrastructure({ generation = 1 } = {}) {
  stubs.get.push(
    [(url, options) => isSettings(url) && (options.params || {}).id === 'eq.sync_generation',
      () => ({ data: [{ id: 'sync_generation', data: { value: generation } }] })],
    [(url) => isIdempotency(url), () => ({ data: [] })],
  );
  stubs.post.push(
    [(url) => isIdempotency(url), () => ({ data: {} })],
  );
}

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

function stubTakenCheck(takenNumbers) {
  const taken = new Set(takenNumbers || []);
  stubs.get.push([
    (url, options) => isSalesOrders(url) && typeof (options.params || {}).or === 'string',
    (url, options) => {
      const or = String(options.params.or);
      const hit = [...taken].some((n) => or.includes(`"${n}"`));
      return { data: hit ? [{ id: 'other-row' }] : [] };
    },
  ]);
}

function stubClaimRpc(sequences) {
  const queue = [...sequences];
  stubs.post.push([
    (url) => isClaimRpc(url),
    () => {
      if (queue.length === 0) throw new Error('claim RPC called more times than stubbed');
      return { data: queue.shift() };
    },
  ]);
}

function stubClaimRpcSeries(counters) {
  const state = new Map(Object.entries(counters));
  stubs.post.push([
    (url) => isClaimRpc(url),
    (url, body) => {
      const series = body.p_series;
      const next = (state.get(series) || 0) + 1;
      state.set(series, next);
      return { data: next };
    },
  ]);
}

const provisionalDirect = (overrides = {}) => ({
  id: 'local-1',
  orderNumber: 'SO-P726/001',
  orderNumberProvisional: true,
  customer_id: 'cust-1',
  total: 100,
  ...overrides,
});

describe('ensureSalesOrderNumber — unified P726 contract', () => {
  beforeEach(resetStubs);

  it('existing row with an official order_number is stamped back (no mint)', async () => {
    stubGetRow({
      'so-1': { id: 'so-1', data: { id: 'so-1', order_number: 'ORD-P726/026', orderNumber: 'SO-P726/001' }, version: 3 },
    });
    const out = await cloudSyncStore.ensureSalesOrderNumber({ id: 'so-1', orderNumber: 'SO-P726/001' });
    expect(out).toBe('ORD-P726/026');
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/rpc/claim_next_sales_order_number'), expect.anything(), expect.anything());
  });

  it('existing row without numbers is left alone (history immutable, no mint)', async () => {
    stubGetRow({
      'so-9': { id: 'so-9', data: { id: 'so-9', customer_id: 'c' }, version: 1 },
    });
    const out = await cloudSyncStore.ensureSalesOrderNumber({ id: 'so-9', orderNumber: 'SO-P726/001' });
    expect(out).toBeNull();
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/rpc/claim_next_sales_order_number'), expect.anything(), expect.anything());
  });

  it('genuine create, provisional direct payload → mints ORD-P726/NNN', async () => {
    stubGetRow({});
    stubClaimRpc([26]);
    const out = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect());
    expect(out).toBe('ORD-P726/026');
  });

  it('genuine create with conversion linkage → mints SO-P726/NNN', async () => {
    stubGetRow({});
    stubClaimRpc([28]);
    const out = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ source_request_id: 'req-1', source_request_number: 'SO-2026-000007' })
    );
    expect(out).toBe('SO-P726/028');
  });

  it('genuine create with quotation linkage → mints SO-P726/NNN', async () => {
    stubGetRow({});
    stubClaimRpc([29]);
    const out = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ quotation_id: 'q-1' })
    );
    expect(out).toBe('SO-P726/029');
  });

  it('keeps a valid pre-claimed conversion number with zero counter waste', async () => {
    stubGetRow({});
    stubTakenCheck([]);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-x',
      order_number: 'SO-P726/030',
      orderNumberProvisional: false,
      source_request_id: 'req-9',
      source_request_number: 'SO-2026-000009',
    });
    expect(out).toBe('SO-P726/030');
    expect(axios.post).not.toHaveBeenCalledWith(expect.stringContaining('/rpc/claim_next_sales_order_number'), expect.anything(), expect.anything());
  });

  it('pre-claimed number taken elsewhere → mints fresh instead of adopting', async () => {
    stubGetRow({});
    stubTakenCheck(['SO-P726/030']);
    stubClaimRpc([31]);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-y',
      order_number: 'SO-P726/030',
      source_request_id: 'req-9',
    });
    expect(out).toBe('SO-P726/031');
  });

  it('pre-claimed number with mismatched prefix (SO- on direct row) → mints ORD- fresh', async () => {
    stubGetRow({});
    stubClaimRpc([32]);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-z',
      order_number: 'SO-P726/032',
      customer_id: 'cust-1',
    });
    expect(out).toBe('ORD-P726/032');
  });

  it('flagged provisional with official-shaped number is never adopted', async () => {
    stubGetRow({});
    stubClaimRpc([33]);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-w',
      order_number: 'SO-P726/033',
      orderNumberProvisional: true,
      source_request_id: 'req-3',
    });
    expect(out).toBe('SO-P726/033');
    // The value coincides textually, but it came from the counter (RPC called once).
    const rpcCalls = axios.post.mock.calls.filter(([url]) => String(url).includes('/rpc/claim_next_sales_order_number'));
    expect(rpcCalls).toHaveLength(1);
  });

  it('legacy ORDER-P726 first-sync → mints ORD-P726 fresh (no ORDER- kept)', async () => {
    stubGetRow({});
    stubClaimRpc([34]);
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'ORDER-P726/034',
      orderNumber: 'ORDER-P726/034',
      customer_id: 'cust-1',
    });
    expect(out).toBe('ORD-P726/034');
  });

  it('sequence-store failure throws (gateway fails open upstream)', async () => {
    stubGetRow({});
    stubs.post.push([
      (url) => isClaimRpc(url),
      () => { throw makeHttpError(500, { message: 'boom' }); },
    ]);
    await expect(
      cloudSyncStore.ensureSalesOrderNumber(provisionalDirect())
    ).rejects.toThrow();
  });
});

describe('applyOp — P726 end-to-end over the gateway', () => {
  beforeEach(resetStubs);

  function baseOp(payload) {
    return {
      operationId: 'op-1',
      table: 'sales_orders',
      recordId: payload.id,
      operation: 'upsert',
      payload,
      syncGeneration: 1,
    };
  }

  it('direct provisional row is stored with a minted ORD-P726 number', async () => {
    stubInfrastructure();
    stubGetRow({});
    stubClaimRpc([26]);
    stubs.post.push([
      (url) => isSalesOrders(url),
      (url, body) => ({ data: [{ ...body, version: 1 }] }),
    ]);
    const result = await cloudSyncStore.applyOp(baseOp(provisionalDirect({ id: 'new-1' })));
    expect(result.ok).toBe(true);
    const posted = axios.post.mock.calls
      .filter(([url]) => isSalesOrders(url))
      .map(([, body]) => body);
    expect(posted).toHaveLength(1);
    expect(posted[0].data.order_number).toBe('ORD-P726/026');
    expect(posted[0].data.orderNumber).toBe('SO-P726/001');
  });

  it('kept pre-claim survives first write; 409 unique violation re-mints once and retries', async () => {
    stubInfrastructure();
    stubGetRow({});
    // Taken-check sees nothing (race happens at insert), then the insert 409s.
    stubTakenCheck([]);
    stubClaimRpc([27]);
    let posts = 0;
    stubs.post.push([
      (url) => isSalesOrders(url),
      (url, body) => {
        posts += 1;
        if (posts === 1) throw makeHttpError(409, { code: '23505', message: 'duplicate key value violates unique constraint "idx_sales_orders_official_number_unique"' });
        return { data: [{ ...body, version: 1 }] };
      },
    ]);
    const payload = {
      id: 'so-race',
      order_number: 'SO-P726/026',
      orderNumberProvisional: false,
      source_request_id: 'req-race',
      source_request_number: 'SO-2026-000001',
    };
    const result = await cloudSyncStore.applyOp(baseOp(payload));
    expect(result.ok).toBe(true);
    const posted = axios.post.mock.calls
      .filter(([url]) => isSalesOrders(url))
      .map(([, body]) => body.data.order_number);
    expect(posted).toEqual(['SO-P726/026', 'SO-P726/027']);
  });

  it('existing official row is preserved through the gateway (no restamp)', async () => {
    stubInfrastructure();
    stubGetRow({
      'so-1': { id: 'so-1', data: { id: 'so-1', order_number: 'ORD-P726/026' }, version: 3 },
    });
    axios.patch.mockResolvedValueOnce({ data: [{ id: 'so-1', version: 4 }] });
    // Versioned push matching the server version → clean update path.
    const result = await cloudSyncStore.applyOp(baseOp({
      id: 'so-1',
      order_number: 'ORD-P726/026',
      orderNumber: 'SO-P726/001',
      _version: 3,
    }));
    expect(result.ok).toBe(true);
    const rpcCalls = axios.post.mock.calls.filter(([url]) => String(url).includes('/rpc/claim_next_sales_order_number'));
    expect(rpcCalls).toHaveLength(0);
  });
});

describe('alternate series over the gateway — P727 configured', () => {
  const P727_CONFIG = {
    transactionSettings: { numbering: { shared: { extension: 'P727', padding: 3 } } },
  };

  beforeEach(() => {
    resetStubs();
    companyConfigService.getCompanyConfig.mockResolvedValue(P727_CONFIG);
  });

  function baseOp(payload) {
    return {
      operationId: 'op-p727',
      table: 'sales_orders',
      recordId: payload.id,
      operation: 'upsert',
      payload,
      syncGeneration: 1,
    };
  }

  it('direct provisional mints ORD-P727 with the P727 counter (p_series=P727)', async () => {
    stubInfrastructure();
    stubGetRow({});
    const seen = [];
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        seen.push(body);
        return { data: [1] };
      },
    ]);
    stubs.post.push([
      (url) => isSalesOrders(url),
      (url, body) => ({ data: [{ ...body, version: 1 }] }),
    ]);
    const result = await cloudSyncStore.applyOp(baseOp(provisionalDirect({ id: 'p727-new' })));
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ p_series: 'P727' }]);
    const posted = axios.post.mock.calls
      .filter(([url]) => isSalesOrders(url))
      .map(([, body]) => body.data.order_number);
    expect(posted).toEqual(['ORD-P727/001']);
  });

  it('conversion linkage mints SO-P727; historical P726 rows are preserved, never re-minted', async () => {
    stubInfrastructure();
    // Historical P726 row already committed: any push keeps it untouched.
    stubGetRow({
      'so-old': { id: 'so-old', data: { id: 'so-old', order_number: 'ORD-P726/028' }, version: 5 },
    });
    axios.patch.mockResolvedValueOnce({ data: [{ id: 'so-old', version: 6 }] });
    const kept = await cloudSyncStore.applyOp(baseOp({
      id: 'so-old',
      order_number: 'ORD-P726/028',
      orderNumber: 'SO-P726/001',
      _version: 5,
    }));
    expect(kept.ok).toBe(true);
    // New conversion under P727 config mints from the P727 counter.
    stubClaimRpcSeries({ P727: 1 });
    const fresh = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-new',
      orderNumberProvisional: true,
      source_request_id: 'req-p727',
    });
    expect(fresh).toBe('SO-P727/002');
    // No P726 RPC shape was ever used; historical row untouched.
    for (const [url] of axios.post.mock.calls) {
      expect(String(url)).not.toContain('p726');
    }
  });

  it('independent per-series counters: P726 and P727 advance separately', async () => {
    stubInfrastructure();
    stubGetRow({});
    stubClaimRpcSeries({ P726: 27, P727: 4 });
    companyConfigService.getCompanyConfig.mockResolvedValue({
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    });
    const a = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 'a1' }));
    expect(a).toBe('ORD-P726/028');
    companyConfigService.getCompanyConfig.mockResolvedValue({
      transactionSettings: { numbering: { shared: { extension: 'P727', padding: 3 } } },
    });
    const b = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ id: 'b1', source_request_id: 'req-b' })
    );
    expect(b).toBe('SO-P727/005');
    companyConfigService.getCompanyConfig.mockResolvedValue({
      transactionSettings: { numbering: { shared: { extension: 'P726', padding: 3 } } },
    });
    const d = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 'a2' }));
    expect(d).toBe('ORD-P726/029');
  });
});

describe('verified live census scenario — P726 seeded at 42', () => {
  beforeEach(resetStubs);

  // Live shape: operational P726 numbers live in id/orderNumber while
  // order_number holds a legacy backend ORD-2026-* value (24 rows, no
  // duplicates, orders table empty). Highest operational suffix: 42.
  const censusRow = (id, seq) => ({
    id,
    data: {
      id,
      orderNumber: id,
      order_number: `ORD-2026-${String(seq).padStart(6, '0')}`,
    },
    version: 1,
  });

  function stubSeriesClaimRpc(counters) {
    const state = new Map(Object.entries(counters));
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        const series = body.p_series;
        const next = (state.get(series) || 0) + 1;
        state.set(series, next);
        return { data: next };
      },
    ]);
  }

  it('census rows keep their legacy official numbers; provenance untouched', async () => {
    stubGetRow({
      'SO-P726/025': {
        ...censusRow('SO-P726/025', 5),
        data: {
          ...censusRow('SO-P726/025', 5).data,
          source: 'invoice',
          quotationId: null,
        },
      },
    });
    // Existing row: server number stamped back, no mint, no reclassification.
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'SO-P726/025',
      orderNumber: 'SO-P726/025',
    });
    expect(out).toBe('ORD-2026-000005');
    const rpcCalls = axios.post.mock.calls.filter(([url]) => isClaimRpc(url));
    expect(rpcCalls).toHaveLength(0);
  });

  it('taken-check sees id-field hits (legacy rows use numbers as ids)', async () => {
    stubGetRow({});
    // Census shape: SO-P726/025 lives in historical id/orderNumber fields.
    // The taken-check OR covers id + both number fields, so any placement
    // blocks adoption and the gateway mints fresh instead.
    stubTakenCheck(['SO-P726/025']);
    stubClaimRpcSeries({ P726: 42 });
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-fresh',
      order_number: 'SO-P726/025',
      orderNumberProvisional: false,
      source_request_id: 'req-1',
    });
    // SO-P726/025 is taken (census) → fresh mint instead of adopting.
    expect(out).toBe('SO-P726/043');
  });

  it('taken-check queries the id column as well as both number fields', async () => {
    stubGetRow({});
    const seen = [];
    stubs.get.push([
      (url, options) => isSalesOrders(url) && typeof (options.params || {}).or === 'string',
      (url, options) => {
        seen.push(String(options.params.or));
        return { data: [] };
      },
    ]);
    stubClaimRpcSeries({ P726: 42 });
    await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-fresh-2',
      order_number: 'SO-P726/043',
      orderNumberProvisional: false,
      source_request_id: 'req-1',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('data->>order_number.eq."SO-P726/043"');
    expect(seen[0]).toContain('data->>orderNumber.eq."SO-P726/043"');
    expect(seen[0]).toContain('id.eq."SO-P726/043"');
  });

  it('legacy ORD-2026 numbers are never adopted as new official numbers', async () => {
    stubGetRow({});
    stubClaimRpcSeries({ P726: 42 });
    const out = await cloudSyncStore.ensureSalesOrderNumber({
      id: 'so-old',
      order_number: 'ORD-2026-000001',
      customer_id: 'cust-1',
    });
    // ORD-YYYY is not a unified official shape → fresh P726 mint by origin.
    expect(out).toBe('ORD-P726/043');
  });
});

describe('shared SO/ORD allocation from P726 → 42', () => {
  beforeEach(resetStubs);

  it('direct then conversion share one sequence: ORD-P726/043, SO-P726/044', async () => {
    stubGetRow({});
    // Counter seeded at verified census max 42 (per-series counters).
    const state = new Map([['P726', 42]]);
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        const next = (state.get(body.p_series) || 0) + 1;
        state.set(body.p_series, next);
        return { data: next };
      },
    ]);
    const direct = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 'd1' }));
    expect(direct).toBe('ORD-P726/043');
    const converted = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ id: 'c1', source_request_id: 'req-1' })
    );
    expect(converted).toBe('SO-P726/044');
  });

  it('reversed order shares the same sequence: SO-P726/043, ORD-P726/044', async () => {
    stubGetRow({});
    const state = new Map([['P726', 42]]);
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        const next = (state.get(body.p_series) || 0) + 1;
        state.set(body.p_series, next);
        return { data: next };
      },
    ]);
    const converted = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ id: 'c2', source_request_id: 'req-2' })
    );
    expect(converted).toBe('SO-P726/043');
    const direct = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 'd2' }));
    expect(direct).toBe('ORD-P726/044');
  });
});

describe('alternate configured series — TEST history seeds TEST → 9', () => {
  const TEST_CONFIG = {
    transactionSettings: { numbering: { shared: { extension: 'TEST', padding: 3 } } },
  };

  beforeEach(() => {
    resetStubs();
    companyConfigService.getCompanyConfig.mockResolvedValue(TEST_CONFIG);
  });

  it('history SO-TEST/007 + ORDER-TEST/009 seeds TEST at 9; next allocations share it', async () => {
    stubGetRow({});
    // Simulates a TEST counter seeded at its historical max (9).
    const state = new Map([['TEST', 9]]);
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        expect(body.p_series).toBe('TEST');
        const next = (state.get(body.p_series) || 0) + 1;
        state.set(body.p_series, next);
        return { data: next };
      },
    ]);
    const direct = await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 't1' }));
    expect(direct).toBe('ORD-TEST/010');
    const converted = await cloudSyncStore.ensureSalesOrderNumber(
      provisionalDirect({ id: 't2', source_request_id: 'req-t' })
    );
    expect(converted).toBe('SO-TEST/011');
  });

  it('P726 counter is untouched by TEST allocations (independent per-series rows)', async () => {
    stubGetRow({});
    const seen = [];
    stubs.post.push([
      (url) => isClaimRpc(url),
      (url, body) => {
        seen.push(body.p_series);
        return { data: 10 };
      },
    ]);
    await cloudSyncStore.ensureSalesOrderNumber(provisionalDirect({ id: 't3' }));
    expect(seen).toEqual(['TEST']);
  });
});

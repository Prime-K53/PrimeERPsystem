/**
 * clientCapabilityGate.test.cjs — the contract-document rollout gate.
 *
 * The gate refuses contract-document writes from a client that declares an
 * outdated document protocol. The requirement lives in the `settings` table and
 * is read as a STRUCTURED STATE:
 *
 *   not_configured - the setting is absent, or it holds the number 0.
 *   required       - a valid capability (a positive integer).
 *   invalid        - the setting exists but its value is not a valid capability.
 *   unavailable    - the setting could not be read.
 *
 * A read failure is NEVER treated as "not configured": the operation is
 * DEFERRED (retryable) so no business data is dead-lettered and no outdated
 * client is let through.
 *
 * The SETTINGS TRANSPORT is mocked; the capability state parsing, the cache and
 * the route are the real code.
 */
const express = require('express');
const request = require('supertest');

const state = {
  /** the settings row returned for required_client_capability (null = absent) */
  setting: null,
  /** when set, the settings read fails with this error */
  readError: null,
  /** every request the transport received */
  calls: [],
};

jest.mock('axios', () => {
  const handler = async (config) => {
    const method = (config.method || 'get').toLowerCase();
    const url = String(config.url || '');
    const params = config.params || {};
    state.calls.push({ method, url, params });

    // the capability setting
    if (url.includes('/rest/v1/settings') && String(params.id || '').includes('required_client_capability')) {
      if (state.readError) throw state.readError;
      if (state.setting === null) return { status: 200, data: [] };
      return { status: 200, data: [{ id: 'required_client_capability', data: state.setting }] };
    }
    // the sync generation
    if (url.includes('/rest/v1/settings') && String(params.id || '').includes('sync_generation')) {
      return { status: 200, data: [{ id: 'sync_generation', data: { value: 1 } }] };
    }
    // the idempotency table + its rows
    if (url.includes('/rest/v1/idempotency_keys')) {
      if (method === 'get') return { status: 200, data: [] };
      return { status: 200, data: [] };
    }
    // the document write itself
    if (url.includes('/rest/v1/contract_documents')) {
      if (method === 'patch') return { status: 200, data: [] };       // 0 rows -> create fallback
      if (method === 'post') {
        return { status: 201, data: [{ id: 'SCH-1', data: { id: 'SCH-1' }, version: 1 }] };
      }
      return { status: 200, data: [] };
    }
    return { status: 200, data: [] };
  };
  const instance = {
    get: jest.fn(async (url, config) => handler({ method: 'get', url, ...(config || {}) })),
    post: jest.fn(async (url, data, config) => handler({ method: 'post', url, data, ...(config || {}) })),
    patch: jest.fn(async (url, data, config) => handler({ method: 'patch', url, data, ...(config || {}) })),
    delete: jest.fn(async (url, config) => handler({ method: 'delete', url, ...(config || {}) })),
  };
  const mock = () => instance;
  mock.create = () => instance;
  mock.__instance = instance;
  return mock;
});

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SECRET_KEY = 'test-secret';

let app;
let syncRouter;

// The capability state is cached inside the service module, so the router (and
// therefore the service) is re-required for every test: each case starts with a
// cold cache and observes exactly the reads it causes.
const buildApp = () => {
  jest.resetModules();
  syncRouter = require('../routes/sync.cjs');
  const express = require('express');
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'admin-1', role: 'admin' }; req.authMode = 'jwt'; next(); });
  app.use('/api/sync', syncRouter);
};

const docOp = (over = {}) => ({
  operationId: 'op-1', table: 'contract_documents', recordId: 'SCH-1', operation: 'upsert',
  syncGeneration: 1,
  payload: { id: 'SCH-1', contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentNumber: 'PC-1', documentVersion: 1, status: 'VALID' },
  ...over,
});

const post = (op) => request(app).post('/api/sync/ops').send({ ops: Array.isArray(op) ? op : [op] });

const writes = () => state.calls.filter((c) => c.url.includes('/rest/v1/contract_documents'));
const documentReads = () => state.calls.filter((c) => c.method === 'get' && c.url.includes('/rest/v1/contract_documents'));
const capabilityReads = () => state.calls.filter((c) => c.url.includes('/rest/v1/settings') && String(c.params.id || '').includes('required_client_capability'));

// The 15 s cache window is driven by an injected clock (Date.now) rather than
// by sleeps, so the transitions below are deterministic.
const REAL_NOW = Date.now();
let fakeNow = REAL_NOW;
let nowSpy = null;
const advanceClock = (ms) => { fakeNow += ms; };

beforeEach(() => {
  state.setting = null;
  state.readError = null;
  state.calls = [];
  fakeNow = REAL_NOW;
  nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => fakeNow);
  buildApp();
});

afterEach(() => {
  if (nowSpy) nowSpy.mockRestore();
  nowSpy = null;
});

describe('capability gate — inactive states', () => {
  it('lets a legacy client write when the setting is absent', async () => {
    const res = await post(docOp());
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(writes().length).toBeGreaterThan(0);
  });

  it('lets a legacy client write when the setting is the number 0', async () => {
    state.setting = { value: 0 };
    const res = await post(docOp());
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(writes().length).toBeGreaterThan(0);
  });
});

describe('capability gate — a configured requirement', () => {
  it('refuses a client that declares capability 1 and never writes', async () => {
    state.setting = { value: 2 };
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.clientTooOld).toBe(true);
    expect(r.error).toMatch(/outdated protocol/i);
    expect(writes().length).toBe(0);
  });

  it('permits a client that declares capability 2', async () => {
    state.setting = { value: 2 };
    const res = await post(docOp({ clientCapabilityVersion: 2 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(writes().length).toBeGreaterThan(0);
  });

  it('permits a client that declares a HIGHER capability', async () => {
    state.setting = { value: 2 };
    const res = await post(docOp({ clientCapabilityVersion: 3 }));
    expect(res.body.results[0].ok).toBe(true);
  });
});

describe('capability gate — invalid configuration defers the operation', () => {
  const invalidValues = [
    ['a numeric string', { value: '2' }],
    ['a non-numeric string', { value: 'abc' }],
    ['null', { value: null }],
    ['a negative number', { value: -1 }],
    ['a fractional number', { value: 1.5 }],
    ['a boolean', { value: true }],
    ['above the supported range', { value: 1001 }],
    ['a malformed settings payload', 'not-an-object'],
  ];

  for (const [label, setting] of invalidValues) {
    it(`defers the operation for ${label}`, async () => {
      state.setting = setting;
      const res = await post(docOp({ clientCapabilityVersion: 1 }));
      const r = res.body.results[0];
      expect(r.ok).toBe(false);
      expect(r.retryable).toBe(true);
      expect(r.serverConfigurationUnavailable).toBe(true);
      expect(r.clientTooOld).toBeUndefined();
      expect(r.error).toMatch(/deferred/i);
      // neither the probe nor the write ran
      expect(writes().length).toBe(0);
    });
  }
});

describe('capability gate — an unreadable setting defers the operation', () => {
  it('defers on a settings read failure', async () => {
    state.readError = new Error('connection refused');
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.serverConfigurationUnavailable).toBe(true);
    expect(writes().length).toBe(0);
  });

  it('defers on a settings read timeout', async () => {
    const timeout = new Error('timeout of 8000ms exceeded');
    timeout.code = 'ECONNABORTED';
    state.readError = timeout;
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.serverConfigurationUnavailable).toBe(true);
    expect(writes().length).toBe(0);
  });

  it('does not let an upgraded client through either (the fault blocks the write, it does not bypass the gate)', async () => {
    state.readError = new Error('connection refused');
    const res = await post(docOp({ clientCapabilityVersion: 2 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(writes().length).toBe(0);
  });
});

describe('capability gate — scope and batching', () => {
  it('never touches a non-document table', async () => {
    state.setting = { value: 2 };
    const res = await post({
      operationId: 'op-2', table: 'products', recordId: 'PRD-1', operation: 'upsert', syncGeneration: 1,
      payload: { id: 'PRD-1', name: 'x', sku: 'S-1', price: 1, stock: 1 },
    });
    const r = res.body.results[0];
    expect(r.ok).toBe(true);
    expect(capabilityReads().length).toBe(0);
  });

  it('reads the requirement AT MOST ONCE for a batch of document operations', async () => {
    state.setting = { value: 2 };
    const res = await post([
      docOp({ operationId: 'op-1', recordId: 'SCH-1', clientCapabilityVersion: 2 }),
      docOp({ operationId: 'op-2', recordId: 'SCH-2', clientCapabilityVersion: 2 }),
      docOp({ operationId: 'op-3', recordId: 'SCH-3', clientCapabilityVersion: 2 }),
    ]);
    expect(res.body.results.length).toBe(3);
    expect(capabilityReads().length).toBe(1);
  });

  it('refuses an unknown table before the gate is consulted', async () => {
    state.setting = { value: 2 };
    const res = await post({ operationId: 'op-9', table: 'not_a_table', recordId: 'x', operation: 'upsert', payload: {} });
    expect(res.body.results[0].ok).toBe(false);
    expect(capabilityReads().length).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * STATE TRANSITIONS — the sequences the Phase 2C review found uncovered.
 * Every case asserts that NO capability-1 document write is ever permitted
 * once a requirement of 2 was in force.
 * ══════════════════════════════════════════════════════════════════════════ */
describe('capability gate — state transitions', () => {
  it('requirement 2 -> malformed configuration: a capability-1 write is never permitted', async () => {
    state.setting = { value: 2 };
    // a first read establishes the requirement
    await post(docOp({ clientCapabilityVersion: 2 }));
    expect(capabilityReads().length).toBe(1);

    // the setting becomes malformed and the cache window elapses
    state.setting = { value: '2' };
    advanceClock(16000);
    state.calls.length = 0;
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(writes().length).toBe(0);
    // either deferred (configuration fault) or refused (outdated client) — never permitted
    const deferred = r.retryable === true && r.serverConfigurationUnavailable === true;
    const refused = r.retryable === false && r.clientTooOld === true;
    expect(deferred || refused).toBe(true);
  });

  it('requirement 2 -> malformed configuration inside the cache window still enforces 2', async () => {
    state.setting = { value: 2 };
    const first = await post(docOp({ clientCapabilityVersion: 2 }));
    expect(first.body.results[0].ok).toBe(true);
    state.setting = { value: '2' };       // malformed, but the cache is still warm
    state.calls.length = 0;
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.clientTooOld).toBe(true);
    expect(writes().length).toBe(0);
    // the cached requirement is still in force: no second settings read
    expect(capabilityReads().length).toBe(0);
  });

  it('requirement 2 -> the settings read fails: the document operation defers with retryable:true', async () => {
    state.setting = { value: 2 };
    await post(docOp({ clientCapabilityVersion: 2 }));
    state.readError = new Error('connection refused');
    advanceClock(16000);
    state.calls.length = 0;
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.serverConfigurationUnavailable).toBe(true);
    // the last known requirement is reported, so an operator can see what the
    // rollout asked for
    expect(r.requiredCapability).toBe(2);
    expect(writes().length).toBe(0);
  });

  it('initially unconfigured -> the settings read fails: the operation defers instead of proceeding', async () => {
    // the row is genuinely absent: the first read says "not configured"
    const first = await post(docOp({ clientCapabilityVersion: 1 }));
    expect(first.body.results[0].ok).toBe(true);

    // the read now fails and the cache window elapses
    state.readError = new Error('connection refused');
    advanceClock(16000);
    state.calls.length = 0;
    const res = await post(docOp({ clientCapabilityVersion: 1 }));
    const r = res.body.results[0];
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.serverConfigurationUnavailable).toBe(true);
    expect(writes().length).toBe(0);
  });

  it('requirement 2 -> 0 -> removed: the stale enforcement is only in the safe direction', async () => {
    state.setting = { value: 2 };
    await post(docOp({ clientCapabilityVersion: 2 }));

    // lowered to 0 but still inside the 15 s window: the cached requirement
    // still applies (over-refusal — the safe direction)
    state.setting = { value: 0 };
    state.calls.length = 0;
    const inWindow = await post(docOp({ clientCapabilityVersion: 1 }));
    expect(inWindow.body.results[0].ok).toBe(false);
    expect(inWindow.body.results[0].clientTooOld).toBe(true);
    expect(writes().length).toBe(0);

    // after the window the lowered value takes effect
    advanceClock(16000);
    state.calls.length = 0;
    const afterWindow = await post(docOp({ clientCapabilityVersion: 1 }));
    expect(afterWindow.body.results[0].ok).toBe(true);

    // and removing the row has the same effect as 0
    state.setting = null;
    advanceClock(16000);
    state.calls.length = 0;
    const removed = await post(docOp({ clientCapabilityVersion: 1 }));
    expect(removed.body.results[0].ok).toBe(true);
  });

  it('concurrent cache expiry: both requests read, and neither permits an unsafe write', async () => {
    state.setting = { value: 2 };
    await post(docOp({ clientCapabilityVersion: 2 }));      // prime the cache
    advanceClock(16000);                                   // expire it
    state.calls.length = 0;

    const [a, b] = await Promise.all([
      post(docOp({ operationId: 'op-a', clientCapabilityVersion: 1 })),
      post(docOp({ operationId: 'op-b', clientCapabilityVersion: 1 })),
    ]);
    const ra = a.body.results[0];
    const rb = b.body.results[0];
    // a duplicate settings read is expected (the cache is per process and the
    // window expired for both callers)
    expect(capabilityReads().length).toBeGreaterThanOrEqual(1);
    // both decisions are identical and neither permits the write
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    expect(ra.clientTooOld).toBe(true);
    expect(rb.clientTooOld).toBe(true);
    expect(writes().length).toBe(0);
  });

  it('a mixed product + document batch during a fault: products proceed, documents defer, no probe runs', async () => {
    state.readError = new Error('connection refused');
    const res = await post([
      {
        operationId: 'op-product', table: 'products', recordId: 'PRD-1', operation: 'upsert', syncGeneration: 1,
        payload: { id: 'PRD-1', name: 'x', sku: 'S-1', price: 1, stock: 1 },
      },
      docOp({ operationId: 'op-document', clientCapabilityVersion: 2 }),
    ]);
    const product = res.body.results.find((r) => r.operationId === 'op-product');
    const document = res.body.results.find((r) => r.operationId === 'op-document');

    expect(product.ok).toBe(true);
    expect(product.serverConfigurationUnavailable).toBeUndefined();
    expect(product.clientTooOld).toBeUndefined();

    expect(document.ok).toBe(false);
    expect(document.retryable).toBe(true);
    expect(document.serverConfigurationUnavailable).toBe(true);
    // neither the write nor the pre-write probe (a read of the documents table)
    // was performed for the deferred operation
    expect(writes().length).toBe(0);
    expect(documentReads().length).toBe(0);
  });

  it('an outdated client and a configuration fault stay distinguishable', async () => {
    state.setting = { value: 2 };
    const outdated = await post(docOp({ operationId: 'op-1', clientCapabilityVersion: 1 }));
    const ro = outdated.body.results[0];
    expect(ro.clientTooOld).toBe(true);
    expect(ro.serverConfigurationUnavailable).toBeUndefined();
    expect(ro.retryable).toBe(false);

    state.readError = new Error('connection refused');
    advanceClock(16000);
    const fault = await post(docOp({ operationId: 'op-2', clientCapabilityVersion: 1 }));
    const rf = fault.body.results[0];
    expect(rf.serverConfigurationUnavailable).toBe(true);
    expect(rf.clientTooOld).toBeUndefined();
    expect(rf.retryable).toBe(true);
    expect(rf.error).not.toBe(ro.error);
  });
});

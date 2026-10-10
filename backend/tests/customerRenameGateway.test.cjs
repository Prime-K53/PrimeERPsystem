/**
 * Gateway-level integration test for customer rename propagation.
 *
 * Exercises the REAL `cloudSyncStore.applyOp` path — pre-image read, cloud
 * write, then the rename cascade — against an in-memory PostgREST stub, so no
 * network access happens.
 */

// ─── in-memory PostgREST stub ────────────────────────────────────────────────
const stubState = { stub: null };

jest.mock('axios', () => {
  const instance = {
    get: async (url, config) => stubState.stub.handleGet(url, config),
    patch: async (url, body, config) => stubState.stub.handlePatch(url, body, config),
    post: async (url, body, config) => stubState.stub.handlePost(url, body, config),
  };
  const mock = () => instance;
  mock.create = () => instance;
  return mock;
});

function parseOperand(value) {
  const raw = String(value);
  if (raw.startsWith('eq.')) return { type: 'eq', value: unquote(raw.slice(3)) };
  if (raw.startsWith('ilike.')) return { type: 'ilike', value: unquote(raw.slice(6)) };
  if (raw === 'is.null' || raw.startsWith('is.null')) return { type: 'isnull' };
  if (raw.startsWith('is.true')) return { type: 'istrue' };
  return { type: 'raw', value: raw };
}

function unquote(value) {
  const trimmed = String(value).trim();
  const inner = trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  return inner.replace(/\\"/g, '"').replace(/\\%/g, '%').replace(/\\_/g, '_').replace(/\\\\/g, '\\');
}

function likeToRegex(operand) {
  const escaped = operand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/%/g, '.*').replace(/_/g, '.')}$`, 'i');
}

function createCloudStub() {
  const tables = new Map();
  const calls = { get: [], patch: [], post: [] };

  const rowsOf = (table) => {
    if (!tables.has(table)) tables.set(table, new Map());
    return tables.get(table);
  };

  const tableFromUrl = (url) => String(url).split('/rest/v1/')[1].split('?')[0];

  const matches = (row, params) => {
    for (const [key, rawValue] of Object.entries(params || {})) {
      if (key === 'select' || key === 'limit' || key === 'offset' || key === 'order' || key === 'on_conflict') continue;
      const operand = parseOperand(rawValue);
      const field = key.startsWith('data->>') ? key.slice('data->>'.length) : null;
      const actual = field ? row.data?.[field] : row[key];
      if (operand.type === 'isnull' && actual != null) return false;
      if (operand.type === 'istrue' && actual !== true) return false;
      if (operand.type === 'eq' && String(actual) !== operand.value) return false;
      if (operand.type === 'ilike' && !likeToRegex(operand.value).test(String(actual ?? ''))) return false;
    }
    return true;
  };

  const stub = {
    tables,
    calls,
    seed(table, rows) {
      const store = rowsOf(table);
      for (const row of rows) store.set(String(row.id), { ...row });
    },
    snapshot(table) {
      return Array.from(rowsOf(table).values());
    },
    async handleGet(url, config = {}) {
      const params = config.params || {};
      calls.get.push({ url, params });
      let rows = Array.from(rowsOf(tableFromUrl(url)).values()).filter((row) => matches(row, params));
      const offset = Number(params.offset || 0);
      if (offset > 0) rows = rows.slice(offset);
      if (params.limit != null) rows = rows.slice(0, Number(params.limit));
      // HTTP responses are serialized snapshots — never the live row objects.
      return { data: rows.map((row) => ({ ...row, data: row.data ? { ...row.data } : row.data })) };
    },
    async handlePatch(url, body, config = {}) {
      const params = (config || {}).params || {};
      calls.patch.push({ url, params, body });
      const store = rowsOf(tableFromUrl(url));
      const target = Array.from(store.values()).find((row) => matches(row, params));
      if (!target) return { data: [] };
      if (body && body.data && typeof body.data === 'object') {
        target.data = { ...target.data, ...body.data };
      }
      if (body && body.updated_at) target.updated_at = body.updated_at;
      if (body && body.version != null) target.version = Number(body.version);
      return { data: [{ ...target, data: { ...target.data } }] };
    },
    async handlePost(url, body, config = {}) {
      calls.post.push({ url, params: (config || {}).params || {}, body });
      const table = tableFromUrl(url);
      const id = String(body?.id ?? '');
      const existing = id ? rowsOf(table).get(id) : null;
      if (existing) {
        if (body?.data && typeof body.data === 'object') existing.data = { ...existing.data, ...body.data };
        if (body?.updated_at) existing.updated_at = body.updated_at;
        if (body?.version != null) existing.version = Number(body.version);
        return { data: [existing] };
      }
      const row = { id, data: body?.data ?? {}, updated_at: body?.updated_at ?? new Date().toISOString(), version: Number(body?.version ?? 1) };
      if (id) rowsOf(table).set(id, row);
      return { data: [row] };
    },
  };

  stubState.stub = stub;
  return stub;
}

describe('cloudSyncStore.applyOp — customer rename cascade', () => {
  const SUPABASE_URL = 'https://test.supabase.co';
  const BASE = '2026-10-10T00:00:00.000Z';

  const customerRow = (id, name, version = 5) => ({
    id,
    data: { id, name, email: `${id}@example.com` },
    updated_at: BASE,
    version,
    created_at: BASE,
  });

  let stub;

  beforeAll(() => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || SUPABASE_URL;
    process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret-key';
    stub = createCloudStub();
  });

  beforeEach(() => {
    stub.tables.clear();
    stub.calls.get = [];
    stub.calls.patch = [];
    stub.calls.post = [];
  });

  // The real client carries its optimistic-concurrency base inside the
  // payload (`_version`), exactly like syncConflictResolver.resolvePushConflict.
  const applyRename = (payload, previousRow) => {
    const op = {
      table: 'customers',
      recordId: payload.id,
      operation: 'upsert',
      payload: { ...payload, _version: previousRow.version, version: previousRow.version },
      syncGeneration: 1,
    };
    return require('../services/cloudSyncStore.cjs').applyOp(op);
  };

  test('rewrites the denormalized name on every linked transaction row', async () => {
    stub.seed('customers', [customerRow('CUST-1', 'Acme')]);
    stub.seed('sales', [
      { id: 'S1', data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme', totalAmount: 100 }, version: 1, updated_at: BASE },
      { id: 'S2', data: { id: 'S2', customerId: 'CUST-2', customerName: 'Acme', totalAmount: 50 }, version: 1, updated_at: BASE },
    ]);
    stub.seed('invoices', [
      { id: 'INV-1', data: { id: 'INV-1', customerId: 'CUST-1', customerName: 'Acme', totalAmount: 100 }, version: 2, updated_at: BASE },
      // Tombstone — history is immutable once deleted.
      { id: 'INV-2', data: { id: 'INV-2', customerId: 'CUST-1', customerName: 'Acme', deleted: true }, version: 2, updated_at: BASE },
    ]);
    stub.seed('customer_payments', [
      { id: 'P1', data: { id: 'P1', customerId: 'CUST-1', customer_name: 'Acme', amount: 20 }, version: 1, updated_at: BASE },
    ]);
    // Unlinked legacy row carrying the old name, and another customer that
    // still answers to it — the legacy row must be left alone.
    stub.seed('customers', [customerRow('CUST-1', 'Acme'), customerRow('CUST-9', 'Acme')]);
    stub.seed('quotations', [
      { id: 'Q1', data: { id: 'Q1', customerName: 'Acme', total: 10 }, version: 1, updated_at: BASE },
    ]);

    const previousRow = stub.snapshot('customers').find((row) => row.id === 'CUST-1');
    const result = await applyRename({ id: 'CUST-1', name: 'Acme Ltd' }, previousRow);

    expect(result.ok).toBe(true);

    const sales = stub.snapshot('sales');
    expect(sales.find((r) => r.id === 'S1').data.customerName).toBe('Acme Ltd');
    expect(sales.find((r) => r.id === 'S2').data.customerName).toBe('Acme'); // other customer

    const invoices = stub.snapshot('invoices');
    expect(invoices.find((r) => r.id === 'INV-1').data.customerName).toBe('Acme Ltd');
    expect(invoices.find((r) => r.id === 'INV-2').data.customerName).toBe('Acme'); // tombstone

    expect(stub.snapshot('customer_payments').find((r) => r.id === 'P1').data.customer_name).toBe('Acme Ltd');
    expect(stub.snapshot('quotations').find((r) => r.id === 'Q1').data.customerName).toBe('Acme'); // ambiguous
  });

  test('does not bump the version of cascaded rows', async () => {
    stub.seed('customers', [customerRow('CUST-1', 'Acme')]);
    stub.seed('sales', [
      { id: 'S1', data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' }, version: 4, updated_at: BASE },
    ]);

    const previousRow = stub.snapshot('customers')[0];
    await applyRename({ id: 'CUST-1', name: 'Acme Ltd' }, previousRow);

    const cascadePatches = stub.calls.patch.filter((call) => call.url.endsWith('/rest/v1/sales'));
    expect(cascadePatches).toHaveLength(1);
    expect(cascadePatches[0].params).toEqual({ id: 'eq.S1', version: 'eq.4' });
    expect(cascadePatches[0].body.version).toBeUndefined();
    expect(stub.snapshot('sales')[0].version).toBe(4);
  });

  test('merges unlinked legacy rows that still carry the previous name', async () => {
    stub.seed('customers', [customerRow('CUST-1', 'Acme')]);
    // No customerId — booked before the customer was linked to the books.
    stub.seed('quotations', [
      { id: 'Q1', version: 1, data: { id: 'Q1', customerName: 'Acme', total: 10 }, updated_at: BASE },
    ]);

    const previousRow = stub.snapshot('customers')[0];
    const result = await applyRename({ id: 'CUST-1', name: 'Acme Ltd' }, previousRow);

    expect(result.ok).toBe(true);
    expect(stub.snapshot('quotations').find((r) => r.id === 'Q1').data.customerName).toBe('Acme Ltd');
    // The legacy row is renamed but never re-parented to the customer.
    expect(stub.snapshot('quotations').find((r) => r.id === 'Q1').data.customerId).toBeUndefined();
  });

  test('is a no-op when the display name does not change', async () => {
    stub.seed('customers', [customerRow('CUST-1', 'Acme')]);
    stub.seed('sales', [
      { id: 'S1', data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' }, version: 1, updated_at: BASE },
    ]);

    const previousRow = stub.snapshot('customers')[0];
    const result = await applyRename({ id: 'CUST-1', name: 'Acme', creditLimit: 5000 }, previousRow);

    expect(result.ok).toBe(true);
    expect(stub.calls.patch.filter((call) => call.url.endsWith('/rest/v1/sales'))).toHaveLength(0);
    expect(stub.snapshot('sales')[0].data.customerName).toBe('Acme');
  });

  test('does not cascade for other tables', async () => {
    stub.seed('customers', [customerRow('CUST-1', 'Acme')]);
    stub.seed('sales', [
      { id: 'S1', data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' }, version: 1, updated_at: BASE },
    ]);

    const result = await require('../services/cloudSyncStore.cjs').applyOp({
      table: 'sales',
      recordId: 'S1',
      operation: 'upsert',
      payload: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme', _version: 1, version: 1 },
      syncGeneration: 1,
    });

    expect(result.ok).toBe(true);
    expect(stub.calls.patch.filter((call) => call.url.endsWith('/rest/v1/sales'))).toHaveLength(1);
    expect(stub.calls.patch.filter((call) => call.url.endsWith('/rest/v1/customers'))).toHaveLength(0);
  });
});

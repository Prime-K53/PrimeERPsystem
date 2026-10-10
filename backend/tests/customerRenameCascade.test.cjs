/**
 * Customer rename propagation (cloud side).
 *
 * A client rename must not split one customer's history into "old name"
 * (previous transactions) and "new name" (future ones). Hermetic: the cloud
 * readers/writers are injected, so no network access happens.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret-key';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const cloudSyncStore = require('../services/cloudSyncStore.cjs');
const propagation = require('../services/customerRenamePropagation.cjs');

const describeBlock = typeof describe === 'function' ? describe : (_name, fn) => fn();
const testBlock = typeof test === 'function' ? test : (_name, fn) => fn();

describeBlock('resolveCloudDisplayName', () => {
  testBlock('prefers businessName, falls back through companyName to name', () => {
    expect(propagation.resolveCloudDisplayName({ businessName: 'Acme Ltd', companyName: 'Acme', name: 'Acme' })).toBe('Acme Ltd');
    expect(propagation.resolveCloudDisplayName({ companyName: 'Acme Ltd', name: 'Acme' })).toBe('Acme Ltd');
    expect(propagation.resolveCloudDisplayName({ name: ' Acme ' })).toBe('Acme');
    expect(propagation.resolveCloudDisplayName(null)).toBe('');
  });
});

describeBlock('planCloudCustomerRename', () => {
  const base = {
    customerId: 'CUST-1',
    previousName: 'Acme',
    nextName: 'Acme Ltd',
    rowsByTable: {},
    otherCustomerNames: [],
  };

  testBlock('renames rows linked by customerId', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        sales: [{ id: 'S1', version: 3, data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' } }],
        invoices: [{ id: 'I1', version: 1, data: { id: 'I1', customerId: 'CUST-1', customer_name: 'Acme' } }],
      },
    });

    expect(plan.patches).toHaveLength(2);
    expect(plan.patches.find((p) => p.table === 'sales').patch).toEqual({ customerName: 'Acme Ltd' });
    // A row that already denormalizes the name in one field is only rewritten
    // in THAT field — no duplicate camel field is manufactured.
    expect(plan.patches.find((p) => p.table === 'invoices').patch).toEqual({ customer_name: 'Acme Ltd' });
  });

  testBlock('fills a missing denormalized name on linked rows', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        sales: [{ id: 'S2', version: 1, data: { id: 'S2', customerId: 'CUST-1' } }],
      },
    });
    expect(plan.patches).toEqual([
      { table: 'sales', id: 'S2', patch: { customerName: 'Acme Ltd' }, version: 1 },
    ]);
  });

  testBlock('renames unlinked legacy rows that still carry the previous name', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        customer_payments: [{ id: 'P1', version: 1, data: { id: 'P1', customerName: 'acme' } }],
      },
    });
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0].patch).toEqual({ customerName: 'Acme Ltd' });
  });

  testBlock('leaves unlinked rows alone when another customer holds the previous name', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        sales: [{ id: 'S3', version: 1, data: { id: 'S3', customerName: 'Acme' } }],
      },
      otherCustomerNames: ['Acme'],
    });
    expect(plan.patches).toHaveLength(0);
    expect(plan.ambiguousPreviousName).toBe(true);
  });

  testBlock('leaves rows linked to another customer untouched', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        sales: [{ id: 'S4', version: 1, data: { id: 'S4', customerId: 'CUST-2', customerName: 'Acme' } }],
      },
    });
    expect(plan.patches).toHaveLength(0);
  });

  testBlock('skips tombstones and unchanged names', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      rowsByTable: {
        sales: [
          { id: 'S5', version: 1, data: { id: 'S5', customerId: 'CUST-1', customerName: 'Acme', deleted: true } },
          { id: 'S6', version: 1, data: { id: 'S6', customerId: 'CUST-1', customerName: 'Acme Ltd' } },
          { id: 'S7', version: 1, data: { id: 'S7', customerId: 'CUST-1', customerName: 'Acme', deletedAt: '2026-01-01T00:00:00Z' } },
        ],
      },
    });
    expect(plan.patches).toHaveLength(0);
  });

  testBlock('is a no-op when previous and next name match', () => {
    const plan = propagation.planCloudCustomerRename({
      ...base,
      nextName: ' ACME ',
      rowsByTable: {
        sales: [{ id: 'S8', version: 1, data: { id: 'S8', customerId: 'CUST-1', customerName: 'Acme' } }],
      },
    });
    expect(plan.patches).toHaveLength(0);
  });
});

describeBlock('cascadeCustomerRename (injected deps)', () => {
  const linkedRow = { id: 'S1', version: 4, data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' } };
  const legacyRow = { id: 'P1', version: 2, data: { id: 'P1', customerName: 'Acme' } };

  const makeDeps = ({ linked = {}, legacy = {} } = {}) => {
    const calls = { fetched: [], patched: [] };
    return {
      calls,
      async fetchRows(table) {
        calls.fetched.push({ table, kind: 'linked' });
        return linked[table] || [];
      },
      async fetchLegacyRows(table) {
        calls.fetched.push({ table, kind: 'legacy' });
        return legacy[table] || [];
      },
      async patchRow(entry, row) {
        calls.patched.push({ entry, row });
        return true;
      },
    };
  };

  const cascadeTables = propagation.CLOUD_CASCADE_TABLES.map((config) => config.table);

  testBlock('rewrites linked and legacy rows across the cascade tables', async () => {
    const deps = makeDeps({ linked: { sales: [linkedRow] }, legacy: { customer_payments: [legacyRow] } });
    const result = await propagation.cascadeCustomerRename({
      customerId: 'CUST-1',
      previousName: 'Acme',
      nextName: 'Acme Ltd',
      deps,
    });

    expect(deps.calls.fetched.filter((c) => c.kind === 'linked')).toHaveLength(cascadeTables.length);
    expect(deps.calls.fetched.filter((c) => c.kind === 'legacy')).toHaveLength(cascadeTables.length);
    expect(result.updated).toBe(2);
    expect(result.tables.sort()).toEqual(['customer_payments', 'sales']);

    const salesPatch = deps.calls.patched.find((c) => c.entry.table === 'sales');
    expect(salesPatch.entry.patch).toEqual({ customerName: 'Acme Ltd' });
    expect(salesPatch.row).toBe(linkedRow);
    const paymentPatch = deps.calls.patched.find((c) => c.entry.table === 'customer_payments');
    expect(paymentPatch.entry.patch).toEqual({ customerName: 'Acme Ltd' });
  });

  testBlock('a failed conditional patch is reported, not retried', async () => {
    const deps = makeDeps({ linked: { sales: [linkedRow] } });
    deps.patchRow = async () => false;
    const result = await propagation.cascadeCustomerRename({
      customerId: 'CUST-1',
      previousName: 'Acme',
      nextName: 'Acme Ltd',
      deps,
    });
    expect(result.updated).toBe(0);
  });

  testBlock('legacy rows are not fetched when the previous name is ambiguous', async () => {
    const deps = makeDeps({ linked: { sales: [linkedRow] }, legacy: { customer_payments: [legacyRow] } });
    const result = await propagation.cascadeCustomerRename({
      customerId: 'CUST-1',
      previousName: 'Acme',
      nextName: 'Acme Ltd',
      otherCustomerNames: ['Acme'],
      deps,
    });
    expect(deps.calls.fetched.some((c) => c.kind === 'legacy')).toBe(false);
    expect(result.updated).toBe(1);
    expect(result.ambiguousPreviousName).toBe(true);
  });
});

describeBlock('createCloudDeps patch semantics', () => {
  testBlock('patches by id + version without bumping the version', async () => {
    const calls = [];
    const cloudHttp = {
      get: async () => ({ data: [] }),
      patch: async (url, body, config) => {
        calls.push({ url, body, config });
        return { data: [{ id: 'S1' }] };
      },
    };

    const deps = propagation.createCloudDeps({
      cloudHttp,
      supabaseUrl: 'https://test.supabase.co',
      adminHeaders: () => ({ apikey: 'k' }),
      serverNow: '2026-10-10T00:00:00Z',
    });

    const ok = await deps.patchRow(
      { table: 'sales', id: 'S1', patch: { customerName: 'Acme Ltd' }, version: 7 },
      { id: 'S1', version: 7, data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme', total: 10 } }
    );

    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].config.params).toEqual({ id: 'eq.S1', version: 'eq.7' });
    expect(calls[0].body.data).toEqual({
      id: 'S1',
      customerId: 'CUST-1',
      customerName: 'Acme Ltd',
      total: 10,
    });
    expect(calls[0].body.updated_at).toBe('2026-10-10T00:00:00Z');
    expect(calls[0].body.version).toBeUndefined();
  });

  testBlock('escapes LIKE wildcards in the legacy name operand', () => {
    expect(propagation.escapeIlikeOperand('100%_School"X')).toBe('100\\%\\_School\\"X');
  });

  testBlock('pages linked rows past a single result page', async () => {
    const requests = [];
    const rows = [];
    for (let i = 1; i <= 1001; i += 1) {
      rows.push({ id: `S${i}`, version: 1, data: { id: `S${i}`, customerId: 'CUST-1', customerName: 'Acme' } });
    }
    // Sorted by id, so the first page is S1..S1000 and the rest is page 2.
    const pages = [rows.slice(0, 1000), rows.slice(1000)];

    const cloudHttp = {
      get: async (url, config) => {
        const offset = Number(config.params.offset || 0);
        requests.push(offset);
        return { data: pages[offset / 1000] || [] };
      },
      patch: async () => ({ data: [{ id: 'x' }] }),
    };

    const deps = propagation.createCloudDeps({
      cloudHttp,
      supabaseUrl: 'https://test.supabase.co',
      adminHeaders: () => ({ apikey: 'k' }),
      serverNow: '2026-10-10T00:00:00Z',
    });

    const config = propagation.CLOUD_CASCADE_TABLES.find((entry) => entry.table === 'sales');
    const fetched = await deps.fetchRows('sales', config, 'CUST-1');

    expect(requests).toEqual([0, 1000]);
    expect(fetched).toHaveLength(1001);
  });
});

describeBlock('cloudSyncStore.propagateCustomerRenameToCloud', () => {
  testBlock('propagates a rename through the gateway path', async () => {
    const patched = [];
    const deps = {
      async fetchRows(table) {
        return table === 'sales'
          ? [{ id: 'S1', version: 1, data: { id: 'S1', customerId: 'CUST-1', customerName: 'Acme' } }]
          : [];
      },
      async fetchLegacyRows() { return []; },
      async patchRow(entry, row) { patched.push({ entry, row }); return true; },
    };

    const result = await cloudSyncStore.propagateCustomerRenameToCloud(
      'CUST-1',
      { id: 'CUST-1', businessName: 'Acme Ltd' },
      { id: 'CUST-1', data: { id: 'CUST-1', businessName: 'Acme' } },
      { deps, listCustomers: async () => [] }
    );

    expect(result.updated).toBe(1);
    expect(patched).toHaveLength(1);
    expect(patched[0].entry.patch).toEqual({ customerName: 'Acme Ltd' });
    // The patch is applied to the row as stored (still carrying the old name).
    expect(patched[0].row.data.customerName).toBe('Acme');
  });

  testBlock('does nothing when the display name is unchanged', async () => {
    const deps = {
      fetchRows: jest.fn(),
      fetchLegacyRows: jest.fn(),
      patchRow: jest.fn(),
    };

    const result = await cloudSyncStore.propagateCustomerRenameToCloud(
      'CUST-1',
      { id: 'CUST-1', name: 'Acme' },
      { id: 'CUST-1', data: { id: 'CUST-1', name: 'Acme' } },
      { deps, listCustomers: async () => [] }
    );

    expect(result.updated).toBe(0);
    expect(deps.fetchRows).not.toHaveBeenCalled();
  });
});

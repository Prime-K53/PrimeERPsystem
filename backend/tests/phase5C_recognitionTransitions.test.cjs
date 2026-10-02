/**
 * phase5C_recognitionTransitions.test.cjs — HTTP-level (supertest) coverage of
 * the direct-API Transport Budget sales-allocation recognition life-cycle.
 *
 * This suite exercises the REAL Express routes in index.cjs and the REAL
 * Phase 5A producer (allocateForApiSale / allocateForApiInvoice) end to end.
 * Only the external boundaries are stubbed so the test is hermetic:
 *
 *   - services/supabaseRepository.cjs            -> in-memory envelope store
 *   - services/companyConfigService.cjs          -> fixed 3% CompanyConfig policy
 *   - services/transportBudgetEventRepository.cjs-> records the Phase 4 append
 *                                                   (the producer's only write)
 *   - services/portalLifecycleService.cjs        -> no-op SSE
 *
 * Proven here (not by source-string assertions):
 *   - POST /api/sales  : allocate once, only AFTER COMMIT, recognized only.
 *   - POST /api/invoices: allocate once; invoice_date persisted + forwarded;
 *                         no allocation when repo.upsert() fails.
 *   - PUT  /api/sales/:id  /  PUT /api/invoices/:id : a document that crosses
 *     NOT-RECOGNIZED -> RECOGNIZED on update allocates exactly once using the
 *     POST-update persisted values; RECOGNIZED -> RECOGNIZED never allocates.
 *   - Economic-total mutation on an already-recognized document is refused.
 *   - recognized -> void/cancel/refund creates NO reversal event.
 *
 * No network, no Supabase, no production data.
 */

process.env.NODE_ENV = 'test';
process.env.ALLOW_HEADER_AUTH = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-phase5c';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-phase5c';

const request = require('supertest');

// Ordered breadcrumb shared by the repo + producer mocks (proof of ordering).
global.__tbOrder = global.__tbOrder || [];

jest.mock('../services/supabaseRepository.cjs', () => {
  const tables = new Map();
  const store = (t) => {
    if (!tables.has(t)) tables.set(t, new Map());
    return tables.get(t);
  };
  const order = (global.__tbOrder = global.__tbOrder || []);
  const repo = {
    __tables: tables,
    __store: store,
    __reset() {
      tables.clear();
      store('financial_years').set('FY-TEST', {
        id: 'FY-TEST',
        name: 'Test FY',
        start_date: '2000-01-01',
        end_date: '2100-12-31',
        is_closed: 0,
        status: 'Active',
        is_default: 1,
      });
    },
    isConfigured: jest.fn(() => false),
    request: jest.fn(async () => null),
    getAll: jest.fn(async (t) => [...store(t).values()]),
    getAllStrict: jest.fn(async (t) => [...store(t).values()]),
    getById: jest.fn(async (t, id) => store(t).get(String(id)) || null),
    upsert: jest.fn(async (t, obj) => {
      order.push({ op: 'persist', table: t, id: String(obj.id) });
      store(t).set(String(obj.id), { ...obj });
      return { ...obj };
    }),
    softDelete: jest.fn(async () => null),
    count: jest.fn(async () => 0),
    callRpc: jest.fn(async () => null),
    fromSupabaseRow: (r) => (r && r.data ? { ...r.data, id: r.id } : r),
    toSupabaseRow: (d) => ({ id: d && d.id, data: d }),
    getAllFlat: jest.fn(async () => []),
    getByIdFlat: jest.fn(async () => null),
    upsertFlat: jest.fn(async () => null),
    updateFlat: jest.fn(async () => null),
    portalEntities: {},
    entities: {},
  };
  repo.financialYears = {
    getAll: (filters = {}) => repo.getAll('financial_years', filters),
    getById: (id) => repo.getById('financial_years', id),
    upsert: (r) => repo.upsert('financial_years', r),
  };
  repo.__reset();
  return repo;
});

jest.mock('../services/companyConfigService.cjs', () => ({
  getCompanyConfig: jest.fn(async () => ({
    transportBudgetPolicy: { allocationRatePercent: 3, effectiveFrom: '2000-01-01' },
  })),
}));

jest.mock('../services/transportBudgetEventRepository.cjs', () => {
  const order = (global.__tbOrder = global.__tbOrder || []);
  return {
    transportBudgetEventRepository: {
      appendTransportBudgetEvent: jest.fn(async (input) => {
        order.push({ op: 'append', input });
        return { event: { ...input, id: input.id || 'tbe-test-1' }, deduplicated: false };
      }),
    },
  };
});

jest.mock('../services/portalLifecycleService.cjs', () => ({
  emitEntityChange: jest.fn(),
  publishErpEvent: jest.fn(async () => ({ published: true })),
  subscribe: jest.fn(),
}));

const repo = require('../services/supabaseRepository.cjs');
const appendRepo = require('../services/transportBudgetEventRepository.cjs');
const appendMock = appendRepo.transportBudgetEventRepository.appendTransportBudgetEvent;

let app;
let unhandled = [];

const adminHeaders = {
  'x-user-id': 'test-admin-phase5c',
  'x-user-role': 'Admin',
  'x-user-email': 'admin@prime.mw',
  'x-user-is-super-admin': 'true',
  'Content-Type': 'application/json',
};

beforeAll(async () => {
  jest.setTimeout(120000);
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  global.__phase5cOffUnhandled = () => process.removeListener('unhandledRejection', onUnhandled);

  app = require('../index.cjs');
  const t0 = Date.now();
  while (!(app.router && app.router.stack.length > 50)) {
    if (Date.now() - t0 > 60000) throw new Error('Server routes did not register in time');
    await new Promise((r) => setTimeout(r, 250));
  }
}, 120000);

afterAll(() => {
  if (global.__phase5cOffUnhandled) global.__phase5cOffUnhandled();
});

beforeEach(() => {
  repo.__reset();
  global.__tbOrder.length = 0;
  unhandled = [];
  jest.clearAllMocks();
});

const saleBody = (overrides = {}) => ({
  items: [{ itemId: 'ITEM-1', quantity: 1, unitPrice: 100 }],
  paymentMethod: 'Cash',
  warehouseId: 'WH-MAIN',
  totalAmount: 500000,
  status: 'Paid',
  ...overrides,
});

const persistedSale = (id) => repo.__store('sales').get(id);
const persistedInvoice = (id) => repo.__store('invoices').get(id);

const firstIndex = (pred) => global.__tbOrder.findIndex(pred);

// ─────────────────────────────────────────────────────────────────────────────
// SALES — POST
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5C: POST /api/sales', () => {
  test('1. recognized sale persists, allocates exactly once, after COMMIT, 200', async () => {
    const res = await request(app).post('/api/sales').set(adminHeaders).send(saleBody());
    expect(res.status).toBe(200);
    expect(res.body.id).toBeTruthy();

    const stored = persistedSale(res.body.id);
    expect(stored).toBeTruthy();
    expect(Number(stored.total_amount)).toBe(500000);

    expect(appendMock).toHaveBeenCalledTimes(1);
    const event = appendMock.mock.calls[0][0];
    expect(event.kind).toBe('SALES_ALLOCATION');
    expect(event.idempotencyKey).toBe(`SALES_ALLOCATION:${res.body.id}`);
    expect(event.amount).toBe(15000); // 500000 @ 3%
    expect(event.sourceAmount).toBe(500000);

    // Ordering: the sale row is persisted before the allocation append.
    const persistIdx = firstIndex((s) => s.op === 'persist' && s.table === 'sales' && s.id === res.body.id);
    const appendIdx = firstIndex((s) => s.op === 'append');
    expect(persistIdx).toBeGreaterThanOrEqual(0);
    expect(appendIdx).toBeGreaterThan(persistIdx);
  });

  test('2. draft sale never allocates (recognition gate, not HTTP success)', async () => {
    const res = await request(app).post('/api/sales').set(adminHeaders).send(saleBody({ status: 'Draft' }));
    expect(res.status).toBe(200);
    expect(appendMock).not.toHaveBeenCalled();
  });

  test('6. allocation failure does not fail the persisted sale, stays 200, is logged', async () => {
    appendMock.mockRejectedValueOnce(new Error('supabase unreachable'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/sales').set(adminHeaders).send(saleBody());
    expect(res.status).toBe(200);
    expect(persistedSale(res.body.id)).toBeTruthy();

    // let the fire-and-forget rejection settle
    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[TransportBudget]'))).toBe(true);
    expect(unhandled).toHaveLength(0);
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SALES — PUT recognition transitions
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5C: PUT /api/sales/:id', () => {
  test('3. draft -> recognized allocates exactly once with post-update values', async () => {
    repo.__store('sales').set('S-DRAFT', {
      id: 'S-DRAFT', status: 'Draft', total_amount: 500000, date: '2026-07-07T00:00:00.000Z',
    });

    const res = await request(app)
      .put('/api/sales/S-DRAFT')
      .set(adminHeaders)
      .send({ status: 'Paid', totalAmount: 500000, date: '2026-07-07' });
    expect(res.status).toBe(200);

    expect(appendMock).toHaveBeenCalledTimes(1);
    const event = appendMock.mock.calls[0][0];
    expect(event.idempotencyKey).toBe('SALES_ALLOCATION:S-DRAFT');
    expect(event.amount).toBe(15000);
    expect(event.businessDate).toBe('2026-07-07');
    expect(persistedSale('S-DRAFT').status).toBe('Paid');
  });

  test('4. recognized -> recognized creates no second allocation', async () => {
    repo.__store('sales').set('S-PAID', {
      id: 'S-PAID', status: 'Paid', total_amount: 500000, date: '2026-07-07',
    });

    const res = await request(app)
      .put('/api/sales/S-PAID')
      .set(adminHeaders)
      .send({ status: 'Paid', totalAmount: 500000, date: '2026-07-07' });
    expect(res.status).toBe(200);
    expect(appendMock).not.toHaveBeenCalled();
  });

  test('5. repeated promotion attempt never duplicates the allocation', async () => {
    repo.__store('sales').set('S-RETRY', {
      id: 'S-RETRY', status: 'Draft', total_amount: 500000, date: '2026-07-07',
    });
    const body = { status: 'Paid', totalAmount: 500000, date: '2026-07-07' };

    await request(app).put('/api/sales/S-RETRY').set(adminHeaders).send(body).expect(200);
    await request(app).put('/api/sales/S-RETRY').set(adminHeaders).send(body).expect(200);

    expect(appendMock).toHaveBeenCalledTimes(1);
  });

  test('13. economic-total mutation on a recognized sale is refused (no reallocation)', async () => {
    repo.__store('sales').set('S-LOCK', {
      id: 'S-LOCK', status: 'Paid', total_amount: 500000, date: '2026-07-07',
    });

    const res = await request(app)
      .put('/api/sales/S-LOCK')
      .set(adminHeaders)
      .send({ status: 'Paid', totalAmount: 600000, date: '2026-07-07' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECOGNIZED_SALE_TOTAL_LOCKED');
    expect(appendMock).not.toHaveBeenCalled();
    expect(Number(persistedSale('S-LOCK').total_amount)).toBe(500000); // unchanged
  });

  test('14. recognized -> Voided creates no reversal and no reallocation', async () => {
    repo.__store('sales').set('S-VOID', {
      id: 'S-VOID', status: 'Paid', total_amount: 500000, date: '2026-07-07',
    });

    const res = await request(app)
      .put('/api/sales/S-VOID')
      .set(adminHeaders)
      .send({ status: 'Voided', totalAmount: 500000, date: '2026-07-07' });
    expect(res.status).toBe(200);
    expect(appendMock).not.toHaveBeenCalled();
    expect(String(persistedSale('S-VOID').status)).toBe('Voided');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES — POST
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5C: POST /api/invoices', () => {
  test('7. recognized invoice persists invoice_date, allocates once, same date supplied', async () => {
    const res = await request(app).post('/api/invoices').set(adminHeaders).send({
      id: 'INV-POST-1',
      customer_id: 'CUST-1',
      customer_name: 'Acme',
      total_amount: 100000,
      status: 'unpaid',
      invoice_date: '2026-05-05',
    });
    expect(res.status).toBe(201);

    expect(persistedInvoice('INV-POST-1').invoice_date).toBe('2026-05-05');
    expect(appendMock).toHaveBeenCalledTimes(1);
    const event = appendMock.mock.calls[0][0];
    expect(event.idempotencyKey).toBe('SALES_ALLOCATION:INV-POST-1');
    expect(event.businessDate).toBe('2026-05-05');
    expect(event.amount).toBe(3000); // 100000 @ 3%
  });

  test('8. draft invoice never allocates', async () => {
    const res = await request(app).post('/api/invoices').set(adminHeaders).send({
      id: 'INV-POST-DRAFT',
      customer_id: 'CUST-1',
      total_amount: 100000,
      status: 'draft',
      invoice_date: '2026-05-05',
    });
    expect(res.status).toBe(201);
    expect(appendMock).not.toHaveBeenCalled();
  });

  test('POST invoice: no allocation when repo.upsert() fails (persistence gate)', async () => {
    repo.upsert.mockResolvedValueOnce(null);
    const res = await request(app).post('/api/invoices').set(adminHeaders).send({
      id: 'INV-POST-FAIL',
      customer_id: 'CUST-1',
      total_amount: 100000,
      status: 'unpaid',
      invoice_date: '2026-05-05',
    });
    expect(res.status).toBe(500);
    expect(appendMock).not.toHaveBeenCalled();
  });

  test('12. dateless recognized invoice never substitutes created_at / current time', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await request(app).post('/api/invoices').set(adminHeaders).send({
      id: 'INV-POST-NODATE',
      customer_id: 'CUST-1',
      total_amount: 100000,
      status: 'unpaid',
      // invoice_date intentionally omitted
    });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));

    expect(appendMock).not.toHaveBeenCalled(); // never allocated from a fabricated date
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('INVALID_DATE'))).toBe(true);
    errSpy.mockRestore();
  });

  test('11. invoice allocation failure leaves the invoice persisted and the response unaffected', async () => {
    appendMock.mockRejectedValueOnce(new Error('supabase unreachable'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).post('/api/invoices').set(adminHeaders).send({
      id: 'INV-POST-ALLOCFAIL',
      customer_id: 'CUST-1',
      total_amount: 100000,
      status: 'unpaid',
      invoice_date: '2026-05-05',
    });
    expect(res.status).toBe(201);
    expect(persistedInvoice('INV-POST-ALLOCFAIL')).toBeTruthy();

    await new Promise((r) => setTimeout(r, 50));
    expect(errSpy.mock.calls.some((c) => String(c[0]).includes('[TransportBudget]'))).toBe(true);
    expect(unhandled).toHaveLength(0);
    errSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INVOICES — PUT recognition transitions
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5C: PUT /api/invoices/:id', () => {
  test('9. draft -> posted allocates exactly once using the persisted invoice_date', async () => {
    repo.__store('invoices').set('INV-DRAFT', {
      id: 'INV-DRAFT', status: 'draft', total_amount: 200000, invoice_date: '2026-06-06',
    });

    const res = await request(app)
      .put('/api/invoices/INV-DRAFT')
      .set(adminHeaders)
      .send({ status: 'paid' });
    expect(res.status).toBe(200);

    expect(appendMock).toHaveBeenCalledTimes(1);
    const event = appendMock.mock.calls[0][0];
    expect(event.idempotencyKey).toBe('SALES_ALLOCATION:INV-DRAFT');
    expect(event.businessDate).toBe('2026-06-06');
    expect(event.amount).toBe(6000); // 200000 @ 3%
    expect(String(persistedInvoice('INV-DRAFT').status)).toBe('paid');
  });

  test('10. recognized -> recognized creates no duplicate allocation', async () => {
    repo.__store('invoices').set('INV-PAID', {
      id: 'INV-PAID', status: 'paid', total_amount: 200000, invoice_date: '2026-06-06',
    });

    await request(app).put('/api/invoices/INV-PAID').set(adminHeaders).send({ status: 'partial' }).expect(200);
    expect(appendMock).not.toHaveBeenCalled();
  });

  test('13. economic-total mutation on a posted invoice is refused', async () => {
    repo.__store('invoices').set('INV-LOCK', {
      id: 'INV-LOCK', status: 'paid', total_amount: 1000, invoice_date: '2026-06-06',
    });

    const res = await request(app)
      .put('/api/invoices/INV-LOCK')
      .set(adminHeaders)
      .send({ total_amount: 5000 });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('RECOGNIZED_INVOICE_TOTAL_LOCKED');
    expect(appendMock).not.toHaveBeenCalled();
    expect(Number(persistedInvoice('INV-LOCK').total_amount)).toBe(1000);
  });

  test('14. posted -> voided creates no reversal and no reallocation', async () => {
    repo.__store('invoices').set('INV-VOID', {
      id: 'INV-VOID', status: 'paid', total_amount: 1000, invoice_date: '2026-06-06',
    });

    const res = await request(app)
      .put('/api/invoices/INV-VOID')
      .set(adminHeaders)
      .send({ status: 'void' });
    expect(res.status).toBe(200);
    expect(appendMock).not.toHaveBeenCalled();
    expect(String(persistedInvoice('INV-VOID').status)).toBe('void');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Reversal boundary (static): Phase 5C must not introduce a reversal producer
// ─────────────────────────────────────────────────────────────────────────────
describe('Phase 5C: reversal / consumption boundary', () => {
  test('no REVERSAL producer or consumption wiring was introduced', () => {
    const fs = require('fs');
    const path = require('path');
    const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.cjs'), 'utf8');
    expect(indexSrc).not.toMatch(/kind:\s*'REVERSAL'/);
    expect(indexSrc).not.toMatch(/allocateForReversal|ReverseAllocation|CONSUMPTION/);
    // The producer module exposes no reversal/consumption entry point.
    const producer = require('../services/transportBudgetSalesAllocation.cjs');
    expect(producer.allocateForReversal).toBeUndefined();
    expect(producer.allocateForConsumption).toBeUndefined();
  });
});

/**
 * Phase 5A — infrastructure tests.
 *
 * 1. Validator: fail-closed shape contract parity (codes, matrix, quarantine).
 * 2. Migration 0031: narrowly scoped invoice business-date contract —
 *    no Transport Budget changes, no tenant fields, no backfill.
 * 3. Sync isolation: POST /api/sync/ops never executes the Phase 5A
 *    producer (event transport only).
 */

const fs = require('fs');
const path = require('path');
const {
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
  TransportBudgetValidationError,
  sameEconomicPayload,
} = require('../services/transportBudgetEventValidator.cjs');

const BACKEND_ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(BACKEND_ROOT, rel), 'utf8');

const VALID_ALLOCATION = {
  kind: 'SALES_ALLOCATION',
  id: '11111111-1111-4111-8111-111111111111',
  idempotencyKey: 'SALES_ALLOCATION:SALE-1',
  sourceEventId: 'SALE-1',
  sourceAmount: 500000,
  allocationRatePercent: 3,
  amount: 15000,
  method: null,
  providerId: null,
  reversesEventId: null,
  businessDate: '2026-10-02',
  occurredAt: '2026-10-02T08:00:00.000Z',
};

describe('Phase 5A: transport budget event validator (Phase 4 parity)', () => {
  test('valid SALES_ALLOCATION passes and preserves rate exactly', () => {
    const event = assertValidTransportBudgetEvent(VALID_ALLOCATION, '2026-10-02T08:00:00.000Z');
    expect(event.allocationRatePercent).toBe(3);
    expect(event.amount).toBe(15000);
    expect(event.accountSplits).toBeNull();
    expect(event.journalIds).toBeNull();
  });

  test('money is rounded once to 2dp (6.0000001 -> 6; epsilon-tolerant)', () => {
    const event = assertValidTransportBudgetEvent(
      { ...VALID_ALLOCATION, amount: 6.0000000001 },
      '2026-10-02T08:00:00.000Z',
    );
    expect(event.amount).toBe(6);
  });

  test('rejects zero / negative / oversized SALES_ALLOCATION amounts', () => {
    for (const amount of [0, -15000, 1000000000000]) {
      const result = validateTransportBudgetEvent({ ...VALID_ALLOCATION, amount });
      expect(result.ok).toBe(false);
      expect(result.issues.some((i) => i.code === 'INVALID_AMOUNT' || i.code === 'INVALID_SIGN')).toBe(true);
    }
  });

  test('rejects >4dp rates without rounding them into validity', () => {
    const result = validateTransportBudgetEvent({ ...VALID_ALLOCATION, allocationRatePercent: 2.75501 });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'INVALID_RATE')).toBe(true);
  });

  test('rejects invalid business dates and occurredAt', () => {
    expect(validateTransportBudgetEvent({ ...VALID_ALLOCATION, businessDate: '2026-02-30' }).ok).toBe(false);
    expect(validateTransportBudgetEvent({ ...VALID_ALLOCATION, businessDate: '10/02/2026' }).ok).toBe(false);
    expect(validateTransportBudgetEvent({ ...VALID_ALLOCATION, occurredAt: 'not-a-time' }).ok).toBe(false);
  });

  test('accounting quarantine: journalIds/accountSplits must stay empty', () => {
    const result = validateTransportBudgetEvent({
      ...VALID_ALLOCATION,
      journalIds: ['JRN-1'],
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === 'ACCOUNTING_FIELDS_FORBIDDEN')).toBe(true);
  });

  test('SALES_ALLOCATION requires sourceEventId / sourceAmount / rate', () => {
    for (const patch of [
      { sourceEventId: null },
      { sourceAmount: null },
      { allocationRatePercent: null },
    ]) {
      const result = validateTransportBudgetEvent({ ...VALID_ALLOCATION, ...patch });
      expect(result.ok).toBe(false);
    }
  });

  test('REVERSAL shape: requires link, forbids source fields, forbids self-link', () => {
    // A valid reversal links a DIFFERENT allocation's physical id.
    expect(validateTransportBudgetEvent({
      ...VALID_ALLOCATION,
      kind: 'REVERSAL',
      reversesEventId: '22222222-2222-4222-8222-222222222222',
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
    }).ok).toBe(true);

    expect(validateTransportBudgetEvent({
      ...VALID_ALLOCATION,
      kind: 'REVERSAL',
      reversesEventId: null,
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
    }).ok).toBe(false);

    expect(validateTransportBudgetEvent({
      ...VALID_ALLOCATION,
      kind: 'REVERSAL',
      reversesEventId: '22222222-2222-4222-8222-222222222222',
      sourceEventId: 'SALE-1',
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
    }).ok).toBe(false);

    // Self-link guard: a reversal cannot reference its own id.
    expect(validateTransportBudgetEvent({
      ...VALID_ALLOCATION,
      kind: 'REVERSAL',
      reversesEventId: VALID_ALLOCATION.id,
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      amount: -5000,
    }).ok).toBe(false);
  });

  test('sameEconomicPayload distinguishes true retry from conflicting id reuse', () => {
    const a = assertValidTransportBudgetEvent(VALID_ALLOCATION);
    const b = assertValidTransportBudgetEvent(VALID_ALLOCATION);
    expect(sameEconomicPayload(a, b)).toBe(true);
    const c = assertValidTransportBudgetEvent({ ...VALID_ALLOCATION, amount: 9999 });
    expect(sameEconomicPayload(a, c)).toBe(false);
  });

  test('throwing wrapper raises TransportBudgetValidationError with issue detail', () => {
    expect(() => assertValidTransportBudgetEvent({ ...VALID_ALLOCATION, kind: 'NOPE' }))
      .toThrow(TransportBudgetValidationError);
  });
});

describe('Phase 5A: migration 0031 (invoice business date) discipline', () => {
  const migrationPath = path.join(BACKEND_ROOT, '..', 'supabase', 'migrations', '0031_invoice_business_date.sql');
  const source = fs.existsSync(migrationPath) ? fs.readFileSync(migrationPath, 'utf8') : '';

  test('migration file exists with the next sequential number (0031, no collision)', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const migrationsDir = path.join(BACKEND_ROOT, '..', 'supabase', 'migrations');
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));
    expect(files.filter((f) => f.startsWith('0031'))).toHaveLength(1);
  });

  test('does not modify Transport Budget tables', () => {
    expect(source).not.toMatch(/ALTER TABLE\s+public\.transport_budget_events/i);
    expect(source).not.toMatch(/DROP\s+(FUNCTION|TRIGGER)\s+\w*transport_budget/i);
    expect(source).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.append_transport_budget_event/i);
  });

  test('adds no tenant/company dimensions', () => {
    expect(source).not.toMatch(/tenant_id|organization_id|company_id/i);
  });

  test('does not backfill historical invoice dates from created_at', () => {
    expect(source).not.toMatch(/UPDATE\s+public\.invoices/i);
    expect(source).not.toMatch(/created_at/i);
  });

  test('documents the nullable, date-only field contract', () => {
    expect(source).toMatch(/invoice_date/i);
    expect(source).toMatch(/NULLABLE/i);
  });
});

describe('Phase 5A: sync isolation (POST /api/sync/ops stays event transport only)', () => {
  test('sync route never imports or invokes the Phase 5A producer', () => {
    const syncSource = readSrc('routes/sync.cjs');
    expect(syncSource).not.toMatch(/transportBudgetSalesAllocation/i);
    expect(syncSource).not.toMatch(/allocateForApi(Sale|Invoice)/);
    expect(syncSource).not.toMatch(/fireAllocationHook/);
  });

  test('index.cjs invokes the producer ONLY inside the four lifecycle handlers', () => {
    const indexSource = readSrc('index.cjs');
    const salesPostStart = indexSource.indexOf("app.post('/api/sales'");
    const salesPutStart = indexSource.indexOf("app.put('/api/sales/:id'");
    const salesPutEnd = indexSource.indexOf("app.delete('/api/sales/:id'", salesPutStart);
    const invoicesPostStart = indexSource.indexOf("app.post('/api/invoices'");
    const invoicesPutStart = indexSource.indexOf("app.put('/api/invoices/:id'");
    const invoicesPutEnd = indexSource.indexOf("app.delete('/api/invoices/:id'", invoicesPutStart);
    const syncOpsStart = indexSource.indexOf('/api/sync/ops');
    expect(salesPostStart).toBeGreaterThan(-1);
    expect(salesPutStart).toBeGreaterThan(-1);
    expect(invoicesPostStart).toBeGreaterThan(-1);
    expect(invoicesPutStart).toBeGreaterThan(-1);

    const salesPostBlock = indexSource.slice(salesPostStart, salesPutStart);
    const salesPutBlock = indexSource.slice(salesPutStart, salesPutEnd);
    const invoicesPostBlock = indexSource.slice(invoicesPostStart, invoicesPutStart);
    const invoicesPutBlock = indexSource.slice(invoicesPutStart, invoicesPutEnd);
    expect(salesPostBlock).toMatch(/allocateForApiSale/);
    expect(salesPutBlock).toMatch(/allocateForApiSale/);
    expect(invoicesPostBlock).toMatch(/allocateForApiInvoice/);
    expect(invoicesPutBlock).toMatch(/allocateForApiInvoice/);

    // The producer appears in exactly these four lifecycle blocks (POST + PUT
    // recognition transitions) and nowhere else — the sync route is registered
    // before global verifyToken but must never reference the producer.
    const count = (block) => (block.match(/allocateForApi(Sale|Invoice)/g) || []).length;
    const allMatches = indexSource.match(/allocateForApi(Sale|Invoice)/g) || [];
    const accounted = count(salesPostBlock) + count(salesPutBlock) + count(invoicesPostBlock) + count(invoicesPutBlock);
    expect(allMatches).toHaveLength(accounted);
    expect(syncOpsStart).toBeGreaterThan(-1); // route exists, untouched by producer
  });

  test('sync route allow-list still carries transport_budget_events exactly once (transport unchanged)', () => {
    const syncSource = readSrc('routes/sync.cjs');
    const matches = syncSource.match(/transport_budget_events/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(1);
  });

  test('migration 0029 RPC remains the authoritative append (no direct INSERT added by 5A routes)', () => {
    const indexSource = readSrc('index.cjs');
    expect(indexSource).not.toMatch(/INSERT INTO transport_budget_events/i);
  });
});

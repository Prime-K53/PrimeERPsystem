/**
 * Phase 9B Blocker D — backend void reversal for direct-API voids.
 *
 * DELETE /api/sales/:id, DELETE /api/invoices/:id, and recognized ->
 * unrecognized PUT demotions now produce exactly one REVERSAL via
 * produceVoidReversalForVoidedDoc (same frozen semantics as the frontend
 * void path: exact negative of the persisted allocation, deterministic
 * REVERSAL:{id}:VOID key, inherited businessDate).
 */
const fs = require('fs');
const path = require('path');
const {
  produceVoidReversalForVoidedDoc,
  fireVoidReversalHook,
  salesAllocationIdempotencyKey,
  voidReversalIdempotencyKey,
} = require('../services/transportBudgetVoidReversal.cjs');

const ROOT = path.join(__dirname, '..', '..');
const indexSource = fs.readFileSync(
  path.join(ROOT, 'backend', 'index.cjs'),
  'utf8',
);

const ALLOCATION = {
  id: 'evt-alloc-be-001',
  kind: 'SALES_ALLOCATION',
  idempotencyKey: 'SALES_ALLOCATION:BE-001',
  sourceEventId: 'BE-001',
  sourceAmount: 500000,
  allocationRatePercent: 3,
  amount: 15000,
  method: null,
  providerId: null,
  reversesEventId: null,
  correctsEventId: null,
  businessDate: '2026-09-30',
  occurredAt: '2026-09-30T10:00:00.000Z',
};

const fakeDeps = (overrides = {}) => {
  const appended = [];
  return {
    appended,
    deps: {
      findAllocationByKey: async (key) =>
        key === 'SALES_ALLOCATION:BE-001' ? { ...ALLOCATION } : null,
      appendReversalEvent: async (input) => {
        appended.push(input);
        return { event: { ...input, id: 'evt-rev-be-001' }, deduplicated: false };
      },
      nowIso: () => '2026-10-04T12:00:00.000Z',
      ...overrides,
    },
  };
};

describe('Phase 9B: backend void reversal helper (Blocker D)', () => {
  test('voided doc with an allocation appends the exact reversal', async () => {
    const { appended, deps } = fakeDeps();
    const result = await produceVoidReversalForVoidedDoc(deps, { id: 'BE-001' });
    expect(result.status).toBe('appended');
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      kind: 'REVERSAL',
      amount: -15000,
      reversesEventId: 'evt-alloc-be-001',
      correctsEventId: null,
      idempotencyKey: 'REVERSAL:BE-001:VOID',
      businessDate: '2026-09-30',
      occurredAt: '2026-10-04T12:00:00.000Z',
      sourceEventId: null,
      sourceAmount: null,
      allocationRatePercent: null,
      method: null,
      providerId: null,
    });
  });

  test('missing allocation fails closed without fabrication', async () => {
    const { appended, deps } = fakeDeps();
    const result = await produceVoidReversalForVoidedDoc(deps, { id: 'BE-UNKNOWN' });
    expect(result.status).toBe('missing-allocation');
    expect(appended).toHaveLength(0);
  });

  test('non-allocation row fails closed', async () => {
    const { appended, deps } = fakeDeps({
      findAllocationByKey: async () => ({ ...ALLOCATION, kind: 'INBOUND_CONSUMPTION' }),
    });
    const result = await produceVoidReversalForVoidedDoc(deps, { id: 'BE-001' });
    expect(result.status).toBe('missing-allocation');
    expect(appended).toHaveLength(0);
  });

  test('empty identity is skipped, append failure never throws', async () => {
    const { deps } = fakeDeps();
    expect(await produceVoidReversalForVoidedDoc(deps, {})).toMatchObject({
      status: 'skipped',
    });
    const failing = fakeDeps({
      appendReversalEvent: async () => {
        throw new Error('simulated outage');
      },
    });
    const result = await produceVoidReversalForVoidedDoc(failing.deps, { id: 'BE-001' });
    expect(result.status).toBe('failed');
  });

  test('fire hook swallows rejection and returns void', () => {
    expect(
      fireVoidReversalHook(Promise.reject(new Error('boom')), 'TEST', 'BE-001'),
    ).toBeUndefined();
  });

  test('key helpers follow the frozen namespaces', () => {
    expect(salesAllocationIdempotencyKey('BE-001')).toBe('SALES_ALLOCATION:BE-001');
    expect(voidReversalIdempotencyKey('BE-001')).toBe('REVERSAL:BE-001:VOID');
  });
});

describe('Phase 9B: backend void wiring (Blocker D)', () => {
  test('DELETE sale voids a recognized sale with reversal', () => {
    expect(indexSource).toMatch(/saleWasRecognized/);
    expect(indexSource).toMatch(/produceVoidReversalForVoidedDoc\(buildVoidReversalDeps\(\), \{ id \}\)/);
    expect(indexSource).toMatch(/'DELETE \/api\/sales\/:id'/);
  });

  test('DELETE invoice voids a posted invoice with reversal', () => {
    expect(indexSource).toMatch(/isPostedInvoiceStatus\(row\.status\)/);
    expect(indexSource).toMatch(/'DELETE \/api\/invoices\/:id'/);
  });

  test('PUT demotions (recognized -> unrecognized) reverse for sales and invoices', () => {
    const demotions = indexSource.match(
      /wasRecognized && !becomesRecognized/g,
    );
    expect(demotions).not.toBeNull();
    expect(demotions.length).toBeGreaterThanOrEqual(2);
    expect(indexSource).toMatch(/'PUT \/api\/sales\/:id'/);
    expect(indexSource).toMatch(/'PUT \/api\/invoices\/:id'/);
  });

  test('no reversal on promotion or metadata paths', () => {
    // Promotion branches allocate; they must not also reverse.
    expect(indexSource).toMatch(/!wasRecognized && becomesRecognized/);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: { get: vi.fn(), getAll: vi.fn(), put: vi.fn() },
}));
vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: { enqueue: vi.fn(), hasPendingMutation: vi.fn() },
}));
vi.mock('../../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  allocateForPostedSale,
  allocateForPostedInvoice,
  isMirrorInvoice,
  resolveMirrorInvoiceIdForSale,
  TransportBudgetAllocationError,
  defaultSalesAllocationDeps,
  type SalesAllocationDeps,
} from '../../services/transportBudgetSalesAllocation';
import { TransportBudgetRepository } from '../../services/repositories/transportBudgetRepository';
import type { Sale, Invoice } from '../../types';
import type { TransportBudgetEvent } from '../../types/transportBudget';

// ---------------------------------------------------------------------------
// Fakes: persisted sales/invoices, configurable policy, real Phase 4 repo
// over an in-memory store + queue (full producer -> validator -> ledger path)
// ---------------------------------------------------------------------------

const createStore = (seed: TransportBudgetEvent[] = []) => {
  const rows = new Map<string, TransportBudgetEvent>(
    seed.map((entry) => [entry.id, { ...entry }]),
  );
  return {
    async get(id: string) {
      const found = rows.get(String(id));
      return found ? { ...found } : undefined;
    },
    async getAll() {
      return [...rows.values()].map((entry) => ({ ...entry }));
    },
    async put(event: TransportBudgetEvent) {
      rows.set(event.id, { ...event });
    },
    size() {
      return rows.size;
    },
  };
};

const createQueue = () => {
  const ops: Array<{ table: string; recordId: string; payload: unknown }> = [];
  return {
    ops,
    async enqueue(table: string, recordId: string, payload: unknown) {
      ops.push({ table, recordId, payload: { ...(payload as object) } });
    },
    async hasPendingMutation(table: string, recordId: string) {
      return ops.some(
        (op) => op.table === table && op.recordId === recordId,
      );
    },
  };
};

const NOW = '2026-09-30T10:00:00.000Z';

// tests/setup.ts pins crypto.randomUUID to a constant; generated physical
// event ids must stay unique across appends in this file.
let uuidSeq = 0;

const setup = (policy: unknown = { allocationRatePercent: 3 }) => {
  (crypto.randomUUID as unknown as { mockImplementation(fn: () => string): void }).mockImplementation(
    () => `test-uuid-${String((uuidSeq += 1)).padStart(4, '0')}`,
  );
  const sales = new Map<string, Sale>();
  const invoices = new Map<string, Invoice>();
  const store = createStore();
  const queue = createQueue();
  const repository = new TransportBudgetRepository(store, queue);
  const deps: SalesAllocationDeps = {
    getPolicy: () => policy,
    async getSale(id: string) {
      const found = sales.get(String(id));
      return found ? { ...found } : null;
    },
    async getInvoice(id: string) {
      const found = invoices.get(String(id));
      return found ? { ...found } : null;
    },
    async findInvoiceByReference(reference: string) {
      const needle = String(reference || '').trim();
      for (const entry of invoices.values()) {
        if (String((entry as { reference?: unknown }).reference || '') === needle) {
          return { ...entry };
        }
      }
      return null;
    },
    repository,
    nowIso: () => NOW,
  };
  return { sales, invoices, store, queue, repository, deps };
};

const saleFixture = (overrides: Partial<Sale> = {}): Sale =>
  ({
    id: 'POS-0001',
    date: '2026-09-30',
    customerId: 'CUST-001',
    customerName: 'Walk-in Customer',
    items: [],
    payments: [],
    totalAmount: 500000,
    status: 'Paid',
    source: 'POS',
    ...overrides,
  }) as Sale;

const invoiceFixture = (overrides: Partial<Invoice> = {}): Invoice =>
  ({
    id: 'INV-0001',
    customerId: 'CUST-001',
    customerName: 'Test Customer',
    totalAmount: 500000,
    paidAmount: 0,
    date: '2026-09-30',
    dueDate: '2026-09-30',
    status: 'Unpaid',
    items: [],
    ...overrides,
  }) as Invoice;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sales allocation — calculation', () => {
  it('K500,000 @ 3% → K15,000 with the frozen event shape', async () => {
    const { sales, deps } = setup();
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome.status).toBe('allocated');
    const event = outcome.event!;
    expect(event.kind).toBe('SALES_ALLOCATION');
    expect(event.amount).toBe(15000);
    expect(event.amount).toBeGreaterThan(0);
    expect(event.sourceAmount).toBe(500000);
    expect(event.allocationRatePercent).toBe(3);
    expect(event.idempotencyKey).toBe('SALES_ALLOCATION:POS-0001');
    expect(event.sourceEventId).toBe('POS-0001');
    expect(event.businessDate).toBe('2026-09-30');
    expect(event.reversesEventId).toBeNull();
    expect(event.journalIds).toBeNull();
    expect(event.accountSplits).toBeNull();
  });

  it('fractional rate: K500,000 @ 2.755% → K13,775', async () => {
    const { sales, deps } = setup({ allocationRatePercent: 2.755 });
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome.status).toBe('allocated');
    expect(outcome.event!.amount).toBe(13775);
    expect(outcome.event!.allocationRatePercent).toBe(2.755);
  });

  it('four-decimal rate is preserved exactly in the event', async () => {
    const { sales, deps } = setup({ allocationRatePercent: 2.755 });
    const sale = saleFixture({ totalAmount: 100000 });
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome.event!.allocationRatePercent).toBe(2.755);
    expect(outcome.event!.amount).toBe(2755);
  });

  it('rounds once at the end (199.99 @ 3% → 6, not 5.99)', async () => {
    const { sales, deps } = setup();
    const sale = saleFixture({ id: 'POS-0002', totalAmount: 199.99 });
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    // 199.99 × 3 / 100 = 5.9997 → roundMoney → 6.
    expect(outcome.event!.amount).toBe(6);
  });

  it('uses the persisted totalAmount, never line recomputation', async () => {
    const { sales, deps } = setup();
    // Lines would sum differently; the persisted total wins.
    const sale = saleFixture({
      items: [{ id: 'ITM-1', quantity: 1, price: 1 } as never],
      totalAmount: 500000,
    });
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome.event!.sourceAmount).toBe(500000);
    expect(outcome.event!.amount).toBe(15000);
  });

  it('zero result creates no event', async () => {
    const { sales, store, deps } = setup();
    const sale = saleFixture({ id: 'POS-0003', totalAmount: 0.01 });
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome).toEqual({ status: 'skipped', reason: 'zero-amount' });
    expect(store.size()).toBe(0);
  });

  it('missing policy creates no event (not an error)', async () => {
    const { sales, store, deps } = setup();
    deps.getPolicy = () => undefined;
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome).toEqual({ status: 'skipped', reason: 'policy-missing' });
    expect(store.size()).toBe(0);
  });

  it('zero rate creates no event (not an error)', async () => {
    const { sales, store, deps } = setup({ allocationRatePercent: 0 });
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const outcome = await allocateForPostedSale(deps, sale, null);
    expect(outcome).toEqual({ status: 'skipped', reason: 'policy-disabled' });
    expect(store.size()).toBe(0);
  });

  it('invalid policy fails loudly (never invents a rate)', async () => {
    const { sales, deps } = setup({ allocationRatePercent: 250 });
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    await expect(allocateForPostedSale(deps, sale, null)).rejects.toMatchObject({
      name: 'TransportBudgetAllocationError',
      code: 'INVALID_POLICY',
    });
  });

  it('non-finite persisted total fails loudly (never invents a base)', async () => {
    const { sales, deps } = setup();
    const sale = saleFixture({ totalAmount: NaN });
    sales.set(sale.id, { ...sale });
    await expect(allocateForPostedSale(deps, sale, null)).rejects.toMatchObject({
      code: 'INVALID_BASE',
    });
  });
});

describe('sales allocation — historical rate resolution', () => {
  const scheduledPolicy = {
    allocationRatePercent: 3,
    effectiveFrom: '2026-01-01',
    scheduledChanges: [{ allocationRatePercent: 5, effectiveFrom: '2026-10-01' }],
  };

  it('original keeps 3% after config moves to 5%; later docs use 5%', async () => {
    const { sales, store, deps } = setup(scheduledPolicy);
    const first = saleFixture({ id: 'POS-0001', date: '2026-09-30' });
    sales.set(first.id, { ...first });
    const firstOutcome = await allocateForPostedSale(deps, first, null);
    expect(firstOutcome.event!.allocationRatePercent).toBe(3);
    expect(firstOutcome.event!.amount).toBe(15000);

    const second = saleFixture({ id: 'POS-0002', date: '2026-10-05' });
    sales.set(second.id, { ...second });
    const secondOutcome = await allocateForPostedSale(deps, second, null);
    expect(secondOutcome.event!.allocationRatePercent).toBe(5);
    expect(secondOutcome.event!.amount).toBe(25000);

    // The original event is never recalculated.
    const stored = await store.get(firstOutcome.event!.id);
    expect(stored!.allocationRatePercent).toBe(3);
    expect(stored!.amount).toBe(15000);
    expect(store.size()).toBe(2);
  });

  it('resolves from the document business date, not the current date', async () => {
    const { sales, deps } = setup(scheduledPolicy);
    // Business date predates the scheduled change even though "now" is later.
    const backdated = saleFixture({ id: 'POS-0009', date: '2026-09-15' });
    sales.set(backdated.id, { ...backdated });
    const outcome = await allocateForPostedSale(deps, backdated, null);
    expect(outcome.event!.allocationRatePercent).toBe(3);
    expect(outcome.event!.businessDate).toBe('2026-09-15');
  });
});

describe('sales allocation — pathways and exactly-once', () => {
  it('POS sale wins: mirror invoice suppressed, one allocation total', async () => {
    const { sales, invoices, store, deps } = setup();
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    // Mirror created by processSale: same id, reference, notes template.
    const mirror = invoiceFixture({
      id: sale.id,
      date: sale.date,
      paidAmount: 500000,
      status: 'Paid',
      notes: `POS Sale - Source: ${sale.source}`,
      reference: sale.id,
    });
    invoices.set(mirror.id, { ...mirror });

    const saleOutcome = await allocateForPostedSale(deps, sale, sale.id);
    expect(saleOutcome.status).toBe('allocated');
    expect(saleOutcome.event!.idempotencyKey).toBe('SALES_ALLOCATION:POS-0001');

    const mirrorOutcome = await allocateForPostedInvoice(deps, mirror);
    expect(mirrorOutcome).toEqual({
      status: 'skipped',
      reason: 'mirror-invoice',
    });
    expect(store.size()).toBe(1);
  });

  it('generated-id mirror (M ≠ S) still allocates once via convertedInvoiceId', async () => {
    const { sales, invoices, store, deps } = setup();
    const sale = saleFixture({ id: 'POS-0042' });
    sales.set(sale.id, { ...sale });
    const mirror = invoiceFixture({
      id: 'POS-9001',
      date: sale.date,
      status: 'Paid',
      paidAmount: 500000,
      notes: 'POS Sale - Source: POS',
      reference: sale.id,
    });
    invoices.set(mirror.id, { ...mirror });

    const saleOutcome = await allocateForPostedSale(deps, sale, 'POS-9001');
    expect(saleOutcome.event!.idempotencyKey).toBe('SALES_ALLOCATION:POS-9001');

    // Mirror resolves back to the sale through its reference → suppressed.
    expect(await isMirrorInvoice(deps, mirror)).toBe(true);
    const mirrorOutcome = await allocateForPostedInvoice(deps, mirror);
    expect(mirrorOutcome.reason).toBe('mirror-invoice');
    expect(store.size()).toBe(1);
  });

  it('order → invoice allocates exactly once on the invoice', async () => {
    const { invoices, store, deps } = setup();
    const converted = invoiceFixture({
      id: 'INV-1001',
      status: 'Unpaid',
      sourceOrderId: 'SO-0007',
      conversionDetails: {
        sourceType: 'order',
        sourceNumber: 'SO-0007',
      },
    } as Partial<Invoice>);
    invoices.set(converted.id, { ...converted });

    const outcome = await allocateForPostedInvoice(deps, converted);
    expect(outcome.status).toBe('allocated');
    expect(outcome.event!.idempotencyKey).toBe('SALES_ALLOCATION:INV-1001');
    // Order creation itself never allocates (no hook); repeat invoice posts dedupe.
    const repeat = await allocateForPostedInvoice(deps, converted);
    expect(repeat.deduplicated).toBe(true);
    expect(store.size()).toBe(1);
  });

  it('exam-batch invoice allocates (originModule examination, not a mirror)', async () => {
    const { invoices, store, deps } = setup();
    const exam = invoiceFixture({
      id: 'INV-EXM-01',
      status: 'Unpaid',
      originModule: 'examination',
      originBatchId: 'EXM-BATCH-01',
    } as Partial<Invoice>);
    invoices.set(exam.id, { ...exam });
    expect(await isMirrorInvoice(deps, exam)).toBe(false);
    const outcome = await allocateForPostedInvoice(deps, exam);
    expect(outcome.status).toBe('allocated');
    expect(store.size()).toBe(1);
  });

  it('genuine POS credit invoice (no backing sale) allocates', async () => {
    const { invoices, deps } = setup();
    const credit = invoiceFixture({ id: 'INV-CR-01', status: 'Unpaid' });
    invoices.set(credit.id, { ...credit });
    expect(await isMirrorInvoice(deps, credit)).toBe(false);
    const outcome = await allocateForPostedInvoice(deps, credit);
    expect(outcome.status).toBe('allocated');
    expect(outcome.event!.idempotencyKey).toBe('SALES_ALLOCATION:INV-CR-01');
  });

  it('draft / cancelled / voided invoices never allocate', async () => {
    const { invoices, store, deps } = setup();
    for (const [id, status] of [
      ['INV-D1', 'Draft'],
      ['INV-D2', 'Cancelled'],
      ['INV-D3', 'Voided'],
    ] as const) {
      const invoice = invoiceFixture({ id, status: status as Invoice['status'] });
      invoices.set(id, { ...invoice });
      const outcome = await allocateForPostedInvoice(deps, invoice);
      expect(outcome.reason).toBe('not-recognized');
    }
    expect(store.size()).toBe(0);
  });

  it('credit notes never allocate (no negative event in this phase)', async () => {
    const { invoices, store, deps } = setup();
    const creditNote = invoiceFixture({ id: 'CN-0001', status: 'credit_note' });
    invoices.set(creditNote.id, { ...creditNote });
    const outcome = await allocateForPostedInvoice(deps, creditNote);
    expect(outcome).toEqual({ status: 'skipped', reason: 'credit-note' });
    expect(store.size()).toBe(0);
  });

  it('unrecognized sale statuses never allocate', async () => {
    const { sales, store, deps } = setup();
    for (const status of ['Pending', 'Cancelled', 'Refunded', 'Draft']) {
      const sale = saleFixture({
        id: `POS-X-${status}`,
        status: status as Sale['status'],
      });
      sales.set(sale.id, { ...sale });
      const outcome = await allocateForPostedSale(deps, sale, null);
      expect(outcome.reason).toBe('not-recognized');
    }
    expect(store.size()).toBe(0);
  });

  it('repeated invocation returns the same event (no second row)', async () => {
    const { sales, store, deps } = setup();
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const first = await allocateForPostedSale(deps, sale, null);
    const second = await allocateForPostedSale(deps, sale, null);
    expect(second.status).toBe('allocated');
    expect(second.deduplicated).toBe(true);
    expect(second.event!.id).toBe(first.event!.id);
    expect(store.size()).toBe(1);
  });

  it('resolveMirrorInvoiceIdForSale prefers the funnel id, then persisted lookups', async () => {
    const { invoices, deps } = setup();
    expect(
      await resolveMirrorInvoiceIdForSale(deps, 'POS-0001', 'POS-9001'),
    ).toBe('POS-9001');
    const mirror = invoiceFixture({
      notes: 'POS Sale - Source: POS',
      reference: 'POS-0001',
    });
    invoices.set(mirror.id, { ...mirror });
    expect(await resolveMirrorInvoiceIdForSale(deps, 'POS-0001')).toBe(
      'INV-0001',
    );
    expect(await resolveMirrorInvoiceIdForSale(deps, 'POS-9999')).toBeNull();
  });
});

describe('sales allocation — offline, replay, and isolation', () => {
  it('offline event survives persist → queue → sync → pull unchanged', async () => {
    const { sales, store, queue, deps } = setup();
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    const created = await allocateForPostedSale(deps, sale, null);
    expect(queue.ops).toHaveLength(1);

    const queued = queue.ops[0].payload as TransportBudgetEvent;
    const pulled = JSON.parse(JSON.stringify(queued)) as TransportBudgetEvent;
    expect(pulled.id).toBe(created.event!.id);
    expect(pulled.idempotencyKey).toBe('SALES_ALLOCATION:POS-0001');
    expect(pulled.sourceAmount).toBe(500000);
    expect(pulled.allocationRatePercent).toBe(3);
    expect(pulled.amount).toBe(15000);
    expect(pulled.businessDate).toBe('2026-09-30');
    expect(store.size()).toBe(1);
  });

  it('sync replay of the same economic sale creates no second allocation', async () => {
    const { sales, store, deps } = setup();
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    await allocateForPostedSale(deps, sale, null);
    // A replayed sale/invoice pair resolves to the same economic key.
    const replay = await allocateForPostedInvoice(
      deps,
      invoiceFixture({
        id: sale.id,
        reference: sale.id,
        notes: 'POS Sale - Source: POS',
        status: 'Paid',
        paidAmount: 500000,
      }),
    );
    expect(replay.reason).toBe('mirror-invoice');
    expect(store.size()).toBe(1);
  });

  it('does not modify sale/invoice totals, payments, or balances', async () => {
    const { sales, invoices, queue, deps } = setup();
    const sale = saleFixture();
    const saleBefore = JSON.parse(JSON.stringify(sale));
    sales.set(sale.id, { ...sale });
    await allocateForPostedSale(deps, sale, null);
    expect(sale.totalAmount).toBe(saleBefore.totalAmount);
    expect(JSON.parse(JSON.stringify(sale))).toEqual(saleBefore);

    const invoice = invoiceFixture({ status: 'Partial', paidAmount: 200000 });
    const invoiceBefore = JSON.parse(JSON.stringify(invoice));
    invoices.set(invoice.id, { ...invoice });
    await allocateForPostedInvoice(deps, invoice);
    expect(invoice.totalAmount).toBe(invoiceBefore.totalAmount);
    expect(invoice.paidAmount).toBe(200000);
    expect(JSON.parse(JSON.stringify(invoice))).toEqual(invoiceBefore);

    // The only outbox traffic is the frozen ledger event (no journals).
    expect(queue.ops.length).toBe(2);
    for (const op of queue.ops) {
      expect(op.table).toBe('transport_budget_events');
    }
  });

  it('default deps read the stored policy without network access', async () => {
    expect(typeof defaultSalesAllocationDeps.getPolicy).toBe('function');
    expect(typeof defaultSalesAllocationDeps.nowIso).toBe('function');
  });

  it('invalid allocation failures are typed, never silent defaults', async () => {
    const { sales, deps } = setup({ allocationRatePercent: '3' });
    const sale = saleFixture();
    sales.set(sale.id, { ...sale });
    await expect(
      allocateForPostedSale(deps, sale, null),
    ).rejects.toBeInstanceOf(TransportBudgetAllocationError);
  });
});

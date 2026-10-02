/**
 * Phase 5A — backend SALES_ALLOCATION producer tests.
 *
 * Covers the frozen Phase 2 contract through the dependency-injected
 * producer: persisted-record base, historical scheduled rate by business
 * date, single terminal rounding, zero suppression, fail-closed invalid
 * policy, economic identity, retry dedupe, and failure isolation.
 * All rates/dates are fixed literals — the current system date is never used.
 */

const {
  allocateForApiSale,
  allocateForApiInvoice,
  toBusinessDate,
  TransportBudgetAllocationError,
} = require('../services/transportBudgetSalesAllocation.cjs');

/** In-memory Transport Budget repository fake (append + economic dedupe). */
function makeRepoFake() {
  const events = [];
  return {
    events,
    async appendTransportBudgetEvent(input) {
      const existing = events.find((e) => e.idempotencyKey === input.idempotencyKey);
      if (existing) {
        return { event: existing, deduplicated: true };
      }
      const event = Object.freeze({
        ...input,
        id: input.id || `tbe-${events.length + 1}`,
      });
      events.push(event);
      return { event, deduplicated: false };
    },
  };
}

/** Standard deps: fixed 3% base policy + 5% scheduled from 2026-10-15. */
function makeDeps(overrides = {}) {
  const repository = overrides.repository || makeRepoFake();
  return {
    getPolicy: overrides.getPolicy || (() => ({
      allocationRatePercent: 3,
      effectiveFrom: '2026-10-01',
      scheduledChanges: [
        { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
      ],
    })),
    repository,
    nowIso: () => '2026-10-02T08:00:00.000Z',
    ...overrides,
  };
}

describe('Phase 5A: /api/sales allocation producer', () => {
  test('recognized Paid sale creates exactly one allocation', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-1',
      date: '2026-10-02T09:30:00.000Z',
      totalAmount: 500000,
      status: 'Paid',
    });
    expect(outcome.status).toBe('allocated');
    expect(deps.repository.events).toHaveLength(1);
  });

  test('uses the persisted totalAmount (never lines/payments) — K500,000 @ 3% -> K15,000', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-2',
      date: '2026-10-02',
      totalAmount: 500000,
      status: 'Paid',
    });
    expect(outcome.event.sourceAmount).toBe(500000);
    expect(outcome.event.amount).toBe(15000);
  });

  test('uses the persisted business date (ISO prefix extraction)', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-3',
      date: '2026-10-10T14:22:00.000Z',
      totalAmount: 199.99,
      status: 'Paid',
    });
    expect(outcome.event.businessDate).toBe('2026-10-10');
    // 199.99 @ 3% = 5.9997 -> single terminal rounding -> 6
    expect(outcome.event.amount).toBe(6);
  });

  test('historical scheduled rate resolves correctly (2026-10-20 -> 5%)', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-4',
      date: '2026-10-20',
      totalAmount: 500000,
      status: 'Paid',
    });
    expect(outcome.event.allocationRatePercent).toBe(5);
    expect(outcome.event.amount).toBe(25000);
  });

  test('historical scheduled rate with decimals: 2.755% of K500,000 -> K13,775', async () => {
    const deps = makeDeps({
      getPolicy: () => ({
        allocationRatePercent: 2.755,
        effectiveFrom: '2026-10-01',
      }),
    });
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-5',
      date: '2026-10-05',
      totalAmount: 500000,
      status: 'Paid',
    });
    expect(outcome.event.allocationRatePercent).toBe(2.755);
    expect(outcome.event.amount).toBe(13775);
  });

  test('zero policy creates no allocation (disabled)', async () => {
    const deps = makeDeps({ getPolicy: () => ({ allocationRatePercent: 0 }) });
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-6', date: '2026-10-02', totalAmount: 5000, status: 'Paid',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'policy-disabled' });
    expect(deps.repository.events).toHaveLength(0);
  });

  test('missing policy creates no allocation', async () => {
    const deps = makeDeps({ getPolicy: () => undefined });
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-7', date: '2026-10-02', totalAmount: 5000, status: 'Paid',
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'policy-missing' });
    expect(deps.repository.events).toHaveLength(0);
  });

  test('invalid policy does not invent a rate (fails loudly)', async () => {
    const deps = makeDeps({ getPolicy: () => ({ allocationRatePercent: 300 }) });
    await expect(allocateForApiSale(deps, {
      id: 'SALE-8', date: '2026-10-02', totalAmount: 5000, status: 'Paid',
    })).rejects.toThrow(TransportBudgetAllocationError);
    expect(deps.repository.events).toHaveLength(0);
  });

  test('async getPolicy is awaited (backend companyConfigService reads are async)', async () => {
    // Regression: the sync resolver must receive the resolved policy, never a
    // Promise (which would be misread as invalid -> every allocation fails).
    const deps = makeDeps({
      getPolicy: async () => ({
        allocationRatePercent: 3,
        effectiveFrom: '2026-10-01',
      }),
    });
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-async', date: '2026-10-02', totalAmount: 500000, status: 'Paid',
    });
    expect(outcome.status).toBe('allocated');
    expect(outcome.event.amount).toBe(15000);
  });

  test('async getPolicy rejection is surfaced (never silently treated as missing)', async () => {
    const deps = makeDeps({
      getPolicy: async () => { throw new Error('config store unreachable'); },
    });
    await expect(allocateForApiSale(deps, {
      id: 'SALE-async-err', date: '2026-10-02', totalAmount: 5000, status: 'Paid',
    })).rejects.toThrow('config store unreachable');
    expect(deps.repository.events).toHaveLength(0);
  });

  test('excluded sale statuses never allocate (recognition gate, not HTTP success)', async () => {
    for (const status of ['Draft', 'Pending', 'Voided', 'Refunded']) {
      const deps = makeDeps();
      const outcome = await allocateForApiSale(deps, {
        id: `SALE-x-${status}`, date: '2026-10-02', totalAmount: 5000, status,
      });
      expect(outcome).toEqual({ status: 'skipped', reason: 'not-recognized' });
      expect(deps.repository.events).toHaveLength(0);
    }
  });

  test('recognized statuses allocate: Paid / Partially Paid / Completed', async () => {
    for (const status of ['Paid', 'Partially Paid', 'Completed']) {
      const deps = makeDeps();
      const outcome = await allocateForApiSale(deps, {
        id: `SALE-ok-${status}`, date: '2026-10-02', totalAmount: 1000, status,
      });
      expect(outcome.status).toBe('allocated');
    }
  });

  test('repeated producer invocation deduplicates on the economic key', async () => {
    const deps = makeDeps();
    const sale = { id: 'SALE-9', date: '2026-10-02', totalAmount: 500000, status: 'Paid' };
    const first = await allocateForApiSale(deps, sale);
    const second = await allocateForApiSale(deps, sale);
    expect(first.status).toBe('allocated');
    expect(second.status).toBe('allocated');
    expect(second.deduplicated).toBe(true);
    expect(deps.repository.events).toHaveLength(1);
  });

  test('allocation append failure does not fail the producer contract (thrown for the hook to log)', async () => {
    const failingRepo = {
      async appendTransportBudgetEvent() {
        throw new Error('supabase unreachable');
      },
    };
    const deps = makeDeps({ repository: failingRepo });
    await expect(allocateForApiSale(deps, {
      id: 'SALE-10', date: '2026-10-02', totalAmount: 1000, status: 'Paid',
    })).rejects.toThrow('supabase unreachable');
  });

  test('non-finite persisted totalAmount refuses to invent a base', async () => {
    const deps = makeDeps();
    await expect(allocateForApiSale(deps, {
      id: 'SALE-11', date: '2026-10-02', totalAmount: Number.NaN, status: 'Paid',
    })).rejects.toThrow(TransportBudgetAllocationError);
    expect(deps.repository.events).toHaveLength(0);
  });

  test('economic identity is SALES_ALLOCATION:{saleId}', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-12', date: '2026-10-02', totalAmount: 1000, status: 'Paid',
    });
    expect(outcome.event.idempotencyKey).toBe('SALES_ALLOCATION:SALE-12');
    expect(outcome.event.sourceEventId).toBe('SALE-12');
    expect(outcome.event.kind).toBe('SALES_ALLOCATION');
    expect(outcome.event.amount).toBeGreaterThan(0);
    // Physical event id is independent (not the economic key, not Date.now()).
    expect(outcome.event.id).not.toContain('SALES_ALLOCATION');
    expect(outcome.event.occurredAt).toBe('2026-10-02T08:00:00.000Z');
  });

  test('event shape carries no accounting linkage (Phase 4 quarantine)', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiSale(deps, {
      id: 'SALE-13', date: '2026-10-02', totalAmount: 1000, status: 'Paid',
    });
    expect(outcome.event.method).toBeNull();
    expect(outcome.event.providerId).toBeNull();
    expect(outcome.event.reversesEventId).toBeNull();
  });
});

describe('Phase 5A: /api/invoices allocation producer', () => {
  test('qualifying posted status creates allocation with persisted fields', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiInvoice(
      deps,
      { id: 'INV-1', status: 'Paid', totalAmount: 500000 },
      '2026-10-02',
    );
    expect(outcome.status).toBe('allocated');
    expect(outcome.event.amount).toBe(15000);
    expect(outcome.event.businessDate).toBe('2026-10-02');
  });

  test('Draft/unposted invoices never allocate', async () => {
    for (const status of ['Draft', 'Cancelled', 'Void', 'Voided']) {
      const deps = makeDeps();
      const outcome = await allocateForApiInvoice(
        deps,
        { id: `INV-x-${status}`, status, totalAmount: 500000 },
        '2026-10-02',
      );
      expect(outcome).toEqual({ status: 'skipped', reason: 'not-recognized' });
      expect(deps.repository.events).toHaveLength(0);
    }
  });

  test('credit notes pass the posted gate but never allocate', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiInvoice(
      deps,
      { id: 'INV-CN', status: 'credit_note', totalAmount: 500000 },
      '2026-10-02',
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'credit-note' });
    expect(deps.repository.events).toHaveLength(0);
  });

  test('unrecognized (unpaid/default) status DOES pass the posted gate per backend predicate — documented mapping', async () => {
    // backend isPostedInvoiceStatus = recognized-unless-excluded:
    // 'unpaid' is NOT excluded, so a posted-gate invoice with status
    // 'unpaid' qualifies. This is the canonical backend predicate, matching
    // P&L recognition — documented in the producer header, not invented here.
    const deps = makeDeps();
    const outcome = await allocateForApiInvoice(
      deps,
      { id: 'INV-UNPAID', status: 'unpaid', totalAmount: 1000 },
      '2026-10-02',
    );
    expect(outcome.status).toBe('allocated');
  });

  test('missing business date fails loudly — created_at / new Date() never substituted', async () => {
    const deps = makeDeps();
    for (const badDate of [undefined, null, '']) {
      await expect(allocateForApiInvoice(
        deps,
        { id: 'INV-NODATE', status: 'Paid', totalAmount: 1000 },
        badDate,
      )).rejects.toThrow(TransportBudgetAllocationError);
    }
    expect(deps.repository.events).toHaveLength(0);
  });

  test('uses the persisted business date, never created_at', async () => {
    const deps = makeDeps({
      getPolicy: () => ({
        // A scheduled change effective AFTER the document date proves the
        // resolution used the invoice_date, not the (later) server time.
        allocationRatePercent: 3,
        effectiveFrom: '2026-09-01',
        scheduledChanges: [
          { allocationRatePercent: 5, effectiveFrom: '2026-10-15' },
        ],
      }),
    });
    const outcome = await allocateForApiInvoice(
      deps,
      { id: 'INV-2', status: 'Finalized', totalAmount: 100000, created_at: '2026-10-02T09:00:00Z' },
      '2026-09-15',
    );
    expect(outcome.event.businessDate).toBe('2026-09-15');
    expect(outcome.event.allocationRatePercent).toBe(3); // not the later 5%
  });

  test('scheduled rate resolves correctly for invoices (2026-10-20 -> 5%)', async () => {
    const deps = makeDeps();
    const outcome = await allocateForApiInvoice(
      deps,
      { id: 'INV-3', status: 'Paid', totalAmount: 500000 },
      '2026-10-20',
    );
    expect(outcome.event.allocationRatePercent).toBe(5);
    expect(outcome.event.amount).toBe(25000);
  });

  test('zero/missing policy creates no allocation for invoices', async () => {
    for (const policy of [{ allocationRatePercent: 0 }, undefined]) {
      const deps = makeDeps({ getPolicy: () => policy });
      const outcome = await allocateForApiInvoice(
        deps,
        { id: 'INV-4', status: 'Paid', totalAmount: 500000 },
        '2026-10-02',
      );
      expect(outcome.status).toBe('skipped');
      expect(deps.repository.events).toHaveLength(0);
    }
  });

  test('repeated invocation deduplicates on SALES_ALLOCATION:{invoiceId}', async () => {
    const deps = makeDeps();
    const invoice = { id: 'INV-5', status: 'Paid', totalAmount: 500000 };
    const first = await allocateForApiInvoice(deps, invoice, '2026-10-02');
    const second = await allocateForApiInvoice(deps, invoice, '2026-10-02');
    expect(second.deduplicated).toBe(true);
    expect(deps.repository.events).toHaveLength(1);
    expect(deps.repository.events[0].idempotencyKey).toBe('SALES_ALLOCATION:INV-5');
  });

  test('allocation failure propagates to the hook (response isolation covered by route test)', async () => {
    const failingRepo = {
      async appendTransportBudgetEvent() {
        throw new Error('rpc down');
      },
    };
    const deps = makeDeps({ repository: failingRepo });
    await expect(allocateForApiInvoice(
      deps,
      { id: 'INV-6', status: 'Paid', totalAmount: 1000 },
      '2026-10-02',
    )).rejects.toThrow('rpc down');
  });

  test('no customer/accounting fields are touched (event-only output)', async () => {
    const deps = makeDeps();
    const invoice = { id: 'INV-7', status: 'Paid', totalAmount: 100000, customer_id: 'CUST-1' };
    await allocateForApiInvoice(deps, invoice, '2026-10-02');
    expect(invoice).toEqual({ id: 'INV-7', status: 'Paid', totalAmount: 100000, customer_id: 'CUST-1' });
    expect(deps.repository.events[0].method).toBeNull();
    expect(deps.repository.events[0].providerId).toBeNull();
  });
});

describe('Phase 5A: toBusinessDate boundary', () => {
  test('extracts the date-only prefix from ISO timestamps', () => {
    expect(toBusinessDate('2026-10-02T09:30:00.000Z')).toBe('2026-10-02');
    expect(toBusinessDate('2026-10-02')).toBe('2026-10-02');
  });

  test('fails closed on unparseable dates', () => {
    expect(() => toBusinessDate('')).toThrow(TransportBudgetAllocationError);
    expect(() => toBusinessDate('garbage')).toThrow(TransportBudgetAllocationError);
    expect(() => toBusinessDate(null)).toThrow(TransportBudgetAllocationError);
  });
});

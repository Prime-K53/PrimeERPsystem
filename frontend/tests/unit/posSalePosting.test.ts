import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    enqueue: vi.fn(() => Promise.resolve({ id: 'op-1', status: 'pending' })),
    getMeta: vi.fn(() => Promise.resolve(null)),
    hasPendingMutation: vi.fn(() => Promise.resolve(false)),
  },
}));

vi.mock('../../services/backgroundSyncService', () => ({
  backgroundSyncService: {
    trigger: vi.fn(() => Promise.resolve()),
  },
}));

import { dbService } from '../../services/db';
import { transactionService } from '../../services/transactionService';
import { computeOwnBalances } from '../../services/accountingEngine';
import { DEFAULT_ACCOUNTS } from '../../constants';

afterEach(() => {
  vi.restoreAllMocks();
});

const spyPuts = () => {
  const puts: Array<{ store: string; record: any }> = [];
  vi.spyOn(dbService, 'put').mockImplementation(async (storeName: never, item: never) => {
    puts.push({ store: String(storeName), record: item });
    return String((item as { id?: unknown })?.id ?? 'mock-id');
  });
  return puts;
};

const stubReads = (accounts: unknown[]) => {
  vi.spyOn(dbService, 'getAll').mockImplementation(async (storeName: never) => {
    // Return a copy: the posting pre-flight heals missing accounts by
    // pushing seeds into the loaded array, which must not mutate the
    // fixture the test also uses for balance assertions.
    if (String(storeName) === 'accounts') return [...accounts] as never;
    return [] as never;
  });
  vi.spyOn(dbService, 'get').mockImplementation(async () => undefined as never);
};

const buildPosSale = (overrides: Record<string, unknown> = {}) => ({
  id: 'POS-REPRO-001',
  date: new Date().toISOString(),
  source: 'POS',
  totalAmount: 1000,
  discount: 0,
  status: 'Paid',
  items: [
    {
      id: 'ITM-001',
      productId: 'ITM-001',
      productName: 'Test Product',
      name: 'Test Product',
      type: 'Product',
      category: 'General',
      quantity: 2,
      price: 500,
      cost: 300,
      unitPrice: 500,
      subtotal: 1000,
    },
  ],
  paymentMethod: 'Cash',
  payments: [{ method: 'Cash', amount: 1000 }],
  cashierId: 'user-1',
  customerId: 'walk-in',
  customerName: 'Walk-in',
  subAccountName: 'Main',
  total: 1000,
  bill_total: 1000,
  roundingDifference: 0,
  salesAccountId: '41100',
  ...overrides,
});

describe('POS sale ledger posting', () => {
  it('posts revenue/cash entries and moves COA balances (happy path)', async () => {
    const puts = spyPuts();
    stubReads([...DEFAULT_ACCOUNTS]);

    const result = await transactionService.processSale(
      buildPosSale() as never,
      undefined,
      'tester'
    );
    expect(result).toBeDefined();

    const ledgerPuts = puts.filter((c) => c.store === 'ledger');
    const descriptions = ledgerPuts.map((c) => String(c.record.description || ''));
    expect(descriptions.some((d) => d.includes('POS Sale Revenue'))).toBe(true);

    const balances = computeOwnBalances(
      DEFAULT_ACCOUNTS as never[],
      ledgerPuts.map((c) => c.record) as never[]
    );
    expect(balances['41100']).toBe(1000);
    expect(balances['11210']).toBe(1000);
  });

  it('heals a missing canonical revenue account so the sale still posts', async () => {
    const puts = spyPuts();
    // Partial chart: revenue leaves missing (the reported "COA not updated" setup).
    const partialChart = (DEFAULT_ACCOUNTS as unknown[]).filter(
      (a) =>
        !['41100', '41200', '41000'].includes(String((a as { code?: unknown })?.code ?? ''))
    );
    stubReads(partialChart);

    const result = await transactionService.processSale(
      buildPosSale({ id: 'POS-HEAL-001' }) as never,
      undefined,
      'tester'
    );
    expect(result).toBeDefined();

    // The missing canonical account was seeded back into the chart …
    const accountPuts = puts.filter((c) => c.store === 'accounts');
    expect(
      accountPuts.some((c) => String(c.record.code ?? '') === '41100')
    ).toBe(true);
    expect(
      accountPuts.map((c) => String(c.record.code ?? c.record.id ?? '')),
      'seeds must not duplicate'
    ).toEqual(['41100']);
    // … and the full ledger section posted.
    const ledgerPuts = puts.filter((c) => c.store === 'ledger');
    expect(
      ledgerPuts.map((c) => `${c.record.description}|${c.record.debitAccountId}>${c.record.creditAccountId}|${c.record.amount}`),
      'ledger puts'
    ).toEqual([
      'POS Sale Revenue #POS-HEAL-001|11110>41100|1000',
      'Payment [Cash] - Sale #POS-HEAL-001|11110>11110|1000',
      'Auto-transfer to Main Ledger - Sale #POS-HEAL-001|11210>11110|1000',
    ]);
    const balances = computeOwnBalances(
      [...partialChart, ...accountPuts.map((c) => c.record)] as never[],
      ledgerPuts.map((c) => c.record) as never[]
    );
    expect(balances['41100']).toBe(1000);
  });

  it('fails clean with no partial writes when an account is truly unresolvable', async () => {
    const puts = spyPuts();
    stubReads([...DEFAULT_ACCOUNTS]);

    let thrown: unknown = null;
    try {
      await transactionService.processSale(
        buildPosSale({ id: 'POS-FAIL-001', salesAccountId: 'NOPE-999' }) as never,
        undefined,
        'tester'
      );
    } catch (e) {
      thrown = e;
    }
    expect(String((thrown as Error)?.message || thrown)).toContain('NOPE-999');
    // No orphan sale, no half-posted ledger: the failure happens in
    // pre-flight, before the first write.
    expect(puts.filter((c) => c.store === 'sales').length).toBe(0);
    expect(puts.filter((c) => c.store === 'ledger').length).toBe(0);
  });
});

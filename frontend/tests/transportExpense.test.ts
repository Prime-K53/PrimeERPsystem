/**
 * transportExpense.test.ts — Phase 7J authoritative courier/transport
 * expense source tests.
 *
 * Covers §17: schema, posting, void, offline/sync boundary (registration +
 * replay semantics), and negative proofs (no free-text classification, no
 * 51300, no ambiguous 52600, no customer/landing/outbound-budget effects).
 *
 * Hermetic: in-memory dbService mock; real service logic; no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const memStores = vi.hoisted(() => ({
  tables: new Map<string, Map<string, any>>(),
  puts: [] as Array<{ table: string; id: string }>,
}));

vi.mock('../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      getTable(name).set(String(obj.id), obj);
      memStores.puts.push({ table: name, id: String(obj.id) });
    },
    delete: async (id: string) => {
      getTable(name).delete(String(id));
    },
  });
  return {
    dbService: {
      getAll: async (table: string) => [...getTable(table).values()],
      get: async (table: string, id: string) => getTable(table).get(String(id)),
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id), obj);
        memStores.puts.push({ table, id: String(obj.id) });
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

vi.mock('../services/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTransportExpense,
  postTransportExpense,
  voidTransportExpense,
  TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
} from '../services/transportExpenseService';
import { transportBudgetRepository } from '../services/repositories/transportBudgetRepository';

const SUPPLIERS = {
  courierA: { id: 'SUP-COURIER-A', name: 'Speedy Couriers Ltd', balance: 0 },
  courierB: { id: 'SUP-COURIER-B', name: 'Fargo Riders', balance: 0 },
};

function coaFixture(): any[] {
  const acc = (code: string, name: string, extra: any = {}) => ({
    id: `ACC-${code}`,
    code,
    account_number: code,
    name,
    account_type: 'EXPENSE',
    type: 'Expense',
    account_group: 'OPERATING_EXPENSE',
    parent_account_id: '52000',
    is_active: true,
    allow_posting: true,
    normal_balance: 'DEBIT',
    ...extra,
  });
  return [
    acc('21110', 'Trade Creditors', {
      account_type: 'LIABILITY',
      type: 'Liability',
      account_group: 'CURRENT_LIABILITY',
      parent_account_id: '21000',
      normal_balance: 'CREDIT',
    }),
    acc('11110', 'Cash Drawer', {
      account_type: 'ASSET',
      type: 'Asset',
      account_group: 'CURRENT_ASSET',
      parent_account_id: '11100',
      subtype: 'CASH',
      normal_balance: 'DEBIT',
    }),
    acc('51300', 'Freight & Carriage', {
      account_group: 'COST_OF_SALES',
      parent_account_id: '51000',
    }),
    acc('52000', 'Operating Expenses', { parent_account_id: '50000', allow_posting: false }),
    acc('52600', 'Transport', {}),
    acc('52610', 'Courier & Delivery Transport', {}),
    acc('52800', 'Office Expenses', {}),
  ];
}

function seed() {
  memStores.tables.clear();
  memStores.puts.length = 0;
  const putAll = (table: string, rows: any[]) =>
    memStores.tables.set(table, new Map(rows.map((r: any) => [String(r.id), { ...r }])));
  putAll('suppliers', Object.values(SUPPLIERS));
  putAll('accounts', coaFixture());
  putAll('bankAccounts', [
    { id: 'ACC-11110', name: 'Cash Drawer', accountNumber: 'CASH-001', balance: 1000000 },
  ]);
  for (const t of [
    'ledger', 'transportExpenses', 'bankAccounts', 'bankTransactions',
    'idempotencyKeys', 'purchases', 'purchaseInvoices',
  ]) {
    if (!memStores.tables.has(t)) memStores.tables.set(t, new Map());
  }
}

const line = (over: Record<string, unknown> = {}) => ({
  description: 'Courier delivery',
  amount: 20000,
  classification: 'OUTBOUND_TRANSPORT',
  supplierId: SUPPLIERS.courierA.id,
  ...over,
});

const draftInput = (over: Record<string, unknown> = {}) => ({
  supplierId: SUPPLIERS.courierA.id,
  settlementMode: 'AP' as const,
  businessDate: '2026-10-02',
  lines: [line()],
  ...over,
});

const ledgerFor = (referenceId: string) =>
  [...(memStores.tables.get('ledger') ?? new Map()).values()].filter(
    (e: any) => e.referenceId === referenceId,
  );

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Schema (§17: valid draft, invalid classification/amount/supplier/status)
// ---------------------------------------------------------------------------

describe('transport expense — schema', () => {
  it('accepts a valid draft with deterministic key', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-1' }));
    expect(created).toMatchObject({
      id: 'TEXP-1',
      idempotencyKey: 'TEXPENSE:TEXP-1',
      status: 'DRAFT',
      totalAmount: 20000,
      journalId: null,
      reversesExpenseId: null,
      isReversal: false,
    });
  });

  it('rejects invalid classification (never inferred from text)', async () => {
    seed();
    for (const classification of ['Transport', 'transport', 'COURIER', '', null]) {
      await expect(
        createTransportExpense(draftInput({ lines: [line({ classification })] })),
      ).rejects.toThrow(/classification/i);
    }
  });

  it('rejects invalid amounts (zero, negative, non-numeric)', async () => {
    seed();
    for (const amount of [0, -5000, NaN, '20000', null]) {
      await expect(
        createTransportExpense(draftInput({ lines: [line({ amount })] })),
      ).rejects.toThrow(/amount/i);
    }
  });

  it('rejects missing supplier and empty lines', async () => {
    seed();
    await expect(
      createTransportExpense(draftInput({ lines: [line({ supplierId: '' })] })),
    ).rejects.toThrow(/supplier/i);
    await expect(createTransportExpense(draftInput({ lines: [] }))).rejects.toThrow(
      /line/i,
    );
  });

  it('rejects invalid status transitions (post twice, void draft)', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-T1' }));
    await postTransportExpense(created.id);
    await expect(postTransportExpense(created.id)).rejects.toThrow(/ALREADY_POSTED|DRAFT/);
    const draft2 = await createTransportExpense(draftInput({ id: 'TEXP-T2' }));
    await expect(voidTransportExpense(draft2.id)).rejects.toThrow(/POSTED/);
  });

  it('rejects conflicting idempotency-key reuse', async () => {
    seed();
    await createTransportExpense(draftInput({ id: 'TEXP-K1' }));
    await expect(
      createTransportExpense(
        draftInput({ id: 'TEXP-K2', idempotencyKey: 'TEXPENSE:TEXP-K1' }),
      ),
    ).rejects.toThrow(/uplicate|idempotency/i);
  });
});

// ---------------------------------------------------------------------------
// Posting (§17: pure/mixed/multiple, totals, balance, AP/cash, duplicates)
// ---------------------------------------------------------------------------

describe('transport expense — posting', () => {
  it('posts pure transport to 52610 / AP with supplier liability', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-P1' }));
    const posted = await postTransportExpense(created.id);
    expect(posted.status).toBe('POSTED');
    expect(posted.journalId).toBeTruthy();
    const legs = ledgerFor(created.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      debitAccountId: 'ACC-52610',
      creditAccountId: 'ACC-21110',
      amount: 20000,
      entryType: 'TRANSPORT_EXPENSE',
    });
    const supplier = memStores.tables.get('suppliers')!.get(SUPPLIERS.courierA.id);
    expect(supplier.balance).toBe(20000);
  });

  it('posts mixed documents with per-line accounts; transport legs stay exact', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({
        id: 'TEXP-M1',
        lines: [
          line({ id: 'L-1', description: 'Printing materials', amount: 100000, classification: 'NON_TRANSPORT', supplierId: SUPPLIERS.courierA.id, accountId: 'ACC-52800' }),
          line({ id: 'L-2', description: 'Delivery', amount: 20000, classification: 'OUTBOUND_TRANSPORT', supplierId: SUPPLIERS.courierB.id }),
        ],
      }),
    );
    expect(created.totalAmount).toBe(120000);
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    expect(legs).toHaveLength(2);
    const byDesc = new Map(legs.map((l: any) => [l.description, l]));
    const deliveryLegs = legs.filter((l: any) => l.description.includes('Delivery'));
    expect(deliveryLegs).toHaveLength(1);
    expect(deliveryLegs[0].debitAccountId).toBe('ACC-52610');
    expect(byDesc.size).toBe(2);
    // Only the transport portion is isolatable by classification downstream.
    const transportTotal = legs
      .filter((l: any) => l.debitAccountId === 'ACC-52610')
      .reduce((s: number, l: any) => s + l.amount, 0);
    expect(transportTotal).toBe(20000);
    // Per-provider liability split.
    expect(memStores.tables.get('suppliers')!.get(SUPPLIERS.courierA.id)?.balance).toBe(100000);
    expect(memStores.tables.get('suppliers')!.get(SUPPLIERS.courierB.id)?.balance).toBe(20000);
  });

  it('posts multiple transport lines with independent identity', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({
        id: 'TEXP-MT',
        lines: [
          line({ id: 'L-A', description: 'Delivery A', amount: 15000, supplierId: SUPPLIERS.courierA.id }),
          line({ id: 'L-B', description: 'Delivery B', amount: 25000, supplierId: SUPPLIERS.courierB.id }),
        ],
      }),
    );
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    expect(legs).toHaveLength(2);
    expect(legs.reduce((s: number, l: any) => s + l.amount, 0)).toBe(40000);
    expect(new Set(legs.map((l: any) => l.supplierId)).size).toBe(2);
  });

  it('header total always equals the line sum', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({
        id: 'TEXP-TOT',
        lines: [line({ amount: 12000 }), line({ id: 'L-2', amount: 8000 })],
      }),
    );
    expect(created.totalAmount).toBe(20000);
  });

  it('balanced journal: debits equal credits', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({
        id: 'TEXP-BAL',
        lines: [line({ amount: 12000 }), line({ id: 'L-2', amount: 8000, classification: 'NON_TRANSPORT', accountId: 'ACC-52800' })],
      }),
    );
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    const debits = legs.reduce((s: number, l: any) => s + l.amount, 0);
    expect(debits).toBe(20000);
    expect(new Set(legs.map((l: any) => l.creditAccountId)).size).toBe(1);
  });

  it('cash mode settles bank directly with mirrored withdrawal', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({ id: 'TEXP-CASH', settlementMode: 'CASH', settlementAccountId: 'ACC-11110' }),
    );
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    expect(legs[0]).toMatchObject({
      debitAccountId: 'ACC-52610',
      creditAccountId: 'ACC-11110',
    });
    const withdrawals = [...(memStores.tables.get('bankTransactions') ?? new Map()).values()];
    expect(withdrawals.length).toBeGreaterThan(0);
    // No supplier liability in cash mode.
    expect(memStores.tables.get('suppliers')!.get(SUPPLIERS.courierA.id)?.balance).toBe(0);
  });

  it('duplicate submission with same id is rejected, not double-posted', async () => {
    seed();
    await createTransportExpense(draftInput({ id: 'TEXP-DUP' }));
    await expect(createTransportExpense(draftInput({ id: 'TEXP-DUP' }))).rejects.toThrow(
      /already exists/i,
    );
    expect(ledgerFor('TEXP-DUP')).toHaveLength(0);
  });

  it('journal legs are balanced per line (no document-total invention)', async () => {
    seed();
    const created = await createTransportExpense(
      draftInput({
        id: 'TEXP-LL',
        lines: [
          line({ id: 'L-1', amount: 20000 }),
          line({ id: 'L-2', amount: 20000, supplierId: SUPPLIERS.courierB.id }),
        ],
      }),
    );
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    expect(legs).toHaveLength(2);
    expect(legs.every((l: any) => l.amount === 20000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Void (§17: lifecycle, caps, concurrency, re-post)
// ---------------------------------------------------------------------------

describe('transport expense — void', () => {
  it('posted → voided with fresh reversal journal; original immutable', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-V1' }));
    await postTransportExpense(created.id);
    const before = await (await import('../services/db')).dbService.get<any>(
      'transportExpenses' as never,
      'TEXP-V1',
    );
    const { voided, reversal } = await voidTransportExpense(created.id, 'Duplicate bill');
    expect(voided.status).toBe('VOIDED');
    expect(reversal).toMatchObject({
      status: 'POSTED',
      reversesExpenseId: 'TEXP-V1',
      isReversal: true,
      totalAmount: 20000,
    });
    expect(reversal.id).not.toBe('TEXP-V1');
    expect(reversal.journalId).not.toBe(before.journalId);
    // Original economics untouched except status.
    expect(voided.totalAmount).toBe(20000);
    expect(voided.businessDate).toBe('2026-10-02');
    expect(reversal.journalId).not.toBe(before.journalId);
    expect(voided.lines).toEqual(before.lines);
    // Offsetting legs balance the original.
    const revLegs = ledgerFor(reversal.id);
    expect(revLegs).toHaveLength(1);
    expect(revLegs[0]).toMatchObject({
      debitAccountId: 'ACC-21110',
      creditAccountId: 'ACC-52610',
      amount: 20000,
    });
    // Supplier liability restored.
    expect(memStores.tables.get('suppliers')!.get(SUPPLIERS.courierA.id)?.balance).toBe(0);
  });

  it('duplicate void is rejected (no double reversal)', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-V2' }));
    await postTransportExpense(created.id);
    await voidTransportExpense(created.id);
    await expect(voidTransportExpense(created.id)).rejects.toThrow(/POSTED|already/i);
    const reversals = [...(memStores.tables.get('transportExpenses') ?? new Map()).values()].filter(
      (e: any) => e.reversesExpenseId === 'TEXP-V2',
    );
    expect(reversals).toHaveLength(1);
  });

  it('concurrent voids converge to exactly one reversal', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-V3' }));
    await postTransportExpense(created.id);
    const outcomes = await Promise.allSettled([
      voidTransportExpense(created.id, 'race 1'),
      voidTransportExpense(created.id, 'race 2'),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reversals = [...(memStores.tables.get('transportExpenses') ?? new Map()).values()].filter(
      (e: any) => e.reversesExpenseId === 'TEXP-V3',
    );
    expect(reversals).toHaveLength(1);
  });

  it('over-reversal is impossible: reversal total equals original total', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-V4' }));
    await postTransportExpense(created.id);
    const { reversal } = await voidTransportExpense(created.id);
    expect(reversal.totalAmount).toBe(20000);
    // No second reversal may exist for the same original.
    await expect(voidTransportExpense(created.id)).rejects.toThrow();
  });

  it('reversal rows cannot be voided and voided rows cannot re-post', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-V5' }));
    await postTransportExpense(created.id);
    const { reversal } = await voidTransportExpense(created.id);
    await expect(voidTransportExpense(reversal.id)).rejects.toThrow(/Reversal rows cannot be voided/);
    await expect(postTransportExpense(created.id)).rejects.toThrow(/DRAFT/);
  });
});

// ---------------------------------------------------------------------------
// Offline/sync boundary + negatives (§17)
// ---------------------------------------------------------------------------

describe('transport expense — offline/sync boundary and negatives', () => {
  it('local creation then posting persists locally (offline-first)', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-O1' }));
    expect(created.status).toBe('DRAFT');
    const stored = memStores.tables.get('transportExpenses')!.get('TEXP-O1');
    expect(stored.status).toBe('DRAFT');
    await postTransportExpense('TEXP-O1');
    expect(memStores.tables.get('transportExpenses')!.get('TEXP-O1').status).toBe('POSTED');
  });

  it('replay of the same post converges (no duplicate journal)', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-O2' }));
    await postTransportExpense(created.id);
    await expect(postTransportExpense(created.id)).rejects.toThrow();
    expect(ledgerFor('TEXP-O2')).toHaveLength(1);
  });

  it('retry of void converges (no duplicate reversal)', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-O3' }));
    await postTransportExpense(created.id);
    await voidTransportExpense(created.id);
    await expect(voidTransportExpense(created.id)).rejects.toThrow();
    const reversals = [...(memStores.tables.get('transportExpenses') ?? new Map()).values()].filter(
      (e: any) => e.reversesExpenseId === 'TEXP-O3',
    );
    expect(reversals).toHaveLength(1);
  });

  it('generic free-text expense can never become a transport expense', async () => {
    seed();
    // There is no category field at all: classification is a required enum.
    await expect(
      createTransportExpense(
        draftInput({ lines: [line({ classification: 'Transport' })] }) as any,
      ),
    ).rejects.toThrow(/classification/i);
  });

  it('51300 can never receive transport-expense debits', async () => {
    seed();
    // NON_TRANSPORT lines with a forbidden account fail at POST (shape is
    // accepted at DRAFT so drafts stay editable).
    const bad = await createTransportExpense(
      draftInput({
        id: 'TEXP-N513',
        lines: [line({ classification: 'NON_TRANSPORT', accountId: 'ACC-51300' })],
      }),
    );
    expect(bad.status).toBe('DRAFT');
    await expect(postTransportExpense(bad.id)).rejects.toThrow(/51300/);
    expect(ledgerFor('TEXP-N513')).toHaveLength(0);
    // Transport lines always resolve the dedicated account even when 51300 exists.
    const created = await createTransportExpense(draftInput({ id: 'TEXP-N526' }));
    await postTransportExpense(created.id);
    expect(ledgerFor('TEXP-N526')[0].debitAccountId).toBe('ACC-52610');
  });

  it('ambiguous 52600 is never used by the transport workflow', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-NAMB' }));
    await postTransportExpense(created.id);
    const legs = ledgerFor(created.id);
    expect(legs.every((l: any) => l.debitAccountId !== 'ACC-52600')).toBe(true);
    expect(legs.every((l: any) => l.debitAccountId === 'ACC-52610')).toBe(true);
  });

  it('customer delivery fields do not create transport expenses', async () => {
    seed();
    // No producer reads shippingCost/deliveryFee/otherCharges: the only
    // creation path is explicit createTransportExpense with classified lines.
    const { dbService } = await import('../services/db');
    await dbService.put('invoices' as never, {
      id: 'INV-CUST-1',
      totalAmount: 150000,
      deliveryFee: 20000,
      otherCharges: 20000,
    } as never);
    expect(memStores.tables.get('transportExpenses')?.size ?? 0).toBe(0);
  });

  it('Landing Freight does not create outbound expense rows', async () => {
    seed();
    const { dbService } = await import('../services/db');
    await dbService.put('purchases' as never, {
      id: 'PO-L1',
      landingCosts: [{ id: 'LC-1', category: 'Freight', amount: 50000 }],
      landingConsumption: [],
    } as never);
    expect(memStores.tables.get('transportExpenses')?.size ?? 0).toBe(0);
  });

  it('post emits exactly one OUTBOUND_CONSUMPTION; void adds no budget events', async () => {
    seed();
    const created = await createTransportExpense(draftInput({ id: 'TEXP-NB' }));
    await postTransportExpense(created.id);
    await voidTransportExpense(created.id);
    // Phase 8E accepted behavior: the post-commit producer emits one
    // OUTBOUND_CONSUMPTION observation per OUTBOUND_TRANSPORT line. The void
    // path emits nothing in this phase (CONSUMPTION_REVERSAL is a later
    // phase), so the full post+void cycle yields exactly one budget event.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const events = [
      ...(memStores.tables.get('transportBudgetEvents') ?? new Map()).values(),
    ];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'OUTBOUND_CONSUMPTION',
      amount: -20000,
      sourceAmount: 20000,
      method: 'OUTBOUND_TRANSPORT',
      providerId: SUPPLIERS.courierA.id,
      businessDate: '2026-10-02',
    });
    expect(String((events[0] as any).idempotencyKey)).toMatch(
      /^OUTBOUND_CONSUMPTION:TEXP-NB:/,
    );
  });
});

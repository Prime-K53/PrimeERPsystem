/**
 * productionExamPaperInvoice.test.ts — P1 regression.
 *
 * The legacy Production exam-paper flow (api.production.generateExamInvoice,
 * used by ExaminationPrinting) builds a raw Invoice and persists it with a
 * DIRECT dbService.put — bypassing the examination mapper AND
 * processInvoice, which normally mints the verification token.
 *
 * Invariant under test: any invoice written to the invoices store by
 * generateExamInvoice MUST contain verificationToken BEFORE the put occurs,
 * so the normal path, the queue payload and any retry are all tokened
 * (existing tokens are preserved, never regenerated).
 *
 * Numbering (INV-series), ledger behaviour and exam-paper updates are
 * unchanged — only the token guarantee is asserted here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    bulkPut: vi.fn(),
    delete: vi.fn(),
    executeAtomicOperation: vi.fn(),
  },
  getStoreForCloudTable: vi.fn((table: string) => table),
}));

import { api } from '../../services/api';
import { dbService } from '../../services/db';

const TOKEN_64 = /^[0-9a-f]{64}$/;

const examPapers = [
  {
    batch_id: 'B1',
    status: 'marked',
    selling_price: 500,
    class: 'Class 1',
    candidates: 10,
    subject: 'Maths',
    marketAdjustmentApplied: 0,
  },
  {
    batch_id: 'B1',
    status: 'marked',
    selling_price: 300,
    class: 'Class 1',
    candidates: 10,
    subject: 'English',
    marketAdjustmentApplied: 0,
  },
];

describe('P1 — legacy Production exam-paper invoices are tokened before put', () => {
  const settingsRows = new Map<string, Record<string, unknown>>();
  let invoicePuts: Array<{ store: string; record: Record<string, unknown> }>;

  beforeEach(() => {
    settingsRows.clear();
    invoicePuts = [];
    vi.mocked(dbService.getAll).mockImplementation(async (store: never) => {
      if (String(store) === 'examPapers') return examPapers as never;
      return [] as never;
    });
    vi.mocked(dbService.put).mockImplementation(async (store: never, record: never) => {
      if (String(store) === 'invoices') {
        invoicePuts.push({ store: String(store), record: { ...(record as object) } });
      }
      return String((record as Record<string, unknown>)?.id || '');
    });
    vi.mocked(dbService.executeAtomicOperation).mockImplementation(
      async (_stores: never, operation: (tx: never) => Promise<never>) =>
        operation({
          objectStore: (name: string) => {
            if (String(name) === 'settings') {
              return {
                get: async (id: string) => settingsRows.get(id),
                put: async (row: Record<string, unknown>) => {
                  settingsRows.set(String(row.id), row);
                },
              };
            }
            return { get: async () => undefined, put: async () => undefined };
          },
        } as never)
    );
  });

  it('generateExamInvoice puts a tokened invoice (queue payload inherits the token)', async () => {
    const result = await api.production.generateExamInvoice(['B1']);
    expect(result.success).toBe(true);
    expect(invoicePuts).toHaveLength(1);
    const [put] = invoicePuts;
    expect(put.store).toBe('invoices');
    // INV-series numbering preserved (not EXM).
    expect(String(put.record.id)).toMatch(/^INV-/);
    // Token minted before the put with the single existing mechanism.
    expect(String(put.record.verificationToken)).toMatch(TOKEN_64);
    expect(result.invoice_id).toBe(String(put.record.id));
    expect(Number(put.record.totalAmount)).toBe(800);
  });

  it('a second generation still mints tokened invoices with distinct numbers', async () => {
    await api.production.generateExamInvoice(['B1']);
    await api.production.generateExamInvoice(['B1']);
    expect(invoicePuts).toHaveLength(2);
    expect(String(invoicePuts[0].record.verificationToken)).toMatch(TOKEN_64);
    expect(String(invoicePuts[1].record.verificationToken)).toMatch(TOKEN_64);
    expect(String(invoicePuts[0].record.id)).not.toBe(String(invoicePuts[1].record.id));
  });
});

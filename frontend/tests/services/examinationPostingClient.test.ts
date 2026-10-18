/**
 * examinationPostingClient.test.ts
 *
 * Contract tests for the client half of the authoritative Examination posting
 * boundary. The properties that matter are:
 *
 *   1. a successful post reconciles the SERVER's canonical result
 *   2. a duplicate retry with the same key does not post twice
 *   3. an uncertain response (timeout / socket error) stays PENDING and never
 *      presents a committed invoice
 *   4. a terminal rejection surfaces and is not retried into a second posting
 *   5. a stale batch version is forwarded so the server can refuse it
 *   6. a competing request for the same batch cannot create a second posting
 *   7. a refresh/reconnect reuses the SAME derived key
 *   8. the client never writes a ledger row of its own
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const puts: Array<{ store: string; item: any; options?: any }> = [];
const storeRows = new Map<string, Map<string, any>>();
const settings = new Map<string, any>();
const fetchCalls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
let fetchImpl: (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }> =
  async () => ({ ok: true, status: 200, json: async () => ({}) });

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async (store: string) => Array.from((storeRows.get(store)?.values()) ?? [])),
    get: vi.fn(async (store: string, id: string) => storeRows.get(store)?.get(String(id))),
    put: vi.fn(async (store: string, item: any, options?: any) => {
      puts.push({ store, item, options });
      if (!options?.cloudSource) {
        if (!storeRows.has(store)) storeRows.set(store, new Map());
        storeRows.get(store)!.set(String(item.id), item);
      }
      return String(item.id);
    }),
    delete: vi.fn(async (store: string, id: string) => { storeRows.get(store)?.delete(String(id)); }),
    getSetting: vi.fn(async (key: string) => settings.get(key)),
    saveSetting: vi.fn(async (key: string, value: any) => { settings.set(key, value); }),
    executeAtomicOperation: vi.fn(async (_stores: string[], op: (tx: any) => Promise<any>) => op({
      objectStore: () => ({ get: async () => undefined, getAll: async () => [], put: async () => undefined }),
      done: Promise.resolve(),
    })),
  },
}));

vi.mock('../../config/api.js', () => ({ API_BASE_URL: 'http://localhost:5000/api' }));
vi.mock('../../services/requestHeaders', () => ({ getJsonRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../../services/syncApiClient', () => ({ getSyncAccessToken: vi.fn(async () => 'token-abc') }));
vi.mock('../../services/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../services/authSession', () => ({
  isSessionExpired: () => false,
  getStoredUserSession: () => null,
}));
vi.mock('../../utils/examinationInvoiceDiag', () => ({ traceExamInvoice: vi.fn(async () => undefined) }));
vi.mock('../../services/transactions/_internal', () => ({
  getGLConfig: () => ({ accountsReceivable: '11310', defaultSalesAccount: '41200' }),
  getCompanyConfig: () => ({ companyId: 'CO-1' }),
  loadAccountsFromStore: async () => [{ id: '11310', accountNumber: '11310', type: 'Asset' }],
  resolveAccountForPosting: (ref: string) => (ref === '11310' ? '11310' : '41200'),
}));
vi.mock('../../utils/revenueRecognition', () => ({
  resolveInvoiceRevenueAccount: () => '41200',
}));

const jsonOk = (body: any) => ({ ok: true, status: 200, json: async () => body });
const jsonErr = (status: number, body: any) => ({ ok: false, status, json: async () => body });

const sampleInvoice = {
  id: 'EXM-001/001',
  invoiceNumber: 'EXM-001/001',
  customerId: 'SCH-1',
  customerName: 'Test School',
  status: 'Unpaid',
  totalAmount: 8000,
  items: [{ id: 'CLASS-1', type: 'Service', quantity: 80, price: 100, total: 8000 }],
};

const sampleLedger = {
  id: 'LG-INV-EXM-001/001',
  debitAccountId: '11310',
  creditAccountId: '41200',
  amount: 8000,
  referenceId: 'EXM-001/001',
};

const postArgs = () => ({
  batchId: 'batch-1',
  invoice: { ...sampleInvoice },
  ledgerEntry: { ...sampleLedger },
  expectedVersion: 4,
});

const loadModule = async () => import('../../services/examinationPostingClient');

describe('examinationPostingClient', () => {
  beforeEach(() => {
    puts.length = 0;
    fetchCalls.length = 0;
    storeRows.clear();
    settings.clear();
    Object.defineProperty(globalThis, 'navigator', {
      value: { onLine: true },
      configurable: true,
      writable: true,
    });
    fetchImpl = async () => jsonOk({});
    (globalThis as any).fetch = vi.fn(async (url: string, init: any) => {
      fetchCalls.push({ url, body: JSON.parse(init.body), headers: init.headers || {} });
      return fetchImpl(url, init);
    });
  });

  describe('1. successful posting', () => {
    it('returns the committed result and forwards the caller key', async () => {
      fetchImpl = async () => jsonOk({
        invoiceNumber: 'EXM-001/001', invoiceId: 'EXM-001/001',
        totalAmount: 8000, status: 'committed', batchVersion: 5, replayed: false,
      });
      const { submitExaminationInvoicePosting } = await loadModule();

      const outcome = await submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('committed');
      if (outcome.status === 'committed') {
        expect(outcome.result.totalAmount).toBe(8000);
        expect(outcome.replayed).toBe(false);
      }
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].url).toContain('/examination/batches/batch-1/post');
      expect(fetchCalls[0].headers['X-Idempotency-Key']).toBe('EXAM-POST:batch-1:EXM-001/001');
      expect(fetchCalls[0].body.expectedVersion).toBe(4);
    });

    it('persists the request BEFORE sending it', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed' });
      const { submitExaminationInvoicePosting } = await loadModule();
      await submitExaminationInvoicePosting(postArgs());

      const durable = storeRows.get('examinationPostingRequests');
      expect(durable).toBeDefined();
      expect(durable!.get('EXAM-POST:batch-1:EXM-001/001')?.state).toBe('COMMITTED');
    });

    it('never writes a ledger row of its own', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed' });
      const { submitExaminationInvoicePosting } = await loadModule();
      await submitExaminationInvoicePosting(postArgs());

      // The client must not put anything in the `ledger` store: the server
      // owns that posting.
      expect(puts.filter((p) => p.store === 'ledger')).toHaveLength(0);
    });
  });

  describe('2. duplicate retries with the same key', () => {
    it('does not re-send once the request is already committed', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed', replayed: false });
      const { submitExaminationInvoicePosting } = await loadModule();
      await submitExaminationInvoicePosting(postArgs());
      expect(fetchCalls).toHaveLength(1);

      const second = await submitExaminationInvoicePosting(postArgs());

      expect(second.status).toBe('committed');
      if (second.status === 'committed') expect(second.replayed).toBe(true);
      // Still exactly one network call.
      expect(fetchCalls).toHaveLength(1);
    });

    it('derives the identical key across separate module loads (refresh)', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed', replayed: false });
      const first = await loadModule();
      await first.submitExaminationInvoicePosting(postArgs());

      vi.resetModules();
      const second = await loadModule();
      const outcome = await second.submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('committed');
      if (outcome.status === 'committed') expect(outcome.replayed).toBe(true);
      expect(fetchCalls).toHaveLength(1);
    });
  });

  describe('3. uncertain responses', () => {
    it('stays pending and never reports committed on a timeout', async () => {
      fetchImpl = async () => { throw new Error('The operation was aborted'); };
      const { submitExaminationInvoicePosting } = await loadModule();

      const outcome = await submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('pending');
      if (outcome.status === 'pending') expect(outcome.request.state).toBe('PENDING');
    });

    it('stays pending while offline and sends nothing', async () => {
      Object.defineProperty(globalThis, 'navigator', { value: { onLine: false }, configurable: true, writable: true });
      const { submitExaminationInvoicePosting } = await loadModule();

      const outcome = await submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('pending');
      expect(fetchCalls).toHaveLength(0);
    });

    it('resolves the unknown outcome on reconnect using the SAME key', async () => {
      fetchImpl = async () => { throw new Error('socket hang up'); };
      const { submitExaminationInvoicePosting, resolveExaminationPostingRequest } = await loadModule();
      await submitExaminationInvoicePosting(postArgs());
      expect(fetchCalls).toHaveLength(1);

      // Connectivity returns and the server had in fact committed.
      fetchImpl = async () => jsonOk({
        invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed', batchVersion: 5, replayed: true,
      });
      const resolved = await resolveExaminationPostingRequest('batch-1', 'EXM-001/001');

      expect(resolved?.status).toBe('committed');
      expect(fetchCalls).toHaveLength(2);
      // Both calls carried the same derived key, so the server collapses them.
      expect(fetchCalls[0].headers['X-Idempotency-Key']).toBe(fetchCalls[1].headers['X-Idempotency-Key']);
    });

    it('lists outstanding postings so the UI can distinguish pending from committed', async () => {
      fetchImpl = async () => { throw new Error('timeout'); };
      const { submitExaminationInvoicePosting, listPendingExaminationPostings } = await loadModule();
      await submitExaminationInvoicePosting(postArgs());

      const pending = await listPendingExaminationPostings();
      expect(pending).toHaveLength(1);
      expect(pending[0].invoiceNumber).toBe('EXM-001/001');
    });
  });

  describe('4. terminal rejections', () => {
    it('reports an already-invoiced rejection without retrying', async () => {
      fetchImpl = async () => jsonErr(409, {
        error: 'batch already invoiced', code: 'EXAM_POST_ALREADY_INVOICED', retryable: false,
      });
      const { submitExaminationInvoicePosting } = await loadModule();

      const outcome = await submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.code).toBe('EXAM_POST_ALREADY_INVOICED');
        expect(outcome.retryable).toBe(false);
        expect(outcome.request.state).toBe('FAILED');
      }
      expect(fetchCalls).toHaveLength(1);
    });

    it('reports a snapshot mismatch as terminal', async () => {
      fetchImpl = async () => jsonErr(400, {
        error: 'repriced invoice refused', code: 'EXAM_POST_SNAPSHOT_MISMATCH', retryable: false,
      });
      const { submitExaminationInvoicePosting } = await loadModule();
      const outcome = await submitExaminationInvoicePosting(postArgs());
      expect(outcome.status).toBe('rejected');
    });

    it('treats a disabled boundary as pending, not as a silent fallback', async () => {
      fetchImpl = async () => jsonErr(503, { error: 'disabled', code: 'EXAM_POSTING_DISABLED' });
      const { submitExaminationInvoicePosting } = await loadModule();

      const outcome = await submitExaminationInvoicePosting(postArgs());

      expect(outcome.status).toBe('pending');
      // Critically: no invoice and no ledger row written locally.
      expect(puts.filter((p) => p.store === 'invoices' || p.store === 'ledger')).toHaveLength(0);
    });
  });

  describe('5. stale batch versions', () => {
    it('forwards the version the caller holds', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed' });
      const { submitExaminationInvoicePosting } = await loadModule();
      await submitExaminationInvoicePosting({ ...postArgs(), expectedVersion: 2 });
      expect(fetchCalls[0].body.expectedVersion).toBe(2);
    });

    it('sends null rather than guessing when no version is known', async () => {
      fetchImpl = async () => jsonOk({ invoiceNumber: 'EXM-001/001', totalAmount: 8000, status: 'committed' });
      const { submitExaminationInvoicePosting } = await loadModule();
      await submitExaminationInvoicePosting({ ...postArgs(), expectedVersion: null });
      expect(fetchCalls[0].body.expectedVersion).toBeNull();
    });
  });

  describe('6. competing requests for one batch', () => {
    it('gives two devices different keys but one winner, leaving the loser terminal', async () => {
      // Device A's key differs from B's because the invoice numbers differ.
      const { submitExaminationInvoicePosting, buildPostingIdempotencyKey } = await loadModule();

      expect(buildPostingIdempotencyKey('batch-1', 'EXM-001/001'))
        .not.toBe(buildPostingIdempotencyKey('batch-1', 'EXM-001/002'));

      fetchImpl = async () => jsonErr(409, {
        error: 'already invoiced', code: 'EXAM_POST_ALREADY_INVOICED', retryable: false,
      });
      const outcome = await submitExaminationInvoicePosting({
        batchId: 'batch-1',
        invoice: { ...sampleInvoice, id: 'EXM-001/002', invoiceNumber: 'EXM-001/002' },
        ledgerEntry: { ...sampleLedger, id: 'LG-INV-EXM-001/002', referenceId: 'EXM-001/002' },
        expectedVersion: 4,
      });

      expect(outcome.status).toBe('rejected');
    });
  });

  describe('8. the client posts no ledger of its own', () => {
    it('builds the same balanced pair the server expects, without writing it', async () => {
      const { buildExaminationLedgerEntry } = await loadModule();
      const entry = await buildExaminationLedgerEntry(sampleInvoice as any);

      expect(entry.id).toBe('LG-INV-EXM-001/001');
      expect(entry.debitAccountId).toBe('11310');
      expect(entry.creditAccountId).toBe('41200');
      expect(entry.amount).toBe(8000);
      expect(entry.referenceId).toBe('EXM-001/001');
      // A ledger entry was BUILT, not persisted.
      expect(puts.filter((p) => p.store === 'ledger')).toHaveLength(0);
    });
  });
});
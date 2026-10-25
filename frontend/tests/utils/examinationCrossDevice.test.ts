/**
 * examinationCrossDevice.test.ts — conceptual reproduction of the original
 * failure (Phase 8), using the real numbering/mapping/resolution/URL
 * helpers with an in-memory stand-in for the two devices' invoice stores
 * and the sync transport (structured clone + field-level merge).
 *
 * Scenario:
 *   Device A: create Batch A → convert → persist/sync.
 *   Device B: receive → list → open by canonical id → verification URL →
 *             verification lookup succeeds.
 *   Then Batch B converted (both orderings): distinct EXM id, Batch A
 *   untouched (data + token), both open on B, both numbers unique, both
 *   verification pairs work.
 *
 * The verifier predicate below mirrors backend
 * documentVerificationService.cjs matchRow (number-hit on id|invoiceNumber
 * + stored-token equality); the REAL contract (PostgREST query + timing-safe
 * compare + slash handling) is covered by
 * backend/tests/examinationInvoiceVerificationContract.test.cjs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CompanyConfig, Invoice } from '../../types';
import { generateNextExaminationInvoiceNumber } from '../../utils/helpers';
import {
  findInvoiceByIdOrNumber,
  resolveExaminationInvoiceNavigationKey,
} from '../../utils/invoiceIdentity';
import {
  mapExaminationPayloadToInvoice,
  persistExaminationInvoiceToFinance,
} from '../../services/examinationInvoiceSyncService';
import { ExaminationGeneratedInvoicePayload } from '../../services/examinationBatchService';
import { buildInvoiceVerificationUrl } from '../../utils/invoiceVerification';
import { fieldLevelMerge } from '../../services/syncConflictResolver';
import { resolveExaminationInvoiceCollision } from '../../services/examinationInvoiceCollisionService';

const config = {
  transactionSettings: {
    numbering: { shared: { prefix: '', startNumber: 1, padding: 4, resetInterval: 'Never' } },
  },
} as CompanyConfig;

const TOKEN_64 = /^[0-9a-f]{64}$/;

// The shared setup mocks crypto.getRandomValues as identity (every token
// would be all-zeros). Seed distinct bytes per call so minted tokens differ
// across invoices, deterministically.
let byteSeed = 0;
beforeEach(() => {
  byteSeed = 0;
  vi.mocked(globalThis.crypto.getRandomValues).mockImplementation(
    ((array: Uint8Array) => {
      byteSeed = (byteSeed % 254) + 1;
      (array as Uint8Array).fill(byteSeed);
      return array;
    }) as typeof globalThis.crypto.getRandomValues
  );
});

let seq = 0;
const nextBatchId = () => `BTC-${String(++seq).padStart(3, '0')}`;

function batchPayload(
  batchId: string,
  schoolName: string,
  total: number,
  invoiceNumber: string
): ExaminationGeneratedInvoicePayload {
  return {
    id: invoiceNumber,
    backendInvoiceId: invoiceNumber,
    invoiceNumber,
    date: '2026-09-20T00:00:00.000Z',
    dueDate: '2026-10-20T00:00:00.000Z',
    customerId: `CUST-${schoolName}`,
    customerName: schoolName,
    subtotal: total,
    totalAmount: total,
    paidAmount: 0,
    status: 'Unpaid',
    items: [
      {
        id: `${batchId}-CLS`,
        itemId: `${batchId}-CLS`,
        name: 'Examination Service',
        sku: `EXM-${batchId}`,
        description: `${schoolName} batch ${batchId}`,
        category: 'Examination',
        type: 'Service',
        unit: 'learner',
        minStockLevel: 0,
        stock: 0,
        reserved: 0,
        price: total,
        cost: 0,
        quantity: 1,
        total,
      },
    ],
    batchId,
    schoolName,
    origin_module: 'examination',
    origin_batch_id: batchId,
  } as ExaminationGeneratedInvoicePayload;
}

/** Mirror of the ERP verifier predicate (see header). */
function verifierAccepts(
  syncedRows: Array<Record<string, unknown>>,
  documentNumber: string,
  token: string
): boolean {
  const hit = syncedRows
    .map((row) => row)
    .find(
      (row) =>
        String(row.id ?? '') === documentNumber ||
        String(row.invoiceNumber ?? '') === documentNumber
    );
  if (!hit) return false;
  const stored = String(hit.verificationToken ?? '');
  return Boolean(stored) && stored === String(token || '');
}

/** Minimal device: local store + mint/convert/persist + simulated transport. */
function makeDevice(sharedCollection: Array<Record<string, unknown>>) {
  const store: Array<Record<string, unknown>> = [];
  return {
    store,
    convertBatch(batchId: string, schoolName: string, total: number) {
      // Phase 1: mint against the canonical invoices namespace (local view
      // of it + everything synced so far).
      const invoiceNumber = generateNextExaminationInvoiceNumber(
        [...sharedCollection, ...store] as Array<{ id?: unknown; invoiceNumber?: unknown }>,
        config
      );
      // Phases 2/3: authoritative mapping (canonical id + token at birth).
      const invoice = mapExaminationPayloadToInvoice(
        batchPayload(batchId, schoolName, total, invoiceNumber)
      ) as unknown as Record<string, unknown>;
      store.push(structuredClone(invoice));
      // Simulated sync commit: the envelope the gateway would store.
      const envelope = structuredClone(invoice);
      return { invoice, envelope };
    },
    /** Simulated Device B pull/realtime of one envelope. */
    receive(envelope: Record<string, unknown>) {
      const incoming = structuredClone(envelope) as Record<string, unknown>;
      const existing = store.find((row) => String(row.id) === String(incoming.id));
      if (existing) {
        const merged = fieldLevelMerge(existing, {
          ...incoming,
          updated_at: new Date().toISOString(),
        }) as Record<string, unknown>;
        Object.assign(existing, merged);
      } else {
        store.push(incoming);
      }
    },
  };
}

function runScenario(secondConverter: 'A' | 'B') {
  seq = 0;
  const syncedRows: Array<Record<string, unknown>> = [];
  const deviceA = makeDevice(syncedRows);
  const deviceB = makeDevice(syncedRows);

  // Device A: Batch A → invoice → sync.
  const batchA = nextBatchId();
  const { invoice: invA, envelope: envA } = deviceA.convertBatch(batchA, 'School A', 1000);
  expect(String(invA.id)).toMatch(/^EXM-/);
  expect(String(invA.id)).toBe(String(invA.invoiceNumber));
  expect(String(invA.verificationToken)).toMatch(TOKEN_64);
  syncedRows.push(envA);

  // Device B receives, lists, opens by canonical id, verifies.
  deviceB.receive(envA);
  expect(deviceB.store.length).toBe(1); // list shows it
  const navKeyA = resolveExaminationInvoiceNavigationKey({
    syncInvoiceId: invA.id,
    invoiceNumber: invA.invoiceNumber,
  });
  expect(navKeyA).toBe(String(invA.id));
  const openedA = findInvoiceByIdOrNumber(
    deviceB.store as Invoice[],
    navKeyA
  );
  expect(openedA).toBeDefined();
  expect((openedA as unknown as Record<string, unknown>).customerName).toBe('School A');
  const urlA = buildInvoiceVerificationUrl(
    {
      invoiceNumber: (openedA as unknown as Record<string, unknown>).invoiceNumber,
      verificationToken: (openedA as unknown as Record<string, unknown>).verificationToken,
    },
    'https://portal.test'
  );
  expect(urlA).toContain(encodeURIComponent(String(invA.id)));
  expect(
    verifierAccepts(syncedRows, String(invA.id), String(invA.verificationToken))
  ).toBe(true);

  // Second batch converted by A or B (ordering variant).
  const batchB = nextBatchId();
  const converter = secondConverter === 'A' ? deviceA : deviceB;
  // The converter's namespace view includes everything synced so far.
  const { invoice: invB, envelope: envB } = converter.convertBatch(batchB, 'School B', 2500);
  syncedRows.push(envB);
  if (secondConverter === 'B') deviceA.receive(envB);
  deviceB.receive(envB);

  // Assertions: distinct ids, A untouched, both open, both verify.
  expect(String(invB.id)).not.toBe(String(invA.id));
  const numbers = new Set(syncedRows.map((row) => String(row.invoiceNumber)));
  expect(numbers.size).toBe(2);

  const storedA = syncedRows.find((row) => String(row.id) === String(invA.id))!;
  expect((storedA as Record<string, unknown>).customerName).toBe('School A');
  expect((storedA as Record<string, unknown>).totalAmount).toBe(1000);
  expect((storedA as Record<string, unknown>).verificationToken).toBe(invA.verificationToken);

  for (const device of [deviceA, deviceB]) {
    const openA = findInvoiceByIdOrNumber(device.store as Invoice[], invA.id);
    const openB = findInvoiceByIdOrNumber(device.store as Invoice[], invB.id);
    expect(openA).toBeDefined();
    expect(openB).toBeDefined();
    expect((openA as unknown as Record<string, unknown>).customerName).toBe('School A');
    expect((openB as unknown as Record<string, unknown>).customerName).toBe('School B');
  }
  expect(verifierAccepts(syncedRows, String(invA.id), String(invA.verificationToken))).toBe(true);
  expect(verifierAccepts(syncedRows, String(invB.id), String(invB.verificationToken))).toBe(true);
  // Cross-token must NOT verify (no oracle, no cross-acceptance).
  expect(verifierAccepts(syncedRows, String(invA.id), String(invB.verificationToken))).toBe(false);
}

describe('Phase 8 — cross-device examination invoice lifecycle', () => {
  it('Device A converts, Device B opens + verifies; second batch by A stays distinct', () => {
    runScenario('A');
  });

  it('reverse ordering: second batch converted by Device B stays distinct', () => {
    runScenario('B');
  });
});

describe('P0 — stale snapshot race: same candidate, A wins, B re-mints (never merges)', () => {
  it('both devices mint EXM-X from the SAME snapshot; loser re-mints, winner byte-equivalent', async () => {
    // 1-2. Common initial snapshot, handed INDEPENDENTLY to both devices.
    const initialSnapshot = [{ id: 'EXM-0001', invoiceNumber: 'EXM-0001' }];

    // 3-4. Both calculate BEFORE either sees the other's invoice → same candidate.
    // This is the dangerous precondition the previous test never produced.
    const candidateA = generateNextExaminationInvoiceNumber(initialSnapshot, config);
    const candidateB = generateNextExaminationInvoiceNumber(initialSnapshot, config);
    expect(candidateA).toBe(candidateB);
    const exmX = candidateA;

    // 5. A persists/syncs first: the server row v1 is A's invoice.
    seq = 100;
    const invA = mapExaminationPayloadToInvoice(
      batchPayload(nextBatchId(), 'School A', 1000, exmX)
    ) as unknown as Record<string, unknown>;
    const server = {
      version: 1,
      updatedAt: '2026-09-21T00:00:00.000Z',
      data: structuredClone(invA),
    };
    const syncedRows: Array<Record<string, unknown>> = [server.data];

    // 6. B (still stale) persists locally under the same candidate, then its
    // push collides: the gateway answers version_required + A's snapshot.
    const invB = mapExaminationPayloadToInvoice(
      batchPayload(nextBatchId(), 'School B', 2500, exmX)
    ) as unknown as Record<string, unknown>;
    const deviceBlocal = [structuredClone(invB)];

    // 7. Exercise the ACTUAL production collision path (not a re-implementation):
    // fake I/O deps over the scenario's in-memory stores.
    const saved: Array<Record<string, unknown>> = [];
    const removed: string[] = [];
    const completed: string[] = [];
    const deadLettered: Array<{ id: string; reason: string }> = [];
    const audits: unknown[] = [];
    const notices: Array<{ ev: string; data: unknown }> = [];
    const batchLinks: Array<{ batchId: string; invoiceId: string }> = [];
    const fakeBatches = [{ id: 'batch-b-uuid', batch_number: 'BTC-B-101', invoice_id: exmX }];

    const invBForQueue = {
      ...structuredClone(invB),
      batchId: 'BTC-B-101',
      origin_batch_id: 'BTC-B-101',
      reference: 'EXAM-BATCH-BTC-B-101',
    };
    const result = await resolveExaminationInvoiceCollision(
      {
        id: 'op-b-1',
        operationId: 'op-b-1',
        table: 'invoices',
        recordId: exmX,
        operation: 'upsert',
        payload: invBForQueue,
      },
      server,
      {
        listInvoices: async () => deviceBlocal.map((row) => ({ ...row })),
        saveInvoiceLocal: async (invoice) => {
          saved.push(invoice);
          return invoice.id;
        },
        removeInvoiceLocal: async (id) => {
          removed.push(id);
        },
        listBatches: async () => fakeBatches.map((batch) => ({ ...batch })),
        updateBatchInvoiceLink: async (batchId, invoiceId) => {
          batchLinks.push({ batchId, invoiceId });
        },
        completeQueueItem: async (queueId) => {
          completed.push(queueId);
        },
        deadLetterQueueItem: async (id, reason) => {
          deadLettered.push({ id, reason });
        },
        recordConflictAudit: async (entry) => {
          audits.push(entry);
        },
        notifyUser: (ev, data) => {
          notices.push({ ev, data });
        },
        numberingConfig: config,
      }
    );

    // 8. B receives a NEW number (or an explicit safe conflict) — never a merge.
    expect(result.handled).toBe(true);
    expect(result.outcome).toBe('conflict');
    expect(deadLettered).toEqual([]);
    const newId = result.newInvoiceId;
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(exmX);

    // 10. B eventually holds a different canonical id with its content + token intact.
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(newId);
    expect(saved[0].invoiceNumber).toBe(newId);
    expect(saved[0].customerName).toBe('School B');
    expect(saved[0].totalAmount).toBe(2500);
    expect(saved[0].batchId).toBe('BTC-B-101');
    expect(String(saved[0].verificationToken)).toMatch(TOKEN_64);
    expect(saved[0].verificationToken).toBe(invB.verificationToken);
    expect(Array.isArray(saved[0].items)).toBe(true);
    // Stale identity retired locally; stale op completed so the old id is
    // never applied remotely (winner untouched by construction).
    expect(removed).toEqual([exmX]);
    expect(completed).toEqual(['op-b-1']);
    // Owning batch repointed to the fresh id.
    expect(batchLinks).toEqual([{ batchId: 'batch-b-uuid', invoiceId: newId }]);
    // B can open its re-minted invoice deterministically.
    expect(findInvoiceByIdOrNumber(saved as Invoice[], newId)).toBe(saved[0]);

    // 9. A's id/number/customer/totals/items/token remain byte/value equivalent.
    expect(server.data.id).toBe(exmX);
    expect(server.data.invoiceNumber).toBe(exmX);
    expect(server.data.customerName).toBe('School A');
    expect(server.data.totalAmount).toBe(1000);
    expect(server.data.items).toEqual(invA.items);
    expect(server.data.verificationToken).toBe(invA.verificationToken);

    // 11. Both invoices verify independently once B's row commits.
    syncedRows.push(saved[0]);
    expect(verifierAccepts(syncedRows, exmX, String(invA.verificationToken))).toBe(true);
    expect(verifierAccepts(syncedRows, String(newId), String(invB.verificationToken))).toBe(true);
    expect(verifierAccepts(syncedRows, exmX, String(invB.verificationToken))).toBe(false);
  });
});

/**
 * Focused cross-device proof of the canonical persistence payload.
 *
 * Device A persists through persistExaminationInvoiceToFinance(); the exact
 * invoice handed to `api.finance.saveInvoice` is what the finance store writes
 * and what the durable sync queue carries to the gateway unchanged. Device B
 * then applies that cloud envelope through its own bulkPut (what
 * pullRemoteChanges does for new rows).
 *
 * The finance API is mocked (no backend), and each device gets an isolated
 * in-memory store so the two sides cannot accidentally share a row.
 */
const phase8b = vi.hoisted(() => {
  const stores = new Map<string, Map<string, Record<string, any>>>();
  let activeDevice = 'A';
  const storeFor = (device: string, storeName: string) => {
    const key = `${device}:${storeName}`;
    if (!stores.has(key)) stores.set(key, new Map());
    return stores.get(key)!;
  };
  const current = (storeName: string) => storeFor(activeDevice, storeName);
  const mockSaveInvoice = vi.fn(async (invoice: Record<string, any>) => {
    current('invoices').set(String(invoice.id), structuredClone(invoice));
    return { success: true, id: invoice.id };
  });

  return {
    mockSaveInvoice,
    setDevice(device: string) {
      activeDevice = device;
    },
    current,
    reset() {
      stores.clear();
      activeDevice = 'A';
      mockSaveInvoice.mockClear();
    },
  };
});

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async (storeName: string) => Array.from(phase8b.current(storeName).values())),
    get: vi.fn(async (storeName: string, id: string) => phase8b.current(storeName).get(String(id))),
    put: vi.fn(async (storeName: string, item: any) => {
      phase8b.current(storeName).set(String(item.id), structuredClone(item));
      return String(item.id);
    }),
    bulkPut: vi.fn(async (storeName: string, items: any[]) => {
      for (const item of items) {
        phase8b.current(storeName).set(String(item.id), structuredClone(item));
      }
    }),
    delete: vi.fn(async (storeName: string, id: string) => {
      phase8b.current(storeName).delete(String(id));
    }),
    executeAtomicOperation: vi.fn(async (_stores: string[], op: (tx: any) => Promise<any>) => op({
      objectStore: () => ({ get: async () => undefined, getAll: async () => [], put: async () => undefined }),
      done: Promise.resolve(),
    })),
  },
}));

vi.mock('../../services/api', () => ({
  api: { finance: { saveInvoice: phase8b.mockSaveInvoice } },
}));

describe('Phase 8b — cross-device through the canonical persistence payload', () => {
  const payload = {
    id: 'EXM-SYNC-1',
    invoiceNumber: 'EXM-SYNC-1',
    date: '2026-09-20T00:00:00.000Z',
    dueDate: '2026-10-20T00:00:00.000Z',
    customerId: 'CUST-1',
    customerName: 'Sync School',
    subtotal: 1000,
    totalAmount: 1000,
    paidAmount: 0,
    status: 'Unpaid',
    items: [
      {
        id: 'CLS-1',
        itemId: 'CLS-1',
        name: 'Class 1',
        sku: 'EXM-CLS-1',
        description: 'Class 1',
        category: 'Examination',
        type: 'Service',
        unit: 'learner',
        minStockLevel: 0,
        stock: 0,
        reserved: 0,
        price: 100,
        cost: 0,
        quantity: 10,
        total: 1000,
      },
    ],
    batchId: 'BTC-SYNC-1',
    schoolName: 'Sync School',
    origin_module: 'examination',
    origin_batch_id: 'BTC-SYNC-1',
  } as ExaminationGeneratedInvoicePayload;

  beforeEach(() => {
    phase8b.reset();
    phase8b.setDevice('A');
  });

  it('Device A persists a tokened examination invoice for the sync queue', async () => {
    const result = await persistExaminationInvoiceToFinance(payload, {
      companyConfig: config,
    });
    expect(result.synced).toBe(true);
    expect(result.invoiceId).toBe('EXM-SYNC-1');

    expect(phase8b.mockSaveInvoice).toHaveBeenCalledTimes(1);
    const saved = phase8b.mockSaveInvoice.mock.calls[0][0] as any;

    // The queue writes this exact payload to the shared `invoices` table with
    // the canonical id as the record key.
    expect(saved.id).toBe('EXM-SYNC-1');
    expect(saved.invoiceNumber).toBe('EXM-SYNC-1');
    expect(String(saved.verificationToken)).toMatch(/^[0-9a-f]{64}$/);
    expect(saved.originModule).toBe('examination');
    expect(saved.batchId).toBe('BTC-SYNC-1');
    expect(saved.origin_batch_id).toBe('BTC-SYNC-1');
    expect(saved.status).toBe('Unpaid');
    expect(saved.totalAmount).toBe(1000);
    expect(saved.items).toHaveLength(1);
  });

  it('Device B receives the exact same canonical invoice through the pull envelope', async () => {
    await persistExaminationInvoiceToFinance(payload, { companyConfig: config });
    const cloudEnvelope = structuredClone(
      phase8b.mockSaveInvoice.mock.calls[0][0] as Record<string, any>
    );

    // Simulate the outbound op arriving at Device B: apply the cloud payload
    // through the normal bulkPut path, exactly as pullRemoteChanges does.
    phase8b.setDevice('B');
    const { dbService } = await import('../../services/db');
    await dbService.bulkPut('invoices', [cloudEnvelope]);

    const local = await dbService.getAll<any>('invoices');
    expect(local).toHaveLength(1);
    expect(local[0].id).toBe('EXM-SYNC-1');
    expect(local[0].invoiceNumber).toBe('EXM-SYNC-1');
    expect(local[0].verificationToken).toBe(cloudEnvelope.verificationToken);
    expect(local[0].origin_module).toBe('examination');
    expect(local[0].origin_batch_id).toBe('BTC-SYNC-1');

    const opened = await dbService.get<any>('invoices', 'EXM-SYNC-1');
    expect(opened).toEqual(local[0]);
  });
});

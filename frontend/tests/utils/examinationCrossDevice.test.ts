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
import { mapExaminationPayloadToInvoice } from '../../services/examinationInvoiceSyncService';
import { ExaminationGeneratedInvoicePayload } from '../../services/examinationBatchService';
import { buildInvoiceVerificationUrl } from '../../utils/invoiceVerification';
import { fieldLevelMerge } from '../../services/syncConflictResolver';

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

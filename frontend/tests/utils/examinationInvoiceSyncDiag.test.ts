import { describe, expect, it } from 'vitest';
import {
  buildExaminationInvoiceDiag,
  renderExamDiagCopy,
  type ExamDiagInput,
} from '../../services/examinationInvoiceDiag';

const NUMBER = 'EXM-P726/021';
const TOKEN = 'e021e021e021e021e021e021e021e021e021e021e021e021e021e021e021e021';

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: NUMBER,
  invoiceNumber: NUMBER,
  originModule: 'examination',
  origin_module: 'examination',
  batchId: 'BTC-021',
  status: 'Unpaid',
  customerId: 'CUST-SECRET',
  customerName: 'Secret Customer Name',
  totalAmount: 2500,
  paidAmount: 0,
  items: [{ name: 'Secret line item' }],
  notes: 'secret notes',
  verificationToken: TOKEN,
  createdAt: '2026-09-20T00:00:00.000Z',
  _updatedAt: '2026-09-21T00:00:00.000Z',
  _version: 3,
  ...overrides,
});

const op = (overrides: Record<string, unknown> = {}) => ({
  id: 'op-1',
  operationId: 'op-uuid-1',
  table: 'invoices',
  recordId: NUMBER,
  operation: 'upsert',
  status: 'pending',
  createdAt: '2026-09-21T00:00:00.000Z',
  lastAttempt: null,
  retryCount: 0,
  lastError: null,
  errorType: null,
  syncGeneration: 7,
  conflictCount: 0,
  ...overrides,
});

const baseInput = (overrides: Partial<ExamDiagInput> = {}): ExamDiagInput => ({
  invoiceNumber: NUMBER,
  invoice: invoice(),
  queueOps: [],
  conflicts: [],
  syncMeta: { authBlocked: false, enginePaused: false },
  ...overrides,
});

const FORBIDDEN = [TOKEN, 'Secret Customer Name', 'CUST-SECRET', 'Secret line item', 'secret notes'];

const assertSafe = (value: unknown) => {
  const raw = JSON.stringify(value);
  for (const secret of FORBIDDEN) expect(raw).not.toContain(secret);
  expect(raw).not.toContain('verificationToken');
  expect(raw).not.toContain('totalAmount');
  expect(raw).not.toContain('paidAmount');
};

describe('examinationInvoiceDiag builder (read-only)', () => {
  it('invoice absent', async () => {
    const result = await buildExaminationInvoiceDiag(baseInput({ invoice: null }));
    expect(result.conclusion).toBe('LOCAL INVOICE ABSENT');
    expect(result.localInvoice.present).toBe(false);
    assertSafe(result);
    assertSafe(renderExamDiagCopy(result));
  });

  it('invoice present + no queue operation', async () => {
    const result = await buildExaminationInvoiceDiag(baseInput());
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — NO QUEUE OPERATION');
    expect(result.localInvoice.idEqualsNumber).toBe(true);
    expect(result.localInvoice.tokenPresent).toBe(true);
    expect(result.localInvoice.tokenLength).toBe(64);
    expect(result.localInvoice.tokenFingerprint).toMatch(/^[0-9a-f]{32,}$/);
    assertSafe(result);
  });

  it('invoice present + queued, not synced', async () => {
    const result = await buildExaminationInvoiceDiag(baseInput({ queueOps: [op()] }));
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — QUEUED, NOT SYNCED');
    expect(result.queue.operations[0].retryEligibility).toBe('in-flight');
    assertSafe(result);
  });

  it('invoice present + failed queue', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({ queueOps: [op({ status: 'failed', lastError: 'gateway timeout', retryCount: 2 })] })
    );
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — QUEUE FAILED');
    expect(result.queue.operations[0].retryEligibility).toBe('eligible');
    assertSafe(result);
  });

  it('authentication failure', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({
        queueOps: [op({ status: 'failed', errorType: 'unauthorized', lastError: 'Sync gateway rejected (403)' })],
        syncMeta: { authBlocked: true, enginePaused: false },
      })
    );
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — SYNC AUTH FAILED');
    expect(result.queue.operations[0].retryEligibility).toBe('blocked-reauth');
    expect(result.sync.authBlocked).toBe(true);
    assertSafe(result);
  });

  it('dead-letter', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({ queueOps: [op({ status: 'dead_letter', lastError: 'permanent rejection', errorType: 'permanent' })] })
    );
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — QUEUE FAILED');
    expect(result.queue.operations[0].retryEligibility).toBe('terminal');
    assertSafe(result);
  });

  it('conflict', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({
        queueOps: [op({ status: 'pending', conflictCount: 1 })],
        conflicts: [
          { recordId: NUMBER, resolved: 'review', conflictedFields: ['totalAmount', 'id'], serverVersion: 4 },
        ],
      })
    );
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — SYNC CONFLICT');
    // Identity fields survive; financial field names are redacted, values never present.
    expect(result.conflicts[0].conflictedFields).toContain('id');
    expect(result.conflicts[0].conflictedFields).toContain('redacted(1)');
    assertSafe(result);
    assertSafe(renderExamDiagCopy(result));
  });

  it('successful sync metadata', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({
        queueOps: [op({ status: 'completed' })],
        syncMeta: { authBlocked: false, enginePaused: false, lastSyncSuccess: '2026-09-22T00:00:00.000Z' },
      })
    );
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — SYNC SUCCESS RECORDED');
    expect(result.queue.operations[0].retryEligibility).toBe('done');
    assertSafe(result);
    assertSafe(renderExamDiagCopy(result));
  });

  it('copy output carries only safe fields', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({ queueOps: [op({ status: 'failed', lastError: 'timeout x' })] })
    );
    const copy = renderExamDiagCopy(result);
    expect(copy).toContain(NUMBER);
    expect(copy).toContain('op-1');
    assertSafe(copy);
  });

  it('is read-only: frozen inputs survive and outputs are fresh objects', async () => {
    const frozenInvoice = Object.freeze(invoice());
    const frozenOps = Object.freeze([Object.freeze(op())]);
    const input: ExamDiagInput = Object.freeze({
      invoiceNumber: NUMBER,
      invoice: frozenInvoice,
      queueOps: frozenOps,
      conflicts: [],
      syncMeta: {},
    }) as ExamDiagInput;
    const before = JSON.stringify({ invoice: frozenInvoice, ops: frozenOps });
    const result = await buildExaminationInvoiceDiag(input);
    expect(JSON.stringify({ invoice: frozenInvoice, ops: frozenOps })).toBe(before);
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — QUEUED, NOT SYNCED');
  });

  it('ignores queue operations for other records', async () => {
    const result = await buildExaminationInvoiceDiag(
      baseInput({ queueOps: [op({ recordId: 'EXM-P726/022' })] })
    );
    expect(result.queue.operations).toEqual([]);
    expect(result.conclusion).toBe('LOCAL INVOICE PRESENT — NO QUEUE OPERATION');
  });
});

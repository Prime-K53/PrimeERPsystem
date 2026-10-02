import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  EXAM_DIAG_INVOICE_NUMBER,
  examDiagTokenFingerprint,
  isExamDiagTarget,
  traceExamInvoice,
} from '../../utils/examinationInvoiceDiag';

const TARGET = 'EXM-P726/021';
const MARKER_TOKEN = 'zz-top-secret-marker-zz-9f8e7d6c5b4a39281706f5e4d3c2b1a09';

const debugPayloads = (): Array<{ tag: string; body: any }> => {
  const spy = console.debug as unknown as { mock: { calls: unknown[][] } };
  return spy.mock.calls
    .filter((args) => args[0] === '[ExamInvoiceDiag]')
    .map((args) => ({ tag: String(args[0]), body: JSON.parse(String(args[1])) }));
};

describe('examinationInvoiceDiag (temporary EXM-P726/021 trace)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('traces EXM-P726/021 by id, invoiceNumber, or recordId', async () => {
    expect(EXAM_DIAG_INVOICE_NUMBER).toBe(TARGET);
    expect(await traceExamInvoice('s1', { id: TARGET })).toBe(true);
    expect(await traceExamInvoice('s2', { invoiceNumber: TARGET })).toBe(true);
    expect(await traceExamInvoice('s3', { recordId: TARGET })).toBe(true);
    expect(await traceExamInvoice('s4', { id: `  ${TARGET}  ` })).toBe(true);
    const bodies = debugPayloads();
    expect(bodies.map((p) => p.body.stage)).toEqual(['s1', 's2', 's3', 's4']);
    for (const p of bodies) expect(p.body.target).toBe(TARGET);
  });

  it('does not trace other invoices', async () => {
    expect(await traceExamInvoice('other', { id: 'EXM-P726/022' })).toBe(false);
    expect(await traceExamInvoice('other', { invoiceNumber: 'INV-1' })).toBe(false);
    expect(await traceExamInvoice('other', null)).toBe(false);
    expect(await traceExamInvoice('other', undefined)).toBe(false);
    expect(await traceExamInvoice('other', 'EXM-P726/021' as any)).toBe(false);
    expect(debugPayloads()).toEqual([]);
    expect(isExamDiagTarget(TARGET)).toBe(true);
    expect(isExamDiagTarget('EXM-P726/022', 'INV-1')).toBe(false);
  });

  it('never emits the token value', async () => {
    await traceExamInvoice('t1', { id: TARGET, verificationToken: MARKER_TOKEN });
    await traceExamInvoice('t2', {
      id: TARGET,
      invoiceNumber: TARGET,
      originModule: 'examination',
      verificationToken: MARKER_TOKEN,
    }, { synced: true });
    const bodies = debugPayloads();
    expect(bodies.length).toBe(2);
    for (const p of bodies) {
      const raw = JSON.stringify(p.body);
      expect(raw).not.toContain(MARKER_TOKEN);
      expect(raw).not.toContain('verificationToken');
      expect(p.body.tokenPresent).toBe(true);
      expect(p.body.tokenLength).toBe(MARKER_TOKEN.length);
      expect(p.body.tokenFingerprint).toMatch(/^[0-9a-f]{32,}$/);
    }
  });

  it('fingerprint is deterministic and distinguishes tokens', async () => {
    const a1 = await examDiagTokenFingerprint(MARKER_TOKEN);
    const a2 = await examDiagTokenFingerprint(MARKER_TOKEN);
    const b = await examDiagTokenFingerprint(`${MARKER_TOKEN}-different`);
    expect(a1).toMatch(/^[0-9a-f]{32,}$/);
    expect(a1).toBe(a2);
    expect(b).toMatch(/^[0-9a-f]{32,}$/);
    expect(b).not.toBe(a1);
    expect(await examDiagTokenFingerprint('')).toBeNull();
    expect(await examDiagTokenFingerprint('   ')).toBeNull();
  });

  it('does not change return values, throw, or mutate inputs', async () => {
    const record = Object.freeze({
      id: TARGET,
      invoiceNumber: TARGET,
      originModule: 'examination',
      verificationToken: MARKER_TOKEN,
    });
    const before = JSON.stringify(record);
    await expect(traceExamInvoice('frozen', record as any)).resolves.toBe(true);
    expect(JSON.stringify(record)).toBe(before);
    await expect(traceExamInvoice('frozen-miss', Object.freeze({ id: 'OTHER' }) as any)).resolves.toBe(
      false
    );
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  attachDocumentSecurity,
  buildSecurityQrPayload,
} from '../../utils/documentSecurity';
import { detectVerifiableDocumentType } from '../../utils/documentVerification';
import { resolveExaminationPreviewVerification } from '../../utils/invoiceIdentity';
import {
  persistExaminationInvoiceToFinance,
  reconcileLegacyExaminationInvoices,
} from '../../services/examinationInvoiceSyncService';

const mockGetAll = vi.hoisted(() => vi.fn());
const mockPut = vi.hoisted(() => vi.fn());
const mockGet = vi.hoisted(() => vi.fn());

vi.mock('../../services/db', () => ({
  dbService: { getAll: mockGetAll, put: mockPut, get: mockGet },
}));

const TOK = 'f'.repeat(64);

/**
 * Regression: examination invoices must be publicly verifiable.
 *
 * The production preview builds FinancialDoc straight from batch rows, so
 * the payload carries only the official number (no invoiceNumber /
 * documentType). detectVerifiableDocumentType used to return null for it,
 * producing the legacy human-readable QR — scanning it could never verify.
 * Examination payloads now resolve as invoices (same `invoices` store).
 */
describe('examination invoice public verifiability', () => {
  it('hand-built EXM payload with token yields a verify URL (the reported break)', async () => {
    const data: any = {
      number: 'EXM-P726/001',
      date: '2026-09-01',
      clientName: 'Demo School',
      address: '',
      phone: '',
      items: [{ desc: 'Class 1', qty: 10, price: 500, total: 5000 }],
      subtotal: 5000,
      amountPaid: 0,
      totalAmount: 5000,
      verificationToken: TOK,
    };
    expect(detectVerifiableDocumentType(data)).toBe('invoice');
    const payload = buildSecurityQrPayload(data, 'Prime Printing Service');
    expect(payload).toContain('/#/verify/invoice/EXM-P726%2F001?t=');
    expect(payload).toContain(TOK);
    const secured: any = await attachDocumentSecurity(data, 'Prime Printing Service');
    expect(secured.securityQrPayload).toContain('/#/verify/invoice/');
  });

  it('detects examination markers without an EXM number', () => {
    expect(
      detectVerifiableDocumentType({ number: '-whatever', originModule: 'examination' })
    ).toBe('invoice');
    expect(
      detectVerifiableDocumentType({ number: 'whatever', documentTitle: 'Examination Invoice Q1' })
    ).toBe('invoice');
  });

  it('leaves non-examination detection untouched', () => {
    expect(detectVerifiableDocumentType({ receiptNumber: 'PAY-1' })).toBe('receipt');
    expect(detectVerifiableDocumentType({ quotationNumber: 'QTN-1' })).toBe('quotation');
    expect(detectVerifiableDocumentType({ invoiceNumber: 'INV-1' })).toBe('invoice');
    expect(detectVerifiableDocumentType({ id: 'SO-1' })).toBe('sales_order');
    expect(detectVerifiableDocumentType({ number: 'random-doc' })).toBeNull();
    expect(detectVerifiableDocumentType(null)).toBeNull();
    // Explicit other-type fields still win over examination markers.
    expect(
      detectVerifiableDocumentType({ receiptNumber: 'PAY-1', originModule: 'examination' })
    ).toBe('receipt');
  });

  it('resolveExaminationPreviewVerification returns stored identity + token', async () => {
    const invoices: any[] = [
      { id: 'EXM-P726/001', invoiceNumber: 'EXM-P726/001', verificationToken: TOK },
    ];
    const issue = vi.fn();
    const identity = await resolveExaminationPreviewVerification('EXM-P726/001', invoices, issue);
    expect(identity).toEqual({
      invoiceNumber: 'EXM-P726/001',
      documentType: 'invoice',
      verificationToken: TOK,
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it('issues a token when the record predates tokens', async () => {
    const invoices: any[] = [{ id: 'EXM-P726/002', invoiceNumber: 'EXM-P726/002' }];
    const identity = await resolveExaminationPreviewVerification(
      'EXM-P726/002',
      invoices,
      async () => TOK
    );
    expect(identity).toEqual({
      invoiceNumber: 'EXM-P726/002',
      documentType: 'invoice',
      verificationToken: TOK,
    });
  });

  it('returns null without a canonical record; survives issuer failure', async () => {
    expect(await resolveExaminationPreviewVerification('EXM-9999', [])).toBeNull();
    expect(
      await resolveExaminationPreviewVerification('local-exam-invoice-1-x', [
        { id: 'EXM-0001', invoiceNumber: 'EXM-0001' },
      ])
    ).toBeNull();
    const identity = await resolveExaminationPreviewVerification(
      'EXM-P726/003',
      [{ id: 'EXM-P726/003', invoiceNumber: 'EXM-P726/003' }],
      async () => {
        throw new Error('offline');
      }
    );
    expect(identity).toEqual({ invoiceNumber: 'EXM-P726/003', documentType: 'invoice' });
  });

  it('ExaminationPrinting view transforms with the new wiring', async () => {
    await expect(import('../../views/production/ExaminationPrinting')).resolves.toBeTruthy();
  }, 120000);
});

describe('canonical-path guard — persistExaminationInvoiceToFinance', () => {
  it('rejects payloads with no batchId', async () => {
    const result = await persistExaminationInvoiceToFinance({} as any);
    expect(result.synced).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.invoiceId).toBeNull();
    expect(result.message).toContain('non-canonical');
  });

  it('rejects payloads with wrong originModule', async () => {
    const result = await persistExaminationInvoiceToFinance({
      batchId: 'BATCH-1',
      originModule: 'sales',
    } as any);
    expect(result.synced).toBe(false);
    expect(result.fallbackUsed).toBe(false);
    expect(result.invoiceId).toBeNull();
    expect(result.message).toContain('non-canonical');
  });

  it('accepts payloads with batchId + originModule=examination', async () => {
    mockGet.mockResolvedValue({ id: 'BATCH-1', total_amount: 1000, calculated_adjustment_total: 0, rounding_adjustment_total: 0, rounding_method: 'nearest_50', adjustment_snapshots_json: '[]' });
    const result = await persistExaminationInvoiceToFinance({
      batchId: 'BATCH-1',
      originModule: 'examination',
      id: 'EXM-TEST-1',
      invoiceNumber: 'EXM-TEST-1',
      totalAmount: 1000,
      status: 'Unpaid',
      date: '2026-01-01',
      customerName: 'Test School',
      items: [],
    } as any);
    expect(result.invoiceId).toBe('EXM-TEST-1');
    expect(result.synced || result.fallbackUsed).toBeTruthy();
  });
});

describe('reconcileLegacyExaminationInvoices', () => {
  beforeEach(() => {
    mockGetAll.mockReset();
    mockPut.mockReset();
    mockGet.mockReset();
  });

  it('reconciles tokenless examination invoices', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'EXM-LEG-1', invoiceNumber: 'EXM-LEG-1', verificationToken: undefined },
      { id: 'EXM-LEG-2', invoiceNumber: 'EXM-LEG-2', verificationToken: '' },
      { id: 'REG-1', invoiceNumber: 'REG-1', verificationToken: 'existing-token' },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await reconcileLegacyExaminationInvoices();
    expect(result.reconciled).toBe(2);
    expect(result.errors).toEqual([]);
    expect(mockPut).toHaveBeenCalledTimes(2);
  });

  it('never overwrites existing tokens', async () => {
    mockGetAll.mockResolvedValue([
      { id: 'EXM-HAS-TOKEN', invoiceNumber: 'EXM-HAS-TOKEN', verificationToken: 'already-there' },
    ]);
    mockPut.mockResolvedValue(undefined);

    const result = await reconcileLegacyExaminationInvoices();
    expect(result.reconciled).toBe(0);
    expect(mockPut).not.toHaveBeenCalled();
  });

  it('survives scan failures without throwing', async () => {
    mockGetAll.mockRejectedValue(new Error('db down'));

    const result = await reconcileLegacyExaminationInvoices();
    expect(result.reconciled).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

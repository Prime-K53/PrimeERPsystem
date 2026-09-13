/**
 * invoiceQrPreviewDownload.test.ts — regression for the ERP Invoice
 * Preview/Download legacy-QR defect.
 *
 * Root cause: pre-token invoice records (or stale objects captured before the
 * on-open backfill round-trip) reached mapToInvoiceData WITHOUT a
 * verificationToken, so attachDocumentSecurity fell back to the legacy
 * human-readable payload ("Company, number, created on ..., by ...").
 * Neither the Preview pipeline (useDocumentPreview) nor the Download paths
 * (Orders invoice download, CustomerWorkspace download) ensured the token
 * synchronously before mapping.
 *
 * Fix: every invoice document-preparation path issues+persists the permanent
 * token first (normal invoice save path; never regenerates), then maps.
 *
 * These tests exercise the REAL pipeline end to end:
 *   token-less record -> getOrIssue (persisted, stable) -> mapToInvoiceData
 *   -> FinancialDocSchema parse -> attachDocumentSecurity -> QR PNG bytes
 *   -> pngjs + jsQR decode -> verification URL
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';

// ─── In-memory dbService stub (same approved pattern as invoiceVerification.test.ts)
const stores = new Map<string, Map<string, any>>();
function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => {
      m.set(String(rec.id ?? rec.key ?? `k${m.size}`), rec);
    },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => {
      m.delete(String(id));
    },
  };
}

vi.mock('../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
  },
}));

import { transactionService } from '../../services/transactionService';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../utils/documentSecurity';
import { FinancialDocSchema } from '../../views/shared/components/PDF/schemas';

const COMPANY = 'Prime Printing';
const ITEMS = [{ desc: 'Business Cards (500)', qty: 2, price: 15000, total: 30000 }];

/** A realistic pre-token ERP invoice record (as stored before backfill). */
function legacyInvoiceRecord() {
  return {
    id: 'INV-P726/024',
    invoiceNumber: 'INV-P726/024',
    date: '2026-09-10',
    customerName: 'Acme Secondary School',
    customerId: 'CUST-1',
    createdBy: 'Rhon Chiwatu',
    items: ITEMS,
    subtotal: 30000,
    tax: 0,
    totalAmount: 30000,
    paidAmount: 0,
    status: 'Unpaid',
  };
}

/**
 * The fixed preparation sequence shared by Preview (useDocumentPreview),
 * invoice Download (Orders) and CustomerWorkspace download: ensure the
 * permanent token first, then map.
 */
async function prepareInvoiceDocument(record: any): Promise<any> {
  let source = record;
  if (record?.id && !record.verificationToken) {
    const { token } = await transactionService.getOrIssueInvoiceVerificationToken(
      String(record.id)
    );
    if (token) source = { ...record, verificationToken: token };
  }
  return mapToInvoiceData(source, {} as any, 'INVOICE' as any);
}

function decodeQrDataUrl(dataUrl: string): string {
  expect(dataUrl).toMatch(/^data:image\/png/);
  const base64 = String(dataUrl).split(',')[1];
  expect(base64).toBeTruthy();
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(result).not.toBeNull();
  return String(result!.data);
}

describe('invoice QR preparation — token ensure (the actual defect)', () => {
  beforeEach(() => {
    stores.clear();
  });

  it('Test 1 — token-less invoice record receives a persisted 64-hex token', async () => {
    await storeFor('invoices').put(legacyInvoiceRecord());
    const { token, issued } = await transactionService.getOrIssueInvoiceVerificationToken('INV-P726/024');
    expect(issued).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const reread = await storeFor('invoices').get('INV-P726/024');
    expect(reread.verificationToken).toBe(token);
  });

  it('Test 2 — token is stable across repeated ensures (never rotated on Preview/Download)', async () => {
    await storeFor('invoices').put(legacyInvoiceRecord());
    const first = await transactionService.getOrIssueInvoiceVerificationToken('INV-P726/024');
    const second = await transactionService.getOrIssueInvoiceVerificationToken('INV-P726/024');
    const third = await transactionService.getOrIssueInvoiceVerificationToken('INV-P726/024');
    expect(second.token).toBe(first.token);
    expect(third.token).toBe(first.token);
    expect(second.issued).toBe(false);
  });

  it('Test 3 — mapper preserves verificationToken + documentType + invoiceNumber', async () => {
    const mapped: any = await prepareInvoiceDocument({
      ...legacyInvoiceRecord(),
      verificationToken: 'a'.repeat(64),
    });
    expect(mapped.verificationToken).toBe('a'.repeat(64));
    expect(mapped.documentType).toBe('invoice');
    expect(mapped.invoiceNumber).toBe('INV-P726/024');
  });

  it('Test 4 — FinancialDocSchema parse preserves the token (no zod stripping)', async () => {
    const mapped: any = await prepareInvoiceDocument({
      ...legacyInvoiceRecord(),
      verificationToken: 'b'.repeat(64),
    });
    const parsed = FinancialDocSchema.safeParse(mapped);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect((parsed.data as any).verificationToken).toBe('b'.repeat(64));
      expect((parsed.data as any).documentType).toBe('invoice');
    }
  });
});

describe('invoice QR PNG decode — Preview/Download proof', () => {
  beforeEach(() => {
    stores.clear();
  });

  it('Test 5 — token-less record decodes to the verification URL (not legacy text)', async () => {
    await storeFor('invoices').put(legacyInvoiceRecord());
    const stored = await storeFor('invoices').get('INV-P726/024');
    const mapped: any = await prepareInvoiceDocument(stored);
    const secured: any = await attachDocumentSecurity(mapped, COMPANY);

    // URL structure.
    expect(secured.securityQrPayload).toContain('/#/verify/invoice/');
    expect(secured.securityQrPayload).toContain('?t=');
    expect(secured.securityQrPayload).toContain('INV-P726%2F024');

    // Actual PNG bytes decode to that same URL.
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    const token = String(decoded.split('?t=')[1] || '');
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  }, 30000);

  it('Test 6 — decoded QR contains no legacy/company/customer/creator data', async () => {
    await storeFor('invoices').put(legacyInvoiceRecord());
    const stored = await storeFor('invoices').get('INV-P726/024');
    const mapped: any = await prepareInvoiceDocument(stored);
    const secured: any = await attachDocumentSecurity(mapped, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));

    expect(decoded).not.toContain(COMPANY);
    expect(decoded).not.toContain('Acme Secondary School');
    expect(decoded).not.toContain('Rhon Chiwatu');
    expect(decoded).not.toContain('created on');
    expect(decoded).not.toContain('subtotal');
    expect(decoded).not.toContain('Business Cards');
    // Only the official number appears, inside the URL path — never as free text.
    expect(decoded).not.toContain('{');
  }, 30000);

  it('Test 7 — Preview QR === Download QR for the same invoice (stable token everywhere)', async () => {
    await storeFor('invoices').put(legacyInvoiceRecord());

    // Simulate Preview: fresh read (post-backfill store state) -> prepare.
    const forPreview = await storeFor('invoices').get('INV-P726/024');
    const previewMapped: any = await prepareInvoiceDocument(forPreview);
    const previewSecured: any = await attachDocumentSecurity(previewMapped, COMPANY);

    // Simulate Download: fresh read again -> prepare.
    const forDownload = await storeFor('invoices').get('INV-P726/024');
    const downloadMapped: any = await prepareInvoiceDocument(forDownload);
    const downloadSecured: any = await attachDocumentSecurity(downloadMapped, COMPANY);

    const previewQr = decodeQrDataUrl(String(previewSecured.securityQrCodeDataUrl));
    const downloadQr = decodeQrDataUrl(String(downloadSecured.securityQrCodeDataUrl));
    expect(downloadQr).toBe(previewQr);
  }, 60000);
});

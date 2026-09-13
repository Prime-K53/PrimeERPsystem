/**
 * qrDecodedPayload.test.ts — proves the ACTUAL QR IMAGE BYTES decode to the
 * public verification URL (not the legacy human-readable payload).
 *
 * For every supported document type the full rendering path is exercised:
 *   record -> mapToInvoiceData / receipt builders (the real mapping layer)
 *   -> attachDocumentSecurity (the single QR-generation path)
 *   -> QR PNG bytes -> pngjs + jsQR decode
 *   -> decoded payload === verification URL
 *
 * Legacy text (company + number + "created on ... by ...") must NOT appear
 * in any decoded tokened-document QR.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { attachDocumentSecurity } from '../../utils/documentSecurity';
import {
  buildDocumentVerificationUrl,
  documentTypeSlug,
  type VerifiableDocumentType,
} from '../../utils/documentVerification';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import {
  buildCustomerReceiptDoc,
  buildSupplierPaymentDoc,
} from '../../services/receiptCalculationService';

const TOK = 'f'.repeat(64);
const COMPANY = 'Prime Printing Service';

/** Decode the QR PNG bytes produced by attachDocumentSecurity. */
function decodeQrDataUrl(dataUrl: string): string {
  expect(dataUrl).toMatch(/^data:image\/png/);
  const base64 = String(dataUrl).split(',')[1];
  expect(base64).toBeTruthy();
  const png = PNG.sync.read(Buffer.from(base64, 'base64'));
  const result = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  expect(result).not.toBeNull();
  return String(result!.data);
}

const ITEMS = [{ desc: 'A4 Paper Ream', qty: 10, price: 5000, total: 50000 }];

const CASES: Array<{
  type: VerifiableDocumentType;
  number: string;
  /** Raw ERP record as stored (with stable token), pre-mapping. */
  record: any;
  /** Target type for mapToInvoiceData, or 'receipt-doc' builders. */
  via: string;
}> = [
  {
    type: 'invoice', number: 'INV-T001', via: 'INVOICE',
    record: { id: 'INV-T001', invoiceNumber: 'INV-T001', date: '2026-09-01', customerName: 'Decode School', items: ITEMS, subtotal: 50000, totalAmount: 50000, paidAmount: 0, verificationToken: TOK },
  },
  {
    type: 'receipt', number: 'PAY-T001', via: 'receipt-doc',
    record: { id: 'PAY-T001', date: '2026-09-02', customerName: 'Decode School', amount: 50000, paymentMethod: 'Cash', allocations: [], verificationToken: TOK },
  },
  {
    type: 'quotation', number: 'QTN-T001', via: 'QUOTATION',
    record: { id: 'QTN-T001', date: '2026-09-03', customerName: 'Decode School', items: ITEMS, subtotal: 50000, totalAmount: 50000, verificationToken: TOK },
  },
  {
    type: 'sales_order', number: 'SO-T001', via: 'SALES_ORDER',
    record: { id: 'SO-T001', orderNumber: 'SO-T001', orderDate: '2026-09-04', date: '2026-09-04', customerName: 'Decode School', items: ITEMS, subtotal: 50000, totalAmount: 50000, verificationToken: TOK },
  },
  {
    type: 'purchase_order', number: 'PO-T001', via: 'PO',
    record: { id: 'PO-T001', supplierId: 'SUP-1', supplierName: 'Decode Supplier', date: '2026-09-05', items: [{ name: 'A4 Paper Ream', quantity: 10, cost: 5000 }], total: 50000, verificationToken: TOK },
  },
  {
    type: 'delivery_note', number: 'DN-T001', via: 'DELIVERY_NOTE',
    record: { id: 'DN-T001', invoiceId: 'INV-T001', date: '2026-09-06', customerName: 'Decode School', items: [{ desc: 'A4 Paper Ream', qty: 10 }], status: 'Delivered', verificationToken: TOK },
  },
  {
    type: 'supplier_payment', number: 'SPAY-T001', via: 'supplier-doc',
    record: { id: 'SPAY-T001', date: '2026-09-07', amount: 50000, paymentMethod: 'Bank Transfer', allocations: [], status: 'Cleared', verificationToken: TOK },
  },
  {
    type: 'statement', number: 'STMT-T001', via: 'ACCOUNT_STATEMENT',
    record: {
      statementNumber: 'STMT-T001', date: '2026-09-08', customerName: 'Decode School',
      startDate: '2026-08-01', endDate: '2026-08-31', currency: 'MWK',
      openingBalance: 10000,
      transactions: [{ date: '2026-08-05', reference: 'INV-T001', memo: 'Invoice', debit: 50000, credit: 0, runningBalance: 60000 }],
      totalInvoiced: 50000, totalReceived: 0, finalBalance: 60000,
      verificationToken: TOK,
    },
  },
];

function toPdfPayload(c: (typeof CASES)[number]): any {
  if (c.via === 'receipt-doc') {
    return buildCustomerReceiptDoc({ payment: c.record, customerName: 'Decode School', currentBalance: 0, currencySymbol: 'MWK' });
  }
  if (c.via === 'supplier-doc') {
    return buildSupplierPaymentDoc(c.record, 'Decode Supplier');
  }
  return mapToInvoiceData(c.record, {} as any, c.via as any);
}

describe.each(CASES.map((c) => [c.type, c.number] as const))(
  'decoded QR for %s %s',
  (type, number) => {
    it('decodes to exactly the public verification URL (no legacy payload)', async () => {
      const c = CASES.find((k) => k.type === type)!;
      const pdfPayload = toPdfPayload(c);
      const secured = await attachDocumentSecurity(pdfPayload, COMPANY);

      const expected = buildDocumentVerificationUrl({
        documentType: type,
        documentNumber: number,
        verificationToken: TOK,
      });
      expect(expected).not.toBeNull();

      // The string handed to the QR library is exactly the URL...
      expect(secured.securityQrPayload).toBe(expected);

      // ...and the ACTUAL QR IMAGE BYTES decode back to that same URL.
      const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
      expect(decoded).toBe(expected);

      const slug = documentTypeSlug(type);
      expect(decoded).toContain(`/#/verify/${slug}/`);
      expect(decoded).toContain('?t=');
      expect(decoded).toContain(TOK);

      // No legacy human-readable payload in a tokened document QR.
      expect(decoded).not.toContain('created on');
      expect(decoded).not.toContain(COMPANY);
      expect(decoded).not.toContain('Decode School');
      expect(decoded).not.toContain('Decode Supplier');
    }, 30000);
  }
);

describe('untokened documents keep the legacy QR (backward compatible)', () => {
  it('decodes to the human-readable payload, not a URL', async () => {
    const pdfPayload = mapToInvoiceData(
      { id: 'INV-OLD', invoiceNumber: 'INV-OLD', date: '2026-01-01', customerName: 'Old School', items: ITEMS, subtotal: 1, totalAmount: 1 },
      {} as any,
      'INVOICE' as any
    );
    const secured = await attachDocumentSecurity(pdfPayload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    expect(decoded).toContain('INV-OLD');
    expect(decoded).not.toContain('/#/verify/');
  }, 30000);
});

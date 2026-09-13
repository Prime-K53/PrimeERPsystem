/**
 * documentVerification.test.ts — generic framework tests.
 *
 * Covers one matrix per supported type (token create/reuse, deterministic
 * URL, QR payload routing) plus invoice backward-compatibility:
 * identical URLs, identical QR bytes, identical legacy payloads.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_DOCUMENT_TYPES,
  buildDocumentVerificationUrl,
  detectVerifiableDocumentType,
  resolveVerifiableDocumentNumber,
  documentTypeFromSlug,
  ensureDocumentVerificationToken,
  generateVerificationToken,
} from '../../utils/documentVerification';
import {
  buildInvoiceVerificationUrl,
  ensureInvoiceVerificationToken,
} from '../../utils/invoiceVerification';
import { attachDocumentSecurity, buildSecurityQrPayload } from '../../utils/documentSecurity';

const BASE = 'https://portal.primeerp.com';
const TOK = 'a'.repeat(64);

const CASES: Array<{
  type: 'invoice' | 'receipt' | 'quotation' | 'sales_order' | 'purchase_order' | 'delivery_note' | 'supplier_payment' | 'statement';
  slug: string;
  doc: any;
  number: string;
}> = [
  { type: 'invoice', slug: 'invoice', doc: { invoiceNumber: 'INV-G001', verificationToken: TOK }, number: 'INV-G001' },
  { type: 'receipt', slug: 'receipt', doc: { receiptNumber: 'PAY-G001', verificationToken: TOK }, number: 'PAY-G001' },
  { type: 'quotation', slug: 'quotation', doc: { id: 'QTN-G001', verificationToken: TOK }, number: 'QTN-G001' },
  { type: 'sales_order', slug: 'sales-order', doc: { orderNumber: 'SO-G001', verificationToken: TOK }, number: 'SO-G001' },
  { type: 'purchase_order', slug: 'purchase-order', doc: { order_number: 'PO-G001', verificationToken: TOK }, number: 'PO-G001' },
  { type: 'delivery_note', slug: 'delivery-note', doc: { dnNumber: 'DN-G001', verificationToken: TOK }, number: 'DN-G001' },
  { type: 'supplier_payment', slug: 'supplier-payment', doc: { documentType: 'supplier_payment', paymentId: 'SPAY-G001', supplierName: 'Paper Supplier', verificationToken: TOK }, number: 'SPAY-G001' },
  { type: 'statement', slug: 'statement', doc: { documentType: 'statement', statementNumber: 'STMT-G001', verificationToken: TOK }, number: 'STMT-G001' },
];

describe('supported types', () => {
  it('enables exactly the eight real document types', () => {
    expect(SUPPORTED_DOCUMENT_TYPES).toEqual([
      'invoice', 'receipt', 'quotation', 'sales_order', 'purchase_order', 'delivery_note',
      'supplier_payment', 'statement',
    ]);
  });

  it('resolves slugs both ways', () => {
    expect(documentTypeFromSlug('sales-order')).toBe('sales_order');
    expect(documentTypeFromSlug('supplier-payment')).toBe('supplier_payment');
    expect(documentTypeFromSlug('statement')).toBe('statement');
    expect(documentTypeFromSlug('invoice')).toBe('invoice');
    expect(documentTypeFromSlug('credit-note')).toBeNull();
    expect(documentTypeFromSlug('nope')).toBeNull();
  });

  it('never detects supplier payments or statements from bare text', () => {
    // Bare PAY- numbers stay customer receipts; bare customer/ledger text
    // with no official number field is not verifiable (fail closed).
    expect(detectVerifiableDocumentType({ number: 'PAY-001' })).toBe('receipt');
    expect(detectVerifiableDocumentType({ customerName: 'Acme', total: 100 })).toBeNull();
    expect(detectVerifiableDocumentType({ id: 'CUST-001', balance: 50 })).toBeNull();
    // Explicit type + SPAY-/STMT- prefixes route to the new types.
    expect(detectVerifiableDocumentType({ documentType: 'supplier_payment' })).toBe('supplier_payment');
    expect(detectVerifiableDocumentType({ paymentId: 'SPAY-001' })).toBe('supplier_payment');
    expect(detectVerifiableDocumentType({ documentType: 'statement' })).toBe('statement');
    expect(detectVerifiableDocumentType({ statementNumber: 'STMT-001' })).toBe('statement');
  });
});

describe.each(CASES.map((c) => [c.type, c.slug, c.doc, c.number] as const))(
  'type %s',
  (type, slug, doc, number) => {
    it('builds a deterministic URL with slug + number + token', () => {
      const a = buildDocumentVerificationUrl({ documentType: type, documentNumber: number, verificationToken: TOK }, BASE);
      const b = buildDocumentVerificationUrl({ documentType: type, documentNumber: number, verificationToken: TOK }, BASE + '/');
      expect(a).toBe(b);
      expect(a).toBe(`${BASE}/#/verify/${slug}/${encodeURIComponent(number)}?t=${TOK}`);
    });

    it('returns null without number or token, rejects unknown types', () => {
      expect(buildDocumentVerificationUrl({ documentType: type, documentNumber: number } as any, BASE)).toBeNull();
      expect(buildDocumentVerificationUrl({ documentType: type, documentNumber: '', verificationToken: TOK } as any, BASE)).toBeNull();
      expect(buildDocumentVerificationUrl({ documentType: 'credit_note', documentNumber: number, verificationToken: TOK } as any, BASE)).toBeNull();
    });

    it('detects type + number from payload data', () => {
      expect(detectVerifiableDocumentType(doc)).toBe(type);
      expect(resolveVerifiableDocumentNumber(doc, type)).toBe(number);
    });

    it('QR payload is the verification URL (no sensitive data)', async () => {
      const payload = buildSecurityQrPayload({ ...doc, date: '2026-09-01' }, 'Prime Printing Service');
      expect(payload).toContain(`/#/verify/${slug}/${encodeURIComponent(number)}?t=${TOK}`);
      expect(payload).toContain(TOK);
      for (const secret of ['customerEmail', 'customerPhone', 'password', 'created on']) {
        expect(payload).not.toContain(secret);
      }
      const secured = await attachDocumentSecurity({ ...doc, date: '2026-09-01' }, 'Prime Printing Service');
      expect(String(secured.securityQrCodeDataUrl)).toMatch(/^data:image\//);
    });

    it('re-rendering never changes the token or QR', async () => {
      const base = { ...doc, date: '2026-09-01' };
      const first = await attachDocumentSecurity({ ...base }, 'Prime Printing Service');
      const second = await attachDocumentSecurity({ ...base }, 'Prime Printing Service');
      expect(second.securityQrPayload).toBe(first.securityQrPayload);
      expect(second.securityQrCodeDataUrl).toBe(first.securityQrCodeDataUrl);
    });
  }
);

describe('token lifecycle (generic)', () => {
  it('issues once, reuses forever', () => {
    const fresh = ensureDocumentVerificationToken({ id: 'X-1' });
    expect(fresh.verificationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureDocumentVerificationToken(fresh)).toBe(fresh);
  });

  it('uses WebCrypto by default', () => {
    generateVerificationToken();
    expect((globalThis as any).crypto.getRandomValues).toHaveBeenCalled();
  });
});

describe('invoice backward compatibility', () => {
  const inv = { invoiceNumber: 'INV-P726/024', verificationToken: TOK };

  it('generic builder matches the original invoice URL byte-for-byte', () => {
    expect(buildDocumentVerificationUrl({ documentType: 'invoice', ...inv }, BASE)).toBe(
      buildInvoiceVerificationUrl(inv, BASE)
    );
    expect(buildInvoiceVerificationUrl(inv, BASE)).toBe(
      `${BASE}/#/verify/invoice/INV-P726%2F024?t=${TOK}`
    );
  });

  it('invoice facade delegates token helpers identically', () => {
    const a = ensureInvoiceVerificationToken({ id: 'INV-1' });
    expect(a.verificationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(ensureInvoiceVerificationToken(a)).toBe(a);
    expect(generateVerificationToken).toBeDefined();
  });

  it('legacy payload unchanged for untokened invoices', async () => {
    const secured = await attachDocumentSecurity(
      { invoiceNumber: 'INV-OLD', date: '2026-01-01', createdByName: 'Admin' } as any,
      'Prime Printing Service'
    );
    expect(secured.securityQrPayload).toContain('Prime Printing Service, INV-OLD, created on');
  });

  it('tokened invoice QR payload equals the generic URL exactly', async () => {
    const data: any = { invoiceNumber: 'INV-P726/024', date: '2026-09-01', verificationToken: TOK };
    const viaQr = await attachDocumentSecurity({ ...data }, 'Prime Printing Service');
    const expected = buildDocumentVerificationUrl({ documentType: 'invoice', ...data });
    expect(expected).not.toBeNull();
    expect(viaQr.securityQrPayload).toBe(expected);
    expect(viaQr.securityQrPayload).toBe(buildInvoiceVerificationUrl(data));
  });
});

describe('new types: supplier_payment + statement', () => {
  it('tokened supplier payment QR payload is the verification URL exactly', async () => {
    const data: any = {
      documentType: 'supplier_payment',
      paymentId: 'SPAY-P726/001',
      supplierName: 'Paper Supplier',
      date: '2026-09-12',
      verificationToken: TOK,
    };
    const viaQr = await attachDocumentSecurity({ ...data }, 'Prime Printing Service');
    const expected = buildDocumentVerificationUrl({ documentType: 'supplier_payment', documentNumber: 'SPAY-P726/001', verificationToken: TOK });
    expect(expected).not.toBeNull();
    expect(expected).toContain('/#/verify/supplier-payment/SPAY-P726%2F001?t=');
    expect(viaQr.securityQrPayload).toBe(expected);
  });

  it('tokened statement QR payload is the verification URL exactly', async () => {
    const data: any = {
      documentType: 'statement',
      statementNumber: 'STMT-P726-001',
      date: '2026-09-12',
      verificationToken: TOK,
    };
    const viaQr = await attachDocumentSecurity({ ...data }, 'Prime Printing Service');
    const expected = buildDocumentVerificationUrl({ documentType: 'statement', documentNumber: 'STMT-P726-001', verificationToken: TOK });
    expect(expected).not.toBeNull();
    expect(expected).toContain('/#/verify/statement/STMT-P726-001?t=');
    expect(viaQr.securityQrPayload).toBe(expected);
  });

  it('legacy payload preserved for untokened supplier payments and statements', async () => {
    const sp = await attachDocumentSecurity(
      { documentType: 'supplier_payment', paymentId: 'SPAY-OLD', supplierName: 'Old Supplier', date: '2026-01-01' } as any,
      'Prime Printing Service'
    );
    expect(sp.securityQrPayload).toContain('Prime Printing Service, SPAY-OLD, created on');
    const st = await attachDocumentSecurity(
      { documentType: 'statement', statementNumber: 'STMT-OLD', customerName: 'Old School', date: '2026-01-01' } as any,
      'Prime Printing Service'
    );
    expect(st.securityQrPayload).toContain('Prime Printing Service, STMT-OLD, created on');
  });
});

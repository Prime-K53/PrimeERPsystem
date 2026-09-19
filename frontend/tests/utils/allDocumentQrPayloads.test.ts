/**
 * allDocumentQrPayloads.test.ts — standardization proof for ALL verifiable
 * document types + the POS compact receipt.
 *
 * For every supported type the REAL mapping layer is exercised:
 *   record (with stable token) -> mapToInvoiceData / receipt builders
 *   -> attachDocumentSecurity (the single QR-generation path)
 *   -> QR PNG bytes -> pngjs + jsQR decode
 *   -> decoded payload === verification URL (never legacy data)
 *
 * Also covers: verificationStoreForDocType registry, POS receiptRef identity
 * (existing receipt record, no second POS record), POS legacy fallback when
 * no receipt is linked yet, QR stability (preview === download === print),
 * and token stability across VOID status changes.
 */
import { describe, it, expect } from 'vitest';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
import { attachDocumentSecurity } from '../../utils/documentSecurity';
import {
  verificationStoreForDocType,
  type VerifiableDocumentType,
} from '../../utils/documentVerification';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import {
  buildCustomerReceiptDoc,
  buildPosReceiptDoc,
  buildSupplierPaymentDoc,
} from '../../services/receiptCalculationService';
import { resolveVerificationBaseUrl } from '../../utils/invoiceVerification';

const TOK = 'e'.repeat(64);
const COMPANY = 'Prime Printing Service';
const BASE = resolveVerificationBaseUrl();

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

function assertUrlOnly(decoded: string, slug: string, number: string) {
  expect(decoded.startsWith(BASE)).toBe(true);
  expect(decoded).toContain(`/#/verify/${slug}/`);
  expect(decoded).toContain('?t=');
  expect(decoded).toContain(TOK);
  const token = String(decoded.split('?t=')[1] || '');
  expect(token).toMatch(/^[0-9a-f]{64}$/);
  // No legacy/business data inside the QR — only the official number in the URL.
  for (const banned of [
    COMPANY,
    'Decode School',
    'Decode Supplier',
    'Rhon Chiwatu',
    'created on',
    'subtotal',
    'A4 Paper Ream',
    '{',
  ]) {
    expect(decoded).not.toContain(banned);
  }
  expect(decoded).toContain(encodeURIComponent(number).replace(/%(25)+/g, '%25'));
}

describe('verification store registry (token ensured BEFORE mapping)', () => {
  it.each([
    ['INVOICE', 'invoices'],
    ['EXAMINATION_INVOICE', 'invoices'],
    ['QUOTATION', 'quotations'],
    ['ORDER', 'orders'],
    ['SALES_ORDER', 'salesOrders'],
    ['WORK_ORDER', 'jobOrders'],
    ['DELIVERY_NOTE', 'deliveryNotes'],
    ['PO', 'purchases'],
    ['RECEIPT', 'customerPayments'],
    ['SUPPLIER_PAYMENT', 'supplierPayments'],
    ['SUBSCRIPTION', 'recurringInvoices'],
    ['SALES_EXCHANGE', 'salesExchanges'],
    ['ACCOUNT_STATEMENT', 'statementSnapshots'],
    ['PRINTING_CONTRACT', 'assessmentContracts'],
  ] as Array<[string, string]>)('%s -> %s', (docType, store) => {
    expect(verificationStoreForDocType(docType)).toBe(store);
  });

  it('POS_RECEIPT has no direct record (represented by its linked receipt)', () => {
    expect(verificationStoreForDocType('POS_RECEIPT')).toBeNull();
  });

  it('unknown types resolve to null (legacy behavior preserved)', () => {
    expect(verificationStoreForDocType('JOB_TICKET')).toBeNull();
    expect(verificationStoreForDocType('')).toBeNull();
  });
});

describe.each([
  ['invoice', 'invoice', 'INV-M001', 'INVOICE'],
  ['quotation', 'quotation', 'QTN-M001', 'QUOTATION'],
  ['sales_order', 'sales-order', 'SO-M001', 'SALES_ORDER'],
  ['delivery_note', 'delivery-note', 'DN-M001', 'DELIVERY_NOTE'],
] as Array<[VerifiableDocumentType, string, string, string]>)(
  'decoded QR for %s',
  (type, slug, number, via) => {
    it('decodes to the URL only', async () => {
      const record: any = {
        id: number,
        date: '2026-09-01',
        customerName: 'Decode School',
        createdBy: 'Rhon Chiwatu',
        items: ITEMS,
        subtotal: 50000,
        totalAmount: 50000,
        paidAmount: 0,
        verificationToken: TOK,
      };
      if (type === 'invoice') {
        record.invoiceNumber = number;
      } else if (type === 'sales_order') {
        record.orderNumber = number;
        record.orderDate = '2026-09-01';
      }
      const payload = mapToInvoiceData(record, {} as any, via as any);
      const secured: any = await attachDocumentSecurity(payload, COMPANY);
      const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
      expect(decoded).toBe(secured.securityQrPayload);
      assertUrlOnly(decoded, slug, number);
    }, 30000);
  }
);

describe('decoded QR for purchase_order', () => {
  it('decodes to the URL only', async () => {
    const payload = mapToInvoiceData(
      {
        id: 'PO-M001',
        supplierId: 'SUP-1',
        supplierName: 'Decode Supplier',
        date: '2026-09-05',
        items: [{ name: 'A4 Paper Ream', quantity: 10, cost: 5000 }],
        total: 50000,
        verificationToken: TOK,
      } as any,
      {} as any,
      'PO' as any
    );
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'purchase-order', 'PO-M001');
  }, 30000);
});

describe('decoded QR for receipt', () => {
  it('decodes to the URL only', async () => {
    const payload = buildCustomerReceiptDoc({
      payment: {
        id: 'REC-M001',
        date: '2026-09-02',
        customerName: 'Decode School',
        amount: 50000,
        paymentMethod: 'Cash',
        allocations: [],
        verificationToken: TOK,
      } as any,
      customerName: 'Decode School',
      currentBalance: 0,
      currencySymbol: 'MWK',
    });
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'receipt', 'REC-M001');
  }, 30000);
});

describe('decoded QR for supplier_payment', () => {
  it('decodes to the URL only', async () => {
    const payload = buildSupplierPaymentDoc(
      {
        id: 'SPAY-M001',
        date: '2026-09-07',
        amount: 50000,
        paymentMethod: 'Bank Transfer',
        allocations: [],
        status: 'Cleared',
        verificationToken: TOK,
      } as any,
      'Decode Supplier'
    );
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'supplier-payment', 'SPAY-M001');
  }, 30000);
});

describe('decoded QR for statement', () => {
  it('decodes to the URL only', async () => {
    const payload = mapToInvoiceData(
      {
        statementNumber: 'STMT-M001',
        date: '2026-09-08',
        customerName: 'Decode School',
        startDate: '2026-08-01',
        endDate: '2026-08-31',
        currency: 'MWK',
        openingBalance: 10000,
        transactions: [
          { date: '2026-08-05', reference: 'INV-M001', memo: 'Invoice', debit: 50000, credit: 0, runningBalance: 60000 },
        ],
        totalInvoiced: 50000,
        totalReceived: 0,
        finalBalance: 60000,
        verificationToken: TOK,
      } as any,
      {} as any,
      'ACCOUNT_STATEMENT' as any
    );
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'statement', 'STMT-M001');
  }, 30000);
});

describe('decoded QR for printing_contract', () => {
  it('decodes to the URL only', async () => {
    const { buildPrintingContractDoc } = await import('../../services/printingContractService');
    const payload = await buildPrintingContractDoc({
      contract: {
        id: 'c-m001',
        company_id: 'co-1',
        customer_id: 'cust-1',
        school_id: 'sch-1',
        contract_number: 'PC-M001',
        title: 'Decode printing',
        status: 'active',
        prepaid_amount: 5000,
        max_assessments: 1,
        assessment_price: 5000,
        version: 1,
        verificationToken: TOK,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
        data: {
          lines: [{ key: 'l1', assessment_name: 'Decode print', quantity: 1, unit_price: 5000 }],
        },
      } as any,
      customerName: 'Decode School',
    });
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'printing-contract', 'PC-M001');
  }, 30000);
});

describe('POS receipt QR (compact, receipt-backed)', () => {
  const sale: any = {
    id: 'POS-M001',
    date: new Date('2026-09-09').toISOString(),
    totalAmount: 10000,
    subtotal: 10000,
    discount: 0,
    items: [{ name: 'Photocopy', quantity: 10, price: 1000 }],
    paymentMethod: 'Cash',
    payments: [{ method: 'Cash', amount: 10000 }],
    customerName: 'Walk-in Customer',
  };

  it('encodes the linked receipt verification URL (no second POS record)', async () => {
    const payload: any = buildPosReceiptDoc({
      sale,
      cashierName: 'Cashier',
      customerName: 'Walk-in Customer',
      receiptRef: { receiptNumber: 'REC-M009', verificationToken: TOK },
    });
    expect(payload.documentType).toBe('receipt');
    expect(payload.receiptNumber).toBe('REC-M009');
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).toBe(secured.securityQrPayload);
    assertUrlOnly(decoded, 'receipt', 'REC-M009');
  }, 30000);

  it('unlinked POS sale keeps the legacy payload (backward compatible)', async () => {
    const payload: any = buildPosReceiptDoc({ sale, cashierName: 'Cashier' });
    expect(payload.verificationToken).toBeUndefined();
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const decoded = decodeQrDataUrl(String(secured.securityQrCodeDataUrl));
    expect(decoded).not.toContain('/#/verify/');
  }, 30000);
});

describe('QR stability (preview === download === print)', () => {
  it('same record attached repeatedly yields identical QR bytes', async () => {
    const payload: any = mapToInvoiceData(
      {
        id: 'INV-M002',
        invoiceNumber: 'INV-M002',
        date: '2026-09-01',
        customerName: 'Decode School',
        items: ITEMS,
        subtotal: 50000,
        totalAmount: 50000,
        verificationToken: TOK,
      } as any,
      {} as any,
      'INVOICE' as any
    );
    const preview: any = await attachDocumentSecurity({ ...payload }, COMPANY);
    const download: any = await attachDocumentSecurity({ ...payload }, COMPANY);
    const print: any = await attachDocumentSecurity({ ...payload }, COMPANY);
    expect(download.securityQrCodeDataUrl).toBe(preview.securityQrCodeDataUrl);
    expect(print.securityQrCodeDataUrl).toBe(preview.securityQrCodeDataUrl);
    expect(decodeQrDataUrl(String(download.securityQrCodeDataUrl))).toBe(
      decodeQrDataUrl(String(preview.securityQrCodeDataUrl))
    );
  }, 60000);

  it('VOID status change does not rotate the token or QR', async () => {
    const base: any = {
      id: 'INV-M003',
      invoiceNumber: 'INV-M003',
      date: '2026-09-01',
      customerName: 'Decode School',
      items: ITEMS,
      subtotal: 50000,
      totalAmount: 50000,
      status: 'Unpaid',
      verificationToken: TOK,
    };
    const before: any = await attachDocumentSecurity(
      mapToInvoiceData(base, {} as any, 'INVOICE' as any),
      COMPANY
    );
    const after: any = await attachDocumentSecurity(
      mapToInvoiceData({ ...base, status: 'Voided' }, {} as any, 'INVOICE' as any),
      COMPANY
    );
    expect(after.securityQrPayload).toBe(before.securityQrPayload);
  }, 60000);
});

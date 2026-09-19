/**
 * receiptPolish.test.ts — targeted Payment Receipt refinement verification.
 *
 * Covers ONLY the customer RECEIPT path (PrimeDocument type 'RECEIPT'):
 * payment-record status semantics, canonical amounts/narrative, QR +
 * authentication preservation, and pagination safety after the spacing
 * tightening. No accounting, payment, or historical behavior is altered;
 * these tests lock presentation + data flow, not calculations.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import {
  buildCustomerReceiptDoc,
  calculateCustomerPaymentSnapshot,
  resolveReceiptPaymentBadge,
} from '../../../services/receiptCalculationService';
import { ReceiptSchema } from '../../../views/shared/components/PDF/schemas';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { analyseWithQr, norm } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';
const TOK = 'a'.repeat(64);
const CUSTOMER = 'Chigwenembe Primary School';

// Screenshot scenario: K70,000 received, K333,000 still outstanding.
const PARTIAL_SNAPSHOT = () =>
  calculateCustomerPaymentSnapshot({
    amountTendered: 70000,
    appliedInvoices: [{ invoiceId: 'INV-P726/031', allocationAmount: 70000, outstandingAmount: 403000 }],
    paymentDate: '2026-01-24',
    customerName: CUSTOMER,
  });

const partialPayment: any = {
  id: 'PAY-P726/031',
  date: '2026-01-24',
  customerName: CUSTOMER,
  amount: 70000,
  paymentMethod: 'Cash',
  verificationToken: TOK,
  allocations: [{ invoiceId: 'INV-P726/031', amount: 70000 }],
};

const buildPartialDoc = () =>
  buildCustomerReceiptDoc({
    payment: partialPayment,
    snapshot: PARTIAL_SNAPSHOT(),
    customerName: CUSTOMER,
    currencySymbol: 'K',
  });

async function renderPdf(type: string, secured: any): Promise<Buffer> {
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type, data: secured })
  ).toString()) as unknown as string;
  return Buffer.from(str, 'latin1');
}

async function renderBoth(type: string, secured: any) {
  const [withQr, withoutQr] = await Promise.all([
    renderPdf(type, { ...secured }),
    renderPdf(type, (() => {
      const d: any = { ...secured };
      delete d.securityQrCodeDataUrl;
      delete d.securityQrPayload;
      return d;
    })()),
  ]);
  return analyseWithQr(withQr, withoutQr);
}

describe('resolveReceiptPaymentBadge — canonical payment-record status', () => {
  it('labels a partially-settled invoice payment as PAYMENT RECEIVED', () => {
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'PARTIALLY PAID' }).label).toBe('PAYMENT RECEIVED');
  });

  it('labels a fully-settled invoice payment as PAYMENT RECEIVED', () => {
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'PAID' }).label).toBe('PAYMENT RECEIVED');
  });

  it('labels an overpaid invoice payment as PAYMENT RECEIVED', () => {
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'OVERPAID' }).label).toBe('PAYMENT RECEIVED');
  });

  it('labels cancelled payments as CANCELLED (flags and status text)', () => {
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'PAID', isCancelled: true }).label).toBe('CANCELLED');
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'PAID', cancelled: true }).label).toBe('CANCELLED');
    expect(resolveReceiptPaymentBadge({ status: 'Cancelled' }).label).toBe('CANCELLED');
    expect(resolveReceiptPaymentBadge({ status: 'void' }).label).toBe('CANCELLED');
  });

  it('reuses the receipt green/red tones (no new palette)', () => {
    expect(resolveReceiptPaymentBadge({ paymentStatus: 'PARTIALLY PAID' })).toEqual({
      label: 'PAYMENT RECEIVED',
      color: '#059669',
      borderColor: '#10b981',
    });
    expect(resolveReceiptPaymentBadge({ status: 'Cancelled' })).toEqual({
      label: 'CANCELLED',
      color: '#dc2626',
      borderColor: '#ef4444',
    });
  });
});

describe('screenshot scenario — K70,000 received, K333,000 outstanding', () => {
  it('derives canonical doc fields without touching accounting state', () => {
    const doc: any = buildPartialDoc();
    expect(doc.amountReceived).toBe(70000);
    expect(doc.balanceDue).toBe(333000);
    // Canonical invoice-settlement source is preserved (drives the
    // Outstanding row), it just never labels the payment itself.
    expect(doc.paymentStatus).toBe('PARTIALLY PAID');
    expect(doc.appliedInvoices).toEqual(['INV-P726/031']);
    expect(doc.paymentMethod).toBe('Cash');
    expect(doc.customerName).toBe(CUSTOMER);
  });

  it('builds the exact explanation sentence dynamically', () => {
    const doc: any = buildPartialDoc();
    expect(doc.narrative).toBe(
      'This receipt confirms payment of K 70,000.00 from Chigwenembe Primary School on 24/01/2026 toward invoice(s) INV-P726/031. Outstanding balance is K 333,000.00.'
    );
  });

  it('renders PAYMENT RECEIVED (never PARTIALLY PAID) with both amounts', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('PAYMENT RECEIVED'));
    expect(text).not.toContain(norm('PARTIALLY PAID'));
    expect(text).toContain(norm('Amount Received'));
    expect(text).toContain(norm('K70,000.00'));
    expect(text).toContain(norm('Outstanding Balance'));
    expect(text).toContain(norm('K333,000.00'));
    expect(text).toContain(norm('Outstanding balance is K 333,000.00'));
    expect(text).toContain(norm('Payment Receipt'));
    expect(text).toContain(norm('PAY-P726/031'));
  }, 120000);
});

describe('receipt badge variants', () => {
  const paidDoc = () =>
    buildCustomerReceiptDoc({
      payment: {
        id: 'PAY-P726/032', date: '2026-01-24', customerName: CUSTOMER,
        amount: 100000, paymentMethod: 'Bank Transfer', verificationToken: TOK,
        allocations: [{ invoiceId: 'INV-P726/032', amount: 100000 }],
      } as any,
      snapshot: calculateCustomerPaymentSnapshot({
        amountTendered: 100000,
        appliedInvoices: [{ invoiceId: 'INV-P726/032', allocationAmount: 100000, outstandingAmount: 100000 }],
        paymentDate: '2026-01-24',
        customerName: CUSTOMER,
      }),
      customerName: CUSTOMER,
      currencySymbol: 'K',
    });

  it('fully-settled invoice: PAYMENT RECEIVED with no Outstanding row', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(paidDoc()), COMPANY);
    expect(secured.paymentStatus).toBe('PAID');
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('PAYMENT RECEIVED'));
    expect(text).not.toContain(norm('Outstanding Balance'));
    expect(text).toContain(norm('K100,000.00'));
  }, 120000);

  it('overpaid invoice: PAYMENT RECEIVED plus overpayment notice and wallet credit', async () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: {
        id: 'PAY-P726/033', date: '2026-01-24', customerName: CUSTOMER,
        amount: 120000, paymentMethod: 'Cash', verificationToken: TOK,
        allocations: [{ invoiceId: 'INV-P726/033', amount: 100000 }],
        excessHandling: 'Wallet',
      } as any,
      snapshot: calculateCustomerPaymentSnapshot({
        amountTendered: 120000,
        appliedInvoices: [{ invoiceId: 'INV-P726/033', allocationAmount: 100000, outstandingAmount: 100000 }],
        excessHandling: 'Wallet',
        paymentDate: '2026-01-24',
        customerName: CUSTOMER,
      }),
      customerName: CUSTOMER,
      currencySymbol: 'K',
    });
    expect(doc.paymentStatus).toBe('OVERPAID');
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(doc), COMPANY);
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('PAYMENT RECEIVED'));
    expect(text).toContain(norm('OVERPAYMENT NOTICE'));
    expect(text).toContain(norm('Wallet Credit'));
    expect(text).toContain(norm('K20,000.00'));
  }, 120000);

  it('cancelled receipt: CANCELLED badge, never PAYMENT RECEIVED', async () => {
    const base: any = ReceiptSchema.parse(buildPartialDoc());
    const secured: any = await attachDocumentSecurity({ ...base, status: 'Cancelled' }, COMPANY);
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('CANCELLED'));
    expect(text).not.toContain(norm('PAYMENT RECEIVED'));
  }, 120000);
});

describe('authentication, QR, footer and pagination safety', () => {
  it('QR encodes the canonical receipt verification URL', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    expect(secured.securityQrPayload).toContain('/#/verify/receipt/');
    expect(secured.securityQrPayload).toContain('?t=');
    expect(secured.securityQrPayload).toContain(TOK);
  });

  it('auth block + QR render on the final page with correct page numbering', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    expect(pages[0].text).toContain(norm('Page 1 of 1'));
    expect(pages[0].drawnImages).toContain(qrObj);
    expect(pages[0].text).toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(pages[0].text).toContain(norm('SCAN TO VERIFY'));
  }, 120000);

  it('multi-invoice receipts still paginate with QR final-only', async () => {
    const applied = Array.from({ length: 30 }, (_, i) => `INV-P726/${String(i + 1).padStart(3, '0')}`);
    const payment: any = {
      id: 'PAY-P726/001', date: '2026-09-01', customerName: CUSTOMER,
      amount: 30000, paymentMethod: 'Cash', verificationToken: TOK,
      allocations: applied.map((id) => ({ invoiceId: id, amount: 1000 })),
    };
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(buildCustomerReceiptDoc({ payment, customerName: CUSTOMER, currentBalance: 0, currencySymbol: 'MWK' })),
      COMPANY
    );
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(2);
    pages.forEach((p, i) => {
      expect(p.text).toContain(norm(`Page ${i + 1} of 2`));
      expect(p.text.length).toBeGreaterThan(200);
    });
    expect(pages[0].drawnImages).not.toContain(qrObj);
    expect(pages[0].text).not.toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(pages[1].drawnImages).toContain(qrObj);
    expect(pages[1].text).toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(pages[1].text).toContain(norm('Receipt PAY-P726/001'));
  }, 120000);

  it('long customer names and multiple allocations stay composed without clipping', async () => {
    const longName = 'Chigwenembe Primary School — Mtakataka Zone, Dedza District, Central Region, Malawi';
    const payment: any = {
      id: 'PAY-P726/040', date: '2026-01-24', customerName: longName,
      amount: 150000, paymentMethod: 'Bank Transfer', verificationToken: TOK,
      allocations: [
        { invoiceId: 'INV-P726/040', amount: 50000 },
        { invoiceId: 'INV-P726/041', amount: 50000 },
        { invoiceId: 'INV-P726/042', amount: 50000 },
      ],
    };
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(buildCustomerReceiptDoc({ payment, customerName: longName, currentBalance: 0, currencySymbol: 'K' })),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBeLessThanOrEqual(2);
    pages.forEach((p) => expect(p.text.length).toBeGreaterThan(200));
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('PAYMENT RECEIVED'));
    expect(text).toContain(norm('K150,000.00'));
    expect(text).toContain(norm('INV-P726/042'));
  }, 120000);
});

describe('visual QA artifacts (os.tmpdir only — never committed)', () => {
  it('writes representative receipt PDFs for human inspection', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const dir = path.join(os.tmpdir(), 'prime-receipt-qa');
    fs.mkdirSync(dir, { recursive: true });

    const partial: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    fs.writeFileSync(path.join(dir, 'receipt-partial-70k.png.pdf'), await renderPdf('RECEIPT', partial));

    const paid: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: {
            id: 'PAY-P726/032', date: '2026-01-24', customerName: CUSTOMER,
            amount: 100000, paymentMethod: 'Bank Transfer', verificationToken: TOK,
            allocations: [{ invoiceId: 'INV-P726/032', amount: 100000 }],
          } as any,
          snapshot: calculateCustomerPaymentSnapshot({
            amountTendered: 100000,
            appliedInvoices: [{ invoiceId: 'INV-P726/032', allocationAmount: 100000, outstandingAmount: 100000 }],
            paymentDate: '2026-01-24',
            customerName: CUSTOMER,
          }),
          customerName: CUSTOMER,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    fs.writeFileSync(path.join(dir, 'receipt-paid-100k.png.pdf'), await renderPdf('RECEIPT', paid));

    // eslint-disable-next-line no-console
    console.log(`receipt QA PDFs written to ${dir}`);
    expect(fs.existsSync(path.join(dir, 'receipt-partial-70k.png.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'receipt-paid-100k.png.pdf'))).toBe(true);
  }, 120000);
});

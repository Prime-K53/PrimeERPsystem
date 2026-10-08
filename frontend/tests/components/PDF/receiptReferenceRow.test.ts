/**
 * receiptReferenceRow.test.ts — official RECEIPT metadata Reference row.
 *
 * The compact metadata grid's Reference row is single-purpose and must
 * never repeat the allocation list already shown in the Payment Details
 * table:
 *   one invoice  -> that invoice number
 *   one order    -> that order number
 *   N invoices   -> "Multiple invoices (N)"
 *   N orders     -> "Multiple orders (N)"
 *   none         -> "—"
 *
 * The Payment Details table keeps the complete allocation list in every
 * case. No calculation, accounting, schema, QR or verification behavior
 * is altered — these tests lock presentation only.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import {
  buildCustomerReceiptDoc,
  calculateCustomerPaymentSnapshot,
} from '../../../services/receiptCalculationService';
import { ReceiptSchema } from '../../../views/shared/components/PDF/schemas';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { analyseWithQr, norm } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';
const TOK = 'b'.repeat(64);
const CUSTOMER = 'Mchinji Primary School';

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

/** Normalized text of the metadata grid segment from the Reference label
 *  to the Payment Details heading (last occurrence wins, so customer names
 *  containing "reference" cannot break the split). */
const refSegment = (text: string): string => {
  const head = text.split('PAYMENTDETAILS')[0];
  const idx = head.lastIndexOf('REFERENCE');
  expect(idx).toBeGreaterThan(-1);
  return head.slice(idx);
};

const invoicePayment = (id: string, invoiceId: string, amount: number): any => ({
  id,
  date: '2026-02-10',
  customerName: CUSTOMER,
  amount,
  paymentMethod: 'Cash',
  verificationToken: TOK,
  allocations: [{ invoiceId, amount }],
});

const invoiceSnapshot = (invoiceId: string, amount: number, outstanding = amount) =>
  calculateCustomerPaymentSnapshot({
    amountTendered: amount,
    appliedInvoices: [{ invoiceId, allocationAmount: amount, outstandingAmount: outstanding }],
    paymentDate: '2026-02-10',
    customerName: CUSTOMER,
  });

describe('Reference row — single allocation', () => {
  it('one invoice shows exactly that invoice number', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: invoicePayment('PAY-REF/001', 'INV-00123', 25000),
          snapshot: invoiceSnapshot('INV-00123', 25000),
          customerName: CUSTOMER,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    expect(refSegment(text)).toContain(norm('INV-00123'));
    // Details table keeps the full allocation line.
    expect(text).toContain(norm('Payment for Invoices: INV-00123'));
  }, 120000);

  it('one order shows exactly that order number', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: {
            id: 'PAY-REF/002', date: '2026-02-10', customerName: CUSTOMER,
            amount: 50000, paymentMethod: 'Bank Transfer', verificationToken: TOK,
            allocations: [],
          } as any,
          customerName: CUSTOMER,
          currencySymbol: 'K',
          appliedOrders: ['ORD-REF/007'],
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    expect(refSegment(text)).toContain(norm('ORD-REF/007'));
    expect(text).toContain(norm('Payment for Orders: ORD-REF/007'));
  }, 120000);

  it('long single reference stays intact without a wrapped identifier list', async () => {
    const longId = `INV-REF/${'9'.repeat(48)}`;
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: invoicePayment('PAY-REF/006', longId, 25000),
          snapshot: invoiceSnapshot(longId, 25000),
          customerName: CUSTOMER,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    expect(refSegment(text)).toContain(norm(longId));
    expect(text).toContain(norm(`Payment for Invoices: ${longId}`));
  }, 120000);
});

describe('Reference row — multiple allocations collapse to a count', () => {
  it('three invoices show "Multiple invoices (3)" while details list all three', async () => {
    const ids = ['INV-REF/101', 'INV-REF/102', 'INV-REF/103'];
    const amount = 30000;
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: {
            id: 'PAY-REF/003', date: '2026-02-10', customerName: CUSTOMER,
            amount, paymentMethod: 'Cash', verificationToken: TOK,
            allocations: ids.map((invoiceId) => ({ invoiceId, amount: 10000 })),
          } as any,
          snapshot: calculateCustomerPaymentSnapshot({
            amountTendered: amount,
            appliedInvoices: ids.map((invoiceId) => ({
              invoiceId, allocationAmount: 10000, outstandingAmount: 10000,
            })),
            paymentDate: '2026-02-10',
            customerName: CUSTOMER,
          }),
          customerName: CUSTOMER,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    const seg = refSegment(text);
    expect(seg).toContain(norm('Multiple invoices (3)'));
    for (const id of ids) {
      expect(seg).not.toContain(norm(id));
    }
    for (const id of ids) {
      expect(text).toContain(norm(id));
    }
  }, 120000);

  it('two orders show "Multiple orders (2)" while details list both', async () => {
    const orders = ['ORD-REF/011', 'ORD-REF/012'];
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: {
            id: 'PAY-REF/004', date: '2026-02-10', customerName: CUSTOMER,
            amount: 80000, paymentMethod: 'Cash', verificationToken: TOK,
            allocations: [],
          } as any,
          customerName: CUSTOMER,
          currencySymbol: 'K',
          appliedOrders: orders,
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    const seg = refSegment(text);
    expect(seg).toContain(norm('Multiple orders (2)'));
    for (const id of orders) {
      expect(seg).not.toContain(norm(id));
    }
    expect(text).toContain(norm(`Payment for Orders: ${orders.join(', ')}`));
  }, 120000);

  it('sixty invoices show "Multiple invoices (60)" with no pagination regression', async () => {
    const applied = Array.from({ length: 60 }, (_, i) => `INV-P726/${String(i + 1).padStart(3, '0')}`);
    const payment: any = {
      id: 'PAY-REF/060', date: '2026-09-01', customerName: CUSTOMER,
      amount: 60000, paymentMethod: 'Cash', verificationToken: TOK,
      allocations: applied.map((id) => ({ invoiceId: id, amount: 1000 })),
    };
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(buildCustomerReceiptDoc({ payment, customerName: CUSTOMER, currentBalance: 0, currencySymbol: 'K' })),
      COMPANY
    );
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(2);
    const firstPage = pages[0].text;
    const seg = refSegment(firstPage);
    expect(seg).toContain(norm('Multiple invoices (60)'));
    expect(seg).not.toContain(norm('INV-P726/059'));
    // Details still carry the complete list across pages.
    const all = pages.map((p) => p.text).join(' ');
    expect(all).toContain(norm('INV-P726/001'));
    expect(all).toContain(norm('INV-P726/060'));
    // QR stays final-only.
    expect(pages[0].drawnImages).not.toContain(qrObj);
    expect(pages[1].drawnImages).toContain(qrObj);
  }, 120000);
});

describe('Reference row — mixed sources keep orders-first precedence', () => {
  it('one order plus one invoice shows the order reference', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: invoicePayment('PAY-REF/007', 'INV-MIX/1', 20000),
          snapshot: invoiceSnapshot('INV-MIX/1', 20000),
          customerName: CUSTOMER,
          currencySymbol: 'K',
          appliedOrders: ['ORD-MIX/1'],
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    expect(refSegment(text)).toContain(norm('ORD-MIX/1'));
    expect(text).toContain(norm('Payment for Orders: ORD-MIX/1'));
  }, 120000);
});

describe('Reference row — no allocation', () => {  it('shows a dash and keeps an empty details line', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: {
            id: 'PAY-REF/005', date: '2026-02-10', customerName: CUSTOMER,
            amount: 15000, paymentMethod: 'Cash', verificationToken: TOK,
            allocations: [],
          } as any,
          customerName: CUSTOMER,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    const { pages, pageCount } = await renderBoth('RECEIPT', secured);
    expect(pageCount).toBe(1);
    const text = pages.map((p) => p.text).join(' ');
    const seg = refSegment(text);
    expect(seg).not.toContain('INV-');
    expect(seg).not.toContain('ORD-');
    expect(text).toContain(norm('Payment for Invoices:'));
  }, 120000);
});

describe('Header — company name always a single row', () => {
  // Walk the element tree (no PDF render) to the header identity Text and
  // return its style. Identified by carrying the exact company name.
  const headerNameStyle = (companyName: string, doc: any, configOverride?: any): any => {
    const root: any = (PrimeDocument as any)({ type: 'RECEIPT', data: doc, configOverride });
    const matches: any[] = [];
    const stack: Array<{ node: any; parent: string }> = [{ node: root, parent: 'ROOT' }];
    while (stack.length > 0) {
      const { node } = stack.pop() as any;
      if (node == null || typeof node === 'boolean') continue;
      if (Array.isArray(node)) {
        for (const child of node) stack.push({ node: child, parent: 'arr' });
        continue;
      }
      if (typeof node !== 'object') continue;
      const el = node as { type?: unknown; props?: Record<string, unknown> };
      if (typeof el.type === 'function') {
        try {
          stack.push({ node: (el.type as (p: any) => unknown)({ ...(el.props || {}) }), parent: 'fn' });
        } catch {
          const kids = (el.props as any)?.children;
          if (kids !== undefined) stack.push({ node: kids, parent: 'fn-kids' });
        }
        continue;
      }
      // The company name also appears nested in the thank-you line — the
      // header identity node is the one carrying the one-line clamp.
      if (typeof el.type === 'string' && el.type === 'TEXT' && (el.props as any)?.children === companyName) {
        matches.push((el.props as any)?.style);
      }
      const kids = (el.props as any)?.children;
      if (kids !== undefined) stack.push({ node: kids, parent: el.type as string });
    }
    return matches.find((s) => s && (s as any).maxLines === 1) ?? matches[0] ?? null;
  };

  const paidDoc = () =>
    buildCustomerReceiptDoc({
      payment: invoicePayment('PAY-REF/009', 'INV-REF/009', 20000),
      snapshot: invoiceSnapshot('INV-REF/009', 20000),
      customerName: CUSTOMER,
      currencySymbol: 'K',
    });

  it('short names render at the configured Company Name Font Size with a one-line clamp', () => {
    const style = headerNameStyle('Prime Printing Service', paidDoc(), { companyName: 'Prime Printing Service' });
    expect(style).not.toBeNull();
    expect(style.maxLines).toBe(1);
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.fontSize).toBe(18);
  });

  it('very long names shrink below the configured size but keep the one-line clamp', () => {
    const longName = 'Chigwenembe Community Day Secondary School and Teacher Training College of the Central Region Cooperative Union Limited';
    const style = headerNameStyle(longName, paidDoc(), { companyName: longName });
    expect(style).not.toBeNull();
    expect(style.maxLines).toBe(1);
    expect(style.textOverflow).toBe('ellipsis');
    expect(style.fontSize).toBeLessThan(18);
    expect(style.fontSize).toBeGreaterThanOrEqual(8.5);
  });

  it('long company name still paginates to a single page', async () => {
    const longName = 'Chigwenembe Community Day Secondary School and Teacher Training College of the Central Region Cooperative Union Limited';
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(paidDoc()), COMPANY);
    const str = (await pdf(
      React.createElement(PrimeDocument as any, { type: 'RECEIPT', data: secured, configOverride: { companyName: longName } })
    ).toString()) as unknown as string;
    const { analysePages } = await import('./pdfAnalyse');
    const pages = analysePages(Buffer.from(str, 'latin1'));
    expect(pages).toHaveLength(1);
    expect(pages[0].text).toContain(norm(longName.slice(0, 20)));
  }, 120000);
});

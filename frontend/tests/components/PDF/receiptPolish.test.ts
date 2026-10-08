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
import { analysePages, analyseWithQr, norm } from './pdfAnalyse';

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

async function renderPdfWithConfig(type: string, secured: any, configOverride: any): Promise<Buffer> {
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type, data: secured, configOverride })
  ).toString()) as unknown as string;
  return Buffer.from(str, 'latin1');
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

  it('acknowledges the payment in one sentence, with no balance line when nothing is owed', () => {
    const doc: any = buildPartialDoc();
    expect(doc.narrative).toBe(
      'Receipt acknowledgment for payment of K 70,000.00 received from Chigwenembe Primary School'
    );
    // Nothing the header rows and the details table already print is
    // restated in the note: no date, no reference list, no second balance.
    expect(doc.narrative).not.toContain('24/01/2026');
    expect(doc.narrative).not.toContain('INV-P726/031');
    expect(doc.narrative).not.toContain('333,000');
    // A settled account has nothing to report, so the balance line is
    // suppressed rather than printing "K 0.00" on every receipt.
    expect(doc.narrative).not.toContain('account balance');
  });

  it('appends the account balance only when one is actually owed', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: partialPayment,
      snapshot: PARTIAL_SNAPSHOT(),
      customerName: CUSTOMER,
      currencySymbol: 'K',
      currentBalance: 25000,
    });
    expect(doc.narrative).toBe(
      'Receipt acknowledgment for payment of K 70,000.00 received from Chigwenembe Primary School. Your account balance is K 25,000.00'
    );
  });

  it('suppresses a sub-cent balance that would print as K 0.00', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: partialPayment,
      snapshot: PARTIAL_SNAPSHOT(),
      customerName: CUSTOMER,
      currencySymbol: 'K',
      currentBalance: 0.004,
    });
    expect(doc.narrative).not.toContain('account balance');
  });

  it('uses the same single sentence shape for a wallet top-up', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: {
        id: 'PAY-P726/070', date: '2026-01-24', customerName: CUSTOMER,
        amount: 50000, paymentMethod: 'Cash', verificationToken: TOK,
        allocations: [], excessHandling: 'Wallet',
      } as any,
      snapshot: calculateCustomerPaymentSnapshot({
        amountTendered: 50000,
        appliedInvoices: [],
        excessHandling: 'Wallet',
        paymentDate: '2026-01-24',
        customerName: CUSTOMER,
      }),
      customerName: CUSTOMER,
      currencySymbol: 'K',
      currentBalance: 0,
    });
    expect(doc.narrative).toBe(
      'Receipt acknowledgment for wallet top-up of K 50,000.00 received from Chigwenembe Primary School'
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
    // The account balance is unknown/zero here, so no balance sentence prints.
    expect(text).not.toContain(norm('Your account balance is'));
    expect(text).toContain(norm('Payment Receipt'));
    expect(text).toContain(norm('PAY-P726/031'));
  }, 120000);

  it('prints the account balance line once a real balance exists', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: partialPayment,
          snapshot: PARTIAL_SNAPSHOT(),
          customerName: CUSTOMER,
          currencySymbol: 'K',
          currentBalance: 25000,
        })
      ),
      COMPANY
    );
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Your account balance is K 25,000.00'));
  }, 120000);
});

/**
 * Walk the receipt element tree (no PDF render) and collect EVERY <Text> as
 * { text, style }. Both outermost and nested runs are collected, because a
 * nested run can carry its own fontSize (the shrunken customer name) while
 * others inherit the parent's (the bold "Label: " half of a metadata row).
 */
const receiptTexts = (doc: any, configOverride?: any) => {
  const root: any = (PrimeDocument as any)({ type: 'RECEIPT', data: doc, configOverride });
  const found: Array<{ text: string; style: any }> = [];
  const flatten = (node: any): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(flatten).join('');
    const el = node as { props?: Record<string, unknown> };
    return flatten(el.props?.children);
  };
  const stack: Array<{ node: any }> = [{ node: root }];
  while (stack.length > 0) {
    const { node } = stack.pop() as any;
    if (node == null || typeof node === 'boolean') continue;
    if (Array.isArray(node)) { for (const child of node) stack.push({ node: child }); continue; }
    if (typeof node !== 'object') continue;
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === 'function') {
      try { stack.push({ node: (el.type as (p: any) => unknown)({ ...(el.props || {}) }) }); }
      catch { /* unexpandable leaf — nothing to collect */ }
      continue;
    }
    if (typeof el.type === 'string' && el.type === 'TEXT') {
      found.push({ text: flatten(el.props?.children), style: (el.props as any)?.style });
    }
    const kids = el.props?.children;
    if (kids !== undefined) stack.push({ node: kids });
  }
  return found;
};

/** The <Text> whose own style sets `fontSize` and whose text matches `needle`. */
const receiptSizeOf = (texts: Array<{ text: string; style: any }>, needle: string) => {
  const sized = texts.filter((t) => typeof t.style?.fontSize === 'number');
  const hit = sized.find((t) => t.text.trim() === needle)
    ?? sized.find((t) => t.text.includes(needle));
  return hit?.style?.fontSize;
};

describe('receipt body type scale', () => {
  // The acknowledgment line sets the scale; everything that is body content
  // must match it exactly.
  const REFERENCE = 12;

  it('sizes the company address, contact line, metadata rows, section labels and every table cell at the acknowledgment line size', () => {
    const texts = receiptTexts(buildPartialDoc());

    // Notes Section heading + the acknowledgment line itself (the reference).
    expect(receiptSizeOf(texts, 'Notes Section')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Receipt acknowledgment for payment of')).toBe(REFERENCE);
    // Section labels + Payment Details table cells.
    expect(receiptSizeOf(texts, 'Payment Details Table')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Description')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Line Total')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Paid')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Amount Received')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Outstanding Balance')).toBe(REFERENCE);
    // Metadata rows (the label run is bold and inherits the row's size).
    expect(receiptSizeOf(texts, 'Receipt No:')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Customer Name:')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Payment Method:')).toBe(REFERENCE);
    expect(receiptSizeOf(texts, 'Currency:')).toBe(REFERENCE);
  });

  it('leaves no stray 10 / 10.5 / 11 body size behind', () => {
    const texts = receiptTexts(buildPartialDoc());
    const stray = texts
      .filter((t) => [10, 10.5, 11].includes(t.style?.fontSize))
      .map((t) => t.text);
    expect(stray).toEqual([]);
  });

  it('sizes the company address and contact line to match the body', () => {
    const configOverride = {
      companyName: 'Prime Printing Service',
      addressLine1: 'Along M5 Road Mtakataka',
      city: 'Dedza',
      country: 'Malawi',
      phone: '+265 992 528 222',
      email: 'info.primemw@gmail.com',
      currencySymbol: 'K',
    };
    const texts = receiptTexts(buildPartialDoc(), configOverride);
    expect(receiptSizeOf(texts, 'Along M5 Road')).toBe(REFERENCE);

    // Both the header contact line and the verification footer's contact line
    // carry phone and email; only the header line sets its own fontSize.
    const contactSizes = texts
      .filter((t) => t.text.includes('info.primemw@gmail.com'))
      .map((t) => t.style?.fontSize)
      .filter((size): size is number => typeof size === 'number');
    expect(contactSizes.length).toBeGreaterThan(0);
    expect(contactSizes.every((size) => size === REFERENCE)).toBe(true);
  });

  it('renders the title as sentence case while keeping its own size', () => {
    const texts = receiptTexts(buildPartialDoc());
    const title = texts.find((t) => t.text.trim() === 'Payment Receipt');
    expect(title).toBeTruthy();
    // Identity and title stay OUTSIDE the body scale.
    expect(title!.style?.fontSize).not.toBe(REFERENCE);
    const name = texts.find((t) => t.text === 'Prime Printing Service');
    expect(name?.style?.fontSize).not.toBe(REFERENCE);
  });
});

describe('customer name — always one row', () => {
  // A school name can be 60+ characters. It must print on ONE row, shrinking
  // only as far as needed, and never wrap.
  const LONG_NAME = 'Chigwenembe Community Day Secondary School and Teacher Training College';

  const nameRowOf = (doc: any) => receiptTexts(doc).find((t) => t.text.trim().startsWith('Customer Name:'));

  it('keeps a name that fits at the full body size', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: partialPayment,
      snapshot: PARTIAL_SNAPSHOT(),
      customerName: CUSTOMER,
      currencySymbol: 'K',
    });
    const row = nameRowOf(doc);
    expect(row).toBeTruthy();
    // Label at the body size, value at the body size.
    expect(row!.style?.fontSize).toBe(12);
    expect(row!.text).toBe(`Customer Name: ${CUSTOMER}`);
  });

  it('shrinks a long name to keep it on one row, and never below the floor', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: partialPayment,
      snapshot: PARTIAL_SNAPSHOT(),
      customerName: LONG_NAME,
      currencySymbol: 'K',
    });
    const row = nameRowOf(doc);
    expect(row).toBeTruthy();
    // The value is its own Text run so it can carry a smaller size than the
    // label beside it.
    const valueRun = receiptTexts(doc).find((t) => t.text === LONG_NAME);
    expect(valueRun).toBeTruthy();
    // Smaller than the body size, but never unreadable.
    expect(valueRun!.style?.fontSize).toBeLessThan(12);
    expect(valueRun!.style?.fontSize).toBeGreaterThanOrEqual(7);
    expect(valueRun!.text).toBe(LONG_NAME);
  });

  it('hard-clamps the row to a single line as the last-resort guarantee', () => {
    const doc: any = buildCustomerReceiptDoc({
      payment: partialPayment,
      snapshot: PARTIAL_SNAPSHOT(),
      customerName: LONG_NAME,
      currencySymbol: 'K',
    });
    const row = nameRowOf(doc)!;
    // maxLines + ellipsis is what makes "always one row" a guarantee rather
    // than a hope: a name too long even for the floor size is ellipsized on one
    // line instead of wrapping and breaking the header's rhythm.
    expect(row.style?.maxLines).toBe(1);
    expect(row.style?.textOverflow).toBe('ellipsis');
  });

  it('renders long customer names without adding a wrapped second row', async () => {
    const secured: any = await attachDocumentSecurity(
      ReceiptSchema.parse(
        buildCustomerReceiptDoc({
          payment: partialPayment,
          snapshot: PARTIAL_SNAPSHOT(),
          customerName: LONG_NAME,
          currencySymbol: 'K',
        })
      ),
      COMPANY
    );
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    // The whole name survives: the row shrank instead of wrapping, so no part
    // of it was pushed onto a second line or cut off.
    expect(text).toContain(norm(LONG_NAME));
  }, 120000);
});

describe('Payment Details table — Line Total vs Paid', () => {
  it('separates the invoice total from the amount paid against it', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Line Total'));
    expect(text).toContain(norm('Paid'));
    expect(text).not.toContain(norm('Unit Price'));
    // Invoice total is K403,000 (70,000 paid, 333,000 still due) — the two
    // money columns must never print the same figure.
    expect(text).toContain(norm('K403,000.00'));
    expect(text).toContain(norm('K70,000.00'));
    // The Amount Received total row is unchanged.
    expect(text).toContain(norm('Amount Received'));
  }, 120000);

  it('falls back to the tendered amount when the payload carries no allocation', async () => {
    const base: any = ReceiptSchema.parse(buildPartialDoc());
    const secured: any = await attachDocumentSecurity(
      { ...base, invoiceTotal: undefined, amountApplied: undefined, balanceDue: 0, paymentStatus: 'PAID' },
      COMPANY
    );
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Line Total'));
    expect(text).toContain(norm('Paid'));
    // Nothing to settle → Line Total 0.00, Paid is the whole tender.
    expect(text).toContain(norm('K0.00'));
    expect(text).toContain(norm('K70,000.00'));
    expect(text).not.toContain(norm('Outstanding Balance'));
  }, 120000);
});

describe('receipt Currency row names the currency', () => {
  it('prints Kwacha instead of the bare K symbol', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    const { pages } = await renderBoth('RECEIPT', secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Currency: Kwacha'));
    // Amounts keep the compact symbol prefix — only the row is named.
    expect(text).toContain(norm('K70,000.00'));
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
    expect(pages[0].text).not.toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(pages[0].text).not.toContain(norm('SCAN TO VERIFY'));
    expect(pages[0].text).toContain(norm('Digitally generated'));
    expect(pages[0].text).toContain(norm('Verification available online'));
  }, 120000);

  it('multi-invoice receipts still paginate with QR final-only', async () => {
    // 120 allocations: calibrated for the trimmed verification footer AND for
    // the single-sentence Notes Section (the old note repeated all 60 invoice
    // numbers, which pushed the receipt onto a second page on its own).
    const applied = Array.from({ length: 120 }, (_, i) => `INV-P726/${String(i + 1).padStart(3, '0')}`);
    const payment: any = {
      id: 'PAY-P726/001', date: '2026-09-01', customerName: CUSTOMER,
      amount: 120000, paymentMethod: 'Cash', verificationToken: TOK,
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
    expect(pages[1].text).not.toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(pages[1].text).not.toContain(norm('SCAN TO VERIFY'));
    expect(pages[1].text).toContain(norm('Digitally generated'));
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

describe('receipt header shows the company identity block from settings', () => {
  it('renders company name, street address and contact lines with a fully populated company config', async () => {
    const secured: any = await attachDocumentSecurity(ReceiptSchema.parse(buildPartialDoc()), COMPANY);
    const buf = await renderPdfWithConfig('RECEIPT', secured, {
      companyName: 'Prime Printing Service',
      addressLine1: 'Along M5 Road Mtakataka',
      city: 'Dedza',
      country: 'Malawi',
      phone: '+265 992 528 222',
      email: 'info.primemw@gmail.com',
    });
    const pages = analysePages(buf);
    expect(pages).toHaveLength(1);
    const text = pages.map((p) => p.text).join(' ');
    // Header carries the company name, the street line and the contact line.
    // (Page text is normalized uppercase — compare via norm().)
    expect(text).toContain(norm('Prime Printing Service'));
    expect(text).toContain(norm('Mtakataka'));
    expect(text).toContain(norm('primemw'));
    // The receipt address is the street line only: city and country are not
    // appended to the Company Address block.
    expect(text).not.toContain(norm('Dedza'));
    expect(text).not.toContain(norm('Malawi'));
    // Thank-you keeps the company name.
    expect(text).toContain(norm('Thank you for choosing Prime Printing Service'));
    // …while the QR verification block is kept.
    expect(text).not.toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(text).toContain(norm('Verification available online'));
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

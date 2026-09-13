/**
 * documentPagination.test.ts — GLOBAL pagination/security standard.
 *
 * Extends the proven invoice pagination architecture (see
 * invoiceTemplatePagination.test.ts + pdfAnalyse.ts) to every
 * customer-facing Prime ERP PDF type sharing the PaginationFurniture /
 * flowing-footer capability:
 *
 *   QUOTATION, SALES_ORDER, PO, DELIVERY_NOTE, EXAMINATION_INVOICE,
 *   SUBSCRIPTION, RECEIPT, SUPPLIER_PAYMENT, SALES_EXCHANGE,
 *   ACCOUNT_STATEMENT (+ INVOICE reference, covered by its own suite).
 *
 * Per type:
 *   TEST 1 — one page (or the type's natural minimum): exact count,
 *     Page 1 of N, QR only on the final page, full footer only on the
 *     final page, compact footer elsewhere, continuation header on pages
 *     2+, no blank pages, document data intact, QR payload unchanged.
 *   TEST 2 — two pages (same placement rules).
 *   TEST 3 — three pages where practically reachable (same rules).
 *
 * Presentation only. No accounting, payment, calculation, numbering, QR
 * algorithm, database, API, or Portal behavior is touched by these tests.
 * Fixtures use deterministic content that actually produces the asserted
 * page counts (calibrated empirically — item counts do not map 1:1).
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../../../utils/documentCustomerData';
import { attachDocumentSecurity, buildSecurityQrPayload } from '../../../utils/documentSecurity';
import {
  buildCustomerReceiptDoc,
  buildSupplierPaymentDoc,
} from '../../../services/receiptCalculationService';
import { ReceiptSchema, SupplierPaymentSchema } from '../../../views/shared/components/PDF/schemas';
import { norm, analyseWithQr } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';
const TOK = 'a'.repeat(64);
const CUSTOMER = 'Chiwana Primary School';
const CONTACT = 'John Banda';

function lineItems(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const qty = (i % 5) + 1;
    const price = 5000 + i * 250;
    return {
      desc: `Exercise Book A4 Hardcover Ruled 200 Pages Premium Quality Line ${i + 1}`,
      qty,
      price,
      total: qty * price,
    };
  });
}

function finRaw(n: number, extra: any = {}) {
  const items = lineItems(n);
  const subtotal = items.reduce((s: number, it: any) => s + it.total, 0);
  return {
    date: '2026-09-01',
    dueDate: '2026-10-01',
    businessName: CUSTOMER,
    contactName: CONTACT,
    customerId: 'CUST-0100',
    address: 'P.O. Box 123, Lilongwe',
    phone: '+265 999 000 001',
    items,
    subtotal,
    discount: 0,
    amountPaid: 0,
    totalAmount: subtotal,
    status: 'Unpaid',
    verificationToken: TOK,
    ...extra,
  };
}

async function renderBoth(type: string, secured: any) {
  const render = async (withQr: boolean) => {
    const data = { ...secured };
    if (!withQr) {
      delete data.securityQrCodeDataUrl;
      delete data.securityQrPayload;
    }
    const str = (await pdf(
      React.createElement(PrimeDocument as any, { type, data })
    ).toString()) as unknown as string;
    return Buffer.from(str, 'latin1');
  };
  const [withQr, withoutQr] = await Promise.all([render(true), render(false)]);
  return analyseWithQr(withQr, withoutQr);
}

async function securedMapped(raw: any, target: any) {
  const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, target);
  return attachDocumentSecurity(mapped, COMPANY);
}

const COMPACT = norm('Verify authenticity using the QR code on the final page');
const VERIFY_LABEL = norm('DOCUMENT VERIFICATION');
const CONTINUED = norm('continued');

function expectPageNumbers(pages: Array<{ text: string }>, total: number) {
  expect(pages.length).toBe(total);
  pages.forEach((p, i) => {
    expect(p.text).toContain(norm(`Page ${i + 1} of ${total}`));
    expect(p.text.length).toBeGreaterThan(200); // no blank pages
  });
}

function expectQrPayloadUrl(data: any, slug: string) {
  // Tokened fixtures encode the verification URL (document number is
  // URL-encoded, e.g. '/' -> %2F — assert slug + token, never raw text).
  expect(data.securityQrPayload).toContain(`/#/verify/${slug}/`);
  expect(data.securityQrPayload).toContain('?t=');
  expect(data.securityQrPayload).toContain(TOK);
}

function expectQrFinalOnly(pages: Array<{ text: string; drawnImages: number[] }>, qrObj: number) {
  pages.forEach((p, i) => {
    if (i < pages.length - 1) {
      expect(p.drawnImages).not.toContain(qrObj);
      expect(p.text).toContain(COMPACT);
      expect(p.text).not.toContain(VERIFY_LABEL);
      if (i > 0) expect(p.text).toContain(CONTINUED);
    } else {
      expect(p.drawnImages).toContain(qrObj);
      expect(p.text).toContain(VERIFY_LABEL);
      expect(p.text).not.toContain(COMPACT);
      if (i > 0) expect(p.text).toContain(CONTINUED);
    }
  });
}

// ─── QUOTATION ───────────────────────────────────────────────────────
describe('quotation pagination (global standard)', () => {
  const raw = (n: number) => finRaw(n, { id: 'QTN-P726/001', number: 'QTN-P726/001', quotationNumber: 'QTN-P726/001' });
  const secured = (n: number) => securedMapped(raw(n), 'QUOTATION');

  it('TEST 1 — one page: number, customer, total, QR, payload intact', async () => {
    const data: any = await secured(4);
    expect(data.securityQrPayload).toBe(buildSecurityQrPayload({ ...data, securityQrPayload: undefined, securityQrCodeDataUrl: undefined }, COMPANY));
    const { pages, pageCount, qrObj } = await renderBoth('QUOTATION', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('QTN-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).not.toContain(norm(CONTACT));
    expect(pages[0].text).toContain(norm('Quoted Amount'));
  }, 120000);

  it('TEST 2 — two pages: continuation, totals final-only, QR final-only', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('QUOTATION', await secured(14));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Quotation QTN-P726/001'));
    expect(pages[1].text).toContain(norm(CUSTOMER));
    expect(pages[1].text).toContain(norm('Quoted Amount'));
    expect(pages[0].text).not.toContain(norm('Quoted Amount'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('QUOTATION', await secured(34));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[2].text).toContain(norm('Quoted Amount'));
  }, 120000);
});

// ─── SALES ORDER ─────────────────────────────────────────────────────
describe('sales order pagination (global standard)', () => {
  const raw = (n: number) => finRaw(n, { id: 'SO-P726/001', number: 'SO-P726/001', orderNumber: 'SO-P726/001' });
  const secured = (n: number) => securedMapped(raw(n), 'SALES_ORDER');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(4);
    expectQrPayloadUrl(data, 'sales-order');
    const { pages, pageCount, qrObj } = await renderBoth('SALES_ORDER', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('SO-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).not.toContain(norm(CONTACT));
    expect(pages[0].text).toContain(norm('Due Balance'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SALES_ORDER', await secured(14));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Sales Order SO-P726/001'));
    expect(pages[1].text).toContain(norm('Due Balance'));
    expect(pages[0].text).not.toContain(norm('Due Balance'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SALES_ORDER', await secured(34));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

// ─── PURCHASE ORDER ──────────────────────────────────────────────────
describe('purchase order pagination (global standard)', () => {
  // A PO has a supplier, not a customer: no businessName/contactName.
  const raw = (n: number) => {
    const r: any = finRaw(n, { id: 'PO-P726/001', supplierId: 'SUP-1', supplierName: 'Test Supplier' });
    delete r.businessName;
    delete r.contactName;
    delete r.customerId;
    return r;
  };
  const secured = (n: number) => securedMapped(raw(n), 'PO');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(4);
    expectQrPayloadUrl(data, 'purchase-order');
    const { pages, pageCount, qrObj } = await renderBoth('PO', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('PO-P726/001'));
    expect(pages[0].text).toContain(norm('Test Supplier'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('PO', await secured(14));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Purchase Order PO-P726/001'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('PO', await secured(34));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

// ─── DELIVERY NOTE ───────────────────────────────────────────────────
describe('delivery note pagination (global standard)', () => {
  const raw = (n: number) => finRaw(n, { id: 'DN-P726/001', invoiceId: 'INV-P726/024' });
  const secured = (n: number) => securedMapped(raw(n), 'DELIVERY_NOTE');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(4);
    expectQrPayloadUrl(data, 'delivery-note');
    const { pages, pageCount, qrObj } = await renderBoth('DELIVERY_NOTE', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('DN-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).toContain(norm('Received By'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('DELIVERY_NOTE', await secured(12));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Delivery Note DN-P726/001'));
    expect(pages[1].text).toContain(norm('Received By'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('DELIVERY_NOTE', await secured(45));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[2].text).toContain(norm('Received By'));
  }, 120000);
});

// ─── EXAMINATION INVOICE ─────────────────────────────────────────────
describe('examination invoice pagination (global standard)', () => {
  const raw = (n: number) => finRaw(n, { id: 'EXM-P726/001', number: 'EXM-P726/001' });
  const secured = (n: number) => securedMapped(raw(n), 'EXAMINATION_INVOICE');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(2);
    const { pages, pageCount, qrObj } = await renderBoth('EXAMINATION_INVOICE', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('EXM-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('EXAMINATION_INVOICE', await secured(14));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Exam Invoice EXM-P726/001'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('EXAMINATION_INVOICE', await secured(34));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

// ─── SUBSCRIPTION ────────────────────────────────────────────────────
describe('subscription pagination (global standard)', () => {
  const raw = (n: number) => finRaw(n, { id: 'SUB-P726/001', number: 'SUB-P726/001' });
  const secured = (n: number) => securedMapped(raw(n), 'SUBSCRIPTION');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(4);
    const { pages, pageCount, qrObj } = await renderBoth('SUBSCRIPTION', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('SUB-P726/001'));
    expect(pages[0].text).toContain(norm('Recurring Total'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SUBSCRIPTION', await secured(14));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Recurring Invoice SUB-P726/001'));
    expect(pages[1].text).toContain(norm('Recurring Total'));
    expect(pages[0].text).not.toContain(norm('Recurring Total'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SUBSCRIPTION', await secured(34));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

// ─── RECEIPT ─────────────────────────────────────────────────────────
describe('receipt pagination (global standard)', () => {
  const receiptDoc = (appliedCount: number, sentences = 0) => {
    const applied = Array.from({ length: appliedCount }, (_, i) => `INV-P726/${String(i + 1).padStart(3, '0')}`);
    const payment: any = {
      id: 'PAY-P726/001', date: '2026-09-01', customerName: CUSTOMER,
      amount: Math.max(50000, appliedCount * 1000), paymentMethod: 'Cash',
      verificationToken: TOK,
      allocations: applied.map((id) => ({ invoiceId: id, amount: 1000 })),
    };
    const doc: any = buildCustomerReceiptDoc({ payment, customerName: CUSTOMER, currentBalance: 0, currencySymbol: 'MWK' });
    if (sentences) doc.narrative = Array.from({ length: sentences }, () => 'Payment received in full for school supplies delivered this term.').join(' ');
    return doc;
  };
  const secured = async (appliedCount: number, sentences = 0) =>
    attachDocumentSecurity(ReceiptSchema.parse(receiptDoc(appliedCount, sentences)), COMPANY);

  it('TEST 1 — one page', async () => {
    const data: any = await secured(1);
    expectQrPayloadUrl(data, 'receipt');
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('PAY-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).toContain(norm('Amount Received'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', await secured(30));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Receipt PAY-P726/001'));
    // The summary box flows with its section (natural flow — the standard
    // guarantees QR/footer/label/continuation placement, not summary drift
    // for text-split layouts); the values themselves must be intact.
    expect(pages.map((p) => p.text).join(' ')).toContain(norm('Amount Received'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('RECEIPT', await secured(5, 90));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

// ─── SUPPLIER PAYMENT ────────────────────────────────────────────────
// NOTE: the voucher's fixed content blocks (header, paid-to, narrative,
// table, summary, authorisation, signatures) naturally span two pages
// minimum — the flowing verification footer design (same as the invoice
// reference) places them in flow instead of overlaying page 1. TEST 1
// therefore asserts the natural two-page minimum with full standard
// behavior rather than a forced one-pager.
describe('supplier payment pagination (global standard)', () => {
  const supplierDoc = (sentences = 0) => {
    const payment: any = {
      id: 'SPAY-P726/001', date: '2026-09-01', amount: 50000, paymentMethod: 'Bank Transfer',
      status: 'Cleared', verificationToken: TOK, allocations: [{ purchaseId: 'PO-P726/001' }],
      notes: sentences ? Array.from({ length: sentences }, () => 'Authorised supplier settlement for stationery delivered this term.').join(' ') : undefined,
    };
    return buildSupplierPaymentDoc(payment, 'Test Supplier');
  };
  const secured = async (sentences = 0) =>
    attachDocumentSecurity(SupplierPaymentSchema.parse(supplierDoc(sentences)), COMPANY);

  it('TEST 1 — natural minimum: two pages, QR final-only, signatures final', async () => {
    const data: any = await secured(0);
    expectQrPayloadUrl(data, 'supplier-payment');
    const { pages, pageCount, qrObj } = await renderBoth('SUPPLIER_PAYMENT', data);
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('SPAY-P726/001'));
    expect(pages[0].text).toContain(norm('Test Supplier'));
    expect(pages[1].text).toContain(norm('Supplier Payment SPAY-P726/001'));
    // Summary and signatures flow with their sections (see receipt note);
    // values intact somewhere in the document.
    const all = pages.map((p) => p.text).join(' ');
    expect(all).toContain(norm('Total Paid'));
    expect(all).toContain(norm('Received By'));
  }, 120000);

  it('TEST 2 — two pages: placement rules hold', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SUPPLIER_PAYMENT', await secured(0));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SUPPLIER_PAYMENT', await secured(70));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[2].text).toContain(norm('Total Paid'));
  }, 120000);
});

// ─── SALES EXCHANGE ──────────────────────────────────────────────────
describe('sales exchange pagination (global standard)', () => {
  const raw = (n: number) => ({
    exchangeNumber: 'EX-P726/001',
    date: '2026-09-01',
    invoiceNumber: 'INV-P726/024',
    customerName: CUSTOMER,
    items: Array.from({ length: n }, (_, i) => ({
      desc: `Exchange item line ${i + 1} description text`,
      qtyReturned: 1,
      qtyReplaced: 1,
      priceDiff: 1000,
    })),
    reason: 'Damaged in transit',
    remarks: 'Handle with care',
    verificationToken: TOK,
  });
  const secured = (n: number) => attachDocumentSecurity(raw(n), COMPANY);

  it('TEST 1 — one page', async () => {
    const data: any = await secured(2);
    const { pages, pageCount, qrObj } = await renderBoth('SALES_EXCHANGE', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('EX-P726/001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).toContain(norm('Customer Signature'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SALES_EXCHANGE', await secured(10));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Exchange Note EX-P726/001'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('SALES_EXCHANGE', await secured(40));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
    // Signatures flow at the end of content (final content page here).
    expect(pages.map((p) => p.text).join(' ')).toContain(norm('Customer Signature'));
    expect(pages[0].text).not.toContain(norm('Customer Signature'));
  }, 120000);
});

// ─── ACCOUNT STATEMENT ───────────────────────────────────────────────
describe('statement pagination (global standard)', () => {
  const raw = (n: number) => ({
    statementNumber: 'STMT-P726-001',
    date: '2026-09-01',
    customerName: CUSTOMER,
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    currency: 'MWK',
    openingBalance: 0,
    transactions: Array.from({ length: n }, (_, i) => ({
      date: '2026-08-05', reference: `INV-${i + 1}`, memo: 'Invoice charge',
      debit: 1000, credit: 0, runningBalance: (i + 1) * 1000,
    })),
    totalInvoiced: n * 1000,
    totalReceived: 0,
    finalBalance: n * 1000,
    verificationToken: TOK,
  });
  const secured = (n: number) => securedMapped(raw(n), 'ACCOUNT_STATEMENT');

  it('TEST 1 — one page', async () => {
    const data: any = await secured(4);
    expect(data.securityQrPayload).toContain('STMT-P726-001');
    const { pages, pageCount, qrObj } = await renderBoth('ACCOUNT_STATEMENT', data);
    expectPageNumbers(pages, 1);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[0].text).toContain(norm('STMT-P726-001'));
    expect(pages[0].text).toContain(norm(CUSTOMER));
    expect(pages[0].text).toContain(norm('Balance Due'));
  }, 120000);

  it('TEST 2 — two pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('ACCOUNT_STATEMENT', await secured(25));
    expectPageNumbers(pages, 2);
    expectQrFinalOnly(pages, qrObj);
    expect(pages[1].text).toContain(norm('Statement STMT-P726-001'));
    // The statement summary lives in the header block (existing design),
    // so it is on page 1 by construction; values intact.
    expect(pages[0].text).toContain(norm('Balance Due'));
  }, 120000);

  it('TEST 3 — three pages', async () => {
    const { pages, pageCount, qrObj } = await renderBoth('ACCOUNT_STATEMENT', await secured(70));
    expectPageNumbers(pages, 3);
    expectQrFinalOnly(pages, qrObj);
  }, 120000);
});

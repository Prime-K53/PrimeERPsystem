/**
 * pdfMapper.receipt.test.ts — server-side RECEIPT / SUPPLIER_PAYMENT mapping.
 *
 * The staff UI builds a receipt with buildCustomerReceiptDoc and hands it
 * straight to PrimeDocument, so the mapper was never exercised on receipts —
 * and it had no RECEIPT branch at all. Both server-side callers therefore
 * fell through to the logistics branch, whose zod schema strips every money
 * field, and printed "Amount Received K 0.00" / "Customer Name: N/A".
 *
 * Locks the two shapes that actually reach the server-side renderer:
 *   • the raw customer_payments row  (public QR download)
 *   • the portal-mapped receipt contract (customer portal)
 */
import { describe, expect, it } from 'vitest';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import type { ReceiptDoc, SupplierPaymentDoc } from '../../views/shared/components/PDF/schemas';

const CONFIG = { currencySymbol: 'K' };
const TOK = 'a'.repeat(64);

describe('pdfMapper RECEIPT — raw customer_payments row (public QR download)', () => {
  const rawRow = () => ({
    id: 'PAY-P726/501',
    date: '2026-10-08',
    customerName: 'Mankhamba LEA School',
    amount: 175000,
    paymentMethod: 'Cash',
    allocations: [
      { invoice_id: 'INV-P726/501', invoice_number: 'INV-P726/501', amount: 175000, total_amount: 175000 },
    ],
    verificationToken: TOK,
  });

  it('keeps every money and identity field that the logistics branch used to strip', () => {
    const mapped = mapToInvoiceData(rawRow(), CONFIG, 'RECEIPT') as ReceiptDoc;

    expect(mapped.receiptNumber).toBe('PAY-P726/501');
    expect(mapped.customerName).toBe('Mankhamba LEA School');
    expect(mapped.amountReceived).toBe(175000);
    expect(mapped.amountApplied).toBe(175000);
    expect(mapped.invoiceTotal).toBe(175000);
    expect(mapped.paymentMethod).toBe('Cash');
    expect(mapped.appliedInvoices).toEqual(['INV-P726/501']);
    expect(mapped.paymentStatus).toBe('PAID');
    expect(mapped.currentBalance).toBe(0);
  });

  it('composes the canonical acknowledgment note, so a download matches the ERP copy', () => {
    const mapped = mapToInvoiceData(rawRow(), CONFIG, 'RECEIPT') as ReceiptDoc;

    // Nothing owed → no balance sentence (never "Your account balance is K 0.00").
    expect(mapped.narrative).toBe(
      'Receipt acknowledgment for payment of K 175,000.00 received from Mankhamba LEA School'
    );
  });

  it('appends the account balance when one is actually owed', () => {
    const mapped = mapToInvoiceData(
      { ...rawRow(), currentBalance: 25000 },
      CONFIG,
      'RECEIPT'
    ) as ReceiptDoc;

    expect(mapped.narrative).toBe(
      'Receipt acknowledgment for payment of K 175,000.00 received from Mankhamba LEA School. Your account balance is K 25,000.00'
    );
  });

  it('formats a stored ISO date as dd/mm/yyyy instead of printing the raw timestamp', () => {
    const mapped = mapToInvoiceData(rawRow(), CONFIG, 'RECEIPT') as ReceiptDoc;
    expect(mapped.date).toBe('08/10/2026');
  });

  it('keeps a verification token so the receipt QR stays scannable', () => {
    const mapped = mapToInvoiceData(rawRow(), CONFIG, 'RECEIPT') as ReceiptDoc;
    expect(mapped.verificationToken).toBe(TOK);
    expect(mapped.documentType).toBe('receipt');
  });

  it('derives PARTIALLY PAID plus the outstanding balance from the allocation', () => {
    const mapped = mapToInvoiceData({
      ...rawRow(),
      amount: 70000,
      allocations: [{ invoice_id: 'INV-P726/031', amount: 70000, total_amount: 403000 }],
    }, CONFIG, 'RECEIPT') as ReceiptDoc;

    expect(mapped.paymentStatus).toBe('PARTIALLY PAID');
    expect(mapped.invoiceTotal).toBe(403000);
    expect(mapped.amountApplied).toBe(70000);
    expect(mapped.balanceDue).toBe(333000);
    // Line Total and Paid are different figures, never the same number twice.
    expect(mapped.invoiceTotal).not.toBe(mapped.amountApplied);
  });

  it('never throws when the allocation exceeds the tendered amount', () => {
    // calculateCustomerPaymentSnapshot rejects this state; a read-only render
    // of a historical record must still print instead of failing the download.
    const mapped = mapToInvoiceData({
      ...rawRow(),
      amount: 1000,
      allocations: [{ invoice_id: 'INV-A', amount: 5000, total_amount: 5000 }],
    }, CONFIG, 'RECEIPT') as ReceiptDoc;

    expect(mapped.amountReceived).toBe(1000);
    expect(mapped.amountApplied).toBe(5000);
    expect(mapped.paymentStatus).toBe('PAID');
  });

  it('excludes an unknown invoice from the totals instead of counting it as zero', () => {
    const mapped = mapToInvoiceData({
      ...rawRow(),
      allocations: [
        { invoice_id: 'INV-A', amount: 100, total_amount: 100 },
        { invoice_id: 'INV-HIDDEN', amount: 50, total_amount: null, missing_invoice: true },
      ],
    }, CONFIG, 'RECEIPT') as ReceiptDoc;

    expect(mapped.invoiceTotal).toBe(100);
    expect(mapped.amountApplied).toBe(150);
  });
});

describe('pdfMapper RECEIPT — portal-mapped contract passes through verbatim', () => {
  const portalMapped = () => ({
    receiptNumber: 'PAY-P726/502',
    date: '8/10/2026',
    customerName: 'Chigwenembe Primary School',
    amountReceived: 70000,
    amountApplied: 70000,
    paymentMethod: 'Cash',
    account: 'Cash Drawer',
    appliedInvoices: ['INV-P726/031'],
    invoiceTotal: 403000,
    paymentStatus: 'PARTIALLY PAID' as const,
    balanceDue: 333000,
    overpaymentAmount: 0,
    currentBalance: 25000,
  });

  it('never re-derives figures the portal already resolved', () => {
    const mapped = mapToInvoiceData(portalMapped(), CONFIG, 'RECEIPT') as ReceiptDoc;

    expect(mapped.amountReceived).toBe(70000);
    expect(mapped.amountApplied).toBe(70000);
    expect(mapped.invoiceTotal).toBe(403000);
    expect(mapped.balanceDue).toBe(333000);
    expect(mapped.currentBalance).toBe(25000);
    expect(mapped.account).toBe('Cash Drawer');
    expect(mapped.appliedInvoices).toEqual(['INV-P726/031']);
  });

  it('preserves an already display-formatted date (never re-parses the ambiguous dd/mm)', () => {
    const mapped = mapToInvoiceData(portalMapped(), CONFIG, 'RECEIPT') as ReceiptDoc;
    expect(mapped.date).toBe('8/10/2026');
  });

  it('keeps a stored note as authoritative over a regenerated one', () => {
    const mapped = mapToInvoiceData(
      { ...portalMapped(), narrative: 'Hand-authored settlement note.' },
      CONFIG,
      'RECEIPT'
    ) as ReceiptDoc;
    expect(mapped.narrative).toBe('Hand-authored settlement note.');
  });

  it('falls back to the canonical note when the portal record carries none', () => {
    const mapped = mapToInvoiceData(portalMapped(), CONFIG, 'RECEIPT') as ReceiptDoc;
    expect(mapped.narrative).toBe(
      'Receipt acknowledgment for payment of K 70,000.00 received from Chigwenembe Primary School. Your account balance is K 25,000.00'
    );
  });
});

describe('pdfMapper SUPPLIER_PAYMENT — publicly downloadable voucher', () => {
  it('keeps the money fields the logistics branch used to strip', () => {
    const mapped = mapToInvoiceData({
      id: 'SPAY-1',
      paymentNumber: 'SPAY-1',
      date: '2026-10-10',
      supplierName: 'Paper Supplier',
      amount: 25000,
      paymentMethod: 'Bank Transfer',
      status: 'Cleared',
      verificationToken: TOK,
      allocations: [{ purchase_id: 'PO-1', purchase_number: 'PO-P726/001' }],
    }, CONFIG, 'SUPPLIER_PAYMENT') as SupplierPaymentDoc;

    expect(mapped.paymentId).toBe('SPAY-1');
    expect(mapped.supplierName).toBe('Paper Supplier');
    expect(mapped.amountPaid).toBe(25000);
    expect(mapped.paymentMethod).toBe('Bank Transfer');
    expect(mapped.status).toBe('Cleared');
    expect(mapped.appliedInvoices).toEqual(['PO-P726/001']);
    expect(mapped.date).toBe('10/10/2026');
    expect(mapped.documentType).toBe('supplier_payment');
  });
});
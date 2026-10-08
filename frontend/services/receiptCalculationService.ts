import {
  CustomerPayment,
  CustomerReceiptSnapshot,
  ReceiptPaymentStatus,
  Sale,
  SupplierPayment
} from '../types';
import { roundMoney } from '../utils/roundingUtils';
import { DEFAULT_ACCOUNTS } from '../constants';

const EPSILON = 0.000001;

/**
 * Resolve a payment's `accountId` to a human-readable account name.
 *
 * The id is the canonical chart-of-accounts code (see ACCOUNT_IDS), so the
 * seed DEFAULT_ACCOUNTS list resolves it without any live-data dependency —
 * a receipt must still render offline. Returns '' when the payment carries no
 * account so the caller can omit the row rather than print a placeholder.
 */
export const resolvePaymentAccountName = (accountId?: string | null): string => {
  const code = String(accountId ?? '').trim();
  if (!code) return '';
  return String(
    DEFAULT_ACCOUNTS.find((a) => a.id === code || a.code === code)?.name || ''
  ).trim();
};

const round2 = roundMoney;

const toIsoDate = (date?: string): string => {
  if (!date) return new Date().toISOString();
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
};

/**
 * Render a stored date the way the receipt prints it (en-GB, dd/mm/yyyy).
 *
 * Exported because the PDF mapper normalizes the SAME field for receipts that
 * reach the server-side renderer as a raw `customer_payments` row: without it
 * a public QR download prints the raw ISO timestamp (2026-10-08) while the ERP
 * copy prints 08/10/2026, which reads as two different payments.
 */
export const formatReceiptDisplayDate = (date?: string): string => {
  const parsed = date ? new Date(date) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toLocaleDateString('en-GB');
  return parsed.toLocaleDateString('en-GB');
};

const toDisplayDate = formatReceiptDisplayDate;

export interface CustomerReceiptInvoiceInput {
  invoiceId: string;
  allocationAmount: number;
  outstandingAmount?: number;
}

export interface CalculateCustomerPaymentSnapshotInput {
  amountTendered: number;
  appliedInvoices: CustomerReceiptInvoiceInput[];
  excessHandling?: string;
  paymentPurpose?: CustomerReceiptSnapshot['paymentPurpose'];
  paymentDate?: string;
  customerName?: string;
}

const resolvePaymentStatus = (
  invoiceTotalAtPosting: number,
  amountApplied: number,
  walletDeposit: number
): ReceiptPaymentStatus => {
  if (invoiceTotalAtPosting <= EPSILON) {
    return walletDeposit > EPSILON ? 'Overpaid' : 'Paid';
  }
  if (walletDeposit > EPSILON) return 'Overpaid';
  if (amountApplied >= invoiceTotalAtPosting - EPSILON) return 'Paid';
  return 'Partial';
};

/** Maps the internal ReceiptPaymentStatus to the uppercase strings expected by the PDF ReceiptSchema. */
const toSchemaPaymentStatus = (
  status: ReceiptPaymentStatus | undefined
): 'PAID' | 'PARTIALLY PAID' | 'OVERPAID' | undefined => {  if (!status) return undefined;
  if (status === 'Paid') return 'PAID';
  if (status === 'Partial') return 'PARTIALLY PAID';
  if (status === 'Overpaid') return 'OVERPAID';
  // Passthrough if already in schema format
  const upper = status.toUpperCase() as string;
  if (upper === 'PAID' || upper === 'PARTIALLY PAID' || upper === 'OVERPAID') {
    return upper as 'PAID' | 'PARTIALLY PAID' | 'OVERPAID';
  }
  return undefined;
};

export interface ReceiptPaymentBadge {
  label: 'PAYMENT RECEIVED' | 'CANCELLED';
  color: string;
  borderColor: string;
}

export interface ReceiptBadgeInput {
  paymentStatus?: string;
  status?: string;
  isCancelled?: boolean;
  cancelled?: boolean;
}

/**
 * Canonical receipt (payment-record) badge.
 *
 * A receipt records the payment that was received — never the invoice's
 * settlement state. `paymentStatus` (PAID / PARTIALLY PAID / OVERPAID)
 * describes how much of the related invoice(s) is settled and must only
 * drive the Outstanding Balance / Wallet Credit rows, never the payment
 * label itself. The only payment-level states are recorded vs cancelled.
 *
 * Tones reuse the receipt's existing green/red accents; no new palette.
 */
export const resolveReceiptPaymentBadge = (
  input: ReceiptBadgeInput | null | undefined
): ReceiptPaymentBadge => {
  const cancelled =
    input?.isCancelled === true ||
    input?.cancelled === true ||
    ['cancelled', 'canceled', 'void', 'voided'].includes(
      String(input?.status ?? input?.paymentStatus ?? '').trim().toLowerCase()
    );
  if (cancelled) {
    return { label: 'CANCELLED', color: '#dc2626', borderColor: '#ef4444' };
  }
  return { label: 'PAYMENT RECEIVED', color: '#059669', borderColor: '#10b981' };
};

const inferPaymentPurpose = (
  inputPurpose: CustomerReceiptSnapshot['paymentPurpose'] | undefined,
  appliedCount: number,
  walletDeposit: number
): CustomerReceiptSnapshot['paymentPurpose'] => {
  if (inputPurpose) return inputPurpose;
  if (appliedCount > 0) return 'INVOICE_PAYMENT';
  if (walletDeposit > EPSILON) return 'WALLET_TOPUP';
  return 'UNALLOCATED_PAYMENT';
};

/**
 * THE canonical receipt acknowledgment sentence — the whole Notes Section.
 *
 * Deliberately carries ONLY what no other part of the receipt already prints:
 *
 *   "Receipt acknowledgment for payment of K 175,000.00 received from
 *    Mankhamba LEA School."
 *
 * …followed by the account balance ONLY when there is one to report:
 *
 *   "… received from Mankhamba LEA School. Your account balance is K 25,000.00"
 *
 * Everything that used to be repeated in the note is printed exactly once
 * elsewhere:
 *   • the payment date  → the header's Date row
 *   • the invoice/order references → the Reference row + Payment Details table
 *   • partial/overpaid state + wallet credit → the Status badge, the
 *     Outstanding Balance / Wallet Credit rows and the overpayment notice
 *   • the outstanding balance → the Outstanding Balance row; the account
 *     balance below is the customer's own ledger position, which is different
 *     information and is the one thing the reader actually needs.
 *
 * So the opening sentence is identical for every payment purpose and status —
 * a wallet top-up, a partial payment and a full payment all acknowledge the
 * same way, because the differences live in the table above them.
 *
 * The balance sentence is OPTIONAL, and it is the only conditional left. It is
 * printed only when a real, non-zero balance is known:
 *   • a settled account has nothing to report, and "Your account balance is
 *     K 0.00" on every receipt is noise that reads as a real figure;
 *   • "not known" (undefined / null / NaN) is not the same statement as
 *     "known to be zero" — but both correctly print nothing, because neither
 *     tells the reader anything.
 * The test is on the ROUNDED balance, so a sub-cent remainder that would print
 * as K 0.00 is suppressed rather than printed.
 *
 * Exported (not private) because the PDF mapper builds the SAME note for
 * receipts that reach the server-side renderer without one — a raw
 * customer_payments row, or a portal-mapped record. One wording, two callers;
 * if the ERP copy and the portal copy are to be indistinguishable, they must
 * not be able to drift apart.
 */
export const buildReceiptAcknowledgement = ({
  amount,
  customerName,
  currencySymbol,
  accountBalance,
  purpose = 'payment',
}: {
  amount: number;
  customerName: string;
  currencySymbol: string;
  /** Omitted from the sentence when absent or zero. */
  accountBalance?: number | null;
  purpose?: 'payment' | 'wallet top-up';
}): string => {
  const fmt = (v: number) => `${currencySymbol} ${round2(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const base = `Receipt acknowledgment for ${purpose} of ${fmt(amount)} received from ${customerName}`;
  const balance = accountBalance == null ? NaN : round2(accountBalance);

  return Number.isFinite(balance) && balance !== 0
    ? `${base}. Your account balance is ${fmt(balance)}`
    : base;
};

const buildNarrative = (
  snapshot: CustomerReceiptSnapshot,
  customerName: string,
  currencySymbol: string,
  currentBalance: number
): string => buildReceiptAcknowledgement({
  amount: snapshot.amountTendered,
  customerName,
  currencySymbol,
  accountBalance: currentBalance,
  purpose: snapshot.paymentPurpose === 'WALLET_TOPUP' ? 'wallet top-up' : 'payment',
});

export const calculateCustomerPaymentSnapshot = (
  input: CalculateCustomerPaymentSnapshotInput
): CustomerReceiptSnapshot => {
  const amountTendered = round2(input.amountTendered);
  const normalizedInvoices = (input.appliedInvoices || [])
    .map(invoice => ({
      invoiceId: invoice.invoiceId,
      allocationAmount: round2(invoice.allocationAmount),
      outstandingAmount: round2(invoice.outstandingAmount ?? invoice.allocationAmount)
    }))
    .filter(invoice => invoice.allocationAmount > 0);

  const amountApplied = round2(
    normalizedInvoices.reduce((sum, invoice) => sum + invoice.allocationAmount, 0)
  );
  const invoiceTotalAtPosting = round2(
    normalizedInvoices.reduce((sum, invoice) => sum + invoice.outstandingAmount, 0)
  );

  if (amountApplied - amountTendered > EPSILON) {
    throw new Error(
      `Invalid payment allocation: allocated amount (${amountApplied}) exceeds amount tendered (${amountTendered}).`
    );
  }

  const unapplied = round2(Math.max(0, amountTendered - amountApplied));
  const shouldWalletDeposit = input.excessHandling === 'Wallet';
  const walletDeposit = round2(shouldWalletDeposit ? unapplied : 0);
  const changeGiven = round2(shouldWalletDeposit ? 0 : unapplied);
  const amountRetained = round2(amountTendered - changeGiven);
  const balanceDueAfterPayment = round2(Math.max(0, invoiceTotalAtPosting - amountApplied));
  const paymentStatus = resolvePaymentStatus(invoiceTotalAtPosting, amountApplied, walletDeposit);
  const purpose = inferPaymentPurpose(input.paymentPurpose, normalizedInvoices.length, walletDeposit);

  return {
    generatedAt: toIsoDate(input.paymentDate),
    paymentPurpose: purpose,
    amountTendered,
    amountApplied,
    changeGiven,
    walletDeposit,
    amountRetained,
    invoiceTotalAtPosting,
    balanceDueAfterPayment,
    appliedInvoices: normalizedInvoices.map(invoice => invoice.invoiceId),
    paymentStatus,
    confidence: 'exact',
    calculationVersion: 1
  };
};

export interface BuildCustomerReceiptDocInput {
  payment: CustomerPayment;
  customerName?: string;
  snapshot?: CustomerReceiptSnapshot;
  currencySymbol?: string;
  currentBalance?: number;
  appliedOrders?: string[];
}

export const buildCustomerReceiptDoc = ({
  payment,
  customerName,
  snapshot,
  currencySymbol = '$',
  currentBalance = 0,
  appliedOrders
}: BuildCustomerReceiptDocInput) => {
  const snap = snapshot || payment.receiptSnapshot || calculateCustomerPaymentSnapshot({
    amountTendered: payment.amount,
    appliedInvoices: (payment.allocations || []).map((allocation: any) => ({
      invoiceId: allocation.invoiceId,
      allocationAmount: allocation.amount
    })),
    excessHandling: payment.excessHandling,
    paymentDate: payment.date
  });

  const resolvedCustomerName = customerName || payment.customerName || 'Customer';
  const resolvedOrders = appliedOrders || [];
  const orderAmount = resolvedOrders.length > 0
    ? round2((payment as any).orderAllocations?.reduce((s: number, a: any) => s + (a.amount || 0), 0) || 0)
    : 0;

  let adjustedSnap = snap;
  if (orderAmount > 0) {
    const newAmountApplied = round2(snap.amountApplied + orderAmount);
    const unapplied = round2(Math.max(0, snap.amountTendered - newAmountApplied));
    const shouldWalletDeposit = (snap as any).paymentPurpose === 'WALLET_TOPUP' || payment.excessHandling === 'Wallet';
    const newWalletDeposit = round2(shouldWalletDeposit ? unapplied : 0);
    const newChangeGiven = round2(shouldWalletDeposit ? 0 : unapplied);
    const newAmountRetained = round2(snap.amountTendered - newChangeGiven);
    adjustedSnap = {
      ...snap,
      amountApplied: newAmountApplied,
      changeGiven: newChangeGiven,
      amountRetained: newAmountRetained,
      walletDeposit: newWalletDeposit
    };
  }

  const narrative = snap.narrative || buildNarrative(adjustedSnap, resolvedCustomerName, currencySymbol, currentBalance);

  return {
    // Verification identity: carried from the stored payment record so the
    // receipt QR encodes the public verification URL. Untokened (legacy)
    // records omit it and keep the legacy QR payload.
    documentType: 'receipt',
    ...((payment as any)?.verificationToken ? { verificationToken: String((payment as any).verificationToken) } : {}),
    receiptNumber: payment.id,
    date: toDisplayDate(payment.date),
    customerName: resolvedCustomerName,
    amountReceived: round2(adjustedSnap.amountTendered),
    amountApplied: round2(adjustedSnap.amountApplied),
    amountRetained: round2(adjustedSnap.amountRetained),
    changeGiven: round2(adjustedSnap.changeGiven),
    paymentMethod: payment.paymentMethod,
    // Payment account the money landed in (Cash Drawer / bank / mobile money).
    // Resolved from the stored accountId; '' renders no Account row.
    account: resolvePaymentAccountName(payment.accountId),
    appliedInvoices: adjustedSnap.appliedInvoices,
    appliedOrders: resolvedOrders,
    invoiceTotal: round2(adjustedSnap.invoiceTotalAtPosting),
    paymentStatus: toSchemaPaymentStatus(adjustedSnap.paymentStatus),
    balanceDue: round2(adjustedSnap.balanceDueAfterPayment),
    overpaymentAmount: round2(adjustedSnap.walletDeposit),
    walletDeposit: round2(adjustedSnap.walletDeposit),
    narrative,
    currentBalance: round2(currentBalance),
    calculationVersion: adjustedSnap.calculationVersion || 1
  };
};

export interface BuildPosReceiptDocInput {
  sale: Sale;
  cashierName: string;
  customerName?: string;
  itemDescriptionFormatter?: (item: any) => string;
  footerMessage?: string;
  companyConfig?: any;
  /**
   * Official receipt backing this POS receipt (the customerPayments REC row
   * created for the sale). When present, the POS QR encodes the existing
   * receipt verification URL (/verify/receipt/<number>?t=<token>) — no
   * second POS verification record is created.
   */
  receiptRef?: { receiptNumber: string; verificationToken?: string };
}

export const buildPosReceiptDoc = ({
  sale,
  cashierName,
  customerName,
  itemDescriptionFormatter,
  footerMessage,
  companyConfig,
  receiptRef
}: BuildPosReceiptDocInput) => {
  const totalPaid = round2(
    (sale.payments && sale.payments.length > 0)
      ? sale.payments.reduce((sum: number, payment: any) => sum + Number(payment.amount || 0), 0)
      : Number(sale.cash_tendered || sale.totalAmount || 0)
  );
  const totalAmount = round2(Number(sale.totalAmount || 0));
  const discount = round2(Number(sale.discount || 0));
  const subtotal = round2(Number(sale.subtotal ?? totalAmount + discount));
  const changeGiven = round2(Number(sale.change_due ?? Math.max(totalPaid - totalAmount, 0)));
  const tax = round2(Number(sale.taxTotal || sale.taxDetails?.reduce((s: any, t: any) => s + (t.taxAmount || 0), 0) || 0));

  return {
    // Verification identity: the linked official receipt record's stable
    // token + explicit type, so the POS QR encodes the public verification
    // URL. POS sales without a linked receipt yet omit the token and keep
    // the legacy QR payload (backward compatible).
    documentType: 'receipt',
    ...(receiptRef?.verificationToken ? { verificationToken: String(receiptRef.verificationToken) } : {}),
    receiptNumber: receiptRef?.receiptNumber || sale.receiptNumber || sale.id,
    date: toDisplayDate(sale.date),
    cashierName: cashierName || 'Cashier',
    customerName: customerName || sale.customerName || 'Walk-in Customer',
    items: (sale.items || []).map((item: any) => {
      const qty = Number(item.quantity || 0);
      const originalPrice = round2(Number(item.price || item.unitPrice || 0));
      const itemDiscount = round2(Number(item.discount || 0));
      const discountedPrice = qty > 0 && itemDiscount > 0 ? round2((originalPrice * qty - itemDiscount) / qty) : originalPrice;
      const total = round2(qty * discountedPrice);
      // Preserve QP markers via passthrough so receipt desc can show pages.
      // Financial qty stays billable sheets; desc carries "50 pages @ K/sheet".
      return {
        ...(item && typeof item === 'object' ? item : {}),
        desc: itemDescriptionFormatter ? itemDescriptionFormatter(item) : (item.name || item.productName || 'Item'),
        qty,
        price: discountedPrice,
        total
      };
    }),
    subtotal,
    discount,
    tax,
    totalAmount,
    paymentMethod: sale.paymentMethod || 'Cash',
    amountTendered: totalPaid,
    changeGiven,
    payments: (sale.payments || []).map((payment: any) => ({
      method: payment.method,
      amount: round2(Number(payment.amount || 0)),
      accountId: payment.accountId
    })),
    footerMessage: footerMessage || companyConfig?.transactionSettings?.pos?.receiptFooter,
    companyInfo: {
      name: companyConfig?.companyName || 'Prime ERP',
      address: 'Along M5 Road Mtakataka',
      phone: companyConfig?.phone || '',
      email: companyConfig?.email || '',
      website: companyConfig?.website || '',
      footerMessage: footerMessage || companyConfig?.transactionSettings?.pos?.receiptFooter
    }
  };
};

export const buildSupplierPaymentDoc = (
  payment: SupplierPayment,
  supplierName: string
) => {
  const record = payment as any;
  return {
    // Verification identity: the stored payment's stable token + explicit
    // type + official payment number. Untokened records omit the token and
    // keep the legacy QR payload (backward compatible).
    documentType: 'supplier_payment',
    ...(record?.verificationToken ? { verificationToken: String(record.verificationToken) } : {}),
    paymentId: payment.id,
    // The ERP treats the payment record id as the official payment number;
    // an explicit paymentNumber (new records) takes precedence for display.
    paymentNumber: String(record?.paymentNumber || payment.id),
    date: toDisplayDate(payment.date),
    supplierName,
    amountPaid: round2(payment.amount),
    paymentMethod: payment.paymentMethod,
    status: String(record?.status || 'Cleared'),
    appliedInvoices: (payment.allocations || []).map((allocation: any) => allocation.purchaseId),
    narrative: payment.notes
  };
};

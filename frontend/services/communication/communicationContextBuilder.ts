/**
 * communicationContextBuilder.ts — SINGLE authoritative ERP-facts layer.
 *
 * All customer/invoice/balance/verification facts for the Communication
 * Center come from here. Reuses:
 *  - dbService (offline-first IndexedDB mirror)
 *  - customerLedger.getCustomerOutstanding (canonical balance)
 *  - utils/customerDisplay (businessName canonical identity)
 *  - utils/documentVerification.buildDocumentVerificationUrl (canonical URL)
 *  - CompanyConfig.paymentDetails (canonical payment info)
 *
 * Never calculates its own ledger math; never invents URLs or payments.
 */

import { dbService } from '../db';
import { getCustomerOutstanding } from '../customerLedger';
import { getCustomerDisplayName, getCustomerContactName } from '../../utils/customerDisplay';
import { buildDocumentVerificationUrl } from '../../utils/documentVerification';
import type {
  CommunicationContext,
  CommunicationPurposeId,
  CompanyFacts,
  CustomerFacts,
  DeliveryFacts,
  InvoiceFacts,
  OrderFacts,
  PaymentFacts,
  QuotationFacts,
} from './communicationTypes';
import { getPurpose } from './communicationTypes';

interface RawCustomer {
  id: string;
  businessName?: string | null;
  companyName?: string | null;
  name?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
}

interface RawPayment {
  id?: string;
  customerId?: string;
  customer_id?: string;
  date?: string;
  createdAt?: string;
  created_at?: string;
  amount?: number;
  amountApplied?: number;
  paymentMethod?: string;
  payment_method?: string;
  reference?: string;
  allocations?: Array<{ invoiceId?: string; invoice_id?: string; amount?: number }>;
}

interface RawQuotation {
  id: string;
  customerId?: string;
  customerName?: string;
  quotationNumber?: string;
  totalAmount?: number;
  total?: number;
  date?: string;
  createdAt?: string;
  created_at?: string;
  validUntil?: string;
  valid_until?: string;
  status?: string;
  items?: Array<{
    name?: string; productName?: string; description?: string; title?: string;
    quantity?: number; qty?: number; price?: number; unitPrice?: number; total?: number; lineTotal?: number;
  }>;
}

interface RawOrder {
  id: string;
  customerId?: string;
  customerName?: string;
  orderNumber?: string;
  total?: number;
  totalAmount?: number;
  status?: string;
  orderDate?: string;
  date?: string;
  createdAt?: string;
  created_at?: string;
  deliveryDate?: string;
}

interface RawShipment {
  id: string;
  orderId?: string;
  customerId?: string;
  customerName?: string;
  status?: string;
  trackingNumber?: string;
  estimatedDelivery?: string;
  actualArrival?: string;
  date?: string;
  createdAt?: string;
}

interface RawInvoice {
  id: string;
  customerId?: string;
  customerName?: string;
  invoiceNumber?: string;
  totalAmount?: number;
  total?: number;
  paidAmount?: number;
  paid_amount?: number;
  date?: string;
  createdAt?: string;
  created_at?: string;
  dueDate?: string;
  due_date?: string;
  status?: string;
  verificationToken?: string;
  verification_token?: string;
}

function readCompanyConfig(): { companyName: string; paymentDetails?: CompanyFacts['bankAccounts'] extends never ? never : unknown } & Record<string, unknown> {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('nexus_company_config') : null;
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { companyName: 'Prime ERP Company' } as unknown as ReturnType<typeof readCompanyConfig>;
}

export function buildCompanyFacts(): CompanyFacts {
  const cfg = readCompanyConfig() as {
    companyName?: string;
    paymentDetails?: {
      bankAccounts?: Array<{ bankName: string; accountName: string; accountNumber: string }>;
      mobileMoneyAccounts?: Array<{ network: string; accountName: string; phoneNumber: string }>;
    };
  };
  const bankAccounts = Array.isArray(cfg.paymentDetails?.bankAccounts) ? cfg.paymentDetails!.bankAccounts! : [];
  const mobileMoneyAccounts = Array.isArray(cfg.paymentDetails?.mobileMoneyAccounts)
    ? cfg.paymentDetails!.mobileMoneyAccounts!
    : [];
  const parts: string[] = [];
  for (const b of bankAccounts) {
    if (b.bankName && b.accountNumber) parts.push(`Bank: ${b.bankName} ${b.accountNumber}${b.accountName ? ` (${b.accountName})` : ''}`);
  }
  for (const m of mobileMoneyAccounts) {
    if (m.network && m.phoneNumber) parts.push(`${m.network}: ${m.phoneNumber}${m.accountName ? ` (${m.accountName})` : ''}`);
  }
  return {
    name: String(cfg.companyName || 'Prime ERP Company'),
    paymentMethodsSummary: parts.length > 0 ? parts.join('; ') : '',
    bankAccounts: bankAccounts.map((b) => ({ bankName: String(b.bankName || ''), accountName: String(b.accountName || ''), accountNumber: String(b.accountNumber || '') })),
    mobileMoneyAccounts: mobileMoneyAccounts.map((m) => ({ network: String(m.network || ''), accountName: String(m.accountName || ''), phoneNumber: String(m.phoneNumber || '') })),
  };
}

function toInvoiceFacts(inv: RawInvoice): InvoiceFacts {
  const total = Number(inv.totalAmount ?? inv.total ?? 0) || 0;
  const paid = Number(inv.paidAmount ?? inv.paid_amount ?? 0) || 0;
  const invoiceNumber = String(inv.invoiceNumber || inv.id || '').trim();
  const token = String(inv.verificationToken ?? inv.verification_token ?? '').trim() || null;
  const verificationUrl = token
    ? buildDocumentVerificationUrl({ documentType: 'invoice', documentNumber: invoiceNumber, verificationToken: token })
    : null;
  return {
    id: String(inv.id),
    invoiceNumber,
    date: (inv.date || inv.createdAt || inv.created_at || null) as string | null,
    dueDate: ((inv.dueDate || inv.due_date || null) as string | null),
    total: Math.round(total * 100) / 100,
    paid: Math.round(paid * 100) / 100,
    outstanding: Math.round(Math.max(0, total - paid) * 100) / 100,
    status: String(inv.status || ''),
    verificationToken: token,
    verificationUrl,
    hasDocument: true,
  };
}

function sortInvoicesDesc(invoices: RawInvoice[]): RawInvoice[] {
  return [...invoices].sort((a, b) => {
    const ta = new Date(a.date || a.createdAt || a.created_at || 0).getTime() || 0;
    const tb = new Date(b.date || b.createdAt || b.created_at || 0).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return String(b.id).localeCompare(String(a.id));
  });
}

function snapshotIdFor(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(0) + i + input.charCodeAt(i)) % 1000000007;
  }
  return `ctx-${Date.now().toString(36)}-${(hash >>> 0).toString(36)}`;
}

export interface BuildContextOptions {
  invoiceId?: string | null;
  invoicesOverride?: RawInvoice[];
  paymentsOverride?: Array<Record<string, unknown>>;
  openingBalanceOverride?: number;
}

export async function resolveCustomerFacts(customerId: string): Promise<{ customer: CustomerFacts; raw: RawCustomer }> {  const all = await dbService.getAll<RawCustomer>('customers');
  const found = all.find((c) => String(c.id) === String(customerId));
  if (!found) throw new Error(`Customer not found: ${customerId}`);
  const businessName = getCustomerDisplayName({
    businessName: (found as RawCustomer).businessName ?? null,
    companyName: (found as RawCustomer).companyName ?? null,
    legacyCustomerName: (found as RawCustomer).name ?? null,
  });
  const contactName = getCustomerContactName({ contactName: (found as RawCustomer).contactName ?? null });
  return {
    customer: {
      id: String(found.id),
      businessName: businessName || String(found.id),
      contactName,
      phone: found.phone ? String(found.phone) : null,
      email: found.email ? String(found.email) : null,
    },
    raw: found,
  };
}

/** Monotonic build marker so regenerated contexts invalidate in-flight async work. */
let contextSequence = 0;

function toMoney(value: unknown): number {
  return Number(value ?? 0) || 0;
}

function latestByDate<T>(rows: T[], pickDate: (row: T) => string | null | undefined): T[] {
  return [...rows].sort((a, b) => {
    const ta = new Date(pickDate(a) || 0).getTime() || 0;
    const tb = new Date(pickDate(b) || 0).getTime() || 0;
    if (tb !== ta) return tb - ta;
    return String((b as { id?: unknown }).id).localeCompare(String((a as { id?: unknown }).id));
  });
}

/** Invoice provider: full list + latest + explicitly chosen specific invoice. */
async function resolveInvoiceDomain(
  customerId: string,
  displayName: string,
  opts: BuildContextOptions,
  warnings: string[],
): Promise<{ invoices: InvoiceFacts[]; latestInvoice: InvoiceFacts | null; specificInvoice: InvoiceFacts | null }> {
  const allInvoices = opts.invoicesOverride ??
    (await dbService.getAll<RawInvoice>('invoices'));
  const mine = allInvoices.filter(
    (i) =>
      String(i.customerId || '') === String(customerId) ||
      (displayName && String(i.customerName || '').toLowerCase() === displayName.toLowerCase()),
  );
  const sorted = sortInvoicesDesc(mine);
  const invoices: InvoiceFacts[] = sorted.map(toInvoiceFacts);
  const latestInvoice = invoices.length > 0 ? invoices[0] : null;

  let specificInvoice: InvoiceFacts | null = null;
  if (opts.invoiceId) {
    const found = sorted.find((i) => String(i.id) === String(opts.invoiceId)) ||
      allInvoices.find((i) => String(i.id) === String(opts.invoiceId));
    if (!found) {
      warnings.push(`Invoice ${opts.invoiceId} was not found for this customer.`);
    } else {
      specificInvoice = toInvoiceFacts(found as RawInvoice);
    }
  }
  return { invoices, latestInvoice, specificInvoice };
}

/** Outstanding-balance provider (canonical ledger, never hand-rolled math). */
async function resolveOutstandingBalance(
  purpose: CommunicationPurposeId,
  customerId: string,
  displayName: string,
  opts: BuildContextOptions,
  warnings: string[],
): Promise<number | null> {
  void purpose;
  void displayName;
  try {
    if (opts.invoicesOverride || opts.paymentsOverride || opts.openingBalanceOverride !== undefined) {
      const { buildLedgerFromRecords } = await import('../customerLedger');
      const allInvoices = opts.invoicesOverride ??
        (await dbService.getAll<RawInvoice>('invoices'));
      const mine = allInvoices.filter(
        (i) =>
          String(i.customerId || '') === String(customerId) ||
          (displayName && String(i.customerName || '').toLowerCase() === displayName.toLowerCase()),
      );
      const payments = opts.paymentsOverride ?? [];
      const ledger = buildLedgerFromRecords({
        customerId,
        invoices: mine as unknown as Array<Record<string, unknown>>,
        payments: payments as Array<Record<string, unknown>>,
        openingBalance: opts.openingBalanceOverride ?? 0,
      });
      return ledger.outstandingBalance;
    }
    return await getCustomerOutstanding(customerId);
  } catch {
    warnings.push('Outstanding balance is currently unavailable.');
    return null;
  }
}

/** Payment/receipt provider: the single latest customer payment, fully resolved
 *  (receipt identifier + allocation targets). Deterministic — the AI never picks. */
async function resolveLastPayment(
  customerId: string,
  opts: BuildContextOptions,
  warnings: string[],
): Promise<PaymentFacts | null> {
  try {
    const payments = (opts.paymentsOverride as RawPayment[] | undefined) ??
      (await dbService.getAll<RawPayment>('customerPayments'));
    const mineP = (payments as RawPayment[]).filter(
      (p) => String(p.customerId || p.customer_id || '') === String(customerId),
    );
    const sorted = latestByDate(mineP, (p) => p.date || p.createdAt || p.created_at || null);
    const lp = sorted[0];
    if (!lp) {
      warnings.push('No recorded payment found for this customer.');
      return null;
    }
    const allocations = Array.isArray(lp.allocations) ? lp.allocations : [];
    const allocatedInvoiceIds = allocations
      .map((a) => String(a.invoiceId || a.invoice_id || '').trim())
      .filter(Boolean);
    let allocatedInvoiceNumbers: string[] = [];
    let allocatedTotal = 0;
    if (allocatedInvoiceIds.length > 0 || allocations.length > 0) {
      try {
        const allInvoices = await dbService.getAll<RawInvoice>('invoices');
        const byId = new Map(allInvoices.map((i) => [String(i.id), i]));
        allocatedInvoiceNumbers = allocatedInvoiceIds.map(
          (id) => String(byId.get(id)?.invoiceNumber || byId.get(id)?.id || id),
        );
        allocatedTotal = Math.round(allocations.reduce((s, a) => s + toMoney(a.amount), 0) * 100) / 100;
      } catch {
        allocatedInvoiceNumbers = allocatedInvoiceIds;
        allocatedTotal = Math.round(allocations.reduce((s, a) => s + toMoney(a.amount), 0) * 100) / 100;
      }
    }
    const reference = String(lp.reference || '').trim();
    return {
      id: String(lp.id || ''),
      receiptNumber: reference || String(lp.id || ''),
      date: (lp.date || lp.createdAt || lp.created_at || null) as string | null,
      amount: Math.round(toMoney(lp.amountApplied ?? lp.amount) * 100) / 100,
      method: lp.paymentMethod || lp.payment_method ? String(lp.paymentMethod || lp.payment_method) : null,
      allocatedInvoiceIds,
      allocatedInvoiceNumbers,
      allocatedTotal,
      remainingBalance: null,
    };
  } catch {
    warnings.push('Payment data is currently unavailable.');
    return null;
  }
}

const CLOSED_QUOTATION_STATUSES = new Set(['converted', 'cancelled', 'rejected', 'expired']);

/** Quotation provider: latest OPEN quotation preferred, latest overall as fallback. */
async function resolveQuotation(
  customerId: string,
  displayName: string,
  warnings: string[],
): Promise<QuotationFacts | null> {
  try {
    const quotes = await dbService.getAll<RawQuotation>('quotations');
    const mineQ = quotes.filter(
      (q) => String(q.customerId || '') === String(customerId) ||
        (displayName && String(q.customerName || '').toLowerCase() === displayName.toLowerCase()),
    );
    if (mineQ.length === 0) {
      warnings.push('No quotation found for this customer.');
      return null;
    }
    const byDate = latestByDate(mineQ, (q) => q.date || q.createdAt || q.created_at || null);
    const open = byDate.filter((q) => !CLOSED_QUOTATION_STATUSES.has(String(q.status || '').trim().toLowerCase()));
    const q = (open.length > 0 ? open : byDate)[0];
    const items = (Array.isArray(q.items) ? q.items : []).slice(0, 8).map((it) => {
      const quantity = Math.floor(toMoney(it.quantity ?? it.qty));
      const price = Math.round(toMoney(it.price ?? it.unitPrice) * 100) / 100;
      const total = Math.round(Number(it.total ?? it.lineTotal ?? quantity * price) * 100) / 100;
      return {
        name: String(it.name || it.productName || it.description || it.title || 'Item'),
        quantity,
        price,
        total: Number.isFinite(total) ? total : 0,
      };
    });
    return {
      id: String(q.id),
      number: String(q.quotationNumber || q.id),
      date: (q.date || q.createdAt || q.created_at || null) as string | null,
      total: Math.round(toMoney(q.totalAmount ?? q.total) * 100) / 100,
      validUntil: q.validUntil || q.valid_until || null,
      status: String(q.status || ''),
      items,
    };
  } catch {
    warnings.push('Quotation data is currently unavailable.');
    return null;
  }
}

/** Sales-order provider: latest order by date (id order as tiebreak only). */
async function resolveOrder(
  customerId: string,
  displayName: string,
  warnings: string[],
): Promise<OrderFacts | null> {
  try {
    const orders = await dbService.getAll<RawOrder>('orders');
    const mineO = orders.filter(
      (o) => String(o.customerId || '') === String(customerId) ||
        (displayName && String(o.customerName || '').toLowerCase() === displayName.toLowerCase()),
    );
    if (mineO.length === 0) {
      warnings.push('No sales order found for this customer.');
      return null;
    }
    const o = latestByDate(mineO, (r) => r.orderDate || r.date || r.createdAt || r.created_at || null)[0];
    return {
      id: String(o.id),
      number: String(o.orderNumber || o.id),
      date: (o.orderDate || o.date || o.createdAt || o.created_at || null) as string | null,
      total: Math.round(toMoney(o.totalAmount ?? o.total) * 100) / 100,
      status: String(o.status || ''),
      deliveryDate: o.deliveryDate || null,
    };
  } catch {
    warnings.push('Order data is currently unavailable.');
    return null;
  }
}

/** Delivery provider: customer-scoped, preferring the shipment linked to the
 *  focal order. Never returns another customer's shipment. */
async function resolveDelivery(
  customerId: string,
  displayName: string,
  focalOrderId: string | null,
  warnings: string[],
): Promise<DeliveryFacts | null> {
  try {
    const shipments = await dbService.getAll<RawShipment>('shipments');
    const mineS = shipments.filter(
      (s) => String(s.customerId || '') === String(customerId) ||
        (displayName && String(s.customerName || '').toLowerCase() === displayName.toLowerCase()),
    );
    if (mineS.length === 0) {
      warnings.push('No delivery/shipment found for this customer.');
      return null;
    }
    const byDate = latestByDate(mineS, (s) => s.actualArrival || s.estimatedDelivery || s.date || s.createdAt || null);
    const linked = focalOrderId ? byDate.find((s) => String(s.orderId || '') === String(focalOrderId)) : undefined;
    const s = linked || byDate[0];
    if (focalOrderId && String(s.orderId || '') !== '' && String(s.orderId) !== String(focalOrderId)) {
      warnings.push('The latest shipment is not linked to the selected order.');
    }
    return {
      id: String(s.id),
      orderId: s.orderId ? String(s.orderId) : null,
      status: String(s.status || ''),
      trackingNumber: s.trackingNumber || null,
      estimatedDelivery: s.estimatedDelivery || s.actualArrival || null,
    };
  } catch {
    warnings.push('Delivery data is currently unavailable.');
    return null;
  }
}

export async function buildCommunicationContext(
  purpose: CommunicationPurposeId,
  customerId: string,
  opts: BuildContextOptions = {},
): Promise<CommunicationContext> {
  // Explicit purpose-to-provider mapping: the selected purpose alone decides
  // which ERP providers run. Anything not in the purpose's allow-list is
  // never resolved and (defense in depth) stripped before return, so invoice
  // facts can never leak into a quotation/order/delivery/payment context.
  const allowed = new Set(getPurpose(purpose).allowedFacts);
  const warnings: string[] = [];
  const { customer, raw } = await resolveCustomerFacts(customerId);
  const company = buildCompanyFacts();
  const displayName = getCustomerDisplayName({
    businessName: raw.businessName ?? null,
    companyName: raw.companyName ?? null,
    legacyCustomerName: raw.name ?? null,
  });

  const wantsInvoices =
    allowed.has('invoices') || allowed.has('latestInvoice') || allowed.has('specificInvoice');

  let invoices: InvoiceFacts[] = [];
  let latestInvoice: InvoiceFacts | null = null;
  let specificInvoice: InvoiceFacts | null = null;
  if (wantsInvoices) {
    const resolved = await resolveInvoiceDomain(customerId, displayName, opts, warnings);
    if (allowed.has('invoices')) invoices = resolved.invoices;
    if (allowed.has('latestInvoice')) latestInvoice = resolved.latestInvoice;
    if (allowed.has('specificInvoice')) specificInvoice = resolved.specificInvoice;
  }

  let outstandingBalance: number | null = null;
  if (allowed.has('outstandingBalance')) {
    outstandingBalance = await resolveOutstandingBalance(
      purpose, customerId, displayName, opts, warnings,
    );
  }

  let lastPayment: PaymentFacts | null = null;
  if (allowed.has('lastPayment')) {
    lastPayment = await resolveLastPayment(customerId, opts, warnings);
    if (lastPayment && allowed.has('outstandingBalance') && outstandingBalance !== null) {
      lastPayment = { ...lastPayment, remainingBalance: outstandingBalance };
    }
  }

  let quotation: QuotationFacts | null = null;
  if (allowed.has('quotation')) {
    quotation = await resolveQuotation(customerId, displayName, warnings);
  }

  let order: OrderFacts | null = null;
  if (allowed.has('order')) {
    order = await resolveOrder(customerId, displayName, warnings);
  }

  let delivery: DeliveryFacts | null = null;
  if (allowed.has('delivery')) {
    delivery = await resolveDelivery(customerId, displayName, order?.id || null, warnings);
  }

  // Purpose guardrails / honesty warnings.
  if (purpose === 'send_latest_invoice' && !latestInvoice) {
    warnings.push('No invoice found for this customer — cannot send latest invoice.');
  }
  if (purpose === 'send_specific_invoice' && !specificInvoice) {
    warnings.push('Select a specific invoice to continue.');
  }
  if ((purpose === 'payment_reminder' || purpose === 'outstanding_balance') && outstandingBalance === 0) {
    warnings.push('This customer has no outstanding balance.');
  }
  const focal: InvoiceFacts | null = specificInvoice || latestInvoice;
  if ((purpose === 'send_latest_invoice' || purpose === 'send_specific_invoice') && focal && !focal.verificationUrl) {
    warnings.push('Verification URL is unavailable for this invoice (missing token or base URL). The message will note this instead of guessing a link.');
  }

  const snapshotInput = JSON.stringify({
    purpose, customer, company: company.name, outstandingBalance,
    latest: latestInvoice, specific: specificInvoice, lastPayment, quotation, order, delivery,
  });
  const ctx: CommunicationContext = {
    purpose,
    customer,
    company,
    outstandingBalance,
    invoices: invoices.slice(0, 10),
    latestInvoice,
    specificInvoice,
    lastPayment,
    quotation,
    order,
    delivery,
    warnings,
    snapshotId: snapshotIdFor(snapshotInput),
    fetchedAt: new Date().toISOString(),
    contextVersion: ++contextSequence,
  };
  return ctx;
}

/** Re-fetch facts for SEND-time revalidation; returns fresh context. */
export async function revalidateCommunicationContext(
  purpose: CommunicationPurposeId,
  customerId: string,
  opts: BuildContextOptions = {},
): Promise<CommunicationContext> {
  return buildCommunicationContext(purpose, customerId, opts);
}

/** Compare two contexts to detect stale financial facts. */
export function diffFinancialFacts(
  before: CommunicationContext,
  after: CommunicationContext,
): { changed: boolean; messages: string[] } {
  const messages: string[] = [];
  if ((before.outstandingBalance ?? null) !== (after.outstandingBalance ?? null)) {
    messages.push(`Outstanding balance changed from ${formatMoney(before.outstandingBalance)} to ${formatMoney(after.outstandingBalance)}.`);
  }
  const bInv = before.specificInvoice || before.latestInvoice;
  const aInv = after.specificInvoice || after.latestInvoice;
  if ((bInv?.id || null) !== (aInv?.id || null)) {
    messages.push(`Focal invoice changed from ${bInv?.invoiceNumber || 'none'} to ${aInv?.invoiceNumber || 'none'}.`);
  } else if (bInv && aInv) {
    if (bInv.invoiceNumber !== aInv.invoiceNumber) messages.push(`Invoice number changed from ${bInv.invoiceNumber} to ${aInv.invoiceNumber}.`);
    if (bInv.total !== aInv.total) messages.push(`Invoice total changed from ${formatMoney(bInv.total)} to ${formatMoney(aInv.total)}.`);
    if (bInv.paid !== aInv.paid) messages.push(`Amount paid changed from ${formatMoney(bInv.paid)} to ${formatMoney(aInv.paid)}.`);
    if (bInv.outstanding !== aInv.outstanding) messages.push(`Invoice outstanding changed from ${formatMoney(bInv.outstanding)} to ${formatMoney(aInv.outstanding)}.`);
    if ((bInv.verificationUrl || null) !== (aInv.verificationUrl || null)) messages.push('Verification token/URL changed.');
    if (bInv.status !== aInv.status) messages.push(`Invoice status changed from ${bInv.status || 'unknown'} to ${aInv.status || 'unknown'}.`);
  }
  // Purpose focal documents: identity or key-figure changes also invalidate.
  if ((before.quotation?.id || null) !== (after.quotation?.id || null)) {
    messages.push(`Focal quotation changed from ${before.quotation?.number || 'none'} to ${after.quotation?.number || 'none'}.`);
  } else if (before.quotation && after.quotation && before.quotation.total !== after.quotation.total) {
    messages.push(`Quotation total changed from ${formatMoney(before.quotation.total)} to ${formatMoney(after.quotation.total)}.`);
  }
  if ((before.order?.id || null) !== (after.order?.id || null)) {
    messages.push(`Focal order changed from ${before.order?.number || 'none'} to ${after.order?.number || 'none'}.`);
  } else if (before.order && after.order && (before.order.total !== after.order.total || before.order.status !== after.order.status)) {
    messages.push(`Order ${before.order.number} changed (total ${formatMoney(before.order.total)} → ${formatMoney(after.order.total)}, status ${before.order.status || 'unknown'} → ${after.order.status || 'unknown'}).`);
  }
  if ((before.delivery?.id || null) !== (after.delivery?.id || null)) {
    messages.push(`Focal delivery changed from ${before.delivery?.id || 'none'} to ${after.delivery?.id || 'none'}.`);
  } else if (before.delivery && after.delivery && before.delivery.status !== after.delivery.status) {
    messages.push(`Delivery status changed from ${before.delivery.status || 'unknown'} to ${after.delivery.status || 'unknown'}.`);
  }
  if ((before.lastPayment?.id || null) !== (after.lastPayment?.id || null)) {
    messages.push(`Focal payment changed from ${before.lastPayment?.receiptNumber || 'none'} to ${after.lastPayment?.receiptNumber || 'none'}.`);
  } else if (before.lastPayment && after.lastPayment && before.lastPayment.amount !== after.lastPayment.amount) {
    messages.push(`Payment amount changed from ${formatMoney(before.lastPayment.amount)} to ${formatMoney(after.lastPayment.amount)}.`);
  }
  return { changed: messages.length > 0, messages };
}

export function formatMoney(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  return `K${Number(value).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

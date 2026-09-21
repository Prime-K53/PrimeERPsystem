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
  InvoiceFacts,
} from './communicationTypes';

interface RawCustomer {
  id: string;
  businessName?: string | null;
  companyName?: string | null;
  name?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
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

export async function resolveCustomerFacts(customerId: string): Promise<{ customer: CustomerFacts; raw: RawCustomer }> {
  const all = await dbService.getAll<RawCustomer>('customers');
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

export async function buildCommunicationContext(
  purpose: CommunicationPurposeId,
  customerId: string,
  opts: BuildContextOptions = {},
): Promise<CommunicationContext> {
  const warnings: string[] = [];
  const { customer, raw } = await resolveCustomerFacts(customerId);
  const company = buildCompanyFacts();

  const allInvoices = opts.invoicesOverride ??
    (await dbService.getAll<RawInvoice>('invoices'));
  const displayName = getCustomerDisplayName({
    businessName: raw.businessName ?? null,
    companyName: raw.companyName ?? null,
    legacyCustomerName: raw.name ?? null,
  });
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

  let outstandingBalance: number | null = null;
  if (['payment_reminder', 'outstanding_balance', 'send_latest_invoice', 'send_specific_invoice'].includes(purpose)) {
    try {
      if (opts.invoicesOverride || opts.paymentsOverride || opts.openingBalanceOverride !== undefined) {
        const { buildLedgerFromRecords } = await import('../customerLedger');
        const payments = opts.paymentsOverride ?? [];
        const ledger = buildLedgerFromRecords({
          customerId,
          invoices: mine as unknown as Array<Record<string, unknown>>,
          payments: payments as Array<Record<string, unknown>>,
          openingBalance: opts.openingBalanceOverride ?? 0,
        });
        outstandingBalance = ledger.outstandingBalance;
      } else {
        outstandingBalance = await getCustomerOutstanding(customerId);
      }
    } catch {
      warnings.push('Outstanding balance is currently unavailable.');
      outstandingBalance = null;
    }
  }

  let lastPayment: CommunicationContext['lastPayment'] = null;
  if (purpose === 'payment_confirmation') {
    try {
      const payments = (opts.paymentsOverride as Array<{
        id?: string; date?: string; createdAt?: string; amount?: number; amountApplied?: number; paymentMethod?: string; payment_method?: string;
      }>) ?? (await dbService.getAll<Record<string, unknown>>('customerPayments'));
      const mineP = (payments as Array<Record<string, unknown>>).filter(
        (p) => String((p as { customerId?: string }).customerId || '') === String(customerId),
      );
      mineP.sort((a, b) => {
        const ta = new Date(String((a as { date?: string }).date || (a as { createdAt?: string }).createdAt || 0)).getTime() || 0;
        const tb = new Date(String((b as { date?: string }).date || (b as { createdAt?: string }).createdAt || 0)).getTime() || 0;
        return tb - ta;
      });
      const lp = mineP[0] as { id?: string; date?: string; createdAt?: string; amount?: number; amountApplied?: number; paymentMethod?: string; payment_method?: string } | undefined;
      if (lp) {
        lastPayment = {
          id: String(lp.id || ''),
          date: (lp.date || lp.createdAt || null) as string | null,
          amount: Number(lp.amountApplied ?? lp.amount ?? 0) || 0,
          method: lp.paymentMethod || lp.payment_method ? String(lp.paymentMethod || lp.payment_method) : null,
        };
      } else {
        warnings.push('No recorded payment found for this customer.');
      }
    } catch {
      warnings.push('Payment data is currently unavailable.');
    }
  }

  let quotation: CommunicationContext['quotation'] = null;
  if (purpose === 'quotation_followup') {
    try {
      const quotes = await dbService.getAll<{
        id: string; customerId?: string; customerName?: string; quotationNumber?: string;
        totalAmount?: number; total?: number; validUntil?: string; status?: string; createdAt?: string;
      }>('quotations');
      const mineQ = quotes.filter(
        (q) => String(q.customerId || '') === String(customerId) ||
          (displayName && String(q.customerName || '').toLowerCase() === displayName.toLowerCase()),
      );
      mineQ.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
      const q = mineQ[0];
      if (q) {
        quotation = {
          id: String(q.id),
          number: String(q.quotationNumber || q.id),
          total: Number(q.totalAmount ?? q.total ?? 0) || 0,
          validUntil: q.validUntil || null,
          status: String(q.status || ''),
        };
      } else {
        warnings.push('No quotation found for this customer.');
      }
    } catch {
      warnings.push('Quotation data is currently unavailable.');
    }
  }

  let order: CommunicationContext['order'] = null;
  let delivery: CommunicationContext['delivery'] = null;
  if (purpose === 'order_update' || purpose === 'delivery_notification') {
    try {
      const orders = await dbService.getAll<{
        id: string; customerId?: string; total?: number; totalAmount?: number; status?: string; deliveryDate?: string;
      }>('orders');
      const mineO = orders.filter((o) => String(o.customerId || '') === String(customerId));
      mineO.sort((a, b) => String(b.id).localeCompare(String(a.id)));
      const o = mineO[0];
      if (o) order = { id: String(o.id), total: Number(o.totalAmount ?? o.total ?? 0) || 0, status: String(o.status || ''), deliveryDate: o.deliveryDate || null };
      else warnings.push('No sales order found for this customer.');
    } catch {
      warnings.push('Order data is currently unavailable.');
    }
    if (purpose === 'delivery_notification') {
      try {
        const shipments = await dbService.getAll<{
          id: string; orderId?: string; status?: string; trackingNumber?: string; estimatedDelivery?: string;
        }>('shipments');
        const s = shipments[0];
        if (s) {
          delivery = {
            id: String(s.id),
            status: String(s.status || ''),
            trackingNumber: s.trackingNumber || null,
            estimatedDelivery: s.estimatedDelivery || null,
          };
        } else {
          warnings.push('No delivery/shipment found.');
        }
      } catch {
        warnings.push('Delivery data is currently unavailable.');
      }
    }
  }

  if ((purpose === 'send_latest_invoice') && !latestInvoice) {
    warnings.push('No invoice found for this customer — cannot send latest invoice.');
  }
  if ((purpose === 'send_specific_invoice') && !specificInvoice) {
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
    if (bInv.total !== aInv.total) messages.push(`Invoice total changed from ${formatMoney(bInv.total)} to ${formatMoney(aInv.total)}.`);
    if (bInv.paid !== aInv.paid) messages.push(`Amount paid changed from ${formatMoney(bInv.paid)} to ${formatMoney(aInv.paid)}.`);
    if (bInv.outstanding !== aInv.outstanding) messages.push(`Invoice outstanding changed from ${formatMoney(bInv.outstanding)} to ${formatMoney(aInv.outstanding)}.`);
    if ((bInv.verificationUrl || null) !== (aInv.verificationUrl || null)) messages.push('Verification URL changed.');
  }
  return { changed: messages.length > 0, messages };
}

export function formatMoney(value: number | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'unavailable';
  return `K${Number(value).toLocaleString('en-ZM', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

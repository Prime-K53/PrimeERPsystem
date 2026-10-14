import { dbService } from '../services/db';
import { transactionService } from '../services/transactionService';
import { buildPosReceiptDoc } from '../services/receiptCalculationService';
import { PosReceiptSchema } from '../views/shared/components/PDF/schemas';
import { isPosMirrorInvoiceRecord } from './invoiceIdentity';

export interface PosReceiptUser {
  id?: string;
  name?: string;
  fullName?: string;
  username?: string;
}

export interface PosReceiptFromInvoiceContext {
  companyConfig?: any;
  /** Users for cashier-name resolution (sale.cashierId -> name). */
  allUsers?: PosReceiptUser[] | null;
  /** Fallback cashier display name (current user). */
  currentUserName?: string;
  /** Receipt footer override (defaults to the POS receipt footer setting). */
  footerMessage?: string;
  /** Item description formatter (defaults to the plain item name). */
  itemDescriptionFormatter?: (item: any) => string;
  /**
   * Test seam / override: resolve the linked POS sale for an invoice
   * reference. Defaults to the local `sales` store lookup.
   */
  findSale?: (reference: string) => Promise<any | null>;
  /**
   * Test seam / override: resolve the official receipt backing a POS sale
   * (the customerPayments REC row created for it). Defaults to the same
   * reference lookup the POS module uses, so the QR encodes the existing
   * receipt verification URL.
   */
  findReceiptRef?: (
    saleId: string,
    fallbackNumber: string
  ) => Promise<{ receiptNumber: string; verificationToken?: string }>;
}

const defaultFindSale = async (reference: string): Promise<any | null> => {
  try {
    return (await dbService.get<any>('sales', reference)) || null;
  } catch {
    return null;
  }
};

/**
 * Official receipt backing a POS sale (mirror of the POS module's own
 * resolver): the first customerPayments REC row with reference === saleId.
 * Best-effort — falls back to the sale number with no token, keeping the
 * legacy QR payload.
 */
export const resolvePosReceiptRefForSale = async (
  saleId: string,
  fallbackNumber: string
): Promise<{ receiptNumber: string; verificationToken?: string }> => {
  const fallback = { receiptNumber: fallbackNumber };
  try {
    const payments = await dbService.getAll<any>('customerPayments');
    const linked = (payments || [])
      .filter((p: any) => String(p?.reference || '') === String(saleId))
      .sort((a: any, b: any) => String(a.id).localeCompare(String(b.id)));
    if (linked.length === 0) return fallback;
    const primary = linked[0];
    if (!primary.verificationToken) {
      try {
        const { token } = await transactionService.getOrIssueDocumentVerificationToken(
          'customerPayments',
          String(primary.id)
        );
        if (token) return { receiptNumber: String(primary.id), verificationToken: String(token) };
      } catch {
        /* offline-safe: legacy payload until synced */
      }
    }
    return primary.verificationToken
      ? { receiptNumber: String(primary.id), verificationToken: String(primary.verificationToken) }
      : { receiptNumber: String(primary.id) };
  } catch {
    return fallback;
  }
};

const toNum = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * Sale-shaped view of an invoice record, used ONLY when the linked POS sale
 * itself is unavailable (offline gap, pruned history). Field mapping mirrors
 * what buildPosReceiptDoc reads: quantity/price/name per line, subtotal,
 * discount, taxTotal, totalAmount, paymentMethod/payments.
 */
const synthesizeSaleFromInvoice = (invoice: Record<string, unknown>): Record<string, unknown> => {
  const totalAmount = toNum(
    invoice.totalAmount ?? invoice.total ?? invoice.subtotal ?? invoice.grandTotal,
    0
  );
  const paymentMethod = String(invoice.paymentMethod || 'Cash');
  const paidAmount = toNum(invoice.paidAmount ?? invoice.amountPaid ?? totalAmount, totalAmount);
  const rawItems = Array.isArray(invoice.items) ? invoice.items : [];
  // Receipt payments require { method: string, amount: number }; invoice
  // payment traces (if any) rarely match, so normalize defensively.
  const rawPayments = Array.isArray(invoice.payments) && invoice.payments.length > 0
    ? invoice.payments
    : [{ method: paymentMethod, amount: paidAmount }];
  const payments = rawPayments
    .filter((p: any) => p && typeof p === 'object')
    .map((p: any) => ({
      method: String(p.method || p.paymentMethod || paymentMethod),
      amount: toNum(p.amount, 0),
      ...(p.accountId ? { accountId: String(p.accountId) } : {}),
    }));
  return {
    id: String(invoice.id ?? invoice.invoiceNumber ?? ''),
    receiptNumber: String(invoice.invoiceNumber || invoice.id || ''),
    date: String(invoice.date || new Date().toISOString()),
    customerId: invoice.customerId,
    customerName: String(invoice.customerName || 'Walk-in Customer'),
    items: rawItems.map((line: any) => ({
      ...(line && typeof line === 'object' ? line : {}),
      name:
        line?.name ??
        line?.productName ??
        line?.product_name ??
        line?.itemName ??
        line?.item_name ??
        line?.title ??
        line?.desc ??
        line?.description ??
        'Item',
      quantity: toNum(line?.quantity ?? line?.qty, 0),
      price: toNum(line?.price ?? line?.unitPrice ?? line?.cost, 0),
    })),
    subtotal: toNum(invoice.subtotal, totalAmount),
    discount: toNum(invoice.discount, 0),
    taxTotal: toNum((invoice as Record<string, unknown>).taxTotal ?? invoice.tax, 0),
    totalAmount,
    paymentMethod,
    payments,
    cash_tendered: paidAmount,
  };
};

const resolveCashierName = (
  sale: Record<string, unknown>,
  ctx: PosReceiptFromInvoiceContext
): string => {
  const cashierId = String(sale?.cashierId || '').trim();
  if (cashierId && Array.isArray(ctx.allUsers)) {
    const cashierUser = ctx.allUsers.find((u) => String(u?.id || '') === cashierId);
    const name =
      cashierUser?.name || cashierUser?.fullName || cashierUser?.username || '';
    if (String(name || '').trim()) return String(name).trim();
  }
  const saleCashier = String((sale as Record<string, unknown>)?.cashierName || '').trim();
  if (saleCashier) return saleCashier;
  if (String(ctx.currentUserName || '').trim()) return String(ctx.currentUserName).trim();
  return 'Cashier';
};

/**
 * Build a validated POS receipt document for an invoice record that mirrors
 * a POS sale. Returns null when the record is NOT a POS-mirror invoice, so
 * callers keep ordinary (and examination) invoices on their existing paths.
 *
 * Fidelity order: linked POS sale (reference -> sales store) first, then a
 * sale-shaped synthesis of the invoice itself. The result is
 * PosReceiptSchema-parsed (unsecured — callers attach security exactly like
 * the POS module does), ready for PrimeDocument type 'POS_RECEIPT'.
 */
export const buildPosReceiptDocFromInvoiceRecord = async (
  invoice: Record<string, unknown> | null | undefined,
  ctx: PosReceiptFromInvoiceContext = {}
): Promise<Record<string, unknown> | null> => {
  if (!invoice || typeof invoice !== 'object') return null;

  const findSale = ctx.findSale || defaultFindSale;
  const findReceiptRef = ctx.findReceiptRef || resolvePosReceiptRefForSale;

  const reference = String((invoice as Record<string, unknown>).reference || '').trim();
  let sale: Record<string, unknown> | null = null;
  if (reference) {
    try {
      sale = (await findSale(reference)) || null;
    } catch {
      sale = null;
    }
  }

  // Static POS markers classify without the sale; otherwise only a found
  // linked sale proves POS provenance (mirrors the SalesAudit split — a
  // bare reference to a non-sale record is never enough).
  if (!isPosMirrorInvoiceRecord(invoice, sale ? [String((sale as Record<string, unknown>).id || reference)] : null)) {
    if (!sale) return null;
  }

  const saleLike = (sale || synthesizeSaleFromInvoice(invoice)) as Record<string, unknown>;
  const saleId = String(saleLike.id || reference || invoice.id || '');
  const receiptRef = await findReceiptRef(
    saleId,
    String(saleLike.receiptNumber || (invoice as Record<string, unknown>).invoiceNumber || saleId)
  );

  const receipt = buildPosReceiptDoc({
    sale: saleLike as never,
    receiptRef,
    cashierName: resolveCashierName(saleLike, ctx),
    customerName: String(saleLike.customerName || invoice.customerName || 'Walk-in Customer'),
    itemDescriptionFormatter: ctx.itemDescriptionFormatter,
    footerMessage:
      ctx.footerMessage || ctx.companyConfig?.transactionSettings?.pos?.receiptFooter,
    companyConfig: ctx.companyConfig,
  });

  // Required-field pre-checks mirroring the POS module (receiptNumber /
  // date / non-empty lines) — the schema itself permits empty arrays, and
  // not every caller re-validates (e.g. direct download).
  if (!receipt.receiptNumber) throw new Error('POS receipt validation failed: Missing receiptNumber');
  if (!receipt.date) throw new Error('POS receipt validation failed: Missing date');
  if (!receipt.items || receipt.items.length === 0) {
    throw new Error('POS receipt validation failed: Missing or empty items array');
  }
  const parsed = PosReceiptSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new Error(
      `POS receipt validation failed: ${parsed.error.issues[0]?.message || 'Invalid POS receipt payload'}`
    );
  }
  return parsed.data as Record<string, unknown>;
};

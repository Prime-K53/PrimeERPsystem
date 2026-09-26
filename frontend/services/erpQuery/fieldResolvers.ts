/**
 * fieldResolvers.ts — Canonical ERP field readers for the query layer.
 *
 * Reuses the ERP's authoritative helpers instead of inventing parallel logic:
 *   - utils/customerDisplay.getCustomerDisplayName (businessName identity)
 *   - utils/inventoryNormalization (stock-bearing rules, qty × cost valuation)
 *   - services/customerLedger (invoice inclusion, payment credit, balances)
 *   - utils/paymentUtils.getPurchaseTotal (purchase total semantics)
 *
 * Stable IDs are always preferred; display-name matching is a fallback only
 * and never merges distinct IDs.
 */

import { getCustomerDisplayName } from '../../utils/customerDisplay';
import {
  resolveInventoryQuantity,
  resolveInventoryCostPerUnit,
  isInventoryBearingItem,
} from '../../utils/inventoryNormalization';
import {
  invoiceTotal as ledgerInvoiceTotal,
  paymentCredit as ledgerPaymentCredit,
  isInvoiceIncluded as ledgerInvoiceIncluded,
  isPaymentIncluded as ledgerPaymentIncluded,
  buildLedgerFromRecords,
} from '../customerLedger';
import type { ErpEntityId } from './erpQueryTypes';

// ── Primitives ───────────────────────────────────────────────────────────────

export function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function round2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100;
}

/** First defined (non-null/undefined/empty-string) candidate. */
export function first<T>(...candidates: Array<T | null | undefined>): T | undefined {
  for (const c of candidates) {
    if (c !== null && c !== undefined && String(c) !== '') return c as T;
  }
  return undefined;
}

export function normLower(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

export function normName(v: unknown): string {
  return String(v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── Customer identity (canonical: businessName) ─────────────────────────────

export function customerDisplayOf(record: Record<string, unknown>): string {
  return getCustomerDisplayName({
    businessName: (record.businessName ?? record.business_name ?? null) as string | null,
    companyName: (record.companyName ?? record.company_name ?? null) as string | null,
    legacyCustomerName: (record.customerName ?? record.name ?? null) as string | null,
  });
}

export function customerContactOf(record: Record<string, unknown>): string {
  const v = record.contactName ?? record.contact_name ?? '';
  return String(v ?? '').trim();
}

export function customerIdOf(record: Record<string, unknown>): string {
  return String(record.customerId ?? record.customer_id ?? record.id ?? '').trim();
}

/** Stable customer match: id first, canonical businessName second. */
export function matchesCustomer(record: Record<string, unknown>, opts: { id?: string; name?: string }): boolean {
  if (opts.id) {
    const rid = String(record.customerId ?? record.customer_id ?? record.id ?? '').trim().toLowerCase();
    if (rid && rid === opts.id.trim().toLowerCase()) return true;
    // Also allow direct id match on the customer record itself
    const selfId = String(record.id ?? '').trim().toLowerCase();
    if (selfId && selfId === opts.id.trim().toLowerCase()) return true;
  }
  if (opts.name) {
    const want = normName(opts.name);
    if (!want) return false;
    const display = normName(customerDisplayOf(record));
    const legacy = normName(record.customerName ?? record.name);
    if (display && (display === want || display.includes(want) || want.includes(display))) return true;
    if (legacy && (legacy === want || legacy.includes(want))) return true;
  }
  return false;
}

// ── Product / item identity (stable productId first) ────────────────────────

export function productIdOf(record: Record<string, unknown>): string {
  return String(record.productId ?? record.product_id ?? record.itemId ?? record.item_id ?? record.id ?? '').trim();
}

export function productNameOf(record: Record<string, unknown>): string {
  const v = first(record.productName, record.itemName, record.name, record.description, record.title);
  return String(v ?? '').trim();
}

export function matchesProduct(record: Record<string, unknown>, opts: { id?: string; name?: string }): boolean {
  if (opts.id) {
    const pid = productIdOf(record).toLowerCase();
    if (pid && pid === opts.id.trim().toLowerCase()) return true;
  }
  if (opts.name) {
    const want = normName(opts.name);
    if (!want) return false;
    const name = normName(productNameOf(record));
    if (name && (name === want || name.includes(want) || want.includes(name))) return true;
    const sku = normName(record.sku);
    if (sku && (sku === want || sku.includes(want))) return true;
  }
  return false;
}

// ── Supplier identity ───────────────────────────────────────────────────────

export function supplierIdOf(record: Record<string, unknown>): string {
  return String(record.supplierId ?? record.supplier_id ?? record.id ?? '').trim();
}

export function supplierNameOf(record: Record<string, unknown>): string {
  const v = first(record.supplierName, record.supplier_name, record.name, record.vendor, record.vendor_name);
  return String(v ?? '').trim();
}

export function matchesSupplier(record: Record<string, unknown>, opts: { id?: string; name?: string }): boolean {
  if (opts.id) {
    const sid = supplierIdOf(record).toLowerCase();
    if (sid && sid === opts.id.trim().toLowerCase()) return true;
  }
  if (opts.name) {
    const want = normName(opts.name);
    if (!want) return false;
    const name = normName(supplierNameOf(record));
    if (name && (name === want || name.includes(want) || want.includes(name))) return true;
  }
  return false;
}

// ── Financial readers (authoritative) ───────────────────────────────────────

export function getInvoiceTotal(inv: Record<string, unknown>): number {
  return ledgerInvoiceTotal(inv as Record<string, unknown>);
}

export function getInvoicePaid(inv: Record<string, unknown>): number {
  return toNum(first(inv.paidAmount, (inv as Record<string, unknown>).paid_amount, (inv as Record<string, unknown>).paid, 0));
}

export function getInvoiceOutstanding(inv: Record<string, unknown>): number {
  return Math.max(0, round2(getInvoiceTotal(inv) - getInvoicePaid(inv)));
}

const UNPAID_STATUSES = new Set(['unpaid', 'partial', 'partially paid', 'overdue', 'pending']);

export function isUnpaidInvoice(inv: Record<string, unknown>): boolean {
  if (!ledgerInvoiceIncluded(inv as Record<string, unknown>)) return false;
  const status = normLower(inv.status);
  if (status === 'paid') return false;
  if (getInvoiceOutstanding(inv) <= 0) return false;
  // Missing status counts as posted; treat positive outstanding as unpaid.
  if (!status) return true;
  return UNPAID_STATUSES.has(status) || (!['draft', 'cancelled', 'void', 'voided', 'credit_note'].includes(status));
}

export function getPaymentAmount(pay: Record<string, unknown>): number {
  const direct = toNum(first(pay.amount, pay.total, pay.totalAmount, 0));
  return direct;
}

/** Authoritative settlement credit for one payment (allocation-aware). */
export function getPaymentCredit(pay: Record<string, unknown>): number {
  try {
    return ledgerPaymentCredit(pay as Record<string, unknown>);
  } catch {
    return getPaymentAmount(pay);
  }
}

export function isIncludedPayment(pay: Record<string, unknown>): boolean {
  try {
    return ledgerPaymentIncluded(pay as Record<string, unknown>);
  } catch {
    return !['cancelled', 'voided'].includes(normLower(pay.status));
  }
}

export function paymentMethodOf(pay: Record<string, unknown>): string {
  const v = first(pay.paymentMethod, pay.payment_method, pay.method);
  return String(v ?? '').trim();
}

/** Purchase total semantics (totalAmount preferred, total fallback). */
export function getPurchaseTotal(p: Record<string, unknown>): number {
  const t = first(p.totalAmount, p.total_amount, p.total);
  return toNum(t, 0);
}

// ── Inventory readers (authoritative) ───────────────────────────────────────

export function inventoryQtyOf(item: Record<string, unknown>): number {
  try {
    return resolveInventoryQuantity(item);
  } catch {
    return toNum(first(item.stock, item.quantity, 0));
  }
}

export function inventoryCostOf(item: Record<string, unknown>): number {
  try {
    return resolveInventoryCostPerUnit(item);
  } catch {
    return toNum(first(item.cost, item.cost_price, item.costPrice, item.cost_per_unit, 0));
  }
}

export function inventoryValueOf(item: Record<string, unknown>): number {
  return round2(inventoryQtyOf(item) * inventoryCostOf(item));
}

export function isStockBearing(item: Record<string, unknown>): boolean {
  try {
    return isInventoryBearingItem(item);
  } catch {
    const t = normLower(first(item.type, item.classification, ''));
    if (t.includes('service')) return false;
    return t.includes('raw') || t.includes('material') || t.includes('stationery') || t.includes('consumable');
  }
}

export function reorderPointOf(item: Record<string, unknown>): number {
  return toNum(first(item.reorderPoint, item.minStockLevel, item.reorderLevel, item.minStock, 0));
}

export function isLowStock(item: Record<string, unknown>): boolean {
  if (!isStockBearing(item)) return false;
  return inventoryQtyOf(item) <= reorderPointOf(item);
}

// ── Line-item flattening (orders / invoices / quotations / sales / purchases) ─

export interface FlatLine {
  id: string;
  parentId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  subtotal: number;
  parentDate: string | null;
  customerId: string;
  customerName: string;
  parentStatus: string;
}

function lineUnitPrice(line: Record<string, unknown>): number {
  return toNum(first(line.unitPrice, line.price, line.unit_price, line.cost, 0));
}

function lineQuantity(line: Record<string, unknown>): number {
  return toNum(first(line.quantity, line.qty, 0));
}

function lineSubtotal(line: Record<string, unknown>): number {
  const explicit = first(line.subtotal, line.lineTotalNet, line.lineTotal, line.total);
  if (explicit !== undefined && Number.isFinite(Number(explicit)) && Number(explicit) !== 0) return toNum(explicit);
  return round2(lineQuantity(line) * lineUnitPrice(line));
}

function parentDateOf(parent: Record<string, unknown>): string | null {
  const v = first(parent.date, parent.orderDate, parent.order_date, parent.createdAt, parent.created_at);
  return v ? String(v) : null;
}

export function flattenLines(
  parents: readonly unknown[],
  opts: { parentIdField: string; dateLabel: string },
): FlatLine[] {
  const out: FlatLine[] = [];
  for (const p of parents) {
    const parent = p as Record<string, unknown>;
    const pid = String(parent.id ?? '').trim();
    const items = Array.isArray(parent.items) ? parent.items : [];
    const pDate = parentDateOf(parent);
    const custId = String(parent.customerId ?? parent.customer_id ?? '').trim();
    const custName = String(parent.customerName ?? parent.customer_name ?? parent.name ?? '').trim();
    const pStatus = String(parent.status ?? '').trim();
    for (const raw of items) {
      const line = raw as Record<string, unknown>;
      const qty = lineQuantity(line);
      const unit = lineUnitPrice(line);
      out.push({
        id: String(line.id ?? `${pid}:${productIdOf(line) || productNameOf(line)}`),
        parentId: pid,
        productId: productIdOf(line),
        productName: productNameOf(line) || 'Unknown item',
        quantity: qty,
        unitPrice: unit,
        subtotal: lineSubtotal(line),
        parentDate: pDate,
        customerId: custId,
        customerName: custName,
        parentStatus: pStatus,
      });
    }
  }
  void opts;
  return out;
}

// ── Customer outstanding via the canonical ledger ───────────────────────────

export function computeOutstandingByCustomer(
  customers: readonly unknown[],
  invoices: readonly unknown[],
  payments: readonly unknown[],
): Map<string, { customerId: string; displayName: string; outstanding: number; invoiced: number; paid: number }> {
  const byId = new Map<string, { customerId: string; displayName: string; outstanding: number; invoiced: number; paid: number }>();
  const idToDisplay = new Map<string, string>();
  for (const c of customers) {
    const rec = c as Record<string, unknown>;
    const id = String(rec.id ?? '').trim();
    if (!id) continue;
    const display = customerDisplayOf(rec) || id;
    idToDisplay.set(id, display);
    if (!byId.has(id)) byId.set(id, { customerId: id, displayName: display, outstanding: 0, invoiced: 0, paid: 0 });
  }
  // Include customers that only appear on transactions (walk-in / legacy rows).
  const ensure = (id: string, display: string) => {
    const key = id || `name:${normName(display)}`;
    if (!byId.has(key)) byId.set(key, { customerId: id, displayName: display || id || 'Unknown', outstanding: 0, invoiced: 0, paid: 0 });
    return byId.get(key)!;
  };
  // Group invoices/payments per customer id (stable id first, name fallback).
  const invoiceGroups = new Map<string, Array<Record<string, unknown>>>();
  const paymentGroups = new Map<string, Array<Record<string, unknown>>>();
  const keyFor = (r: Record<string, unknown>): string => {
    const id = String(r.customerId ?? r.customer_id ?? '').trim();
    if (id) return `id:${id}`;
    return `name:${normName(customerDisplayOf(r) || String(r.customerName ?? ''))}`;
  };
  for (const i of invoices) {
    const r = i as Record<string, unknown>;
    const k = keyFor(r);
    if (!invoiceGroups.has(k)) invoiceGroups.set(k, []);
    invoiceGroups.get(k)!.push(r);
  }
  for (const p of payments) {
    const r = p as Record<string, unknown>;
    const k = keyFor(r);
    if (!paymentGroups.has(k)) paymentGroups.set(k, []);
    paymentGroups.get(k)!.push(r);
  }
  const allKeys = new Set([...invoiceGroups.keys(), ...paymentGroups.keys()]);
  for (const k of allKeys) {
    const isId = k.startsWith('id:');
    const rawId = isId ? k.slice(3) : '';
    const sample = (invoiceGroups.get(k) || paymentGroups.get(k) || [])[0] as Record<string, unknown> | undefined;
    const display = (rawId && idToDisplay.get(rawId)) || (sample ? customerDisplayOf(sample) || String(sample.customerName ?? '') : '') || rawId || 'Unknown';
    const ledger = buildLedgerFromRecords({
      customerId: rawId || display,
      invoices: (invoiceGroups.get(k) || []) as Array<Record<string, unknown>>,
      payments: (paymentGroups.get(k) || []) as Array<Record<string, unknown>>,
      openingBalance: 0,
    });
    const entry = ensure(rawId, display);
    entry.outstanding = ledger.outstandingBalance;
    entry.invoiced = round2(ledger.transactions.filter((t) => t.type === 'invoice').reduce((s, t) => s + t.debit, 0));
    entry.paid = round2(ledger.transactions.filter((t) => t.type === 'payment').reduce((s, t) => s + t.credit, 0));
  }
  return byId;
}

// ── Canonical row normalisation (one place, used by the executor) ───────────

export function dateMonthOf(value: unknown): string {
  const d = new Date(String(value ?? ''));
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Normalise one raw record to canonical readable fields for `entity`.
 * Never mutates the input. Unknown fields are dropped (allowlist).
 */
export function normalizeRecord(entity: ErpEntityId, raw: unknown): Record<string, unknown> {
  const r = (raw || {}) as Record<string, unknown>;
  switch (entity) {
    case 'orders':
      return {
        id: String(r.id ?? ''),
        orderNumber: String(r.orderNumber ?? r.order_number ?? r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: first(r.date, r.orderDate, r.order_date, r.createdAt, r.created_at) ? String(first(r.date, r.orderDate, r.order_date, r.createdAt, r.created_at)) : null,
        orderDate: first(r.orderDate, r.date, r.createdAt) ? String(first(r.orderDate, r.date, r.createdAt)) : null,
        status: String(r.status ?? ''),
        paymentStatus: String(r.paymentStatus ?? r.payment_status ?? ''),
        invoiceStatus: String(r.invoiceStatus ?? r.invoice_status ?? ''),
        totalAmount: toNum(first(r.totalAmount, r.total_amount, r.total, 0)),
        subtotal: toNum(first(r.subtotal, r.totalAmount, r.total, 0)),
        paidAmount: toNum(first(r.paidAmount, r.paid_amount, 0)),
        remainingBalance: toNum(first(r.remainingBalance, r.remaining_balance, 0)),
        itemCount: Array.isArray(r.items) ? r.items.length : toNum(r.itemCount, 0),
        dateMonth: dateMonthOf(first(r.date, r.orderDate)),
        _raw: r,
      };
    case 'invoices':
      return {
        id: String(r.id ?? ''),
        invoiceNumber: String(r.invoiceNumber ?? r.invoice_number ?? r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: r.date ? String(r.date) : r.createdAt ? String(r.createdAt) : null,
        dueDate: (r.dueDate ?? r.due_date) ? String(r.dueDate ?? r.due_date) : null,
        status: String(r.status ?? ''),
        totalAmount: getInvoiceTotal(r),
        paidAmount: getInvoicePaid(r),
        outstanding: getInvoiceOutstanding(r),
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        dateMonth: dateMonthOf(r.date),
        _raw: r,
      };
    case 'customer_payments':
      return {
        id: String(r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: r.date ? String(r.date) : null,
        amount: getPaymentAmount(r),
        paymentMethod: paymentMethodOf(r),
        reference: String(r.reference ?? ''),
        status: String(r.status ?? ''),
        allocatedTotal: toNum(first((() => { try { return getPaymentCredit(r); } catch { return 0; } })(), 0)),
        invoiceId: Array.isArray(r.allocations) && r.allocations.length > 0 ? String((r.allocations[0] as Record<string, unknown>).invoiceId ?? (r.allocations[0] as Record<string, unknown>).invoice_id ?? '') : '',
        dateMonth: dateMonthOf(r.date),
        _raw: r,
      };
    case 'customers':
      return {
        id: String(r.id ?? ''),
        businessName: customerDisplayOf(r),
        contactName: customerContactOf(r),
        email: String(r.email ?? ''),
        phone: String(r.phone ?? ''),
        status: String(r.status ?? 'active'),
        _raw: r,
      };
    case 'suppliers':
      return {
        id: String(r.id ?? ''),
        name: supplierNameOf(r),
        email: String(r.email ?? ''),
        phone: String(r.phone ?? ''),
        status: String(r.status ?? 'active'),
        _raw: r,
      };
    case 'products':
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        sku: String(r.sku ?? ''),
        type: String(r.type ?? r.classification ?? ''),
        category: String(r.category ?? ''),
        stock: inventoryQtyOf(r),
        cost: inventoryCostOf(r),
        price: toNum(first(r.price, r.sellingPrice, r.selling_price, 0)),
        reorderPoint: reorderPointOf(r),
        inventoryValue: inventoryValueOf(r),
        isStockBearing: isStockBearing(r),
        _raw: r,
      };
    case 'quotations':
      return {
        id: String(r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: r.date ? String(r.date) : null,
        validUntil: (r.validUntil ?? r.valid_until) ? String(r.validUntil ?? r.valid_until) : null,
        status: String(r.status ?? ''),
        totalAmount: toNum(first(r.totalAmount, r.total_amount, r.total, 0)),
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        dateMonth: dateMonthOf(r.date),
        _raw: r,
      };
    case 'purchases':
      return {
        id: String(r.id ?? ''),
        supplierId: supplierIdOf(r),
        supplierName: supplierNameOf(r),
        date: r.date ? String(r.date) : null,
        status: String(r.status ?? ''),
        totalAmount: getPurchaseTotal(r),
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        dateMonth: dateMonthOf(r.date),
        _raw: r,
      };
    case 'expenses':
    case 'income':
      return {
        id: String(r.id ?? ''),
        date: r.date ? String(r.date) : (r.expense_date ? String(r.expense_date) : r.income_date ? String(r.income_date) : null),
        description: String(r.description ?? ''),
        category: String(r.category ?? ''),
        amount: toNum(first(r.amount, r.totalAmount, r.total, 0)),
        paymentMethod: String(r.paymentMethod ?? r.payment_method ?? ''),
        status: String(r.status ?? ''),
        dateMonth: dateMonthOf(first(r.date, r.expense_date, r.income_date)),
        _raw: r,
      };
    case 'sales':
      return {
        id: String(r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: r.date ? String(r.date) : null,
        totalAmount: toNum(first(r.totalAmount, r.total_amount, r.total, 0)),
        status: String(r.status ?? ''),
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        dateMonth: dateMonthOf(r.date),
        _raw: r,
      };
    case 'delivery_notes':
      return {
        id: String(r.id ?? ''),
        invoiceId: String(r.invoiceId ?? r.invoice_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? r.clientName ?? ''),
        date: r.date ? String(r.date) : null,
        status: String(r.status ?? ''),
        _raw: r,
      };
    case 'supplier_payments':
      return {
        id: String(r.id ?? ''),
        supplierId: supplierIdOf(r),
        date: (r.date ?? r.payment_date) ? String(r.date ?? r.payment_date) : null,
        amount: toNum(first(r.amount, r.total, 0)),
        paymentMethod: String(r.paymentMethod ?? r.payment_method ?? r.method ?? ''),
        reference: String(r.reference ?? ''),
        status: String(r.status ?? ''),
        dateMonth: dateMonthOf(first(r.date, r.payment_date)),
        _raw: r,
      };
    case 'inventory_transactions':
      return {
        id: String(r.id ?? ''),
        itemId: String(r.itemId ?? r.item_id ?? ''),
        itemName: String(r.itemName ?? r.item_name ?? ''),
        type: String(r.type ?? ''),
        quantity: toNum(first(r.quantity, r.qty, 0)),
        date: r.date ? String(r.date) : (r.createdAt ? String(r.createdAt) : null),
        warehouseId: String(r.warehouseId ?? r.warehouse_id ?? ''),
        reference: String(r.reference ?? r.referenceId ?? ''),
        _raw: r,
      };
    case 'goods_receipts':
      return {
        id: String(r.id ?? ''),
        purchaseId: String(r.purchaseId ?? r.purchase_id ?? r.purchase_order_id ?? ''),
        date: r.date ? String(r.date) : null,
        status: String(r.status ?? ''),
        itemCount: Array.isArray(r.items) ? r.items.length : 0,
        _raw: r,
      };
    case 'shipments':
      return {
        id: String(r.id ?? ''),
        orderId: String(r.orderId ?? r.order_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        date: (r.date ?? r.createdAt) ? String(r.date ?? r.createdAt) : null,
        status: String(r.status ?? ''),
        trackingNumber: String(r.trackingNumber ?? r.tracking_number ?? ''),
        _raw: r,
      };
    case 'wallet_transactions':
      return {
        id: String(r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        date: r.date ? String(r.date) : null,
        amount: toNum(first(r.amount, 0)),
        type: String(r.type ?? ''),
        reference: String(r.reference ?? ''),
        _raw: r,
      };
    case 'referrals':
      return {
        id: String(r.id ?? ''),
        referredById: String(r.referredById ?? r.referred_by_id ?? r.referredBy ?? ''),
        referredByName: String(r.referredByName ?? r.referred_by_name ?? ''),
        date: (r.date ?? r.createdAt ?? r.created_at) ? String(r.date ?? r.createdAt ?? r.created_at) : null,
        status: String(r.status ?? ''),
        rewardAmount: toNum(first(r.rewardAmount, r.reward_amount, r.amount, 0)),
        _raw: r,
      };
    case 'examination_batches':
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? r.batchName ?? r.batch_name ?? r.id ?? ''),
        schoolId: String(r.schoolId ?? r.school_id ?? r.customerId ?? ''),
        customerName: String(r.customerName ?? r.customer_name ?? r.schoolName ?? r.school_name ?? ''),
        date: (r.date ?? r.createdAt ?? r.created_at) ? String(r.date ?? r.createdAt ?? r.created_at) : null,
        status: String(r.status ?? ''),
        totalAmount: toNum(first(r.totalAmount, r.total_amount, r.total, 0)),
        learnerCount: toNum(first(r.learnerCount, r.expected_candidature, r.numberOfStudents, 0)),
        _raw: r,
      };
    case 'work_orders':
      return {
        id: String(r.id ?? ''),
        productName: String(r.productName ?? r.product_name ?? r.name ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        status: String(r.status ?? ''),
        quantityPlanned: toNum(first(r.quantityPlanned, r.quantity_planned, 0)),
        quantityCompleted: toNum(first(r.quantityCompleted, r.quantity_completed, 0)),
        dueDate: (r.dueDate ?? r.due_date) ? String(r.dueDate ?? r.due_date) : null,
        _raw: r,
      };
    case 'boms':
      return {
        id: String(r.id ?? ''),
        name: String(r.name ?? ''),
        productId: String(r.productId ?? r.product_id ?? ''),
        productName: String(r.productName ?? r.product_name ?? ''),
        status: String(r.status ?? 'active'),
        componentCount: Array.isArray(r.components) ? r.components.length : 0,
        _raw: r,
      };
    case 'subscriptions':
      return {
        id: String(r.id ?? ''),
        customerId: String(r.customerId ?? r.customer_id ?? ''),
        customerName: customerDisplayOf(r) || String(r.customerName ?? ''),
        status: String(r.status ?? ''),
        totalAmount: toNum(first(r.totalAmount, r.total_amount, r.total, 0)),
        frequency: String(r.frequency ?? ''),
        nextRunDate: (r.nextRunDate ?? r.next_run_date) ? String(r.nextRunDate ?? r.next_run_date) : null,
        _raw: r,
      };
    case 'order_items':
    case 'invoice_items':
      // Built by flattenLines; stored pre-normalised with parent context.
      return { ...(r as Record<string, unknown>) };
    default:
      return { ...(r as Record<string, unknown>) };
  }
}

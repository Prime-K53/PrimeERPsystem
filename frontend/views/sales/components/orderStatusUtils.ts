import type { Order } from '../../../types';
import { canonicalizeStatus, isTerminalStatus, type SalesOrderStatus } from '../../../types/salesOrder';

/**
 * An order is considered workflow-complete only when it has reached its
 * legitimate terminal state via the explicit Order → Invoice conversion
 * (status Converted) or fulfillment (status Fulfilled). Invoice existence
 * alone (invoiceId/invoiceNumber/invoiceStatus) does NOT complete the
 * Sales Order workflow — invoice status and order status are separate
 * concepts. Kept under the historical name for backwards compatibility.
 */
export function isOrderInvoiced(order: any): boolean {
  if (!order) return false;
  const status = String(order.status || '').trim();
  return status === 'Converted' || status === 'Fulfilled';
}

/**
 * Canonical lifecycle status of an order, safe to read regardless of whether
 * the record is a raw `SalesOrder` or a legacy projection from
 * `toLegacyOrder`. The legacy `status` string is lossy — it folds payment and
 * invoicing state into the workflow field — so `canonicalStatus` is preferred
 * whenever the projection supplied it, and the raw status is canonicalized
 * only as a fallback for records that predate the projection.
 */
export function getOrderCanonicalStatus(order: Order | any): SalesOrderStatus {
  if (!order) return 'Confirmed';
  return canonicalizeStatus(order.canonicalStatus ?? order.status);
}

/**
 * Display status for an order on the Full Orders list.
 * Terminal workflow states (Converted/Fulfilled) show as "Done"; cancelled
 * stays "Cancelled"; everything else (Draft/Confirmed/Processing, including
 * invoice-derived orders that merely carry an invoiceId) shows as
 * "Processing" until an explicit terminal transition occurs.
 */
export function getOrderDisplayStatus(order: Order | any): string {
  const status = (order && order.status) || '';
  if (status === 'Cancelled') return 'Cancelled';
  if (isOrderInvoiced(order)) return 'Done';
  return 'Processing';
}

/**
 * Outstanding (unpaid) balance for an order. Prefers the derived
 * `remainingBalance` when present, otherwise recomputes from amounts so the
 * value stays correct for records written before that field existed.
 */
export function getOrderOutstanding(order: Order | any): number {
  if (!order) return 0;
  const total = Number(order.totalAmount ?? order.total ?? 0) || 0;
  const paid = Number(order.paidAmount ?? 0) || 0;
  return Math.max(0, total - paid);
}

/**
 * True when an order can still legitimately receive a customer payment
 * allocation (e.g. the Record Customer Payment modal).
 *
 * Eligibility is decided on the CANONICAL workflow status, never on the legacy
 * projection string: the old `status === 'Processing'` check silently hid
 * every order whose legacy status had been rewritten to 'Partially Paid',
 * 'Paid' or 'Converted', which is most real orders.
 *
 * Rules:
 *  - Cancelled orders can never be paid (mirrors the transaction-service guard).
 *  - Terminal workflow states (Fulfilled/Converted) are settled through their
 *    invoice or job ticket, so they are not order-allocatable. An order that is
 *    merely Invoiced is likewise settled via its invoice.
 *  - Draft orders have not been committed and are not yet receivable.
 *  - A fully settled order (zero outstanding) is never offered.
 */
export function isOrderPaymentEligible(order: Order | any): boolean {
  if (!order) return false;
  const status = getOrderCanonicalStatus(order);
  if (status === 'Cancelled' || status === 'Draft') return false;
  if (isTerminalStatus(status)) return false;
  if (order.invoiceStatus === 'Invoiced') return false;
  if (order.invoiceId || order.invoiceNumber) return false;
  return getOrderOutstanding(order) > 0.005;
}

/**
 * Tailwind class sets that give every order status a distinct colour.
 * Previously only "Cancelled" stood out; now each lifecycle state is coloured.
 */
export const orderStatusClasses: Record<string, string> = {
  Processing: 'bg-blue-100 text-blue-700 border-blue-200',
  Pending: 'bg-blue-100 text-blue-700 border-blue-200',
  Confirmed: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  Done: 'bg-teal-100 text-teal-700 border-teal-200',
  Completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  Paid: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  'Partially Paid': 'bg-amber-100 text-amber-700 border-amber-200',
  Cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
  Draft: 'bg-slate-100 text-slate-600 border-slate-200',
  default: 'bg-slate-100 text-slate-600 border-slate-200',
};

export function getOrderStatusClass(status: string): string {
  return orderStatusClasses[status] || orderStatusClasses.default;
}

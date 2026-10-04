import type { Order } from '../../../types';
import {
  canonicalizeStatus,
  isTerminalStatus,
  SALES_ORDER_STATUSES,
  type SalesOrderStatus,
} from '../../../types/salesOrder';

/**
 * An order is considered workflow-complete only when it has reached its
 * legitimate terminal state via the explicit Order → Invoice conversion
 * (status Converted) or fulfillment (status Fulfilled). Invoice existence
 * alone (invoiceId/invoiceNumber/invoiceStatus) does NOT complete the
 * Sales Order workflow — invoice status and order status are separate
 * concepts. Kept under the historical name for backwards compatibility.
 *
 * MUST consult the canonical status, not the legacy projection string:
 * `toLegacyOrder` rewrites canonical `Fulfilled` to the legacy `'Completed'`,
 * so the old `status === 'Fulfilled'` test never fired for real records and a
 * fulfilled order kept displaying as "Processing" forever. The legacy spellings
 * are still accepted so hand-built and pre-projection records behave the same.
 */
export function isOrderInvoiced(order: any): boolean {
  if (!order) return false;
  const legacyStatus = String(order.status || '').trim();
  if (legacyStatus === 'Converted' || legacyStatus === 'Fulfilled') return true;
  const canonical = getOrderCanonicalStatus(order);
  return canonical === 'Converted' || canonical === 'Fulfilled';
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
  // Canonical terminal states, shown by the Change Status modal.
  Fulfilled: 'bg-teal-100 text-teal-700 border-teal-200',
  Converted: 'bg-teal-100 text-teal-700 border-teal-200',
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

/**
 * Legal status transitions for a Sales Order, restricted to statuses that
 * survive `canonicalizeStatus` unchanged.
 *
 * Why the restriction matters: `transactionService.updateOrderStatus` runs every
 * incoming status through `canonicalizeStatus`, which maps `Pending -> Confirmed`
 * and does not know `Shipped`/`Delivered` at all (both fall back to `Confirmed`).
 * Offering those would let the UI claim a status the store then silently
 * overwrites. Portal-facing `Shipped`/`Delivered` are shipment states, not order
 * lifecycle states, so they are out of scope here by design.
 *
 * Two further states are deliberately NOT offered:
 *  - `Cancelled` — must go through `cancelOrder(id, reason)`, which releases
 *    stock reservations and writes the audit trail. `updateOrderStatus` would
 *    flip the label and leave the reservations behind.
 *  - `Converted` — reserved for the real Order → Invoice / Job Ticket
 *    conversions. Setting it by hand writes `invoiceStatus = 'Invoiced'` with no
 *    invoice behind it, i.e. fabricates an invoiced state.
 *
 * Terminal states are final, matching `isCancelableStatus` and the backend
 * workflow engine (`workflowEngine.assertSalesOrderTransition`).
 */
export const ORDER_STATUS_TRANSITIONS: Record<SalesOrderStatus, readonly SalesOrderStatus[]> = {
  Draft: ['Confirmed'],
  Confirmed: ['Processing', 'Fulfilled'],
  Processing: ['Fulfilled'],
  Fulfilled: [],
  Cancelled: [],
  Converted: [],
};

export interface OrderStatusAction {
  status: SalesOrderStatus;
  label: string;
  /** What the system will actually do, stated before the user commits. */
  description: string;
  /** Present when the change is irreversible or moves stock/ledgers. */
  warning?: string;
  /** Requires an explicit second confirmation before it is dispatched. */
  requiresConfirmation: boolean;
}

const ORDER_STATUS_ACTION_META: Record<SalesOrderStatus, Omit<OrderStatusAction, 'status'>> = {
  Draft: {
    label: 'Draft',
    description: 'Not yet committed to the customer.',
    requiresConfirmation: false,
  },
  Confirmed: {
    label: 'Confirmed',
    description: 'Order accepted. Reserved stock stays held and nothing is consumed.',
    requiresConfirmation: false,
  },
  Processing: {
    label: 'Processing',
    description: 'Work has started. Stock remains reserved until the order is fulfilled.',
    requiresConfirmation: false,
  },
  Fulfilled: {
    label: 'Fulfilled',
    description:
      'Deducts stock, clears reservations, posts cost of goods sold to the ledger and applies market adjustments.',
    warning:
      'This is not reversible from the order. Stock leaves inventory and a COGS journal is posted.',
    requiresConfirmation: true,
  },
  Cancelled: {
    label: 'Cancelled',
    description: 'Releases reserved stock and records the cancellation reason.',
    requiresConfirmation: false,
  },
  Converted: {
    label: 'Converted',
    description: 'Order became an invoice or job ticket.',
    requiresConfirmation: false,
  },
};

/**
 * The status changes a user may pick right now for this order, each with the
 * side effects it will cause. Empty means the order is in a terminal state and
 * must be reopened by cancelling (when allowed) rather than by editing status.
 */
export function getOrderStatusActions(order: Order | any): OrderStatusAction[] {
  const current = getOrderCanonicalStatus(order);
  if (isTerminalStatus(current)) return [];

  const allowed = ORDER_STATUS_TRANSITIONS[current] || [];
  return allowed
    .filter((status) => status !== current)
    .filter((status) => (SALES_ORDER_STATUSES as readonly string[]).includes(status))
    .filter((status) => canonicalizeStatus(status) === status)
    .map((status) => ({ status, ...ORDER_STATUS_ACTION_META[status] }));
}

export function canTransitionOrderStatus(from: string | null | undefined, to: string | null | undefined): boolean {
  const source = canonicalizeStatus(from);
  const target = canonicalizeStatus(to);
  if (source === target) return false;
  return (ORDER_STATUS_TRANSITIONS[source] || []).includes(target);
}

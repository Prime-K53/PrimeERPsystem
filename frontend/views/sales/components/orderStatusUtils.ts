import type { Order } from '../../../types';

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

/**
 * Read-only diagnostic for missing-order incidents (ERP only).
 *
 * Answers, per order id, at exactly which layer a row disappears:
 * IndexedDB (`salesOrders` + legacy `orders`) → tombstone flag →
 * sync-queue operations → list projection/filter inputs.
 *
 * Strictly read-only: performs zero writes, enqueues nothing, mutates no
 * records. Safe to run from devtools on a live device:
 *
 *   const { diagnoseMissingOrders } = await import('./services/orderDiagnostics');
 *   await diagnoseMissingOrders(['ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024']);
 *
 * Verdicts:
 * - VISIBLE            row is live in `salesOrders` and reaches the list input
 * - SOFT_DELETED_LOCALLY row carries `deletedAt` (hidden by design; check the
 *                      queued delete op below to see whether the delete synced)
 * - LEGACY_ONLY        row lives only in the legacy `orders` store (runs again
 *                      through migration on next Orders-mount; no action needed
 *                      unless it never migrates)
 * - MISSING_LOCALLY    row is in neither store: it never persisted here, was
 *                      hard-removed, or this is a different browser/profile/
 *                      device than the one that created it. Compare against the
 *                      cloud table before recreating anything.
 */
import { dbService } from './db';
import { durableSyncQueue } from './durableSyncQueue';
import { canonicalizeStatus } from '../types/salesOrder';

export type OrderDiagnosticVerdict =
  | 'VISIBLE'
  | 'SOFT_DELETED_LOCALLY'
  | 'LEGACY_ONLY'
  | 'MISSING_LOCALLY';

export interface OrderDiagnosticQueuedOp {
  operation: string;
  status: string;
  lastError: string | null;
  retryCount: number;
  lastAttempt: string | null;
}

export interface OrderDiagnosticResult {
  id: string;
  presentInSalesOrders: boolean;
  tombstoned: boolean;
  deletedAt: string | null;
  presentInLegacyOrders: boolean;
  storedStatus: unknown;
  storedOrderNumber: unknown;
  storedCustomerName: unknown;
  storedTotal: unknown;
  projectable: boolean;
  queuedOps: OrderDiagnosticQueuedOp[];
  verdict: OrderDiagnosticVerdict;
}

const OP_TABLES = ['sales_orders', 'salesOrders', 'orders'] as const;

export async function diagnoseMissingOrders(ids: string[]): Promise<OrderDiagnosticResult[]> {
  const results: OrderDiagnosticResult[] = [];

  let queued: Array<{
    table?: string;
    recordId?: string | null;
    operation?: string;
    status?: string;
    lastError?: string | null;
    retryCount?: number;
    lastAttempt?: string | null;
  }> = [];
  try {
    const all = await durableSyncQueue.getAll();
    queued = Array.isArray(all) ? all : [];
  } catch {
    queued = [];
  }

  for (const id of ids) {
    let row: any = null;
    try {
      row = await dbService.get('salesOrders', id);
    } catch {
      row = null;
    }

    let legacyRow: any = null;
    try {
      legacyRow = await dbService.get('orders', id);
    } catch {
      legacyRow = null;
    }

    const tombstoned = Boolean(row && (row as Record<string, unknown>).deletedAt);
    let projectable = false;
    if (row && !tombstoned) {
      try {
        canonicalizeStatus((row as Record<string, unknown>).status as string | null);
        projectable = (row as Record<string, unknown>).id != null;
      } catch {
        projectable = false;
      }
    }

    const queuedOps: OrderDiagnosticQueuedOp[] = queued
      .filter(
        (op) =>
          op &&
          (OP_TABLES as readonly string[]).includes(String(op.table || '')) &&
          String(op.recordId || '') === String(id),
      )
      .map((op) => ({
        operation: String(op.operation || ''),
        status: String(op.status || ''),
        lastError: op.lastError != null ? String(op.lastError) : null,
        retryCount: Number(op.retryCount || 0),
        lastAttempt: op.lastAttempt != null ? String(op.lastAttempt) : null,
      }));

    const verdict: OrderDiagnosticVerdict = row
      ? tombstoned
        ? 'SOFT_DELETED_LOCALLY'
        : 'VISIBLE'
      : legacyRow
        ? 'LEGACY_ONLY'
        : 'MISSING_LOCALLY';

    results.push({
      id,
      presentInSalesOrders: Boolean(row),
      tombstoned,
      deletedAt:
        row && (row as Record<string, unknown>).deletedAt != null
          ? String((row as Record<string, unknown>).deletedAt)
          : null,
      presentInLegacyOrders: Boolean(legacyRow),
      storedStatus: row ? (row as Record<string, unknown>).status : undefined,
      storedOrderNumber:
        row != null
          ? (row as Record<string, unknown>).orderNumber ?? (row as Record<string, unknown>).order_number
          : undefined,
      storedCustomerName: row ? (row as Record<string, unknown>).customerName : undefined,
      storedTotal:
        row != null
          ? (row as Record<string, unknown>).totalAmount ?? (row as Record<string, unknown>).total
          : undefined,
      projectable,
      queuedOps,
      verdict,
    });
  }

  return results;
}

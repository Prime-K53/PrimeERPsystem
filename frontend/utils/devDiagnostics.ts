/**
 * Development-only DevTools diagnostics bridge (ERP only).
 *
 * Exposes ONLY the read-only missing-order diagnostic on a narrowly scoped
 * global so it can be invoked from browser DevTools during investigations:
 *
 *   await globalThis.diagnoseMissingOrders(['ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024'])
 *
 * Safety properties:
 * - Gated on `import.meta.env.DEV` (repo convention, cf. AppTopBar/logger):
 *   Vite statically replaces the flag at build time, so production builds
 *   contain neither the global nor this code path (dead branch eliminated).
 * - Delegates to the existing implementation in services/orderDiagnostics;
 *   no diagnostic logic is duplicated here.
 * - Read-only: the underlying diagnostic performs zero writes.
 * - No other service or application internals are exposed.
 */
import { diagnoseMissingOrders } from '../services/orderDiagnostics';
import type { OrderDiagnosticResult } from '../services/orderDiagnostics';

declare global {
  // eslint-disable-next-line no-var
  var diagnoseMissingOrders:
    | ((ids: string[]) => Promise<OrderDiagnosticResult[]>)
    | undefined;
}

if (import.meta.env.DEV && typeof globalThis !== 'undefined') {
  globalThis.diagnoseMissingOrders = (ids: string[]) => diagnoseMissingOrders(ids);
}

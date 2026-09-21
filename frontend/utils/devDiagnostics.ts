/**
 * Development-only DevTools diagnostics bridge (ERP only).
 *
 * Exposes ONLY read-only diagnostics on a narrowly scoped global so they
 * can be invoked from browser DevTools during investigations:
 *
 *   await globalThis.diagnoseMissingOrders(['ORDER-P726/022', 'ORDER-P726/023', 'ORDER-P726/024'])
 *   await globalThis.runInventoryRecoveryReportFromStores()
 *
 * Safety properties:
 * - Gated on `import.meta.env.DEV` (repo convention, cf. AppTopBar/logger):
 *   Vite statically replaces the flag at build time, so production builds
 *   contain neither the global nor this code path (dead branch eliminated).
 * - Delegates to existing implementations in services/; no diagnostic logic
 *   is duplicated here.
 * - Read-only: underlying diagnostics perform zero writes.
 * - No other service or application internals are exposed.
 */
import { diagnoseMissingOrders } from '../services/orderDiagnostics';
import type { OrderDiagnosticResult } from '../services/orderDiagnostics';
import { buildInventoryRecoveryReport, formatInventoryRecoveryReport } from '../services/inventoryRecoveryService';

declare global {
  // eslint-disable-next-line no-var
  var diagnoseMissingOrders:
    | ((ids: string[]) => Promise<OrderDiagnosticResult[]>)
    | undefined;
  // eslint-disable-next-line no-var
  var runInventoryRecoveryReportFromStores:
    | (() => Promise<string>)
    | undefined;
  // eslint-disable-next-line no-var
  var runInventoryRecoveryReport:
    | ((
        items: any[],
        accounts: any[],
        ledger: any[],
        warehouseRecords?: any[],
        inventoryTransactions?: any[]
      ) => InventoryRecoveryReport)
    | undefined;
}

if (import.meta.env.DEV && typeof globalThis !== 'undefined') {
  globalThis.diagnoseMissingOrders = (ids: string[]) => diagnoseMissingOrders(ids);

  globalThis.runInventoryRecoveryReport = (
    items: any[],
    accounts: any[],
    ledger: any[],
    warehouseRecords: any[] = [],
    inventoryTransactions: any[] = []
  ) => buildInventoryRecoveryReport(items, accounts, ledger, warehouseRecords, inventoryTransactions);

  globalThis.runInventoryRecoveryReportFromStores = async (): Promise<string> => {
    try {
      const { useInventoryStore } = await import('../stores/inventoryStore');
      const { useFinanceStore } = await import('../stores/financeStore');

      const inventory = useInventoryStore.getState().inventory;
      const warehouses = useInventoryStore.getState().warehouses;
      const accounts = useFinanceStore.getState().accounts;
      const ledger = useFinanceStore.getState().ledger;

      if (!inventory || inventory.length === 0) {
        return 'ERROR: Inventory store is empty. Ensure inventory data has been loaded into the ERP session before running this diagnostic.';
      }

      const report = buildInventoryRecoveryReport(inventory, accounts, ledger, warehouses, []);
      return formatInventoryRecoveryReport(report);
    } catch (error: any) {
      return `ERROR: Failed to run inventory recovery report: ${error.message || error}`;
    }
  };
}

if (import.meta.env.DEV && typeof globalThis !== 'undefined') {
  globalThis.diagnoseMissingOrders = (ids: string[]) => diagnoseMissingOrders(ids);
  globalThis.runInventoryRecoveryReport = (
    items: any[],
    accounts: any[],
    ledger: any[],
    warehouseRecords: any[] = [],
    inventoryTransactions: any[] = []
  ) => buildInventoryRecoveryReport(items, accounts, ledger, warehouseRecords, inventoryTransactions);
}

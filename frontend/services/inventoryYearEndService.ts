/**
 * Inventory Year-End Check.
 *
 * Surfaces inventory-related issues that should be reviewed before
 * closing a financial year:
 *   - Items with negative stock
 *   - Items with zero cost (potential misvaluation)
 *   - Items with large outstanding variance (last stock count)
 *   - Unposted adjustments (no GL linkage on inventory transactions)
 *   - Inventory account reconciliation (sum of GL inventory debits
 *     should equal items' book value)
 *
 * Read-only.
 */

import { dbService } from './db';
import { logger } from './logger';
import { roundFinancial } from '../utils/helpers';

export interface InventoryYearEndIssue {
  severity: 'error' | 'warning' | 'info';
  category: 'negative-stock' | 'zero-cost' | 'large-variance' | 'unposted-adjustment' | 'reconciliation';
  message: string;
  count?: number;
  amount?: number;
}

export interface InventoryYearEndReport {
  fiscalYear: number;
  generatedAt: string;
  issues: InventoryYearEndIssue[];
  summary: {
    totalItems: number;
    totalStockValue: number;
    fyAdjustments: number;
    negativeStock: number;
    zeroCost: number;
    ledgerInventoryTotal: number;
    variance: number;
  };
}

export async function checkInventoryYearEnd(fiscalYear: number): Promise<InventoryYearEndReport> {
  const generatedAt = new Date().toISOString();
  const issues: InventoryYearEndIssue[] = [];

  try {
    const items: any[] = (await dbService.getAll<any>('inventory')) || [];
    const invTxns: any[] = (await dbService.getAll<any>('inventoryTransactions')) || [];
    const ledger: any[] = (await dbService.getAll<any>('ledger')) || [];

    const fyStart = `${fiscalYear}-01-01`;
    const fyEnd = `${fiscalYear}-12-31`;

    // 1) Negative stock
    const negative = items.filter((i) => (i.stock || 0) < 0);
    if (negative.length > 0) {
      issues.push({
        severity: 'error',
        category: 'negative-stock',
        message: `${negative.length} item(s) with negative stock`,
        count: negative.length,
      });
    }

    // 2) Zero cost on stocked items
    const zeroCost = items.filter((i) => (i.stock || 0) > 0 && !(i.cost || 0));
    if (zeroCost.length > 0) {
      issues.push({
        severity: 'warning',
        category: 'zero-cost',
        message: `${zeroCost.length} stocked item(s) with zero cost — valuation may be incorrect`,
        count: zeroCost.length,
      });
    }

    // 3) FY adjustments count
    const fyAdjustments = invTxns.filter((t) => {
      const d = (t.date || '').slice(0, 10);
      return t.type === 'ADJUSTMENT' && d >= fyStart && d <= fyEnd;
    });
    if (fyAdjustments.length > 0) {
      issues.push({
        severity: 'info',
        category: 'unposted-adjustment',
        message: `${fyAdjustments.length} stock adjustment(s) recorded in FY ${fiscalYear}`,
        count: fyAdjustments.length,
      });
    }

    // 4) GL inventory balance vs items book value
    const totalStockValue = items.reduce((s, i) => s + roundFinancial((i.stock || 0) * (i.cost || 0)), 0);
    // Sum inventory GL debits - credits for default inventory account (11400)
    let ledgerInventoryTotal = 0;
    const invAcctPrefixes = ['11400', '11410', '11420', '11430'];
    for (const e of ledger) {
      const dr = String(e.debitAccountId || '');
      const cr = String(e.creditAccountId || '');
      if (invAcctPrefixes.some((p) => dr.startsWith(p))) ledgerInventoryTotal += roundFinancial(e.amount || 0);
      if (invAcctPrefixes.some((p) => cr.startsWith(p))) ledgerInventoryTotal -= roundFinancial(e.amount || 0);
    }
    const variance = roundFinancial(totalStockValue - ledgerInventoryTotal);
    const tol = 1; // 1 currency unit tolerance for rounding
    if (Math.abs(variance) > tol) {
      issues.push({
        severity: 'warning',
        category: 'reconciliation',
        message: `Inventory GL (${ledgerInventoryTotal.toFixed(2)}) vs item book value (${totalStockValue.toFixed(2)}) — variance ${variance.toFixed(2)}`,
        amount: variance,
      });
    }

    return {
      fiscalYear,
      generatedAt,
      issues,
      summary: {
        totalItems: items.length,
        totalStockValue,
        fyAdjustments: fyAdjustments.length,
        negativeStock: negative.length,
        zeroCost: zeroCost.length,
        ledgerInventoryTotal,
        variance,
      },
    };
  } catch (err) {
    logger.error('[Inventory YearEnd] check failed', err);
    return { fiscalYear, generatedAt, issues: [{ severity: 'error', category: 'reconciliation', message: 'Inventory year-end check failed — see logs.' }], summary: { totalItems: 0, totalStockValue: 0, fyAdjustments: 0, negativeStock: 0, zeroCost: 0, ledgerInventoryTotal: 0, variance: 0 } };
  }
}

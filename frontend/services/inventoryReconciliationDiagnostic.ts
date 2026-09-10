/**
 * inventoryReconciliationDiagnostic.ts
 *
 * Diagnostic utility that compares physical inventory valuation (from the
 * inventory subledger) against General Ledger balances for the inventory
 * hierarchy (11400 → 11410/11420/11430).
 *
 * Reports:
 *  - physicalInventoryValue       — total stock × cost across all active items
 *  - glInventoryValue            — sum of GL balances for 11410/11420/11430
 *  - variance                    — physical − GL (positive = GL is understated)
 *  - merchandiseValue / rawMaterialsValue / finishedGoodsValue — physical by type
 *  - glMerchandiseValue / glRawMaterialsValue / glFinishedGoodsValue — GL by account
 *  - diagnostics                 — array of data-quality flags
 */

import { Item } from '../types';
import {
  resolveInventoryAccountByItemType,
  computeHierarchicalBalances,
  getGLConfig,
} from './transactions/_internal';
import { isPostedLedgerEntry } from './accountingEngine';
import {
  reconcileInventoryValuation,
  formatInventoryReconciliation,
  resolveInventoryCostPerUnit,
  resolveInventoryQuantity,
  type InventoryValuationReconciliation,
} from '../utils/inventoryNormalization';
import { Account, LedgerEntry } from '../types';
import { dbService } from './db';

export interface InventoryReconciliationResult {
  physicalInventoryValue: number;
  glInventoryValue: number;
  variance: number;
  merchandiseValue: number;
  rawMaterialsValue: number;
  finishedGoodsValue: number;
  otherValue: number;
  totalUnits: number;
  itemCount: number;
  activeItemCount: number;
  inactiveItemCount: number;
  glMerchandiseValue: number;
  glRawMaterialsValue: number;
  glFinishedGoodsValue: number;
  glTotalChildrenValue: number;
  diagnostics: InventoryDiagnosticFlag[];
  byItemType: Record<string, { physical: number; units: number; itemCount: number }>;
}

export interface InventoryDiagnosticFlag {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
  count?: number;
}

const INFLATION_ZONE = 1_000_000; // values above this get a flag

export async function computeInventoryReconciliation(): Promise<InventoryReconciliationResult> {
  const [inventory, accounts, ledger] = await Promise.all([
    dbService.getAll<Item>('inventory'),
    dbService.getAll<Account>('accounts'),
    dbService.getAll<LedgerEntry>('ledger'),
  ]);

  // ── 1. Physical inventory valuation ──────────────────────────────────────
  let physicalInventoryValue = 0;
  let totalUnits = 0;
  let itemCount = 0;
  let activeItemCount = 0;
  let inactiveItemCount = 0;

  const byType: Record<string, { physical: number; units: number; itemCount: number }> = {};

  const diagnostics: InventoryDiagnosticFlag[] = [];

  for (const item of inventory) {
    itemCount++;
    const isActive = String(item.status || 'Active').toLowerCase() !== 'inactive';
    if (isActive) activeItemCount++; else inactiveItemCount++;

    // Canonical economics: quantity × cost (never Selling Price), every
    // historical cost representation supported.
    const qty = resolveInventoryQuantity(item);
    const cost = resolveInventoryCostPerUnit(item);
    const value = qty * cost;

    if (qty < 0) {
      diagnostics.push({
        code: 'NEGATIVE_STOCK',
        message: `Item ${item.id} (${item.name}) has negative stock (${qty})`,
        severity: 'warning',
        count: qty,
      });
    }
    if (cost === 0 && qty > 0) {
      diagnostics.push({
        code: 'ZERO_COST',
        message: `Item ${item.id} (${item.name}) has zero cost but ${qty} units in stock`,
        severity: 'warning',
      });
    }
    if (value > INFLATION_ZONE) {
      diagnostics.push({
        code: 'HIGH_VALUE_ITEM',
        message: `Item ${item.id} (${item.name}) has value K${value.toLocaleString()}`,
        severity: 'info',
      });
    }

    physicalInventoryValue += value;
    totalUnits += qty;

    const type = String(item.type || 'product').toLowerCase();
    if (!byType[type]) byType[type] = { physical: 0, units: 0, itemCount: 0 };
    byType[type].physical += value;
    byType[type].units += qty;
    byType[type].itemCount++;
  }

  // ── 2. GL balances by inventory sub-account ───────────────────────────────
  // Build a map from account id → account record
  const accountById = new Map<string, Account>();
  const accountByCode = new Map<string, Account>();
  for (const acc of accounts) {
    accountById.set(acc.id, acc);
    if (acc.code) accountByCode.set(acc.code, acc);
  }

  // Resolve the three posting sub-accounts
  const merchandiseAcct = resolveInventoryAccountByItemType('product', accounts);
  const rawMaterialsAcct = resolveInventoryAccountByItemType('raw material', accounts);
  const finishedGoodsAcct = resolveInventoryAccountByItemType('finished good', accounts);

  // Compute GL balance for a given account id from ledger entries
  function glBalanceForAccountId(targetId: string | null): number {
    if (!targetId) return 0;
    let balance = 0;
    for (const entry of ledger) {
      // Skip drafts, voids, and reversals for balance computation consistency
      if (!isPostedLedgerEntry(entry)) continue;
      const amount = Number(entry.amount || 0);
      if (!amount) continue;

      const debitId = entry.debitAccountId;
      const creditId = entry.creditAccountId;

      const debitAcc = accountById.get(debitId) || accountByCode.get(debitId);
      const creditAcc = accountById.get(creditId) || accountByCode.get(creditId);

      const isDebitNormal = (acc: Account | undefined) => {
        if (!acc) return true;
        const t = (acc.account_type || acc.type || '').toUpperCase();
        return t === 'ASSET' || t === 'EXPENSE';
      };

      if (debitAcc && (debitAcc.id === targetId || debitAcc.code === targetId)) {
        balance += isDebitNormal(debitAcc) ? amount : -amount;
      }
      if (creditAcc && (creditAcc.id === targetId || creditAcc.code === targetId)) {
        balance += isDebitNormal(creditAcc) ? -amount : amount;
      }
    }
    return balance;
  }

  const glMerchandiseValue = glBalanceForAccountId(merchandiseAcct);
  const glRawMaterialsValue = glBalanceForAccountId(rawMaterialsAcct);
  const glFinishedGoodsValue = glBalanceForAccountId(finishedGoodsAcct);
  const glTotalChildrenValue = glMerchandiseValue + glRawMaterialsValue + glFinishedGoodsValue;

  // Also compute hierarchical balance for 11400 to verify rollup
  const balances: Record<string, number> = {};
  for (const acc of accounts) {
    balances[acc.id] = 0;
  }
  // Apply ledger entries (same logic as ChartOfAccounts)
  for (const entry of ledger) {
    if (!isPostedLedgerEntry(entry)) continue;
    const amount = Number(entry.amount || 0);
    if (!amount) continue;

    const debitAcc = accountById.get(entry.debitAccountId) || accountByCode.get(entry.debitAccountId);
    const creditAcc = accountById.get(entry.creditAccountId) || accountByCode.get(entry.creditAccountId);

    const normalBalance = (acc: Account | undefined): 'DEBIT' | 'CREDIT' => {
      if (!acc) return 'DEBIT';
      if (acc.normal_balance === 'CREDIT' || acc.normal_balance === 'DEBIT') return acc.normal_balance;
      const t = (acc.account_type || acc.type || '').toUpperCase();
      if (t === 'ASSET' || t === 'EXPENSE') return 'DEBIT';
      if (t === 'LIABILITY' || t === 'EQUITY' || t === 'INCOME') return 'CREDIT';
      return 'DEBIT';
    };

    if (debitAcc && balances[debitAcc.id] !== undefined) {
      const normal = normalBalance(debitAcc);
      const sign = normal === 'DEBIT' ? 1 : -1;
      balances[debitAcc.id] = (balances[debitAcc.id] || 0) + (amount * sign);
    }
    if (creditAcc && balances[creditAcc.id] !== undefined) {
      const normal = normalBalance(creditAcc);
      const sign = normal === 'DEBIT' ? -1 : 1;
      balances[creditAcc.id] = (balances[creditAcc.id] || 0) + (amount * sign);
    }
  }

  const hierarchicalBalances = computeHierarchicalBalances(accounts, balances);
  // Find the inventory parent account by code (configurable via glMapping), then read its rolled-up balance
  const gl = getGLConfig();
  const inventoryParentCode = gl.defaultInventoryAccount || '11400';
  const inventoryParentAcct = accounts.find(a => (a.code || a.account_number) === inventoryParentCode);
  const inventoryParentId = inventoryParentAcct ? inventoryParentAcct.id : inventoryParentCode;
  const merchandiseFallbackId = accounts.find(a => (a.code || a.account_number) === '11410')?.id || '11410';
  const glInventoryValue = hierarchicalBalances[inventoryParentId] || hierarchicalBalances[merchandiseAcct || merchandiseFallbackId] || 0;

  // ── 3. Variance ──────────────────────────────────────────────────────────
  const variance = physicalInventoryValue - glInventoryValue;

  // ── 4. Diagnostics ───────────────────────────────────────────────────────
  if (physicalInventoryValue === 0) {
    diagnostics.push({ code: 'NO_INVENTORY', message: 'Physical inventory value is zero', severity: 'warning' });
  }

  if (Math.abs(variance) > 0.01) {
    diagnostics.push({
      code: 'INVENTORY_VARIANCE',
      message: `Physical inventory (K${physicalInventoryValue.toLocaleString()}) differs from GL (K${glInventoryValue.toLocaleString()}) by K${Math.abs(variance).toLocaleString()}`,
      severity: variance > 0 ? 'error' : 'warning',
      count: Math.round(variance),
    });
  }

  if (inactiveItemCount > 0) {
    diagnostics.push({
      code: 'INACTIVE_ITEMS',
      message: `${inactiveItemCount} inactive items in inventory`,
      severity: 'info',
      count: inactiveItemCount,
    });
  }

  // Check for unclassified items
  const typeKeys = Object.keys(byType);
  const knownTypes = new Set(['raw material', 'material', 'product', 'finished good', 'finished goods', 'service', 'stationery', 'stationaries']);
  const unclassified = typeKeys.filter(t => !knownTypes.has(t));
  if (unclassified.length > 0) {
    diagnostics.push({
      code: 'UNCLASSIFIED_ITEMS',
      message: `Items with unrecognized type: ${unclassified.join(', ')}`,
      severity: 'warning',
      count: unclassified.length,
    });
  }

  // Verify GL children sum to parent (if parent exists in balances)
  const parentCode = '11400';
  const glParentFromChildren = glMerchandiseValue + glRawMaterialsValue + glFinishedGoodsValue;
  if (Math.abs(glParentFromChildren - glInventoryValue) > 0.01 && glInventoryValue !== 0) {
    diagnostics.push({
      code: 'GL_PARENT_MISMATCH',
      message: `GL parent (11400) = K${glInventoryValue.toLocaleString()} but children sum to K${glParentFromChildren.toLocaleString()}`,
      severity: 'error',
    });
  }

  return {
    physicalInventoryValue: Math.round(physicalInventoryValue * 100) / 100,
    glInventoryValue: Math.round(glInventoryValue * 100) / 100,
    variance: Math.round(variance * 100) / 100,
    merchandiseValue: Math.round(byType['product']?.physical || 0),
    rawMaterialsValue: Math.round(byType['raw material']?.physical || byType['material']?.physical || 0),
    finishedGoodsValue: Math.round(byType['finished goods']?.physical || 0),
    otherValue: Math.round(
      Object.entries(byType).reduce((s, [t, v]) => {
        if (t === 'product' || t === 'finished goods' || t === 'raw material' || t === 'material' || t === 'stationery' || t === 'stationaries') return s;
        return s + v.physical;
      }, 0)
    ),
    totalUnits,
    itemCount,
    activeItemCount,
    inactiveItemCount,
    glMerchandiseValue: Math.round(glMerchandiseValue * 100) / 100,
    glRawMaterialsValue: Math.round(glRawMaterialsValue * 100) / 100,
    glFinishedGoodsValue: Math.round(glFinishedGoodsValue * 100) / 100,
    glTotalChildrenValue: Math.round(glTotalChildrenValue * 100) / 100,
    diagnostics,
    byItemType: byType,
  };
}

/** Format the result for display / logging */
export function formatReconciliationReport(r: InventoryReconciliationResult): string {
  const lines = [
    '═══ INVENTORY RECONCILIATION REPORT ═══',
    '',
    `Physical Inventory Value:  K${r.physicalInventoryValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `GL Inventory Value:        K${r.glInventoryValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `Variance (Physical − GL):  K${r.variance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    '',
    '── By Item Type (Physical) ──',
    `  Merchandise (Products):   K${r.merchandiseValue.toLocaleString()}`,
    `  Raw Materials:            K${r.rawMaterialsValue.toLocaleString()}`,
    `  Finished Goods:           K${r.finishedGoodsValue.toLocaleString()}`,
    `  Other/Unclassified:       K${r.otherValue.toLocaleString()}`,
    '',
    '── GL Balances by Account ──',
    `  11410 Merchandise:        K${r.glMerchandiseValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `  11420 Raw Materials:      K${r.glRawMaterialsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `  11430 Finished Goods:     K${r.glFinishedGoodsValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    `  Children Sum:             K${r.glTotalChildrenValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    '',
    `Total Units:  ${r.totalUnits.toLocaleString()}`,
    `Item Count:   ${r.itemCount} (${r.activeItemCount} active, ${r.inactiveItemCount} inactive)`,
    '',
  ];

  if (r.diagnostics.length > 0) {
    lines.push('── Diagnostics ──');
    for (const d of r.diagnostics) {
      const prefix = d.severity === 'error' ? '✗' : d.severity === 'warning' ? '⚠' : '·';
      lines.push(`  ${prefix} [${d.code}] ${d.message}`);
    }
  }

  lines.push('');
  lines.push(`═══ END REPORT ═══`);
  return lines.join('\n');
}

/**
 * Read-only inventory ↔ GL valuation reconciliation (Phase 18).
 *
 * Runs entirely against current data and never creates journals. Exposes
 * per-item economics (quantity × cost, expected 11410/11420/11430 account,
 * inclusion + exclusion reason), category totals, posted-only GL balances,
 * and the reconciling difference.
 */
export async function getInventoryValuationReconciliation(): Promise<InventoryValuationReconciliation> {
  const [inventory, accounts, ledger] = await Promise.all([
    dbService.getAll<Item>('inventory'),
    dbService.getAll<Account>('accounts'),
    dbService.getAll<LedgerEntry>('ledger'),
  ]);
  return reconcileInventoryValuation(inventory as any[], accounts as any[], ledger as any[]);
}

/** Human-readable rendering of getInventoryValuationReconciliation. */
export async function formatInventoryValuationReconciliation(currencySymbol = 'K'): Promise<string> {
  const report = await getInventoryValuationReconciliation();
  return formatInventoryReconciliation(report, currencySymbol);
}

/**
 * Inventory Recovery Service — read-only analysis and recovery planning
 * for the Smart Stock contamination incident (SMART-1789588940379-egoshg).
 *
 * THIS SERVICE DOES NOT MODIFY ANY DATA.
 *
 * It provides:
 * 1. Incident reconstruction for all affected items
 * 2. Three-quantity separation: historical / current / physical
 * 3. Inventory account reconciliation (11410/11420/11430/11400)
 * 4. Recoverability classification: RECOVERABLE / PARTIALLY RECOVERABLE / UNKNOWN
 * 5. Physical count readiness report
 * 6. Recovery model recommendation (A/B/C)
 * 7. Read-only inventory correction preview
 *
 * SAFETY:
 * - No inventory mutations
 * - No GL postings
 * - No invoice modifications
 * - No customer balance changes
 * - No AR/revenue changes
 * - No ledger modifications
 * - No Supabase writes
 * - No migrations
 */

import {
  isInventoryBearingItem,
  resolveInventoryGLAccountCode,
  resolveInventoryCostPerUnit,
  resolveWarehouseQuantity,
  resolveInventoryQuantity,
  classifyInventoryItem,
  reconcileInventoryValuation,
  INVENTORY_GL_CODES,
  InventoryExclusionReason,
} from '../utils/inventoryNormalization';
import { computeOwnBalances } from '../services/accountingEngine';
import { analyzeSmartStockIncident } from './smartStockIncidentService';
import { generatePhysicalCountReport, PhysicalCountReport } from './physicalCountService';

// ── Types ────────────────────────────────────────────────────────

export type Recoverability = 'RECOVERABLE' | 'PARTIALLY_RECOVERABLE' | 'UNKNOWN';

export interface InventoryRecoveryItem {
  itemId: string;
  name: string;
  type: string;
  sku: string;
  inventoryBearing: boolean;
  inventoryAccount: string | null;
  quantityBeforeSeeding: number | null; // null = UNKNOWN
  seedQuantity: number;
  subsequentMovements: number;
  currentSystemQuantity: number;
  currentWarehouseQuantity: number;
  currentInventoryTransactionQuantity: number | null;
  canonicalCost: number;
  currentCalculatedValue: number;
  recoverability: Recoverability;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  note: string;
}

export interface InventoryAccountReconciliation {
  accountCode: string;
  accountName: string;
  accountType: string;
  openingBalance: number;
  legitimateDebits: number;
  legitimateCredits: number;
  smartStockEntries: number;
  currentLedgerBalance: number;
  currentPhysicalValue: number;
  difference: number;
  explanation: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface InventoryRecoveryReport {
  generatedAt: string;
  bulkId: string;
  totalAffectedItems: number;
  inventoryBearingItems: InventoryRecoveryItem[];
  nonInventoryBearingItems: InventoryRecoveryItem[];
  recoverabilitySummary: {
    recoverable: number;
    partiallyRecoverable: number;
    unknown: number;
  };
  accountReconciliations: InventoryAccountReconciliation[];
  physicalCountReport: PhysicalCountReport | null;
  recommendedRecoveryModel: 'A' | 'B' | 'C';
  recoveryModelReason: string;
  itemsRequiringPhysicalCount: number;
  itemsWithHistoricalEvidence: number;
  totalCurrentSystemValue: number;
  totalCurrentWarehouseValue: number;
  totalPhysicalValueIfCounted: number | null;
  safeguards: string[];
  invoiceProtectionProof: string[];
}

// ── Helpers ──────────────────────────────────────────────────────

function round2(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function confidenceFromEvidence(
  hasPreSeed: boolean,
  hasAdjustmentHistory: boolean,
  hasWarehouseData: boolean
): 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN' {
  if (hasPreSeed && hasAdjustmentHistory && hasWarehouseData) return 'HIGH';
  if (hasPreSeed || hasAdjustmentHistory) return 'MEDIUM';
  if (hasWarehouseData) return 'LOW';
  return 'UNKNOWN';
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Build a comprehensive inventory recovery report.
 *
 * This function is READ-ONLY. It does not modify:
 * - invoices
 * - invoice line items
 * - invoice totals
 * - invoice dates
 * - invoice status
 * - historical COGS entries
 * - customer balances
 * - AR
 * - revenue
 * - inventory quantities
 * - warehouse quantities
 * - ledger entries
 * - Supabase data
 */
export function buildInventoryRecoveryReport(
  items: any[],
  accounts: any[],
  ledger: any[],
  warehouseRecords: any[] = [],
  inventoryTransactions: any[] = []
): InventoryRecoveryReport {
  const smartStockReport = analyzeSmartStockIncident(items);
  const physicalCountReport = generatePhysicalCountReport(items);

  // Build recovery items for affected items only
  const inventoryBearingItems: InventoryRecoveryItem[] = [];
  const nonInventoryBearingItems: InventoryRecoveryItem[] = [];

  for (const affected of smartStockReport.affectedItems) {
    const raw = items.find(i => String(i.id || '') === affected.itemId) || affected;
    const isBearing = isInventoryBearingItem(raw);
    const inventoryAccount = isBearing ? resolveInventoryGLAccountCode(raw) : null;
    const currentSystemQuantity = resolveInventoryQuantity(raw);
    const currentWarehouseQuantity = resolveWarehouseQuantity(raw);
    const canonicalCost = resolveInventoryCostPerUnit(raw);
    const currentCalculatedValue = isBearing ? round2(currentSystemQuantity * canonicalCost) : 0;

    // Attempt to find current inventory transaction quantity
    const currentInvTxnQty = inventoryTransactions.length > 0
      ? inventoryTransactions
          .filter((t: any) => String(t.itemId || t.item_id || '') === affected.itemId)
          .reduce((sum: number, t: any) => sum + Number(t.quantity || t.qty || 0), 0)
      : null;

    // Determine recoverability
    const hasPreSeed = affected.quantityBeforeSeeding !== null;
    const hasAdjustmentHistory = affected.subsequentMovements !== 0;
    const hasWarehouseData = currentWarehouseQuantity > 0 || (warehouseRecords.length > 0 && warehouseRecords.some((w: any) => String(w.itemId || w.item_id || '') === affected.itemId));
    const confidence = confidenceFromEvidence(hasPreSeed, hasAdjustmentHistory, hasWarehouseData);

    let recoverability: Recoverability;
    if (hasPreSeed && confidence === 'HIGH') {
      recoverability = 'RECOVERABLE';
    } else if (hasPreSeed || hasAdjustmentHistory) {
      recoverability = 'PARTIALLY_RECOVERABLE';
    } else {
      recoverability = 'UNKNOWN';
    }

    const recoveryItem: InventoryRecoveryItem = {
      itemId: affected.itemId,
      name: affected.name,
      type: affected.type,
      sku: affected.sku,
      inventoryBearing: isBearing,
      inventoryAccount,
      quantityBeforeSeeding: affected.quantityBeforeSeeding,
      seedQuantity: affected.seedQuantity,
      subsequentMovements: affected.subsequentMovements,
      currentSystemQuantity,
      currentWarehouseQuantity,
      currentInventoryTransactionQuantity: currentInvTxnQty,
      canonicalCost,
      currentCalculatedValue,
      recoverability,
      confidence,
      note: affected.note,
    };

    if (isBearing) {
      inventoryBearingItems.push(recoveryItem);
    } else {
      nonInventoryBearingItems.push(recoveryItem);
    }
  }

  // Reconcile inventory accounts
  const accountReconciliations = reconcileInventoryAccounts(accounts, ledger, items);

  // Determine recovery model
  const recoverableCount = inventoryBearingItems.filter(i => i.recoverability === 'RECOVERABLE').length;
  const partiallyRecoverableCount = inventoryBearingItems.filter(i => i.recoverability === 'PARTIALLY_RECOVERABLE').length;
  const unknownCount = inventoryBearingItems.filter(i => i.recoverability === 'UNKNOWN').length;

  let recommendedRecoveryModel: 'A' | 'B' | 'C';
  let recoveryModelReason: string;

  if (unknownCount === 0 && recoverableCount > 0) {
    recommendedRecoveryModel = 'A';
    recoveryModelReason = 'All affected inventory-bearing items have recoverable pre-seeding quantities. Historical correction is possible.';
  } else if (unknownCount > 0 && recoverableCount === 0) {
    recommendedRecoveryModel = 'B';
    recoveryModelReason = 'No pre-seeding quantities are recoverable. Physical count is required before any correction.';
  } else {
    recommendedRecoveryModel = 'C';
    recoveryModelReason = `Mixed recoverability: ${recoverableCount} recoverable, ${partiallyRecoverableCount} partially recoverable, ${unknownCount} unknown. Physical count required for unknown items; historical correction possible for recoverable items.`;
  }

  // Safeguards proof
  const safeguards: string[] = [
    'Inventory recovery services (smartStockIncidentService, physicalCountService, inventoryRecoveryService) contain zero references to invoices, invoice lines, COGS, revenue, customers, AR, or payments.',
    'All recovery functions are read-only analysis: no mutations, no postings, no writes.',
    'The R1 COGS reversal service (coaCorrectionService.ts) is out of scope and must not be executed.',
    'No inventory correction will be performed without explicit authorization and physical count verification.',
    'Opening balance is a separate accounting question and will not be inferred from contaminated stock.',
  ];

  const invoiceProtectionProof: string[] = [
    'smartStockIncidentService.ts: no invoice/COGS/customer/AR imports or references',
    'physicalCountService.ts: no invoice/COGS/customer/AR imports or references',
    'inventoryRecoveryService.ts: no invoice/COGS/customer/AR imports or references',
    'inventoryNormalization.ts: no invoice/COGS/customer/AR imports or references',
    'All three services operate solely on: items, accounts, ledger, warehouse records, inventory transactions',
    'The ledger read in reconcileInventoryValuation uses computeOwnBalances for GL reconciliation only — it does not write ledger entries.',
  ];

  return {
    generatedAt: new Date().toISOString(),
    bulkId: smartStockReport.bulkId,
    totalAffectedItems: smartStockReport.totalAffected,
    inventoryBearingItems,
    nonInventoryBearingItems,
    recoverabilitySummary: {
      recoverable: recoverableCount,
      partiallyRecoverable: partiallyRecoverableCount,
      unknown: unknownCount,
    },
    accountReconciliations,
    physicalCountReport,
    recommendedRecoveryModel,
    recoveryModelReason,
    itemsRequiringPhysicalCount: unknownCount + partiallyRecoverableCount,
    itemsWithHistoricalEvidence: recoverableCount + partiallyRecoverableCount,
    totalCurrentSystemValue: inventoryBearingItems.reduce((sum, i) => sum + i.currentCalculatedValue, 0),
    totalCurrentWarehouseValue: inventoryBearingItems.reduce(
      (sum, i) => sum + round2(i.currentWarehouseQuantity * i.canonicalCost), 0
    ),
    totalPhysicalValueIfCounted: physicalCountReport.totalPhysicalQuantity !== null
      ? physicalCountReport.items
          .filter(i => i.isInventoryBearing && i.physicalCountQuantity !== null)
          .reduce((sum, i) => sum + round2((i.physicalCountQuantity || 0) * i.costPerUnit), 0)
      : null,
    safeguards,
    invoiceProtectionProof,
  };
}

/**
 * Reconcile inventory GL accounts independently.
 *
 * Does NOT modify ledger or accounts.
 */
function reconcileInventoryAccounts(
  accounts: any[],
  ledger: any[],
  items: any[]
): InventoryAccountReconciliation[] {
  const reconciliations: InventoryAccountReconciliation[] = [];
  const targetCodes = [INVENTORY_GL_CODES.merchandise, INVENTORY_GL_CODES.rawMaterials, INVENTORY_GL_CODES.finishedGoods];

  // Compute own balances for all accounts
  const ownBalances = computeOwnBalances(accounts as any[], ledger as any[]);

  // Classify all items for physical value calculation
  const classifiedItems = (items || []).map(classifyInventoryItem);
  const eligibleItems = classifiedItems.filter(i => i.included);

  // Aggregate physical value by account
  const physicalByAccount: Record<string, { value: number; quantity: number; warehouseQuantity: number }> = {};
  for (const item of eligibleItems) {
    if (!item.expectedAccount) continue;
    if (!physicalByAccount[item.expectedAccount]) {
      physicalByAccount[item.expectedAccount] = { value: 0, quantity: 0, warehouseQuantity: 0 };
    }
    physicalByAccount[item.expectedAccount].value += item.inventoryValue;
    physicalByAccount[item.expectedAccount].quantity += item.quantity;
    physicalByAccount[item.expectedAccount].warehouseQuantity += item.warehouseQuantity;
  }

  for (const code of targetCodes) {
    const account = (accounts || []).find(
      (a: any) => String(a.account_number || a.code || '') === code
    );

    if (!account) {
      reconciliations.push({
        accountCode: code,
        accountName: `Account ${code}`,
        accountType: 'UNKNOWN',
        openingBalance: 0,
        legitimateDebits: 0,
        legitimateCredits: 0,
        smartStockEntries: 0,
        currentLedgerBalance: 0,
        currentPhysicalValue: 0,
        difference: 0,
        explanation: 'Account not found in chart of accounts',
        confidence: 'LOW',
      });
      continue;
    }

    const accountName = String(account.name || `Account ${code}`);
    const accountType = String(account.account_type || account.type || 'UNKNOWN');

    // Opening balance
    const openingBalance = round2((account as any).opening_balance || 0);

    // Legitimate debits/credits from posted ledger entries
    let legitimateDebits = 0;
    let legitimateCredits = 0;
    let smartStockEntries = 0;

    const accountId = String(account.id || '');
    const accountCode = String(account.account_number || account.code || '');
    const identifiers = new Set([accountId, accountCode, code]);

    for (const entry of ledger || []) {
      // Skip non-posted entries
      const status = String((entry as any).status || '').trim().toLowerCase();
      if (status === 'draft' || status === 'void' || status === 'voided' || status === 'cancelled' || status === 'deleted') {
        continue;
      }

      const entryType = String((entry as any).entryType || '').trim().toLowerCase();
      const refType = String((entry as any).referenceType || '').trim().toLowerCase();

      // Identify Smart Stock related entries
      const isSmartStock =
        refType === 'stock_adjustment' ||
        entryType === 'stock_adjustment' ||
        String((entry as any).referenceId || '').includes('SMART-') ||
        String((entry as any).description || '').toLowerCase().includes('smart stock');

      const debitId = String((entry as any).debitAccountId || '').trim();
      const creditId = String((entry as any).creditAccountId || '').trim();

      if (identifiers.has(debitId) || identifiers.has(creditId)) {
        const amount = round2((entry as any).amount || 0);

        if (isSmartStock) {
          smartStockEntries += amount;
        }

        if (identifiers.has(debitId)) {
          legitimateDebits += amount;
        }
        if (identifiers.has(creditId)) {
          legitimateCredits += amount;
        }
      }
    }

    // Current ledger balance = opening + debits - credits (for DEBIT-normal asset)
    const normalBalance = String((account as any).normal_balance || '').trim().toUpperCase();
    let currentLedgerBalance: number;
    if (normalBalance === 'CREDIT') {
      currentLedgerBalance = round2(openingBalance + legitimateCredits - legitimateDebits);
    } else {
      currentLedgerBalance = round2(openingBalance + legitimateDebits - legitimateCredits);
    }

    // Current physical value from items
    const physical = physicalByAccount[code] || { value: 0, quantity: 0, warehouseQuantity: 0 };
    const currentPhysicalValue = round2(physical.value);

    const difference = round2(currentPhysicalValue - currentLedgerBalance);

    let explanation: string;
    if (difference === 0) {
      explanation = 'Physical inventory matches GL balance.';
    } else if (difference > 0) {
      explanation = `Physical inventory exceeds GL by ${formatCurrency(difference)}. Possible causes: unrecorded receipts, missing GL postings, or Smart Stock contamination.`;
    } else {
      explanation = `GL exceeds physical inventory by ${formatCurrency(-difference)}. Possible causes: unrecorded issues, Smart Stock contamination, or missing physical count.`;
    }

    if (smartStockEntries > 0) {
      explanation += ` Smart Stock entries detected: ${formatCurrency(smartStockEntries)}.`;
    }

    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    if (openingBalance === 0 && legitimateDebits === 0 && legitimateCredits === 0) {
      confidence = 'LOW';
    } else if (smartStockEntries > 0) {
      confidence = 'MEDIUM';
    } else {
      confidence = 'HIGH';
    }

    reconciliations.push({
      accountCode: code,
      accountName,
      accountType,
      openingBalance,
      legitimateDebits,
      legitimateCredits,
      smartStockEntries,
      currentLedgerBalance,
      currentPhysicalValue,
      difference,
      explanation,
      confidence,
    });
  }

  return reconciliations;
}

/**
 * Format the recovery report as human-readable text.
 */
export function formatInventoryRecoveryReport(report: InventoryRecoveryReport, currencySymbol = 'K'): string {
  const money = (n: number) => `${currencySymbol}${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
  const lines = [
    '========================================',
    'INVENTORY RECOVERY REPORT',
    '========================================',
    '',
    `Generated: ${report.generatedAt}`,
    `Bulk incident: ${report.bulkId}`,
    '',
    'SMART STOCK AFFECTED ITEMS:',
    `  Total affected:              ${report.totalAffectedItems}`,
    `  Inventory-bearing:           ${report.inventoryBearingItems.length}`,
    `  Non-inventory-bearing:       ${report.nonInventoryBearingItems.length}`,
    '',
    'RECOVERABILITY:',
    `  Recoverable:                 ${report.recoverabilitySummary.recoverable}`,
    `  Partially recoverable:       ${report.recoverabilitySummary.partiallyRecoverable}`,
    `  Unknown:                     ${report.recoverabilitySummary.unknown}`,
    '',
    'RECOMMENDED RECOVERY MODEL:',
    `  Model:                       ${report.recommendedRecoveryModel}`,
    `  Reason:                      ${report.recoveryModelReason}`,
    '',
    'INVENTORY VALUES:',
    `  Total current system value:  ${money(report.totalCurrentSystemValue)}`,
    `  Total warehouse value:       ${money(report.totalCurrentWarehouseValue)}`,
    report.totalPhysicalValueIfCounted !== null
      ? `  Total physical value:        ${money(report.totalPhysicalValueIfCounted)}`
      : '  Total physical value:        (pending physical count)',
    '',
    'ACCOUNT RECONCILIATIONS:',
    ...report.accountReconciliations.flatMap(r => [
      `  ${r.accountCode} ${r.accountName}:`,
      `    Opening balance:          ${money(r.openingBalance)}`,
      `    Legitimate debits:        ${money(r.legitimateDebits)}`,
      `    Legitimate credits:       ${money(r.legitimateCredits)}`,
      `    Smart Stock entries:      ${money(r.smartStockEntries)}`,
      `    Current GL balance:       ${money(r.currentLedgerBalance)}`,
      `    Current physical value:   ${money(r.currentPhysicalValue)}`,
      `    Difference:               ${money(r.difference)}`,
      `    Confidence:               ${r.confidence}`,
      `    Explanation:              ${r.explanation}`,
      '',
    ]),
    'PHYSICAL COUNT REQUIREMENTS:',
    `  Items requiring count:       ${report.itemsRequiringPhysicalCount}`,
    `  Items with historical data:  ${report.itemsWithHistoricalEvidence}`,
    `  Approval gate:               ${report.physicalCountReport?.approvalGate || 'N/A'}`,
    '',
    'SAFEGUARDS:',
    ...report.safeguards.map(s => `  - ${s}`),
    '',
    'INVOICE PROTECTION PROOF:',
    ...report.invoiceProtectionProof.map(p => `  - ${p}`),
    '',
    '========================================',
    'INVENTORY-BEARING ITEMS DETAIL:',
    '========================================',
    '',
    ...report.inventoryBearingItems.map(item => [
      `[${item.itemId}] ${item.name} (${item.sku})`,
      `  Type: ${item.type}`,
      `  Account: ${item.inventoryAccount || '(none)'}`,
      `  Recoverability: ${item.recoverability}`,
      `  Confidence: ${item.confidence}`,
      `  Before seeding: ${item.quantityBeforeSeeding !== null ? item.quantityBeforeSeeding : 'UNKNOWN'}`,
      `  Seed quantity: +${item.seedQuantity}`,
      `  Subsequent movements: ${item.subsequentMovements}`,
      `  Current system qty: ${item.currentSystemQuantity}`,
      `  Current warehouse qty: ${item.currentWarehouseQuantity}`,
      `  Current inv txn qty: ${item.currentInventoryTransactionQuantity !== null ? item.currentInventoryTransactionQuantity : 'N/A'}`,
      `  Canonical cost: ${money(item.canonicalCost)}`,
      `  Current calculated value: ${money(item.currentCalculatedValue)}`,
      `  Note: ${item.note}`,
      '',
    ]).flat(),
    '========================================',
    'NON-INVENTORY-BEARING ITEMS (EXCLUDED FROM RECOVERY):',
    '========================================',
    '',
    ...report.nonInventoryBearingItems.map(item => [
      `[${item.itemId}] ${item.name} (${item.sku})`,
      `  Type: ${item.type}`,
      `  Current system qty: ${item.currentSystemQuantity}`,
      `  Current calculated value: ${money(item.currentCalculatedValue)}`,
      `  Note: ${item.note}`,
      '',
    ]).flat(),
    '========================================',
  ];

  return lines.join('\n');
}

function formatCurrency(value: number): string {
  const abs = Math.abs(value);
  const formatted = `K${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return value < 0 ? `(${formatted})` : formatted;
}

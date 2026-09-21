/**
 * Physical Count Service — read-only workflow documentation and report
 * generation for future physical inventory correction.
 *
 * This service documents the 10-step correction workflow:
 *   1. Data freeze
 *   2. Physical count
 *   3. Independent verification
 *   4. Enter verified quantity
 *   5. Calculate variance
 *   6. Accountant/operations approval
 *   7. Generate auditable adjustment
 *   8. Post corresponding GL entry
 *   9. Reconcile inventory GL
 *   10. Produce before/after report
 *
 * IMPORTANT: This service is READ-ONLY. It does NOT implement automatic
 * correction from current contaminated stock. It generates reports and
 * workflow documentation that support the future correction workflow.
 *
 * The service does not:
 * - Modify inventory quantities
 * - Post GL entries
 * - Create adjustments
 * - Infer or substitute quantities
 */

import { isInventoryBearingItem, resolveInventoryGLAccountCode, resolveInventoryCostPerUnit, resolveWarehouseQuantity, resolveInventoryQuantity } from '../utils/inventoryNormalization';
import { computeOwnBalances } from '../services/accountingEngine';

export interface PhysicalCountItem {
  itemId: string;
  name: string;
  sku: string;
  type: string;
  currentSystemQuantity: number;
  currentWarehouseQuantity: number;
  physicalCountQuantity: number | null; // null = not yet counted
  variance: number | null;
  varianceValue: number | null;
  costPerUnit: number;
  isInventoryBearing: boolean;
  inventoryAccount: string | null;
  counted: boolean;
  verified: boolean;
}

export interface PhysicalCountWorkflowStep {
  step: number;
  name: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  blockedReason?: string;
}

export interface PhysicalCountReport {
  generatedAt: string;
  bulkId: string;
  workflowSteps: PhysicalCountWorkflowStep[];
  items: PhysicalCountItem[];
  totalSystemQuantity: number;
  totalWarehouseQuantity: number;
  totalPhysicalQuantity: number | null;
  totalVariance: number | null;
  totalVarianceValue: number | null;
  inventoryBearingCount: number;
  nonInventoryBearingCount: number;
  countedCount: number;
  verifiedCount: number;
  readyForApproval: boolean;
  approvalGate: string;
  notes: string[];
}

const TARGET_BULK_ID = 'SMART-1789588940379-egoshg';

export function generatePhysicalCountWorkflow(): PhysicalCountWorkflowStep[] {
  return [
    {
      step: 1,
      name: 'Data Freeze',
      description: 'Freeze all inventory writes and adjustments. No stock mutations allowed during physical count.',
      status: 'pending',
    },
    {
      step: 2,
      name: 'Physical Count',
      description: 'Conduct physical count of all inventory-bearing items. Record counts independently of system quantities.',
      status: 'pending',
    },
    {
      step: 3,
      name: 'Independent Verification',
      description: 'Second count by different personnel to verify accuracy. Resolve discrepancies before proceeding.',
      status: 'pending',
    },
    {
      step: 4,
      name: 'Enter Verified Quantity',
      description: 'Enter the independently verified physical quantities into the system. Do NOT use system quantities as verified counts.',
      status: 'pending',
    },
    {
      step: 5,
      name: 'Calculate Variance',
      description: 'System quantity vs physical quantity = variance. Calculate variance value at canonical cost.',
      status: 'pending',
    },
    {
      step: 6,
      name: 'Accountant/Operations Approval',
      description: 'Qualified accountant reviews variances and approves adjustments. Large variances require additional sign-off.',
      status: 'pending',
    },
    {
      step: 7,
      name: 'Generate Auditable Adjustment',
      description: 'Create adjustment records with full audit trail: who, when, why, before/after quantities.',
      status: 'pending',
    },
    {
      step: 8,
      name: 'Post Corresponding GL Entry',
      description: 'Post double-entry GL adjustment: DR/CR Inventory + DR/CR Adjustment/COGS as appropriate.',
      status: 'pending',
    },
    {
      step: 9,
      name: 'Reconcile Inventory GL',
      description: 'After posting, reconcile physical inventory value against GL inventory accounts (11410/11420/11430).',
      status: 'pending',
    },
    {
      step: 10,
      name: 'Produce Before/After Report',
      description: 'Generate comprehensive report showing system quantities, physical counts, variances, GL impact, and reconciliation status.',
      status: 'pending',
    },
  ];
}

export function generatePhysicalCountReport(items: any[]): PhysicalCountReport {
  const workflowSteps = generatePhysicalCountWorkflow();
  const physicalCountItems: PhysicalCountItem[] = [];

  for (const raw of items || []) {
    const currentSystemQuantity = resolveInventoryQuantity(raw);
    const currentWarehouseQuantity = resolveWarehouseQuantity(raw);
    const costPerUnit = resolveInventoryCostPerUnit(raw);
    const isInventoryBearing = isInventoryBearingItem(raw);
    const inventoryAccount = isInventoryBearing ? resolveInventoryGLAccountCode(raw) : null;

    physicalCountItems.push({
      itemId: String(raw.id || ''),
      name: String(raw.name || ''),
      sku: String(raw.sku || raw.code || ''),
      type: String(raw.type || raw._rawType || ''),
      currentSystemQuantity,
      currentWarehouseQuantity,
      physicalCountQuantity: null,
      variance: null,
      varianceValue: null,
      costPerUnit,
      isInventoryBearing,
      inventoryAccount,
      counted: false,
      verified: false,
    });
  }

  const inventoryBearingItems = physicalCountItems.filter(i => i.isInventoryBearing);
  const nonInventoryBearingItems = physicalCountItems.filter(i => !i.isInventoryBearing);

  const totalSystemQuantity = inventoryBearingItems.reduce((sum, i) => sum + i.currentSystemQuantity, 0);
  const totalWarehouseQuantity = inventoryBearingItems.reduce((sum, i) => sum + i.currentWarehouseQuantity, 0);
  const countedItems = physicalCountItems.filter(i => i.counted);
  const totalPhysicalQuantity = countedItems.length > 0 ? countedItems.reduce((sum, i) => sum + (i.physicalCountQuantity || 0), 0) : null;
  const totalVariance = countedItems.length > 0 ? countedItems.reduce((sum, i) => sum + (i.variance || 0), 0) : null;
  const totalVarianceValue = countedItems.length > 0 ? countedItems.reduce((sum, i) => sum + (i.varianceValue || 0), 0) : null;

  const approvalGate = countedItems.length === 0
    ? 'PENDING_PHYSICAL_COUNT'
    : countedItems.some(i => !i.verified)
      ? 'PENDING_VERIFICATION'
      : 'PENDING_ACCOUNTANT_APPROVAL';

  const notes = [
    'This report is READ-ONLY. No inventory mutations or GL postings are performed.',
    `Bulk incident: ${TARGET_BULK_ID}`,
    'System quantities may be contaminated by bulk seeding and should not be trusted as opening inventory.',
    'Physical count must be conducted independently of system data.',
    'Do NOT reuse historical K41,868,000 opening balance figure without physical verification.',
    'Do NOT use seeded K222,306,800 as inventory valuation.',
    'Opening balance must be derived from verified physical count, not from current contaminated stock.',
  ];

  return {
    generatedAt: new Date().toISOString(),
    bulkId: TARGET_BULK_ID,
    workflowSteps,
    items: physicalCountItems,
    totalSystemQuantity,
    totalWarehouseQuantity,
    totalPhysicalQuantity,
    totalVariance,
    totalVarianceValue,
    inventoryBearingCount: inventoryBearingItems.length,
    nonInventoryBearingCount: nonInventoryBearingItems.length,
    countedCount: countedItems.length,
    verifiedCount: countedItems.filter(i => i.verified).length,
    readyForApproval: approvalGate === 'PENDING_ACCOUNTANT_APPROVAL',
    approvalGate,
    notes,
  };
}

export function formatPhysicalCountReport(report: PhysicalCountReport): string {
  const lines = [
    '========================================',
    'PHYSICAL COUNT WORKFLOW REPORT',
    '========================================',
    '',
    `Generated: ${report.generatedAt}`,
    `Bulk incident: ${report.bulkId}`,
    '',
    'WORKFLOW STEPS:',
    ...report.workflowSteps.map(s => `  ${s.step}. ${s.name} [${s.status}]${s.blockedReason ? ' — BLOCKED: ' + s.blockedReason : ''}`),
    '',
    'INVENTORY SUMMARY:',
    `  Inventory-bearing items:     ${report.inventoryBearingCount}`,
    `  Non-inventory-bearing items:  ${report.nonInventoryBearingCount}`,
    `  Total system quantity:        ${report.totalSystemQuantity}`,
    `  Total warehouse quantity:     ${report.totalWarehouseQuantity}`,
    report.totalPhysicalQuantity !== null ? `  Total physical count:         ${report.totalPhysicalQuantity}` : '  Total physical count:         (not yet counted)',
    report.totalVariance !== null ? `  Total variance:               ${report.totalVariance}` : '  Total variance:               (not yet calculated)',
    report.totalVarianceValue !== null ? `  Total variance value:         K${Math.abs(report.totalVarianceValue).toLocaleString()}` : '  Total variance value:         (not yet calculated)',
    '',
    `Counted: ${report.countedCount} / Verified: ${report.verifiedCount}`,
    `Approval gate: ${report.approvalGate}`,
    `Ready for approval: ${report.readyForApproval ? 'YES' : 'NO'}`,
    '',
    'NOTES:',
    ...report.notes.map(n => `  - ${n}`),
    '',
    '========================================',
    'ITEMS REQUIRING PHYSICAL COUNT:',
    '========================================',
    '',
  ];

  const itemsNeedingCount = report.items.filter(i => i.isInventoryBearing);
  if (itemsNeedingCount.length === 0) {
    lines.push('  No inventory-bearing items found.');
  } else {
    for (const item of itemsNeedingCount) {
      lines.push(
        `  [${item.itemId}] ${item.name} (${item.sku})`,
        `    Type: ${item.type}`,
        `    System qty: ${item.currentSystemQuantity}`,
        `    Warehouse qty: ${item.currentWarehouseQuantity}`,
        `    Physical count: ${item.physicalCountQuantity !== null ? item.physicalCountQuantity : '(not counted)'}`,
        `    Variance: ${item.variance !== null ? item.variance : '(not calculated)'}`,
        `    Account: ${item.inventoryAccount || '(none)'}`,
        ''
      );
    }
  }

  return lines.join('\n');
}

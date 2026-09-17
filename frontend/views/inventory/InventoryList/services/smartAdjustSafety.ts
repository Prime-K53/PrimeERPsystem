import type { Item } from '../../../../types';
import {
  isInventoryBearingItem,
  resolveInventoryCostPerUnit,
  resolveInventoryGLAccountCode,
} from '../../../../utils/inventoryNormalization';

/**
 * Smart Adjust bulk-containment policy (2026-09-17 incident response).
 *
 * The 2026-09-16 incident applied an unreviewed +500 ADD to all 100 active
 * items through one bulk click (`no selection → all items`, no
 * confirmation, no type filter). Every rule below is a pure function so the
 * containment itself is unit-testable, including an exact replay of the
 * incident pattern (100 items, no selection, qty 500 → NO MUTATION).
 *
 * Layers (all must pass before any mutation):
 *   1. explicit selection (never inferred)
 *   2. inventory eligibility (authoritative isInventoryBearingItem)
 *   3. bulk scope limit (no automatic batching)
 *   4. magnitude acknowledgement for large impacts
 *   5. sync health (refuse from clearly unsynced state)
 *   6. explicit confirmation (mutation only from the Confirm action)
 *   7. existing `inventory.adjust` permission + service-level guard
 */

export type SmartAdjustType = 'ADD' | 'REMOVE' | 'SET';

/** Conservative cap: at most this many eligible items per bulk operation. */
export const SMART_ADJUST_MAX_ITEMS = 20;

/**
 * Documented conservative constant for the extra-acknowledgement gate below.
 * Not a business or accounting policy — purely a "pause and re-read" tripwire
 * for unusually large bulk impacts.
 */
export const SMART_ADJUST_LARGE_VALUE_THRESHOLD = 1_000_000;

/** Per-line anomaly factor: |delta| beyond this multiple of current stock. */
export const SMART_ADJUST_LARGE_LINE_FACTOR = 10;

export type SmartAdjustBlockCode =
  | 'EMPTY_SELECTION'
  | 'NO_ELIGIBLE_ITEMS'
  | 'LIMIT_EXCEEDED'
  | 'SYNC_NOT_CURRENT'
  | 'MISSING_PERMISSION'
  | 'NOT_CONFIRMED'
  | 'INVALID_QUANTITY'
  | 'LARGE_IMPACT_UNACKNOWLEDGED';

export interface SmartAdjustTarget {
  item: Item;
}

export interface SmartAdjustIneligible {
  item: Item;
  reason: 'non-stock-type' | 'unknown-type';
}

export interface SmartAdjustLineImpact {
  itemId: string;
  name: string;
  sku: string;
  previousStock: number;
  delta: number;
  resultingStock: number;
  unitCost: number;
  valueChange: number;
  accountCode: string | null;
}

export interface SmartAdjustImpact {
  lines: SmartAdjustLineImpact[];
  totalValueChange: number;
  totalAbsValue: number;
  accountCodes: string[];
}

export interface SmartAdjustSyncSnapshot {
  online: boolean;
  isSyncing: boolean;
  consecutiveFailures: number;
  deadLetter: number;
  pending: number;
}

export interface SmartAdjustGateResult {
  ok: boolean;
  code: SmartAdjustBlockCode | null;
  message: string | null;
}

/** 1. Explicit selection — ids must be stated; nothing is ever inferred. */
export function resolveSmartAdjustTargets(
  items: Item[],
  selectedIds: string[]
): { targets: SmartAdjustTarget[]; gate: SmartAdjustGateResult } {
  const byId = new Map<string, Item>();
  for (const item of items || []) {
    if (item && item.id) byId.set(String(item.id), item);
  }
  const targets: SmartAdjustTarget[] = [];
  for (const id of selectedIds || []) {
    const item = byId.get(String(id));
    if (item) targets.push({ item });
  }
  if (targets.length === 0) {
    return {
      targets,
      gate: {
        ok: false,
        code: 'EMPTY_SELECTION',
        message: 'Select at least one inventory item before applying an adjustment.',
      },
    };
  }
  return { targets, gate: { ok: true, code: null, message: null } };
}

/**
 * 2. Eligibility — authoritative isInventoryBearingItem only.
 * Unknown/blank types fail closed (never adjusted).
 */
export function partitionSmartAdjustTargets(targets: SmartAdjustTarget[]): {
  eligible: Item[];
  ineligible: SmartAdjustIneligible[];
} {
  const eligible: Item[] = [];
  const ineligible: SmartAdjustIneligible[] = [];
  for (const { item } of targets) {
    const rawType = String((item as any)?.type ?? '');
    const rawClassification = String((item as any)?.classification ?? '');
    if (!rawType.trim() && !rawClassification.trim()) {
      ineligible.push({ item, reason: 'unknown-type' });
      continue;
    }
    if (isInventoryBearingItem(item)) eligible.push(item);
    else {
      ineligible.push({
        item,
        reason: rawType.trim() ? 'non-stock-type' : 'unknown-type',
      });
    }
  }
  return { eligible, ineligible };
}

/** 3. Bulk scope — hard cap, no automatic batching. */
export function checkSmartAdjustBulkLimit(eligibleCount: number): SmartAdjustGateResult {
  if (eligibleCount > SMART_ADJUST_MAX_ITEMS) {
    return {
      ok: false,
      code: 'LIMIT_EXCEEDED',
      message: `Bulk adjustment limit exceeded. Select at most ${SMART_ADJUST_MAX_ITEMS} items, or perform the adjustments in controlled batches.`,
    };
  }
  return { ok: true, code: null, message: null };
}

export function getSmartAdjustDelta(item: Item, type: SmartAdjustType, quantity: number): number {
  if (type === 'SET') return quantity - (Number(item.stock) || 0);
  if (type === 'REMOVE') return -Math.abs(quantity);
  return Math.abs(quantity);
}

/** Estimated inventory-value impact (authoritative unit cost, never SP). */
export function estimateSmartAdjustImpact(
  eligible: Item[],
  type: SmartAdjustType,
  quantity: number
): SmartAdjustImpact {
  const lines: SmartAdjustLineImpact[] = [];
  const accountSet = new Set<string>();
  let totalValueChange = 0;
  let totalAbsValue = 0;
  for (const item of eligible) {
    const previousStock = Number(item.stock) || 0;
    const delta = getSmartAdjustDelta(item, type, quantity);
    const unitCost = resolveInventoryCostPerUnit(item);
    const valueChange = Math.round(delta * unitCost * 100) / 100;
    const accountCode = resolveInventoryGLAccountCode(item);
    if (accountCode) accountSet.add(accountCode);
    totalValueChange = Math.round((totalValueChange + valueChange) * 100) / 100;
    totalAbsValue = Math.round((totalAbsValue + Math.abs(valueChange)) * 100) / 100;
    lines.push({
      itemId: String(item.id),
      name: String(item.name || ''),
      sku: String((item as any).sku || ''),
      previousStock,
      delta,
      resultingStock: previousStock + delta,
      unitCost,
      valueChange,
      accountCode,
    });
  }
  return {
    lines,
    totalValueChange,
    totalAbsValue,
    accountCodes: [...accountSet].sort(),
  };
}

/**
 * 4. Magnitude — large impacts need an extra explicit acknowledgement
 * (checkbox in the review step). Never silently blocks legitimate work;
 * the delta itself is always fully previewed.
 */
export function checkSmartAdjustMagnitude(impact: SmartAdjustImpact): {
  large: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (impact.totalAbsValue > SMART_ADJUST_LARGE_VALUE_THRESHOLD) {
    reasons.push(
      `Estimated inventory value impact K${Math.round(impact.totalAbsValue).toLocaleString('en-US')} exceeds the K${SMART_ADJUST_LARGE_VALUE_THRESHOLD.toLocaleString('en-US')} review threshold.`
    );
  }
  for (const line of impact.lines) {
    if (line.previousStock > 0 && Math.abs(line.delta) > SMART_ADJUST_LARGE_LINE_FACTOR * line.previousStock) {
      reasons.push(
        `${line.name || line.itemId}: change of ${line.delta} is more than ${SMART_ADJUST_LARGE_LINE_FACTOR}× current stock (${line.previousStock}).`
      );
      break;
    }
  }
  return { large: reasons.length > 0, reasons };
}

/**
 * 5. Sync safety — refuse from clearly unsynced state, using only the
 * existing backgroundSyncService/durableSyncQueue signals. A non-zero
 * pending queue alone is a warning (background sync drains continuously),
 * never a block.
 *
 * Honest limitation: no client can prove cloud freshness; this gate blocks
 * only states the app can *clearly* determine are unsafe.
 */
export function checkSmartAdjustSync(snapshot: SmartAdjustSyncSnapshot): SmartAdjustGateResult {
  if (!snapshot.online) {
    return {
      ok: false,
      code: 'SYNC_NOT_CURRENT',
      message: 'Inventory synchronization is not current. Refresh/synchronize inventory before making a bulk stock adjustment. No stock changes were made.',
    };
  }
  if (snapshot.isSyncing) {
    return {
      ok: false,
      code: 'SYNC_NOT_CURRENT',
      message: 'Inventory synchronization is running. Wait for it to finish, then review and confirm again. No stock changes were made.',
    };
  }
  if (snapshot.consecutiveFailures > 0) {
    return {
      ok: false,
      code: 'SYNC_NOT_CURRENT',
      message: 'Inventory synchronization is not current. Refresh/synchronize inventory before making a bulk stock adjustment. No stock changes were made.',
    };
  }
  if (snapshot.deadLetter > 0) {
    return {
      ok: false,
      code: 'SYNC_NOT_CURRENT',
      message: 'Inventory synchronization has failed operations awaiting review. Resolve them before making a bulk stock adjustment. No stock changes were made.',
    };
  }
  return { ok: true, code: null, message: null };
}

/** Snapshot the existing sync signals (impure boundary, kept out of the pure gates). */
export async function readSmartAdjustSyncSnapshot(deps: {
  getSyncState: () => Promise<{
    isSyncing: boolean;
    consecutiveFailures: number;
    queueMetrics: { pending: number; deadLetter: number };
  }>;
  isOnline: () => boolean;
}): Promise<SmartAdjustSyncSnapshot> {
  const online = deps.isOnline();
  try {
    const state = await deps.getSyncState();
    return {
      online,
      isSyncing: state.isSyncing === true,
      consecutiveFailures: Number(state.consecutiveFailures) || 0,
      deadLetter: Number(state.queueMetrics?.deadLetter) || 0,
      pending: Number(state.queueMetrics?.pending) || 0,
    };
  } catch {
    // If sync state itself is unreadable, fail closed: treat as not current.
    return { online, isSyncing: false, consecutiveFailures: 1, deadLetter: 0, pending: 0 };
  }
}

export interface SmartAdjustApplyDecision {
  ok: boolean;
  code: SmartAdjustBlockCode | null;
  message: string | null;
  eligible: Item[];
  ineligible: SmartAdjustIneligible[];
  impact: SmartAdjustImpact | null;
  requiresLargeImpactAck: boolean;
}

/**
 * 6. Combined apply-time decision. `confirmed` must come from the review
 * step's explicit Confirm action; `largeImpactAcked` from its checkbox.
 * `hasAdjustPermission` is the existing `inventory.adjust` permission.
 */
export function decideSmartAdjustApply(args: {
  items: Item[];
  selectedIds: string[];
  type: SmartAdjustType;
  quantity: number;
  confirmed: boolean;
  largeImpactAcked: boolean;
  hasAdjustPermission: boolean;
  sync: SmartAdjustSyncSnapshot;
}): SmartAdjustApplyDecision {
  const empty: SmartAdjustApplyDecision = {
    ok: false,
    code: null,
    message: null,
    eligible: [],
    ineligible: [],
    impact: null,
    requiresLargeImpactAck: false,
  };
  if (!args.hasAdjustPermission) {
    return { ...empty, code: 'MISSING_PERMISSION', message: 'Bulk stock adjustment requires the Adjust Stock permission.' };
  }
  if (!Number.isFinite(args.quantity) || args.quantity <= 0) {
    return { ...empty, code: 'INVALID_QUANTITY', message: 'Enter a quantity greater than zero.' };
  }
  const resolved = resolveSmartAdjustTargets(args.items, args.selectedIds);
  if (!resolved.gate.ok) return { ...empty, code: resolved.gate.code, message: resolved.gate.message };
  const { eligible, ineligible } = partitionSmartAdjustTargets(resolved.targets);
  if (eligible.length === 0) {
    return {
      ...empty,
      ineligible,
      code: 'NO_ELIGIBLE_ITEMS',
      message: 'None of the selected items support stock adjustment. Product, Service, and unknown item types are excluded.',
    };
  }
  const limit = checkSmartAdjustBulkLimit(eligible.length);
  if (!limit.ok) return { ...empty, eligible, ineligible, code: limit.code, message: limit.message };
  const syncGate = checkSmartAdjustSync(args.sync);
  if (!syncGate.ok) {
    const impact = estimateSmartAdjustImpact(eligible, args.type, args.quantity);
    return { ...empty, eligible, ineligible, impact, code: syncGate.code, message: syncGate.message };
  }
  const impact = estimateSmartAdjustImpact(eligible, args.type, args.quantity);
  const magnitude = checkSmartAdjustMagnitude(impact);
  if (magnitude.large && !args.largeImpactAcked) {
    return {
      ok: false,
      code: 'LARGE_IMPACT_UNACKNOWLEDGED',
      message: `${magnitude.reasons[0]} Tick the large-impact acknowledgement to proceed.`,
      eligible,
      ineligible,
      impact,
      requiresLargeImpactAck: true,
    };
  }
  if (!args.confirmed) {
    return {
      ok: false,
      code: 'NOT_CONFIRMED',
      message: 'Review the adjustment and press Confirm Adjustment to proceed. No stock changes were made.',
      eligible,
      ineligible,
      impact,
      requiresLargeImpactAck: magnitude.large,
    };
  }
  return { ok: true, code: null, message: null, eligible, ineligible, impact, requiresLargeImpactAck: false };
}

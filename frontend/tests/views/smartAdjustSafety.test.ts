/**
 * smartAdjustSafety.test.ts
 *
 * Containment tests for the 2026-09-16 Smart Adjust incident
 * (single bulk ADD +500 applied to all 100 active items with no selection,
 * no confirmation, and no type filter).
 *
 * All gates are pure functions in
 * views/inventory/InventoryList/services/smartAdjustSafety.ts, so the tests
 * prove containment without touching real business data.
 */
import { describe, it, expect } from 'vitest';
import {
  SMART_ADJUST_MAX_ITEMS,
  checkSmartAdjustBulkLimit,
  checkSmartAdjustSync,
  decideSmartAdjustApply,
  estimateSmartAdjustImpact,
  partitionSmartAdjustTargets,
  resolveSmartAdjustTargets,
  type SmartAdjustSyncSnapshot,
} from '../../views/inventory/InventoryList/services/smartAdjustSafety';

const healthySync: SmartAdjustSyncSnapshot = {
  online: true,
  isSyncing: false,
  consecutiveFailures: 0,
  deadLetter: 0,
  pending: 0,
};

const item = (id: string, type?: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Item ${id}`,
  sku: `SKU-${id}`,
  type,
  stock: 50,
  cost: 100,
  costPrice: 100,
  status: 'Active',
  ...extra,
});

const decide = (overrides: Record<string, unknown> = {}) =>
  decideSmartAdjustApply({
    items: [],
    selectedIds: [],
    type: 'ADD',
    quantity: 10,
    confirmed: true,
    largeImpactAcked: true,
    hasAdjustPermission: true,
    sync: healthySync,
    ...overrides,
  } as Parameters<typeof decideSmartAdjustApply>[0]);

describe('selection containment', () => {
  it('1. no selected items → blocked (never inferred)', () => {
    const items = [item('R1', 'Raw Material'), item('S1', 'Stationery')];
    const { targets, gate } = resolveSmartAdjustTargets(items, []);
    expect(targets).toEqual([]);
    expect(gate.ok).toBe(false);
    expect(gate.code).toBe('EMPTY_SELECTION');
  });

  it('unknown ids resolve to nothing (never the whole catalog)', () => {
    const items = [item('R1', 'Raw Material')];
    const { targets, gate } = resolveSmartAdjustTargets(items, ['NOPE']);
    expect(targets).toEqual([]);
    expect(gate.ok).toBe(false);
  });

  it('2/3. explicitly selected Raw Material / Stationery proceed', () => {
    const items = [item('R1', 'Raw Material'), item('S1', 'Stationery'), item('P1', 'Product')];
    const d = decide({ items, selectedIds: ['R1', 'S1'], quantity: 5 });
    expect(d.ok).toBe(true);
    expect(d.eligible.map((i) => i.id).sort()).toEqual(['R1', 'S1']);
  });
});

describe('eligibility gating', () => {
  it('4/5. Product and Service are excluded', () => {
    const items = [item('P1', 'Product'), item('V1', 'Service')];
    const { eligible, ineligible } = partitionSmartAdjustTargets(items.map((i) => ({ item: i as never })));
    expect(eligible).toEqual([]);
    expect(ineligible.map((e) => String(e.item.id)).sort()).toEqual(['P1', 'V1']);
  });

  it('6. mixed Product + Raw Material → only the Raw Material proceeds', () => {
    const items = [item('P1', 'Product', { stock: 500, cost: 2000 }), item('R1', 'Raw Material')];
    const d = decide({ items, selectedIds: ['P1', 'R1'], quantity: 5 });
    expect(d.ok).toBe(true);
    expect(d.eligible.map((i) => i.id)).toEqual(['R1']);
    expect(d.ineligible.map((e) => String(e.item.id))).toEqual(['P1']);
  });

  it('7. unknown/blank type fails closed', () => {
    const items = [item('U1', undefined), item('U2', 'Mystery')];
    const d = decide({ items, selectedIds: ['U1', 'U2'], quantity: 5 });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('NO_ELIGIBLE_ITEMS');
    expect(d.eligible).toEqual([]);
  });

  it('all-non-stock selection explains itself', () => {
    const items = [item('P1', 'Product')];
    const d = decide({ items, selectedIds: ['P1'], quantity: 5 });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('NO_ELIGIBLE_ITEMS');
    expect(d.message).toMatch(/Product/i);
  });
});

describe('confirmation gating', () => {
  it('8. mutation decision requires explicit confirmation', () => {
    const items = [item('R1', 'Raw Material')];
    const d = decide({ items, selectedIds: ['R1'], quantity: 5, confirmed: false });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('NOT_CONFIRMED');
    expect(d.impact).not.toBeNull();
  });

  it('9. cancel (unconfirmed) → zero eligible mutations released', () => {
    const items = [item('R1', 'Raw Material'), item('R2', 'Raw Material')];
    const d = decide({ items, selectedIds: ['R1', 'R2'], quantity: 5, confirmed: false });
    // The caller must release mutations only when ok === true.
    expect(d.ok).toBe(false);
  });

  it('10. confirm → exactly the intended eligible items', () => {
    const items = [item('R1', 'Raw Material'), item('R2', 'Raw Material'), item('P1', 'Product')];
    const d = decide({ items, selectedIds: ['R1', 'R2', 'P1'], quantity: 5 });
    expect(d.ok).toBe(true);
    expect(d.eligible.map((i) => i.id).sort()).toEqual(['R1', 'R2']);
  });

  it('missing permission blocks before anything else', () => {
    const items = [item('R1', 'Raw Material')];
    const d = decide({ items, selectedIds: ['R1'], hasAdjustPermission: false });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('MISSING_PERMISSION');
  });

  it('invalid quantity blocks', () => {
    const items = [item('R1', 'Raw Material')];
    expect(decide({ items, selectedIds: ['R1'], quantity: 0 }).code).toBe('INVALID_QUANTITY');
    expect(decide({ items, selectedIds: ['R1'], quantity: -3 }).code).toBe('INVALID_QUANTITY');
  });
});

describe('bulk scope', () => {
  it('11. above the configured maximum → blocked, no auto-batching', () => {
    expect(SMART_ADJUST_MAX_ITEMS).toBe(20);
    const items = Array.from({ length: 21 }, (_, i) => item(`R${i}`, 'Raw Material'));
    const d = decide({ items, selectedIds: items.map((i) => i.id), quantity: 1 });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('LIMIT_EXCEEDED');
    expect(d.eligible).toHaveLength(21);
  });

  it('12. at the maximum → allowed as one explicit batch', () => {
    const items = Array.from({ length: 20 }, (_, i) => item(`R${i}`, 'Raw Material'));
    const d = decide({ items, selectedIds: items.map((i) => i.id), quantity: 1 });
    expect(d.ok).toBe(true);
    expect(checkSmartAdjustBulkLimit(20).ok).toBe(true);
    expect(checkSmartAdjustBulkLimit(21).ok).toBe(false);
  });
});

describe('sync safety', () => {
  it('13a. offline → blocked', () => {
    expect(checkSmartAdjustSync({ ...healthySync, online: false }).code).toBe('SYNC_NOT_CURRENT');
  });

  it('13b. syncing → blocked', () => {
    expect(checkSmartAdjustSync({ ...healthySync, isSyncing: true }).code).toBe('SYNC_NOT_CURRENT');
  });

  it('13c. recent sync failure → blocked', () => {
    expect(checkSmartAdjustSync({ ...healthySync, consecutiveFailures: 2 }).code).toBe('SYNC_NOT_CURRENT');
  });

  it('13d. dead letters → blocked', () => {
    expect(checkSmartAdjustSync({ ...healthySync, deadLetter: 1 }).code).toBe('SYNC_NOT_CURRENT');
  });

  it('14. healthy state → allowed (pending alone only warns, never blocks)', () => {
    expect(checkSmartAdjustSync(healthySync).ok).toBe(true);
    expect(checkSmartAdjustSync({ ...healthySync, pending: 7 }).ok).toBe(true);
  });

  it('blocked sync surfaces through the apply decision with zero release', () => {
    const items = [item('R1', 'Raw Material')];
    const d = decide({ items, selectedIds: ['R1'], sync: { ...healthySync, online: false } });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('SYNC_NOT_CURRENT');
  });
});

describe('magnitude acknowledgement', () => {
  it('large impacts require an extra explicit ack, then proceed', () => {
    const items = [item('R1', 'Raw Material', { stock: 1000, cost: 17000 })];
    const impact = estimateSmartAdjustImpact(items as never[], 'ADD', 500);
    expect(impact.totalAbsValue).toBe(8500000);
    const unacked = decide({ items, selectedIds: ['R1'], quantity: 500, largeImpactAcked: false });
    expect(unacked.ok).toBe(false);
    expect(unacked.code).toBe('LARGE_IMPACT_UNACKNOWLEDGED');
    const acked = decide({ items, selectedIds: ['R1'], quantity: 500, largeImpactAcked: true });
    expect(acked.ok).toBe(true);
  });

  it('ordinary impacts need no extra ack', () => {
    const items = [item('R1', 'Raw Material', { stock: 100, cost: 5 })];
    const d = decide({ items, selectedIds: ['R1'], quantity: 5, largeImpactAcked: false });
    expect(d.ok).toBe(true);
  });
});

describe('incident reproduction (2026-09-16 pattern)', () => {
  const incidentItems = () => {
    const list: ReturnType<typeof item>[] = [];
    for (let i = 0; i < 61; i++) list.push(item(`P${i}`, 'Product', { stock: 50, cost: 2000 }));
    for (let i = 0; i < 21; i++) list.push(item(`ST${i}`, 'Stationery', { stock: 50, cost: 100 }));
    for (let i = 0; i < 10; i++) list.push(item(`R${i}`, 'Raw Material', { stock: 50, cost: 100 }));
    for (let i = 0; i < 8; i++) list.push(item(`V${i}`, 'Service', { stock: 0, cost: 50 }));
    return list;
  };

  it('100 items, 61P/21S/10R/8V, qty 500, selection NONE → NO MUTATION', () => {
    const items = incidentItems();
    const d = decide({ items, selectedIds: [], quantity: 500 });
    expect(d.ok).toBe(false);
    expect(d.code).toBe('EMPTY_SELECTION');
    expect(d.eligible).toEqual([]);
  });

  it('100 items explicitly selected → still constrained (limit + eligibility)', () => {
    const items = incidentItems();
    const d = decide({ items, selectedIds: items.map((i) => i.id), quantity: 500 });
    expect(d.ok).toBe(false);
    // 31 eligible (21 Stationery + 10 Raw) exceeds the 20-item cap.
    expect(d.code).toBe('LIMIT_EXCEEDED');
    expect(d.eligible).toHaveLength(31);
    expect(d.ineligible).toHaveLength(69);
  });

  it('20 explicitly selected stocked items → the only releasable batch', () => {
    const items = incidentItems();
    const ids = [...Array.from({ length: 12 }, (_, i) => `ST${i}`), ...Array.from({ length: 8 }, (_, i) => `R${i}`)];
    const d = decide({ items, selectedIds: ids, quantity: 500, largeImpactAcked: true });
    expect(d.ok).toBe(true);
    expect(d.eligible).toHaveLength(20);
  });
});

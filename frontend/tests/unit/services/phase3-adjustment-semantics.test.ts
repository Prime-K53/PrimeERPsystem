import { describe, it, expect } from 'vitest';
import {
  applyAdjustmentsAdditive,
  getAdjustmentSortKey,
  isMarketAdjustmentActive,
  normalizeMarketAdjustmentType,
  sortMarketAdjustments,
} from '../../../utils/marketAdjustmentSemantics';
import { calculateExaminationBatchPricing } from '../../../src/domain/examination/pricingEngine';

describe('Phase 3 — canonical semantics helpers (B6)', () => {
  it("collapses PERCENT/percentage to PERCENTAGE, keeps FIXED", () => {
    expect(normalizeMarketAdjustmentType('PERCENTAGE')).toBe('PERCENTAGE');
    expect(normalizeMarketAdjustmentType('PERCENT')).toBe('PERCENTAGE');
    expect(normalizeMarketAdjustmentType('percentage')).toBe('PERCENTAGE');
    expect(normalizeMarketAdjustmentType('FIXED')).toBe('FIXED');
    expect(normalizeMarketAdjustmentType(undefined)).toBe('PERCENTAGE');
  });

  it('defaults missing flags to active, tolerates strings/numbers', () => {
    expect(isMarketAdjustmentActive({} as any)).toBe(true);
    expect(isMarketAdjustmentActive(null)).toBe(true);
    expect(isMarketAdjustmentActive(undefined)).toBe(true);
    expect(isMarketAdjustmentActive({ active: true } as any)).toBe(true);
    expect(isMarketAdjustmentActive({ active: 0 } as any)).toBe(false);
    expect(isMarketAdjustmentActive({ is_active: 'true' } as any)).toBe(true);
    expect(isMarketAdjustmentActive({ isActive: '0' } as any)).toBe(false);
    // The old masterInventory default (false on missing) is gone:
    expect(isMarketAdjustmentActive({ id: 'legacy-row' } as any)).toBe(true);
  });

  it('sorts by sort_order ?? sortOrder, then name', () => {
    expect(getAdjustmentSortKey({ sort_order: 3 } as any)).toBe(3);
    expect(getAdjustmentSortKey({ sortOrder: 2 } as any)).toBe(2);
    const sorted = sortMarketAdjustments([
      { id: 'b', name: 'B', sort_order: 2 },
      { id: 'a', name: 'A', sort_order: 1 },
    ] as any[]);
    expect(sorted.map((r: any) => r.id)).toEqual(['a', 'b']);
  });
});

describe('Phase 3 — additive application (B5)', () => {
  it('applies percentages to the original base (10%+20% of 1000 = 300, not 320)', () => {
    const { total, rows } = applyAdjustmentsAdditive(1000, [
      { id: 'a', name: 'A', type: 'PERCENTAGE', value: 10, sort_order: 1, active: true },
      { id: 'b', name: 'B', type: 'PERCENT', value: 20, sort_order: 2, active: true },
    ] as any[]);
    expect(total).toBe(300);
    expect(rows.map((r) => r.amount)).toEqual([100, 200]);
  });
});

describe('Phase 3 — FIXED is flat per class (B4)', () => {
  it('does not multiply FIXED by totalPages', () => {
    // BOM: 2 pages x 6 learners, paper 5000/ream @500 sheets: 6 sheets -> 60.
    const result = calculateExaminationBatchPricing(
      {
        classes: [
          {
            id: 'class-1',
            class_name: 'Grade 1',
            number_of_learners: 6,
            subjects: [{ pages: 2, extra_copies: 0 }],
          },
        ],
      },
      {
        paper_unit_cost: 5000,
        toner_unit_cost: 0,
        conversion_rate: 500,
        profit_margin: 0,
      },
      [{ id: 'adj-fixed', name: 'Flat fee', type: 'FIXED', value: 500, sort_order: 1 } as any]
    );
    expect(result.classes).toHaveLength(1);
    const cls = result.classes[0];
    expect(cls.totalBomCost).toBe(60);
    // Flat: adjusted 560 -> 93.33/learner -> roundUp50 100 -> total 600.
    // Old per-page behavior would give 500*12=6000 -> total 6300.
    expect(cls.expectedFeePerLearner).toBe(100);
    expect(cls.totalCost).toBe(600);
  });
});

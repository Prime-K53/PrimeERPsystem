/**
 * Phase 3 — Single adjustment semantics (B4 + B5 + B6, backend leg).
 *
 * - Canonical type/active/sort helpers behave identically for legacy shapes.
 * - buildAdjustmentBreakdown is ADDITIVE (two percentages don't compound).
 * - buildClassAdjustmentBreakdown treats FIXED as flat per class (no * pages).
 */
const { describe, it, expect } = require('@jest/globals');
const fs = require('node:fs');
const path = require('node:path');
const semantics = require('../services/marketAdjustmentSemantics.cjs');
const pricingEngine = require('../services/examinationPricingEngine.cjs');

describe('canonical type normalization', () => {
  it.each([
    ['PERCENTAGE', 'PERCENTAGE'],
    ['PERCENT', 'PERCENTAGE'],
    ['percentage', 'PERCENTAGE'],
    ['percent', 'PERCENTAGE'],
    ['FIXED', 'FIXED'],
    ['fixed', 'FIXED'],
    [undefined, 'PERCENTAGE'],
  ])('normalizeMarketAdjustmentType(%p) === %p', (input, expected) => {
    expect(semantics.normalizeMarketAdjustmentType(input)).toBe(expected);
  });
});

describe('canonical active check', () => {
  it('defaults missing flags to active', () => {
    expect(semantics.isMarketAdjustmentActive({})).toBe(true);
    expect(semantics.isMarketAdjustmentActive({ id: 'x' })).toBe(true);
    expect(semantics.isMarketAdjustmentActive(null)).toBe(true);
    expect(semantics.isMarketAdjustmentActive(undefined)).toBe(true);
  });

  it.each([
    [{ active: true }, true],
    [{ active: false }, false],
    [{ active: 1 }, true],
    [{ active: 0 }, false],
    [{ is_active: 'true' }, true],
    [{ is_active: 'false' }, false],
    [{ isActive: '1' }, true],
    [{ isActive: '0' }, false],
    [{ active: 'yes' }, true],
    [{ active: 'no' }, false],
  ])('%p => %p', (adj, expected) => {
    expect(semantics.isMarketAdjustmentActive(adj)).toBe(expected);
  });
});

describe('canonical sort', () => {
  it('orders by sort_order ?? sortOrder, then name', () => {
    const sorted = semantics.sortMarketAdjustments([
      { id: 'b', name: 'B', sort_order: 2 },
      { id: 'a', name: 'A', sort_order: 1 },
      { id: 'c', name: 'C', sortOrder: 1 },
    ]);
    expect(sorted.map((r) => r.id)).toEqual(['a', 'c', 'b']);
  });
});

describe('additive application (B5)', () => {
  it('applies every percentage to the ORIGINAL base (no compounding)', () => {
    const { total, rows } = semantics.applyAdjustmentsAdditive(1000, [
      { id: 'a', name: 'A', type: 'PERCENTAGE', value: 10, sort_order: 1, active: 1 },
      { id: 'b', name: 'B', type: 'PERCENT', value: 20, sort_order: 2, active: 1 },
    ]);
    // Additive: 100 + 200 = 300. Compounding would give 100 + 220 = 320.
    expect(total).toBe(300);
    expect(rows.map((r) => r.amount)).toEqual([100, 200]);
  });

  it('keeps FIXED flat and skips inactive rows', () => {
    const { total } = semantics.applyAdjustmentsAdditive(1000, [
      { id: 'f', name: 'F', type: 'FIXED', value: 150, active: 1 },
      { id: 'off', name: 'Off', type: 'PERCENTAGE', value: 50, active: 0 },
    ]);
    expect(total).toBe(150);
  });

  it('buildAdjustmentBreakdown matches additive semantics', () => {
    const result = pricingEngine.buildAdjustmentBreakdown(1000, [
      { id: 'a', name: 'A', type: 'PERCENTAGE', value: 10, sort_order: 1 },
      { id: 'b', name: 'B', type: 'PERCENTAGE', value: 20, sort_order: 2 },
    ]);
    expect(result.adjustmentTotal).toBe(300);
    expect(result.totalCost).toBe(1300);
  });
});

describe('FIXED is flat per class (B4)', () => {
  it('buildClassAdjustmentBreakdown no longer scales by pages', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'examinationService.cjs'),
      'utf8'
    );
    expect(src).not.toMatch(/rawValue \* safeTotalPages/);
  });
});

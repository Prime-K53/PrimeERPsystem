/**
 * examinationPricingCanonical.test.cjs — canonical pricing contract (backend half).
 *
 * Asserts calculateCanonicalClassPricing produces the golden outputs in
 * tests/fixtures/examination-pricing-vectors.json for identical inputs.
 * The frontend vitest suite asserts the same fixture against
 * calculateExaminationBatchPricing — identical inputs, identical outputs.
 */
const path = require('path');
const engine = require('../services/examinationPricingEngine.cjs');

const vectors = require(path.join(
  __dirname, '..', '..', 'tests', 'fixtures', 'examination-pricing-vectors.json'
));

const sorted = (values) => [...values].sort((a, b) => a - b);

describe('canonical examination pricing (backend)', () => {
  test('publishes the canonical engine version and toner yield', () => {
    expect(engine.EXAM_PRICING_ENGINE_VERSION).toBe(vectors.engineVersion);
    expect(engine.TONER_PAGES_PER_UNIT).toBe(vectors.tonerPagesPerUnit);
    // Legacy alias preserved for import compatibility.
    expect(engine.TONER_PAGES_PER_KG).toBe(vectors.tonerPagesPerUnit);
  });

  test('FIXED adjustments are flat (never scaled by pages)', () => {
    const out = engine.calculateCanonicalClassPricing({
      subjects: [{ pages: 100, extra_copies: 0 }],
      learners: 10,
      paperUnitCost: 0,
      tonerUnitCost: 0,
      conversionRate: 500,
      tonerPagesPerUnit: 20000,
      adjustments: [{ id: 'f', name: 'Flat', type: 'FIXED', value: 777 }],
      profitMargin: 0,
      roundingMethod: 'ALWAYS_UP_50',
      roundingStep: 50
    });
    expect(out.adjustmentTotal).toBe(777);
    expect(out.adjustmentRows).toHaveLength(1);
    expect(out.adjustmentRows[0].originalAmount).toBe(777);
  });

  for (const vector of vectors.vectors) {
    test(`${vector.id}: golden outputs`, () => {
      const input = vector.input;
      const out = engine.calculateCanonicalClassPricing({
        subjects: input.subjects,
        learners: input.learners,
        paperUnitCost: input.paperUnitCost,
        tonerUnitCost: input.tonerUnitCost,
        conversionRate: input.conversionRate,
        tonerPagesPerUnit: input.tonerPagesPerUnit,
        adjustments: input.adjustments,
        profitMargin: input.profitMargin,
        roundingMethod: input.roundingMethod,
        roundingStep: input.roundingStep,
        isManualOverride: input.isManualOverride,
        manualCostPerLearner: input.manualCostPerLearner
      });
      const expected = vector.expected;
      expect(out.learners).toBe(expected.learners);
      expect(out.totalSheets).toBe(expected.totalSheets);
      expect(out.totalPages).toBe(expected.totalPages);
      expect(out.materialCost).toBe(expected.totalBomCost);
      expect(sorted(out.adjustmentRows.map((r) => r.originalAmount))).toEqual(
        sorted(expected.adjustmentAmounts)
      );
      expect(out.adjustmentTotal).toBe(expected.adjustmentTotal);
      expect(out.marketAdjustmentTotal).toBe(expected.marketAdjustmentTotal);
      expect(out.rawFeePerLearner).toBe(expected.rawFeePerLearner);
      expect(out.roundedFeePerLearner).toBe(expected.roundedFeePerLearner);
      expect(out.expectedTotal).toBe(expected.expectedTotal);
      expect(out.roundingAdjustment).toBe(expected.roundingAdjustment);
      expect(out.totalAdjustments).toBe(expected.totalAdjustments);
      expect(out.finalFeePerLearner).toBe(expected.finalFeePerLearner);
      expect(out.liveTotal).toBe(expected.liveTotal);
    });
  }
});

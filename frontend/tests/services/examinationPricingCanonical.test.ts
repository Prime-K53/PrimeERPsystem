/**
 * examinationPricingCanonical.test.ts — canonical pricing contract (frontend half).
 *
 * Asserts the frontend canonical engine produces the golden outputs in
 * tests/fixtures/examination-pricing-vectors.json for identical inputs.
 * The backend jest suite asserts the same fixture against
 * calculateCanonicalClassPricing — identical inputs, identical outputs.
 */
import { describe, it, expect } from 'vitest';
import {
  calculateExaminationBatchPricing,
  EXAM_PRICING_ENGINE_VERSION,
  EXAM_TONER_PAGES_PER_UNIT,
} from '../../src/domain/examination/pricingEngine';
import vectors from '../../../tests/fixtures/examination-pricing-vectors.json';

describe('canonical examination pricing (frontend)', () => {
  it('publishes the canonical engine version and toner yield', () => {
    expect(EXAM_PRICING_ENGINE_VERSION).toBe(vectors.engineVersion);
    expect(EXAM_TONER_PAGES_PER_UNIT).toBe(vectors.tonerPagesPerUnit);
  });

  for (const vector of vectors.vectors as any[]) {
    it(`${vector.id}: golden outputs`, () => {
      const input = vector.input;
      const result = calculateExaminationBatchPricing(
        {
          classes: [
            {
              id: 'class-1',
              class_name: 'Vector',
              number_of_learners: input.learners,
              subjects: input.subjects,
              is_manual_override: input.isManualOverride ? 1 : 0,
              manual_cost_per_learner: input.manualCostPerLearner ?? null,
            },
          ],
        },
        {
          paper_unit_cost: input.paperUnitCost,
          toner_unit_cost: input.tonerUnitCost,
          conversion_rate: input.conversionRate,
          profit_margin: input.profitMargin,
          constants: { toner_pages_per_unit: input.tonerPagesPerUnit },
          rounding: { method: input.roundingMethod, step: input.roundingStep },
          active_adjustments: [],
        } as any,
        input.adjustments
      );
      expect(result.classes).toHaveLength(1);
      const row = result.classes[0];
      const expected = vector.expected;
      expect(row.learners).toBe(expected.learners);
      expect(row.totalSheets).toBe(expected.totalSheets);
      expect(row.totalPages).toBe(expected.totalPages);
      expect(row.totalBomCost).toBe(expected.totalBomCost);
      expect(row.totalAdjustments).toBe(expected.totalAdjustments);
      expect((row as any).marketAdjustmentTotal).toBe(expected.marketAdjustmentTotal);
      expect((row as any).roundingAdjustment).toBe(expected.roundingAdjustment);
      expect(row.totalCost).toBe(expected.expectedTotal);
      expect(row.expectedFeePerLearner).toBe(expected.roundedFeePerLearner);
      expect(row.finalFeePerLearner).toBe(expected.finalFeePerLearner);
      expect(row.liveTotalPreview).toBe(expected.liveTotal);
    });
  }

  it('explicit adjustment_rate folds into an equivalent synthetic row', () => {
    const base: any = {
      classes: [
        {
          id: 'class-1',
          class_name: 'Vector',
          number_of_learners: 80,
          subjects: [{ pages: 12, extra_copies: 3 }],
        },
      ],
    };
    const common: any = {
      paper_unit_cost: 10,
      toner_unit_cost: 85000,
      conversion_rate: 500,
      profit_margin: 0,
      constants: { toner_pages_per_unit: 20000 },
      rounding: { method: 'ALWAYS_UP_50', step: 50 },
      active_adjustments: [],
    };
    const viaRate = calculateExaminationBatchPricing(base, { ...common, adjustment_rate: 0.1 }, []);
    const viaRow = calculateExaminationBatchPricing(
      base,
      common,
      [{ type: 'PERCENTAGE', percentage: 10 } as any]
    );
    expect(viaRate.classes[0]).toEqual(viaRow.classes[0]);
  });
});

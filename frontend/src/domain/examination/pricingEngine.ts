export interface PricingAdjustmentInput {
  id?: string;
  name?: string;
  display_name?: string;
  type?: string;
  value?: number;
  percentage?: number;
  sort_order?: number;
}

export interface PricingRoundingInput {
  method?: string;
  step?: number;
}

/**
 * Canonical examination pricing engine version. Bumped ONLY when the
 * mathematical contract changes. Stamped onto every calculation snapshot
 * (frontend + backend) so historical batches stay tied to the engine that
 * priced them — never silently repriced with today's constants.
 */
export const EXAM_PRICING_ENGINE_VERSION = 'EXAM-2026.1';

/** Canonical toner yield: 20,000 pages per kg (HP Universal Toner spec). */
export const EXAM_TONER_PAGES_PER_UNIT = 20000;

export interface PricingSettingsInput {
  paper_unit_cost?: number;
  toner_unit_cost?: number;
  conversion_rate?: number;
  adjustment_rate?: number; // percentage as decimal, e.g. 0.70
  profit_margin?: number;    // percentage as decimal, e.g. 0.385
  constants?: {
    toner_pages_per_unit?: number;
  };
  active_adjustments?: PricingAdjustmentInput[];
  rounding?: PricingRoundingInput;
}

export interface PricingSubjectInput {
  pages?: number;
  extra_copies?: number;
}

export interface PricingClassInput {
  id?: string;
  class_name?: string;
  number_of_learners?: number;
  subjects?: PricingSubjectInput[];
  is_manual_override?: number | boolean;
  manual_cost_per_learner?: number | null;
}

export interface PricingBatchInput {
  classes?: PricingClassInput[];
}

export interface ClassPricingResult {
  classId: string;
  className: string;
  learners: number;
  totalSheets: number;
  totalPages: number;
  totalBomCost: number;
  totalAdjustments: number;
  marketAdjustmentTotal: number;
  roundingAdjustment: number;
  totalCost: number;
  expectedFeePerLearner: number;
  finalFeePerLearner: number;
  liveTotalPreview: number;
}

export interface BatchPricingResult {
  classes: ClassPricingResult[];
}

import { roundMoney, roundUpToStep } from '../../../utils/roundingUtils';

/**
 * Canonical rounding-method normalization. Byte-identical semantics to the
 * backend engine (normalizeRoundingMethod): NEAREST_10/50/100 behave as
 * ALWAYS_UP_*, only NEAREST_500 is a true nearest.
 */
export const normalizeRoundingMethod = (method?: string, fallback = 'ALWAYS_UP_50'): string => {
  const normalized = String(method || '').trim().toUpperCase();
  if (!normalized) return fallback;
  if (normalized === 'NEAREST_10') return 'ALWAYS_UP_10';
  if (normalized === 'NEAREST_50') return 'ALWAYS_UP_50';
  if (normalized === 'NEAREST_100') return 'ALWAYS_UP_100';
  if (normalized === 'ALWAYS_UP_10') return 'ALWAYS_UP_10';
  if (normalized === 'ALWAYS_UP_50') return 'ALWAYS_UP_50';
  if (normalized === 'ALWAYS_UP_100') return 'ALWAYS_UP_100';
  if (normalized === 'ALWAYS_UP_500') return 'ALWAYS_UP_500';
  if (normalized === 'ALWAYS_UP_CUSTOM') return 'ALWAYS_UP_CUSTOM';
  if (normalized === 'PSYCHOLOGICAL') return 'PSYCHOLOGICAL';
  if (normalized === 'NEAREST_500') return 'NEAREST_500';
  if (normalized === 'CUSTOM') return 'ALWAYS_UP_CUSTOM';
  return fallback;
};

const applyPsychologicalRounding = (price: number): number => {
  if (price <= 0) {
    return Math.ceil(price / 10) * 10;
  }
  let magnitude = 10;
  if (price >= 100) magnitude = 100;
  if (price >= 1000) magnitude = 1000;
  let candidate = Math.floor(price / magnitude) * magnitude + (magnitude - 1);
  if (candidate < price) candidate += magnitude;
  return candidate;
};

/** Canonical fee rounding — same contract as backend applyRounding. */
export const applyRounding = (value: number, method?: string, step?: number): number => {
  const safeValue = roundMoney(value);
  const norm = normalizeRoundingMethod(method, 'ALWAYS_UP_50');
  const rawStep = Number(step);
  const s = (!Number.isFinite(rawStep) || rawStep <= 0) ? 50 : Math.max(1, Math.round(rawStep));
  if (norm === 'NEAREST_500') return roundMoney(Math.round(safeValue / s) * s);
  if (norm === 'PSYCHOLOGICAL') return roundMoney(applyPsychologicalRounding(safeValue));
  let suffixStep = s;
  if (norm.endsWith('_10')) suffixStep = 10;
  else if (norm.endsWith('_50')) suffixStep = 50;
  else if (norm.endsWith('_100')) suffixStep = 100;
  else if (norm.endsWith('_500')) suffixStep = 500;
  return roundMoney(roundUpToStep(safeValue, suffixStep));
};

const normalizeAdjustmentType = (value: string | undefined) => {
  const type = String(value || '').toUpperCase();
  if (type === 'FIXED') return 'FIXED';
  return 'PERCENTAGE';
};

export const calculateSubjectConsumptionForLearners = (
  subject: PricingSubjectInput | null | undefined,
  learnersInput: number
) => {
  const learners = Math.max(1, Math.floor(Number(learnersInput) || 0));
  const pages = Math.max(1, Math.floor(Number(subject?.pages) || 0));
  const extraCopies = Math.max(0, Math.floor(Number(subject?.extra_copies) || 0));
  const copies = learners + extraCopies;
  const totalSheets = Math.ceil(pages / 2) * copies;
  const totalPages = pages * copies;
  return {
    pages,
    extraCopies,
    copies,
    totalSheets,
    totalPages
  };
};

export const calculateExaminationBomCost = (
  subjects: Array<{ pages?: number; extra_copies?: number }>,
  learners: number,
  paperUnitCost: number,
  tonerUnitCost: number,
  conversionRate: number,
  tonerPagesPerUnit: number
) => {
  const safeLearners = Math.max(1, Math.floor(Number(learners) || 0));
  let totalSheets = 0;
  let totalPages = 0;

  for (const subject of subjects || []) {
    const consumption = calculateSubjectConsumptionForLearners(subject as PricingSubjectInput, safeLearners);
    totalSheets += consumption.totalSheets;
    totalPages += consumption.totalPages;
  }

  const paperQty = totalSheets / Math.max(1, Number(conversionRate) || 500);
  const tonerQty = totalPages / Math.max(1, Number(tonerPagesPerUnit) || 20000);
  const paperCost = roundMoney(paperQty * Math.max(0, Number(paperUnitCost) || 0));
  const tonerCost = roundMoney(tonerQty * Math.max(0, Number(tonerUnitCost) || 0));
  const totalBomCost = roundMoney(paperCost + tonerCost);

  return { totalSheets, totalPages, paperCost, tonerCost, totalBomCost };
};

export const calculateExaminationBatchPricing = (
  batch: PricingBatchInput | null | undefined,
  settings: PricingSettingsInput | null,
  activeAdjustments: PricingAdjustmentInput[]
): BatchPricingResult => {
  if (!batch || !settings) {
    return { classes: [] };
  }

  const conversionRate = Math.max(1, Number(settings.conversion_rate) || 500);
  const tonerPagesPerUnit = Math.max(1, Number(settings.constants?.toner_pages_per_unit) || 20000);
  const effectiveAdjustments = activeAdjustments.length > 0
    ? activeAdjustments
    : (settings.active_adjustments || []);

  const classes = (batch.classes || []).map((cls, index) => {
    const learners = Math.max(1, Math.floor(Number(cls.number_of_learners) || 0));
    const bom = calculateExaminationBomCost(
      cls.subjects || [],
      learners,
      Number(settings.paper_unit_cost) || 0,
      Number(settings.toner_unit_cost) || 0,
      conversionRate,
      tonerPagesPerUnit
    );
    const { totalSheets, totalPages, totalBomCost } = bom;

    // 1. Compute adjustedCost = BOM + additive adjustments on the ORIGINAL
    // BOM base. Canonical contract: per-row rounded amounts (matches the
    // backend breakdown rows that are persisted/audited). FIXED is a flat
    // per-class amount (never * totalPages). A legacy explicit
    // settings.adjustment_rate (decimal) is folded in as a synthetic
    // PERCENTAGE row so exactly one formula exists.
    const explicitAdjustmentRate = Number(settings.adjustment_rate ?? 0);
    const rateRow: PricingAdjustmentInput[] = explicitAdjustmentRate > 0
      ? [{ id: 'explicit-adjustment-rate', name: 'Adjustment rate', type: 'PERCENTAGE', percentage: explicitAdjustmentRate * 100 }]
      : [];
    const allAdjustments = [...rateRow, ...(effectiveAdjustments || [])];
    let percentTotal = 0;
    let fixedTotal = 0;
    for (const adj of allAdjustments) {
      if (normalizeAdjustmentType(adj.type) === 'FIXED') {
        fixedTotal += roundMoney(Number(adj.value) || 0);
      } else {
        percentTotal += roundMoney(totalBomCost * ((Number(adj.percentage ?? adj.value ?? 0)) / 100));
      }
    }
    const totalFixedAdjustments = roundMoney(fixedTotal);
    const totalPercentAdjustments = roundMoney(percentTotal);
    const marketAdjustmentTotal = roundMoney(totalPercentAdjustments + totalFixedAdjustments);
    const adjustedCost = totalBomCost + totalPercentAdjustments + totalFixedAdjustments;

    // 2. Compute rawTotal = adjustedCost * (1 + profitMargin)
    // Profit margin must be applied after adjustments, not directly on BOM.
    const profitMargin = Number(settings.profit_margin ?? 0);
    const rawTotal = adjustedCost * (1 + profitMargin);

    // 3. Compute rawFeePerLearner = rawTotal / learners
    // Ensure floating point precision up to 2 decimal places before rounding.
    const rawFeePerLearner = learners > 0 ? roundMoney(rawTotal / learners) : 0;

    // 4. Apply the canonical rounding rule (default ALWAYS_UP_50).
    // Fees never round down: a below-raw candidate is discarded.
    const roundingMethod = settings.rounding?.method || 'ALWAYS_UP_50';
    const roundingStep = settings.rounding?.step || 50;
    const roundedCandidate = applyRounding(rawFeePerLearner, roundingMethod, roundingStep);
    const roundedFeePerLearner = roundedCandidate >= rawFeePerLearner
      ? roundedCandidate
      : rawFeePerLearner;

    const expectedFeePerLearner = roundedFeePerLearner;
    const roundedExpectedTotal = roundMoney(expectedFeePerLearner * learners);
    const totalCost = roundedExpectedTotal;
    const roundingAdjustment = Math.max(0, roundMoney(totalCost - totalBomCost - marketAdjustmentTotal));
    const totalAdjustments = roundMoney(totalCost - totalBomCost);

    const hasManualOverride = Boolean(Number(cls.is_manual_override || 0)) && cls.manual_cost_per_learner != null;
    const finalFeePerLearner = hasManualOverride
      ? Number(cls.manual_cost_per_learner)
      : expectedFeePerLearner;
    const liveTotalPreview = roundMoney(finalFeePerLearner * learners);

    return {
      classId: cls.id || `class-${index + 1}`,
      className: cls.class_name || `Class ${index + 1}`,
      learners,
      totalSheets,
      totalPages,
      totalBomCost,
      totalAdjustments,
      marketAdjustmentTotal,
      roundingAdjustment,
      totalCost,
      expectedFeePerLearner,
      finalFeePerLearner,
      liveTotalPreview
    };
  });

  return { classes };
};

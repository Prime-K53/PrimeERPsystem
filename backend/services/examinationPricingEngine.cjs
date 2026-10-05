const { roundToCurrency, roundUpToStep, roundToNearest } = require('../utils/mathUtils.cjs');

/**
 * Canonical examination pricing contract (EXAM-2026.1).
 *
 * Frontend (src/domain/examination/pricingEngine.ts) and backend implement
 * this exact contract. The physical implementations stay separate (browser
 * vs Node runtimes) but MUST remain mathematically identical — see the
 * shared golden vectors in tests/fixtures/examination-pricing-vectors.json.
 *
 * Canonical rules:
 *  - Duplex sheets: ceil(pages/2) * (learners + extra_copies).
 *  - Toner yield: 20,000 pages per kg of HP Universal Toner (measured spec
 *    used by the seeded consumables and every frontend path). An earlier
 *    backend revision derived 50,000 from a 20mg/sheet assumption, which
 *    understated toner cost — corrected here.
 *  - FIXED adjustments are flat per-class amounts (never * pages).
 *  - PERCENTAGE adjustments are additive on the original BOM base.
 *  - Profit margin applies once: rawTotal = adjusted * (1 + margin).
 *  - Fee rounding defaults to ALWAYS_UP to `step` (default 50).
 */
const EXAM_PRICING_ENGINE_VERSION = 'EXAM-2026.1';

const PAGES_PER_SHEET = 2;
// Canonical toner yield (pages per kg). Matches the seeded HP Universal
// Toner spec (~20,000 pages/kg), the frontend hidden-BOM constant
// (EXAM_TONER_PAGES_PER_KG) and every frontend pricing default.
const TONER_PAGES_PER_UNIT = 20000;
// Legacy alias (pre-canonical derivation, kept for import compatibility).
const TONER_PAGES_PER_KG = TONER_PAGES_PER_UNIT;
const SHEETS_PER_REAM = 500;

const DEFAULT_FALLBACK_ADJUSTMENTS = [];

const toNumber = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const roundCurrency = (value) => roundToCurrency(value);

const clampNonNegative = (value) => Math.max(0, roundCurrency(value));

const normalizeAdjustmentType = (type) => {
  const normalized = String(type || '').toUpperCase().trim();
  if (normalized === 'FIXED') return 'FIXED';
  if (normalized === 'PERCENT') return 'PERCENTAGE';
  return 'PERCENTAGE';
};

/**
 * Resolve the preferred material unit cost source for BOM calculations.
 * Priority:
 * 1) current inventory master cost
 * 2) weighted active material batch cost
 * 3) latest inbound transaction cost
 * 4) configured fallback cost
 */
const resolvePreferredUnitCost = ({
  inventoryUnitCost,
  weightedBatchUnitCost,
  latestInboundUnitCost,
  fallbackUnitCost = 0
}) => {
  const preferred = [
    { source: 'inventory.master', value: toNumber(inventoryUnitCost, 0) },
    { source: 'material_batches.weighted_active', value: toNumber(weightedBatchUnitCost, 0) },
    { source: 'inventory_transactions.latest_in', value: toNumber(latestInboundUnitCost, 0) },
    { source: 'fallback.default', value: toNumber(fallbackUnitCost, 0) }
  ].find((entry) => entry.value > 0);

  if (!preferred) {
    return { unitCost: 0, source: 'none' };
  }

  return { unitCost: preferred.value, source: preferred.source };
};

const calculateSubjectConsumption = (subject, learners) => {
  const pages = Math.max(1, Math.floor(toNumber(subject?.pages, 0)));
  const extraCopies = Math.max(0, Math.floor(toNumber(subject?.extra_copies, 0)));
  const safeLearners = Math.max(1, Math.floor(toNumber(learners, 1)));

  const sheetsPerCopy = Math.ceil(pages / PAGES_PER_SHEET);
  const totalCopies = safeLearners + extraCopies;
  const totalSheets = sheetsPerCopy * totalCopies;
  const totalPages = pages * totalCopies;

  return {
    pages,
    extraCopies,
    sheetsPerCopy,
    totalCopies,
    totalSheets,
    totalPages
  };
};

const calculateClassMaterialCost = ({
  totalSheets,
  totalPages,
  paperUnitCost,
  tonerUnitCost
}) => {
  const safeSheets = Math.max(0, toNumber(totalSheets, 0));
  const safePages = Math.max(0, toNumber(totalPages, 0));
  const safePaperUnitCost = Math.max(0, toNumber(paperUnitCost, 0));
  const safeTonerUnitCost = Math.max(0, toNumber(tonerUnitCost, 0));

  const reamsRequired = safeSheets / SHEETS_PER_REAM;
  const tonerRequired = safePages / TONER_PAGES_PER_UNIT;
  const paperCost = clampNonNegative(reamsRequired * safePaperUnitCost);
  const tonerCost = clampNonNegative(tonerRequired * safeTonerUnitCost);
  const materialCost = clampNonNegative(paperCost + tonerCost);

  return {
    reamsRequired,
    tonerRequired,
    paperCost,
    tonerCost,
    materialCost
  };
};

const sortAdjustments = (adjustments) => {
  return [...adjustments].sort((a, b) => {
    const left = toNumber(a?.sort_order, 0);
    const right = toNumber(b?.sort_order, 0);
    if (left !== right) return left - right;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
};

const normalizeAdjustments = (adjustments = []) => {
  return sortAdjustments(adjustments).map((adj, index) => {
    const type = normalizeAdjustmentType(adj?.type);
    const rawValue = type === 'FIXED'
      ? toNumber(adj?.value, 0)
      : toNumber(adj?.percentage ?? adj?.value, 0);

    return {
      id: String(adj?.id || `fallback-adjustment-${index + 1}`),
      name: String(adj?.display_name || adj?.name || `Adjustment ${index + 1}`),
      type,
      value: rawValue,
      sortOrder: toNumber(adj?.sort_order, index)
    };
  });
};

const buildAdjustmentBreakdown = (materialCost, adjustments = []) => {
  const normalized = normalizeAdjustments(adjustments);
  const safeMaterialCost = clampNonNegative(materialCost);
  // Canonical Phase 3 semantics: ADDITIVE on the original base.
  // (Previously sequential compounding on the running total, which made
  // multi-percentage totals depend on sort order.)
  let totalAdjustment = 0;

  const rows = normalized.map((adj) => {
    const baseAmount = safeMaterialCost;
    const amount = adj.type === 'FIXED'
      ? clampNonNegative(adj.value)
      : clampNonNegative(baseAmount * (adj.value / 100));

    totalAdjustment = clampNonNegative(totalAdjustment + amount);

    return {
      adjustmentId: adj.id,
      adjustmentName: adj.name,
      adjustmentType: adj.type,
      adjustmentValue: adj.value,
      baseAmount: clampNonNegative(baseAmount),
      originalAmount: clampNonNegative(amount),
      redistributedAmount: clampNonNegative(amount),
      allocationRatio: 0
    };
  });

  const normalizedRows = rows.map((row, index) => ({
    ...row,
    allocationRatio: totalAdjustment > 0
      ? row.originalAmount / totalAdjustment
      : (rows.length > 0 ? 1 / rows.length : 0),
    sequenceNo: index + 1
  }));

  return {
    rows: normalizedRows,
    materialCost: safeMaterialCost,
    adjustmentTotal: clampNonNegative(totalAdjustment),
    totalCost: clampNonNegative(safeMaterialCost + totalAdjustment)
  };
};

const roundPreservingTotal = (values, targetTotal) => {
  if (values.length === 0) return [];
  const rounded = values.map((value) => clampNonNegative(value));
  const current = rounded.reduce((sum, value) => sum + value, 0);
  const diff = roundCurrency(targetTotal - current);
  if (Math.abs(diff) < 0.01) return rounded;
  rounded[rounded.length - 1] = clampNonNegative(rounded[rounded.length - 1] + diff);
  return rounded;
};

const redistributeAdjustments = (rows, targetAdjustmentTotal) => {
  const safeTargetTotal = clampNonNegative(targetAdjustmentTotal);
  if (!rows.length) {
    return {
      rows: [],
      adjustmentTotal: safeTargetTotal
    };
  }

  const safeRows = rows.map((row) => ({
    ...row,
    originalAmount: clampNonNegative(row.originalAmount),
    allocationRatio: Math.max(0, toNumber(row.allocationRatio, 0))
  }));
  const originalTotal = safeRows.reduce((sum, row) => sum + row.originalAmount, 0);

  let redistributedRaw;
  if (originalTotal <= 0) {
    const even = safeTargetTotal / safeRows.length;
    redistributedRaw = safeRows.map(() => even);
  } else {
    const scale = safeTargetTotal / originalTotal;
    redistributedRaw = safeRows.map((row) => row.originalAmount * scale);
  }

  const redistributed = roundPreservingTotal(redistributedRaw, safeTargetTotal);

  const resultRows = safeRows.map((row, index) => ({
    ...row,
    redistributedAmount: clampNonNegative(redistributed[index]),
    allocationRatio: safeTargetTotal > 0
      ? clampNonNegative(redistributed[index]) / safeTargetTotal
      : row.allocationRatio
  }));

  return {
    rows: resultRows,
    adjustmentTotal: clampNonNegative(
      resultRows.reduce((sum, row) => sum + row.redistributedAmount, 0)
    )
  };
};

const calculatePercentageDifference = (manualCostPerLearner, suggestedCostPerLearner) => {
  const manual = toNumber(manualCostPerLearner, 0);
  const suggested = toNumber(suggestedCostPerLearner, 0);
  if (suggested <= 0) return 0;
  return roundCurrency(((manual - suggested) / suggested) * 100);
};

const resolveClassPricing = ({
  learners,
  materialCost,
  suggestedTotalCost,
  suggestedCostPerLearner,
  adjustmentRows,
  manualCostPerLearner,
  manualOverrideEnabled
}) => {
  const safeLearners = Math.max(1, Math.floor(toNumber(learners, 1)));
  const safeMaterialCost = clampNonNegative(materialCost);
  const safeSuggestedTotalCost = clampNonNegative(suggestedTotalCost);
  const safeSuggestedCostPerLearner = clampNonNegative(suggestedCostPerLearner);
  const safeAdjustmentRows = Array.isArray(adjustmentRows) ? adjustmentRows : [];

  if (!manualOverrideEnabled) {
    return {
      isManualOverride: false,
      finalCostPerLearner: safeSuggestedCostPerLearner,
      finalClassTotal: safeSuggestedTotalCost,
      adjustmentTotal: clampNonNegative(safeSuggestedTotalCost - safeMaterialCost),
      adjustmentRows: safeAdjustmentRows.map((row) => ({
        ...row,
        redistributedAmount: clampNonNegative(row.redistributedAmount ?? row.originalAmount)
      })),
      percentageDifference: 0
    };
  }

  const safeManualCostPerLearner = toNumber(manualCostPerLearner, 0);
  if (!Number.isFinite(safeManualCostPerLearner) || safeManualCostPerLearner <= 0) {
    throw new Error('Manual cost per learner must be greater than zero.');
  }

  const manualClassTotal = roundCurrency(safeManualCostPerLearner * safeLearners);
  const minimumClassTotal = safeMaterialCost;
  if (manualClassTotal < minimumClassTotal) {
    throw new Error(
      `Manual cost is too low. Minimum allowed per learner is ${roundCurrency(minimumClassTotal / safeLearners)}.`
    );
  }

  const targetAdjustmentTotal = clampNonNegative(manualClassTotal - safeMaterialCost);
  const redistributed = redistributeAdjustments(safeAdjustmentRows, targetAdjustmentTotal);

  return {
    isManualOverride: true,
    finalCostPerLearner: roundCurrency(manualClassTotal / safeLearners),
    finalClassTotal: clampNonNegative(manualClassTotal),
    adjustmentTotal: redistributed.adjustmentTotal,
    adjustmentRows: redistributed.rows,
    percentageDifference: calculatePercentageDifference(
      safeManualCostPerLearner,
      safeSuggestedCostPerLearner
    )
  };
};

// --- Round Up Logic ---

/**
 * Rounds a value UP to the nearest multiple.
 * Delegates to shared mathUtils.roundUpToStep.
 */
const roundUpToNearest = (value, nearest) => roundUpToStep(value, nearest);

/**
 * Canonical rounding-method normalization. Single implementation shared by
 * the pure engine and (via delegation) examinationService.
 * NOTE: NEAREST_10/50/100 normalize to ALWAYS_UP_* (historical backend
 * semantics); only NEAREST_500 is a true nearest. Preserved deliberately.
 */
const normalizeRoundingMethod = (method, fallback = 'ALWAYS_UP_50') => {
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

const normalizeRoundingStep = (value, fallback = 50) => {
  const num = toNumber(value, NaN);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.max(1, Math.round(num));
};

const applyPsychologicalRounding = (price) => {
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

/**
 * Canonical fee rounding. Mirrors examinationService.applyBatchRounding
 * exactly; the service delegates here so only one implementation exists.
 */
const applyRounding = (value, method, step) => {
  const safeValue = roundCurrency(value);
  const norm = normalizeRoundingMethod(method, 'ALWAYS_UP_50');
  const s = normalizeRoundingStep(step, 50);

  switch (norm) {
    case 'NEAREST_500':
      return roundCurrency(Math.round(safeValue / s) * s);
    case 'PSYCHOLOGICAL':
      return roundCurrency(applyPsychologicalRounding(safeValue));
    case 'ALWAYS_UP_10':
    case 'ALWAYS_UP_50':
    case 'ALWAYS_UP_100':
    case 'ALWAYS_UP_500':
    case 'ALWAYS_UP_CUSTOM':
    default: {
      let suffixStep = s;
      if (norm.endsWith('_10')) suffixStep = 10;
      else if (norm.endsWith('_50')) suffixStep = 50;
      else if (norm.endsWith('_100')) suffixStep = 100;
      else if (norm.endsWith('_500')) suffixStep = 500;
      return roundCurrency(roundUpToStep(safeValue, suffixStep));
    }
  }
};

/**
 * ONE canonical class-pricing computation (pure, no I/O).
 *
 * Contract (mirrors frontend calculateExaminationBatchPricing per class):
 *  1. consumption: ceil(pages/2) * (learners + extra) sheets (duplex).
 *  2. BOM: paper = sheets/conversionRate * paperUnitCost (rounded),
 *     toner = pages/tonerPagesPerUnit * tonerUnitCost (rounded).
 *  3. adjustments: additive on the ORIGINAL BOM base; FIXED is a flat
 *     per-class amount, PERCENTAGE is base * pct/100.
 *  4. margin: rawTotal = (BOM + adjustments) * (1 + profitMargin).
 *  5. fee: rawFee = round(rawTotal/learners); roundedFee = canonical
 *     rounding(method, step); the rounded fee is applied only when it does
 *     not go below raw (fees never round down).
 *  6. totals: expectedTotal = round(roundedFee * learners);
 *     roundingAdjustment = expectedTotal - BOM - adjustments (floored at 0
 *     for reporting; the fee rule above already prevents going below raw).
 *  7. manual override (optional): final = manual fee, liveTotal = final*l.
 */
const calculateCanonicalClassPricing = (input = {}) => {
  const subjects = Array.isArray(input.subjects) ? input.subjects : [];
  const learners = Math.max(1, Math.floor(toNumber(input.learners, 0)));
  // Input normalization mirrors the frontend canonical engine exactly
  // (falsy 0/NaN fall back to defaults; negatives clamp via Math.max).
  const crRaw = toNumber(input.conversionRate, NaN);
  const conversionRate = Math.max(1, (!Number.isFinite(crRaw) || crRaw === 0) ? 500 : crRaw);
  const tpuRaw = toNumber(input.tonerPagesPerUnit, NaN);
  const tonerPagesPerUnit = Math.max(1, (!Number.isFinite(tpuRaw) || tpuRaw === 0) ? TONER_PAGES_PER_UNIT : tpuRaw);
  const paperUnitCost = Math.max(0, toNumber(input.paperUnitCost, NaN) || 0);
  const tonerUnitCost = Math.max(0, toNumber(input.tonerUnitCost, NaN) || 0);
  const profitMargin = Number(input.profitMargin ?? 0);

  let totalSheets = 0;
  let totalPages = 0;
  for (const sub of subjects) {
    const c = calculateSubjectConsumption(sub, learners);
    totalSheets += c.totalSheets;
    totalPages += c.totalPages;
  }

  const paperCost = roundCurrency((totalSheets / conversionRate) * paperUnitCost);
  const tonerCost = roundCurrency((totalPages / tonerPagesPerUnit) * tonerUnitCost);
  const materialCost = roundCurrency(paperCost + tonerCost);

  const breakdown = buildAdjustmentBreakdown(materialCost, input.adjustments || []);
  const adjustmentTotal = breakdown.adjustmentTotal;
  // NOTE: no intermediate rounding before margin — mirrors the frontend
  // canonical engine (adjustedCost is exact until the fee rounding).
  const rawTotal = (materialCost + adjustmentTotal) * (1 + profitMargin);
  const rawFeePerLearner = learners > 0 ? roundCurrency(rawTotal / learners) : 0;
  const roundedCandidate = applyRounding(
    rawFeePerLearner,
    input.roundingMethod || 'ALWAYS_UP_50',
    input.roundingStep || 50
  );
  // Fees never round down: a below-raw candidate is discarded.
  const roundedFeePerLearner = roundedCandidate >= rawFeePerLearner
    ? roundedCandidate
    : rawFeePerLearner;
  const expectedTotal = roundCurrency(roundedFeePerLearner * learners);
  const marketAdjustmentTotal = adjustmentTotal;
  const roundingAdjustment = Math.max(0, roundCurrency(expectedTotal - materialCost - adjustmentTotal));
  const totalAdjustments = roundCurrency(expectedTotal - materialCost);

  const manualFee = toNumber(input.manualCostPerLearner, NaN);
  const hasManualOverride = Boolean(input.isManualOverride) && Number.isFinite(manualFee) && manualFee > 0;
  const finalFeePerLearner = hasManualOverride ? manualFee : roundedFeePerLearner;
  const liveTotal = roundCurrency(finalFeePerLearner * learners);

  return {
    learners,
    totalSheets,
    totalPages,
    paperCost,
    tonerCost,
    materialCost,
    adjustmentRows: breakdown.rows,
    adjustmentTotal,
    marketAdjustmentTotal,
    roundingAdjustment,
    totalAdjustments,
    preRoundingTotal: roundCurrency(materialCost + adjustmentTotal),
    rawFeePerLearner,
    roundedFeePerLearner,
    expectedTotal,
    hasManualOverride,
    finalFeePerLearner,
    liveTotal
  };
};

/**
 * Calculates a "Rounding Adjustment" to reach the rounded-up target.
 * Returns the adjustment amount needed to add to the base value to reach the target.
 */
const calculateRoundingAdjustment = (baseValue, targetValue) => {
  const safeBase = clampNonNegative(baseValue);
  const safeTarget = clampNonNegative(targetValue);
  return clampNonNegative(safeTarget - safeBase);
};

module.exports = {
  EXAM_PRICING_ENGINE_VERSION,
  PAGES_PER_SHEET,
  TONER_PAGES_PER_UNIT,
  TONER_PAGES_PER_KG,
  SHEETS_PER_REAM,
  DEFAULT_FALLBACK_ADJUSTMENTS,
  toNumber,
  roundCurrency,
  roundUpToNearest,
  calculateRoundingAdjustment,
  normalizeAdjustmentType,
  normalizeRoundingMethod,
  normalizeRoundingStep,
  applyPsychologicalRounding,
  applyRounding,
  calculateCanonicalClassPricing,
  resolvePreferredUnitCost,
  calculateSubjectConsumption,
  calculateClassMaterialCost,
  buildAdjustmentBreakdown,
  redistributeAdjustments,
  calculatePercentageDifference,
  resolveClassPricing
};

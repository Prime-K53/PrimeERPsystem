/**
 * examinationWorkflowGuards.test.cjs — status-machine invariants (pure, no DB).
 *
 * - Approved/Completed batches are immutable for pricing.
 * - Approval is single-shot (no double stock deduction path).
 * - Invoice generation requires Approved/Completed; regeneration likewise.
 * - Pricing engine version is published and canonical constants hold.
 */
const batchWorkflow = require('../services/examinationBatchWorkflow.cjs');
const pricingEngine = require('../services/examinationPricingEngine.cjs');

describe('examination batch workflow guards', () => {
  const codeOf = (fn) => {
    try {
      fn();
    } catch (error) {
      return error.workflowCode;
    }
    return null;
  };

  test('pricing is mutable only in Draft/Calculated', () => {
    expect(() => batchWorkflow.assertBatchMutableForPricing('Draft', 'test')).not.toThrow();
    expect(() => batchWorkflow.assertBatchMutableForPricing('Calculated', 'test')).not.toThrow();
    for (const status of ['Approved', 'Completed', 'Invoiced', 'approved', 'completed']) {
      expect(codeOf(() => batchWorkflow.assertBatchMutableForPricing(status, 'test'))).toBe('BATCH_IMMUTABLE');
    }
  });

  test('approval is single-shot', () => {
    expect(() => batchWorkflow.assertCanApproveBatch('Calculated')).not.toThrow();
    expect(() => batchWorkflow.assertCanApproveBatch('Draft')).not.toThrow();
    for (const status of ['Approved', 'Completed']) {
      expect(codeOf(() => batchWorkflow.assertCanApproveBatch(status))).toBe('APPROVAL_NOT_ALLOWED');
    }
  });

  test('invoice generation requires an approved batch', () => {
    expect(() => batchWorkflow.assertCanGenerateInvoice('Approved')).not.toThrow();
    expect(() => batchWorkflow.assertCanGenerateInvoice('Completed')).not.toThrow();
    for (const status of ['Draft', 'Calculated', '']) {
      expect(codeOf(() => batchWorkflow.assertCanGenerateInvoice(status))).toBe('INVOICE_NOT_ALLOWED');
    }
  });

  test('regeneration requires an approved/invoiced batch', () => {
    expect(() => batchWorkflow.assertCanRegenerateInvoice('Approved')).not.toThrow();
    expect(() => batchWorkflow.assertCanRegenerateInvoice('Completed')).not.toThrow();
    for (const status of ['Draft', 'Calculated']) {
      expect(codeOf(() => batchWorkflow.assertCanRegenerateInvoice(status))).toBe('REGENERATE_NOT_ALLOWED');
    }
  });

  test('only forward single-step transitions are allowed', () => {
    expect(batchWorkflow.canTransitionBatchStatus('Draft', 'Calculated')).toBe(true);
    expect(batchWorkflow.canTransitionBatchStatus('Approved', 'Approved')).toBe(true);
    expect(batchWorkflow.canTransitionBatchStatus('Draft', 'Approved')).toBe(false);
    expect(batchWorkflow.canTransitionBatchStatus('Calculated', 'Draft')).toBe(false);
  });

  test('canonical engine version and toner yield are published', () => {
    expect(pricingEngine.EXAM_PRICING_ENGINE_VERSION).toBe('EXAM-2026.1');
    expect(pricingEngine.TONER_PAGES_PER_UNIT).toBe(20000);
  });

  test('canonical rounding never rounds a fee down', () => {
    // 58.34 to NEAREST_500 would be 0 — the contract keeps raw instead.
    const out = pricingEngine.calculateCanonicalClassPricing({
      subjects: [{ pages: 12, extra_copies: 3 }],
      learners: 80,
      paperUnitCost: 10,
      tonerUnitCost: 85000,
      conversionRate: 500,
      tonerPagesPerUnit: 20000,
      adjustments: [],
      profitMargin: 0.1,
      roundingMethod: 'NEAREST_500',
      roundingStep: 500
    });
    expect(out.roundedFeePerLearner).toBe(out.rawFeePerLearner);
    expect(out.roundedFeePerLearner).toBe(58.34);
  });
});

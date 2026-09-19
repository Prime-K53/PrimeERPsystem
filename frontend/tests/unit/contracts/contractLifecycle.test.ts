import { describe, expect, it } from 'vitest';
import {
  assertAllowedContractTransition,
  generateNextContractNumber,
  isAllowedContractTransition,
  isAllowedItemTransition,
  matchContractWalletTx,
  resolveActivationEvidence,
  validateAmendmentAdjustments,
} from '../../../utils/contractLifecycle';

const contract = (overrides: any = {}) => ({
  id: 'c1',
  contract_number: 'PC-0001',
  prepaid_amount: 1000,
  max_assessments: 5,
  data: {},
  ...overrides,
});

describe('contract lifecycle transitions', () => {
  it('allows only the documented edges', () => {
    expect(isAllowedContractTransition('draft', 'pending_payment')).toBe(true);
    expect(isAllowedContractTransition('pending_payment', 'active')).toBe(true);
    expect(isAllowedContractTransition('active', 'suspended')).toBe(true);
    expect(isAllowedContractTransition('draft', 'active')).toBe(false);
    expect(isAllowedContractTransition('completed', 'active')).toBe(false);
    expect(isAllowedContractTransition('cancelled', 'draft')).toBe(false);
    expect(() => assertAllowedContractTransition('draft', 'active')).toThrow(/not allowed/);
    expect(() => assertAllowedContractTransition('draft', 'pending_payment')).not.toThrow();
  });

  it('guards item transitions', () => {
    expect(isAllowedItemTransition('reserved', 'consumed')).toBe(true);
    expect(isAllowedItemTransition('consumed', 'cancelled')).toBe(true);
    expect(isAllowedItemTransition('consumed', 'reserved')).toBe(false);
    expect(isAllowedItemTransition('released', 'consumed')).toBe(false);
  });
});

describe('contract numbering', () => {
  it('sequences from contract_number, not random record ids', () => {
    const existing = [
      { id: 'lxyz-abc123', contract_number: 'PC-0001' },
      { id: 'm999-zz top', contract_number: 'PC-0002' },
    ];
    // The legacy bug scanned `id` (random uids) and always returned the
    // start number — every contract minted PC-0001.
    expect(generateNextContractNumber(existing as any)).toBe('PC-0003');
  });

  it('starts at PC-0001 for an empty collection', () => {
    expect(generateNextContractNumber([])).toBe('PC-0001');
  });

  it('bumps past numbers already taken (legacy duplicates / races)', () => {
    const existing = [
      { id: 'a', contract_number: 'PC-0001' },
      { id: 'b', contract_number: 'PC-0001' },
    ];
    const next = generateNextContractNumber(existing as any);
    expect(next).not.toBe('PC-0001');
    expect(next).toBe('PC-0002');
  });

  it('ignores its own number when renumbering (edit path)', () => {
    const existing = [{ id: 'a', contract_number: 'PC-0007' }];
    expect(generateNextContractNumber(existing as any, undefined, 'a')).toBe('PC-0008');
  });
});

describe('wallet transaction matching', () => {
  it('matches exact contract id or exact reference only', () => {
    expect(matchContractWalletTx({ data: { contract_id: 'abc' } }, 'abc', 'PC-0001')).toBe(true);
    expect(matchContractWalletTx({ reference: 'PC-0001' }, 'abc', 'PC-0001')).toBe(true);
    // Substring must never match.
    expect(matchContractWalletTx({ data: { contract_id: 'xabcx' } }, 'abc', 'PC-0001')).toBe(false);
    expect(matchContractWalletTx({ reference: 'PC-00010' }, 'abc', 'PC-0001')).toBe(false);
    expect(matchContractWalletTx(null, 'abc', 'PC-0001')).toBe(false);
  });
});

describe('activation evidence', () => {
  it('zero-value contracts need no payment evidence', () => {
    expect(resolveActivationEvidence(contract({ prepaid_amount: 0 }), [])).toEqual({
      ok: true,
      kind: 'zero-value',
    });
  });

  it('accepts a paid issued invoice (status or amounts)', () => {
    const c = contract({ data: { issued_invoice_id: 'INV-1' } });
    expect(
      resolveActivationEvidence(c, [{ id: 'INV-1', status: 'Paid', totalAmount: 1000, paidAmount: 1000 }] as any)
    ).toEqual({ ok: true, kind: 'paid-invoice', invoiceId: 'INV-1' });
    expect(
      resolveActivationEvidence(c, [{ id: 'INV-1', status: 'Unpaid', totalAmount: 1000, paidAmount: 1000 }] as any)
    ).toEqual({ ok: true, kind: 'paid-invoice', invoiceId: 'INV-1' });
  });

  it('rejects missing or unpaid invoices', () => {
    expect(resolveActivationEvidence(contract(), []).ok).toBe(false);
    const c = contract({ data: { issued_invoice_id: 'INV-1' } });
    expect(
      resolveActivationEvidence(c, [{ id: 'INV-1', status: 'Unpaid', totalAmount: 1000, paidAmount: 200 }] as any).ok
    ).toBe(false);
    expect(resolveActivationEvidence(null, []).ok).toBe(false);
  });

  it('routes to override when an amendment raised prepaid above the paid invoice', () => {
    const c = contract({
      prepaid_amount: 1200,
      data: { issued_invoice_id: 'INV-1' },
    });
    expect(
      resolveActivationEvidence(c, [{ id: 'INV-1', status: 'Paid', totalAmount: 1000, paidAmount: 1000 }] as any)
    ).toEqual({ ok: false, kind: 'none' });
  });
});

describe('amendment bounds', () => {
  it('rejects adjustments that break coherence', () => {
    expect(
      validateAmendmentAdjustments(contract(), { prepaid_amount_adjustment: -2000 })
    ).toMatch(/below zero/);
    expect(
      validateAmendmentAdjustments(contract(), { assessment_count_adjustment: -5 })
    ).toMatch(/below 1/);
    expect(
      validateAmendmentAdjustments(contract(), { prepaid_amount_adjustment: Number.NaN })
    ).toMatch(/valid numbers/);
    expect(validateAmendmentAdjustments(null, {})).toMatch(/not found/);
  });

  it('accepts coherent adjustments', () => {
    expect(
      validateAmendmentAdjustments(contract(), { prepaid_amount_adjustment: 500, assessment_count_adjustment: 2 })
    ).toBeNull();
    expect(validateAmendmentAdjustments(contract(), {})).toBeNull();
  });
});

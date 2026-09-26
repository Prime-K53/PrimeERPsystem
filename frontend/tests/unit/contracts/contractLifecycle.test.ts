import { describe, expect, it } from 'vitest';
import {
  applyContractSignature,
  applySignatureVoid,
  assertAllowedContractTransition,
  assertAllowedItemCreate,
  assertAllowedItemWrite,
  generateNextContractNumber,
  isAllowedContractTransition,
  isAllowedItemTransition,
  isFullySigned,
  isSignableContractStatus,
  matchContractWalletTx,
  readContractSignatures,
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

  it('terminal states never return to active (or anywhere)', () => {
    for (const terminal of ['completed', 'expired', 'cancelled']) {
      for (const target of ['draft', 'pending_payment', 'active', 'suspended', 'completed', 'expired', 'cancelled']) {
        expect(isAllowedContractTransition(terminal, target)).toBe(false);
        expect(() => assertAllowedContractTransition(terminal, target)).toThrow(/not allowed/);
      }
    }
  });

  it('keeps the pending_payment chain and suspend/resume edges intact', () => {
    expect(isAllowedContractTransition('draft', 'pending_payment')).toBe(true);
    expect(isAllowedContractTransition('pending_payment', 'active')).toBe(true);
    expect(isAllowedContractTransition('pending_payment', 'cancelled')).toBe(true);
    expect(isAllowedContractTransition('active', 'suspended')).toBe(true);
    expect(isAllowedContractTransition('suspended', 'active')).toBe(true);
    expect(isAllowedContractTransition('suspended', 'cancelled')).toBe(true);
    expect(isAllowedContractTransition('active', 'completed')).toBe(true);
    expect(isAllowedContractTransition('active', 'expired')).toBe(true);
    expect(isAllowedContractTransition('active', 'cancelled')).toBe(true);
  });

  it('intentionally requires pending_payment between draft and active', () => {
    // draft → active direct is forbidden by design: activation evidence
    // (paid invoice or explicit override) is collected on the
    // pending_payment step, so activation can never skip the payment gate.
    expect(isAllowedContractTransition('draft', 'active')).toBe(false);
  });

  it('intentionally requires resume before completing/expiring a suspended contract', () => {
    // suspended → completed / suspended → expired are not edges: the
    // operator resumes to active first, keeping terminal transitions
    // single-sourced through the active state.
    expect(isAllowedContractTransition('suspended', 'completed')).toBe(false);
    expect(isAllowedContractTransition('suspended', 'expired')).toBe(false);
  });
});

describe('assessment item write guards (wallet-first)', () => {
  it('blocks direct reserved → consumed mutation (canonical op only)', () => {
    expect(() =>
      assertAllowedItemWrite({ status: 'reserved' }, { status: 'consumed' })
    ).toThrow(/canonical wallet-first operation/);
  });

  it('blocks every edge out of consumed (compensating reversal required)', () => {
    for (const target of ['reserved', 'released', 'cancelled']) {
      expect(() => assertAllowedItemWrite({ status: 'consumed' }, { status: target })).toThrow(
        /compensating reversal/
      );
    }
  });

  it('allows non-financial transitions and status-preserving writes', () => {
    expect(() => assertAllowedItemWrite({ status: 'reserved' }, { status: 'released' })).not.toThrow();
    expect(() => assertAllowedItemWrite({ status: 'reserved' }, { status: 'cancelled' })).not.toThrow();
    expect(() =>
      assertAllowedItemWrite({ status: 'consumed', id: 'a' }, { status: 'consumed', id: 'a', job_order_id: 'j' } as any)
    ).not.toThrow();
    expect(() => assertAllowedItemWrite(undefined, { status: 'reserved' })).not.toThrow();
  });

  it('still rejects lifecycle-map violations', () => {
    expect(() => assertAllowedItemWrite({ status: 'released' }, { status: 'consumed' })).toThrow(/not allowed/);
  });

  it('new items must be born reserved', () => {
    expect(() => assertAllowedItemCreate({ status: 'reserved' })).not.toThrow();
    expect(() => assertAllowedItemCreate({} as any)).not.toThrow();
    expect(() => assertAllowedItemCreate({ status: 'consumed' })).toThrow(/created reserved/);
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

describe('amendment bounds', () => {  it('rejects adjustments that break coherence', () => {
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

describe('signing ceremony state machine', () => {
  const block = (overrides: any = {}) => ({
    name: 'Jane Banda',
    role: 'Sales Manager',
    signatureDataUrl: 'data:image/png;base64,AAA',
    mode: 'Draw' as const,
    signedAt: '2026-09-19T10:00:00.000Z',
    signedBy: 'u-1',
    ...overrides,
  });

  it('reads empty signatures by default', () => {
    expect(readContractSignatures(undefined)).toEqual({ company: null, customer: null, history: [] });
    expect(readContractSignatures({})).toEqual({ company: null, customer: null, history: [] });
    expect(isFullySigned({})).toBe(false);
  });

  it('records first signatures with signed events', () => {
    const afterCompany = applyContractSignature({}, 'company', block());
    expect(afterCompany.signatures.company?.name).toBe('Jane Banda');
    expect(afterCompany.signatures.customer).toBeNull();
    expect(afterCompany.signatures.history).toHaveLength(1);
    expect(afterCompany.signatures.history[0].type).toBe('signed');
    expect(isFullySigned(afterCompany)).toBe(false);

    const afterCustomer = applyContractSignature(afterCompany, 'customer', block({ name: 'Peter Phiri' }));
    expect(afterCustomer.signatures.customer?.name).toBe('Peter Phiri');
    expect(afterCustomer.signatures.company?.name).toBe('Jane Banda');
    expect(isFullySigned(afterCustomer)).toBe(true);
  });

  it('re-signing overwrites the block but appends history', () => {
    const once = applyContractSignature({}, 'company', block());
    const twice = applyContractSignature(once, 'company', block({ name: 'New Rep' }));
    expect(twice.signatures.company?.name).toBe('New Rep');
    expect(twice.signatures.history.map((h: any) => h.type)).toEqual(['signed', 're-signed']);
  });

  it('void is a no-op when nothing is signed, clearing otherwise', () => {
    const empty: Record<string, any> = { lines: [] };
    expect(applySignatureVoid(empty, { by: 'u-1', at: 'now', reason: 'x' })).toBe(empty);
    const signed = applyContractSignature({}, 'company', block());
    const voided = applySignatureVoid(signed, { by: 'u-1', at: 'later', reason: 'amendment a-1 approved' });
    expect(voided.signatures.company).toBeNull();
    expect(voided.signatures.customer).toBeNull();
    expect(voided.signatures.history.at(-1)).toMatchObject({ type: 'voided', reason: 'amendment a-1 approved' });
    expect(isFullySigned(voided)).toBe(false);
  });

  it('restricts signing to signable statuses', () => {
    for (const s of ['draft', 'pending_payment', 'active', 'suspended']) {
      expect(isSignableContractStatus(s)).toBe(true);
    }
    for (const s of ['completed', 'expired', 'cancelled', undefined]) {
      expect(isSignableContractStatus(s)).toBe(false);
    }
  });
});

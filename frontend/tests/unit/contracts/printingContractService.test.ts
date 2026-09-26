import { describe, expect, it } from 'vitest';
import {
  buildPrintingContractDoc,
  hashContractContent,
  stableStringify,
} from '../../../services/printingContractService';

const baseContract: any = {
  id: 'c-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  school_id: 'sch-1',
  contract_number: 'PC-0007',
  title: 'Term 2 exam printing',
  status: 'active',
  prepaid_amount: 5000,
  max_assessments: 4,
  assessment_price: 1250,
  starts_at: '2026-01-05T00:00:00.000Z',
  ends_at: '2026-04-05T00:00:00.000Z',
  terms: 'Payment within 30 days. Reprints billed separately.',
  notes: 'Handle with care',
  version: 3,
  data: {
    lines: [
      { key: 'l1', assessment_name: 'Mathematics', assessment_grade: 'Grade 8', quantity: 2, unit_price: 1250 },
      { key: 'l2', assessment_name: 'English', quantity: 2, unit_price: 1250 },
    ],
    issued_invoice_id: 'INV-9',
  },
};

const sigBlock = (overrides: any = {}) => ({
  name: 'Jane Banda',
  role: 'Sales Manager',
  signatureDataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  mode: 'Draw',
  signedAt: '2026-09-19T10:00:00.000Z',
  signedBy: 'u-1',
  ...overrides,
});

describe('buildPrintingContractDoc', () => {
  it('maps parties, lines, totals, terms and invoice reference', async () => {
    const doc = await buildPrintingContractDoc({
      contract: baseContract,
      customerName: 'Acme School',
      schoolName: 'Acme Primary',
    });
    expect(doc.documentType).toBe('printing_contract');
    expect(doc.contractNumber).toBe('PC-0007');
    expect(doc.version).toBe(3);
    expect(doc.status).toBe('active');
    expect(doc.customerName).toBe('Acme School');
    expect(doc.schoolName).toBe('Acme Primary');
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0]).toMatchObject({ desc: 'Mathematics (Grade 8)', qty: 2, price: 1250, total: 2500 });
    expect(doc.prepaidAmount).toBe(5000);
    expect(doc.maxAssessments).toBe(4);
    expect(doc.assessmentPrice).toBe(1250);
    expect(doc.terms).toContain('30 days');
    expect(doc.issuedInvoiceId).toBe('INV-9');
    expect(doc.fullySigned).toBe(false);
    expect(doc.signatures).toEqual({ company: null, customer: null });
    expect(typeof doc.contentHash).toBe('string');
    expect(doc.contentHash.length).toBeGreaterThan(16);
  });

  it('synthesizes a fallback line when no billable lines exist', async () => {
    const doc = await buildPrintingContractDoc({
      contract: { ...baseContract, data: {} },
      customerName: 'Acme School',
    });
    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].desc).toBe('Term 2 exam printing');
  });

  it('carries both signatures and marks fully signed', async () => {
    const doc = await buildPrintingContractDoc({
      contract: {
        ...baseContract,
        data: {
          ...baseContract.data,
          signatures: { company: sigBlock(), customer: sigBlock({ name: 'Peter Phiri' }), history: [] },
        },
      },
      customerName: 'Acme School',
    });
    expect(doc.fullySigned).toBe(true);
    expect(doc.signatures.company?.name).toBe('Jane Banda');
    expect(doc.signatures.customer?.name).toBe('Peter Phiri');
  });

  it('drops malformed signature blocks instead of rendering garbage', async () => {
    const doc = await buildPrintingContractDoc({
      contract: {
        ...baseContract,
        data: { ...baseContract.data, signatures: { company: { name: '', signatureDataUrl: '' }, customer: null, history: [] } },
      },
      customerName: 'Acme School',
    });
    expect(doc.signatures.company).toBeNull();
    expect(doc.fullySigned).toBe(false);
  });

  it('refuses to build without a contract number', async () => {
    await expect(
      buildPrintingContractDoc({ contract: { ...baseContract, contract_number: '' }, customerName: 'X' })
    ).rejects.toThrow(/Contract number is required/);
  });

  it('carries the permanent verification token for QR routing', async () => {
    const doc = await buildPrintingContractDoc({
      contract: { ...baseContract, verificationToken: 'b'.repeat(64) },
      customerName: 'Acme School',
    });
    expect(doc.verificationToken).toBe('b'.repeat(64));
    const untokened = await buildPrintingContractDoc({ contract: baseContract, customerName: 'Acme School' });
    expect(untokened.verificationToken).toBeUndefined();
  });
});

describe('wallet-first document semantics (commercial agreement, not receipt)', () => {
  it('presents agreed commercial value and pricing, never a wallet balance', async () => {
    const doc = await buildPrintingContractDoc({
      contract: baseContract,
      customerName: 'Acme School',
      schoolName: 'Acme Primary',
    });
    // Agreed commercial figures present.
    expect(doc.prepaidAmount).toBe(5000);
    expect(doc.assessmentPrice).toBe(1250);
    expect(doc.maxAssessments).toBe(4);
    expect(doc.contractNumber).toBe('PC-0007');
    // The document has no wallet-balance concept: no such key anywhere.
    expect('walletBalance' in (doc as Record<string, unknown>)).toBe(false);
    expect(JSON.stringify(doc)).not.toContain('walletBalance');
  });

  it('contains no per-assessment payment language', async () => {
    const doc = await buildPrintingContractDoc({
      contract: baseContract,
      customerName: 'Acme School',
    });
    const text = JSON.stringify(doc).toLowerCase();
    expect(text).not.toContain('pay per assessment');
    expect(text).not.toContain('payment required per');
    expect(text).not.toContain('amount due');
    expect(text).not.toContain('outstanding');
  });

  it('keeps signatures, token passthrough and content hash intact', async () => {
    const doc = await buildPrintingContractDoc({
      contract: {
        ...baseContract,
        verificationToken: 'c'.repeat(64),
        data: {
          ...baseContract.data,
          signatures: { company: sigBlock(), customer: sigBlock({ name: 'Peter Phiri' }), history: [] },
        },
      },
      customerName: 'Acme School',
    });
    expect(doc.fullySigned).toBe(true);
    expect(doc.verificationToken).toBe('c'.repeat(64));
    expect(typeof doc.contentHash).toBe('string');
    expect(doc.contentHash.length).toBeGreaterThan(16);
  });
});

describe('content hash', () => {
  it('is deterministic for identical content', async () => {
    const a = await hashContractContent(stableStringify({ n: 'PC-1', v: 3 }));
    const b = await hashContractContent(stableStringify({ n: 'PC-1', v: 3 }));
    expect(a).toBe(b);
  });

  it('changes on any content change (amounts, terms, signatures)', async () => {
    const base = stableStringify({ n: 'PC-1', prepaid: 5000, terms: 't', sig: null });
    const changedAmount = stableStringify({ n: 'PC-1', prepaid: 5001, terms: 't', sig: null });
    const changedTerms = stableStringify({ n: 'PC-1', prepaid: 5000, terms: 't!', sig: null });
    const changedSig = stableStringify({ n: 'PC-1', prepaid: 5000, terms: 't', sig: 'img' });
    const h = await hashContractContent(base);
    expect(await hashContractContent(changedAmount)).not.toBe(h);
    expect(await hashContractContent(changedTerms)).not.toBe(h);
    expect(await hashContractContent(changedSig)).not.toBe(h);
  });

  it('is key-order insensitive (canonical)', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('end-to-end: doc hash changes when terms change', async () => {
    const a = await buildPrintingContractDoc({ contract: baseContract, customerName: 'Acme' });
    const b = await buildPrintingContractDoc({
      contract: { ...baseContract, terms: 'Different terms.' },
      customerName: 'Acme',
    });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});

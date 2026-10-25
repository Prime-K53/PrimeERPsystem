/**
 * printingContractCustomerIdentity.test.ts — PC-P726/024 regression suite.
 *
 * Defect history: commit 12cd867 replaced the view's local 1-arg
 * `customerNameOf(id, customers)` closure with an import that ignored the
 * customer list, so every call site effectively passed only the contract id.
 * `schoolNameOf` then returned a truthy `'—'`, `partySnapshot` persisted
 * `school_name: '—'`, and the document builders happily printed the raw id or
 * placeholder. This suite pins the display contract of the resolver layer so a
 * placeholder can never again reach a customer-facing document:
 *
 *   - resolve by the STABLE customer id, never by a display string;
 *   - a placeholder (`_`, `—`, `n/a`, bare `CUST-…`) is a missing reference —
 *     it is skipped and the fallback is used instead;
 *   - contact persons are never accepted as the business/school name;
 *   - the CONTENT DIGEST stays byte-identical for legacy records (display
 *     tightening must not invalidate already-issued documents).
 */
import { describe, expect, it } from 'vitest';
import {
  buildAssessmentCompletionReceiptDoc,
  buildContractIntegritySnapshot,
  buildContractScheduleDoc,
  buildPrintingContractDoc,
  hashContractRecord,
  resolveCustomerNameForDocument,
  resolveSchoolNameForDocument,
  stripCustomerIdSuffix,
} from '../../../services/printingContractService';

const baseContract = (overrides: Record<string, unknown> = {}): any => ({
  id: 'c-p726-024',
  company_id: 'co-1',
  customer_id: 'CUST-0035',
  school_id: 'sch-1',
  contract_number: 'PC-P726/024',
  title: 'Term 3 examination printing',
  status: 'draft',
  version: 2,
  customerName: '_',
  prepaid_amount: 5000,
  max_assessments: 5,
  assessment_price: 1000,
  starts_at: '2026-10-01T00:00:00.000Z',
  ends_at: '2027-03-31T00:00:00.000Z',
  created_at: '2026-09-30T08:00:00.000Z',
  data: {
    lines: [{ assessment_name: 'End of term examinations', quantity: 5, unit_price: 1000 }],
    school_name: 'Mphandula CDSS',
  },
  ...overrides,
});

const os = (input: Record<string, unknown> = {}) => ({
  contract: baseContract(),
  customerName: 'Mphandula CDSS',
  schoolName: 'Mphandula CDSS',
  ...input,
});

describe('resolveCustomerNameForDocument (display-only, placeholder-free)', () => {
  it('skips placeholders per candidate instead of stopping at the first truthy one', () => {
    expect(resolveCustomerNameForDocument('_', 'Mphandula CDSS')).toBe('Mphandula CDSS');
    expect(resolveCustomerNameForDocument('—', 'Mphandula CDSS')).toBe('Mphandula CDSS');
    expect(resolveCustomerNameForDocument('n/a', 'Mphandula CDSS')).toBe('Mphandula CDSS');
    expect(resolveCustomerNameForDocument('', 'Mphandula CDSS')).toBe('Mphandula CDSS');
  });

  it('never returns the bare customer id (an id is a reference, not a name)', () => {
    expect(resolveCustomerNameForDocument('CUST-0035', 'Mphandula CDSS')).toBe('Mphandula CDSS');
    expect(resolveCustomerNameForDocument('CUST-0035', '')).toBe('');
    expect(resolveCustomerNameForDocument('CUST-0035')).toBe('');
  });

  it('strips an id suffix from a real stored name', () => {
    expect(resolveCustomerNameForDocument('Mphandula CDSS (CUST-0035)')).toBe('Mphandula CDSS');
    expect(resolveCustomerNameForDocument('CUST-0035 - Mphandula CDSS')).toBe('Mphandula CDSS');
  });

  it('returns empty when nothing usable exists so callers can surface an error', () => {
    expect(resolveCustomerNameForDocument('_', '—')).toBe('');
    expect(resolveCustomerNameForDocument(null, undefined)).toBe('');
  });

  it('keeps the hash-side stripping rule unchanged (regression lock)', () => {
    // `resolveCustomerDisplayName` semantics are part of the stored digest;
    // stripCustomerIdSuffix is the shared primitive both rules stand on.
    expect(stripCustomerIdSuffix('CUST-0035')).toBe('');
    expect(stripCustomerIdSuffix('Mphandula CDSS (CUST-0035)')).toBe('Mphandula CDSS');
    expect(stripCustomerIdSuffix('—')).toBe('—');
  });
});

describe('resolveSchoolNameForDocument', () => {
  it('drops placeholders and ids to undefined', () => {
    expect(resolveSchoolNameForDocument('_')).toBeUndefined();
    expect(resolveSchoolNameForDocument('—')).toBeUndefined();
    expect(resolveSchoolNameForDocument('CUST-0035')).toBeUndefined();
    expect(resolveSchoolNameForDocument('')).toBeUndefined();
  });

  it('returns the real school name', () => {
    expect(resolveSchoolNameForDocument('Mphandula CDSS')).toBe('Mphandula CDSS');
    expect(resolveSchoolNameForDocument('Mphandula CDSS (CUST-0035)')).toBe('Mphandula CDSS');
  });
});

describe('buildPrintingContractDoc display resolution', () => {
  it('prints the school name when the stored contract name is the placeholder "_"', async () => {
    const doc = await buildPrintingContractDoc(os());
    expect(doc.customerName).toBe('Mphandula CDSS');
    expect(doc.schoolName).toBe('Mphandula CDSS');
    expect(doc.customerName).not.toBe('_');
    expect(doc.customerName).not.toContain('CUST-');
  });

  it('falls back to the caller-resolved customer name when the stored name is a bare id', async () => {
    const contract = baseContract({
      customerName: 'CUST-0035',
      data: { lines: [{ assessment_name: 'Exam', quantity: 5, unit_price: 1000 }] },
    });
    const doc = await buildPrintingContractDoc(os({
      contract,
      customerName: 'Green Valley School',
      schoolName: '',
    }));
    expect(doc.customerName).toBe('Green Valley School');
    expect(doc.customerName).not.toBe('CUST-0035');
    expect(doc.customerName).not.toBe('Customer');
  });

  it('does not let a stored placeholder school name hide the caller-resolved school', async () => {
    const contract = baseContract({
      customerName: 'Green Valley School',
      data: {
        lines: [{ assessment_name: 'Exam', quantity: 5, unit_price: 1000 }],
        school_name: '—',
      },
    });
    const doc = await buildPrintingContractDoc(os({ contract, schoolName: 'Green Valley Primary' }));
    expect(doc.customerName).toBe('Green Valley School');
    expect(doc.schoolName).toBe('Green Valley Primary');
  });

  it('keeps a valid stored legacy name (edits must not erase a valid reference)', async () => {
    const contract = baseContract({
      customerName: 'Legacy Stored School',
      data: { lines: [{ assessment_name: 'Exam', quantity: 5, unit_price: 1000 }], school_name: 'Legacy Stored School' },
    });
    const doc = await buildPrintingContractDoc(os({ contract, customerName: 'Different School' }));
    expect(doc.customerName).toBe('Legacy Stored School');
  });

  it('never falls back to a contact person as the business name', async () => {
    // A person's name in `customerContact` must never be promoted into the
    // business/school party line: with no usable customer or school name the
    // document prints the generic label, not the contact person.
    const contract = baseContract({
      customerName: '_',
      data: { lines: [{ assessment_name: 'Exam', quantity: 5, unit_price: 1000 }] },
    });
    const doc = await buildPrintingContractDoc(os({
      contract,
      customerName: '',
      schoolName: '',
      customerContact: 'Mr Banda',
    }));
    expect(doc.customerName).toBe('Customer');
    expect(doc.customerName).not.toBe('Mr Banda');
    expect(doc.customerContact).toBe('Mr Banda');
  });
});

describe('contract content digest (hash rule 1) is untouched by display tightening', () => {
  it('keeps legacy placeholder semantics so already-issued hashes still verify', async () => {
    // Historical rows were hashed WITH whatever the record stored, placeholder
    // or not. The display resolvers must never change this projection.
    const snapshot = buildContractIntegritySnapshot(baseContract());
    expect(snapshot.customerName).toBe('_');
    expect(snapshot.schoolName).toBe('Mphandula CDSS');
  });

  it('hashes identically across repeated runs and ignores caller display inputs', async () => {
    const first = await hashContractRecord(baseContract());
    const second = await hashContractRecord(baseContract());
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildContractScheduleDoc display resolution', () => {
  const items = [
    {
      id: 'it-1',
      contract_id: 'c-p726-024',
      assessment_name: 'Mid-term tests',
      status: 'reserved',
      item_price: 1000,
      assessment_date: '2026-11-02',
    },
  ] as any;

  it('prints the resolved name when the caller passes a placeholder as customerName', async () => {
    const doc = await buildContractScheduleDoc({
      contract: baseContract(),
      items,
      customerName: '_',
      schoolName: 'Mphandula CDSS',
      issuedAtIso: '2026-10-05T09:00:00.000Z',
    } as any);
    expect(doc.customerName).toBe('Mphandula CDSS');
    expect(doc.schoolName).toBe('Mphandula CDSS');
  });

  it('never prints the bare customer id on a schedule', async () => {
    const doc = await buildContractScheduleDoc({
      contract: baseContract(),
      items,
      customerName: 'CUST-0035',
      schoolName: 'Mphandula CDSS',
      issuedAtIso: '2026-10-05T09:00:00.000Z',
    } as any);
    expect(doc.customerName).toBe('Mphandula CDSS');
  });
});

describe('buildAssessmentCompletionReceiptDoc display resolution', () => {
  const item = {
    id: 'it-1',
    contract_id: 'c-p726-024',
    assessment_name: 'Mid-term tests',
    status: 'consumed',
    item_price: 1000,
    consumed_at: '2026-11-03T10:00:00.000Z',
  } as any;

  it('prints the resolved name when the caller passes the bare id', async () => {
    const doc = await buildAssessmentCompletionReceiptDoc({
      contract: baseContract(),
      item,
      items: [item],
      sequence: 1,
      amountDebited: 1000,
      walletBalanceAfter: 4000,
      walletTransactionId: 'wt-1',
      ledgerEntryId: 'le-1',
      customerName: 'CUST-0035',
      schoolName: 'Mphandula CDSS',
      issuedAtIso: '2026-11-03T10:05:00.000Z',
    } as any);
    expect(doc.customerName).toBe('Mphandula CDSS');
    expect(doc.customerName).not.toContain('CUST-');
  });

  it('prints the resolved name when the caller passes the placeholder "_"', async () => {
    const doc = await buildAssessmentCompletionReceiptDoc({
      contract: baseContract(),
      item,
      items: [item],
      sequence: 1,
      amountDebited: 1000,
      walletBalanceAfter: 4000,
      walletTransactionId: 'wt-1',
      ledgerEntryId: 'le-1',
      customerName: '_',
      schoolName: 'Mphandula CDSS',
      issuedAtIso: '2026-11-03T10:05:00.000Z',
    } as any);
    expect(doc.customerName).toBe('Mphandula CDSS');
  });
});

/**
 * completionReceiptDoc.test.ts — the completion-receipt document builder.
 *
 * Two customer-facing rules are locked here:
 *  - the internal customer id ("Mtakataka CCAP School (CUST-0033)", the bare
 *    "CUST-0033", or an id-prefixed line) must never reach a customer-facing
 *    receipt — the school name is used when the stored name is only the id —
 *    while a genuine qualifier ("St Mary's (Blantyre)") must survive;
 *  - the academic year of the engagement is always recorded as a DEFINED
 *    string: the field is covered by the content hash and JSONB drops
 *    undefined keys, so an absent key would re-hash differently from the
 *    issued document and break verification.
 */
import { describe, expect, it } from 'vitest';
import { buildAssessmentCompletionReceiptDoc } from '../../../services/printingContractService';

const contract: any = {
  id: 'PC-1',
  contract_number: 'PC-2026-0001',
  status: 'active',
  version: 7,
  prepaid_amount: 500000,
  consumed_amount: 125000,
  reserved_amount: 125000,
  max_assessments: 4,
  starts_at: '2026-09-01',
  data: {},
};

const item: any = {
  id: 'A-1',
  contract_id: 'PC-1',
  status: 'consumed',
  assessment_name: 'Mathematics Paper 1',
  assessment_grade: 'Grade 8',
  assessment_subject: 'Mathematics',
  item_price: 125000,
  consumed_at: '2026-10-19T00:00:00.000Z',
};

const build = (overrides: any = {}) =>
  buildAssessmentCompletionReceiptDoc({
    contract,
    item,
    items: [item],
    sequence: 1,
    amountDebited: 125000,
    walletBalanceAfter: 50000,
    walletTransactionId: 'WTX-A-1-CONSUMED',
    ledgerEntryId: 'LG-WTX-A-1-CONSUMED',
    customerName: 'Mtakataka CCAP School (CUST-0033)',
    schoolName: 'Mtakataka CCAP School',
    consumedAtIso: '2026-10-19T00:00:00.000Z',
    ...overrides,
  });

describe('completion receipt document', () => {
  it('never carries the internal customer id', async () => {
    const doc = await build();
    expect(doc.customerName).toBe('Mtakataka CCAP School');
  });

  it('falls back to the school name when the customer name is only the id', async () => {
    const doc = await build({ customerName: 'CUST-0033' });
    expect(doc.customerName).toBe('Mtakataka CCAP School');
  });

  it('strips a leading id line from the customer name', async () => {
    const doc = await build({ customerName: 'CUST-0033\nMtakataka CCAP School' });
    expect(doc.customerName).toBe('Mtakataka CCAP School');
  });

  it('strips an id prefix from the customer name', async () => {
    const doc = await build({ customerName: 'CUST-0033 Mtakataka CCAP School' });
    expect(doc.customerName).toBe('Mtakataka CCAP School');
  });

  it('keeps a genuine qualifier in the customer name', async () => {
    const doc = await build({ customerName: "St Mary's (Blantyre)" });
    expect(doc.customerName).toBe("St Mary's (Blantyre)");
  });

  it('derives the academic year from the contract window', async () => {
    const doc = await build();
    expect(doc.academicYear).toBe('2026/27');
  });

  it('prefers the academic year recorded on the contract', async () => {
    const doc = await build({ contract: { ...contract, data: { academic_year: '2025/26' } } });
    expect(doc.academicYear).toBe('2025/26');
  });

  it('always records an academic year, so the content hash stays stable', async () => {
    const doc = await build({
      contract: { ...contract, starts_at: undefined, ends_at: undefined, data: {} },
    });
    expect(doc.academicYear).toBe('');
    expect('academicYear' in doc).toBe(true);
  });
});

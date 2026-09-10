/**
 * Printing-contract invoice-style billing — pins the form math and the
 * contract → items → invoice issuance mapping.
 */
import { describe, it, expect } from 'vitest';
import {
  contractLineAmount,
  contractLinesTotal,
  contractLinesQuantity,
  isValidContractLine,
  buildContractItemsFromLines,
  buildInvoiceDraftFromContract,
  emptyContractLine,
  type ContractFormLine,
} from '../../utils/contractInvoiceDraft';

const line = (over: Partial<ContractFormLine> = {}): ContractFormLine => ({
  ...emptyContractLine(),
  assessment_name: 'Term 2 Grade 7 Mathematics',
  assessment_type: 'examination',
  assessment_grade: 'Grade 7',
  assessment_subject: 'Mathematics',
  quantity: 2,
  unit_price: 1500,
  ...over,
});

describe('contract line math', () => {
  it('computes line amount from floored quantity and non-negative price', () => {
    expect(contractLineAmount(line())).toBe(3000);
    expect(contractLineAmount(line({ quantity: 0 }))).toBe(0);
    expect(contractLineAmount(line({ unit_price: -5 }))).toBe(0);
  });

  it('totals lines and quantities', () => {
    expect(contractLinesTotal([line(), line({ quantity: 1, unit_price: 500 })])).toBe(3500);
    expect(contractLinesQuantity([line(), line({ quantity: 3 })])).toBe(5);
    expect(contractLinesTotal([])).toBe(0);
  });

  it('validates lines (named, qty >= 1, price >= 0)', () => {
    expect(isValidContractLine(line())).toBe(true);
    expect(isValidContractLine(line({ assessment_name: '  ' }))).toBe(false);
    expect(isValidContractLine(line({ quantity: 0 }))).toBe(false);
    expect(isValidContractLine(line({ unit_price: -1 }))).toBe(false);
  });
});

describe('buildContractItemsFromLines', () => {
  const ctx = {
    contract_id: 'c-1',
    company_id: 'co-1',
    customer_id: 'cust-1',
    school_id: 'sch-1',
    created_by: 'u-1',
    now: new Date().toISOString(),
  };

  it('expands each quantity unit into a reserved assessment record', () => {
    const items = buildContractItemsFromLines(ctx, [line()]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      contract_id: 'c-1',
      status: 'reserved',
      item_price: 1500,
      assessment_name: 'Term 2 Grade 7 Mathematics',
    });
  });

  it('skips invalid lines', () => {
    expect(buildContractItemsFromLines(ctx, [line({ assessment_name: '' })])).toHaveLength(0);
  });
});

describe('buildInvoiceDraftFromContract', () => {
  const ctx = {
    contract_number: 'PC-0007',
    contract_title: 'Term 2 exam printing',
    customer: { id: 'cust-1', name: 'Acme School', companyName: 'Acme School Ltd' },
    issuedDate: '2026-09-10',
  };

  it('builds an Unpaid invoice draft referenced to the contract', () => {
    const draft = buildInvoiceDraftFromContract(ctx, [line()]);
    expect(draft.status).toBe('Unpaid');
    expect(draft.paidAmount).toBe(0);
    expect(draft.totalAmount).toBe(3000);
    expect(draft.reference).toBe('PC-0007');
    expect(draft.customerId).toBe('cust-1');
    expect(draft.customerName).toBe('Acme School Ltd');
    expect(String(draft.notes)).toContain('PC-0007');
  });

  it('maps lines to service items with no inventory linkage', () => {
    const draft = buildInvoiceDraftFromContract(ctx, [line()]);
    expect(draft.items).toHaveLength(1);
    expect(draft.items?.[0]).toMatchObject({
      quantity: 2,
      price: 1500,
      type: 'Service',
      cost: 0,
    });
    expect(draft.items?.[0].productId).toBeUndefined();
    expect(draft.items?.[0].name).toContain('Grade 7');
  });
});

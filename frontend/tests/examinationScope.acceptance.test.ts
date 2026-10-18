/**
 * examinationScope.acceptance.test.ts
 *
 * ACCEPTANCE: examination invoices retain the correct branch.
 *
 * Drives the REAL `resolveExaminationInvoiceScope` used by
 * `examinationJobService.generateInvoiceForJobs`, with real job shapes:
 *
 *   * jobs tagged by STABLE id keep that branch on the invoice;
 *   * jobs whose names are shared by two branches are REFUSED (never guessed);
 *   * jobs spanning two different branch ids are REFUSED (invoice per branch);
 *   * a legacy name-only tag resolves only when the name is unique;
 *   * untagged jobs produce an explicitly Main invoice.
 */
import { describe, it, expect, vi } from 'vitest';

// The service pulls in IndexedDB-backed modules at import time; the exported
// scope resolver is pure, so the store is stubbed rather than driven.
vi.mock('../services/db', () => ({
  dbService: {
    getAll: vi.fn(async () => []),
    get: vi.fn(async () => null),
    put: vi.fn(async () => ''),
    delete: vi.fn(async () => true),
    bulkGet: vi.fn(async () => []),
  },
}));

import { resolveExaminationInvoiceScope } from '../services/examinationJobService';

type Job = Record<string, unknown>;

const ACME = {
  id: 'CUST-ACME',
  name: 'Acme Schools',
  subAccounts: [
    { id: 'SUB-A', name: 'Campus' },
    { id: 'SUB-B', name: 'Campus' },   // identical display name, different id
    { id: 'SUB-C', name: 'Fees' },
  ],
} as any;

const job = (extra: Job): Job => ({ id: `J-${Math.random().toString(36).slice(2)}`, ...extra });

describe('ACCEPTANCE 6 — examination invoice account scope', () => {
  it('untagged jobs produce an explicitly Main invoice', () => {
    const res = resolveExaminationInvoiceScope([job({}), job({})], ACME, 'Acme Schools');
    expect(res.subAccountId).toBeUndefined();
    expect(res.subAccountName).toBeUndefined();
    expect(res.scopeKey).toBe('main');
  });

  it('jobs tagged by stable id keep that exact branch', () => {
    const res = resolveExaminationInvoiceScope(
      [job({ sub_account_id: 'SUB-A', sub_account_name: 'Campus' }), job({ sub_account_id: 'SUB-A', sub_account_name: 'Campus' })],
      ACME, 'Acme Schools',
    );
    expect(res.subAccountId).toBe('SUB-A');
    expect(res.subAccountName).toBe('Campus');
  });

  it('jobs tagged by a unique legacy NAME still resolve to the stable id', () => {
    const res = resolveExaminationInvoiceScope([job({ sub_account_name: 'Fees' })], ACME, 'Acme Schools');
    expect(res.subAccountId).toBe('SUB-C');
    expect(res.subAccountName).toBe('Fees');
  });

  it('a name shared by two branches is REFUSED (never assigned to Main or a branch)', () => {
    expect(() => resolveExaminationInvoiceScope([job({ sub_account_name: 'Campus' })], ACME, 'Acme Schools'))
      .toThrowError(/cannot be identified/i);
  });

  it('two jobs with DIFFERENT branch ids are REFUSED (one invoice = one account)', () => {
    expect(() => resolveExaminationInvoiceScope(
      [job({ sub_account_id: 'SUB-A' }), job({ sub_account_id: 'SUB-B' })],
      ACME, 'Acme Schools',
    )).toThrowError(/across 2 accounts/i);
  });

  it('a branch id the school does not own is REFUSED', () => {
    expect(() => resolveExaminationInvoiceScope([job({ sub_account_id: 'SUB-FOREIGN' })], ACME, 'Acme Schools'))
      .toThrowError(/cannot be identified/i);
  });

  it('mixed id + name tags that resolve to the SAME branch produce one account', () => {
    const res = resolveExaminationInvoiceScope(
      [job({ sub_account_id: 'SUB-C' }), job({ sub_account_name: 'Fees' })],
      ACME, 'Acme Schools',
    );
    expect(res.subAccountId).toBe('SUB-C');
    expect(res.scopeKey).toContain('id:SUB-C');
  });

  it('an id tag plus an AMBIGUOUS name tag is refused (two accounts, not one)', () => {
    expect(() => resolveExaminationInvoiceScope(
      [job({ sub_account_id: 'SUB-A' }), job({ sub_account_name: 'Campus' })],
      ACME, 'Acme Schools',
    )).toThrowError(/across 2 accounts/i);
  });

  it('an unknown customer (no branch list) cannot have a branch invoice', () => {
    expect(() => resolveExaminationInvoiceScope([job({ sub_account_id: 'SUB-A' })], null, 'Ghost'))
      .toThrow();
  });
});
/**
 * contractSchedule.test.ts — the rendered assessment schedule.
 *
 * The customer-facing contract: one page, unambiguous dates, a fund position
 * the customer can reconcile, the status legend, the version's own identity,
 * and every exception printed on the face of the document.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import React from 'react';
import { webcrypto } from 'node:crypto';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { buildContractScheduleDoc } from '../../../services/printingContractService';
import { analysePages, norm } from './pdfAnalyse';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
      getRandomizers: undefined,
      getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b),
    },
    configurable: true,
    writable: true,
  });
});

const CONTRACT_ID = 'PC-SCH-R';

const makeContract = (over: any = {}) => ({
  id: CONTRACT_ID,
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  contract_number: 'PC-P726/023',
  status: 'active',
  version: 1,
  prepaid_amount: 319200,
  reserved_amount: 239400,
  consumed_amount: 79800,
  starts_at: '2026-10-19T00:00:00.000Z',
  ends_at: '2027-04-30T00:00:00.000Z',
  terms: 'Payment within 30 days. Reprints billed separately.',
  data: {
    total_candidature: 42,
    charge_per_candidate: 1900,
    assessment_spec: '8 Pages',
    assessment_sittings: 'Normal',
    academic_year: '2026/27',
    pricing_rules: { model: 'per_candidate' },
  },
  ...over,
});

const makeItem = (over: any = {}) => ({
  id: `A-${Math.random().toString(16).slice(2)}`,
  contract_id: CONTRACT_ID,
  assessment_name: 'Assessment',
  assessment_grade: 'Standard 8',
  assessment_subject: 'All',
  status: 'reserved',
  item_price: 79800,
  ...over,
});

const fourAssessments = () => ([
  makeItem({ id: 'A-1', status: 'consumed', assessment_date: '2026-10-19' }),
  makeItem({ id: 'A-2', assessment_date: '2026-10-21' }),
  makeItem({ id: 'A-3', assessment_date: '2027-01-06' }),
  makeItem({ id: 'A-4', assessment_date: '2027-02-18' }),
]);

async function renderSchedule(doc: any): Promise<string> {
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type: 'CONTRACT_SCHEDULE', data: doc })
  ).toString()) as unknown as string;
  const pages = analysePages(Buffer.from(str, 'latin1'));
  return pages.map((p) => p.text).join(' ');
}

async function buildDoc(contract: any, items: any[]) {
  return buildContractScheduleDoc({
    contract,
    items,
    customerName: 'MUA RC Primary School',
    schoolName: 'Mankhamba Zone',
    issuedAtIso: '2026-10-18T08:31:00.000Z',
    verificationToken: 'a'.repeat(48),
  });
}

describe('the assessment schedule as the customer receives it', () => {
  it('is ONE page, and carries NO verification result', async () => {
    const doc: any = await buildDoc(makeContract(), fourAssessments());
    const str = (await pdf(
      React.createElement(PrimeDocument as any, { type: 'CONTRACT_SCHEDULE', data: doc })
    ).toString()) as unknown as string;
    const pages = analysePages(Buffer.from(str, 'latin1'));
    const text = pages.map((p) => p.text).join(' ');

    // The schedule is a single page: the review's layout criterion.
    expect(pages.length).toBe(1);
    expect(text).toContain(norm('Page 1 of 1'));

    // The VERIFICATION RESULT is not printed. The customer scans the QR and
    // reads the document id, version, issue date and status on the
    // verification page — exactly like the general invoice. Nothing of that
    // panel may appear on the printout.
    expect(text).not.toContain(norm('VERIFY THIS DOCUMENT'));
    expect(text).not.toContain(norm('Document ID'));
    expect(text).not.toContain(norm('Schedule version'));
    expect(text).not.toContain(norm('Verify this document'));

    // What DOES belong on paper: the QR and the verification copy, printed ONCE
    // (never repeated on every page), plus the tamper-evidence digest.
    expect(text).toContain(norm('Digitally generated'));
    expect(text).toContain(norm('Verification available online'));
    expect(text).toContain(norm('DOCUMENT INTEGRITY'));
    expect(text).toContain(norm('Content hash'));
    // The verification block is rendered once, after the last block of the
    // document - never on every page.
    const blockCount = (text.match(/DIGITALLYGENERATED/g) || []).length;
    expect(blockCount).toBe(1);
    pages.forEach((page) => {
      expect((page.text.match(/DIGITALLYGENERATED/g) || []).length).toBeLessThanOrEqual(1);
    });

    // "19 Oct 2026" — never "19/10/2026", never "10/19/2026".
    expect(text).toContain(norm('19 Oct 2026'));
    expect(text).toContain(norm('6 Jan 2027'));
    expect(text).not.toContain(norm('19/10/2026'));
    // The period states both years and reads as a range.
    expect(text).toContain(norm('19 Oct 2026 to 30 Apr 2027'));
    expect(text).toContain(norm('Assessment Schedule'));
    expect(text).toContain(norm('PC-P726/023'));
    expect(text).toContain(norm('MUA RC Primary School'));
  }, 120000);

  it('prints the verification block ONCE when the schedule runs to two pages', async () => {
    // The failure the staff reported: the verification block appeared on BOTH
    // pages. It must be rendered once, after the last block of the document.
    const many = Array.from({ length: 12 }, (_, i) => makeItem({
      id: `A-${i + 1}`,
      assessment_date: `2026-${String((i % 12) + 1).padStart(2, '0')}-10`,
    }));
    const doc: any = await buildDoc(makeContract({
      prepaid_amount: 957600,
      reserved_amount: 957600,
      consumed_amount: 0,
      terms: 'Payment within 30 days. Reprints billed separately. '
        + 'Payment within 30 days. Reprints billed separately. '
        + 'Payment within 30 days. Reprints billed separately.',
    }), many);
    const str = (await pdf(
      React.createElement(PrimeDocument as any, { type: 'CONTRACT_SCHEDULE', data: doc })
    ).toString()) as unknown as string;
    const pages = analysePages(Buffer.from(str, 'latin1'));
    expect(pages.length).toBeGreaterThan(1);
    const withBlock = pages.filter((p) => /DIGITALLYGENERATED/.test(p.text));
    expect(withBlock.length).toBe(1);
    // ...and it is on the FINAL page.
    expect(withBlock[0]).toBe(pages[pages.length - 1]);
  }, 120000);

  it('prints the fund position, the legend and the currency unit', async () => {
    const doc: any = await buildDoc(makeContract(), fourAssessments());
    const text = await renderSchedule(doc);
    expect(text).toContain(norm('Contract value (commercial)'));
    expect(text).toContain(norm('Reserved'));
    expect(text).toContain(norm('Consumed'));
    expect(text).toContain(norm('Available balance'));
    expect(text).toContain(norm('K239,400.00'));
    expect(text).toContain(norm('K79,800.00'));
    // The legend defines the statuses in the customer's terms.
    expect(text).toContain(norm('Reserved: committed to a scheduled assessment'));
    expect(text).toContain(norm('Consumed: completed and chargeable'));
    expect(text).toContain(norm('Released: reservation returned to the available balance'));
    // The currency unit is stated once, so the amounts cannot be misread.
    expect(text).toMatch(/ALLAMOUNTSIN[A-Z]{3}/);
    // A separator must never be broken by a line wrap (react-pdf hyphenates a
    // word it splits, which printed a stray "-" on the document).
    expect(text).not.toContain(norm('·-'));
  }, 120000);

  it('does NOT print the issued version identity', async () => {
    const doc: any = await buildDoc(makeContract(), fourAssessments());
    const text = await renderSchedule({ ...doc, documentId: 'SCH-PC-SCH-R-v1', documentVersion: 1 });
    expect(text).not.toContain(norm('SCH-PC-SCH-R-V1'));
    expect(text).not.toContain(norm('Version 1'));
    // The issue date stays in the document header, like every other document.
    expect(text).toContain(norm('Issued: 18 Oct 2026'));
  }, 120000);

  it('prints an out-of-period assessment on the face of the document', async () => {
    const doc: any = await buildDoc(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', assessment_date: '2027-06-01' }),
    ]);
    const text = await renderSchedule(doc);
    expect(text).toContain(norm('Schedule needs review'));
    expect(text).toContain(norm('outside contract period'));
    expect(text).toContain(norm('1 Jun 2027'));
    expect(text).toContain(norm('after the contract period ends'));
  }, 120000);

  it('prints a price that disagrees with the agreed pricing basis', async () => {
    const doc: any = await buildDoc(makeContract(), [
      makeItem({ id: 'A-1', item_price: 90000, assessment_date: '2026-10-19' }),
    ]);
    const text = await renderSchedule(doc);
    expect(text).toContain(norm('Schedule needs review'));
    expect(text).toContain(norm('K90,000.00'));
    expect(text).toContain(norm('K79,800.00'));
  }, 120000);

  it('shows a released assessment as a movement, never as an addition', async () => {
    const doc: any = await buildDoc(makeContract({
      prepaid_amount: 1000000,
      reserved_amount: 0,
      consumed_amount: 400000,
      data: { closure: { status: 'closed', releasedValue: 600000 } },
    }), [
      makeItem({ id: 'A-1', status: 'consumed', item_price: 400000, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'released', item_price: 600000, assessment_date: '2026-10-21' }),
    ]);
    const text = await renderSchedule(doc);
    expect(text).toContain(norm('Released (returned to balance)'));
    expect(text).toContain(norm('K600,000.00'));
    // The schedule value is the entitlement, not the released value.
    expect(text).toContain(norm('K400,000.00'));
    expect(text).toContain(norm('released assessment excluded from the schedule value'));
    // The count that labels the value covers only what the value covers.
    expect(text).toContain(norm('1 of 2 active assessments'));
  }, 120000);
});

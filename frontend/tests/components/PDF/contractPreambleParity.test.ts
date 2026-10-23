/**
 * contractPreambleParity.test.ts — the assessment schedule and the assessment
 * completion receipt are a matched pair.
 *
 * Both documents open with the same formal preamble: company name, document
 * title, then the addressee. The completion receipt used to print its title at
 * 20pt while the schedule used 18pt, so the pair looked mismatched. This test
 * locks the first-page type scale of the two preambles together — the company
 * name and the title must use the exact same sizes on both documents.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { buildContractScheduleDoc } from '../../../services/printingContractService';
import { dictObjects, inflateStream } from './pdfAnalyse';

const companyName = 'PrimeERP';

const receipt: any = {
  receiptNumber: 'PCR-PC-0007',
  contractNumber: 'PC-0007',
  date: '19/10/2026',
  version: 2,
  status: 'active',
  customerName: 'Mtakataka CCAP School',
  schoolName: 'Mtakataka CCAP School',
  academicYear: '2026/27',
  item: {
    assessmentName: 'Mathematics Paper 1',
    grade: 'Grade 8',
    subject: 'Mathematics',
    consumedAt: '18/10/2026',
    unitPrice: 1250,
  },
  sequence: 2,
  totalAssessments: 4,
  completedToDate: 2,
  remainingAssessments: 2,
  contractValue: 5000,
  amountDebited: 1250,
  totalConsumedToDate: 2500,
  remainingReservedFunds: 1250,
  unallocatedFunds: 1250,
  walletBalanceAfter: 500,
  walletTransactionId: 'wt-9f2c4a71',
  ledgerEntryId: 'le-71ab9c02',
  contentHash: 'c'.repeat(64),
};

const contract: any = {
  id: 'PC-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  contract_number: 'PC-0007',
  status: 'active',
  version: 1,
  prepaid_amount: 5000,
  reserved_amount: 2500,
  consumed_amount: 2500,
  max_assessments: 4,
  starts_at: '2026-10-19T00:00:00.000Z',
  ends_at: '2027-04-30T00:00:00.000Z',
  data: {},
};

const item: any = {
  id: 'A-1',
  contract_id: 'PC-1',
  assessment_name: 'Mathematics Paper 1',
  assessment_grade: 'Grade 8',
  assessment_subject: 'Mathematics',
  status: 'reserved',
  item_price: 1250,
  assessment_date: '2026-10-21',
};

/** Font sizes (the operands of every `Tf`) in the first page's content stream. */
const firstPageFontSizes = (pdfString: string): number[] => {
  const buf = Buffer.from(pdfString, 'latin1');
  const page = dictObjects(pdfString).find((o) => /\/Type\s*\/Page(?!s)/.test(o.dict));
  if (!page) return [];
  const refs: number[] = [];
  const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(page.dict);
  if (arr) {
    for (const m of arr[1].matchAll(/(\d+)\s+\d+\s+R/g)) refs.push(Number(m[1]));
  } else {
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(page.dict);
    if (single) refs.push(Number(single[1]));
  }
  const content = refs.map((r) => inflateStream(buf, r)?.toString('latin1') || '').join('\n');
  return [...content.matchAll(/\/F\d+\s+([\d.]+)\s+Tf/g)].map((m) => Number(m[1]));
};

const render = async (type: string, data: any): Promise<string> =>
  String(await pdf(
    React.createElement(PrimeDocument as any, { type, data, config: { companyName } })
  ).toString());

describe('contract preamble type parity', () => {
  it('prints the completion receipt company name and title at the schedule sizes', async () => {
    const scheduleDoc = await buildContractScheduleDoc({
      contract,
      items: [item],
      customerName: 'Mtakataka CCAP School',
      schoolName: 'Mtakataka CCAP School',
      issuedAtIso: '2026-10-18T08:31:00.000Z',
      verificationToken: 'a'.repeat(48),
    });

    const receiptSizes = firstPageFontSizes(await render('CONTRACT_COMPLETION_RECEIPT', receipt));
    const scheduleSizes = firstPageFontSizes(await render('CONTRACT_SCHEDULE', scheduleDoc));

    // Page furniture (8pt) precedes the preamble, whose first two text runs
    // are the company name and the document title. Both documents must agree
    // on those sizes exactly.
    expect(scheduleSizes.slice(1, 3)).toEqual([18, 18]);
    expect(receiptSizes.slice(1, 3)).toEqual(scheduleSizes.slice(1, 3));
  }, 120000);
});

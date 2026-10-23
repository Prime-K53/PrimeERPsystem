/**
 * completionReceiptLayout.test.ts — CONTRACT_COMPLETION_RECEIPT layout.
 *
 * The completion receipt is rendered in the PAYMENT RECEIPT's visual
 * language: formal centred company header, centred title, addressee row,
 * two-column metadata grid, bordered "Completion Details Table" and
 * "Completion & Fund Position" blocks, boxed canonical linkage, Notes
 * Section, closing thank-you line and the integrity/verification footer.
 *
 * The test locks that structure AND that every figure the document used to
 * carry is still printed — a redesign must never drop a financial figure.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { analysePages, norm } from './pdfAnalyse';

const receipt: any = {
  receiptNumber: 'PCR-PC-0007',
  contractNumber: 'PC-0007',
  date: '19/10/2026',
  version: 2,
  status: 'active',
  customerName: 'Chikondi Community Secondary School',
  schoolName: 'Chikondi Community Secondary School',
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
  notes: 'Payment within 30 days of invoice. Reprints billed separately.',
  contentHash: 'c'.repeat(64),
};

const renderPages = async (doc: any = receipt): Promise<string[]> => {
  const out = await pdf(
    React.createElement(PrimeDocument as any, {
      type: 'CONTRACT_COMPLETION_RECEIPT',
      data: doc,
    })
  ).toString();
  return analysePages(Buffer.from(out as any, 'latin1')).map((p) => p.text);
};

const renderText = async (doc: any = receipt): Promise<string> =>
  (await renderPages(doc)).join(' ');

describe('contract completion receipt layout', () => {
  it('uses the payment receipt structure', async () => {
    const text = norm(await renderText());

    // Header, title and addressee.
    expect(text).toContain('ASSESSMENTCOMPLETIONRECEIPT');
    expect(text).toContain('CUSTOMERNAME:CHIKONDICOMMUNITYSECONDARYSCHOOL');

    // Two-column metadata grid.
    expect(text).toContain('RECEIPTNO:PCR-PC-0007');
    expect(text).toContain('CONTRACTNO:PC-0007');
    expect(text).toContain('CURRENCY:');
    expect(text).toContain('DATE:19/10/2026');
    expect(text).toContain('ACADEMICYEAR:2026/27');
    expect(text).toContain('SEQUENCE:2');
    expect(text).toContain('STATUS:ACTIVE');

    // Bordered details table and the fund-position block.
    expect(text).toContain('COMPLETIONDETAILSTABLE');
    expect(text).toContain('DESCRIPTION');
    expect(text).toContain('PRICE');
    expect(text).toContain('DEBITED');
    expect(text).toContain('COMPLETION&FUNDPOSITION');
    expect(text).toContain('COMPLETIONPROGRESS2/4');
    expect(text).toContain('REMAININGASSESSMENTS2');
    expect(text).toContain('CONTRACTVALU');
    expect(text).toContain('RESERVEDFUNDS');
    expect(text).toContain('UNALLOCATEDFUNDS');

    // Boxed linkage, notes and closing line.
    expect(text).toContain('CANONICALLINKAGE');
    expect(text).toContain('WALLETTRANSACTION:WT-9F2C4A71');
    expect(text).toContain('LEDGERENTRY:LE-71AB9C02');
    expect(text).toContain('NOTESSECTION');
    expect(text).toContain('THANKYOUFORCHOOSING');

    // Integrity + verification footer.
    expect(text).toContain('DOCUMENTINTEGRITY');
    expect(text).toContain(`CONTENTHASH:${'C'.repeat(64)}`);
  });

  it('still prints every financial figure of the completion', async () => {
    const text = norm(await renderText());

    expect(text).toContain('K1,250.00'); // assessment price + amount debited
    expect(text).toContain('K2,500.00'); // consumed to date
    expect(text).toContain('K500.00'); // wallet balance after
    expect(text).toContain('K5,000.00'); // contract value
    expect(text).toContain('CONSUMED:18/10/2026');
  });

  it('prints the customer name alone, without the internal customer id', async () => {
    const pages = await renderPages({
      ...receipt,
      // The contract screens assemble the display name with the customer id.
      customerName: 'Mtakataka CCAP School (CUST-0033)',
      schoolName: 'Mtakataka CCAP School',
    });
    const text = norm(pages.join(' '));

    expect(text).toContain('CUSTOMERNAME:MTAKATAKACCAPSCHOOL');
    expect(text).not.toContain('CUST-0033');
    // The school name repeats the customer name — the addressee block states
    // it once (the continuation header of a later page repeats it by design).
    expect(norm(pages[0]).match(/MTAKATAKACCAPSCHOOL/g)?.length).toBe(1);
  });
});

/**
 * printingContract.test.ts — PRINTING_CONTRACT document verification.
 *
 * Schema + validation gates, rendered content (parties, terms, dual
 * signatures, integrity hash), honest pagination (no QR claims anywhere),
 * and QA artifacts for human inspection.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { PrintingContractSchema } from '../../../views/shared/components/PDF/schemas';
import { validateDocumentData } from '../../../views/shared/components/PDF/documentValidation';
import { buildPrintingContractDoc } from '../../../services/printingContractService';
import { analysePages, norm } from './pdfAnalyse';

// Valid 1x1 PNGs (signature stand-ins the renderer can decode).
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_1PX_RED = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const baseContract: any = {
  id: 'c-7',
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
  terms: 'Payment within 30 days of invoice. Reprints billed separately.',
  version: 2,
  data: {
    lines: [
      { key: 'l1', assessment_name: 'Mathematics', assessment_grade: 'Grade 8', quantity: 2, unit_price: 1250 },
      { key: 'l2', assessment_name: 'English', quantity: 2, unit_price: 1250 },
    ],
    issued_invoice_id: 'INV-9',
  },
};

const sig = (overrides: any = {}) => ({
  name: 'Jane Banda',
  role: 'Sales Manager',
  signatureDataUrl: PNG_1PX,
  mode: 'Draw',
  signedAt: '2026-09-19T10:00:00.000Z',
  signedBy: 'u-1',
  ...overrides,
});
async function renderPdf(data: any): Promise<Buffer> {
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type: 'PRINTING_CONTRACT', data })
  ).toString()) as unknown as string;
  return Buffer.from(str, 'latin1');
}

describe('printing contract schema + validation', () => {
  it('accepts a builder-produced document', async () => {
    const doc = await buildPrintingContractDoc({ contract: baseContract, customerName: 'Acme School' });
    expect(() => PrintingContractSchema.parse(doc)).not.toThrow();
    expect(validateDocumentData('PRINTING_CONTRACT', doc)).toEqual({ valid: true });
  });

  it('rejects missing identity, empty lines, and missing hash', async () => {
    const doc: any = await buildPrintingContractDoc({ contract: baseContract, customerName: 'Acme School' });
    expect(validateDocumentData('PRINTING_CONTRACT', { ...doc, contractNumber: '' }).valid).toBe(false);
    expect(validateDocumentData('PRINTING_CONTRACT', { ...doc, lines: [] }).valid).toBe(false);
    expect(validateDocumentData('PRINTING_CONTRACT', { ...doc, contentHash: '' }).valid).toBe(false);
  });
});

describe('rendered contract content', () => {
  it('unsigned document shows parties, terms, totals and Not-signed blocks (no QR claims)', async () => {
    const doc = await buildPrintingContractDoc({ contract: baseContract, customerName: 'Acme School', schoolName: 'Acme Primary' });
    const pages = analysePages(await renderPdf(PrintingContractSchema.parse(doc)));
    expect(pages).toHaveLength(1);
    const text = pages[0].text;
    expect(text).toContain(norm('Printing Contract'));
    expect(text).toContain(norm('PC-0007'));
    expect(text).toContain(norm('Acme School'));
    expect(text).toContain(norm('Acme Primary'));
    expect(text).toContain(norm('Payment within 30 days'));
    expect(text).toContain(norm('K5,000.00'));
    expect(text).toContain(norm('Not signed'));
    expect(text).toContain(norm('DOCUMENT INTEGRITY'));
    expect(text).toContain(norm((doc as any).contentHash));
    expect(text).toContain(norm('Page 1 of 1'));
    // Honest v1: no QR image and no QR-verification claims anywhere.
    expect(pages[0].drawnImages).toHaveLength(0);
    expect(text).not.toContain(norm('SCAN TO VERIFY'));
    expect(text).not.toContain(norm('QR code on the final page'));
  }, 120000);

  it('fully-signed document embeds both signature images with names and dates', async () => {
    const doc = await buildPrintingContractDoc({
      contract: {
        ...baseContract,
        data: {
          ...baseContract.data,
          // Distinct image bytes per party (identical bytes would embed once).
          signatures: {
            company: sig(),
            customer: sig({ name: 'Peter Phiri', role: 'Head Teacher', signatureDataUrl: PNG_1PX_RED }),
            history: [],
          },
        },
      },
      customerName: 'Acme School',
    });
    const pages = analysePages(await renderPdf(PrintingContractSchema.parse(doc)));
    expect(pages).toHaveLength(1);
    const text = pages[0].text;
    expect(text).toContain(norm('Fully signed'));
    expect(text).toContain(norm('Jane Banda'));
    expect(text).toContain(norm('Peter Phiri'));
    expect(text).toContain(norm('Head Teacher'));
    expect(text).not.toContain(norm('Not signed'));
    // Both signature PNGs are drawn on the page.
    expect(pages[0].drawnImages.length).toBeGreaterThanOrEqual(2);
  }, 120000);

  it('cancelled contracts render the CANCELLED watermark', async () => {
    const doc = await buildPrintingContractDoc({
      contract: { ...baseContract, status: 'cancelled' },
      customerName: 'Acme School',
    });
    const pages = analysePages(await renderPdf(PrintingContractSchema.parse(doc)));
    expect(pages.map((p) => p.text).join(' ')).toContain(norm('CANCELLED'));
  }, 120000);
});

describe('contract pagination honesty', () => {
  it('long terms flow across pages with continuation and QR-free intermediate notes', async () => {
    const longTerms = Array.from({ length: 60 }, (_, i) => `Term clause ${i + 1}: all printed materials remain subject to quality inspection before acceptance.`).join(' ');
    const doc = await buildPrintingContractDoc({
      contract: { ...baseContract, terms: longTerms },
      customerName: 'Acme School',
    });
    const pages = analysePages(await renderPdf(PrintingContractSchema.parse(doc)));
    const total = pages.length;
    expect(total).toBeGreaterThanOrEqual(2);
    pages.forEach((p, i) => {
      expect(p.text).toContain(norm(`Page ${i + 1} of ${total}`));
      expect(p.text.length).toBeGreaterThan(200);
    });
    // Intermediate pages carry the honest verification note; pages 2+
    // carry the continuation header. The final page carries neither.
    for (let i = 0; i < total - 1; i += 1) {
      expect(pages[i].text).toContain(norm('Quote the contract number and content hash to verify'));
      expect(pages[i].text).not.toContain(norm('QR code on the final page'));
      expect(pages[i].text).not.toContain(norm('DOCUMENT INTEGRITY'));
      if (i > 0) {
        expect(pages[i].text).toContain(norm('Contract PC-0007'));
        expect(pages[i].text).toContain(norm('continued'));
      }
    }
    // Integrity block flows to the final page only.
    expect(pages[total - 1].text).toContain(norm('DOCUMENT INTEGRITY'));
  }, 120000);
});

describe('visual QA artifacts (os.tmpdir only — never committed)', () => {
  it('writes representative contract PDFs for human inspection', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const dir = path.join(os.tmpdir(), 'prime-contract-qa');
    fs.mkdirSync(dir, { recursive: true });

    const signed = await buildPrintingContractDoc({
      contract: {
        ...baseContract,
        data: {
          ...baseContract.data,
          signatures: { company: sig(), customer: sig({ name: 'Peter Phiri', role: 'Head Teacher' }), history: [] },
        },
      },
      customerName: 'Acme School',
      schoolName: 'Acme Primary',
    });
    fs.writeFileSync(path.join(dir, 'contract-signed.pdf'), await renderPdf(PrintingContractSchema.parse(signed)));

    const unsigned = await buildPrintingContractDoc({
      contract: baseContract,
      customerName: 'Acme School',
      schoolName: 'Acme Primary',
    });
    fs.writeFileSync(path.join(dir, 'contract-unsigned.pdf'), await renderPdf(PrintingContractSchema.parse(unsigned)));

    // eslint-disable-next-line no-console
    console.log(`contract QA PDFs written to ${dir}`);
    expect(fs.existsSync(path.join(dir, 'contract-signed.pdf'))).toBe(true);
  }, 120000);
});

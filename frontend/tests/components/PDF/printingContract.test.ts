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
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { analysePages, analyseWithQr, norm } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';
const TOK = 'a'.repeat(64);

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
  verificationToken: TOK,
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

async function renderBoth(secured: any) {
  const withoutQr: any = { ...secured };
  delete withoutQr.securityQrCodeDataUrl;
  delete withoutQr.securityQrPayload;
  const [withQr, without] = await Promise.all([renderPdf(secured), renderPdf(withoutQr)]);
  return analyseWithQr(withQr, without);
}

async function securedDoc(contract: any, customerName = 'Acme School', schoolName?: string) {
  const doc = await buildPrintingContractDoc({ contract, customerName, schoolName });
  return attachDocumentSecurity(PrintingContractSchema.parse(doc), COMPANY);
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
  it('unsigned document shows parties, terms, totals and Not-signed blocks with QR footer', async () => {
    const secured: any = await securedDoc(baseContract, 'Acme School', 'Acme Primary');
    expect(secured.securityQrPayload).toContain('/#/verify/printing-contract/PC-0007');
    const { pages, qrObj } = await renderBoth(secured);
    expect(pages.length).toBeLessThanOrEqual(2);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Printing Contract'));
    expect(text).toContain(norm('PC-0007'));
    expect(text).toContain(norm('Acme School'));
    expect(text).toContain(norm('Acme Primary'));
    expect(text).toContain(norm('Payment within 30 days'));
    expect(text).toContain(norm('K5,000.00'));
    expect(text).toContain(norm('Not signed'));
    expect(text).toContain(norm('DOCUMENT INTEGRITY'));
    expect(text).toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(text).toContain(norm('SCAN TO VERIFY'));
    // QR is drawn on the final page only.
    pages.forEach((p, i) => {
      if (i < pages.length - 1) expect(p.drawnImages).not.toContain(qrObj);
      else expect(p.drawnImages).toContain(qrObj);
    });
  }, 120000);

  it('fully-signed document embeds both signature images with names and dates', async () => {
    const secured: any = await securedDoc(
      {
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
      'Acme School',
    );
    const { pages, qrObj } = await renderBoth(secured);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Fully signed'));
    expect(text).toContain(norm('Jane Banda'));
    expect(text).toContain(norm('Peter Phiri'));
    expect(text).toContain(norm('Head Teacher'));
    expect(text).not.toContain(norm('Not signed'));
    // QR plus both signature PNGs are drawn (signatures may paginate
    // ahead of the final-page QR footer — aggregate across pages).
    const allDrawn = pages.flatMap((p) => p.drawnImages);
    expect(allDrawn).toContain(qrObj);
    expect(allDrawn.length).toBeGreaterThanOrEqual(3);
  }, 120000);

  it('cancelled contracts render the CANCELLED watermark', async () => {
    const secured: any = await securedDoc({ ...baseContract, status: 'cancelled' });
    const { pages } = await renderBoth(secured);
    expect(pages.map((p) => p.text).join(' ')).toContain(norm('CANCELLED'));
  }, 120000);
});

describe('contract pagination honesty', () => {
  it('long terms flow across pages with continuation, QR footer and integrity placement', async () => {
    const longTerms = Array.from({ length: 60 }, (_, i) => `Term clause ${i + 1}: all printed materials remain subject to quality inspection before acceptance.`).join(' ');
    const secured: any = await securedDoc({ ...baseContract, terms: longTerms });
    const { pages, qrObj } = await renderBoth(secured);
    const total = pages.length;
    expect(total).toBeGreaterThanOrEqual(2);
    pages.forEach((p, i) => {
      expect(p.text).toContain(norm(`Page ${i + 1} of ${total}`));
      expect(p.text.length).toBeGreaterThan(200);
    });
    // Intermediate pages: continuation header + QR verification note.
    for (let i = 0; i < total - 1; i += 1) {
      expect(pages[i].drawnImages).not.toContain(qrObj);
      expect(pages[i].text).toContain(norm('QR code on the final page'));
      expect(pages[i].text).not.toContain(norm('DOCUMENT INTEGRITY'));
      expect(pages[i].text).not.toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
      if (i > 0) {
        expect(pages[i].text).toContain(norm('Contract PC-0007'));
        expect(pages[i].text).toContain(norm('continued'));
      }
    }
    // Final page: QR drawn, both auth blocks, integrity evidence retained.
    const final = pages[total - 1];
    expect(final.drawnImages).toContain(qrObj);
    expect(final.text).toContain(norm('DOCUMENT AUTHENTICATION & VERIFICATION'));
    expect(final.text).toContain(norm('SCAN TO VERIFY'));
    expect(final.text).toContain(norm('DOCUMENT INTEGRITY'));
  }, 120000);
});

describe('visual QA artifacts (os.tmpdir only — never committed)', () => {
  it('writes representative contract PDFs for human inspection', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');
    const dir = path.join(os.tmpdir(), 'prime-contract-qa');
    fs.mkdirSync(dir, { recursive: true });

    const signed = await securedDoc(
      {
        ...baseContract,
        data: {
          ...baseContract.data,
          signatures: { company: sig(), customer: sig({ name: 'Peter Phiri', role: 'Head Teacher' }), history: [] },
        },
      },
      'Acme School',
      'Acme Primary',
    );
    fs.writeFileSync(path.join(dir, 'contract-signed.pdf'), await renderPdf(signed));

    const unsigned = await securedDoc(baseContract, 'Acme School', 'Acme Primary');
    fs.writeFileSync(path.join(dir, 'contract-unsigned.pdf'), await renderPdf(unsigned));

    // eslint-disable-next-line no-console
    console.log(`contract QA PDFs written to ${dir}`);
    expect(fs.existsSync(path.join(dir, 'contract-signed.pdf'))).toBe(true);
  }, 120000);
});

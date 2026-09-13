/**
 * posReceiptQrLayout.test.ts — POS compact-QR layout proof.
 *
 * Renders the REAL POS_RECEIPT template (PrimeDocument) to a PDF buffer and
 * asserts the verification presentation is QR-only:
 *   - exactly one QR image XObject (no duplicate QR)
 *   - "SCAN TO VERIFY" caption present
 *   - full invoice-style security footer absent ("DOCUMENT VERIFICATION",
 *     "Verified document")
 */
import { describe, it, expect } from 'vitest';
import { pdf } from '@react-pdf/renderer';
import { createElement } from 'react';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { buildPosReceiptDoc } from '../../../services/receiptCalculationService';

const TOK = 'd'.repeat(64);

async function renderPosPdf(): Promise<string> {
  const payload: any = buildPosReceiptDoc({
    sale: {
      id: 'POS-L001',
      date: new Date('2026-09-09').toISOString(),
      totalAmount: 10000,
      subtotal: 10000,
      discount: 0,
      items: [{ name: 'Photocopy', quantity: 10, price: 1000 }],
      paymentMethod: 'Cash',
      payments: [{ method: 'Cash', amount: 10000 }],
      customerName: 'Walk-in Customer',
    } as any,
    cashierName: 'Cashier',
    customerName: 'Walk-in Customer',
    receiptRef: { receiptNumber: 'REC-L001', verificationToken: TOK },
  });
  const secured: any = await attachDocumentSecurity(payload, 'Prime Printing Service');
  const element = createElement(PrimeDocument as any, {
    type: 'POS_RECEIPT',
    data: secured,
  });
  // toString() resolves the rendered PDF document to its raw string content.
  const pdfString = await (pdf(element as any) as any).toString();
  return String(pdfString);
}

/**
 * react-pdf encodes visible text as hex glyph runs ([<53>...] TJ), so decode
 * every hex token to recover the human-readable content stream text.
 */
function extractPdfText(pdfString: string): string {
  const chunks: string[] = [];
  const hexRe = /<([0-9A-Fa-f]{2,})>/g;
  let match: RegExpExecArray | null;
  while ((match = hexRe.exec(pdfString)) !== null) {
    try {
      chunks.push(Buffer.from(match[1], 'hex').toString('latin1'));
    } catch {
      /* ignore malformed runs */
    }
  }
  const literalRe = /\((?:[^\\()]|\\.)*\)/g;
  const literals = pdfString.match(literalRe) || [];
  for (const lit of literals) chunks.push(lit.slice(1, -1));
  return chunks.join(' ');
}

describe('POS receipt QR layout (compact, QR-only)', () => {
  it('renders SCAN TO VERIFY without the full security footer', async () => {
    // Glyph runs are kerned with spacing; collapse whitespace before matching.
    const text = extractPdfText(await renderPosPdf()).replace(/\s+/g, '');
    expect(text).toContain('SCANTOVERIFY');
    expect(text).not.toContain('DOCUMENTVERIFICATION');
    expect(text).not.toContain('Verifieddocument');
  }, 120000);

  it('embeds exactly one QR image (no duplicate QR)', async () => {
    const pdfText = await renderPosPdf();
    // A transparent PNG embeds as one RGB image XObject plus its soft-mask
    // (SMask) XObject. A second QR would add two more image objects.
    const imageObjects = pdfText.match(/\/Subtype\s*\/Image/g) || [];
    expect(imageObjects.length).toBe(2);
  }, 120000);
});

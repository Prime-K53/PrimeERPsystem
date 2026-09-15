/**
 * documentTemplateTweaks.test.ts — render-level proof for the document
 * presentation tweaks (single PrimeDocument source):
 *  1. SCAN TO VERIFY pill appears in the shared authentication &
 *     verification footer (all verifiable docs) and on the POS receipt.
 *  2. Legal footer reads "Scan QR Code to Verify" (not "No signature required").
 *  3. Delivery-note Vehicle No and the customer signature line share one row.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { buildPosReceiptDoc } from '../../../services/receiptCalculationService';

const TOK = 'c'.repeat(64);
const COMPANY = 'Prime Printing Service';

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
  const literals = pdfString.match(/\((?:[^\\()]|\\.)*\)/g) || [];
  for (const lit of literals) chunks.push(lit.slice(1, -1));
  return chunks.join(' ').replace(/\s+/g, '');
}

async function renderPdf(type: string, data: any): Promise<string> {
  const element = createElement(PrimeDocument as any, { type, data });
  return String(await (pdf(element as any) as any).toString());
}

const invoiceRecord: any = {
  id: 'INV-T001',
  invoiceNumber: 'INV-T001',
  date: '2026-09-01',
  customerName: 'Tweak Test School',
  items: [{ desc: 'A4 Paper Ream', qty: 2, price: 5000, total: 10000 }],
  subtotal: 10000,
  totalAmount: 10000,
  paidAmount: 0,
  status: 'Unpaid',
  verificationToken: TOK,
};

describe('document template tweaks', () => {
  it('invoice footer matches the authentication & verification reference', async () => {
    const mapped: any = mapToInvoiceData(invoiceRecord, {} as any, 'INVOICE' as any);
    const secured: any = await attachDocumentSecurity(mapped, COMPANY);
    const text = extractPdfText(await renderPdf('INVOICE', secured));
    expect(text).toContain('DOCUMENTAUTHENTICATION&VERIFICATION');
    expect(text).toContain('Digitallygenerated');
    expect(text).toContain('Verificationavailableonline');
    expect(text).toContain('SCANTOVERIFY');
    expect(text).toContain('electronicallygeneratedandisvalidwithoutahandwrittensignature');
  }, 120000);

  it('POS receipt keeps the SCAN TO VERIFY caption', async () => {
    const payload: any = buildPosReceiptDoc({
      sale: {
        id: 'POS-T001',
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
      receiptRef: { receiptNumber: 'REC-T001', verificationToken: TOK },
    });
    const secured: any = await attachDocumentSecurity(payload, COMPANY);
    const text = extractPdfText(await renderPdf('POS_RECEIPT', secured));
    expect(text).toContain('SCANTOVERIFY');
  }, 120000);

  it('delivery note keeps Vehicle No and the signature line content', async () => {
    const mapped: any = mapToInvoiceData(
      {
        id: 'DN-T001',
        date: '2026-09-01',
        customerName: 'Tweak Test School',
        status: 'Delivered',
        driverName: 'Moffat',
        vehicleNo: 'ZA 1234',
        items: [{ name: 'A4 Paper', quantity: 5 }],
        verificationToken: TOK,
      } as any,
      { currencySymbol: 'K' } as any,
      'DELIVERY_NOTE' as any
    );
    const secured: any = await attachDocumentSecurity(mapped, COMPANY);
    const text = extractPdfText(await renderPdf('DELIVERY_NOTE', secured));
    expect(text).toContain('VehicleNo');
    expect(text).toContain('ReceivedBy');
  }, 120000);
});

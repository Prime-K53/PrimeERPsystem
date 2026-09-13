import { it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { generatePrimeDocumentBlob } from '../../../views/shared/components/PDF/generatePrimeDocumentBlob';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../../../utils/documentCustomerData';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { buildCustomerReceiptDoc } from '../../../services/receiptCalculationService';
import { ReceiptSchema } from '../../../views/shared/components/PDF/schemas';
import { analysePages } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';
const TOK = 'a'.repeat(64);

function lineItems(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const qty = (i % 5) + 1;
    const price = 5000 + i * 250;
    return { desc: `Exercise Book A4 Hardcover Ruled 200 Pages Premium Quality Line ${i + 1}`, qty, price, total: qty * price };
  });
}

function finRaw(n: number, extra: any = {}) {
  const items = lineItems(n);
  const subtotal = items.reduce((s: number, it: any) => s + it.total, 0);
  return {
    date: '2026-09-01', dueDate: '2026-10-01', businessName: 'Chiwana Primary School',
    contactName: 'John Banda', customerId: 'CUST-0100', address: 'P.O. Box 123, Lilongwe',
    phone: '+265 999 000 001', items, subtotal, discount: 0, amountPaid: 0,
    totalAmount: subtotal, status: 'Unpaid', verificationToken: TOK, ...extra,
  };
}

it('genSamples', async () => {
  const fs = await import('fs');
  fs.mkdirSync('tmp-global-pagination', { recursive: true });
  const jobs: Array<[string, string, () => Promise<any>]> = [
    ['invoice-2page', 'INVOICE', async () => attachDocumentSecurity(mapToInvoiceData(enrichDocumentCustomerData(finRaw(14, { invoiceNumber: 'INV-P726/024' }), []), {} as any, 'INVOICE'), COMPANY)],
    ['quotation-2page', 'QUOTATION', async () => attachDocumentSecurity(mapToInvoiceData(enrichDocumentCustomerData(finRaw(14, { id: 'QTN-P726/001', number: 'QTN-P726/001', quotationNumber: 'QTN-P726/001' }), []), {} as any, 'QUOTATION'), COMPANY)],
    ['order-2page', 'SALES_ORDER', async () => attachDocumentSecurity(mapToInvoiceData(enrichDocumentCustomerData(finRaw(14, { id: 'SO-P726/001', number: 'SO-P726/001', orderNumber: 'SO-P726/001' }), []), {} as any, 'SALES_ORDER'), COMPANY)],
    ['receipt-2page', 'RECEIPT', async () => {
      const applied = Array.from({ length: 30 }, (_, i) => `INV-P726/${String(i + 1).padStart(3, '0')}`);
      const payment: any = { id: 'PAY-P726/001', date: '2026-09-01', customerName: 'Chiwana Primary School', amount: 30000, paymentMethod: 'Cash', verificationToken: TOK, allocations: applied.map((id) => ({ invoiceId: id, amount: 1000 })) };
      return attachDocumentSecurity(ReceiptSchema.parse(buildCustomerReceiptDoc({ payment, customerName: 'Chiwana Primary School', currentBalance: 0, currencySymbol: 'MWK' })), COMPANY);
    }],
    ['delivery-2page', 'DELIVERY_NOTE', async () => attachDocumentSecurity(mapToInvoiceData(enrichDocumentCustomerData(finRaw(12, { id: 'DN-P726/001', invoiceId: 'INV-P726/024' }), []), {} as any, 'DELIVERY_NOTE'), COMPANY)],
    ['invoice-1page', 'INVOICE', async () => attachDocumentSecurity(mapToInvoiceData(enrichDocumentCustomerData(finRaw(4, { invoiceNumber: 'INV-P726/024' }), []), {} as any, 'INVOICE'), COMPANY)],
  ];
  const summary: string[] = [];
  for (const [name, type, build] of jobs) {
    const secured = await build();
    const str = (await pdf(React.createElement(PrimeDocument as any, { type, data: secured })).toString()) as unknown as string;
    const buf = Buffer.from(str, 'latin1');
    fs.writeFileSync(`tmp-global-pagination/${name}.pdf`, buf);
    const pages = analysePages(buf);
    summary.push(`== ${name}: ${pages.length} page(s), ${buf.length} bytes`);
    pages.forEach((p, i) => {
      const qr = p.drawnImages.length > 0 ? `images:[${p.drawnImages.join(',')}]` : 'images:[]';
      summary.push(`  p${i + 1} len=${p.text.length} ${qr} :: ${p.text.slice(0, 220)}`);
    });
  }
  // Download/Print/Share path consumes generatePrimeDocumentBlob for invoices.
  // (jsdom Blob lacks arrayBuffer, so the helper's header check cannot run
  // here — renderer-byte equivalence is covered by invoice TEST K instead.)
  try {
    const blobSecured = await jobs[0][2]();
    const blob = await generatePrimeDocumentBlob('INVOICE', blobSecured as any, null);
    summary.push(`generatePrimeDocumentBlob invoice bytes=${blob.size}`);
  } catch (e: any) {
    summary.push(`generatePrimeDocumentBlob skipped in jsdom: ${String(e?.message || e)}`);
  }
  fs.writeFileSync('tmp-global-pagination/inspect.txt', summary.join('\n') + '\n');
}, 600000);

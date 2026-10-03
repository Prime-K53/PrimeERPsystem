import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { inflateSync } from 'zlib';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../../../utils/documentCustomerData';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { buildCustomerReceiptDoc } from '../../../services/receiptCalculationService';
import { ReceiptSchema } from '../../../views/shared/components/PDF/schemas';
import { DEFAULT_PRIME_TEMPLATE_SETTINGS } from '../../../views/shared/components/PDF/templateSettings';
import { allDrawnImages, type DrawnImage } from './measureDrawnImages';

const TOK = 'a'.repeat(64);
const COMPANY_NAME = 'Prime Printing Service';
const LOGO_ASPECT = 40 / 20; // generated below

function crc32(buf: Buffer) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

/** A valid solid PNG, so react-pdf actually decodes and draws it. */
function makePng(w: number, h: number): string {
  const zlib = require('zlib') as typeof import('zlib');
  const raw = Buffer.alloc((w * 3 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) { raw[o++] = 200; raw[o++] = 30; raw[o++] = 30; }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

const logoDataUrl = `data:image/png;base64,${makePng(40, 20)}`;
const qrDataUrl = `data:image/png;base64,${makePng(30, 30)}`;

const companyConfig = (logoWidth: number): any => ({
  companyName: COMPANY_NAME,
  name: COMPANY_NAME,
  logoBase64: logoDataUrl,
  currencySymbol: 'MWK',
  invoiceTemplates: { engine: 'Classic', bodyFontSize: 12, logoWidth, showCompanyLogo: true },
});

const receiptDoc = () => {
  const payment: any = {
    id: 'PAY-001', date: '2026-09-01', customerName: 'Chiwana Primary School',
    amount: 17500, paymentMethod: 'Cash', verificationToken: TOK,
    allocations: [{ invoiceId: 'INV-001', amount: 17500 }],
  };
  return attachDocumentSecurity(
    ReceiptSchema.parse(buildCustomerReceiptDoc({
      payment, customerName: 'Chiwana Primary School', currentBalance: 0, currencySymbol: 'MWK',
    })),
    COMPANY_NAME
  );
};

const invoiceDoc = () => {
  const items = [{ desc: 'Exercise Book A4', qty: 2, price: 5000, total: 10000 }];
  const subtotal = items.reduce((s, it) => s + it.total, 0);
  const raw = {
    date: '2026-09-01', dueDate: '2026-10-01', businessName: 'Chiwana Primary School',
    contactName: 'John Banda', customerId: 'CUST-0100', address: 'P.O. Box 123',
    phone: '+265 999 000 001', items, subtotal, discount: 0, amountPaid: 0,
    totalAmount: subtotal, status: 'Unpaid', verificationToken: TOK, invoiceNumber: 'INV-001',
  };
  return {
    ...attachDocumentSecurity(
      mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE'),
      COMPANY_NAME
    ),
    // The security footer only draws a QR when the doc carries one.
    securityQrCodeDataUrl: qrDataUrl,
  };
};

const posDoc = () => ({
  ...receiptDoc(),
  receiptNumber: 'R-1', status: 'Paid', cashierName: 'Cashier',
  items: [{ desc: 'Exercise Book A4', qty: 2, price: 5000, total: 10000 }],
  subtotal: 17500, totalAmount: 17500, discount: 0, tax: 0,
  changeGiven: 0, amountTendered: 17500,
  companyInfo: { name: COMPANY_NAME, address: 'Lilongwe', phone: '+265 992 528 222' },
  securityQrCodeDataUrl: qrDataUrl,
});

async function render(type: string, data: any, logoWidth: number): Promise<DrawnImage[]> {
  const str = (await pdf(React.createElement(PrimeDocument as any, {
    type, data, configOverride: companyConfig(logoWidth),
  })).toString()) as unknown as string;
  // keep the import honest: zlib is required for compressed streams
  void inflateSync;
  return allDrawnImages(Buffer.from(str, 'latin1'));
}

describe('brand asset sizing — logo and QR parity across documents', () => {
  it('payment receipt logo honours the settings-driven logoWidth', async () => {
    for (const logoWidth of [100, 140, 200]) {
      const imgs = await render('RECEIPT', receiptDoc(), logoWidth);
      const logo = imgs.find((i) => i.w > 1 && i.h > 1);
      expect(logo, `no logo drawn at logoWidth=${logoWidth}`).toBeTruthy();
      expect(logo!.w).toBeCloseTo(logoWidth, 0);
      // Aspect ratio must survive: the width setting must not distort the image.
      expect(logo!.w / logo!.h).toBeCloseTo(LOGO_ASPECT, 1);
    }
  });

  it('receipt logo matches the invoice logo at the same setting', async () => {
    const logoWidth = DEFAULT_PRIME_TEMPLATE_SETTINGS.logoWidth;
    const receipt = (await render('RECEIPT', receiptDoc(), logoWidth)).find((i) => i.w > 1 && i.h > 1);
    const invoice = (await render('INVOICE', invoiceDoc(), logoWidth)).find((i) => i.w > 1 && i.h > 1);
    expect(receipt).toBeTruthy();
    expect(invoice).toBeTruthy();
    expect(receipt!.w).toBeCloseTo(invoice!.w, 0);
    expect(receipt!.h).toBeCloseTo(invoice!.h, 0);
  });

  it('POS receipt QR is square and the same size as the invoice QR', async () => {
    // The invoice QR lives in the security footer; grab its square image.
    const invoiceImgs = await render('INVOICE', invoiceDoc(), 140);
    const invoiceQr = invoiceImgs.find((i) => Math.abs(i.w - i.h) < 0.5);
    expect(invoiceQr, 'invoice QR not found').toBeTruthy();

    const posQr = (await render('POS_RECEIPT', posDoc(), 140)).find((i) => Math.abs(i.w - i.h) < 0.5);
    expect(posQr, 'POS receipt QR not found').toBeTruthy();

    // Regression: the POS receipt used `100 * scale` (130pt at defaults).
    expect(posQr!.w).toBeCloseTo(invoiceQr!.w, 0);
    expect(posQr!.w).toBeLessThan(100);
  });

  it('POS receipt QR does not drift when body font size changes', async () => {
    const base: any = companyConfig(140);
    const enlarged = { ...base, invoiceTemplates: { ...base.invoiceTemplates, bodyFontSize: 16 } };
    const str = (await pdf(React.createElement(PrimeDocument as any, {
      type: 'POS_RECEIPT', data: posDoc(), configOverride: enlarged,
    })).toString()) as unknown as string;
    const qr = allDrawnImages(Buffer.from(str, 'latin1')).find((i) => Math.abs(i.w - i.h) < 0.5);
    expect(qr).toBeTruthy();
    expect(qr!.w).toBeCloseTo(72, 0);
  });
});
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createElementSpy,
  toBlobSpy,
  pdfSpy,
  mapToInvoiceDataSpy,
  attachDocumentSecuritySpy,
  validateDocumentDataSpy,
  enrichDocumentCustomerDataSpy,
  initializePrimePdfFontsSpy,
} = vi.hoisted(() => {
  const createElementSpy = vi.fn((component: any, props: any) => ({ component, props }));
  // Return a Blob-like that always exposes arrayBuffer(): the jsdom Blob in
  // this environment lacks it, which made Buffer.from(await blob.arrayBuffer())
  // throw before the assertions ever ran.
  const toBlobSpy = vi.fn(async () => ({
    arrayBuffer: async () => Buffer.from('%PDF-1.7 test'),
  }));
  const pdfSpy = vi.fn(() => ({ toBlob: toBlobSpy }));
  const mapToInvoiceDataSpy = vi.fn((rawData: any) => ({ ...rawData }));
  const attachDocumentSecuritySpy = vi.fn(async (data: any) => data);
  const validateDocumentDataSpy = vi.fn(() => ({ valid: true }));
  const enrichDocumentCustomerDataSpy = vi.fn((rawData: any) => rawData);
  const initializePrimePdfFontsSpy = vi.fn(async () => undefined);

  return {
    createElementSpy,
    toBlobSpy,
    pdfSpy,
    mapToInvoiceDataSpy,
    attachDocumentSecuritySpy,
    validateDocumentDataSpy,
    enrichDocumentCustomerDataSpy,
    initializePrimePdfFontsSpy,
  };
});

vi.mock('react', () => ({ createElement: createElementSpy }));
vi.mock('@react-pdf/renderer', () => ({ pdf: pdfSpy }));
vi.mock('../../utils/pdfMapper', () => ({ mapToInvoiceData: mapToInvoiceDataSpy }));
vi.mock('../../utils/documentCustomerData', () => ({ enrichDocumentCustomerData: enrichDocumentCustomerDataSpy }));
vi.mock('../../utils/documentSecurity', () => ({ attachDocumentSecurity: attachDocumentSecuritySpy }));
vi.mock('../../views/shared/components/PDF/templateSettings', () => ({ initializePrimePdfFonts: initializePrimePdfFontsSpy }));
vi.mock('../../views/shared/components/PDF/documentValidation', () => ({ validateDocumentData: validateDocumentDataSpy }));
vi.mock('../../views/shared/components/PDF/PrimeDocument', () => ({ PrimeDocument: 'PrimeDocument' }));

import { renderOfficialDocumentPdf } from '../../server/renderOfficialDocument';

describe('renderOfficialDocumentPdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards companyConfig into PrimeDocument so server-rendered statements use authoritative branding', async () => {
    const companyConfig = {
      companyName: 'Prime Printing Service',
      phone: '+265 992 528 222',
      email: 'info.primemw@gmail.com',
      addressLine1: 'Along M5 Road Mtakataka',
      currencySymbol: 'K',
    };

    const rawData = {
      date: '2026-08-29',
      statementNumber: 'STMT-6001',
      customerName: 'Test Customer',
      startDate: '2026-01-01',
      endDate: '2026-08-29',
      openingBalance: 0,
      totalInvoiced: 300,
      totalReceived: 0,
      finalBalance: 300,
      transactions: [
        { date: '2026-08-01', reference: 'INV-1001', debit: 300, credit: 0, runningBalance: 300 },
      ],
    };

    const buffer = await renderOfficialDocumentPdf({
      type: 'ACCOUNT_STATEMENT',
      rawData,
      companyConfig,
      customers: [{ id: 'cust_a', name: 'Test Customer' }],
    });

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(mapToInvoiceDataSpy).toHaveBeenCalledWith(expect.any(Object), companyConfig, 'ACCOUNT_STATEMENT');
    expect(attachDocumentSecuritySpy).toHaveBeenCalledWith(expect.any(Object), 'Prime Printing Service');
    expect(createElementSpy).toHaveBeenCalledWith('PrimeDocument', expect.objectContaining({
      type: 'ACCOUNT_STATEMENT',
      configOverride: companyConfig,
    }));
  });

  it('defaults channel to erp (clean document)', async () => {
    await renderOfficialDocumentPdf({
      type: 'INVOICE',
      rawData: { invoiceNumber: 'INV-1', customerName: 'C', items: [] },
    });
    expect(createElementSpy).toHaveBeenCalledWith('PrimeDocument', expect.objectContaining({
      channel: 'erp',
    }));
  });

  it('forwards channel portal so PrimeDocument renders the native PORTAL COPY watermark', async () => {
    await renderOfficialDocumentPdf({
      type: 'INVOICE',
      rawData: { invoiceNumber: 'INV-2', customerName: 'C', items: [] },
      channel: 'portal',
    });
    expect(createElementSpy).toHaveBeenCalledWith('PrimeDocument', expect.objectContaining({
      channel: 'portal',
    }));
  });
});

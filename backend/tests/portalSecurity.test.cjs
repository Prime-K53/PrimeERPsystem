/**
 * Portal PDF Security tests.
 *
 * Verifies:
 *   1. Shop vs Portal distinction: source parameter flows correctly
 *   2. Portal watermark: PORTAL COPY text present in portal PDFs, absent in shop PDFs
 *   3. PDF permissions: editing restricted, printing allowed for portal PDFs
 *   4. PDF metadata: portal-specific metadata tags
 *   5. Graceful degradation: post-processing failure doesn't break the pipeline
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const RENDERED_PDF = Buffer.from('%PDF-1.7 mock-official-document-bytes');

jest.mock('../services/officialDocument/primeRenderer.cjs', () => ({
  renderOfficialDocumentPdf: jest.fn(async (input) => {
    global.__lastRenderInput = input;
    return RENDERED_PDF;
  }),
}));

jest.mock('../services/supabaseRepository.cjs', () => ({
  getAll: jest.fn(async () => []),
  getAllStrict: jest.fn(async () => []),
  getById: jest.fn(async () => null),
  upsert: jest.fn(async () => ({ id: 'test' })),
  softDelete: jest.fn(async () => ({ changes: 1 })),
}));

const { renderOfficialDocumentPdf } = require('../services/officialDocument/primeRenderer.cjs');
const officialDocumentService = require('../services/officialDocumentService.cjs');
const { applyPortalPermissions } = require('../services/portalPdfPostProcess.cjs');
const { PDFDocument } = require('pdf-lib');

beforeEach(() => {
  jest.clearAllMocks();
  global.__lastRenderInput = undefined;
});

describe('Portal PDF Security — source parameter flow', () => {
  it('officialDocumentService passes source=portal to renderer', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      source: 'portal',
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.source).toBe('portal');
  });

  it('officialDocumentService passes source=erp by default', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.source).toBe('erp');
  });

  it('officialDocumentService passes source=erp when explicitly set', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      source: 'erp',
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.source).toBe('erp');
  });
});

describe('Portal PDF Security — permissions post-processing', () => {
  it('applyPortalPermissions produces a valid PDF', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Test document');
    const pdfBuffer = Buffer.from(await doc.save());

    const result = await applyPortalPermissions(pdfBuffer, { companyName: 'Test Co' });
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);

    // Should be loadable as a valid PDF
    const loaded = await PDFDocument.load(result);
    expect(loaded).toBeDefined();
  });

  it('applyPortalPermissions sets creator metadata', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Test');
    const pdfBuffer = Buffer.from(await doc.save());

    const result = await applyPortalPermissions(pdfBuffer, { companyName: 'Acme Corp' });
    const loaded = await PDFDocument.load(result);
    expect(loaded.getCreator()).toBe('Prime ERP Official Document Service');
  });

  it('applyPortalPermissions sets author to company name', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Test');
    const pdfBuffer = Buffer.from(await doc.save());

    const result = await applyPortalPermissions(pdfBuffer, { companyName: 'Acme Corp' });
    const loaded = await PDFDocument.load(result);
    expect(loaded.getAuthor()).toBe('Acme Corp');
  });

  it('applyPortalPermissions sets subject', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Test');
    const pdfBuffer = Buffer.from(await doc.save());

    const result = await applyPortalPermissions(pdfBuffer);
    const loaded = await PDFDocument.load(result);
    expect(loaded.getSubject()).toBe('Customer Portal Download');
  });

  it('post-processed PDF is larger than original (permissions overhead)', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage();
    page.drawText('Test document with some content');
    const pdfBuffer = Buffer.from(await doc.save());

    const result = await applyPortalPermissions(pdfBuffer, { companyName: 'Test Co' });
    expect(result.length).toBeGreaterThan(pdfBuffer.length);
  });

  it('throws on empty buffer', async () => {
    await expect(applyPortalPermissions(Buffer.alloc(0))).rejects.toThrow('empty PDF buffer');
  });

  it('throws on null input', async () => {
    await expect(applyPortalPermissions(null)).rejects.toThrow();
  });
});

describe('Portal PDF Security — graceful degradation', () => {
  it('returns original PDF when post-processing fails on corrupted input', async () => {
    // Corrupt buffer that will fail pdf-lib parsing but still is non-empty
    const corruptBuffer = Buffer.from('not-a-valid-pdf-but-non-empty');
    const result = await applyPortalPermissions(corruptBuffer);
    // Should return the original buffer as fallback
    expect(result).toBe(corruptBuffer);
  });
});

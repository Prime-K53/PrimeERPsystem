/**
 * Portal PDF Security tests.
 *
 * The PORTAL COPY watermark is now rendered NATIVELY by the authoritative ERP
 * renderer when the server-side channel is 'portal'. There is NO post-generation
 * PDF byte manipulation anywhere in the pipeline (the old portalPdfPostProcess
 * byte-rewrite layer was removed).
 *
 * Verifies:
 *   1. channel flow: renderOfficialPdf forwards channel 'portal' / 'erp' to
 *      the authoritative renderer — established server-side, never from the
 *      browser
 *   2. default channel is 'erp' (clean, unwatermarked)
 *   3. legacy `source` alias maps to the channel contract
 *   4. no byte post-processing step is invoked (the renderer output is the
 *      final PDF)
 *   5. failure behavior: when the renderer fails for a portal request, the
 *      error propagates — the Portal never receives a silently clean PDF
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

beforeEach(() => {
  jest.clearAllMocks();
  global.__lastRenderInput = undefined;
});

describe('Portal PDF Security — channel flow', () => {
  it('officialDocumentService passes channel=portal to the authoritative renderer', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      channel: 'portal',
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.channel).toBe('portal');
  });

  it('officialDocumentService passes channel=erp by default', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.channel).toBe('erp');
  });

  it('officialDocumentService passes channel=erp when explicitly set', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      channel: 'erp',
    });
    expect(renderOfficialDocumentPdf).toHaveBeenCalledTimes(1);
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.channel).toBe('erp');
  });

  it('legacy source alias maps to the channel contract', async () => {
    await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      source: 'portal',
    });
    const calledWith = renderOfficialDocumentPdf.mock.calls[0][0];
    expect(calledWith.channel).toBe('portal');
  });
});

describe('Portal PDF Security — no byte post-processing', () => {
  it('renderer output IS the final PDF (buffer identity preserved)', async () => {
    const { buffer } = await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: { items: [], status: 'posted' },
      channel: 'portal',
    });
    // The service must return the renderer's bytes untouched — no
    // post-generation PDF parsing/rewriting step may run.
    expect(buffer).toBe(RENDERED_PDF);
  });
});

describe('Portal PDF Security — failure behavior', () => {
  it('portal render failure propagates (Portal receives an error, never a clean PDF)', async () => {
    renderOfficialDocumentPdf.mockRejectedValueOnce(new Error('watermark render failed'));
    await expect(
      officialDocumentService.renderOfficialPdf({
        type: 'INVOICE',
        rawData: { items: [], status: 'posted' },
        channel: 'portal',
      })
    ).rejects.toThrow('watermark render failed');
  });

  it('erp render failure also propagates (no silent fallback)', async () => {
    renderOfficialDocumentPdf.mockRejectedValueOnce(new Error('renderer exploded'));
    await expect(
      officialDocumentService.renderOfficialPdf({
        type: 'INVOICE',
        rawData: { items: [], status: 'posted' },
        channel: 'erp',
      })
    ).rejects.toThrow('renderer exploded');
  });
});
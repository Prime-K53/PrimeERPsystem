/**
 * Statement Branding Verification
 *
 * Generates an actual ERP Account Statement PDF using the authoritative company
 * settings and inspects the rendered PDF bytes (text + metadata) to confirm:
 *   - Prime Printing Service / phone / email are present
 *   - Prime Printing & Stationery / Phone N/A are NOT present
 *   - Statement number metadata is present
 *   - Portal copy carries the native PORTAL COPY watermark; ERP copy is clean
 *
 * Uses an in-memory repo stub so it runs without Supabase.
 */

process.env.JWT_SECRET = 'verify-statement-jwt-secret';

const path = require('path');
const zlib = require('zlib');
const { pathToFileURL } = require('url');
const { PDFDocument } = require('pdf-lib');
const Module = require('module');

const settingsStore = new Map();
settingsStore.set('companyConfig', {
  id: 'companyConfig',
  key: 'companyConfig',
  value: {
    companyName: 'Prime Printing Service',
    phone: '+265 992 528 222',
    email: 'info.primemw@gmail.com',
    addressLine1: 'Along M5 Road Mtakataka',
    city: 'Dedza',
    country: 'Malawi',
    currencySymbol: 'K',
  },
});

const originalResolve = Module._resolveFilename;
const originalLoad = Module._load;

const repoStub = {
  getAll: async (table, filters = {}) => {
    if (table === 'settings') {
      return Array.from(settingsStore.values());
    }
    return [];
  },
  getAllStrict: async (table) => {
    if (table === 'settings') return Array.from(settingsStore.values());
    return [];
  },
  getById: async () => null,
};

Module._load = function patched(request, parent, ...rest) {
  if (request === './supabaseRepository.cjs' || request.endsWith('supabaseRepository.cjs')) {
    return repoStub;
  }
  return originalLoad.call(this, request, parent, ...rest);
};

function extractDecodedPdfText(buffer) {
  const decodedChunks = [];
  const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match;

  while ((match = streamRegex.exec(buffer.toString('latin1'))) !== null) {
    const compressedChunk = Buffer.from(match[1], 'latin1');
    for (const inflate of [zlib.inflateSync, zlib.inflateRawSync]) {
      try {
        const decoded = inflate(compressedChunk);
        decodedChunks.push(decoded.toString('utf8'));
        break;
      } catch (_) {
        // try the next inflater
      }
    }
  }

  return decodedChunks.join('\n');
}

async function extractPdfTextWithPdfJs(buffer) {
  const pdfjsModulePath = path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.mjs');
  const pdfjsLib = await import(pathToFileURL(pdfjsModulePath).href);
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(buffer) });
  const pdf = await loadingTask.promise;

  const pages = [];
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => (typeof item?.str === 'string' ? item.str : ''))
      .filter(Boolean)
      .join(' ');
    pages.push(pageText);
  }

  await pdf.destroy();
  return pages.join('\n');
}

function normalizeExtractedText(text) {
  return String(text || '')
    .replace(/Generated on:\s*[^\n]+/gi, 'Generated on: <normalized>')
    .replace(/\s+/g, ' ')
    .trim();
}

(async () => {
  let passCount = 0;
  let failCount = 0;
  const fail = (msg) => { console.error(`  ✕ FAIL: ${msg}`); failCount++; };
  const pass = (msg) => { console.log(`  ✓ PASS: ${msg}`); passCount++; };

  try {
    const officialDocumentService = require('../services/officialDocumentService.cjs');
    const statementPayload = {
      statementNumber: 'STMT-2026-0001',
      date: '2026-08-29',
      startDate: '2026-01-01',
      endDate: '2026-08-29',
      customerName: 'Test Customer',
      openingBalance: 0,
      totalInvoiced: 1000,
      totalReceived: 500,
      finalBalance: 500,
      transactions: [
        { date: '2026-02-01', reference: 'INV-1001', memo: 'Printing', debit: 1000, credit: 0, runningBalance: 1000 },
        { date: '2026-08-15', reference: 'PAY-1', memo: 'Deposit', debit: 0, credit: 500, runningBalance: 500 },
      ],
    };

    const [{ buffer, contentType }, { buffer: erpBuffer, contentType: erpContentType }] = await Promise.all([
      officialDocumentService.renderOfficialPdf({
        type: 'ACCOUNT_STATEMENT',
        rawData: statementPayload,
        source: 'portal',
      }),
      officialDocumentService.renderOfficialPdf({
        type: 'ACCOUNT_STATEMENT',
        rawData: statementPayload,
        source: 'erp',
      }),
    ]);

    if (contentType !== 'application/pdf') fail(`portal contentType expected application/pdf, got ${contentType}`); else pass('portal contentType is application/pdf');
    if (erpContentType !== 'application/pdf') fail(`erp contentType expected application/pdf, got ${erpContentType}`); else pass('erp contentType is application/pdf');
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) fail('portal buffer is empty'); else pass(`portal buffer has ${buffer.length} bytes`);
    if (!Buffer.isBuffer(erpBuffer) || erpBuffer.length === 0) fail('erp buffer is empty'); else pass(`erp buffer has ${erpBuffer.length} bytes`);
    if (buffer.slice(0, 5).toString('ascii') !== '%PDF-') fail('portal buffer does not start with %PDF-'); else pass('portal buffer starts with %PDF-');
    if (erpBuffer.slice(0, 5).toString('ascii') !== '%PDF-') fail('erp buffer does not start with %PDF-'); else pass('erp buffer starts with %PDF-');

    const rawPdfString = buffer.toString('latin1');
    const decodedPdfText = extractDecodedPdfText(buffer);
    const extractedPdfText = await extractPdfTextWithPdfJs(buffer);
    const searchablePdfText = `${rawPdfString}\n${decodedPdfText}\n${extractedPdfText}`;
    const erpExtractedPdfText = await extractPdfTextWithPdfJs(erpBuffer);

    const required = ['Prime Printing Service', '+265 992 528 222', 'info.primemw@gmail.com'];
    for (const text of required) {
      if (searchablePdfText.includes(text)) pass(`PDF contains required text: ${text}`);
      else fail(`PDF missing required text: ${text}`);
    }

    const forbidden = ['Prime Printing & Stationery', 'PRIME PRINTING INC', 'Phone N/A', 'DOWNLOADED FROM CUSTOMER PORTAL'];
    for (const text of forbidden) {
      if (searchablePdfText.includes(text)) fail(`PDF unexpectedly contains: ${text}`);
      else pass(`PDF does NOT contain stale/prohibited text: ${text}`);
    }

    // Portal copy MUST carry the native PORTAL COPY watermark; ERP copy must not.
    if (searchablePdfText.includes('PORTAL COPY')) pass('portal statement PDF contains native PORTAL COPY watermark');
    else fail('portal statement PDF is missing the native PORTAL COPY watermark');
    if (erpExtractedPdfText.includes('PORTAL COPY')) fail('ERP statement PDF unexpectedly contains PORTAL COPY');
    else pass('ERP statement PDF is clean (no PORTAL COPY)');

    const statementNumberInBody = searchablePdfText.includes('STMT-2026-0001');
    if (statementNumberInBody) pass('PDF embeds the statement number');
    else fail('PDF missing the statement number');

    const normalizedPortalText = normalizeExtractedText(extractedPdfText.replace(/PORTAL COPY/g, ''));
    const normalizedErpText = normalizeExtractedText(erpExtractedPdfText);
    if (normalizedPortalText === normalizedErpText) pass('portal and ERP statement PDFs have matching extracted text content (watermark excluded)');
    else fail('portal and ERP statement PDFs differ in extracted text content');

    // The old byte post-processing layer (which stamped 'Customer Portal Download'
    // into PDF metadata) has been REMOVED — the portal copy is now identified by
    // the native PORTAL COPY watermark inside the PDF itself. Both copies are
    // produced by the SAME authoritative renderer, so neither should carry a
    // portal-only metadata subject.
    const pdfDoc = await PDFDocument.load(buffer);
    const subject = pdfDoc.getSubject();
    if (subject !== 'Customer Portal Download') pass('portal-source PDF has no portal-only metadata subject (byte layer removed)');
    else fail(`portal-source PDF unexpectedly retains legacy portal metadata subject: ${subject}`);

    const erpPdfDoc = await PDFDocument.load(erpBuffer);
    if (erpPdfDoc.getSubject() !== 'Customer Portal Download') pass('erp-source PDF does not carry portal metadata subject');
    else fail('erp-source PDF unexpectedly carries portal metadata subject');
  } catch (err) {
    fail(`Unexpected error: ${err.stack || err.message}`);
  }

  console.log(`\n=== STATEMENT BRANDING SUMMARY ===`);
  console.log(`  Passed: ${passCount}`);
  console.log(`  Failed: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
})();

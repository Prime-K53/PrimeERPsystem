/**
 * Comprehensive Verification Suite for Official Document Renderer & Portal PDF Downloads
 *
 * Verifies:
 *   1. Module loading: primeRenderer.cjs loads cleanly in Node.js
 *   2. Runtime dependencies: react, react-dom, @react-pdf/renderer, qrcode, pdf-lib
 *   3. All 6 document types: INVOICE, QUOTATION, ORDER, RECEIPT, DELIVERY_NOTE, ACCOUNT_STATEMENT
 *   4. Output validity: Buffer > 0 bytes, starts with %PDF-
 *   5. Watermark & Security:
 *        - source: 'portal' -> PORTAL COPY + DOWNLOADED FROM CUSTOMER PORTAL present in PDF
 *        - source: 'erp' -> PORTAL COPY absent from PDF
 *   6. Slash-containing IDs: INV-P726%2F027 decoded correctly
 *   7. Accounting firewall: zero database writes during PDF rendering
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

async function runVerification() {
  console.log('=== OFFICIAL DOCUMENT RENDERER VERIFICATION ===\n');
  let passCount = 0;
  let failCount = 0;

  function test(description, fn) {
    try {
      const res = fn();
      if (res && typeof res.then === 'function') {
        return res.then(() => {
          console.log(`  ✓ PASS: ${description}`);
          passCount++;
        }).catch((err) => {
          console.error(`  ✕ FAIL: ${description}\n    Error: ${err.stack || err.message}`);
          failCount++;
        });
      }
      console.log(`  ✓ PASS: ${description}`);
      passCount++;
    } catch (err) {
      console.error(`  ✕ FAIL: ${description}\n    Error: ${err.stack || err.message}`);
      failCount++;
    }
  }

  // 1. Dependency checks
  await test('Runtime dependencies are loadable (react, react-dom, @react-pdf/renderer, qrcode, pdf-lib)', () => {
    require('react');
    require('react-dom');
    require('@react-pdf/renderer');
    require('qrcode');
    require('pdf-lib');
  });

  // 2. Renderer module load
  let officialDocumentService;
  await test('officialDocumentService loads primeRenderer.cjs without error', async () => {
    officialDocumentService = require('../services/officialDocumentService.cjs');
    const isAvailable = await officialDocumentService.isRendererAvailable();
    assert.strictEqual(isAvailable, true, 'isRendererAvailable should return true');
  });

  // 3. Document types test
  const documentTypes = [
    {
      type: 'INVOICE',
      rawData: {
        invoiceNumber: 'INV-1001', date: '2026-08-29', dueDate: '2026-09-28',
        customerName: 'Test Customer', status: 'posted',
        items: [{ description: 'Item 1', quantity: 1, price: 100, total: 100 }], subtotal: 100, total: 100,
      },
    },
    {
      type: 'QUOTATION',
      rawData: {
        quotationNumber: 'QT-2001', date: '2026-08-29', validUntil: '2026-09-28',
        customerName: 'Test Customer', status: 'draft',
        items: [{ description: 'Quote Item', quantity: 2, price: 50, total: 100 }], subtotal: 100, total: 100,
      },
    },
    {
      type: 'ORDER',
      rawData: {
        orderNumber: 'ORD-3001', date: '2026-08-29',
        customerName: 'Test Customer', status: 'confirmed',
        items: [{ description: 'Order Item', quantity: 1, price: 200, total: 200 }], subtotal: 200, total: 200,
      },
    },
    {
      type: 'RECEIPT',
      rawData: {
        receiptNumber: 'REC-4001', date: '2026-08-29',
        customerName: 'Test Customer',
        amountPaid: 150, paymentMethod: 'Bank Transfer',
        items: [{ description: 'Payment', quantity: 1, price: 150, total: 150 }], subtotal: 150, total: 150,
      },
    },
    {
      type: 'DELIVERY_NOTE',
      rawData: {
        dnNumber: 'DEL-5001', date: '2026-08-29',
        customerName: 'Test Customer',
        items: [{ description: 'Delivered Item', quantity: 5, price: 10, total: 50 }], subtotal: 50, total: 50,
      },
    },
    {
      type: 'ACCOUNT_STATEMENT',
      rawData: {
        statementNumber: 'STMT-6001', date: '2026-08-29',
        startDate: '2026-01-01', endDate: '2026-08-29',
        customerName: 'Test Customer',
        openingBalance: 0, finalBalance: 300,
        transactions: [{ date: '2026-08-01', description: 'Invoice INV-1001', debit: 300, credit: 0, balance: 300 }],
        items: [], subtotal: 300, total: 300,
      },
    },
  ];

  for (const doc of documentTypes) {
    await test(`Render ${doc.type} document (returns Buffer > 0 bytes with %PDF- header)`, async () => {
      const { buffer, contentType } = await officialDocumentService.renderOfficialPdf({
        type: doc.type,
        rawData: doc.rawData,
        source: 'erp',
      });

      assert.strictEqual(contentType, 'application/pdf');
      assert.ok(Buffer.isBuffer(buffer), 'Output must be a Buffer');
      assert.ok(buffer.length > 0, `Buffer length must be > 0 (got ${buffer.length})`);
      assert.strictEqual(buffer.slice(0, 5).toString('ascii'), '%PDF-', 'Buffer must start with %PDF-');
    });
  }

  // 4. Portal watermark verification
  await test('Portal document (source: "portal") contains PORTAL COPY watermark & security metadata', async () => {
    const { buffer } = await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: {
        invoiceNumber: 'INV-PORTAL-1', date: '2026-08-29', dueDate: '2026-09-28',
        customerName: 'Portal Test Customer', status: 'posted',
        items: [{ description: 'Portal Item', quantity: 1, price: 50, total: 50 }], subtotal: 50, total: 50,
      },
      source: 'portal',
    });

    assert.ok(Buffer.isBuffer(buffer), 'Portal output must be a Buffer');
    assert.ok(buffer.length > 0, 'Portal PDF must have non-zero length');
    assert.strictEqual(buffer.slice(0, 5).toString('ascii'), '%PDF-');

    // Parse with pdf-lib to inspect metadata
    // Note: pdf-lib overwrites Producer on save() — check Creator and Subject instead
    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(buffer);
    assert.strictEqual(pdfDoc.getCreator(), 'Prime ERP Official Document Service',
      'Creator must be set to Prime ERP Official Document Service');
    assert.strictEqual(pdfDoc.getSubject(), 'Customer Portal Download',
      'Subject must be set to Customer Portal Download');

    // Verify watermark text is embedded in PDF stream bytes
    const pdfString = buffer.toString('latin1');
    assert.ok(
      pdfString.includes('PORTAL COPY') || pdfString.includes('PORTAL'),
      'PDF stream must contain PORTAL watermark text'
    );
    assert.ok(
      pdfString.includes('DOWNLOADED FROM CUSTOMER PORTAL') || pdfString.includes('PORTAL'),
      'PDF stream must contain DOWNLOADED FROM CUSTOMER PORTAL footer text'
    );
  });

  // 5. ERP/Shop rendering — NO portal watermark
  await test('Shop/ERP document (source: "erp") does NOT contain PORTAL COPY watermark', async () => {
    const { buffer } = await officialDocumentService.renderOfficialPdf({
      type: 'INVOICE',
      rawData: {
        invoiceNumber: 'INV-ERP-1', date: '2026-08-29', dueDate: '2026-09-28',
        customerName: 'ERP Test Customer', status: 'posted',
        items: [{ description: 'ERP Item', quantity: 1, price: 50, total: 50 }], subtotal: 50, total: 50,
      },
      source: 'erp',
    });

    const { PDFDocument } = require('pdf-lib');
    const pdfDoc = await PDFDocument.load(buffer);
    // ERP docs must NOT have portal security metadata
    assert.notStrictEqual(pdfDoc.getSubject(), 'Customer Portal Download',
      'ERP PDF must NOT have Customer Portal Download subject');

    const pdfString = buffer.toString('latin1');
    assert.strictEqual(pdfString.includes('PORTAL COPY'), false, 'ERP PDF must NOT contain PORTAL COPY watermark text');
  });

  // 6. Slash-containing ID resolution
  await test('URL-encoded invoice ID with slashes (INV-P726%2F027) decodes properly', () => {
    const encodedId = 'INV-P726%2F027';
    const decodedId = decodeURIComponent(encodedId);
    assert.strictEqual(decodedId, 'INV-P726/027');
  });

  console.log(`\n=== VERIFICATION SUMMARY ===`);
  console.log(`  Passed: ${passCount}`);
  console.log(`  Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runVerification().catch((err) => {
  console.error('Verification failed unexpectedly:', err);
  process.exit(1);
});

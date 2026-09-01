/**
 * Portal PDF Post-Processing
 *
 * Applies portal-specific security and metadata to official PDF documents
 * downloaded through the Customer Portal. This runs AFTER the standard
 * PrimeDocument renderer produces the PDF bytes.
 *
 * Operations:
 *   1. PDF permissions (editing restricted, printing allowed)
 *   2. PDF metadata (document source, producer)
 *
 * This module is ONLY called for portal-origin documents. Staff/ERP copies
 * bypass this layer entirely. It must not alter the visual accounting content
 * or branding of the authoritative ERP PDF.
 */

const { PDFDocument } = require('pdf-lib');

/**
 * Apply portal security permissions and metadata to a PDF buffer.
 *
 * Permissions enforced:
 *   - Printing: ALLOWED
 *   - Modification: NOT ALLOWED
 *   - Content extraction/copying: NOT ALLOWED (where viewer supports)
 *   - Form filling: NOT ALLOWED
 *   - Annotations: NOT ALLOWED
 *   - Document assembly: NOT ALLOWED
 *
 * IMPORTANT: PDF permission flags are viewer-enforced restrictions.
 * They are NOT cryptographically enforced and can be bypassed by
 * specialized software. This provides editing resistance, not
 * mathematical impossibility of editing.
 *
 * @param {Buffer} pdfBuffer - The original PDF bytes from the renderer
 * @param {Object} [options]
 * @param {string} [options.companyName] - Company name for metadata
 * @returns {Promise<Buffer>} Modified PDF buffer with permissions
 */
async function applyPortalPermissions(pdfBuffer, options = {}) {
  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error('portalPdfPostProcess: empty PDF buffer');
  }

  try {
    const pdfDoc = await PDFDocument.load(pdfBuffer, {
      ignoreEncryption: true,
    });

    // Set PDF metadata indicating portal origin
    pdfDoc.setCreator('Prime ERP Official Document Service');
    pdfDoc.setProducer('Prime ERP Portal Security Layer');
    pdfDoc.setSubject('Customer Portal Download');

    if (options.companyName) {
      pdfDoc.setAuthor(options.companyName);
    }

    // IMPORTANT: do NOT draw portal-only watermarks or provenance text.
    // The portal must receive the same authoritative ERP statement content and
    // branding. We keep only non-visual PDF metadata/permissions.

    // Save with permissions
    // PDF 1.7 permission flags:
    //   - Printing: allowed (bit 3 = 4)
    //   - Modifying contents: NOT allowed (bit 4 = 0)
    //   - Copying/extracting text: NOT allowed (bit 5 = 0)
    //   - Adding/modifying annotations: NOT allowed (bit 6 = 0)
    //   - Form filling: NOT allowed (bit 9 = 0)
    //   - Document assembly: NOT allowed (bit 11 = 0)
    //
    // We use a user password of '' (empty) so the PDF opens without prompting.
    // The permission bits restrict editing operations in compliant viewers.
    const modifiedBytes = await pdfDoc.save({
      useObjectStreams: false,
      addDefaultPage: false,
      permissions: {
        printing: 'highResolution',
        modifying: false,
        copying: false,
        annotating: false,
        formFilling: false,
        documentAssembly: false,
      },
    });

    return Buffer.from(modifiedBytes);
  } catch (err) {
    console.warn('[portalPdfPostProcess] PDF permission post-processing failed, returning original:', err.message);
    // Graceful degradation: return original PDF if permission layer fails
    return pdfBuffer;
  }
}

module.exports = {
  applyPortalPermissions,
};

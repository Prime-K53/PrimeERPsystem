/**
 * publicDocumentDownload.cjs — PUBLIC document download (read-only).
 *
 *   GET /api/public/documents/download/:documentType/:documentNumber?t=<token>
 *
 * Verifies the document using the same token mechanism as the
 * verification endpoint, then renders the official PDF with the
 * PORTAL COPY watermark and streams it as a downloadable attachment.
 *
 * No admin login, no portal session. Strictly GET; every failure
 * returns the same generic 404 so documents cannot be enumerated.
 *
 * Security: the endpoint is tied to the verified document/token.
 * The token is the sole authorization — no arbitrary document access.
 * The download is read-only — no record creation or updates.
 */
const express = require('express');
const { verifyDocument, getDocumentRecord, supportedDocumentTypes, GENERIC_FAILURE } = require('../services/documentVerificationService.cjs');
const officialDocumentService = require('../services/officialDocumentService.cjs');

const router = express.Router();

router.get('/download/:documentType/:documentNumber', async (req, res) => {
  try {
    const type = String(req.params.documentType || '').toLowerCase().trim().replace(/-/g, '_');
    if (!supportedDocumentTypes().includes(type)) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }

    const documentNumber = req.params.documentNumber;
    const token = req.query.t;

    const record = await getDocumentRecord(type, documentNumber, token);
    if (!record) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }

    const { buffer } = await officialDocumentService.renderOfficialPdf({
      type,
      rawData: record,
      channel: 'portal',
    });

    const filename = String(record.documentNumber || record.id || documentNumber);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', officialDocumentService.buildContentDisposition(filename));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(buffer);
  } catch (err) {
    if (err.code === 'RENDERER_UNAVAILABLE') {
      console.error('[PublicDownload] Official document renderer not configured:', err.message);
      return res.status(503).json({ error: 'official_document_renderer_unconfigured' });
    }
    console.error('[PublicDownload] Document download failed:', err.message);
    return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
  }
});

module.exports = router;
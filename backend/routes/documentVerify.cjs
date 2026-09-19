/**
 * documentVerify.cjs — PUBLIC generic document verification (read-only).
 *
 *   GET /api/public/documents/verify/:documentType/:documentNumber?t=<token>
 *
 * No admin login, no portal session. Strictly GET; every failure — unknown
 * type, missing/invalid token, unknown number, store error — returns the
 * same generic 404 so documents cannot be enumerated.
 */
const express = require('express');
const { verifyDocument, supportedDocumentTypes, GENERIC_FAILURE } = require('../services/documentVerificationService.cjs');

const router = express.Router();

// Express decodes %2F, so slash-bearing numbers (INV-P726/023) arrive intact.
router.get('/verify/:documentType/:documentNumber', async (req, res) => {
  try {
    // URL slugs use hyphens (sales-order, printing-contract); the registry
    // uses underscores. Normalize here so hyphenated QR links verify.
    const type = String(req.params.documentType || '').toLowerCase().trim().replace(/-/g, '_');
    if (!supportedDocumentTypes().includes(type)) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }
    const result = await verifyDocument(type, req.params.documentNumber, req.query.t);
    if (!result.ok) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }
    return res.json(result.data);
  } catch {
    return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
  }
});

module.exports = router;

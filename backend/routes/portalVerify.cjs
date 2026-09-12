/**
 * portalVerify.cjs — compatibility wrapper for the original invoice-only
 * verification endpoint.
 *
 *   GET /api/public/invoices/verify/:invoiceNumber?t=<token>
 *
 * Delegates to the generic document verification service with
 * documentType=invoice, so customer links/QR codes issued before the
 * generic framework keep working with byte-identical responses.
 */
const express = require('express');
const { verifyDocument } = require('../services/documentVerificationService.cjs');
const { GENERIC_FAILURE } = require('../services/invoiceVerificationService.cjs');

const router = express.Router();

// Express decodes %2F, so slash-bearing numbers (INV-P726/023) arrive intact.
router.get('/verify/:invoiceNumber', async (req, res) => {
  try {
    const result = await verifyDocument('invoice', req.params.invoiceNumber, req.query.t);
    if (!result.ok) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }
    // Strip the generic envelope's documentType so legacy responses stay
    // byte-identical to the original invoice-only endpoint.
    const { documentType: _dropped, ...legacyShape } = result.data;
    return res.json(legacyShape);
  } catch {
    return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
  }
});

module.exports = router;

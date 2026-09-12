/**
 * portalVerify.cjs — PUBLIC invoice QR verification endpoint (read-only).
 *
 *   GET /api/public/invoices/verify/:invoiceNumber?t=<token>
 *
 * No admin login, no portal session. Strictly GET (read-only); every
 * failure — missing/invalid token, unknown number, store error — returns
 * the same generic 404 so invoice numbers cannot be enumerated.
 */
const express = require('express');
const { verifyInvoice, GENERIC_FAILURE } = require('../services/invoiceVerificationService.cjs');

const router = express.Router();

// Express decodes %2F, so slash-bearing numbers (INV-P726/023) arrive intact.
router.get('/verify/:invoiceNumber', async (req, res) => {
  try {
    const result = await verifyInvoice(req.params.invoiceNumber, req.query.t);
    if (!result.ok) {
      return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
    }
    return res.json(result.data);
  } catch {
    return res.status(404).json({ verified: false, error: GENERIC_FAILURE });
  }
});

module.exports = router;

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
const {
  verifyContract,
  GENERIC_NOT_FOUND,
  GENERIC_ALTERED,
} = require('../services/contractVerificationService.cjs');

const router = express.Router();

/**
 * GET /api/public/documents/contract-verify?c=<number|short-code>&h=<sha256>
 *
 * Dedicated content-hash verification for printing contracts. Mounted under
 * the same public, rate-limited prefix as the generic verifier.
 */
router.get('/contract-verify', async (req, res) => {
  try {
    const c = String(req.query.c || req.query.number || '').slice(0, 80);
    const h = String(req.query.h || req.query.hash || '').slice(0, 64);
    const sc = String(req.query.sc || req.query.shortCode || '').slice(0, 16);
    const lookup = await verifyContract({ contractNumber: c, hash: h, shortCode: sc });
    if (lookup.result === 'verified') {
      return res.status(200).json({
        ...lookup.contract,
        verified: true,
        result: 'verified',
        documentVerified: true,
        integrityVerified: true,
        integrityResult: 'Integrity Verified',
        reason: 'verified',
      });
    }
    if (lookup.result === 'altered') {
      const reason = lookup.reason || 'integrity_failed';
      const integrityResult =
        reason === 'missing_stored_hash' || reason === 'stored_hash_not_sha256'
          ? 'Hash Missing'
          : 'Integrity Mismatch';
      return res.status(200).json({
        verified: false,
        result: 'altered',
        documentVerified: true,
        integrityVerified: false,
        integrityResult,
        reason,
        error: GENERIC_ALTERED,
      });
    }
    return res.status(200).json({
      verified: false,
      result: 'not_found',
      documentVerified: false,
      integrityVerified: false,
      integrityResult: 'Not Evaluated',
      reason: lookup.reason || 'no_match',
      error: GENERIC_NOT_FOUND,
    });
  } catch (err) {
    // Store/schema failure is not "not found": 503 keeps the distinction
    // internal without leaking the underlying error to the scanner.
    console.error('[documentVerify] contract verification failed:', err?.message || err);
    return res.status(503).json({ verified: false, result: 'error', error: 'Verification is temporarily unavailable.' });
  }
});

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

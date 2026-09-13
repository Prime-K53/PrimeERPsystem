/**
 * Public customer-registration-request routes.
 *
 * Mounted at /api/portal/registration-requests (BEFORE the authenticated
 * /api/portal chain) so anonymous applicants can submit without a JWT.
 *
 *   POST /                          → submit application (201, no credentials)
 *   GET  /:requestNumber?email=...   → minimal status lookup (email match)
 *   POST /:requestNumber/cancel      → applicant cancel (email match)
 *
 * A successful submission creates EXACTLY ONE pending request and NEVER
 * issues access_token / refresh_token / portal_user / customer_id, and
 * NEVER stores password material.
 */
const express = require('express');
const customerRegistrationService = require('../services/customerRegistrationService.cjs');
const { idempotencyMiddleware } = require('../middleware/idempotency.cjs');

const router = express.Router();

function requestContext(req) {
  return {
    ip: req.ip || req.headers['x-forwarded-for'] || null,
    userAgent: req.headers['user-agent'] || null,
    method: req.method,
    path: req.originalUrl,
    correlationId: req.correlationId || null,
  };
}

function mapServiceError(err) {
  const message = (err && err.message) || 'Registration failed. Please try again.';
  if (err && err.code === 'INVALID_REFERRAL_CODE') {
    return { status: 400, body: { error: message } };
  }
  if (err && err.code === 'DUPLICATE_PENDING_REQUEST') {
    return { status: 409, body: { error: message, requestNumber: err.existingRequest?.request_number || null } };
  }
  if (err && err.code === 'DUPLICATE_CUSTOMER') {
    return { status: 409, body: { error: message } };
  }
  if (/at least 2 characters|A valid email is required|required/i.test(message)) {
    return { status: 400, body: { error: message } };
  }
  return { status: 400, body: { error: message } };
}

// ─── POST / — public submission ────────────────────────────────────────────
router.post('/', idempotencyMiddleware(), async (req, res) => {
  try {
    const record = await customerRegistrationService.createRegistrationRequest(req.body || {}, {
      idempotencyKey:
        req.headers['idempotency-key'] || req.headers['Idempotency-Key'] || null,
      context: requestContext(req),
      actor: { type: 'anonymous', role: 'anonymous' },
    });
    // Public response: request identity + status ONLY. Never tokens, users,
    // customer ids, or credential material.
    res.status(201).json({
      requestNumber: record.request_number,
      status: record.status,
      submittedAt: record.submitted_at,
      message: 'Registration request received and pending review.',
    });
  } catch (err) {
    const mapped = mapServiceError(err);
    // Duplicate-pending responses include the existing request number so a
    // double-submit can converge without leaking other PII.
    if (err && err.code === 'DUPLICATE_PENDING_REQUEST') {
      return res.status(mapped.status).json({
        error: mapped.body.error,
        requestNumber: mapped.body.requestNumber,
        status: 'pending',
      });
    }
    res.status(mapped.status).json(mapped.body);
  }
});

// ─── GET /:requestNumber — minimal anonymous status lookup ─────────────────
// Requires the applicant's email as proof of ownership (query param must
// match the stored normalized email). Returns status ONLY — no PII, no
// tokens. Rate-limited at the mount point. Authenticated per-applicant
// tracking will be added with the portal integration phase.
router.get('/:requestNumber', async (req, res) => {
  try {
    const { requestNumber } = req.params;
    const { email } = req.query || {};
    if (!email) {
      return res.status(400).json({ error: 'email query parameter is required' });
    }
    const row = await customerRegistrationService.getRequestByNumber(requestNumber);
    if (!row || row.deleted_at || row.deletedAt) {
      return res.status(404).json({ error: 'Registration request not found' });
    }
    const expected = customerRegistrationService.normalizeEmail(email);
    const actual = customerRegistrationService.normalizeEmail(row.email);
    if (!expected || expected !== actual) {
      // Indistinguishable from not-found so request numbers cannot be
      // enumerated without knowing the applicant email.
      return res.status(404).json({ error: 'Registration request not found' });
    }
    res.json(customerRegistrationService.toPublicDto(row));
  } catch (err) {
    res.status(500).json({ error: 'Failed to load registration request' });
  }
});

// ─── POST /:requestNumber/cancel — applicant cancel (idempotent) ───────────
router.post('/:requestNumber/cancel', idempotencyMiddleware(), async (req, res) => {
  try {
    const { requestNumber } = req.params;
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }
    const row = await customerRegistrationService.getRequestByNumber(requestNumber);
    if (!row || row.deleted_at || row.deletedAt) {
      return res.status(404).json({ error: 'Registration request not found' });
    }
    const expected = customerRegistrationService.normalizeEmail(email);
    const actual = customerRegistrationService.normalizeEmail(row.email);
    if (!expected || expected !== actual) {
      return res.status(404).json({ error: 'Registration request not found' });
    }
    if (row.status === 'cancelled') {
      return res.json(customerRegistrationService.toPublicDto(row));
    }
    const updated = await customerRegistrationService.cancelRequest(row.id, {
      actor: { type: 'anonymous', role: 'anonymous' },
      context: requestContext(req),
    });
    res.json(customerRegistrationService.toPublicDto(updated));
  } catch (err) {
    const message = (err && err.message) || 'Failed to cancel registration request';
    if (/Invalid registration request transition/.test(message)) {
      return res.status(409).json({ error: message });
    }
    if (/not found/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    res.status(400).json({ error: message });
  }
});

module.exports = router;

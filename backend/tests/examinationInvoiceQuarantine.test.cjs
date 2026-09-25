/**
 * examinationInvoiceQuarantine.test.cjs — Phase 6 contract.
 *
 * The backend examination-invoice creation path is quarantined: it writes to
 * a separate store, uses a divergent EXM numbering scheme, and never mints
 * verificationToken, so its invoices are invisible to the ERP invoice list
 * and can never satisfy public verification (no schema change is permitted
 * to fix that here). This suite pins the quarantine contract:
 * status flags, canonical-path pointer, and the loud usage warning.
 */
const {
  CANONICAL_EXAMINATION_INVOICE_PATH,
  QUARANTINE_REASON,
  QUARANTINE_BYPASS_ENV,
  examinationBackendInvoiceStatus,
  warnExaminationBackendInvoiceUsage,
  isBackendExaminationInvoiceCreationBlocked,
  backendExaminationInvoiceBlockedResponse,
} = require('../services/examinationInvoiceQuarantine.cjs');

describe('examinationInvoiceQuarantine', () => {
  test('status marks the path quarantined with verification unsupported', () => {
    const status = examinationBackendInvoiceStatus();
    expect(status.quarantined).toBe(true);
    expect(status.verificationUnsupported).toBe(true);
    expect(typeof status.canonicalPath).toBe('string');
    expect(status.canonicalPath.length).toBeGreaterThan(0);
    expect(status.canonicalPath).toBe(CANONICAL_EXAMINATION_INVOICE_PATH);
    expect(typeof status.reason).toBe('string');
    expect(status.reason).toBe(QUARANTINE_REASON);
  });

  test('canonical path points at the frontend offline-first flow', () => {
    expect(CANONICAL_EXAMINATION_INVOICE_PATH).toMatch('persistExaminationInvoiceToFinance');
    expect(CANONICAL_EXAMINATION_INVOICE_PATH).toMatch('Supabase');
  });

  test('usage warning is loud and returns the status', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const status = warnExaminationBackendInvoiceUsage('generateInvoice');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch('QUARANTINED');
      expect(status.quarantined).toBe(true);
      expect(status.verificationUnsupported).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  describe('P2 hard-quarantine gate', () => {
    const ENV_KEY = QUARANTINE_BYPASS_ENV;
    let original;

    beforeEach(() => {
      original = process.env[ENV_KEY];
      delete process.env[ENV_KEY];
    });

    afterEach(() => {
      if (original === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = original;
    });

    test('creation is blocked by default (unset, empty, or anything but true)', () => {
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(true);
      process.env[ENV_KEY] = '';
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(true);
      process.env[ENV_KEY] = 'false';
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(true);
      process.env[ENV_KEY] = 'yes';
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(true);
    });

    test('exact true (case-insensitive) is the only bypass', () => {
      process.env[ENV_KEY] = 'true';
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(false);
      process.env[ENV_KEY] = 'TRUE';
      expect(isBackendExaminationInvoiceCreationBlocked()).toBe(false);
    });

    test('blocked response is non-success, machine-readable, and points at the canonical path', () => {
      const blocked = backendExaminationInvoiceBlockedResponse();
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('EXAMINATION_INVOICE_QUARANTINED');
      expect(blocked.body.quarantined).toBe(true);
      expect(blocked.body.verificationUnsupported).toBe(true);
      expect(blocked.body.canonicalPath).toBe(CANONICAL_EXAMINATION_INVOICE_PATH);
      expect(String(blocked.body.error)).toMatch('quarantined');
    });
  });
});

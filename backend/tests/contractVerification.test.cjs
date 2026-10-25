/**
 * contractVerification.test.cjs — printing-contract digest parity + customer
 * identity display regression (PC-P726/024).
 *
 * 1) PARITY LOCK: the shared fixture `tests/fixtures/contract-integrity-vector.json`
 *    is hashed by the browser issuer (frontend Vitest) and MUST hash to the same
 *    digest here via `backend/services/documentIntegrity.cjs`. The frontend
 *    vector test (`frontend/tests/unit/contracts/contractIntegrityVector.test.ts`)
 *    points at this file; without it the two implementations could drift and
 *    public verification would report valid contracts as `altered`.
 *
 * 2) DISPLAY REGRESSION: a customer NAME field holding a placeholder (`_`, `—`,
 *    a bare `CUST-…` key) is a MISSING reference. Every server-side surface
 *    (public verification, server-rendered PDFs, rename cascade) must skip it
 *    and never echo the customer id. The DIGEST semantics must stay untouched
 *    so already-issued hashes still verify.
 *
 * READ-ONLY, hermetic: no network, no credentials, no writes.
 */
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || 'test-secret-key';
process.env.COMPANY_NAME = process.env.COMPANY_NAME || 'Prime Printing Service';

const integrity = require('../services/documentIntegrity.cjs');
const customerDisplay = require('../services/customerDisplay.cjs');
const contractVerification = require('../services/contractVerificationService.cjs');
const { normalizeRecordForRenderer } = require('../services/officialDocumentService.cjs');
const propagation = require('../services/customerRenamePropagation.cjs');
const fixture = require('../../tests/fixtures/contract-integrity-vector.json');

const clone = (value) => JSON.parse(JSON.stringify(value));

describe('contract integrity vector (backend ↔ frontend parity)', () => {
  const contract = () => clone(fixture.contract);

  it('builds the exact canonical JSON the browser builds', () => {
    const snapshot = integrity.contractIntegritySnapshot(contract());
    expect(snapshot.hashVersion).toBe(1);
    expect(integrity.stableStringify(snapshot)).toBe(fixture.expectedCanonicalJson);
  });

  it('hashes the canonical snapshot to the shared SHA-256 vector', () => {
    expect(fixture.expectedHash).toMatch(/^[0-9a-f]{64}$/);
    expect(integrity.hashContractRecord(contract())).toBe(fixture.expectedHash);
  });

  it('derives the shared 12-hex short code', () => {
    expect(integrity.contractShortCode(fixture.expectedHash)).toBe(fixture.expectedShortCode);
    expect(fixture.expectedShortCode).toBe('4849-ad3f-40b8');
  });

  it('ensureContractIntegrity stores the same digest and is idempotent', () => {
    const once = integrity.ensureContractIntegrity(contract());
    expect(once.contentHash).toBe(fixture.expectedHash);
    expect(once.integrityShortCode).toBe(fixture.expectedShortCode);
    const twice = integrity.ensureContractIntegrity(once);
    expect(twice.contentHash).toBe(once.contentHash);
  });

  it('keeps legacy placeholder semantics in the digest (display tightening must not re-hash history)', () => {
    // Historical rows were hashed WITH whatever the record stored. The display
    // resolvers must never leak into this projection.
    const snapshot = integrity.contractIntegritySnapshot({
      contract_number: 'PC-P726/024',
      customerName: '_',
      schoolName: 'Mphandula CDSS',
    });
    expect(snapshot.customerName).toBe('_');
    expect(snapshot.schoolName).toBe('Mphandula CDSS');
  });
});

describe('customerDisplay (server display resolvers)', () => {
  it('recognises placeholders and real names', () => {
    for (const value of ['', '   ', '_', '-', '—', 'n/a', 'Customer', 'CUST-0035']) {
      expect(customerDisplay.isPlaceholderCustomerName(value)).toBe(true);
    }
    for (const value of ['Mphandula CDSS', "St Mary's (Blantyre)", 'CUST-0035 School']) {
      expect(customerDisplay.isPlaceholderCustomerName(value)).toBe(false);
    }
  });

  it('skips placeholder candidates per field', () => {
    expect(customerDisplay.getCustomerDisplayName({ businessName: '_', companyName: 'Acme Ltd' })).toBe('Acme Ltd');
    expect(customerDisplay.getCustomerDisplayName({ businessName: '—', legacyCustomerName: 'Legacy School' })).toBe('Legacy School');
    expect(customerDisplay.getCustomerDisplayName({ businessName: '_', companyName: '-', legacyCustomerName: 'n/a' })).toBe('');
  });

  it('resolves a contract party from customer name then school, never an id', () => {
    expect(customerDisplay.resolveContractPartyName({ customerName: '_', schoolName: 'Mphandula CDSS' })).toBe('Mphandula CDSS');
    expect(customerDisplay.resolveContractPartyName({ customerName: 'CUST-0035', school_name: 'Mphandula CDSS' })).toBe('Mphandula CDSS');
    expect(customerDisplay.resolveContractPartyName({ customerName: 'Green Valley (CUST-0035)' })).toBe('Green Valley');
    expect(customerDisplay.resolveContractPartyName({ customerName: '_' })).toBe('');
  });
});

describe('contractVerificationService.safeContract (public verification display)', () => {
  it('shows the stored school when the customer name is a placeholder', () => {
    const safe = contractVerification.safeContract({
      contract_number: 'PC-P726/024',
      customerName: '_',
      schoolName: 'Mphandula CDSS',
      prepaid_amount: 5000,
      status: 'active',
    });
    expect(safe.customerName).toBe('Mphandula CDSS');
    expect(safe.customerName).not.toBe('_');
  });

  it('never echoes a bare customer id or a placeholder', () => {
    expect(contractVerification.safeContract({
      contract_number: 'PC-1',
      customerName: 'CUST-0035',
    }).customerName).toBe('Customer');
    expect(contractVerification.safeContract({
      contract_number: 'PC-1',
      customer_name: '—',
    }).customerName).toBe('Customer');
  });

  it('strips an id suffix from a real name', () => {
    expect(contractVerification.safeContract({
      contract_number: 'PC-1',
      customer_name: 'Green Valley (CUST-0035)',
    }).customerName).toBe('Green Valley');
  });

  it('keeps real stored names unchanged', () => {
    expect(contractVerification.safeContract({
      contract_number: 'PC-G001',
      customerName: 'Contract School',
    }).customerName).toBe('Contract School');
  });
});

describe('officialDocumentService.normalizeRecordForRenderer (server PDF)', () => {
  const rawContract = (overrides = {}) => ({
    contract_number: 'PC-P726/024',
    customer_id: 'CUST-0035',
    customerName: '_',
    schoolName: 'Mphandula CDSS',
    created_at: '2026-10-01T00:00:00.000Z',
    status: 'active',
    max_assessments: 2,
    assessment_price: 1000,
    ...overrides,
  });

  it('prints the school name when the stored customer name is "_"', () => {
    const doc = normalizeRecordForRenderer(rawContract(), 'PRINTING_CONTRACT');
    expect(doc.customerName).toBe('Mphandula CDSS');
    expect(doc.schoolName).toBe('Mphandula CDSS');
    expect(doc.customerName).not.toBe('Customer');
  });

  it('falls through a placeholder school to the legacy school_name spelling', () => {
    const doc = normalizeRecordForRenderer(rawContract({
      customerName: 'Green Valley School',
      schoolName: '—',
      school_name: 'Green Valley Primary',
    }), 'PRINTING_CONTRACT');
    expect(doc.customerName).toBe('Green Valley School');
    expect(doc.schoolName).toBe('Green Valley Primary');
  });

  it('never prints the raw customer id as a name', () => {
    const doc = normalizeRecordForRenderer(rawContract({
      customerName: 'CUST-0035',
      schoolName: '',
    }), 'PRINTING_CONTRACT');
    expect(doc.customerName).toBe('Customer');
    expect(doc.customerName).not.toContain('CUST-');
  });

  it('leaves a real stored name alone', () => {
    const doc = normalizeRecordForRenderer(rawContract({ customerName: 'Contract School' }), 'PRINTING_CONTRACT');
    expect(doc.customerName).toBe('Contract School');
  });
});

describe('customerRenamePropagation.resolveCloudDisplayName (rename cascade)', () => {
  it('skips placeholders instead of cascading them as names', () => {
    expect(propagation.resolveCloudDisplayName({ businessName: '_', companyName: 'Acme Ltd' })).toBe('Acme Ltd');
    expect(propagation.resolveCloudDisplayName({ businessName: '—', name: 'Legacy Shop' })).toBe('Legacy Shop');
    expect(propagation.resolveCloudDisplayName({ businessName: '_' })).toBe('');
    expect(propagation.resolveCloudDisplayName(null)).toBe('');
  });

  it('keeps real business names unchanged', () => {
    expect(propagation.resolveCloudDisplayName({ businessName: 'Acme Ltd', companyName: 'Acme' })).toBe('Acme Ltd');
    expect(propagation.resolveCloudDisplayName({ name: ' Acme ' })).toBe('Acme');
  });
});

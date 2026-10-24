/**
 * contractIntegrityVector.test.ts — cross-language parity lock for the
 * printing-contract content digest (hash v1).
 *
 * The SAME fixture (`tests/fixtures/contract-integrity-vector.json`) is hashed
 * here by the browser issuer and by
 * `backend/tests/contractVerification.test.cjs` via
 * `backend/services/documentIntegrity.cjs`. If the two implementations ever
 * drift, one side stops matching `expectedHash` and this suite fails.
 *
 * What the digest must cover: parties, line items, amounts, terms, contract
 * dates, version, status and the recorded signature blocks.
 * What it must ignore: print date, verification token, QR payload/bytes and
 * the integrity fields themselves.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTRACT_HASH_VERSION,
  buildContractIntegritySnapshot,
  contractShortCode,
  ensureContractIntegrity,
  hashContractRecord,
  stableStringify,
} from '../../../services/printingContractService';
import fixture from '../../../../tests/fixtures/contract-integrity-vector.json';

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const contract = () => clone((fixture as any).contract);

describe('contract integrity vector (frontend ↔ backend)', () => {
  it('builds the exact canonical JSON the server builds', () => {
    const snapshot = buildContractIntegritySnapshot(contract());
    expect(snapshot.hashVersion).toBe(CONTRACT_HASH_VERSION);
    expect(stableStringify(snapshot)).toBe((fixture as any).expectedCanonicalJson);
  });

  it('hashes the canonical snapshot to the shared SHA-256 vector', async () => {
    expect((fixture as any).expectedHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(hashContractRecord(contract())).resolves.toBe((fixture as any).expectedHash);
  });

  it('derives the shared 12-hex short code', () => {
    expect(contractShortCode((fixture as any).expectedHash)).toBe((fixture as any).expectedShortCode);
    expect((fixture as any).expectedShortCode).toBe('4849-ad3f-40b8');
  });

  it('ensureContractIntegrity stores the same digest and is idempotent', async () => {
    const once = await ensureContractIntegrity(contract());
    expect(once.contentHash).toBe((fixture as any).expectedHash);
    expect(once.integrityShortCode).toBe((fixture as any).expectedShortCode);
    const twice = await ensureContractIntegrity(once);
    expect(twice.contentHash).toBe(once.contentHash);
  });
});

describe('contract digest covers every material field', () => {
  const changes: Array<[string, (record: any) => void]> = [
    ['contract number', (r) => { r.contract_number = 'PC-P726/024'; }],
    ['version', (r) => { r.version = 3; }],
    ['status', (r) => { r.status = 'cancelled'; }],
    ['client name', (r) => { r.customerName = 'Another School'; }],
    ['school name', (r) => { r.data.school_name = 'Another School'; }],
    ['client contact', (r) => { r.data.customer_contact = 'Ms Phiri'; }],
    ['client phone', (r) => { r.data.customer_phone = '+265 999 111 222'; }],
    ['client address', (r) => { r.data.customer_address = 'Private Bag 9'; }],
    ['period start', (r) => { r.starts_at = '2026-10-20T00:00:00.000Z'; }],
    ['period end', (r) => { r.ends_at = '2027-05-01T00:00:00.000Z'; }],
    ['prepaid amount', (r) => { r.prepaid_amount = 79801; }],
    ['assessment price', (r) => { r.assessment_price = 1901; }],
    ['line quantity', (r) => { r.data.lines[0].quantity = 41; }],
    ['line unit price', (r) => { r.data.lines[0].unit_price = 1901; }],
    ['terms', (r) => { r.terms = 'Different terms.'; }],
    ['notes', (r) => { r.notes = 'Different notes.'; }],
    ['specification', (r) => { r.data.contract_profile.print_spec.paper_size = 'A3'; }],
    ['pricing rule', (r) => { r.data.contract_profile.pricing_rules.charge_per_candidate = 2000; }],
    ['delivery term', (r) => { r.data.contract_profile.delivery_terms.timeline = '3 days'; }],
    ['company signature image', (r) => { r.data.signatures.company.signatureDataUrl = 'data:image/png;base64,AAAA'; }],
    ['client signature name', (r) => { r.data.signatures.customer.name = 'Someone Else'; }],
  ];

  it.each(changes)('changes when %s changes', async (_label, mutate) => {
    const changed = contract();
    mutate(changed);
    await expect(hashContractRecord(changed)).resolves.not.toBe((fixture as any).expectedHash);
  });

  it('changes when a signature block is added', async () => {
    const changed = contract();
    changed.data.signatures.customer = null;
    await expect(hashContractRecord(changed)).resolves.not.toBe((fixture as any).expectedHash);
  });
});

describe('contract digest ignores volatile and non-material data', () => {
  const ignored: Array<[string, (record: any) => void]> = [
    ['print date', (r) => { r.date = '24/10/2026'; }],
    ['verification token', (r) => { r.verificationToken = '9'.repeat(64); }],
    ['content hash', (r) => { r.contentHash = '0'.repeat(64); }],
    ['short code', (r) => { r.integrityShortCode = '0000-0000-0000'; }],
    ['QR payload', (r) => { r.securityQrPayload = 'https://example.test/verify?c=X&h=Y'; }],
    ['QR image', (r) => { r.securityQrCodeDataUrl = 'data:image/png;base64,AAAA'; }],
    ['sync timestamps', (r) => {
      r.created_at = '2020-01-01T00:00:00.000Z';
      r.updated_at = '2030-01-01T00:00:00.000Z';
    }],
    ['record ids', (r) => {
      r.id = 'another-id';
      r.school_id = 'another-school';
      r.company_id = 'another-company';
    }],
    ['client email', (r) => { r.data.customer_email = 'private@example.test'; }],
  ];

  it.each(ignored)('stays stable when %s changes', async (_label, mutate) => {
    const changed = contract();
    mutate(changed);
    await expect(hashContractRecord(changed)).resolves.toBe((fixture as any).expectedHash);
  });

  it('normalises contract dates to their calendar day', async () => {
    const sameDay = contract();
    sameDay.starts_at = '2026-10-19T23:59:59.000Z';
    sameDay.ends_at = '2027-04-30T00:00:01.000Z';
    await expect(hashContractRecord(sameDay)).resolves.toBe((fixture as any).expectedHash);
  });
});

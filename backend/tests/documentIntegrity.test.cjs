/**
 * documentIntegrity.test.cjs
 *
 * Pins the SERVER-side hash rules used before a public verify/download is
 * allowed. Fixtures mirror the key sets of the two real legacy rows (schedule
 * and completion receipt) with synthetic values, so the rule is regression-
 * covered without embedding live customer data.
 *
 * The expected digests are computed by an INDEPENDENT canonical serialiser in
 * this file, not by the module under test.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const integrity = require('../services/documentIntegrity.cjs');

function canonical(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const legacySchedule = () => ({
  documentType: 'printing_contract_schedule',
  verificationToken: 'a'.repeat(64),
  contractNumber: 'PC-LEGACY/1',
  date: '18/10/2026',
  version: 3,
  status: 'active',
  customerName: 'Legacy School',
  schoolName: 'Legacy School',
  billedBranch: 'Main Account',
  academicYear: '2026/27',
  periodStart: '2026-10-18T00:00:00.000Z',
  periodEnd: '2027-04-30T00:00:00.000Z',
  schedule: [
    { sequence: 1, assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', assessmentDate: '15/10/2026', status: 'reserved', unitPrice: 79800 },
  ],
  totalAssessments: 1,
  scheduleComplete: true,
  missingDateSequences: [],
  scheduledCount: 1,
  consumedCount: 0,
  releasedCount: 0,
  cancelledCount: 0,
  prepaidAmount: 79800,
  reservedAmount: 79800,
  consumedAmount: 0,
  availableFunds: 0,
  totalValue: 79800,
  totalCandidature: 40,
  assessmentSpec: 'Spec',
  chargePerCandidate: 1995,
  assessmentSittings: 'Morning',
  terms: 'Terms',
  // schoolZone / customerPhone / notes were dropped by JSONB persistence
});

const legacyReceipt = () => ({
  documentType: 'printing_contract_completion_receipt',
  verificationToken: 'b'.repeat(64),
  receiptNumber: 'PCR-PC-LEGACY/1',
  contractNumber: 'PC-LEGACY/1',
  date: '19/10/2026',
  version: 3,
  status: 'active',
  customerName: 'Legacy School (CUST-1)',
  schoolName: 'Legacy School',
  item: { assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', consumedAt: '19/10/2026', unitPrice: 79800 },
  sequence: 1,
  totalAssessments: 1,
  completedToDate: 1,
  remainingAssessments: 0,
  contractValue: 79800,
  amountDebited: 79800,
  totalConsumedToDate: 79800,
  remainingReservedFunds: 0,
  unallocatedFunds: 0,
  walletBalanceAfter: 79800,
  walletTransactionId: 'WTX-1',
  ledgerEntryId: 'LG-1',
  // notes dropped by JSONB persistence
});

describe('server legacy schedule hash', () => {
  it('verifies the authentic null-padded document', () => {
    const content = legacySchedule();
    const padded = { ...content, schoolZone: null, customerPhone: null, notes: null };
    const expected = sha256(canonical(padded));
    const row = {
      documentType: 'printing_contract_schedule',
      contentHash: expected,
      content: { ...content, contentHash: expected },
    };
    const out = integrity.verifyScheduleRow(row);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.rule, 'legacy');
    assert.equal(out.recomputed, expected);
  });

  it('is NOT the naive delete-contentHash rule', () => {
    const content = legacySchedule();
    const naive = sha256(canonical(content));
    const row = {
      documentType: 'printing_contract_schedule',
      contentHash: naive,
      content: { ...content, contentHash: naive },
    };
    const out = integrity.verifyScheduleRow(row);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'integrity_failed');
  });

  it('rejects altered material content', () => {
    const content = legacySchedule();
    const padded = { ...content, schoolZone: null, customerPhone: null, notes: null };
    const expected = sha256(canonical(padded));
    const row = {
      documentType: 'printing_contract_schedule',
      contentHash: expected,
      content: { ...content, contentHash: expected, prepaidAmount: 1 },
    };
    const out = integrity.verifyScheduleRow(row);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'integrity_failed');
  });
});

describe('server legacy completion-receipt hash', () => {
  it('verifies the authentic document with a dropped notes key', () => {
    const content = legacyReceipt();
    const expected = sha256(canonical({ ...content, notes: null }));
    const row = { contentHash: expected, content: { ...content, contentHash: expected } };
    const out = integrity.verifyReceiptRow(row);
    assert.equal(out.ok, true, JSON.stringify(out));
    assert.equal(out.rule, 'legacy');
  });

  it('rejects an altered debited amount', () => {
    const content = legacyReceipt();
    const expected = sha256(canonical({ ...content, notes: null }));
    const row = { contentHash: expected, content: { ...content, contentHash: expected, amountDebited: 1 } };
    const out = integrity.verifyReceiptRow(row);
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'integrity_failed');
  });
});

describe('server stable-envelope (v2) schedule hash', () => {
  const base = () => ({
    documentType: 'printing_contract_schedule',
    contractNumber: 'PC-V2/1',
    date: '2026-10-18',
    verificationToken: 'c'.repeat(64),
    status: 'active',
    customerName: 'V2 School',
    schedule: [{ sequence: 1, assessmentName: 'A', status: 'reserved', unitPrice: 1 }],
    totalAssessments: 1,
    scheduleComplete: true,
    missingDateSequences: [],
    scheduledCount: 1,
    consumedCount: 0,
    releasedCount: 0,
    cancelledCount: 0,
    prepaidAmount: 1,
    reservedAmount: 1,
    consumedAmount: 0,
    availableFunds: 0,
    totalValue: 1,
    hashVersion: 2,
  });

  const digest = (content) => {
    const copy = { ...content };
    for (const k of ['contentHash', 'date', 'verificationToken', 'securityQrPayload', 'securityQrCodeDataUrl']) delete copy[k];
    return sha256(canonical(copy));
  };

  it('verifies and ignores volatile date/token changes', () => {
    const content = base();
    const hash = digest(content);
    const out = integrity.verifyScheduleRow({ hashVersion: 2, contentHash: hash, content: { ...content, contentHash: hash } });
    assert.equal(out.ok, true);
    assert.equal(out.rule, 'v2');

    const reissued = { ...content, date: '2026-11-01', verificationToken: 'd'.repeat(64), contentHash: hash };
    const again = integrity.verifyScheduleRow({ hashVersion: 2, contentHash: hash, content: reissued });
    assert.equal(again.ok, true);
  });

  it('fails when stable content is altered', () => {
    const content = base();
    const hash = digest(content);
    const out = integrity.verifyScheduleRow({
      hashVersion: 2,
      contentHash: hash,
      content: { ...content, contentHash: hash, prepaidAmount: 999 },
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'integrity_failed');
  });

  it('ignores the issued version identity carried in the content', () => {
    // The version identity is injected into the content AFTER it is hashed (the
    // version number is allocated once the digest is known), so it is volatile
    // metadata: excluding it on both sides keeps the digest reproducible.
    const content = base();
    const hash = digest(content);
    const issued = { ...content, documentId: 'SCH-PC-V2/1-v1', documentVersion: 1, contentHash: hash };
    const out = integrity.verifyScheduleRow({ hashVersion: 2, contentHash: hash, content: issued });
    assert.equal(out.ok, true);
    assert.equal(out.rule, 'v2');
  });

  it('excludes exactly the same volatile keys as the frontend', () => {
    // The two exclusion lists must stay identical: if they drift, EVERY
    // schedule fails verification on one side of the system.
    const fs = require('node:fs');
    const path = require('node:path');
    const frontend = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'frontend', 'services', 'printingContractService.ts'),
      'utf8',
    );
    const match = frontend.match(/SCHEDULE_VOLATILE_HASH_KEYS\s*=\s*\[([\s\S]*?)\]\s*as const/);
    assert.ok(match, 'the frontend volatile key list must be readable');
    const frontendKeys = Array.from(match[1].matchAll(/'([^']+)'/g)).map((m) => m[1]);
    const serverKeys = Array.from(
      integrity.SCHEDULE_VOLATILE_HASH_KEYS || [],
    );
    if (serverKeys.length) {
      assert.deepEqual([...serverKeys].sort(), [...frontendKeys].sort());
    } else {
      // The module does not export the list: compare through a verification
      // that proves each frontend key is ignored server-side.
      const content = base();
      const hash = digest(content);
      const probe = { ...content };
      for (const key of frontendKeys) probe[key] = 'probe';
      probe.contentHash = hash;
      const out = integrity.verifyScheduleRow({ hashVersion: 2, contentHash: hash, content: probe });
      assert.equal(out.ok, true);
    }
  });
});

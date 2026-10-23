/**
 * contractDocumentGuard.test.cjs
 *
 * The sync gateway's pre-write guard for issued contract documents.
 *
 * A deterministic database rejection (unique violation, trigger refusal)
 * arrives as HTTP 409 — the same status as a lost optimistic-concurrency
 * race. Classified as retryable it is re-sent forever. The guard turns the
 * known deterministic cases into a clean, non-retryable rejection BEFORE the
 * write, so the reason is visible and the operation is dead-lettered.
 *
 * The cloud access is injected: no network, no credentials, no writes.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { validateContractDocumentOp, legacyVersionValue, isCanonicalVersion } = require('../services/contractDocumentGuard.cjs');

describe('canonical version classification (matches the database)', () => {
  it('accepts only a JSON number in the supported range', () => {
    // The database requires jsonb_typeof(data->'documentVersion') = 'number'
    // AND a positive integer text of at most nine digits.
    assert.equal(isCanonicalVersion(1), true);
    assert.equal(isCanonicalVersion(999999999), true);
    assert.equal(isCanonicalVersion(1000000000), false);
    assert.equal(isCanonicalVersion(0), false);
    assert.equal(isCanonicalVersion(-1), false);
    assert.equal(isCanonicalVersion(1.5), false);
    assert.equal(isCanonicalVersion('1'), false);
    assert.equal(isCanonicalVersion('01'), false);
    assert.equal(isCanonicalVersion('1e3'), false);
    assert.equal(isCanonicalVersion(null), false);
    assert.equal(isCanonicalVersion(undefined), false);
  });

  it('compares a legacy version by its numeric value', () => {
    assert.equal(legacyVersionValue('05'), 5);
    assert.equal(legacyVersionValue('1'), 1);
    assert.equal(legacyVersionValue(5), 5);
    assert.equal(legacyVersionValue('abc'), 0);
    assert.equal(legacyVersionValue(1.5), 0);
    assert.equal(legacyVersionValue(1000000000), 0);
    assert.equal(legacyVersionValue(undefined), 0);
  });
});

const row = (id, data) => ({ id, data });

const depsWith = (rows = [], byId = {}) => ({
  findRowsByDataField: async (_table, field, value) => {
    if (field === 'contract_id') return rows.filter((r) => String(r.data.contract_id) === String(value));
    if (field === 'assessmentItemId') return rows.filter((r) => String(r.data.assessmentItemId) === String(value));
    return [];
  },
  findRowById: async (_table, id) => byId[id] || null,
});

const scheduleOp = (over = {}) => ({
  operation: 'upsert',
  recordId: 'SCH-cid-1-v2',
  payload: {
    id: 'SCH-cid-1-v2',
    contract_id: 'cid-1',
    documentType: 'printing_contract_schedule',
    documentNumber: 'PC-1',
    documentVersion: 2,
    status: 'VALID',
    ...over,
  },
});

describe('contract document guard — schedule identity', () => {
  it('accepts a first version of a contract', async () => {
    const reason = await validateContractDocumentOp(scheduleOp(), depsWith([]));
    assert.equal(reason, null);
  });

  it('rejects a version that already exists under another row', async () => {
    const rows = [row('SCH-cid-1-v1', {
      contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2, status: 'VALID',
    })];
    const reason = await validateContractDocumentOp(scheduleOp(), depsWith(rows));
    assert.match(String(reason), /already exists for contract cid-1/);
  });

  it('ignores its own row when re-sending the same version', async () => {
    const rows = [row('SCH-cid-1-v2', {
      contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2, status: 'VALID',
    })];
    const reason = await validateContractDocumentOp(scheduleOp(), depsWith(rows));
    assert.equal(reason, null);
  });

  it('ignores a different document type of the same contract', async () => {
    const rows = [row('PCR-cid-1', {
      contract_id: 'cid-1', documentType: 'printing_contract_completion_receipt', documentVersion: 2, status: 'VALID',
    })];
    const reason = await validateContractDocumentOp(scheduleOp(), depsWith(rows));
    assert.equal(reason, null);
  });

  it('ignores a tombstoned row', async () => {
    const rows = [row('SCH-cid-1-v1', {
      contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2, status: 'VALID', deleted: true,
    })];
    const reason = await validateContractDocumentOp(scheduleOp(), depsWith(rows));
    assert.equal(reason, null);
  });

  it('ignores a row whose version is NOT canonical (it is not in the identity index)', async () => {
    // Migration 0052 indexes only rows whose version is a canonical JSON
    // number. A legacy row (version '1' as a string) is NOT indexed, so it
    // cannot clash - the probe must not refuse a write the database accepts.
    for (const legacyVersion of ['1', '01', '1.5', null]) {
      const rows = [row('SCH-legacy', {
        contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: legacyVersion, status: 'VALID',
      })];
      const reason = await validateContractDocumentOp(scheduleOp(), depsWith(rows));
      assert.equal(reason, null, `legacy version ${JSON.stringify(legacyVersion)} must not be a clash`);
    }
  });

  it('does not treat a non-canonical PAYLOAD version as an identity', async () => {
    // A write whose own version is not canonical is not indexed either, so it
    // cannot collide with an indexed row.
    const rows = [row('SCH-cid-1-v1', {
      contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2, status: 'VALID',
    })];
    const reason = await validateContractDocumentOp(
      scheduleOp({ documentVersion: '2' }),
      depsWith(rows),
    );
    assert.equal(reason, null);
  });
});

describe('contract document guard — receipt identity', () => {
  const receiptOp = (over = {}) => ({
    operation: 'upsert',
    recordId: 'PCR-item-2',
    payload: {
      id: 'PCR-item-2',
      contract_id: 'cid-1',
      documentType: 'printing_contract_completion_receipt',
      documentNumber: 'PCR-PC-1',
      documentVersion: 2,
      assessmentItemId: 'item-2',
      status: 'VALID',
      ...over,
    },
  });

  it('accepts a receipt for a new assessment item', async () => {
    const reason = await validateContractDocumentOp(receiptOp(), depsWith([]));
    assert.equal(reason, null);
  });

  it('rejects a second receipt for the same assessment item', async () => {
    // Another device issued a receipt for the same assessment under a
    // different row id: 0049's uq_contract_documents_receipt_item refuses it.
    const rows = [row('PCR-item-2-alt', {
      contract_id: 'cid-1', documentType: 'printing_contract_completion_receipt', assessmentItemId: 'item-2', documentVersion: 1,
    })];
    const reason = await validateContractDocumentOp(receiptOp(), depsWith(rows));
    assert.match(String(reason), /already exists for assessment item-2/);
  });

  it('ignores its own row when the same receipt is re-sent', async () => {
    const rows = [row('PCR-item-2', {
      contract_id: 'cid-1', documentType: 'printing_contract_completion_receipt', assessmentItemId: 'item-2', documentVersion: 1,
    })];
    const reason = await validateContractDocumentOp(receiptOp(), depsWith(rows));
    assert.equal(reason, null);
  });

  it('accepts a receipt for a DIFFERENT item of the same contract', async () => {
    // Two receipts of one contract share the number; only the assessment item
    // identifies them.
    const rows = [row('PCR-item-1', {
      contract_id: 'cid-1', documentType: 'printing_contract_completion_receipt', assessmentItemId: 'item-1', documentVersion: 1,
    })];
    const reason = await validateContractDocumentOp(receiptOp(), depsWith(rows));
    assert.equal(reason, null);
  });
});

describe('contract document guard — supersede link', () => {
  const supersedeOp = (over = {}) => ({
    operation: 'upsert',
    recordId: 'SCH-cid-1-v1',
    payload: {
      id: 'SCH-cid-1-v1',
      contract_id: 'cid-1',
      documentType: 'printing_contract_schedule',
      documentNumber: 'PC-1',
      documentVersion: 1,
      status: 'SUPERSEDED',
      supersededBy: 'SCH-cid-1-v2',
      ...over,
    },
  });

  const target = (over = {}) => ({
    id: 'SCH-cid-1-v2',
    data: {
      contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2, ...over,
    },
  });

  it('accepts a supersede pointing at a newer version of the same contract', async () => {
    const reason = await validateContractDocumentOp(supersedeOp(), depsWith([], { 'SCH-cid-1-v2': target() }));
    assert.equal(reason, null);
  });

  it('rejects a supersede whose target does not exist yet', async () => {
    const reason = await validateContractDocumentOp(supersedeOp(), depsWith([]));
    assert.match(String(reason), /has not been published yet/);
  });

  it('rejects a self-reference', async () => {
    const reason = await validateContractDocumentOp(
      supersedeOp({ supersededBy: 'SCH-cid-1-v1' }),
      depsWith([], { 'SCH-cid-1-v1': target() }),
    );
    assert.match(String(reason), /cannot supersede itself/);
  });

  it('rejects a target from another contract', async () => {
    const reason = await validateContractDocumentOp(
      supersedeOp(),
      depsWith([], { 'SCH-cid-1-v2': target({ contract_id: 'cid-2' }) }),
    );
    assert.match(String(reason), /belongs to a different contract/);
  });

  it('rejects a target of another document type', async () => {
    const reason = await validateContractDocumentOp(
      supersedeOp(),
      depsWith([], { 'SCH-cid-1-v2': target({ documentType: 'printing_contract_completion_receipt' }) }),
    );
    assert.match(String(reason), /different document type/);
  });

  it('rejects a target that is not newer', async () => {
    const reason = await validateContractDocumentOp(
      supersedeOp(),
      depsWith([], { 'SCH-cid-1-v2': target({ documentVersion: 1 }) }),
    );
    assert.match(String(reason), /must have a greater version/);
  });

  it('lets a canonical version replace a LEGACY version of the same number', async () => {
    // The superseded row carries the legacy version '01'; the canonical 1
    // legitimately replaces it (the same rule the database applies).
    const reason = await validateContractDocumentOp(
      supersedeOp({ documentVersion: '01' }),
      depsWith([], { 'SCH-cid-1-v2': target() }),
    );
    assert.equal(reason, null);
  });

  it('still refuses a target that is OLDER than a legacy version', async () => {
    const reason = await validateContractDocumentOp(
      supersedeOp({ documentVersion: '05' }),
      depsWith([], { 'SCH-cid-1-v2': target({ documentVersion: 3 }) }),
    );
    assert.match(String(reason), /must have a greater version/);
  });
});

describe('contract document guard — resilience', () => {
  it('never blocks a write when the probe itself fails', async () => {
    const broken = {
      findRowsByDataField: async () => { throw new Error('cloud unreachable'); },
      findRowById: async () => { throw new Error('cloud unreachable'); },
    };
    const reason = await validateContractDocumentOp(scheduleOp(), broken);
    assert.equal(reason, null);
  });

  it('ignores a delete operation', async () => {
    const reason = await validateContractDocumentOp({ operation: 'delete', recordId: 'SCH-cid-1-v1' }, depsWith([]));
    assert.equal(reason, null);
  });
});

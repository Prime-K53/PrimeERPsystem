/**
 * contractDocumentGuard.test.ts — the client-side mirror of the database's
 * document rules (migrations 0052 / 0053).
 *
 * The guard exists so the client never queues a write the database would
 * reject deterministically (which the sync gateway would then either retry
 * forever or dead-letter with an opaque error). These tests pin the rules the
 * SQL trigger implements in `supabase/migrations/0052_contract_document_identity.sql`.
 */
import { describe, it, expect } from 'vitest';
import {
  ALLOWED_STATUS_TRANSITIONS,
  CANONICAL_DOCUMENT_VERSION_RE,
  FROZEN_DOCUMENT_FIELDS,
  diffFrozenDocumentFields,
  isAllowedStatusTransition,
  isCanonicalDocumentVersion,
  legacyVersionValue,
  validateDocumentInsert,
  validateDocumentUpdate,
} from '../../../services/contractDocumentGuard';

const doc = (over: Record<string, any> = {}) => ({
  id: 'SCH-cid-1-v1',
  contract_id: 'cid-1',
  company_id: 'co-1',
  customer_id: 'cust-1',
  documentType: 'printing_contract_schedule',
  documentNumber: 'PC-1',
  documentVersion: 1,
  contractVersion: 3,
  content: { contractNumber: 'PC-1', customerName: 'School' },
  contentHash: 'a'.repeat(64),
  hashVersion: 2,
  verificationToken: 'b'.repeat(64),
  issuedAt: '2026-10-20T10:00:00.000Z',
  issuedBy: 'system',
  status: 'VALID',
  created_at: '2026-10-20T10:00:00.000Z',
  updated_at: '2026-10-20T10:00:00.000Z',
  version: 1,
  data: { id: 'SCH-cid-1-v1', contract_id: 'cid-1' },
  ...over,
});

describe('canonical document version', () => {
  it('accepts positive integers only', () => {
    expect(isCanonicalDocumentVersion(1)).toBe(true);
    expect(isCanonicalDocumentVersion(42)).toBe(true);
    // A numeric STRING is a legacy version, not a canonical one (the database
    // requires jsonb_typeof(...) = 'number').
    expect(isCanonicalDocumentVersion('1')).toBe(false);
  });

  it('caps the canonical version at the INT4-safe bound the database uses', () => {
    // The database enforces the same nine-digit cap, so a version that fits
    // here fits the identity index expression there.
    expect(isCanonicalDocumentVersion(999999999)).toBe(true);
    expect(isCanonicalDocumentVersion('999999999')).toBe(false);   // a string is legacy
    expect(isCanonicalDocumentVersion(1000000000)).toBe(false);
    expect(isCanonicalDocumentVersion(1000000000)).toBe(false);
    expect(isCanonicalDocumentVersion(99999999999999999999)).toBe(false);
  });

  it('treats a numeric string as LEGACY, exactly as the database does', () => {
    // The database requires jsonb_typeof(...) = 'number': "1" and "01" are
    // legacy rows, excluded from the identity index, compared by their value.
    expect(isCanonicalDocumentVersion(1)).toBe(true);
    expect(isCanonicalDocumentVersion('1')).toBe(false);
    expect(isCanonicalDocumentVersion('01')).toBe(false);
    expect(isCanonicalDocumentVersion(1.5)).toBe(false);
    expect(isCanonicalDocumentVersion('1e3')).toBe(false);
    expect(isCanonicalDocumentVersion(null)).toBe(false);
    expect(isCanonicalDocumentVersion(undefined)).toBe(false);
    expect(isCanonicalDocumentVersion({})).toBe(false);
  });

  it('compares a legacy version by its numeric value', () => {
    // '05' compares as 5; anything that is not an integer compares as 0.
    expect(legacyVersionValue('05')).toBe(5);
    expect(legacyVersionValue(5)).toBe(5);
    expect(legacyVersionValue('abc')).toBe(0);
    expect(legacyVersionValue(undefined)).toBe(0);
    expect(legacyVersionValue(1.5)).toBe(0);
    expect(legacyVersionValue(1000000000)).toBe(0);
  });

  it('rejects every non-canonical form', () => {
    for (const bad of ['01', '1.0', '1.5', '0', 0, -1, '-1', 'abc', '', ' 1', '1e3', 1.5, null, undefined, {}]) {
      expect(isCanonicalDocumentVersion(bad), String(bad)).toBe(false);
    }
    expect(CANONICAL_DOCUMENT_VERSION_RE.test('01')).toBe(false);
    expect(CANONICAL_DOCUMENT_VERSION_RE.test('1')).toBe(true);
  });
});

describe('lifecycle transitions', () => {
  it('allows VALID -> SUPERSEDED and idempotent repeats', () => {
    expect(isAllowedStatusTransition('VALID', 'SUPERSEDED')).toBe(true);
    expect(isAllowedStatusTransition('VALID', 'VALID')).toBe(true);
    expect(isAllowedStatusTransition('SUPERSEDED', 'SUPERSEDED')).toBe(true);
    expect(ALLOWED_STATUS_TRANSITIONS.VALID).toEqual(['VALID', 'SUPERSEDED']);
  });

  it('never lets a superseded document return to VALID', () => {
    expect(isAllowedStatusTransition('SUPERSEDED', 'VALID')).toBe(false);
    expect(isAllowedStatusTransition('VOID', 'VALID')).toBe(false);
  });

  it('does not invent VOID semantics', () => {
    // No writer produces VOID for a contract document and its meaning for an
    // already printed document is a business decision, so the transition is
    // blocked rather than half-implemented.
    expect(isAllowedStatusTransition('VALID', 'VOID')).toBe(false);
    expect(isAllowedStatusTransition('SUPERSEDED', 'VOID')).toBe(false);
  });

  it('rejects unknown statuses', () => {
    expect(isAllowedStatusTransition('VALID', 'PUBLISHED')).toBe(false);
    expect(isAllowedStatusTransition('UNKNOWN', 'VALID')).toBe(false);
  });
});

describe('frozen fields', () => {
  it('detects no change for an identical revision', () => {
    expect(diffFrozenDocumentFields(doc(), doc())).toEqual([]);
  });

  it('detects every issued field that must not change', () => {
    const cases: Array<[string, Record<string, any>]> = [
      ['content', { content: { contractNumber: 'PC-1', customerName: 'Other' } }],
      ['contentHash', { contentHash: 'c'.repeat(64) }],
      ['hashVersion', { hashVersion: 1 }],
      ['verificationToken', { verificationToken: 'd'.repeat(64) }],
      ['documentNumber', { documentNumber: 'PC-2' }],
      ['documentType', { documentType: 'printing_contract_completion_receipt' }],
      ['documentVersion', { documentVersion: 2 }],
      ['contract_id', { contract_id: 'cid-2' }],
      ['issuedAt', { issuedAt: '2026-10-21T10:00:00.000Z' }],
      ['issuedBy', { issuedBy: 'someone' }],
      ['contractVersion', { contractVersion: 4 }],
      ['assessmentItemId', { assessmentItemId: 'item-1' }],
      ['walletTransactionId', { walletTransactionId: 'WTX-1' }],
      ['ledgerEntryId', { ledgerEntryId: 'LG-1' }],
      ['id', { id: 'SCH-cid-1-v9' }],
    ];
    for (const [field, patch] of cases) {
      const changed = diffFrozenDocumentFields(doc(), doc(patch));
      expect(changed, field).toContain(field);
    }
  });

  it('catches the duplicated payload id drifting from the row id', () => {
    const changed = diffFrozenDocumentFields(doc(), doc({ data: { id: 'SCH-other', contract_id: 'cid-1' } }));
    expect(changed).toContain('id');
  });

  it('does not treat the lifecycle fields as frozen', () => {
    const changed = diffFrozenDocumentFields(
      doc(),
      doc({ status: 'SUPERSEDED', supersededBy: 'SCH-cid-1-v2', version: 2, updated_at: 'later' }),
    );
    expect(changed).toEqual([]);
  });

  it('freezes every field the migration freezes', () => {
    // The SQL trigger compares exactly this set (plus the payload id).
    expect([...FROZEN_DOCUMENT_FIELDS].sort()).toEqual([
      'assessmentItemId', 'company_id', 'content', 'contentHash', 'contractVersion',
      'contract_id', 'customer_id', 'documentNumber', 'documentType', 'documentVersion',
      'hashVersion', 'id', 'issuedAt', 'issuedBy', 'ledgerEntryId', 'verificationToken',
      'walletTransactionId',
    ]);
  });
});

describe('validateDocumentUpdate', () => {
  const supersede = (over: Record<string, any> = {}) => ({
    ...doc(),
    status: 'SUPERSEDED',
    supersededBy: 'SCH-cid-1-v2',
    version: 2,
    ...over,
  });

  it('accepts a valid supersede', () => {
    const result = validateDocumentUpdate(doc(), supersede(), {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 2 },
    });
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('accepts an idempotent repeat of the same supersede', () => {
    const result = validateDocumentUpdate(supersede(), supersede());
    expect(result.ok).toBe(true);
  });

  it('refuses a resurrection to VALID', () => {
    const result = validateDocumentUpdate(supersede(), { ...supersede(), status: 'VALID', supersededBy: undefined });
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('status_transition_forbidden');
  });

  it('refuses a VOID transition', () => {
    const result = validateDocumentUpdate(doc(), doc({ status: 'VOID' }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('status_transition_forbidden');
  });

  it('refuses a changed content, hash, hash rule, token or identity', () => {
    for (const patch of [
      { content: { tampered: true } },
      { contentHash: 'f'.repeat(64) },
      { hashVersion: 1 },
      { verificationToken: 'e'.repeat(64) },
      { id: 'SCH-cid-1-v3' },
      { documentVersion: 3 },
      { contract_id: 'cid-2' },
      { issuedAt: '2026-10-21T10:00:00.000Z' },
    ]) {
      const result = validateDocumentUpdate(doc(), supersede(patch));
      expect(result.ok, JSON.stringify(patch)).toBe(false);
      expect(result.violations[0].rule).toBe('frozen_field_changed');
    }
  });

  it('refuses a supersede without a target', () => {
    const result = validateDocumentUpdate(doc(), { ...doc(), status: 'SUPERSEDED', supersededBy: '' });
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('superseded_by_missing');
  });

  it('refuses a self-reference', () => {
    const result = validateDocumentUpdate(doc(), { ...doc(), status: 'SUPERSEDED', supersededBy: doc().id });
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('superseded_by_self');
  });

  it('refuses a target from another contract, another type or an older version', () => {
    const foreign = validateDocumentUpdate(doc(), supersede(), {
      supersededByTarget: { contract_id: 'cid-2', documentType: 'printing_contract_schedule', documentVersion: 9 },
    });
    expect(foreign.violations[0].rule).toBe('superseded_by_foreign_contract');

    const otherType = validateDocumentUpdate(doc(), supersede(), {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_completion_receipt', documentVersion: 9 },
    });
    expect(otherType.violations[0].rule).toBe('superseded_by_foreign_type');

    const older = validateDocumentUpdate(doc(), supersede(), {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 1 },
    });
    expect(older.violations[0].rule).toBe('superseded_by_not_newer');
  });

  it('lets a canonical version replace a LEGACY version of the same number', () => {
    // The legacy row carries version '01' (not canonical); the canonical 1
    // legitimately replaces it. A lower version still may not.
    const legacyRow = doc({ documentVersion: '01' });
    const replacement = { ...legacyRow, status: 'SUPERSEDED', supersededBy: 'SCH-cid-1-v2' };
    const allowed = validateDocumentUpdate(legacyRow, replacement, {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 1 },
    });
    expect(allowed.ok).toBe(true);

    const tooOld = validateDocumentUpdate(legacyRow, replacement, {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 0 },
    });
    expect(tooOld.ok).toBe(false);
    expect(tooOld.violations[0].rule).toBe('superseded_by_not_newer');
  });

  it('applies the legacy rule to a row whose version is a numeric STRING', () => {
    // '1' is a legacy row (the database requires a JSON number), so it may be
    // replaced by a target that is not older than it.
    const legacyRow = doc({ documentVersion: '1' });
    const replacement = { ...legacyRow, status: 'SUPERSEDED', supersededBy: 'SCH-cid-1-v2' };
    const allowed = validateDocumentUpdate(legacyRow, replacement, {
      supersededByTarget: { contract_id: 'cid-1', documentType: 'printing_contract_schedule', documentVersion: 1 },
    });
    expect(allowed.ok).toBe(true);
  });

  it('refuses a tombstone on an issued document', () => {
    const result = validateDocumentUpdate(doc(), doc({ deleted: true, deletedAt: '2026-10-21T00:00:00.000Z' }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('tombstone_forbidden');
  });

  it('refuses a supersededBy link on a document that is not superseded', () => {
    const result = validateDocumentUpdate(doc(), doc({ supersededBy: 'SCH-cid-1-v2' }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('superseded_by_unexpected');
  });
});

describe('validateDocumentInsert', () => {
  it('accepts a well formed schedule', () => {
    expect(validateDocumentInsert(doc()).ok).toBe(true);
  });

  it('refuses a non-canonical version', () => {
    const result = validateDocumentInsert(doc({ documentVersion: '01' }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('document_version_not_canonical');
  });

  it('refuses a missing contract id, an unknown type and a VOID status', () => {
    expect(validateDocumentInsert(doc({ contract_id: '' })).violations[0].rule).toBe('contract_id_missing');
    expect(validateDocumentInsert(doc({ documentType: 'printing_contract' })).violations[0].rule).toBe('document_type_unknown');
    expect(validateDocumentInsert(doc({ status: 'VOID' })).violations[0].rule).toBe('status_not_insertable');
  });

  it('refuses a payload id that does not match the row id', () => {
    const result = validateDocumentInsert(doc({ data: { id: 'SCH-other' } }));
    expect(result.ok).toBe(false);
    expect(result.violations[0].rule).toBe('id_mismatch');
  });
});

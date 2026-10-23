/**
 * contractDocumentGuard.ts — the client's mirror of the database's rules for
 * issued contract documents (schedules + completion receipts).
 *
 * WHY THIS EXISTS
 *   Migration 0052 adds database-level guarantees to `contract_documents`:
 *   issued content is immutable, a document can never return to VALID, and a
 *   supersede must point at a real newer version of the same contract. A
 *   client that emits an illegal write does not merely fail — it fails
 *   DETERMINISTICALLY, and the sync gateway would either retry it forever or
 *   dead-letter it with an opaque database error.
 *
 *   So the same rules are implemented here, in pure TypeScript, and applied
 *   BEFORE a write is queued. The client refuses to produce a write the
 *   database would reject; the database trigger remains the backstop for any
 *   other writer (a second device, a direct PostgREST call, a future client).
 *
 * MIRRORING CONTRACT
 *   Every rule below has a counterpart in
 *   `supabase/migrations/0052_contract_document_identity.sql` (and 0053 for the
 *   single-current rule). When one changes, BOTH must change:
 *     - canonical version      : SQL predicate `(data->>'documentVersion') ~ '^[1-9][0-9]*$'`
 *                                + `jsonb_typeof(data->'documentVersion') = 'number'`
 *     - status transitions     : SQL `enforce_contract_document_immutability()`
 *     - frozen fields          : SQL frozen-field comparison
 *     - supersededBy reference : SQL supersededBy validation
 *   The database is authoritative; this module exists so the client never
 *   depends on a database rejection to discover a mistake.
 */

/**
 * Canonical document version: a positive integer with no leading zeros, of at
 * most NINE digits (1 .. 999999999).
 *
 * The nine-digit cap is the same bound the database enforces
 * (`supabase/migrations/0052_contract_document_identity.sql`): it keeps every
 * `::INT` cast inside PostgreSQL's INT4 range, so a stored value can never
 * overflow the identity index expression.
 */
export const CANONICAL_DOCUMENT_VERSION_RE = /^[1-9][0-9]{0,8}$/;

/** The largest canonical version (INT4-safe). */
export const MAX_CANONICAL_DOCUMENT_VERSION = 999999999;

/** The legacy comparison form of a version (mirrors the database's R2 rule). */
export const LEGACY_VERSION_RE = /^[0-9]{1,9}$/;

/**
 * The value an EXISTING version compares as.
 *
 * A version whose text form is an integer keeps that value (leading zeros
 * allowed: '05' compares as 5). Anything else - missing, null, fractional,
 * exponent form, too large - compares as 0, i.e. "older than any canonical
 * version". This is the rule the database uses, so a legacy row can still be
 * ordered and retired, and a lower version can never supersede a higher one.
 */
export const legacyVersionValue = (value: unknown): number => {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= MAX_CANONICAL_DOCUMENT_VERSION ? value : 0;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!LEGACY_VERSION_RE.test(text)) return 0;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
};

/** The document status vocabulary this codebase writes. */
export const DOCUMENT_STATUSES = ['VALID', 'SUPERSEDED', 'VOID'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Document types that may be issued. */
export const ISSUABLE_DOCUMENT_TYPES = [
  'printing_contract_schedule',
  'printing_contract_completion_receipt',
] as const;

/**
 * Allowed lifecycle transitions.
 *
 * `VALID → SUPERSEDED` is the only transition the application performs today
 * (a new version replaces the previous one). `VALID → VOID` is DELIBERATELY
 * NOT allowed: no code path writes VOID for a contract document, and inventing
 * the semantics (what a void means for an already-printed document, its QR and
 * its hash) is a business decision, not an implementation detail. The same
 * applies to tombstones (`deleted`) — see `validateDocumentUpdate`.
 *
 * `X → X` is allowed so a re-sent (retried) write is a no-op rather than a
 * violation; without it every retried supersede would be rejected.
 */
export const ALLOWED_STATUS_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  VALID: ['VALID', 'SUPERSEDED'],
  SUPERSEDED: ['SUPERSEDED'],
  VOID: ['VOID'],
};

/** Statuses a NEW document may be created with. */
export const INSERTABLE_STATUSES: readonly DocumentStatus[] = ['VALID', 'SUPERSEDED'];

/**
 * Fields that may never change on an issued document.
 *
 * - identity      : id (row identity), contract_id, documentType, documentVersion,
 *                   documentNumber
 * - content/hash  : content, contentHash, hashVersion (the hash RULE, not just
 *                   the digest — changing it would change how a document is
 *                   verified)
 * - token         : verificationToken (the QR's subject)
 * - issuance audit: issuedAt, issuedBy, contractVersion
 * - ownership     : company_id, customer_id
 * - receipt money : assessmentItemId, walletTransactionId, ledgerEntryId
 *
 * `status` and `supersededBy` are NOT frozen: they carry the lifecycle and are
 * validated by the transition rules instead.
 */
export const FROZEN_DOCUMENT_FIELDS = [
  'id',
  'contract_id',
  'company_id',
  'customer_id',
  'documentType',
  'documentNumber',
  'documentVersion',
  'content',
  'contentHash',
  'hashVersion',
  'verificationToken',
  'assessmentItemId',
  'walletTransactionId',
  'ledgerEntryId',
  'issuedAt',
  'issuedBy',
  'contractVersion',
] as const;

export type FrozenDocumentField = (typeof FROZEN_DOCUMENT_FIELDS)[number];

export interface DocumentGuardViolation {
  rule: string;
  field?: string;
  detail: string;
}

export interface DocumentGuardResult {
  ok: boolean;
  violations: DocumentGuardViolation[];
}

const ok = (): DocumentGuardResult => ({ ok: true, violations: [] });
const fail = (rule: string, detail: string, field?: string): DocumentGuardResult => ({
  ok: false,
  violations: [{ rule, field, detail }],
});

/**
 * True only for a canonical document version: a positive integer with no
 * leading zeros. Numbers and their canonical string form are both accepted;
 * `'01'`, `'1.0'`, `0`, `-1`, `1.5` and `'1e3'` are not.
 */
export const isCanonicalDocumentVersion = (value: unknown): boolean => {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && CANONICAL_DOCUMENT_VERSION_RE.test(String(value));
  }
  // A JSON STRING is never canonical, even when it reads like a number
  // ("1", "01"): the database requires jsonb_typeof(...) = 'number'
  // (migration 0052), so a string version is a LEGACY version everywhere -
  // in the app layers as well. It is compared by its numeric value (R2) and
  // it is excluded from the identity index.
  return false;
};

/** True when `from → to` is a permitted lifecycle transition. */
export const isAllowedStatusTransition = (from: unknown, to: unknown): boolean => {
  const f = String(from || '').toUpperCase() as DocumentStatus;
  const t = String(to || '').toUpperCase() as DocumentStatus;
  if (!(f in ALLOWED_STATUS_TRANSITIONS)) return false;
  if (!(t in ALLOWED_STATUS_TRANSITIONS)) return false;
  return ALLOWED_STATUS_TRANSITIONS[f].includes(t);
};

const readField = (doc: Record<string, any> | null | undefined, field: string): unknown => {
  if (!doc) return undefined;
  if (field in doc) return doc[field];
  const nested = (doc as any).data;
  if (nested && typeof nested === 'object' && field in nested) return nested[field];
  return undefined;
};

/** The row identity duplicated inside the document payload. */
const nestedId = (doc: Record<string, any> | null | undefined): unknown => {
  if (!doc) return undefined;
  const nested = (doc as any).data;
  if (!nested || typeof nested !== 'object') return undefined;
  return (nested as any).id;
};

const sameValue = (a: unknown, b: unknown): boolean => {  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a === 'object' || typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return String(a) === String(b);
};

/**
 * The frozen fields that differ between two revisions of a document.
 * `data.id` is compared as well: the payload duplicates the row's primary key
 * and must not drift away from it.
 */
export const diffFrozenDocumentFields = (
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
): string[] => {
  const changed: string[] = [];
  for (const field of FROZEN_DOCUMENT_FIELDS) {
    if (!sameValue(readField(before, field), readField(after, field))) changed.push(field);
  }
  // The payload duplicates the row's primary key. The top-level `id` is
  // compared above; the DUPLICATED copy inside `data` is compared here, so a
  // payload that drifts away from its row is caught.
  const nestedBefore = nestedId(before);
  const nestedAfter = nestedId(after);
  if (!sameValue(nestedBefore, nestedAfter) && !changed.includes('id')) changed.push('id');
  return changed;
};

/**
 * Validate a document UPDATE against the same rules the database enforces.
 *
 * `resolveSupersededBy` lets the caller supply the referenced row when it is
 * known (the server checks the same thing in the database); the client uses it
 * to refuse a supersede that points nowhere.
 */
export function validateDocumentUpdate(
  before: Record<string, any> | null | undefined,
  after: Record<string, any> | null | undefined,
  opts: {
    /** The document the `supersededBy` link points at, when known locally. */
    supersededByTarget?: Record<string, any> | null;
  } = {},
): DocumentGuardResult {
  if (!before) return fail('missing_before', 'A document update requires the previous revision.');
  if (!after) return fail('missing_after', 'A document update requires the new revision.');

  const changed = diffFrozenDocumentFields(before, after);
  if (changed.length) {
    return {
      ok: false,
      violations: [{
        rule: 'frozen_field_changed',
        field: changed[0],
        detail: `Issued document fields are immutable: ${changed.join(', ')} cannot change after issue.`,
      }],
    };
  }

  const from = String(before.status || '').toUpperCase();
  const to = String(after.status || '').toUpperCase();
  if (!isAllowedStatusTransition(from, to)) {
    return {
      ok: false,
      violations: [{
        rule: 'status_transition_forbidden',
        field: 'status',
        detail: `Illegal document status transition ${from || '(none)'} → ${to || '(none)'}. A superseded document must never return to VALID.`,
      }],
    };
  }

  const beforeLink = readField(before, 'supersededBy');
  const afterLink = readField(after, 'supersededBy');
  if (to === 'SUPERSEDED') {
    if (!afterLink || !String(afterLink).trim()) {
      return fail('superseded_by_missing', 'A SUPERSEDED document must record the version that replaced it.', 'supersededBy');
    }
    if (String(afterLink) === String(readField(after, 'id'))) {
      return fail('superseded_by_self', 'A document cannot be superseded by itself.', 'supersededBy');
    }
    const target = opts.supersededByTarget;
    if (target) {
      if (String(target.contract_id || '') !== String(readField(after, 'contract_id') || '')) {
        return fail('superseded_by_foreign_contract', 'The superseding document belongs to a different contract.', 'supersededBy');
      }
      if (String(target.documentType || '') !== String(readField(after, 'documentType') || '')) {
        return fail('superseded_by_foreign_type', 'The superseding document has a different document type.', 'supersededBy');
      }
      // A canonical row may only be superseded by a STRICTLY newer version; a
      // LEGACY row (a version that is not canonical) may be superseded by a
      // version that is not older than it — the canonical 1 legitimately
      // replaces the legacy '01'. A lower version can never supersede a
      // higher one (mirrors the database rule).
      const oldVersion = readField(after, 'documentVersion');
      const targetVersion = legacyVersionValue(target.documentVersion);
      const oldIsCanonical = isCanonicalDocumentVersion(oldVersion);
      const allowed = oldIsCanonical
        ? targetVersion > legacyVersionValue(oldVersion)
        : targetVersion >= legacyVersionValue(oldVersion);
      if (!allowed) {
        return fail('superseded_by_not_newer', 'The superseding document must have a greater version.', 'supersededBy');
      }
    }
  } else if (!sameValue(beforeLink, afterLink)) {
    return fail('superseded_by_unexpected', 'Only a SUPERSEDED document carries a supersededBy link.', 'supersededBy');
  }

  // Tombstoning an issued document is not supported: the physical row is the
  // evidence. UNRESOLVED business decision — see the migration header.
  const deletedBefore = readField(before, 'deleted');
  const deletedAfter = readField(after, 'deleted');
  const deletedAtBefore = readField(before, 'deletedAt');
  const deletedAtAfter = readField(after, 'deletedAt');
  if (!sameValue(deletedBefore, deletedAfter) || !sameValue(deletedAtBefore, deletedAtAfter)) {
    return fail('tombstone_forbidden', 'An issued document must not be tombstoned; it is the customer\'s evidence.', 'deleted');
  }

  return ok();
}

/** Validate a document INSERT against the same rules the database enforces. */
export function validateDocumentInsert(doc: Record<string, any> | null | undefined): DocumentGuardResult {
  if (!doc) return fail('missing_document', 'A document insert requires the document.');
  const id = String(doc.id || '').trim();
  if (!id) return fail('id_missing', 'A document requires a row id.', 'id');
  const nestedId = doc.data && typeof doc.data === 'object' ? String((doc.data as any).id || '') : '';
  if (nestedId && nestedId !== id) {
    return fail('id_mismatch', 'The payload id must match the row id.', 'id');
  }
  if (!String(doc.contract_id || '').trim()) {
    return fail('contract_id_missing', 'A document requires the stable contract id.', 'contract_id');
  }
  if (!ISSUABLE_DOCUMENT_TYPES.includes(String(doc.documentType) as any)) {
    return fail('document_type_unknown', `Unknown document type '${String(doc.documentType)}'.`, 'documentType');
  }
  if (!isCanonicalDocumentVersion(doc.documentVersion)) {
    return fail(
      'document_version_not_canonical',
      `Document version '${String(doc.documentVersion)}' is not a canonical positive integer.`,
      'documentVersion',
    );
  }
  const status = String(doc.status || '').toUpperCase();
  if (!INSERTABLE_STATUSES.includes(status as DocumentStatus)) {
    return fail('status_not_insertable', `A document cannot be created with status '${status}'.`, 'status');
  }
  return ok();
}

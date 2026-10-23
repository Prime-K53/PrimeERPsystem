/**
 * contractDocumentGuard.cjs — pre-write validation for issued contract
 * documents (`contract_documents`).
 *
 * WHY THIS EXISTS
 *   The database owns these rules (migrations 0052 / 0053), but a deterministic
 *   rejection from the database arrives as HTTP 409 — the same status the
 *   client uses for a lost optimistic-concurrency race. Classified as
 *   retryable, such a write is re-sent forever and never converges.
 *
 *   This guard turns the known deterministic cases into a clean, NON-retryable
 *   rejection BEFORE the write, so the reason is visible and the operation is
 *   dead-lettered instead of looping.
 *
 * THE RULES MIRRORED HERE
 *   - a schedule's identity is (contract_id, documentType, documentVersion)
 *     — enforced by uq_contract_documents_schedule_identity (0052);
 *   - a receipt's identity is its assessment item
 *     — enforced by uq_contract_documents_receipt_item (0049);
 *   - a supersede must point at an existing, different row of the same
 *     contract and document type with a GREATER version
 *     — enforced by enforce_contract_document_immutability() (0052).
 *
 * CONTRACT
 *   A failed probe NEVER blocks the write: the database remains authoritative
 *   and the probe is an early, readable diagnosis. The cloud access is
 *   injected (`deps`) so the guard is testable without network or credentials.
 */

/** True when a version is canonical (R1): a JSON number, 1 .. 999999999. */
function isCanonicalVersion(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= 999999999;
  }
  // A JSON STRING is never canonical, even when it reads like a number
  // ("1", "01"): the database requires jsonb_typeof(...) = 'number'
  // (migration 0052), so a string version is a LEGACY version everywhere - in
  // the app layers as well. It is compared by its numeric value (R2) and it is
  // excluded from the identity index.
  return false;
}

/**
 * The value an EXISTING version compares as (the database's R2 rule).
 *
 * A version whose text form is an integer keeps that value (leading zeros
 * allowed: '05' compares as 5). Anything else - missing, null, fractional,
 * exponent form, too large - compares as 0, i.e. "older than any canonical
 * version". The same rule is applied by
 * `supabase/migrations/0052_contract_document_identity.sql` and
 * `frontend/services/contractDocumentGuard.ts`.
 */
function legacyVersionValue(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= 999999999 ? value : 0;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[0-9]{1,9}$/.test(text)) return 0;
    const parsed = Number(text);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

/**
 * @param {object} op  the sync operation ({ operation, payload, recordId })
 * @param {object} deps  { findRowsByDataField(table, field, value), findRowById(table, id) }
 * @returns {Promise<string|null>} a rejection reason, or null when the op is fine
 */
async function validateContractDocumentOp(op, deps) {
  if (!op || op.operation === 'delete') return null;
  const payload = op.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const documentType = String(payload.documentType || '').trim();
  if (!documentType) return null;
  if (!deps || typeof deps.findRowsByDataField !== 'function') return null;

  const selfId = String(op.recordId || payload.id || '');
  const contractId = String(payload.contract_id || '').trim();

  try {
    // ── identity ────────────────────────────────────────────────────────────
    if (documentType === 'printing_contract_schedule' && contractId) {
      // The identity index (migration 0052) covers ONLY rows whose version is a
      // CANONICAL JSON number. A row with a legacy/non-canonical version is not
      // indexed and therefore cannot clash - the probe must not refuse a write
      // the database would accept.
      const version = Number(payload.documentVersion);
      if (isCanonicalVersion(payload.documentVersion)) {
        const rows = await deps.findRowsByDataField('contract_documents', 'contract_id', contractId);
        const clash = (rows || []).find((row) => {
          if (String(row.id) === selfId) return false;
          const data = (row && row.data && typeof row.data === 'object') ? row.data : {};
          if (data.deleted === true || data.deletedAt) return false;
          if (String(data.documentType || '') !== documentType) return false;
          if (!isCanonicalVersion(data.documentVersion)) return false;   // not indexed -> not a clash
          return Number(data.documentVersion) === version;
        });
        if (clash) {
          return 'contract document version ' + version + ' already exists for contract ' + contractId + ' (row ' + clash.id + ')';
        }
      }
    }

    if (documentType === 'printing_contract_completion_receipt') {
      const itemId = String(payload.assessmentItemId || '').trim();
      if (itemId && typeof deps.findRowsByDataField === 'function') {
        const rows = await deps.findRowsByDataField('contract_documents', 'assessmentItemId', itemId);
        const clash = (rows || []).find((row) => {
          if (String(row.id) === selfId) return false;
          const data = (row && row.data && typeof row.data === 'object') ? row.data : {};
          if (data.deleted === true || data.deletedAt) return false;
          return String(data.documentType || '') === documentType;
        });
        if (clash) {
          return 'a completion receipt already exists for assessment ' + itemId + ' (row ' + clash.id + ')';
        }
      }
    }

    // ── supersede link ──────────────────────────────────────────────────────
    const supersededBy = String(payload.supersededBy || '').trim();
    if (supersededBy) {
      if (supersededBy === selfId) {
        return 'a contract document cannot supersede itself';
      }
      if (typeof deps.findRowById !== 'function') return null;
      const target = await deps.findRowById('contract_documents', supersededBy);
      if (!target) {
        return 'the superseding document ' + supersededBy + ' has not been published yet';
      }
      const targetData = (target && target.data && typeof target.data === 'object') ? target.data : {};
      if (String(targetData.contract_id || '') !== contractId) {
        return 'the superseding document ' + supersededBy + ' belongs to a different contract';
      }
      if (String(targetData.documentType || '') !== documentType) {
        return 'the superseding document ' + supersededBy + ' has a different document type';
      }
      // A canonical row may only be superseded by a STRICTLY newer version; a
      // LEGACY row (a version that is not canonical) may be superseded by a
      // version that is not older than it. A lower version can never supersede
      // a higher one (mirrors the database rule in migration 0052).
      const oldIsCanonical = isCanonicalVersion(payload.documentVersion);
      const targetVersion = legacyVersionValue(targetData.documentVersion);
      const oldVersion = legacyVersionValue(payload.documentVersion);
      const allowed = oldIsCanonical ? targetVersion > oldVersion : targetVersion >= oldVersion;
      if (!allowed) {
        return 'the superseding document ' + supersededBy + ' must have a greater version';
      }
    }
  } catch (err) {
    // The unique index and the trigger remain authoritative; a failed probe
    // must never block a legitimate write.
    console.warn('[contractDocumentGuard] probe failed:', err?.message || err);
  }
  return null;
}

module.exports = { validateContractDocumentOp, legacyVersionValue, isCanonicalVersion };

/**
 * documentIntegrity.cjs — server-side canonical hashing for issued documents.
 *
 * MIRRORS the frontend issue-side algorithm in
 * `frontend/services/printingContractService.ts` exactly, so a document can be
 * recomputed and checked on the server before it is verified or downloaded.
 * This is a plain SHA-256 content digest (tamper-EVIDENCE), NOT a digital
 * signature: possession of the verification token establishes which issued
 * record is being referenced; the digest establishes that the frozen content
 * has not changed since issue.
 *
 * Two rules exist because the issue-side algorithm changed:
 *   - hash rule 2 (stable envelope): material content only. The issue date and
 *     the random per-version verification token are EXCLUDED, so unchanged
 *     canonical content hashes identically across renders.
 *   - hash rule 1 (legacy): the WHOLE document as the pre-Phase-2 builders saw
 *     it. `stableStringify` serialised every absent optional as `null`, but
 *     JSONB persisted the row with those keys DROPPED — so the reconstruction
 *     restores exactly the builders' optional keys as `null` before hashing.
 *     Deleting `contentHash` alone reproduces neither historical document.
 *
 * READ-ONLY and pure. No network, no writes.
 */
const crypto = require('crypto');

/** Deterministic JSON: sorted keys, recursive — the issue-side hash input. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function sha256(canonicalJson) {
  return crypto.createHash('sha256').update(String(canonicalJson), 'utf8').digest('hex');
}

/**
 * Volatile metadata excluded by hash rule 2 (must match the frontend).
 *
 * `documentId` / `documentVersion` are the issued version's own identity. They
 * are allocated after the content is hashed and injected into the stored
 * content afterwards, so they are excluded here: the digest must still cover
 * exactly the agreed content, and both sides must exclude the same keys.
 */
const SCHEDULE_VOLATILE_HASH_KEYS = [
  'contentHash', 'date', 'verificationToken', 'securityQrPayload', 'securityQrCodeDataUrl',
  'documentId', 'documentVersion',
];

const LEGACY_SCHEDULE_OPTIONAL_HASH_KEYS = [
  'verificationToken', 'schoolName', 'schoolZone', 'customerPhone', 'academicYear',
  'periodStart', 'periodEnd', 'totalCandidature', 'assessmentSpec',
  'chargePerCandidate', 'assessmentSittings', 'terms', 'notes',
];
const LEGACY_SCHEDULE_ROW_OPTIONAL_HASH_KEYS = ['grade', 'subject', 'assessmentDate'];
const LEGACY_RECEIPT_OPTIONAL_HASH_KEYS = ['verificationToken', 'schoolName', 'notes'];
const LEGACY_RECEIPT_ITEM_OPTIONAL_HASH_KEYS = ['grade', 'subject', 'consumedAt'];

function restoreNullKeys(obj, keys) {
  const out = { ...obj };
  for (const key of keys) if (!(key in out)) out[key] = null;
  return out;
}

function stableScheduleHashInput(doc) {
  const out = { ...doc };
  for (const key of SCHEDULE_VOLATILE_HASH_KEYS) delete out[key];
  return out;
}

function legacyScheduleHashInput(content) {
  const out = restoreNullKeys(content, LEGACY_SCHEDULE_OPTIONAL_HASH_KEYS);
  delete out.contentHash;
  if (Array.isArray(out.schedule)) {
    out.schedule = out.schedule.map((row) =>
      row && typeof row === 'object'
        ? restoreNullKeys(row, LEGACY_SCHEDULE_ROW_OPTIONAL_HASH_KEYS)
        : row);
  }
  return out;
}

function legacyReceiptHashInput(content) {
  const out = restoreNullKeys(content, LEGACY_RECEIPT_OPTIONAL_HASH_KEYS);
  delete out.contentHash;
  if (out.item && typeof out.item === 'object') {
    out.item = restoreNullKeys(out.item, LEGACY_RECEIPT_ITEM_OPTIONAL_HASH_KEYS);
  }
  return out;
}

function hashScheduleV2(content) {
  return sha256(stableStringify(stableScheduleHashInput(content)));
}

/**
 * The v2 digest of a schedule whose content also carries the issued
 * version's identity (`documentId` / `documentVersion`).
 *
 * The identity is injected into the content AFTER it is hashed (the version
 * number is allocated once the digest is known), so it is volatile metadata
 * and MUST be excluded from the digest. A client that ships that injection
 * before the server knows about it produces a row whose digest excludes the
 * identity — so the server accepts EITHER shape. Both are digests of the SAME
 * content under a fixed rule, so this does not weaken tamper detection: the
 * content still has to hash to one of them exactly.
 */
function hashScheduleV2WithoutIdentity(content) {
  const out = { ...stableScheduleHashInput(content) };
  delete out.documentId;
  delete out.documentVersion;
  return sha256(stableStringify(out));
}

function hashScheduleContent(content, hashVersion) {
  return Number(hashVersion) >= 2
    ? hashScheduleV2(content)
    : sha256(stableStringify(legacyScheduleHashInput(content)));
}

function hashReceiptContent(content) {
  return sha256(stableStringify(legacyReceiptHashInput(content)));
}

const isHex64 = (v) => /^[0-9a-f]{64}$/.test(String(v || ''));

/**
 * Verify one persisted schedule VERSION row.
 * Returns { ok, reason, rule, stored, recomputed } — never throws.
 */
function verifyScheduleRow(row) {
  const content = (row && row.content) || null;
  if (!content || typeof content !== 'object') return { ok: false, reason: 'no_content' };
  const stored = String(row.contentHash || content.contentHash || '');
  if (!isHex64(stored)) return { ok: false, reason: 'stored_hash_not_sha256' };
  // The row-level digest and the frozen content's digest must agree.
  if (content.contentHash && String(content.contentHash) !== stored) {
    return { ok: false, reason: 'content_hash_mismatch', stored, recomputed: String(content.contentHash) };
  }
  const rule = Number(row.hashVersion ?? content.hashVersion) >= 2 ? 'v2' : 'legacy';
  let recomputed;
  try {
    recomputed = hashScheduleContent(content, row.hashVersion ?? content.hashVersion);
  } catch (e) {
    return { ok: false, reason: 'hash_error', rule, stored, error: String((e && e.message) || e) };
  }
  if (recomputed !== stored) {
    // The v2 rule with the issued identity excluded from the digest: a client
    // that injects `documentId`/`documentVersion` into the content (and
    // excludes them from the digest) is a valid issuer, and the server must
    // not fail a row that a newer client legitimately wrote. Both digests
    // cover the same content, so accepting either keeps the check exact.
    if (rule === 'v2') {
      let alt;
      try {
        alt = hashScheduleV2WithoutIdentity(content);
      } catch (e) {
        return { ok: false, reason: 'hash_error', rule, stored, error: String((e && e.message) || e) };
      }
      if (alt === stored) return { ok: true, reason: 'verified', rule: 'v2', stored, recomputed: alt };
    }
    return { ok: false, reason: 'integrity_failed', rule, stored, recomputed };
  }
  return { ok: true, reason: 'verified', rule, stored, recomputed };
}

/** Verify one persisted completion-receipt row (always legacy rule). */
function verifyReceiptRow(row) {
  const content = (row && row.content) || null;
  if (!content || typeof content !== 'object') return { ok: false, reason: 'no_content' };
  const stored = String(row.contentHash || content.contentHash || '');
  if (!isHex64(stored)) return { ok: false, reason: 'stored_hash_not_sha256' };
  if (content.contentHash && String(content.contentHash) !== stored) {
    return { ok: false, reason: 'content_hash_mismatch', stored, recomputed: String(content.contentHash) };
  }
  let recomputed;
  try {
    recomputed = hashReceiptContent(content);
  } catch (e) {
    return { ok: false, reason: 'hash_error', rule: 'legacy', stored, error: String((e && e.message) || e) };
  }
  if (recomputed !== stored) return { ok: false, reason: 'integrity_failed', rule: 'legacy', stored, recomputed };
  return { ok: true, reason: 'verified', rule: 'legacy', stored, recomputed };
}

module.exports = {
  stableStringify,
  sha256,
  SCHEDULE_VOLATILE_HASH_KEYS,
  stableScheduleHashInput,
  legacyScheduleHashInput,
  legacyReceiptHashInput,
  hashScheduleV2,
  hashScheduleContent,
  hashReceiptContent,
  verifyScheduleRow,
  verifyReceiptRow,
};

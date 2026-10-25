/**
 * contractVerificationService.cjs — PUBLIC printing-contract verification.
 *
 *   GET /api/public/documents/contract-verify?c=<number-or-short-code>&h=<sha256>
 *
 * Unlike the generic token registry, a printing contract is verified by its
 * CANONICAL CONTENT HASH: the server recomputes the digest from the stored
 * `assessment_contracts` record and compares it constant-time with the full
 * digest encoded in the QR. An edit to any material field (party, amount,
 * term, date, status, signature) therefore fails verification.
 *
 * The short code (`4612-f2e1-2ecc`, first 12 hex chars) is a MANUAL lookup
 * convenience only. It is never encoded in the QR and is never proof on its
 * own: a short-code lookup still recomputes and checks the full digest against
 * the stored hash, and reports `altered` when they disagree.
 *
 * READ-ONLY. No writes, no tokens, no sensitive fields on a mismatch.
 */
const axios = require('axios');
const integrity = require('./documentIntegrity.cjs');
const customerDisplay = require('./customerDisplay.cjs');

const GENERIC_NOT_FOUND = 'No contract matches that number, short code or hash.';
const GENERIC_ALTERED = 'The contract record does not match the supplied digest.';
const SHORT_CODE_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i;

function getConfig() {
  return {
    base: String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, ''),
    key: process.env.SUPABASE_SECRET_KEY || '',
    company: String(process.env.COMPANY_NAME || 'Prime Printing Service'),
  };
}

function sanitizeLookup(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) return '';
  // Contract numbers, URL-safe forms and short codes only. Reject PostgREST
  // grammar characters so the value can never escape its quoted literal.
  if (!/^[A-Za-z0-9][A-Za-z0-9/_-]*$/.test(text)) return '';
  return text;
}

/** `PC-P726-023` → [`PC-P726-023`, `PC-P726/023`]. */
function lookupVariants(value) {
  const variants = [value];
  if (value.includes('-')) {
    const last = value.lastIndexOf('-');
    variants.push(`${value.slice(0, last)}/${value.slice(last + 1)}`);
  }
  return Array.from(new Set(variants));
}

function rowRecord(row) {
  const data = row && row.data && typeof row.data === 'object' ? row.data : null;
  return data ? { ...data } : { ...(row || {}) };
}

function recordShortCode(record) {
  const stored = String((record && record.integrityShortCode) || '').trim().toLowerCase();
  if (SHORT_CODE_RE.test(stored)) return stored;
  return integrity.contractShortCode(String((record && record.contentHash) || ''));
}

function statusLabel(record) {
  const raw = String((record && record.status) || '').toLowerCase().trim();
  if (!raw) return 'DRAFT';
  if (['cancelled', 'canceled'].includes(raw)) return 'CANCELLED';
  if (['voided', 'void'].includes(raw)) return 'VOID';
  return raw.toUpperCase();
}

/** Only safe display fields — never tokens, ids, signatures, addresses. */
function safeContract(record) {
  // The stored party label may be a placeholder (`_`, `—`, a bare `CUST-…`
  // key) — a missing reference, never safe to echo as the client name. Resolve
  // the real name from the record (customer, then school) and only then fall
  // back to a generic label; the display must never leak the customer id.
  const customerName = customerDisplay.resolveContractPartyName(record) || 'Customer';
  return {
    verified: true,
    result: 'verified',
    documentType: 'printing_contract',
    contractNumber: String(record.contract_number || record.contractNumber || '').trim(),
    customerName,
    contractDate: String(record.starts_at || record.created_at || record.createdAt || '').slice(0, 10),
    status: statusLabel(record),
    total: Number(record.prepaid_amount ?? record.prepaidAmount ?? 0) || 0,
    currency: String(record.currency || 'MWK'),
    companyName: getConfig().company,
  };
}

async function fetchByNumber(base, key, get, value, timeout) {
  const quoted = value.replace(/"/g, '""');
  const { data } = await get(`${base}/rest/v1/assessment_contracts`, {
    params: {
      select: '*',
      or: `(data->>contract_number.eq."${quoted}",data->>contractNumber.eq."${quoted}")`,
      limit: 5,
    },
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    timeout,
  });
  return Array.isArray(data) ? data : [];
}

/** Short-code lookup is a bounded scan: a 12-hex prefix is not indexed. */
async function fetchRecent(base, key, get, timeout) {
  const { data } = await get(`${base}/rest/v1/assessment_contracts`, {
    params: { select: 'id,data', limit: 2000, order: 'updated_at.desc' },
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    timeout,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * Verify a contract by number (URL-safe or native) and/or short code.
 *
 * @returns {Promise<{result:'verified'|'altered'|'not_found', contract?:object, reason?:string}>}
 */
async function verifyContract({ contractNumber, hash, shortCode, httpGet } = {}) {
  const { base, key } = getConfig();
  if (!base || !key) {
    const err = new Error('verification store unavailable');
    err.code = 'STORE_UNAVAILABLE';
    throw err;
  }
  const get = httpGet || axios;
  const timeout = 15000;
  const lookup = sanitizeLookup(contractNumber || shortCode);
  const suppliedHash = String(hash || '').trim().toLowerCase();
  if (!lookup) return { result: 'not_found', reason: 'invalid_lookup' };

  let rows = [];
  const isShortCode = SHORT_CODE_RE.test(lookup);
  // A contract number alone is not a verification: the QR always carries the
  // full digest, and the manual form asks for the printed short code. Do not
  // report a number-only hand-crafted URL as "altered" — it is simply not a
  // supported lookup, and no contract data may be revealed by enumeration.
  if (!isShortCode && !/^[0-9a-f]{64}$/.test(suppliedHash)) {
    return { result: 'not_found', reason: 'hash_required' };
  }
  if (isShortCode) {
    rows = await fetchRecent(base, key, get, timeout);
  } else {
    for (const variant of lookupVariants(lookup)) {
      rows = await fetchByNumber(base, key, get, variant, timeout);
      if (rows.length) break;
    }
  }
  if (!rows.length) return { result: 'not_found', reason: 'no_match' };

  // A short code may resolve to more than one historical row; only an
  // unambiguous, internally consistent match may verify.
  const candidates = [];
  for (const row of rows) {
    const record = rowRecord(row);
    if (!record || !String(record.contract_number || record.contractNumber || '').trim()) continue;
    const recomputed = integrity.hashContractRecord(record);
    const stored = String(record.contentHash || '').trim().toLowerCase();
    const rowShortCode = recordShortCode(record);
    const shortCodeMatches = isShortCode ? rowShortCode === lookup.toLowerCase() : true;
    if (!shortCodeMatches) continue;
    if (isShortCode && !rowShortCode) continue;
    // A short-code lookup never supplies `h`: validation is stored vs recomputed.
    const check = isShortCode
      ? {
        ok: Boolean(stored) && integrity.timingSafeEqualHex(stored, recomputed),
        reason: stored ? 'integrity_failed' : 'missing_stored_hash',
      }
      : integrity.verifyContractRecord(record, suppliedHash);
    candidates.push({ record, check, recomputed, stored });
  }
  if (!candidates.length) return { result: 'not_found', reason: 'no_match' };

  const verified = candidates.find((candidate) => candidate.check.ok);
  if (verified) return { result: 'verified', contract: safeContract(verified.record) };

  // A row was found but its content no longer matches its digest. Do not leak
  // which field changed (or any contract data) — the caller only learns that
  // the presented document is not authentic.
  return { result: 'altered', reason: candidates[0].check.reason || 'integrity_failed' };
}

module.exports = {
  verifyContract,
  safeContract,
  lookupVariants,
  sanitizeLookup,
  GENERIC_NOT_FOUND,
  GENERIC_ALTERED,
};

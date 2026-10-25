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

// ─── Printing contract: record-based canonical digest (v1) ─────────────────
//
// The printed contract hash is a digest of the STORED CONTRACT RECORD, never of
// the rendered PDF bytes. The browser issuer
// (`frontend/services/printingContractService.ts`) and this module must
// produce byte-identical canonical JSON. The shared fixture
// `tests/fixtures/contract-integrity-vector.json` locks them together.
//
// Material: parties, line items, amounts, terms, contract dates, version,
// status, recorded signature blocks.
// Volatile/excluded: print date, verification token, QR payload/bytes,
// contentHash and integrityShortCode themselves.

const CONTRACT_HASH_VERSION = 1;

const snapshotText = (value) => (value === undefined || value === null ? '' : String(value).trim());

const snapshotFirstText = (...values) => {
  for (const value of values) {
    const text = snapshotText(value);
    if (text) return text;
  }
  return undefined;
};

const snapshotNumber = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

const isLeap = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const daysInMonth = (year, month) => {
  if (month < 1 || month > 12) return 0;
  if (month === 2) return isLeap(year) ? 29 : 28;
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
};
const validYmd = (year, month, day) => Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)
  && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);

/** Mirrors frontend/utils/isoDate.ts `toIsoDateOnly` (pure, timezone-free). */
function toIsoDateOnly(value) {
  const raw = String(value === undefined || value === null ? '' : value).trim();
  if (!raw) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(raw);
  if (iso) {
    const [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    return validYmd(year, month, day)
      ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : undefined;
  }
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (dmy) {
    const [day, month, year] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])];
    return validYmd(year, month, day)
      ? `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : undefined;
  }
  return undefined;
}

/** Mirrors frontend `stripCustomerIdSuffix`. */
function stripCustomerIdSuffix(name) {
  let out = snapshotText(name);
  if (!out) return '';
  out = out.replace(/\s*\((?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}\)\s*$/i, '').trim();
  out = out.replace(/^CUST-\d{3,}\s*(?:[\r\n]+|[-–—:|]\s*|\s+)/i, '').trim();
  out = out.replace(/(?:[\r\n]+|[-–—:|]\s*|\s+)CUST-\d{3,}\s*$/i, '').trim();
  if (/^CUST-\d{3,}$/i.test(out)) return '';
  return out.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeCustomerReference(value) {
  const reference = snapshotText(value);
  if (!reference) return undefined;
  if (/^CUST[-\s]?\d{3,}$/i.test(reference)) return reference.toUpperCase().replace(/\s+/g, '-');
  if (/^[A-Z]{2,5}-\d{3,}$/i.test(reference)) return reference;
  return undefined;
}

function readContractProfile(data) {
  const d = data && typeof data === 'object' ? data : {};
  const nested = d.contract_profile && typeof d.contract_profile === 'object' ? d.contract_profile : {};
  const printSpec = nested.print_spec || d.print_spec || {};
  const pricing = nested.pricing_rules || d.pricing_rules || {};
  const delivery = nested.delivery_terms || d.delivery_terms || {};
  const cand = nested.candidature || d.candidature || {};
  return {
    printSpec: {
      paperSize: snapshotText(printSpec.paper_size ?? printSpec.paperSize ?? ''),
      paperType: snapshotText(printSpec.paper_type ?? printSpec.paperType ?? ''),
      paperWeight: snapshotText(printSpec.paper_weight ?? printSpec.paperWeight ?? ''),
      colorMode: snapshotText(printSpec.color_mode ?? printSpec.colorMode ?? ''),
      sides: snapshotText(printSpec.sides ?? ''),
      pagesPerCopy: snapshotText(printSpec.pages_per_copy ?? printSpec.pagesPerCopy ?? ''),
      copies: snapshotText(printSpec.copies ?? ''),
      orientation: snapshotText(printSpec.orientation ?? ''),
      finishing: snapshotText(printSpec.finishing ?? ''),
      packaging: snapshotText(printSpec.packaging ?? ''),
    },
    pricingRules: {
      model: snapshotText(pricing.model ?? pricing.pricing_model ?? ''),
      chargePerCandidate: snapshotNumber(
        pricing.charge_per_candidate ?? pricing.chargePerCandidate ?? d.charge_per_candidate,
      ),
      discount: snapshotText(pricing.discount ?? ''),
      urgentFee: snapshotText(pricing.urgent_fee ?? pricing.urgentFee ?? ''),
      taxHandling: snapshotText(pricing.tax_handling ?? pricing.taxHandling ?? ''),
      rulesNotes: snapshotText(pricing.notes ?? pricing.rules_notes ?? ''),
    },
    delivery: {
      method: snapshotText(delivery.method ?? delivery.delivery_method ?? ''),
      timeline: snapshotText(delivery.timeline ?? delivery.delivery_timeline ?? ''),
      address: snapshotText(delivery.address ?? delivery.delivery_address ?? ''),
      packaging: snapshotText(delivery.packaging ?? ''),
      deliveryNotes: snapshotText(delivery.notes ?? delivery.delivery_notes ?? ''),
    },
    candidature: {
      totalCandidature: snapshotNumber(cand.total ?? cand.total_candidature ?? d.total_candidature),
      sittings: snapshotText(cand.sittings ?? cand.assessment_sittings ?? d.assessment_sittings ?? ''),
      spec: snapshotText(cand.spec ?? cand.assessment_spec ?? d.assessment_spec ?? d.assessmentSpec ?? ''),
    },
  };
}

function formatPaperWeight(value) {
  const weight = snapshotText(value);
  if (!weight) return '';
  const numeric = weight.match(/^([\d.]+)\s*(?:gsm|g\/m2|g\/m²)?$/i);
  return numeric ? `${numeric[1]}gsm` : weight;
}

function formatPagesPerCopy(value) {
  const pages = snapshotText(value);
  if (!pages) return '';
  return /page/i.test(pages) ? pages : `${pages} pages`;
}

function normalizeColorMode(value) {
  const modeText = snapshotText(value);
  if (!modeText) return '';
  if (/^(b\s*&\s*w|bw|mono(?:chrome)?|black\s*(?:and|&)\s*white)$/i.test(modeText)) return 'Black & white';
  if (/^colou?r$/i.test(modeText)) return 'Colour';
  return modeText.charAt(0).toUpperCase() + modeText.slice(1);
}

function normalizeSides(value) {
  const sides = snapshotText(value);
  if (!sides) return '';
  if (/^(double|duplex)(?:[-\s]?sided)?$/i.test(sides)) return 'double-sided';
  if (/^(single|simplex)(?:[-\s]?sided)?$/i.test(sides)) return 'single-sided';
  return sides;
}

function mapContractLines(record) {
  const inner = record && record.data && typeof record.data === 'object' ? record.data : {};
  const raw = Array.isArray(inner.lines) ? inner.lines : [];
  const mapped = raw
    .filter((l) => l && snapshotText(l.assessment_name) !== '' && Math.floor(Number(l.quantity)) > 0)
    .map((l) => {
      const qty = Math.max(0, Math.floor(Number(l.quantity) || 0));
      const price = roundMoney(Math.max(0, Number(l.unit_price) || 0));
      const qualifiers = [l.assessment_grade, l.assessment_subject].filter(Boolean).join(' · ');
      return {
        desc: qualifiers ? `${snapshotText(l.assessment_name)} (${qualifiers})` : snapshotText(l.assessment_name),
        qty,
        price,
        total: roundMoney(qty * price),
      };
    });
  if (mapped.length > 0) return mapped;
  const qty = Math.max(1, Math.floor(Number(record.max_assessments ?? record.maxAssessments) || 0));
  const price = roundMoney(Math.max(0, Number(record.assessment_price ?? record.assessmentPrice) || 0));
  return [{
    desc: snapshotText(record.title) || 'Printing contract',
    qty,
    price,
    total: roundMoney(qty * price),
  }];
}

function snapshotSignature(block) {
  if (!block || typeof block !== 'object') return null;
  const name = snapshotText(block.name);
  const signatureDataUrl = snapshotText(block.signatureDataUrl);
  if (!name || !signatureDataUrl) return null;
  const rawSignedAt = snapshotText(block.signedAt);
  return {
    name,
    role: snapshotText(block.role),
    mode: block.mode === 'Upload' ? 'Upload' : 'Draw',
    signedAt: toIsoDateOnly(rawSignedAt) || rawSignedAt,
    signedBy: snapshotText(block.signedBy),
    signatureDataUrl,
  };
}

function contractPruneUndefined(value) {
  if (Array.isArray(value)) return value.map(contractPruneUndefined);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = contractPruneUndefined(entry);
    }
    return out;
  }
  return value;
}

/**
 * Canonical projection of an `assessment_contracts` record. MIRRORS
 * `buildContractIntegritySnapshot` in the frontend service exactly.
 */
function contractIntegritySnapshot(contract) {
  const record = contract && typeof contract === 'object' ? contract : {};
  const inner = record.data && typeof record.data === 'object' ? record.data : {};
  const profile = readContractProfile(inner);

  const schoolName = stripCustomerIdSuffix(
    snapshotFirstText(record.schoolName, record.school_name, inner.school_name),
  ) || undefined;
  const customerName = stripCustomerIdSuffix(
    snapshotFirstText(record.customerName, record.customer_name, inner.customer_name),
  ) || stripCustomerIdSuffix(schoolName) || 'Customer';

  const vatValue = snapshotNumber(
    inner.vat_amount ?? inner.vatAmount ?? record.vat_amount ?? record.vatAmount
      ?? record.tax_amount ?? record.taxAmount,
  );
  const signatures = inner.signatures && typeof inner.signatures === 'object' ? inner.signatures : {};
  const company = snapshotSignature(signatures.company);
  const customer = snapshotSignature(signatures.customer);

  const snapshot = {
    hashVersion: CONTRACT_HASH_VERSION,
    documentType: 'printing_contract',
    contractNumber: snapshotText(record.contract_number || record.contractNumber),
    version: Number(record.version) || 1,
    status: snapshotText(record.status || 'draft'),
    customerName,
    schoolName,
    customerContact: snapshotFirstText(record.customerContact, record.customer_contact, inner.customer_contact),
    customerPhone: snapshotFirstText(record.customerPhone, record.customer_phone, inner.customer_phone),
    customerAddress: snapshotFirstText(
      record.customerAddress,
      record.customer_address,
      record.billing_address,
      inner.customer_address,
    ),
    customerReference: normalizeCustomerReference(
      snapshotFirstText(record.customerReference, record.customer_reference, record.customer_id, inner.customer_reference),
    ),
    schoolZone: snapshotFirstText(record.schoolZone, record.school_zone, inner.school_zone, inner.schoolZone),
    periodStart: toIsoDateOnly(record.starts_at ?? record.periodStart ?? record.startsAt) || undefined,
    periodEnd: toIsoDateOnly(record.ends_at ?? record.periodEnd ?? record.endsAt) || undefined,
    lines: mapContractLines(record),
    prepaidAmount: roundMoney(Number(record.prepaid_amount ?? record.prepaidAmount) || 0),
    maxAssessments: Math.max(0, Math.floor(Number(record.max_assessments ?? record.maxAssessments) || 0)),
    assessmentPrice: roundMoney(Number(record.assessment_price ?? record.assessmentPrice) || 0),
    vatAmount: vatValue !== undefined && vatValue > 0 ? roundMoney(vatValue) : undefined,
    terms: snapshotText(record.terms) || undefined,
    notes: snapshotText(record.notes) || undefined,
    totalCandidature: profile.candidature.totalCandidature,
    assessmentSpec: profile.candidature.spec || undefined,
    chargePerCandidate: profile.pricingRules.chargePerCandidate,
    assessmentSittings: profile.candidature.sittings || undefined,
    printSpecSummary: (() => {
      const spec = profile.printSpec;
      const bits = [
        spec.paperSize,
        spec.paperType,
        spec.paperWeight ? (/gsm/i.test(spec.paperWeight) ? spec.paperWeight : `${spec.paperWeight}gsm`) : '',
        spec.colorMode,
        spec.sides,
        spec.pagesPerCopy ? `${spec.pagesPerCopy}pp` : '',
        spec.copies ? `×${spec.copies}` : '',
        spec.orientation,
      ].map((part) => snapshotText(part)).filter(Boolean);
      const head = bits.join(' · ');
      const tail = [spec.finishing, spec.packaging].map((part) => snapshotText(part)).filter(Boolean).join(' · ');
      if (head && tail) return `${head} — ${tail}`;
      return head || tail || undefined;
    })(),
    printPaperSummary: [
      profile.printSpec.paperSize,
      formatPaperWeight(profile.printSpec.paperWeight),
      formatPagesPerCopy(profile.printSpec.pagesPerCopy),
    ].filter((part) => snapshotText(part)).join(', ') || undefined,
    printColorSummary: [
      normalizeColorMode(profile.printSpec.colorMode),
      normalizeSides(profile.printSpec.sides),
    ].filter((part) => snapshotText(part)).join(', ') || undefined,
    printTypeSummary: [
      profile.printSpec.paperType,
      profile.printSpec.orientation,
    ].filter((part) => snapshotText(part)).join(' · ') || undefined,
    printFinishing: profile.printSpec.finishing || undefined,
    printPackaging: profile.printSpec.packaging || undefined,
    printOrientation: profile.printSpec.orientation || undefined,
    pricingRulesSummary: [
      profile.pricingRules.model ? String(profile.pricingRules.model).replace(/_/g, ' ') : '',
      profile.pricingRules.chargePerCandidate !== undefined
        ? `Charge per candidate: ${roundMoney(profile.pricingRules.chargePerCandidate)}`
        : '',
      profile.pricingRules.discount ? `Discount: ${profile.pricingRules.discount}` : '',
      profile.pricingRules.urgentFee ? `Urgent: ${profile.pricingRules.urgentFee}` : '',
      profile.pricingRules.taxHandling,
      profile.pricingRules.rulesNotes,
    ].filter((part) => snapshotText(part)).join(' · ') || undefined,
    deliveryTermsSummary: [
      profile.delivery.method,
      profile.delivery.timeline,
      profile.delivery.address,
      profile.delivery.packaging ? `Pack: ${profile.delivery.packaging}` : '',
      profile.delivery.deliveryNotes,
    ].filter((part) => snapshotText(part)).join(' · ') || undefined,
    deliveryMethod: profile.delivery.method || undefined,
    deliveryTimeline: profile.delivery.timeline || undefined,
    deliveryAddress: profile.delivery.address || undefined,
    deliveryNotes: profile.delivery.deliveryNotes || undefined,
    signatures: { company, customer },
    fullySigned: Boolean(company && customer),
    issuedInvoiceId: snapshotFirstText(inner.issued_invoice_id, inner.issuedInvoiceId, record.issuedInvoiceId),
  };
  return contractPruneUndefined(snapshot);
}

/** SHA-256 over the canonical contract snapshot (same bytes as the browser). */
function hashContractRecord(contract) {
  return sha256(stableStringify(contractIntegritySnapshot(contract)));
}

/** First 12 hex characters grouped 4-4-4 ("4612-f2e1-2ecc"). */
function contractShortCode(contentHash) {
  const hex = String(contentHash || '').toLowerCase().trim();
  if (!/^[0-9a-f]{12,}$/.test(hex)) return '';
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

/** Attach/refresh the persisted integrity fields on a contract record. */
function ensureContractIntegrity(contract) {
  const contentHash = hashContractRecord(contract);
  return { ...contract, contentHash, integrityShortCode: contractShortCode(contentHash) };
}

function timingSafeEqualHex(a, b) {
  const left = String(a || '').trim().toLowerCase();
  const right = String(b || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  } catch {
    return false;
  }
}

/**
 * Verify a contract record against a supplied full digest. The digest is
 * recomputed from the STORED record and compared constant-time; the persisted
 * `contentHash` must also agree with the recomputation, otherwise the record
 * is reported as altered even when the caller quotes the old digest.
 */
function verifyContractRecord(record, suppliedHash) {
  const stored = String((record && record.contentHash) || '').trim().toLowerCase();
  let recomputed;
  try {
    recomputed = hashContractRecord(record);
  } catch (e) {
    return { ok: false, reason: 'hash_error', error: String((e && e.message) || e) };
  }
  if (!isHex64(stored)) {
    return { ok: false, reason: stored ? 'stored_hash_not_sha256' : 'missing_stored_hash', stored, recomputed };
  }
  if (!timingSafeEqualHex(stored, recomputed)) {
    return { ok: false, reason: 'stored_hash_stale', stored, recomputed };
  }
  const supplied = String(suppliedHash || '').trim().toLowerCase();
  if (!supplied || !isHex64(supplied)) {
    return { ok: false, reason: 'supplied_hash_invalid', stored, recomputed };
  }
  if (!timingSafeEqualHex(supplied, recomputed)) {
    return { ok: false, reason: 'integrity_failed', stored, recomputed };
  }
  return { ok: true, reason: 'verified', stored, recomputed };
}

module.exports = {
  stableStringify,
  sha256,
  stripCustomerIdSuffix,
  SCHEDULE_VOLATILE_HASH_KEYS,
  stableScheduleHashInput,
  legacyScheduleHashInput,
  legacyReceiptHashInput,
  hashScheduleV2,
  hashScheduleContent,
  hashReceiptContent,
  verifyScheduleRow,
  verifyReceiptRow,
  CONTRACT_HASH_VERSION,
  contractIntegritySnapshot,
  hashContractRecord,
  contractShortCode,
  ensureContractIntegrity,
  verifyContractRecord,
  timingSafeEqualHex,
  toIsoDateOnly,
};

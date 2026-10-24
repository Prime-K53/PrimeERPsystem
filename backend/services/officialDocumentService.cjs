/**
 * Official Document Service (portal-facing)
 *
 * Bridges authenticated portal requests to THE authoritative ERP document
 * renderer. The renderer bundle (officialDocument/primeRenderer.cjs) is built
 * from the ERP frontend's own PrimeDocument pipeline — there is exactly ONE
 * document generator in the system; this service only feeds it authoritative
 * ERP records and streams the resulting application/pdf bytes.
 *
 * Security contract enforced by CALLERS (routes/portal.cjs):
 *   - customer identity comes from the portal JWT
 *   - the record is fetched through the existing customer-scoped getters,
 *     so an id belonging to another customer resolves to NOT_FOUND
 */

const path = require('path');
const fs = require('fs');
const { getCompanyConfig } = require('./companyConfigService.cjs');
const integrity = require('./documentIntegrity.cjs');

let rendererPromise = null;

/**
 * Font path resolver for the server-side renderer bundle.
 *
 * The renderer (primeRenderer.cjs) was built for browser use and registers
 * fonts with web-relative paths like "/fonts/comic.ttf". When @react-pdf/renderer
 * runs in Node.js it calls fs.promises.readFile() on that string, which on Windows
 * resolves to "D:\fonts\comic.ttf" — a path that doesn't exist.
 *
 * This patches fs.promises.readFile (once) so any access to an absolute path
 * ending in /fonts/<name>.ttf|.otf is transparently redirected to the
 * frontend/public/fonts/ directory where the files actually live.
 *
 * The patch is idempotent and only touches font file reads.
 */
const FONT_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'fonts');
let _fontPathsPatched = false;

function ensureFontPaths() {
  if (_fontPathsPatched) return;
  _fontPathsPatched = true;

  const origReadFile = fs.promises.readFile;
  fs.promises.readFile = function (filename, ...args) {
    if (
      typeof filename === 'string' &&
      /[/\\]fonts[/\\][^/\\]+\.(ttf|otf)$/i.test(filename) &&
      !filename.startsWith(FONT_DIR)
    ) {
      const fontName = path.basename(filename);
      const resolved = path.join(FONT_DIR, fontName);
      console.log(
        `[OfficialDocumentService] Font path redirect: "${filename}" → "${resolved}"`
      );
      filename = resolved;
    }
    return origReadFile.call(this, filename, ...args);
  };

  console.log(`[OfficialDocumentService] Font path resolver active (FONT_DIR: ${FONT_DIR})`);
}

/**
 * Server-side renderer environment propagation (public verification URLs).
 *
 * The renderer bundle (officialDocument/primeRenderer.cjs) is built with
 * `import.meta.env` mapped to `globalThis.__PRIME_DOC_VITE_ENV__`, so the
 * canonical verification URL builder inside the bundle reads the Portal
 * origin from that global. This populates it from the server runtime
 * environment BEFORE the bundle is required (the bundle banner only
 * installs defaults while the global is still undefined).
 *
 * Canonical variable: VITE_PUBLIC_PORTAL_URL — the same name the browser
 * build uses; backend/.env or the platform environment provides it. When
 * it is absent the global simply carries no Portal origin and the bundled
 * builder keeps its production fail-closed behavior (legacy QR payload,
 * never an ERP-origin fallback). No verification logic is touched here.
 */
function ensureRendererEnv() {
  const fromEnv = String(process.env.VITE_PUBLIC_PORTAL_URL || '').trim();
  // Contract QR codes use their own verification page (`/verify?c=&h=`) and
  // therefore need the public app origin. Both variables are passed through;
  // the bundle resolves VITE_CONTRACT_VERIFY_BASE_URL first, then the app URL.
  const appUrl = String(process.env.VITE_PUBLIC_APP_URL || '').trim();
  const contractVerifyUrl = String(process.env.VITE_CONTRACT_VERIFY_BASE_URL || '').trim();
  const existing = globalThis.__PRIME_DOC_VITE_ENV__;
  if (existing && typeof existing === 'object') {
    if (fromEnv) existing.VITE_PUBLIC_PORTAL_URL = fromEnv;
    if (appUrl) existing.VITE_PUBLIC_APP_URL = appUrl;
    if (contractVerifyUrl) existing.VITE_CONTRACT_VERIFY_BASE_URL = contractVerifyUrl;
    return existing;
  }
  globalThis.__PRIME_DOC_VITE_ENV__ = {
    DEV: false,
    PROD: true,
    MODE: 'production',
    ...(fromEnv ? { VITE_PUBLIC_PORTAL_URL: fromEnv } : {}),
    ...(appUrl ? { VITE_PUBLIC_APP_URL: appUrl } : {}),
    ...(contractVerifyUrl ? { VITE_CONTRACT_VERIFY_BASE_URL: contractVerifyUrl } : {}),
  };
  return globalThis.__PRIME_DOC_VITE_ENV__;
}

function loadRenderer() {
  if (!rendererPromise) {
    ensureFontPaths();   // must be before require() so fs.promises.readFile is patched
    ensureRendererEnv();
    const bundlePath = path.resolve(__dirname, 'officialDocument', 'primeRenderer.cjs');
    rendererPromise = Promise.resolve()
      .then(() => require(bundlePath))
      .then((mod) => {
        const fn = mod.renderOfficialDocumentPdf || mod.default;
        if (typeof fn !== 'function') throw new Error('renderer entrypoint missing');
        console.log('[OfficialDocumentService] Official document renderer: READY');
        console.log(`[OfficialDocumentService] Renderer bundle: ${bundlePath}`);
        return fn;
      })
      .catch((err) => {
        rendererPromise = null; // allow retry after a build/deploy fix
        console.error(`[OfficialDocumentService] Failed to load renderer bundle (${bundlePath}): ${err.stack || err.message}`);
        const error = new Error(`Official document renderer unavailable: ${err.message}`);
        error.code = 'RENDERER_UNAVAILABLE';
        throw error;
      });
  }
  return rendererPromise;
}

async function isRendererAvailable() {
  try { await loadRenderer(); return true; } catch { return false; }
}


/**
 * Helper to resolve the authoritative line item description from an ERP line item object.
 * Checks historical line description first, then item/product master names, ignoring empty/whitespace strings.
 */
function resolveItemDescription(it) {
  if (!it) return 'Item';
  const candidates = [
    it.description,
    it.desc,
    it.item_description,
    it.itemDescription,
    it.item_name,
    it.itemName,
    it.name,
    it.productName,
    it.product_name,
    it.title,
    it.label,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return 'Item';
}

/**
 * Public verification type (lowercase, underscore) -> canonical renderer
 * DocType (uppercase) mapping.
 *
 * The public verification routes use lowercase underscore types
 * (invoice, sales_order, ...) while the canonical renderer pipeline
 * (validateDocumentData / mapToInvoiceData / PrimeDocument) matches
 * UPPERCASE DocTypes (INVOICE, SALES_ORDER, PO, DELIVERY_NOTE, ...).
 * Passing the public slug straight through silently drops the document
 * into the renderer's generic fallback branch: line prices/amounts,
 * subtotal/paid/balance, status badge, due date and thank-you text are
 * all lost even though the record carries them.
 *
 * This maps ONLY the type token. Channel, security, and record data are
 * untouched here. Unknown types pass through unchanged.
 */
const PUBLIC_TO_RENDERER_TYPE = {
  invoice: 'INVOICE',
  receipt: 'RECEIPT',
  quotation: 'QUOTATION',
  sales_order: 'SALES_ORDER',
  purchase_order: 'PO',
  delivery_note: 'DELIVERY_NOTE',
  supplier_payment: 'SUPPLIER_PAYMENT',
  statement: 'ACCOUNT_STATEMENT',
  printing_contract: 'PRINTING_CONTRACT',
  // Without this mapping a schedule fell through to the generic renderer
  // branch, failed validation, and the download route collapsed into its
  // generic 404: the document verified but could never be downloaded.
  printing_contract_schedule: 'CONTRACT_SCHEDULE',
  // Same failure mode for the completion receipt: without the canonical type
  // the renderer's generic financial branch stripped the receipt fields (and
  // printed a document that was not the receipt). The public download must
  // serve the receipt template the QR was printed from.
  printing_contract_completion_receipt: 'CONTRACT_COMPLETION_RECEIPT',
};

function toCanonicalRendererType(type) {
  if (type === undefined || type === null) return type;
  const raw = String(type).trim();
  if (!raw) return raw;
  if (PUBLIC_TO_RENDERER_TYPE[raw]) return PUBLIC_TO_RENDERER_TYPE[raw];
  const lowered = raw.toLowerCase();
  if (PUBLIC_TO_RENDERER_TYPE[lowered]) return PUBLIC_TO_RENDERER_TYPE[lowered];
  return raw;
}

// ─── Printing contract: stored record → renderable document ───────────────
//
// A printing contract is NOT an immutable issued snapshot: the QR verifies the
// live `assessment_contracts` record (number + token + status), and the staff
// UI builds the PDF from that record on demand with
// `buildPrintingContractDoc` (frontend/services/printingContractService.ts).
//
// The public download receives the STORED record instead — snake_case contract
// columns plus the nested `data` bag — which the renderer cannot consume. These
// helpers mirror the frontend builder so a verified contract can be downloaded
// as the same document the ERP prints. The content hash is recomputed over the
// assembled document because it is a print-time digest (the ERP never persists
// it): the downloaded copy is generated from the live record, exactly like a
// fresh ERP print.
//
// Pure assembly only: no field values are derived beyond the same fallbacks
// the frontend builder uses.

const roundMoney = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parsed + Number.EPSILON) * 100) / 100;
};

const text = (value) => (value === undefined || value === null ? '' : String(value));

const displayDate = (iso) => {
  const parsed = iso ? new Date(iso) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toLocaleDateString('en-GB');
  return parsed.toLocaleDateString('en-GB');
};

const numberOrUndefined = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
};

/** Mirrors frontend/utils/contractProfile.ts readContractProfile (read only). */
function readContractProfile(data) {
  const d = (data && typeof data === 'object') ? data : {};
  const nested = (d.contract_profile && typeof d.contract_profile === 'object') ? d.contract_profile : {};
  const printSpec = (nested.print_spec || d.print_spec || {});
  const pricing = (nested.pricing_rules || d.pricing_rules || {});
  const delivery = (nested.delivery_terms || d.delivery_terms || {});
  const cand = (nested.candidature || d.candidature || {});
  return {
    printSpec: {
      paperSize: text(printSpec.paper_size ?? printSpec.paperSize ?? ''),
      paperType: text(printSpec.paper_type ?? printSpec.paperType ?? ''),
      paperWeight: text(printSpec.paper_weight ?? printSpec.paperWeight ?? ''),
      colorMode: text(printSpec.color_mode ?? printSpec.colorMode ?? ''),
      sides: text(printSpec.sides ?? ''),
      pagesPerCopy: text(printSpec.pages_per_copy ?? printSpec.pagesPerCopy ?? ''),
      copies: text(printSpec.copies ?? ''),
      orientation: text(printSpec.orientation ?? ''),
      finishing: text(printSpec.finishing ?? ''),
      packaging: text(printSpec.packaging ?? ''),
      specNotes: text(printSpec.notes ?? printSpec.spec_notes ?? ''),
    },
    pricingRules: {
      model: text(pricing.model ?? pricing.pricing_model ?? ''),
      chargePerCandidate: numberOrUndefined(
        pricing.charge_per_candidate ?? pricing.chargePerCandidate ?? d.charge_per_candidate,
      ),
      discount: text(pricing.discount ?? ''),
      urgentFee: text(pricing.urgent_fee ?? pricing.urgentFee ?? ''),
      taxHandling: text(pricing.tax_handling ?? pricing.taxHandling ?? ''),
      rulesNotes: text(pricing.notes ?? pricing.rules_notes ?? ''),
    },
    delivery: {
      method: text(delivery.method ?? delivery.delivery_method ?? ''),
      timeline: text(delivery.timeline ?? delivery.delivery_timeline ?? ''),
      address: text(delivery.address ?? delivery.delivery_address ?? ''),
      packaging: text(delivery.packaging ?? ''),
      deliveryNotes: text(delivery.notes ?? delivery.delivery_notes ?? ''),
    },
    candidature: {
      totalCandidature: numberOrUndefined(cand.total ?? cand.total_candidature ?? d.total_candidature),
      sittings: text(cand.sittings ?? cand.assessment_sittings ?? d.assessment_sittings ?? ''),
      spec: text(cand.spec ?? cand.assessment_spec ?? d.assessment_spec ?? ''),
    },
  };
}

/** Mirrors frontend/utils/contractProfile.ts summarisePrintSpec. */
function summarisePrintSpec(p) {
  const bits = [
    p.paperSize,
    p.paperType,
    p.paperWeight ? (/gsm/i.test(p.paperWeight) ? p.paperWeight : `${p.paperWeight}gsm`) : '',
    p.colorMode,
    p.sides,
    p.pagesPerCopy ? `${p.pagesPerCopy}pp` : '',
    p.copies ? `×${p.copies}` : '',
    p.orientation,
  ].map((s) => text(s).trim()).filter(Boolean);
  const head = bits.join(' · ');
  const tail = [p.finishing, p.packaging].map((s) => text(s).trim()).filter(Boolean).join(' · ');
  if (head && tail) return `${head} — ${tail}`;
  return head || tail || '';
}

/** Mirrors frontend/services/printingContractService.ts display helpers. */
function formatPaperWeight(value) {
  const weight = text(value).trim();
  if (!weight) return '';
  const numeric = weight.match(/^([\d.]+)\s*(?:gsm|g\/m2|g\/m²)?$/i);
  return numeric ? `${numeric[1]}gsm` : weight;
}

function formatPagesPerCopy(value) {
  const pages = text(value).trim();
  if (!pages) return '';
  return /page/i.test(pages) ? pages : `${pages} pages`;
}

function normalizeColorMode(value) {
  const mode = text(value).trim();
  if (!mode) return '';
  if (/^(b\s*&\s*w|bw|mono(?:chrome)?|black\s*(?:and|&)\s*white)$/i.test(mode)) return 'Black & white';
  if (/^colou?r$/i.test(mode)) return 'Colour';
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function normalizeSides(value) {
  const sides = text(value).trim();
  if (!sides) return '';
  if (/^(double|duplex)(?:[-\s]?sided)?$/i.test(sides)) return 'double-sided';
  if (/^(single|simplex)(?:[-\s]?sided)?$/i.test(sides)) return 'single-sided';
  return sides;
}

function stripCustomerIdSuffix(name) {
  let out = text(name).trim();
  if (!out) return '';
  out = out.replace(/\s*\((?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}\)\s*$/i, '').trim();
  out = out.replace(/^CUST-\d{3,}\s*(?:[\r\n]+|[-–—:|]\s*|\s+)/i, '').trim();
  out = out.replace(/(?:[\r\n]+|[-–—:|]\s*|\s+)CUST-\d{3,}\s*$/i, '').trim();
  if (/^CUST-\d{3,}$/i.test(out)) return '';
  return out.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
}

function resolveCustomerDisplayName(customerName, schoolName) {
  return stripCustomerIdSuffix(customerName) || stripCustomerIdSuffix(schoolName);
}

function normalizeCustomerReference(value) {
  const reference = text(value).trim();
  if (!reference) return undefined;
  if (/^CUST[-\s]?\d{3,}$/i.test(reference)) return reference.toUpperCase().replace(/\s+/g, '-');
  if (/^[A-Z]{2,5}-\d{3,}$/i.test(reference)) return reference;
  return undefined;
}

const firstText = (...values) => {
  for (const value of values) {
    const normalized = text(value).trim();
    if (normalized) return normalized;
  }
  return undefined;
};

const mapContractLines = (snapshot) => {
  const inner = (snapshot.data && typeof snapshot.data === 'object') ? snapshot.data : {};
  const raw = Array.isArray(inner.lines) ? inner.lines : [];
  const mapped = raw
    .filter((l) => l && text(l.assessment_name).trim() !== '' && Math.floor(Number(l.quantity)) > 0)
    .map((l) => {
      const qty = Math.max(0, Math.floor(Number(l.quantity) || 0));
      const price = roundMoney(Math.max(0, Number(l.unit_price) || 0));
      const qualifiers = [l.assessment_grade, l.assessment_subject].filter(Boolean).join(' · ');
      return {
        desc: qualifiers ? `${text(l.assessment_name).trim()} (${qualifiers})` : text(l.assessment_name).trim(),
        qty,
        price,
        total: roundMoney(qty * price),
      };
    });
  if (mapped.length > 0) return mapped;
  const qty = Math.max(1, Math.floor(Number(snapshot.max_assessments) || 0));
  const price = roundMoney(Math.max(0, Number(snapshot.assessment_price) || 0));
  return [{ desc: text(snapshot.title || 'Printing contract').trim(), qty, price, total: roundMoney(qty * price) }];
};

const mapContractSignatureBlock = (block) => {
  if (!block || typeof block !== 'object') return null;
  if (!text(block.name).trim() || !text(block.signatureDataUrl).trim()) return null;
  return {
    name: text(block.name).trim(),
    role: text(block.role).trim(),
    signatureDataUrl: text(block.signatureDataUrl),
    mode: block.mode === 'Upload' ? 'Upload' : 'Draw',
    signedAt: text(block.signedAt),
    signedBy: text(block.signedBy),
  };
};

/**
 * Assemble the canonical PrintingContractDoc from the stored contract record.
 * An already-canonical doc (staff/server caller) passes through untouched so
 * its issued digest is preserved.
 */
function normalizePrintingContractRecord(record) {
  if (
    record && record.contractNumber
    && Array.isArray(record.lines) && record.lines.length > 0
    && record.contentHash
  ) {
    return record;
  }
  const snapshot = record || {};
  const inner = (snapshot.data && typeof snapshot.data === 'object') ? snapshot.data : {};
  const profile = readContractProfile(inner);
  const company = mapContractSignatureBlock((inner.signatures || {}).company);
  const customer = mapContractSignatureBlock((inner.signatures || {}).customer);
  const pricingBits = [
    profile.pricingRules.model ? String(profile.pricingRules.model).replace(/_/g, ' ') : '',
    profile.pricingRules.chargePerCandidate !== undefined
      ? `Charge per candidate: ${roundMoney(profile.pricingRules.chargePerCandidate)}`
      : '',
    profile.pricingRules.discount ? `Discount: ${profile.pricingRules.discount}` : '',
    profile.pricingRules.urgentFee ? `Urgent: ${profile.pricingRules.urgentFee}` : '',
    profile.pricingRules.taxHandling,
    profile.pricingRules.rulesNotes,
  ].filter((s) => text(s).trim()).join(' · ') || undefined;
  const deliveryBits = [
    profile.delivery.method,
    profile.delivery.timeline,
    profile.delivery.address,
    profile.delivery.packaging ? `Pack: ${profile.delivery.packaging}` : '',
    profile.delivery.deliveryNotes,
  ].filter((s) => text(s).trim()).join(' · ') || undefined;
  const printPaperSummary = [
    profile.printSpec.paperSize,
    formatPaperWeight(profile.printSpec.paperWeight),
    formatPagesPerCopy(profile.printSpec.pagesPerCopy),
  ].filter((s) => text(s).trim()).join(', ') || undefined;
  const printColorSummary = [
    normalizeColorMode(profile.printSpec.colorMode),
    normalizeSides(profile.printSpec.sides),
  ].filter((s) => text(s).trim()).join(', ') || undefined;
  const printTypeSummary = [
    profile.printSpec.paperType,
    profile.printSpec.orientation,
  ].filter((s) => text(s).trim()).join(' · ') || undefined;
  const vatValue = numberOrUndefined(
    inner.vat_amount ?? inner.vatAmount ?? snapshot.vat_amount ?? snapshot.vatAmount ?? snapshot.tax_amount ?? snapshot.taxAmount,
  );
  const resolvedSchoolName = stripCustomerIdSuffix(text(snapshot.schoolName || snapshot.school_name).trim()) || undefined;
  const doc = {
    documentType: 'printing_contract',
    verificationToken: text(snapshot.verificationToken).trim() || undefined,
    contractNumber: text(snapshot.contract_number || snapshot.contractNumber).trim(),
    // The stored record carries no print instant; use the agreement's own
    // lifecycle date. The date is part of the recomputed digest, never a
    // claim about a different (historical) printout.
    date: displayDate(snapshot.created_at || snapshot.activated_at || snapshot.starts_at || snapshot.serverUpdatedAt),
    version: Number(snapshot.version) || 1,
    status: text(snapshot.status || 'draft'),
    customerName: resolveCustomerDisplayName(snapshot.customerName || snapshot.customer_name, resolvedSchoolName) || 'Customer',
    schoolName: resolvedSchoolName,
    customerContact: firstText(snapshot.customerContact, snapshot.customer_contact, inner.customer_contact),
    customerPhone: firstText(snapshot.customerPhone, snapshot.customer_phone, inner.customer_phone),
    customerEmail: firstText(snapshot.customerEmail, snapshot.customer_email, inner.customer_email),
    customerAddress: firstText(snapshot.customerAddress, snapshot.customer_address, snapshot.billing_address, inner.customer_address),
    customerReference: normalizeCustomerReference(
      firstText(snapshot.customerReference, snapshot.customer_reference, snapshot.customer_id, snapshot.customerId),
    ),
    schoolZone: firstText(snapshot.schoolZone, snapshot.school_zone, inner.school_zone, inner.schoolZone),
    periodStart: snapshot.starts_at || undefined,
    periodEnd: snapshot.ends_at || undefined,
    lines: mapContractLines(snapshot),
    prepaidAmount: roundMoney(Number(snapshot.prepaid_amount ?? snapshot.prepaidAmount) || 0),
    maxAssessments: Math.max(0, Math.floor(Number(snapshot.max_assessments ?? snapshot.maxAssessments) || 0)),
    assessmentPrice: roundMoney(Number(snapshot.assessment_price ?? snapshot.assessmentPrice) || 0),
    terms: text(snapshot.terms).trim() || undefined,
    notes: text(snapshot.notes).trim() || undefined,
    totalCandidature: profile.candidature.totalCandidature,
    assessmentSpec: profile.candidature.spec.trim() || undefined,
    chargePerCandidate: profile.pricingRules.chargePerCandidate,
    assessmentSittings: profile.candidature.sittings.trim() || undefined,
    printSpecSummary: summarisePrintSpec(profile.printSpec) || undefined,
    printPaperSummary,
    printColorSummary,
    printTypeSummary,
    printFinishing: text(profile.printSpec.finishing).trim() || undefined,
    printPackaging: text(profile.printSpec.packaging).trim() || undefined,
    printOrientation: text(profile.printSpec.orientation).trim() || undefined,
    pricingRulesSummary: pricingBits,
    deliveryTermsSummary: deliveryBits,
    deliveryMethod: text(profile.delivery.method).trim() || undefined,
    deliveryTimeline: text(profile.delivery.timeline).trim() || undefined,
    deliveryAddress: text(profile.delivery.address).trim() || undefined,
    deliveryNotes: text(profile.delivery.deliveryNotes).trim() || undefined,
    vatAmount: vatValue !== undefined && vatValue > 0 ? roundMoney(vatValue) : undefined,
    signatures: { company, customer },
    fullySigned: Boolean(company && customer),
    issuedInvoiceId: text(inner.issued_invoice_id).trim() || undefined,
  };
  if (!doc.contractNumber) return record;
  // Canonical, RECORD-based digest (contract hash v1). Not the assembled
  // document: `date`, token and QR are volatile and excluded, and the public
  // verifier recomputes exactly this digest from `assessment_contracts`.
  const integrityFields = integrity.ensureContractIntegrity(record);
  doc.contentHash = integrityFields.contentHash;
  doc.integrityShortCode = integrityFields.integrityShortCode;
  return doc;
}

/**
 * Normalize a stored/mapped ERP record into the shape the canonical document
 * mapper expects (same as what the ERP finance layer feeds its renderer):
 * items[] as an array of {description, quantity, price, total, …} regardless
 * of whether the source spelled them line_items/items_json/name-vs-desc.
 *
 * Invoice field contract (matches frontend/utils/pdfMapper.ts mapToInvoiceData):
 * - date: invoiceDate || invoice_date || orderDate || order_date || date
 *         || nextRunDate || created_at || issuedAt || issued_at
 * - dueDate: dueDate || due_date || due_at || validUntil || expiryDate
 * - items: record.items only (populated here from historical aliases);
 *          line price: price || unitPrice || unit_price || selling_price
 *            || sellingPrice || unitCost || unit_cost || cost || rate
 *          line total: total || lineTotal || line_total || lineTotalNet
 *            || subtotal || totalAmount || amount || extendedPrice
 *            || extended_price || qty*price
 * - totals/status: preserved via spread (renderer reads totalAmount/total/
 *   total_amount, paidAmount/amountPaid/paid_amount, subtotal, status and
 *   derives balance as total - paid). Aliases below only fill MISSING
 *   canonical keys; no accounting recalculation is introduced.
 */
function normalizeRecordForRenderer(raw, type) {
  // The printing contract is a live commercial agreement, not an invoice-shaped
  // record: its stored snapshot needs the contract document assembled before
  // the generic aliasing below (which would otherwise discard the agreed
  // lines/profile and add invoice-only keys).
  if (type === 'PRINTING_CONTRACT') return normalizePrintingContractRecord(raw);

  const record = { ...(raw || {}) };

  // Fill one canonical key from the first stored alias that carries a value.
  // Never overwrites an existing canonical key and never derives a new value,
  // so this stays a pure naming bridge between the stored ERP record and the
  // canonical document contract the renderer validates against.
  const fillFrom = (target, sources) => {
    if (record[target] !== undefined && record[target] !== null && record[target] !== '') return;
    for (const source of sources) {
      const value = record[source];
      if (value !== undefined && value !== null && value !== '') {
        record[target] = value;
        return;
      }
    }
  };

  // Authoritative invoice date: same precedence as mapToInvoiceData.
  // NOTE: `invoice_number_date` is intentionally NOT read (non-canonical;
  // it appears nowhere else in the ERP and previously shadowed `date`).
  const invoiceDate = record.invoiceDate || record.invoice_date || record.orderDate || record.order_date || record.date || record.nextRunDate || record.created_at || record.issuedAt || record.issued_at;
  if (invoiceDate) {
    record.date = invoiceDate;
    record.invoiceDate = invoiceDate;
  }

  const dueDate = record.dueDate || record.due_date || record.due_at || record.validUntil || record.expiryDate;
  if (dueDate) {
    record.dueDate = dueDate;
    record.due_date = dueDate;
  }

  const paymentTerms = record.paymentTerms || record.payment_terms || record.terms;
  if (paymentTerms) {
    record.paymentTerms = paymentTerms;
    record.payment_terms = paymentTerms;
  }

  // Canonical invoice-number alias for the renderer, which reads
  // `invoiceNumber || id` (never `invoice_number` alone). Never overwrites
  // an existing invoiceNumber; other document types keep their own numbers.
  if (record.invoiceNumber === undefined || record.invoiceNumber === null || record.invoiceNumber === '') {
    const aliased = record.invoice_number;
    if (aliased !== undefined && aliased !== null && String(aliased).trim() !== '') {
      record.invoiceNumber = aliased;
    }
  }

  // Fill missing canonical financial aliases from existing values only.
  // The renderer accepts every spelling below, but validation
  // (resolveAmount) and downstream readers may prefer one spelling;
  // filling the missing alias keeps all readers consistent.
  const pickNumber = (...candidates) => {
    for (const v of candidates) {
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return v;
        return v;
      }
    }
    return undefined;
  };
  const totalSource = pickNumber(record.totalAmount, record.total, record.total_amount, record.total_cost, record.subtotal);
  if ((record.totalAmount === undefined || record.totalAmount === null || record.totalAmount === '') && totalSource !== undefined) {
    record.totalAmount = totalSource;
  }
  if ((record.subtotal === undefined || record.subtotal === null || record.subtotal === '') && totalSource !== undefined) {
    record.subtotal = totalSource;
  }
  const paidSource = pickNumber(record.paidAmount, record.amountPaid, record.paid_amount);
  if ((record.paidAmount === undefined || record.paidAmount === null || record.paidAmount === '') && paidSource !== undefined) {
    record.paidAmount = paidSource;
  }
  if ((record.amountPaid === undefined || record.amountPaid === null || record.amountPaid === '') && paidSource !== undefined) {
    record.amountPaid = paidSource;
  }

  // ── Statement / receipt canonical aliases ─────────────────────────────
  // The public verification registry (services/documentVerificationService.cjs)
  // resolves the STORED ERP record — a statement_snapshots snapshot
  // (periodStart / periodEnd / closingBalance) or a customer_payments receipt
  // (id as the official number) — while the canonical renderer validates
  // canonical field names (startDate / endDate / finalBalance, receiptNumber).
  // Without this bridge the renderer rejects the record, the public download
  // route maps that rejection to its generic 404, and a perfectly verified
  // document reports "could not be verified". Pure aliasing only: identical
  // field-selection rules as the invoice aliases above, no recalculation.
  const isStatementType = type === 'ACCOUNT_STATEMENT' || type === 'ACCOUNT_STATEMENT_SUMMARY';
  if (isStatementType) {
    fillFrom('startDate', ['startDate', 'periodStart', 'period_start', 'from', 'openingDate']);
    fillFrom('endDate', ['endDate', 'periodEnd', 'period_end', 'to']);
    fillFrom('openingBalance', ['openingBalance', 'opening_balance', 'openingAmount']);
    // `finalBalance` is the renderer's closing-balance field; the frozen
    // snapshot persists the same total as closingBalance.
    fillFrom('finalBalance', ['finalBalance', 'closingBalance', 'closing_balance', 'closingAmount', 'balance']);
    fillFrom('customerName', ['customerName', 'customer_name', 'clientName', 'client_name', 'businessName', 'business_name']);
    fillFrom('date', ['statementDate', 'statement_date', 'periodEnd', 'period_end']);
  }
  if (type === 'RECEIPT') {
    // The ERP treats the customer_payments record id as the official receipt
    // number (see frontend/services/receiptCalculationService.ts).
    fillFrom('receiptNumber', ['receiptNumber', 'receipt_number', 'paymentNumber', 'id']);
    fillFrom('customerName', ['customerName', 'customer_name', 'clientName', 'client_name', 'businessName', 'business_name']);
    fillFrom('paymentMethod', ['paymentMethod', 'payment_method', 'method']);
    fillFrom('amountReceived', ['amountReceived', 'amount_received', 'amount', 'totalAmount']);
  }

  // Line items: treat an empty array as missing (never let `items: []`
  // shadow a populated historical alias), accept JSON-string storage,
  // and cover the full historical key set handled by the shared
  // invoiceLineItemNormalization layer.
  const readItemsArray = (value) => {
    if (Array.isArray(value)) return value.length > 0 ? value : null;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return null;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.length > 0 ? parsed : null;
      } catch (_) { /* not JSON — skip */ }
    }
    return null;
  };
  let items = readItemsArray(record.items);
  if (!items) {
    for (const key of ['line_items', 'lineItems', 'invoiceItems', 'invoice_items', 'lines', 'invoiceLines', 'lines_items', 'invoice_lines', 'line_items_json', 'lineItemsJson', 'items_json', 'itemsJson', 'invoice_items_json']) {
      const found = readItemsArray(record[key]);
      if (found) { items = found; break; }
    }
  }
  if (!items) items = [];
  record.items = items.map((it) => {
    const description = resolveItemDescription(it);
    const quantity = Number(it?.quantity ?? it?.qty ?? it?.quantityOrdered ?? it?.qty_ordered ?? 0) || 0;
    const price = Number(it?.price ?? it?.unitPrice ?? it?.unit_price ?? it?.selling_price ?? it?.sellingPrice ?? it?.unitCost ?? it?.unit_cost ?? it?.cost ?? it?.rate ?? 0) || 0;
    const total = Number(it?.total ?? it?.lineTotal ?? it?.line_total ?? it?.lineTotalNet ?? it?.subtotal ?? it?.totalAmount ?? it?.amount ?? it?.extendedPrice ?? it?.extended_price ?? (quantity * price)) || 0;
    return {
      ...it,
      desc: description,
      description,
      name: it?.name || description,
      productName: it?.productName || description,
      item_name: it?.item_name || description,
      quantity,
      qty: quantity,
      price,
      unitPrice: price,
      total,
    };
  });
  return record;
}

/**
 * OfficialDocumentChannel — the ONLY thing that changes between an ERP copy
 * and a Portal copy is the native PORTAL COPY watermark inside the PDF.
 *
 *   - 'erp'    → clean official document (no watermark)
 *   - 'portal' → the SAME authoritative document rendered with PORTAL COPY
 *                drawn into the PDF by the renderer itself (no byte
 *                post-processing anywhere in this pipeline).
 *
 * The channel is established by the CALLER (routes/portal.cjs) server-side;
 * it is never derived from browser-supplied input. 'source' is accepted as a
 * legacy alias so older callers keep working during the migration.
 *
 * Security: for channel === 'portal' the watermark is part of the rendered
 * PDF. If rendering fails, this throws — the Portal receives an error, never
 * a silently clean/unwatermarked PDF.
 */
async function renderOfficialPdf({ type, rawData, customers = [], channel, source } = {}) {
  const effectiveChannel = channel || (source === 'portal' ? 'portal' : 'erp');
  // Canonicalize the public verification slug (lowercase) to the renderer's
  // UPPERCASE DocType. Authenticated callers already pass canonical types;
  // they pass through unchanged. The channel/watermark contract is untouched.
  const canonicalType = toCanonicalRendererType(type);
  const render = await loadRenderer();
  const companyConfig = await getCompanyConfig();
  const buffer = await render({
    type: canonicalType,
    rawData: normalizeRecordForRenderer(rawData, canonicalType),
    companyConfig,
    customers,
    channel: effectiveChannel,
  });

  return { buffer, contentType: 'application/pdf' };
}

/** RFC 6266-ish filename for Content-Disposition (ASCII-safe). */
function buildContentDisposition(filename) {
  const safe = String(filename || 'document.pdf')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'document.pdf';
  if (!/\.pdf$/i.test(safe)) return `attachment; filename="${safe}.pdf"`;
  return `attachment; filename="${safe}"`;
}

module.exports = {
  loadRenderer,
  ensureRendererEnv,
  isRendererAvailable,
  getCompanyConfig,
  normalizeRecordForRenderer,
  toCanonicalRendererType,
  renderOfficialPdf,
  buildContentDisposition,
};

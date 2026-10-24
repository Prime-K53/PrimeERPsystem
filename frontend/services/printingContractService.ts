import type { AssessmentContract, AssessmentContractItem } from '../types';
import { roundMoney } from '../utils/roundingUtils';
import { readContractProfile, summarisePrintSpec } from '../utils/contractProfile';
import { isMainBranchValue } from './customerAccountScope';
import { compareIsoDateOnly, isIsoDateWithin, toIsoDateOnly, toIsoDateOnlyOrEmpty } from '../utils/isoDate';

export interface PrintingContractDocLine {
  desc: string;
  qty: number;
  price: number;
  total: number;
}

export interface PrintingContractSignatureBlock {
  name: string;
  role: string;
  signatureDataUrl?: string | null;
  mode?: 'Draw' | 'Upload';
  signedAt: string;
  signedBy: string;
}

export interface PrintingContractDocData {
  documentType: 'printing_contract';
  verificationToken?: string;
  contractNumber: string;
  date: string;
  version: number;
  status: string;
  customerName: string;
  schoolName?: string;
  /** Client party block: contact person, phone, email and postal/physical address. */
  customerContact?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  /** Small secondary reference (the CUST-xxxx key), never the display name. */
  customerReference?: string;
  schoolZone?: string;
  periodStart?: string;
  periodEnd?: string;
  lines: PrintingContractDocLine[];
  prepaidAmount: number;
  maxAssessments: number;
  assessmentPrice: number;
  terms?: string;
  notes?: string;
  totalCandidature?: number;
  assessmentSpec?: string;
  chargePerCandidate?: number;
  assessmentSittings?: string;
  printSpecSummary?: string;
  /** Structured agreed-specification rows (label/value table on the contract). */
  printPaperSummary?: string;
  printColorSummary?: string;
  printTypeSummary?: string;
  printFinishing?: string;
  printPackaging?: string;
  printOrientation?: string;
  pricingRulesSummary?: string;
  deliveryTermsSummary?: string;
  deliveryMethod?: string;
  deliveryTimeline?: string;
  deliveryAddress?: string;
  deliveryNotes?: string;
  /** VAT applied to the order, when the contract records one. */
  vatAmount?: number;
  signatures: {
    company: PrintingContractSignatureBlock | null;
    customer: PrintingContractSignatureBlock | null;
  };
  fullySigned: boolean;
  contentHash: string;
  /**
   * Human-typable digest prefix ("4612-f2e1-2ecc"). Derived from `contentHash`
   * by `contractShortCode`; persisted alongside it so a manual lookup resolves
   * server-side. NEVER proof on its own — the verify endpoint recomputes the
   * full hash and compares it constant-time.
   */
  integrityShortCode?: string;
  issuedInvoiceId?: string;
}

export interface BuildPrintingContractDocInput {
  contract: AssessmentContract;
  customerName: string;
  schoolName?: string;
  /** Client party details sourced from the customer/school records. */
  customerContact?: string;
  customerPhone?: string;
  customerEmail?: string;
  customerAddress?: string;
  customerReference?: string;
  currencySymbol?: string;
  issuedAtIso?: string;
}

const toDisplayDate = (iso?: string): string => {
  const parsed = iso ? new Date(iso) : new Date();
  if (Number.isNaN(parsed.getTime())) return new Date().toLocaleDateString('en-GB');
  return parsed.toLocaleDateString('en-GB');
};

const mapLines = (contract: AssessmentContract): PrintingContractDocLine[] => {
  const raw = ((contract.data as any)?.lines || []) as any[];
  const mapped = raw
    .filter((l) => l && String(l.assessment_name || '').trim() !== '' && Math.floor(Number(l.quantity)) > 0)
    .map((l) => {
      const qty = Math.max(0, Math.floor(Number(l.quantity) || 0));
      const price = roundMoney(Math.max(0, Number(l.unit_price) || 0));
      const qualifiers = [l.assessment_grade, l.assessment_subject].filter(Boolean).join(' · ');
      return {
        desc: qualifiers ? `${String(l.assessment_name).trim()} (${qualifiers})` : String(l.assessment_name).trim(),
        qty,
        price,
        total: roundMoney(qty * price),
      };
    });
  if (mapped.length > 0) return mapped;
  // Fallback mirrors the invoice-issuance path: synthesize one line from
  // the commercial header so the document never renders blank.
  const qty = Math.max(1, Math.floor(Number(contract.max_assessments) || 0));
  const price = roundMoney(Math.max(0, Number(contract.assessment_price) || 0));
  return [{
    desc: String(contract.title || 'Printing contract').trim(),
    qty,
    price,
    total: roundMoney(qty * price),
  }];
};

const mapSignatureBlock = (block: any): PrintingContractSignatureBlock | null => {
  if (!block || typeof block !== 'object') return null;
  if (!String(block.name || '').trim() || !String(block.signatureDataUrl || '').trim()) return null;
  return {
    name: String(block.name).trim(),
    role: String(block.role || '').trim(),
    signatureDataUrl: String(block.signatureDataUrl),
    mode: block.mode === 'Upload' ? 'Upload' : 'Draw',
    signedAt: String(block.signedAt || ''),
    signedBy: String(block.signedBy || ''),
  };
};

const textOrUndefined = (value: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  return text || undefined;
};

/**
 * Normalise a paper weight for print. The profile historically let operators
 * type "80gsm" into a field that the summary also suffixed with "gsm",
 * producing "80gmsgsm"; accepting either form here keeps both old and new
 * contracts readable without rewriting stored data.
 */
const formatPaperWeight = (value?: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  const numeric = text.match(/^([\d.]+)\s*(?:gsm|g\/m2|g\/m²)?$/i);
  return numeric ? `${numeric[1]}gsm` : text;
};

const formatPagesPerCopy = (value?: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  return /page/i.test(text) ? text : `${text} pages`;
};

const normalizeColorMode = (value?: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(b\s*&\s*w|bw|mono(?:chrome)?|black\s*(?:and|&)\s*white)$/i.test(text)) return 'Black & white';
  if (/^colou?r$/i.test(text)) return 'Colour';
  return text.charAt(0).toUpperCase() + text.slice(1);
};

const normalizeSides = (value?: string): string => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(double|duplex)(?:[-\s]?sided)?$/i.test(text)) return 'double-sided';
  if (/^(single|simplex)(?:[-\s]?sided)?$/i.test(text)) return 'single-sided';
  return text;
};

/** Only a human-facing customer key is printed — never a UUID or raw row id. */
const normalizeCustomerReference = (value?: unknown): string | undefined => {
  const text = String(value ?? '').trim();
  if (!text) return undefined;
  if (/^CUST[-\s]?\d{3,}$/i.test(text)) return text.toUpperCase().replace(/\s+/g, '-');
  if (/^[A-Z]{2,5}-\d{3,}$/i.test(text)) return text;
  return undefined;
};

/** Deterministic JSON: sorted keys, recursive — the hash input. */
export const stableStringify = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

/**
 * Tamper-evidence hash over the exact agreed content (parties, lines,
 * totals, terms, both signature blocks including images). Any post-sign
 * change — amounts, terms, or signature swap — yields a different hash.
 *
 * FAIL CLOSED: SHA-256 is the only accepted algorithm. When WebCrypto
 * is unavailable the document is NOT issued with a weaker hash — the
 * build throws so the caller surfaces the failure instead of silently
 * downgrading to a non-cryptographic fingerprint that would let a
 * tampered document verify as authentic.
 */
export const hashContractContent = async (canonicalJson: string): Promise<string> => {
  const subtle = (globalThis as any)?.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== 'function') {
    throw new Error('Secure hashing unavailable (WebCrypto SHA-256 required) — document not issued.');
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
};

// ─── Contract integrity (record-based canonical digest) ────────────────
//
// The printed contract hash is a digest of the STORED CONTRACT RECORD — never
// of the rendered PDF bytes. That is what lets the public verify endpoint
// recompute it server-side from `assessment_contracts` alone and detect any
// edit to a material field.
//
// Rule (contract hash v1):
//   - Material: parties, line items, amounts, terms, contract dates, version,
//     status and the recorded signature blocks.
//   - Volatile/excluded: the print/issue date, the verification token, the QR
//     payload/bytes, `contentHash` and `integrityShortCode` themselves.
//   - Absent optionals are pruned exactly as JSONB drops them, so the issuer
//     and the verifier hash the same shape.
//   - Keys are serialised in sorted order by `stableStringify`.
//
// MUST stay byte-identical to `backend/services/documentIntegrity.cjs`
// (`contractIntegritySnapshot` / `hashContractRecord`). The cross-language
// fixture `tests/fixtures/contract-integrity-vector.json` locks the two
// implementations together.
export const CONTRACT_HASH_VERSION = 1;

const snapshotText = (value: unknown): string => String(value ?? '').trim();

const snapshotFirstText = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const text = snapshotText(value);
    if (text) return text;
  }
  return undefined;
};

const snapshotNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Normalised recorded signature block (or null when it is not a signature). */
const snapshotSignature = (block: unknown): PrintingContractSignatureBlock | null => {
  const mapped = mapSignatureBlock(block);
  if (!mapped) return null;
  const rawSignedAt = snapshotText(mapped.signedAt);
  return {
    name: mapped.name,
    role: mapped.role,
    mode: mapped.mode,
    // Calendar date only: two renders of the same signature day agree even if
    // the recorded instant carries a different time/offset.
    signedAt: toIsoDateOnly(rawSignedAt) || rawSignedAt,
    signedBy: mapped.signedBy,
    signatureDataUrl: mapped.signatureDataUrl as string,
  };
};

/**
 * Canonical, deterministic projection of an `AssessmentContract` record.
 * Both the browser issuer and the server verifier call the same rule; only
 * material fields are present, and undefined keys are removed.
 */
export const buildContractIntegritySnapshot = (
  contract: AssessmentContract,
): Record<string, unknown> => {
  const record = (contract || {}) as any;
  const inner = record.data && typeof record.data === 'object' ? record.data : {};
  const profile = readContractProfile(inner);

  const schoolName = stripCustomerIdSuffix(
    snapshotFirstText(record.schoolName, record.school_name, inner.school_name),
  ) || undefined;
  const customerName = resolveCustomerDisplayName(
    snapshotFirstText(record.customerName, record.customer_name, inner.customer_name),
    schoolName,
  ) || 'Customer';

  const vatValue = snapshotNumber(
    inner.vat_amount ?? inner.vatAmount ?? record.vat_amount ?? record.vatAmount
      ?? record.tax_amount ?? record.taxAmount,
  );
  const company = snapshotSignature((inner.signatures || {}).company);
  const customer = snapshotSignature((inner.signatures || {}).customer);

  const snapshot = {
    hashVersion: CONTRACT_HASH_VERSION,
    documentType: 'printing_contract',
    contractNumber: snapshotText(record.contract_number || record.contractNumber),
    version: Number(record.version) || 1,
    status: snapshotText(record.status || 'draft'),
    // Parties
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
    // Contract window (calendar dates, never instants)
    periodStart: toIsoDateOnly(record.starts_at ?? record.periodStart ?? record.startsAt) || undefined,
    periodEnd: toIsoDateOnly(record.ends_at ?? record.periodEnd ?? record.endsAt) || undefined,
    // Commercial content
    lines: mapLines(record),
    prepaidAmount: roundMoney(Number(record.prepaid_amount ?? record.prepaidAmount) || 0),
    maxAssessments: Math.max(0, Math.floor(Number(record.max_assessments ?? record.maxAssessments) || 0)),
    assessmentPrice: roundMoney(Number(record.assessment_price ?? record.assessmentPrice) || 0),
    vatAmount: vatValue !== undefined && vatValue > 0 ? roundMoney(vatValue) : undefined,
    terms: snapshotText(record.terms) || undefined,
    notes: snapshotText(record.notes) || undefined,
    // Agreed specification (the same values printed on the contract)
    totalCandidature: profile.candidature.totalCandidature,
    assessmentSpec: snapshotText(profile.candidature.spec) || undefined,
    chargePerCandidate: profile.pricingRules.chargePerCandidate,
    assessmentSittings: snapshotText(profile.candidature.sittings) || undefined,
    printSpecSummary: summarisePrintSpec(profile.printSpec) || undefined,
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
    printFinishing: snapshotText(profile.printSpec.finishing) || undefined,
    printPackaging: snapshotText(profile.printSpec.packaging) || undefined,
    printOrientation: snapshotText(profile.printSpec.orientation) || undefined,
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
    deliveryMethod: snapshotText(profile.delivery.method) || undefined,
    deliveryTimeline: snapshotText(profile.delivery.timeline) || undefined,
    deliveryAddress: snapshotText(profile.delivery.address) || undefined,
    deliveryNotes: snapshotText(profile.delivery.deliveryNotes) || undefined,
    // Signatures (images included so a signature swap changes the digest)
    signatures: { company, customer },
    fullySigned: Boolean(company && customer),
    issuedInvoiceId: snapshotFirstText(inner.issued_invoice_id, inner.issuedInvoiceId, record.issuedInvoiceId),
  };
  return pruneUndefined(snapshot) as Record<string, unknown>;
};

/** SHA-256 over the canonical contract snapshot. */
export const hashContractRecord = async (contract: AssessmentContract): Promise<string> =>
  hashContractContent(stableStringify(buildContractIntegritySnapshot(contract)));

/**
 * First 12 hex characters of the digest, grouped 4-4-4 for manual entry.
 * Empty string when the digest is not a SHA-256 hex value.
 */
export const contractShortCode = (contentHash?: string | null): string => {
  const hex = String(contentHash || '').toLowerCase().trim();
  if (!/^[0-9a-f]{12,}$/.test(hex)) return '';
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
};

/**
 * Attach/refresh the persisted integrity fields. Called on contract create,
 * every update (including status transitions) and at print time for legacy
 * rows, so a changed contract can never keep a stale digest.
 */
export const ensureContractIntegrity = async (
  contract: AssessmentContract,
): Promise<AssessmentContract> => {
  const contentHash = await hashContractRecord(contract);
  return {
    ...contract,
    contentHash,
    integrityShortCode: contractShortCode(contentHash),
  } as AssessmentContract;
};

export const buildPrintingContractDoc = async (
  input: BuildPrintingContractDocInput,
): Promise<PrintingContractDocData> => {
  const { contract } = input;
  if (!contract) throw new Error('Contract is required to build the document.');
  // The digest is computed from the STORED record, not from this assembled
  // document: `date`, token and QR are volatile and must never enter it. The
  // record-only snapshot also means the server can recompute the same digest
  // from `assessment_contracts` without re-rendering a PDF.
  const snapshot = buildContractIntegritySnapshot(contract);
  // Display falls back to caller-supplied party details for legacy rows and
  // for standalone builder calls. The DIGEST above is always record-based;
  // the ERP persists these party fields before printing so the server can
  // recompute exactly what the client block shows.
  const storedCustomer = String(snapshot.customerName || '').trim();
  const storedSchool = snapshot.schoolName ? String(snapshot.schoolName) : '';
  const schoolName = storedSchool || stripCustomerIdSuffix(String(input.schoolName || '')) || undefined;
  const customerName = resolveCustomerDisplayName(
    storedCustomer && storedCustomer !== 'Customer' ? storedCustomer : input.customerName,
    schoolName,
  ) || 'Customer';
  const doc: Omit<PrintingContractDocData, 'contentHash'> = {
    documentType: 'printing_contract',
    verificationToken: String((contract as any)?.verificationToken || '').trim() || undefined,
    contractNumber: String(snapshot.contractNumber || ''),
    date: toDisplayDate(input.issuedAtIso),
    version: Number(snapshot.version) || 1,
    status: String(snapshot.status || 'draft'),
    customerName,
    schoolName,
    customerContact: snapshot.customerContact
      ? String(snapshot.customerContact)
      : textOrUndefined(input.customerContact),
    customerPhone: snapshot.customerPhone
      ? String(snapshot.customerPhone)
      : textOrUndefined(input.customerPhone),
    customerEmail: textOrUndefined(input.customerEmail),
    customerAddress: snapshot.customerAddress
      ? String(snapshot.customerAddress)
      : textOrUndefined(input.customerAddress),
    customerReference: snapshot.customerReference
      ? String(snapshot.customerReference)
      : normalizeCustomerReference(input.customerReference) || normalizeCustomerReference((contract as any)?.customer_id),
    schoolZone: snapshot.schoolZone ? String(snapshot.schoolZone) : undefined,
    periodStart: snapshot.periodStart ? String(snapshot.periodStart) : undefined,
    periodEnd: snapshot.periodEnd ? String(snapshot.periodEnd) : undefined,
    lines: snapshot.lines as PrintingContractDocLine[],
    prepaidAmount: Number(snapshot.prepaidAmount) || 0,
    maxAssessments: Number(snapshot.maxAssessments) || 0,
    assessmentPrice: Number(snapshot.assessmentPrice) || 0,
    terms: snapshot.terms ? String(snapshot.terms) : undefined,
    notes: snapshot.notes ? String(snapshot.notes) : undefined,
    totalCandidature: snapshot.totalCandidature !== undefined ? Number(snapshot.totalCandidature) : undefined,
    assessmentSpec: snapshot.assessmentSpec ? String(snapshot.assessmentSpec) : undefined,
    chargePerCandidate: snapshot.chargePerCandidate !== undefined ? Number(snapshot.chargePerCandidate) : undefined,
    assessmentSittings: snapshot.assessmentSittings ? String(snapshot.assessmentSittings) : undefined,
    printSpecSummary: snapshot.printSpecSummary ? String(snapshot.printSpecSummary) : undefined,
    printPaperSummary: snapshot.printPaperSummary ? String(snapshot.printPaperSummary) : undefined,
    printColorSummary: snapshot.printColorSummary ? String(snapshot.printColorSummary) : undefined,
    printTypeSummary: snapshot.printTypeSummary ? String(snapshot.printTypeSummary) : undefined,
    printFinishing: snapshot.printFinishing ? String(snapshot.printFinishing) : undefined,
    printPackaging: snapshot.printPackaging ? String(snapshot.printPackaging) : undefined,
    printOrientation: snapshot.printOrientation ? String(snapshot.printOrientation) : undefined,
    pricingRulesSummary: snapshot.pricingRulesSummary ? String(snapshot.pricingRulesSummary) : undefined,
    deliveryTermsSummary: snapshot.deliveryTermsSummary ? String(snapshot.deliveryTermsSummary) : undefined,
    deliveryMethod: snapshot.deliveryMethod ? String(snapshot.deliveryMethod) : undefined,
    deliveryTimeline: snapshot.deliveryTimeline ? String(snapshot.deliveryTimeline) : undefined,
    deliveryAddress: snapshot.deliveryAddress ? String(snapshot.deliveryAddress) : undefined,
    deliveryNotes: snapshot.deliveryNotes ? String(snapshot.deliveryNotes) : undefined,
    vatAmount: Number(snapshot.vatAmount) > 0 ? Number(snapshot.vatAmount) : undefined,
    signatures: (snapshot.signatures as PrintingContractDocData['signatures']) || { company: null, customer: null },
    fullySigned: Boolean(snapshot.fullySigned),
    issuedInvoiceId: snapshot.issuedInvoiceId ? String(snapshot.issuedInvoiceId) : undefined,
  };
  if (!doc.contractNumber) throw new Error('Contract number is required to build the document.');
  const contentHash = await hashContractContent(stableStringify(snapshot));
  return { ...doc, contentHash, integrityShortCode: contractShortCode(contentHash) };
};

// ─── Customer document: Contract Schedule (§2) ────────────────────────

export interface PrintingContractScheduleLine {
  sequence: number;
  assessmentName: string;
  grade?: string;
  subject?: string;
  assessmentDate?: string;
  status: string;
  unitPrice: number;
}

export interface PrintingContractScheduleDocData {
  documentType: 'printing_contract_schedule';
  verificationToken?: string;
  contractNumber: string;
  date: string;
  version: number;
  status: string;
  customerName: string;
  schoolName?: string;
  schoolZone?: string;
  customerPhone?: string;
  /**
   * Billed branch: the customer sub-account this contract is billed to, or
   * the main account. Always present — never a blank line on the schedule.
   */
  billedBranch?: string;
  /**
   * Academic year (e.g. "2026/27"): recorded on the contract, else derived
   * from the contract window. Absent only when neither is available.
   */
  academicYear?: string;
  periodStart?: string;
  periodEnd?: string;
  schedule: PrintingContractScheduleLine[];
  /**
   * Every row on the schedule, including cancelled ones. Kept as the raw
   * table size; `activeAssessments` is the entitlement that is still live.
   */
  totalAssessments: number;
  /** Rows that are not cancelled — the assessments the contract still owns. */
  activeAssessments: number;
  scheduleComplete: boolean;
  missingDateSequences: number[];
  /** Dated, non-cancelled rows — what "Scheduled" actually means. */
  scheduledCount: number;
  /** Non-cancelled rows that carry no scheduled date. */
  undatedCount: number;
  consumedCount: number;
  releasedCount: number;
  cancelledCount: number;
  prepaidAmount: number;
  reservedAmount: number;
  consumedAmount: number;
  /**
   * Commercial available balance: `prepaid − reserved − consumed` from the
   * synchronized contract figures. The persisted
   * `assessment_contracts.available_funds` generated column is honoured only
   * when it agrees with that formula (`availableFundsSource === 'generated'`);
   * otherwise the formula wins and the disagreement is disclosed in
   * `fundInconsistencies`. Never clamped, never silently replaced with zero.
   */
  availableFunds: number;
  /** Whether the persisted generated column agreed with the formula. */
  availableFundsSource: 'generated' | 'derived';
  /** True when the fund position is internally consistent (see `fundInconsistencies`). */
  fundPositionConsistent: boolean;
  /** Explicit, human-readable fund inconsistencies. Empty when consistent. */
  fundInconsistencies: string[];
  /** Value of the non-cancelled rows — the schedule value the contract still holds. */
  totalValue: number;
  /** Value of the cancelled rows, excluded from `totalValue` but still disclosed. */
  cancelledValue: number;
  /** Hash rule version: 1 = legacy (whole doc incl. volatile metadata), 2 = stable content only. */
  hashVersion: number;
  totalCandidature?: number;
  assessmentSpec?: string;
  chargePerCandidate?: number;
  assessmentSittings?: string;
  terms?: string;
  notes?: string;
  /**
   * Assessments scheduled OUTSIDE the contract period. Disclosed, never
   * corrected: the date on the document is the date on the assessment.
   * Absent when every dated assessment falls inside the period.
   */
  outOfPeriodRows?: Array<{
    sequence: number;
    assessmentName: string;
    assessmentDate: string;
    reason: 'before_period_start' | 'after_period_end';
  }>;
  /**
   * Rows whose recorded price disagrees with `candidature × charge per
   * candidate` under a per-candidate pricing model. Disclosed, never corrected.
   * Absent when the contract carries no pricing basis or every row agrees.
   */
  pricingMismatches?: Array<{
    sequence: number;
    assessmentName: string;
    expected: number;
    recorded: number;
  }>;
  /**
   * Value of the assessments whose reservation was RELEASED back to the
   * balance. It is part of the available balance, not an addition to it.
   * Absent when nothing was released.
   */
  releasedAmount?: number;
  /**
   * The issued version's own identity (`SCH-<contract>-v<n>`). Injected once
   * the version number exists — it is allocated AFTER the content is hashed —
   * and excluded from the hash as volatile metadata.
   */
  documentId?: string;
  /** The issued version's own version number. Excluded from the hash. */
  documentVersion?: number;
  contentHash: string;
}

export interface BuildContractScheduleInput {
  contract: AssessmentContract;
  items: AssessmentContractItem[];
  customerName: string;
  schoolName?: string;
  /**
   * Persisted issue instant of the issued version (`ContractDocument.issuedAt`).
   * Required for a stable hash and a truthful "Issued" line — the builder never
   * substitutes the current time. Absent for a transient (unissued) preview.
   */
  issuedAtIso?: string;
  /**
   * Verification token of the PERSISTED schedule version. Deliberately not
   * defaulted to the parent contract's token: a schedule must verify as its own
   * issued version, not as the contract it belongs to.
   */
  verificationToken?: string;
}

/**
 * Hash rule version 2 — the stable content envelope for a schedule.
 *
 * Volatile metadata (the issue date, the random per-version verification token
 * and the generated QR bytes) is excluded so that unchanged canonical content
 * hashes identically across repeated renders. Everything material — assessment
 * names, dates, statuses, amounts, counts and the authoritative fund position —
 * stays inside the hash.
 *
 * Version 1 (legacy) hashed the whole document including volatile metadata;
 * historical rows are still verified with that rule because they carry no
 * `hashVersion` marker. See `verifyPersistedDocument`.
 */
export const SCHEDULE_HASH_VERSION = 2;

/**
 * Volatile metadata excluded from the schedule hash.
 *
 * `documentId` / `documentVersion` are the ISSUED VERSION's identity. They are
 * allocated AFTER the content is hashed (the idempotency check compares digests
 * before the version number is known), so they can never be covered by the
 * digest — they are injected into the stored content once the version exists
 * and are excluded here so the hash still covers exactly the agreed content.
 *
 * MUST stay identical to the backend's list (`backend/services/documentIntegrity.cjs`)
 * or the issuer and the verifier would compute different digests.
 */
export const SCHEDULE_VOLATILE_HASH_KEYS = [
  'contentHash', 'date', 'verificationToken', 'securityQrPayload', 'securityQrCodeDataUrl',
  'documentId', 'documentVersion',
] as const;

/**
 * Legacy date formatting kept ONLY for the completion-receipt builder, which
 * still renders through `formatDateOnly` on the PDF side. The schedule path
 * uses the canonical ISO helpers in `utils/isoDate` instead.
 */
const toDisplayDateOrEmpty = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleDateString('en-GB');
};

/**
 * Normalise a customer display name before it reaches a customer-facing
 * document. The contract screens assemble names in a few different ways:
 *
 *   "Mtakataka CCAP School (CUST-0033)"  → "Mtakataka CCAP School"
 *   "CUST-0033\nMtakataka CCAP School"   → "Mtakataka CCAP School"
 *   "CUST-0033 Mtakataka CCAP School"    → "Mtakataka CCAP School"
 *   "CUST-0033"                          → "" (an id is not a name)
 *
 * The customer id is an internal key and must never appear on a document, so
 * every caller (ERP preview, auto-issued documents, portal) passes through
 * this one funnel. Only a bracketed trailing token that looks like an id is
 * removed — it must be upper-case/digits/dashes AND contain a digit — so a
 * genuine qualifier such as "St Mary's (Blantyre)" survives untouched.
 */
export const stripCustomerIdSuffix = (name: string): string => {
  let out = String(name || '').trim();
  if (!out) return '';
  // "Name (CUST-0033)" / "Name (ABC-123)" — trailing bracketed id.
  out = out.replace(/\s*\((?=[A-Z0-9-]*\d)[A-Z0-9-]{2,}\)\s*$/i, '').trim();
  // "CUST-0033\nName" / "CUST-0033 - Name" — leading id line or prefix.
  out = out.replace(/^CUST-\d{3,}\s*(?:[\r\n]+|[-–—:|]\s*|\s+)/i, '').trim();
  // "Name\nCUST-0033" / "Name - CUST-0033" / "Name CUST-0033" — trailing id.
  out = out.replace(/(?:[\r\n]+|[-–—:|]\s*|\s+)CUST-\d{3,}\s*$/i, '').trim();
  // A value that is only the id carries no display name at all.
  if (/^CUST-\d{3,}$/i.test(out)) return '';
  // Display names print on one line: fold any leftover line breaks.
  return out.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
};

/**
 * Resolve the customer name printed on a contract document, falling back to
 * the school name when the denormalised customer name is missing or is only
 * the internal id. This is the resolver both the document builders and the
 * renderer use, so an already-issued document whose stored name is just
 * "CUST-0033" still prints the school name without mutating hashed content.
 */
export const resolveCustomerDisplayName = (
  customerName?: string | null,
  schoolName?: string | null,
): string =>
  stripCustomerIdSuffix(String(customerName || ''))
  || stripCustomerIdSuffix(String(schoolName || ''));

/** Label printed when the contract is billed to the customer's main account. */
const BILLED_BRANCH_MAIN = 'Main Account';

/**
 * Billed branch of the contract: the customer sub-account the work is billed
 * to (e.g. "Examination") or the main account.
 *
 * Customers carry their branches in `subAccounts`; records denote the chosen
 * one by name — the exact convention invoices, examination batches and job
 * tickets already follow (`sub_account_name`). Absent, blank or "main" means
 * the main account, so the schedule always prints the billed branch rather
 * than a blank line.
 */
const resolveBilledBranch = (data: Record<string, any>): string => {
  const raw = data?.sub_account_name ?? data?.subAccountName ?? data?.billed_branch ?? '';
  const label = String(raw || '').trim();
  if (!label || isMainBranchValue(label)) return BILLED_BRANCH_MAIN;
  return label;
};

/**
 * Academic year printed on the schedule.
 *
 * Recorded explicitly on the contract when the user sets it. Otherwise it is
 * derived from the contract window (19 Oct 2026 → "2026/27") so a contract
 * created before the field existed still prints a year instead of a blank.
 * Malawian academic years open in the year the engagement starts.
 */
const resolveAcademicYear = (data: Record<string, any>, periodStart?: string): string | undefined => {
  const explicit = String(data?.academic_year ?? data?.academicYear ?? '').trim();
  if (explicit) return explicit;
  // Derive from the CANONICAL date-only value, never `new Date(...).getFullYear()`
  // — that reads the local timezone, so a 1 Jan engagement would silently
  // resolve to the previous year west of UTC.
  const iso = toIsoDateOnly(periodStart);
  if (!iso) return undefined;
  const year = Number(iso.slice(0, 4));
  const nextYear = year + 1;
  const nextYearShort = nextYear % 100 === 0 ? String(nextYear) : String(nextYear % 100).padStart(2, '0');
  return `${year}/${nextYearShort}`;
};

/**
 * Customer-facing assessment schedule for a printing contract: every
 * contractual assessment with its sequence, scheduled date, specification and
 * lifecycle state, plus schedule completeness and the authoritative fund
 * position.
 *
 * Correctness rules (Phase 2):
 *  - Dates stay canonical (`YYYY-MM-DD`) all the way to the render boundary and
 *    are sorted chronologically as values, never as display strings.
 *  - A missing or invalid date is reported (missingDateSequences), never
 *    substituted with the current date.
 *  - "Scheduled" counts dated, non-cancelled assessments — not a status bucket.
 *  - Cancelled assessments are excluded from the active schedule value and the
 *    scheduled count, and are disclosed separately (cancelledValue).
 *  - Available funds are derived from the synchronized contract figures
 *    (`prepaid − reserved − consumed`); the stale generated column is trusted
 *    only when it agrees, and every disagreement is surfaced — never clamped.
 *  - The issue date comes from the persisted version; volatile metadata is
 *    excluded from the hash so unchanged content hashes identically.
 */
export const buildContractScheduleDoc = async (
  input: BuildContractScheduleInput,
): Promise<PrintingContractScheduleDocData> => {
  const { contract, items } = input;
  if (!contract) throw new Error('Contract is required to build the schedule.');
  const contractNumber = String(contract.contract_number || '').trim();
  if (!contractNumber) throw new Error('Contract number is required to build the schedule.');

  const rows = (items || [])
    .filter((it) => String(it.contract_id || '') === String(contract.id || contractNumber))
    .map((it) => ({
      assessmentName: String(it.assessment_name || 'Assessment').trim(),
      grade: String(it.assessment_grade || '').trim() || undefined,
      subject: String(it.assessment_subject || '').trim() || undefined,
      // Canonical ISO date-only (or undefined). Never a locale display string.
      assessmentDate: toIsoDateOnly(it.assessment_date),
      status: String(it.status || 'reserved'),
      unitPrice: roundMoney(Math.max(0, Number(it.item_price) || 0)),
    }))
    .sort((a, b) => compareIsoDateOnly(
      a.assessmentDate,
      b.assessmentDate,
      // Dated rows sort chronologically; undated rows trail in a stable,
      // name-then-status order so sequence numbering never churns.
      () => a.assessmentName.localeCompare(b.assessmentName) || a.status.localeCompare(b.status),
    ))
    .map((row, index) => ({ ...row, sequence: index + 1 }));

  // Cancelled assessments are not part of the agreed schedule: they must not
  // drive the completeness banner, the "Scheduled" count or the schedule value.
  const isCancelledRow = (status: string) => ['cancelled', 'canceled', 'void', 'voided'].includes(status);
  const activeRows = rows.filter((r) => !isCancelledRow(r.status));
  const cancelledRows = rows.filter((r) => isCancelledRow(r.status));

  const missingDateSequences = activeRows
    .filter((r) => !r.assessmentDate)
    .map((r) => r.sequence);
  const countBy = (status: string) => rows.filter((r) => r.status === status).length;
  const prepaid = roundMoney(Number(contract.prepaid_amount) || 0);
  const reserved = roundMoney(Number(contract.reserved_amount) || 0);
  const consumedAmount = roundMoney(Number(contract.consumed_amount) || 0);
  const profile = (contract as any)?.data || {};

  // ── Fund position ────────────────────────────────────────────────────
  // The authoritative value is `prepaid − reserved − consumed` computed from the
  // synchronized contract figures. `assessment_contracts.available_funds` is a
  // GENERATED column over those same three top-level fields, so it carries no
  // independent information: once migration 0039 made the envelope the system of
  // record, the top-level columns stopped being populated and the generated
  // column now reads a stale 0 while the envelope holds the real position.
  //
  // The formula is therefore ALWAYS the source of the displayed balance; the
  // persisted column is honoured (reported as `generated`) only when it AGREES
  // with the formula. A disagreement — the production regression — is surfaced
  // explicitly with the derived value shown, never silently trusted as 0 and
  // never clamped. Nothing here mutates any financial record.
  const rawPersisted = (contract as any)?.available_funds;
  const hasPersisted = rawPersisted !== undefined
    && rawPersisted !== null
    && rawPersisted !== ''
    && Number.isFinite(Number(rawPersisted));
  const derivedAvailable = roundMoney(prepaid - reserved - consumedAmount);
  const persistedValue = hasPersisted ? roundMoney(Number(rawPersisted)) : null;
  const persistedAgrees = persistedValue !== null && Math.abs(persistedValue - derivedAvailable) <= 0.005;
  const availableFunds = derivedAvailable;
  const availableFundsSource: 'generated' | 'derived' = persistedAgrees ? 'generated' : 'derived';

  const reservedItemsValue = roundMoney(activeRows
    .filter((r) => r.status === 'reserved')
    .reduce((sum, r) => sum + r.unitPrice, 0));
  // A RELEASED assessment is not an entitlement: the reservation was returned
  // to the balance, so its value is part of the available funds — it is never
  // added to them. It is disclosed separately, never folded into the schedule
  // value the contract still owes.
  const releasedItemsValue = roundMoney(activeRows
    .filter((r) => r.status === 'released')
    .reduce((sum, r) => sum + r.unitPrice, 0));
  const fundInconsistencies: string[] = [];
  // The close path records what it released independently of the item list, so
  // the two can be compared. A disagreement is a real drift between two
  // records; it is disclosed, never reconciled.
  const closureReleasedValue = Number((profile as any)?.closure?.releasedValue);
  if (releasedItemsValue > 0
    && Number.isFinite(closureReleasedValue)
    && Math.abs(closureReleasedValue - releasedItemsValue) > 0.005) {
    fundInconsistencies.push(
      `released assessments total (${releasedItemsValue}) disagrees with the recorded closure release (${closureReleasedValue}).`,
    );
  }
  if (persistedValue !== null && !persistedAgrees) {
    fundInconsistencies.push(
      `persisted available_funds (${persistedValue}) disagrees with the synchronized prepaid − reserved − consumed (${derivedAvailable}); the derived balance is shown.`,
    );
  }
  if (Math.abs(reserved - reservedItemsValue) > 0.005) {
    fundInconsistencies.push(
      `reserved_amount bucket (${reserved}) disagrees with the canonical reserved assessments (${reservedItemsValue}).`,
    );
  }
  if (availableFunds < 0) {
    fundInconsistencies.push(`available funds are negative (${availableFunds}).`);
  }
  // NOTE: the consumed bucket is deliberately NOT cross-checked against the
  // consumed items. A consumed assessment can legitimately leave no visible
  // item (archived, or settled outside the item list), so the check would
  // raise a "needs review" banner on a correct document. Only the reservation
  // bucket is corroborated, and only against items that are actually present.

  // ── Scheduled dates against the contract period ───────────────────────
  // The document states a period ("19 Oct 2026 – 30 Apr 2027") and a set of
  // assessment dates. A date outside that window is a disagreement between two
  // facts printed side by side, so it is DISCLOSED on the document — never
  // silently corrected, and never used to rewrite the assessment.
  //
  // The period bounds are canonicalised first: the contract stores them as ISO
  // instants (`2027-04-30T00:00:00.000Z`), and comparing a calendar date with
  // an instant is the same class of defect the whole date work removed.
  const periodStartIso = toIsoDateOnly(contract.starts_at);
  const periodEndIso = toIsoDateOnly(contract.ends_at);
  const outOfPeriodRows = activeRows
    .filter((r) => !!r.assessmentDate)
    .filter((r) => isIsoDateWithin(r.assessmentDate, periodStartIso, periodEndIso) === false)
    .map((r) => ({
      sequence: r.sequence,
      assessmentName: r.assessmentName,
      assessmentDate: r.assessmentDate as string,
      reason: (periodEndIso && (r.assessmentDate as string) > periodEndIso
        ? 'after_period_end'
        : 'before_period_start') as 'before_period_start' | 'after_period_end',
    }));

  // ── Pricing basis ─────────────────────────────────────────────────────
  // Under a per-candidate pricing model the assessment price is derived:
  // `candidature × charge per candidate`. The document prints the recorded
  // price AND the pricing basis side by side, so a disagreement between them
  // must be visible. Only applied when the contract actually records a
  // per-candidate model and both factors — the very numbers the customer sees
  // — are present, so a contract priced per line is never flagged.
  const contractProfile = readContractProfile(profile);
  const pricingModel = String(contractProfile.pricingRules?.model || '').trim().toLowerCase();
  const perCandidateModel = pricingModel === 'per_candidate' || pricingModel === 'per candidate';
  const printedCandidature = Number(profile.total_candidature);
  const printedCharge = Number(profile.charge_per_candidate);
  const expectedUnitPrice = perCandidateModel
    && Number.isFinite(printedCandidature) && printedCandidature > 0
    && Number.isFinite(printedCharge) && printedCharge > 0
    ? roundMoney(printedCandidature * printedCharge)
    : undefined;
  const pricingMismatches = expectedUnitPrice === undefined
    ? []
    : activeRows
      .filter((r) => Math.abs(r.unitPrice - expectedUnitPrice) > 0.005)
      .map((r) => ({
        sequence: r.sequence,
        assessmentName: r.assessmentName,
        expected: expectedUnitPrice,
        recorded: r.unitPrice,
      }));

  // The schedule value the contract STILL OWES: every live assessment except
  // the ones whose reservation was released (returned to the balance) and the
  // cancelled ones. A released assessment stays on the schedule as a row, but
  // its value is no longer part of the entitlement — the money is back in the
  // available balance, and counting it twice would misstate the position.
  const totalValue = roundMoney(activeRows
    .filter((r) => r.status !== 'released')
    .reduce((sum, r) => sum + r.unitPrice, 0));
  const cancelledValue = roundMoney(cancelledRows.reduce((sum, r) => sum + r.unitPrice, 0));

  const doc: Omit<PrintingContractScheduleDocData, 'contentHash'> = {
    documentType: 'printing_contract_schedule',
    // The PERSISTED version's token — never the parent contract's token, which
    // would make a schedule verify as the contract rather than as its own
    // issued version.
    verificationToken: String(input.verificationToken || '').trim() || undefined,
    contractNumber,
    // Persisted issue date, or '' for a transient (unissued) preview. The
    // current time is never substituted.
    date: toIsoDateOnlyOrEmpty(input.issuedAtIso),
    version: Number(contract.version) || 1,
    status: String(contract.status || 'draft'),
    customerName: resolveCustomerDisplayName(input.customerName, input.schoolName) || 'Customer',
    schoolName: stripCustomerIdSuffix(String(input.schoolName || '')) || undefined,
    schoolZone: String((contract as any)?.data?.school_zone || (contract as any)?.data?.zone || '').trim() || undefined,
    customerPhone: String((contract as any)?.data?.customer_phone || (contract as any)?.data?.phone || '').trim() || undefined,
    billedBranch: resolveBilledBranch(profile),
    academicYear: resolveAcademicYear(profile, contract.starts_at || contract.ends_at),
    periodStart: contract.starts_at || undefined,
    periodEnd: contract.ends_at || undefined,
    schedule: rows,
    totalAssessments: rows.length,
    activeAssessments: activeRows.length,
    scheduleComplete: missingDateSequences.length === 0,
    missingDateSequences,
    scheduledCount: activeRows.filter((r) => !!r.assessmentDate).length,
    undatedCount: missingDateSequences.length,
    consumedCount: countBy('consumed'),
    releasedCount: countBy('released'),
    cancelledCount: cancelledRows.length,
    prepaidAmount: prepaid,
    reservedAmount: reserved,
    consumedAmount,
    availableFunds,
    availableFundsSource,
    fundPositionConsistent: fundInconsistencies.length === 0,
    fundInconsistencies,
    totalValue,
    cancelledValue,
    hashVersion: SCHEDULE_HASH_VERSION,
    totalCandidature: profile.total_candidature !== undefined ? Number(profile.total_candidature) : undefined,
    assessmentSpec: profile.assessment_spec || undefined,
    chargePerCandidate: profile.charge_per_candidate !== undefined ? Number(profile.charge_per_candidate) : undefined,
    assessmentSittings: profile.assessment_sittings || undefined,
    terms: String(contract.terms || '').trim() || undefined,
    notes: String(contract.notes || '').trim() || undefined,
    // Disclosed exceptions. Omitted entirely when there are none, so a clean
    // contract keeps byte-identical content — and therefore the same digest,
    // and the same issued version.
    outOfPeriodRows: outOfPeriodRows.length ? outOfPeriodRows : undefined,
    pricingMismatches: pricingMismatches.length ? pricingMismatches : undefined,
    releasedAmount: releasedItemsValue > 0 ? releasedItemsValue : undefined,
  };
  const contentHash = await hashStableScheduleContent(doc);
  return { ...doc, contentHash };
};

/**
 * Drop every key whose value is `undefined`, recursively.
 *
 * WHY THIS EXISTS: `stableStringify` renders an absent value as the literal
 * `null`, but JSONB DROPS a key whose value is `undefined`. Hashing the
 * pre-serialisation document therefore produced a digest the verifier could
 * never reproduce, because the verifier hashes the STORED content (where those
 * keys are gone). Every schedule with an absent optional field — no school
 * name, no notes, no phone, no candidature — was born unverifiable: the public
 * verification page reported it as altered, and the device that issued it
 * failed its own integrity check.
 *
 * Pruning makes the hashed shape and the persisted shape identical, so the
 * issuer, the local verifier and the server all compute the same digest.
 */
export const pruneUndefined = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => pruneUndefined(entry));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue;
      out[key] = pruneUndefined(entry);
    }
    return out;
  }
  return value;
};

/**
 * Hash the STABLE content envelope of a schedule: the document with its
 * volatile metadata removed (see SCHEDULE_VOLATILE_HASH_KEYS) and with the
 * absent optional keys pruned exactly as persistence drops them. Two renders of
 * unchanged canonical content therefore produce the same digest, while any
 * material change — a date, a status, an amount, a count, the fund position —
 * changes it. Shared with `verifyPersistedDocument` so the two can never
 * disagree about what the hash covers.
 */
export const stableScheduleHashInput = (
  doc: Record<string, unknown>,
): Record<string, unknown> => {
  const out = pruneUndefined({ ...doc }) as Record<string, unknown>;
  for (const key of SCHEDULE_VOLATILE_HASH_KEYS) delete out[key];
  return out;
};

export const hashStableScheduleContent = async (
  doc: Record<string, unknown>,
): Promise<string> => hashContractContent(stableStringify(stableScheduleHashInput(doc)));

/**
 * Legacy hash rule (version 1) — the input shape the pre-Phase-2 builders
 * (`HEAD`) hashed.
 *
 * `stableStringify` serialises an absent/`undefined` value as the literal
 * `null`, but JSONB persistence DROPS keys whose value is `undefined`. A row
 * written by the old builder therefore re-hashes differently unless those
 * dropped optional keys are restored as `null` before hashing. `delete
 * contentHash` alone is NOT the legacy rule: the Phase 2B audit proved it
 * reproduces neither the live historical schedule nor the live receipt.
 *
 * The lists below are exactly the optional keys of the HEAD builders. A key is
 * restored to `null` ONLY when it is absent, so a row that always carried the
 * key hashes exactly as it did at issue; required keys are never invented and
 * newer keys (e.g. `activeAssessments`, `hashVersion`) are never added to a
 * legacy input.
 */
export const LEGACY_SCHEDULE_OPTIONAL_HASH_KEYS = [
  'verificationToken', 'schoolName', 'schoolZone', 'customerPhone', 'academicYear',
  'periodStart', 'periodEnd', 'totalCandidature', 'assessmentSpec',
  'chargePerCandidate', 'assessmentSittings', 'terms', 'notes',
] as const;

export const LEGACY_RECEIPT_OPTIONAL_HASH_KEYS = [
  'verificationToken', 'schoolName', 'notes',
] as const;

const LEGACY_SCHEDULE_ROW_OPTIONAL_HASH_KEYS = ['grade', 'subject', 'assessmentDate'] as const;
const LEGACY_RECEIPT_ITEM_OPTIONAL_HASH_KEYS = ['grade', 'subject', 'consumedAt'] as const;

const restoreNullKeys = (obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...obj };
  for (const key of keys) if (!(key in out)) out[key] = null;
  return out;
};

/** Reconstructed legacy hash input for a schedule (never mutates `content`). */
export const legacyScheduleHashInput = (
  content: Record<string, unknown>,
): Record<string, unknown> => {
  const out = restoreNullKeys(content, LEGACY_SCHEDULE_OPTIONAL_HASH_KEYS);
  delete out.contentHash;
  if (Array.isArray(out.schedule)) {
    out.schedule = (out.schedule as unknown[]).map((row) =>
      row && typeof row === 'object'
        ? restoreNullKeys(row as Record<string, unknown>, LEGACY_SCHEDULE_ROW_OPTIONAL_HASH_KEYS)
        : row);
  }
  return out;
};

/** Reconstructed legacy hash input for a completion receipt (never mutates). */
export const legacyReceiptHashInput = (
  content: Record<string, unknown>,
): Record<string, unknown> => {
  const out = restoreNullKeys(content, LEGACY_RECEIPT_OPTIONAL_HASH_KEYS);
  delete out.contentHash;
  if (out.item && typeof out.item === 'object') {
    out.item = restoreNullKeys(out.item as Record<string, unknown>, LEGACY_RECEIPT_ITEM_OPTIONAL_HASH_KEYS);
  }
  return out;
};

export const hashLegacyScheduleContent = async (
  content: Record<string, unknown>,
): Promise<string> => hashContractContent(stableStringify(legacyScheduleHashInput(content)));

export const hashLegacyReceiptContent = async (
  content: Record<string, unknown>,
): Promise<string> => hashContractContent(stableStringify(legacyReceiptHashInput(content)));

// ─── Customer document: Assessment Completion Receipt (§3) ────────────

export interface PrintingContractCompletionLine {
  assessmentName: string;
  grade?: string;
  subject?: string;
  consumedAt?: string;
  unitPrice: number;
}

export interface PrintingContractCompletionReceiptDocData {
  documentType: 'printing_contract_completion_receipt';
  verificationToken?: string;
  receiptNumber: string;
  contractNumber: string;
  date: string;
  version: number;
  status: string;
  customerName: string;
  schoolName?: string;
  academicYear: string;
  item: PrintingContractCompletionLine;
  sequence: number;
  totalAssessments: number;
  completedToDate: number;
  remainingAssessments: number;
  contractValue: number;
  amountDebited: number;
  totalConsumedToDate: number;
  remainingReservedFunds: number;
  unallocatedFunds: number;
  walletBalanceAfter: number;
  walletTransactionId: string;
  ledgerEntryId: string;
  notes?: string;
  contentHash: string;
}

export interface BuildContractCompletionReceiptInput {
  contract: AssessmentContract;
  item: AssessmentContractItem;
  items: AssessmentContractItem[];
  sequence: number;
  amountDebited: number;
  walletBalanceAfter: number;
  walletTransactionId: string;
  ledgerEntryId: string;
  customerName: string;
  schoolName?: string;
  consumedAtIso?: string;
  issuedAtIso?: string;
}

/**
 * Customer-facing completion receipt for ONE consumed assessment:
 * the completed assessment with its consumption timestamp, the
 * completion progress against the contractual entitlement, the
 * debit just recognised and the resulting prepaid fund position.
 * Only a genuinely consumed assessment yields a receipt — a
 * reserved (not yet consumed) assessment never does. Hashed like
 * the contract so the printed receipt is tamper-evident and
 * verifiable.
 */
export const buildAssessmentCompletionReceiptDoc = async (
  input: BuildContractCompletionReceiptInput,
): Promise<PrintingContractCompletionReceiptDocData> => {
  const { contract, item, items } = input;
  if (!contract) throw new Error('Contract is required to build the completion receipt.');
  const contractNumber = String(contract.contract_number || '').trim();
  if (!contractNumber) throw new Error('Contract number is required to build the completion receipt.');
  if (!item) throw new Error('A consumed assessment item is required to build the completion receipt.');
  if (String(item.status || '') !== 'consumed') {
    throw new Error(`buildAssessmentCompletionReceiptDoc: completion receipt requires a consumed assessment (item ${String(item.id || '')} is '${item.status || 'unknown'}').`);
  }

  const contractItems = (items || []).filter(
    (it) => String(it.contract_id || '') === String(contract.id || contractNumber),
  );
  const consumedItems = contractItems.filter((it) => String(it.status || '') === 'consumed');
  const completedToDate = consumedItems.length;
  const totalAssessments = Math.max(0, Math.floor(Number(contract.max_assessments) || 0));
  const contractValue = roundMoney(Number(contract.prepaid_amount) || 0);
  const totalConsumedToDate = roundMoney(Number(contract.consumed_amount) || 0);
  const remainingReservedFunds = roundMoney(Number(contract.reserved_amount) || 0);

  const doc: Omit<PrintingContractCompletionReceiptDocData, 'contentHash'> = {
    documentType: 'printing_contract_completion_receipt',
    verificationToken: String((contract as any)?.verificationToken || '').trim() || undefined,
    receiptNumber: `PCR-${contractNumber}`,
    contractNumber,
    date: toDisplayDate(input.issuedAtIso),
    version: Number(contract.version) || 1,
    status: String(contract.status || 'draft'),
    // The customer id is an internal key: the contract screens may assemble
    // the display name as "Mtakataka CCAP School (CUST-0033)" or fall back to
    // the bare id. That id must never reach a customer-facing receipt, so
    // resolve the name (falling back to the school) before hashing.
    customerName: resolveCustomerDisplayName(input.customerName, input.schoolName) || 'Customer',
    schoolName: stripCustomerIdSuffix(String(input.schoolName || '')) || undefined,
    // Academic year of the engagement — recorded on the contract, else derived
    // from its window (same rule as the schedule). ALWAYS a defined string:
    // this field is covered by the content hash and JSONB drops undefined
    // keys, so an absent key would re-hash differently from the issued
    // document and break verification.
    academicYear: resolveAcademicYear((contract as any)?.data || {}, contract.starts_at || contract.ends_at) || '',
    item: {
      assessmentName: String(item.assessment_name || 'Assessment').trim(),
      grade: String(item.assessment_grade || '').trim() || undefined,
      subject: String(item.assessment_subject || '').trim() || undefined,
      consumedAt: toDisplayDateOrEmpty(input.consumedAtIso || item.consumed_at),
      unitPrice: roundMoney(Math.max(0, Number(item.item_price) || 0)),
    },
    sequence: Math.max(1, Math.floor(Number(input.sequence) || completedToDate)),
    totalAssessments,
    completedToDate,
    remainingAssessments: Math.max(0, totalAssessments - completedToDate),
    contractValue,
    amountDebited: roundMoney(Number(input.amountDebited) || 0),
    totalConsumedToDate,
    remainingReservedFunds,
    unallocatedFunds: roundMoney(Math.max(0, contractValue - totalConsumedToDate - remainingReservedFunds)),
    walletBalanceAfter: roundMoney(Number(input.walletBalanceAfter) || 0),
    walletTransactionId: String(input.walletTransactionId || ''),
    ledgerEntryId: String(input.ledgerEntryId || ''),
    notes: String(contract.notes || '').trim() || undefined,
  };
  const contentHash = await hashContractContent(stableStringify(doc));
  return { ...doc, contentHash };
};

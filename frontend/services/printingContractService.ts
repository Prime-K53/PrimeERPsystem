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
  pricingRulesSummary?: string;
  deliveryTermsSummary?: string;
  signatures: {
    company: PrintingContractSignatureBlock | null;
    customer: PrintingContractSignatureBlock | null;
  };
  fullySigned: boolean;
  contentHash: string;
  issuedInvoiceId?: string;
}

export interface BuildPrintingContractDocInput {
  contract: AssessmentContract;
  customerName: string;
  schoolName?: string;
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

export const buildPrintingContractDoc = async (
  input: BuildPrintingContractDocInput,
): Promise<PrintingContractDocData> => {
  const { contract } = input;
  if (!contract) throw new Error('Contract is required to build the document.');
  const lines = mapLines(contract);
  const company = mapSignatureBlock((contract.data as any)?.signatures?.company);
  const customer = mapSignatureBlock((contract.data as any)?.signatures?.customer);
  const profile = readContractProfile((contract as any)?.data);
  const printSpecSummary = summarisePrintSpec(profile.printSpec) || undefined;
  const pricingBits = [
    profile.pricingRules.model ? String(profile.pricingRules.model).replace(/_/g, ' ') : '',
    profile.pricingRules.chargePerCandidate !== undefined ? `Charge per candidate: ${roundMoney(profile.pricingRules.chargePerCandidate)}` : '',
    profile.pricingRules.discount ? `Discount: ${profile.pricingRules.discount}` : '',
    profile.pricingRules.urgentFee ? `Urgent: ${profile.pricingRules.urgentFee}` : '',
    profile.pricingRules.taxHandling,
    profile.pricingRules.rulesNotes,
  ].filter((s) => String(s || '').trim()).join(' · ') || undefined;
  const deliveryBits = [
    profile.delivery.method,
    profile.delivery.timeline,
    profile.delivery.address,
    profile.delivery.packaging ? `Pack: ${profile.delivery.packaging}` : '',
    profile.delivery.deliveryNotes,
  ].filter((s) => String(s || '').trim()).join(' · ') || undefined;
  const doc: Omit<PrintingContractDocData, 'contentHash'> = {
    documentType: 'printing_contract',
    verificationToken: String((contract as any)?.verificationToken || '').trim() || undefined,
    contractNumber: String(contract.contract_number || '').trim(),
    date: toDisplayDate(input.issuedAtIso),
    version: Number(contract.version) || 1,
    status: String(contract.status || 'draft'),
    customerName: String(input.customerName || '').trim() || 'Customer',
    schoolName: String(input.schoolName || '').trim() || undefined,
    periodStart: contract.starts_at || undefined,
    periodEnd: contract.ends_at || undefined,
    lines,
    prepaidAmount: roundMoney(Number(contract.prepaid_amount) || 0),
    maxAssessments: Math.max(0, Math.floor(Number(contract.max_assessments) || 0)),
    assessmentPrice: roundMoney(Number(contract.assessment_price) || 0),
    terms: String(contract.terms || '').trim() || undefined,
    notes: String(contract.notes || '').trim() || undefined,
    totalCandidature: profile.candidature.totalCandidature,
    assessmentSpec: profile.candidature.spec?.trim() || undefined,
    chargePerCandidate: profile.pricingRules.chargePerCandidate,
    assessmentSittings: profile.candidature.sittings?.trim() || undefined,
    printSpecSummary,
    pricingRulesSummary: pricingBits,
    deliveryTermsSummary: deliveryBits,
    signatures: { company, customer },
    fullySigned: Boolean(company && customer),
    issuedInvoiceId: String((contract.data as any)?.issued_invoice_id || '').trim() || undefined,
  };
  if (!doc.contractNumber) throw new Error('Contract number is required to build the document.');
  const contentHash = await hashContractContent(stableStringify(doc));
  return { ...doc, contentHash };
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
  return `${year}/${String((year + 1) % 100).padStart(2, '0')}`;
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

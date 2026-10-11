import type { AssessmentContract, AssessmentContractItem } from '../types';
import { roundMoney } from '../utils/roundingUtils';

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
  periodStart?: string;
  periodEnd?: string;
  schedule: PrintingContractScheduleLine[];
  totalAssessments: number;
  scheduleComplete: boolean;
  missingDateSequences: number[];
  scheduledCount: number;
  consumedCount: number;
  releasedCount: number;
  cancelledCount: number;
  prepaidAmount: number;
  reservedAmount: number;
  consumedAmount: number;
  availableFunds: number;
  totalValue: number;
  totalCandidature?: number;
  assessmentSpec?: string;
  chargePerCandidate?: number;
  assessmentSittings?: string;
  terms?: string;
  notes?: string;
  contentHash: string;
}

export interface BuildContractScheduleInput {
  contract: AssessmentContract;
  items: AssessmentContractItem[];
  customerName: string;
  schoolName?: string;
  issuedAtIso?: string;
}

const toDisplayDateOrEmpty = (iso?: string): string | undefined => {
  if (!iso) return undefined;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toLocaleDateString('en-GB');
};

/**
 * Customer-facing assessment schedule for a printing contract: every
 * contractual assessment (one row per reserved entitlement unit) with
 * its sequence, scheduled date, specification and lifecycle state,
 * plus schedule completeness and the prepaid fund position. A schedule
 * is only represented as agreed when every assessment carries a
 * scheduled date — missing dates are reported explicitly
 * (missingDateSequences), never silently substituted. Hashed like the
 * contract so the printed schedule is tamper-evident and verifiable.
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
      assessmentDate: toDisplayDateOrEmpty(it.assessment_date),
      status: String(it.status || 'reserved'),
      unitPrice: roundMoney(Math.max(0, Number(it.item_price) || 0)),
    }))
    .sort((a, b) => {
      // Dated assessments first (chronological), undated last —
      // so sequence numbers stay stable and the missing-date
      // sequences are the trailing rows.
      const da = a.assessmentDate || '9999';
      const db = b.assessmentDate || '9999';
      return da === db ? a.assessmentName.localeCompare(b.assessmentName) : da.localeCompare(db);
    })
    .map((row, index) => ({ ...row, sequence: index + 1 }));

  const missingDateSequences = rows
    .filter((r) => !r.assessmentDate)
    .map((r) => r.sequence);
  const countBy = (status: string) => rows.filter((r) => r.status === status).length;
  const prepaid = roundMoney(Number(contract.prepaid_amount) || 0);
  const reserved = roundMoney(Number(contract.reserved_amount) || 0);
  const consumedAmount = roundMoney(Number(contract.consumed_amount) || 0);
  const profile = (contract as any)?.data || {};
  const doc: Omit<PrintingContractScheduleDocData, 'contentHash'> = {
    documentType: 'printing_contract_schedule',
    verificationToken: String((contract as any)?.verificationToken || '').trim() || undefined,
    contractNumber,
    date: toDisplayDate(input.issuedAtIso),
    version: Number(contract.version) || 1,
    status: String(contract.status || 'draft'),
    customerName: String(input.customerName || '').trim() || 'Customer',
    schoolName: String(input.schoolName || '').trim() || undefined,
    periodStart: contract.starts_at || undefined,
    periodEnd: contract.ends_at || undefined,
    schedule: rows,
    totalAssessments: rows.length,
    scheduleComplete: missingDateSequences.length === 0,
    missingDateSequences,
    scheduledCount: countBy('reserved'),
    consumedCount: countBy('consumed'),
    releasedCount: countBy('released'),
    cancelledCount: countBy('cancelled'),
    prepaidAmount: prepaid,
    reservedAmount: reserved,
    consumedAmount,
    availableFunds: roundMoney(Math.max(0, prepaid - reserved - consumedAmount)),
    totalValue: roundMoney(rows.reduce((sum, r) => sum + r.unitPrice, 0)),
    totalCandidature: profile.total_candidature !== undefined ? Number(profile.total_candidature) : undefined,
    assessmentSpec: profile.assessment_spec || undefined,
    chargePerCandidate: profile.charge_per_candidate !== undefined ? Number(profile.charge_per_candidate) : undefined,
    assessmentSittings: profile.assessment_sittings || undefined,
    terms: String(contract.terms || '').trim() || undefined,
    notes: String(contract.notes || '').trim() || undefined,
  };
  const contentHash = await hashContractContent(stableStringify(doc));
  return { ...doc, contentHash };
};

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
    customerName: String(input.customerName || '').trim() || 'Customer',
    schoolName: String(input.schoolName || '').trim() || undefined,
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

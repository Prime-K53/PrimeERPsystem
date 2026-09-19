import type { AssessmentContract } from '../types';
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

const fnv1a64 = (input: string): string => {
  let hash = BigInt('0xcbf29ce484222325');
  const prime = BigInt('0x100000001b3');
  const mask = BigInt('0xffffffffffffffff');
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
};

/**
 * Tamper-evidence hash over the exact agreed content (parties, lines,
 * totals, terms, both signature blocks including images). Any post-sign
 * change — amounts, terms, or signature swap — yields a different hash.
 * SHA-256 where available; deterministic FNV-1a fallback otherwise.
 */
export const hashContractContent = async (canonicalJson: string): Promise<string> => {
  try {
    const subtle = (globalThis as any)?.crypto?.subtle;
    if (subtle && typeof subtle.digest === 'function') {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson));
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch {
    /* fall through to deterministic fallback */
  }
  return `fnv1a64:${fnv1a64(canonicalJson)}`;
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

import { generateNextId } from './helpers';
import type { AssessmentContract, Invoice } from '../types';

export type ContractStatus = AssessmentContract['status'];

/**
 * Allowed lifecycle edges (DB migration 0006 lifecycle:
 * Draft → Pending Payment → Active → Suspended → Completed/Expired/Cancelled).
 * Single source of truth shared by the view AND the finance store so status
 * jumps cannot bypass the UI by calling the store directly.
 */
export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  draft: ['pending_payment', 'cancelled'],
  pending_payment: ['active', 'cancelled'],
  active: ['suspended', 'completed', 'expired', 'cancelled'],
  suspended: ['active', 'cancelled'],
  completed: [],
  expired: [],
  cancelled: [],
};

export type ContractItemStatus = 'reserved' | 'consumed' | 'released' | 'cancelled';

export const CONTRACT_ITEM_TRANSITIONS: Record<ContractItemStatus, ContractItemStatus[]> = {
  reserved: ['consumed', 'released', 'cancelled'],
  consumed: ['cancelled'],
  released: [],
  cancelled: [],
};

export const isAllowedContractTransition = (
  from: string | undefined,
  to: string | undefined,
): boolean => {
  const edges = (CONTRACT_TRANSITIONS as Record<string, string[]>)[String(from || '')];
  return Array.isArray(edges) && edges.includes(String(to || ''));
};

export const assertAllowedContractTransition = (
  from: string | undefined,
  to: string | undefined,
): void => {
  if (!isAllowedContractTransition(from, to)) {
    throw new Error(`Transition ${String(from)} → ${String(to)} is not allowed.`);
  }
};

export const isAllowedItemTransition = (
  from: string | undefined,
  to: string | undefined,
): boolean => {
  const edges = CONTRACT_ITEM_TRANSITIONS[String(from || '') as ContractItemStatus];
  return Array.isArray(edges) && (edges as string[]).includes(String(to || ''));
};

/**
 * Canonical write-guard for assessment item records (wallet-first model).
 *
 * Financial edges must go through transactionService.consumeContractAssessment,
 * which owns the wallet debit + ledger posting + idempotent reservation.
 * Ordinary writers (UI handlers, store methods) must never flip these edges
 * by direct status mutation:
 *  - reserved → consumed is BLOCKED here (consume via the canonical operation).
 *  - any edge OUT of consumed is BLOCKED here (a consumed assessment already
 *    has exactly one wallet debit behind it; value recovery requires an
 *    explicit compensating reversal, tracked separately — not a status flip).
 * Status-preserving writes (job links, notes, scheduling fields) always pass.
 * Lifecycle-map violations are still rejected with the map error.
 */
export const assertAllowedItemWrite = (
  current: { status?: string } | null | undefined,
  next: { status?: string } | null | undefined,
): void => {
  const from = String(current?.status || '');
  const to = String(next?.status || '');
  if (!current || from === to || !to) return;
  if (from === 'reserved' && to === 'consumed') {
    throw new Error(
      'Direct status mutation reserved → consumed is blocked. Consume assessments only through the canonical wallet-first operation (consumeContractAssessment), which posts exactly one wallet debit and one ledger entry.',
    );
  }
  if (from === 'consumed') {
    throw new Error(
      `Status change consumed → ${to} is blocked. A consumed assessment already has a wallet debit behind it; value recovery requires an explicit compensating reversal (tracked separately), not a status flip.`,
    );
  }
  if (!isAllowedItemTransition(from, to)) {
    throw new Error(`Assessment transition ${from} → ${to} is not allowed.`);
  }
};

/**
 * Canonical write-guard for brand-new assessment items. Items are born
 * reserved; a consumed-at-birth record without a wallet debit behind it
 * would corrupt the one-debit-per-consumption invariant.
 */
export const assertAllowedItemCreate = (next: { status?: string } | null | undefined): void => {
  const to = String(next?.status || '');
  if (to && to !== 'reserved') {
    throw new Error(
      `New assessment items must be created reserved (got '${to}'). Consumed state is reachable only through the canonical wallet-first operation.`,
    );
  }
};

/**
 * Next PC contract number, scanned from `contract_number` (never `id`:
 * contract ids are random uids, so scanning `id` always yields the start
 * number and mints duplicates). A uniqueness guard bumps past numbers
 * already taken by another record (legacy duplicates, concurrent creates).
 */
export const generateNextContractNumber = (
  contracts: Array<{ id?: string; contract_number?: string }>,
  config?: unknown,
  selfId?: string,
): string => {
  const taken = new Set(
    (contracts || [])
      .filter((c) => String(c?.id || '') !== String(selfId || ''))
      .map((c) => String(c?.contract_number || '').trim())
      .filter(Boolean),
  );
  let candidate = generateNextId('PC', contracts || [], config as never, 'contract_number');
  let guard = 0;
  while (taken.has(candidate) && guard < 10000) {
    const match = candidate.match(/^(.*?)(\d+)([^0-9]*)$/);
    if (!match) {
      candidate = `${candidate}-2`;
    } else {
      const [, head, digits, tail] = match;
      const next = String(parseInt(digits, 10) + 1).padStart(digits.length, '0');
      candidate = `${head}${next}${tail}`;
    }
    guard += 1;
  }
  return candidate;
};

interface WalletTxLike {
  contract_id?: unknown;
  reference?: unknown;
  data?: { contract_id?: unknown } | null;
}

/**
 * Exact wallet-transaction matching for a contract. Never substring:
 * contract 'abc' must not match a transaction referencing 'xabcx'.
 */
export const matchContractWalletTx = (
  tx: WalletTxLike | null | undefined,
  contractId: string,
  contractNumber: string,
): boolean => {
  if (!tx) return false;
  const cid = String(contractId || '');
  const cnum = String(contractNumber || '');
  const d = (tx as WalletTxLike)?.data || {};
  if (cid && (String(tx.contract_id || '') === cid || String(d.contract_id || '') === cid)) return true;
  if (cnum && String(tx.reference || '') === cnum) return true;
  return false;
};

export type ActivationEvidence =
  | { ok: true; kind: 'zero-value' }
  | { ok: true; kind: 'paid-invoice'; invoiceId: string }
  | { ok: false; kind: 'none' };

const isPaidInvoice = (
  invoice: Invoice | null | undefined,
  prepaidAmount: number,
): boolean => {
  if (!invoice) return false;
  const total = Number(invoice.totalAmount);
  const paid = Number(invoice.paidAmount);
  if (Number.isFinite(paid)) {
    // Amounts win over labels: the payment must cover the invoice total
    // AND the current commercial value (amendments can raise prepaid
    // above the issued invoice — that extra is still due).
    return paid > 0 && paid >= Math.max(Number.isFinite(total) ? total : 0, prepaidAmount);
  }
  return (
    String(invoice.status || '').trim().toLowerCase() === 'paid' &&
    Number.isFinite(total) &&
    total >= prepaidAmount
  );
};

/**
 * Evidence gate for contract activation. Zero-value contracts need no
 * payment; otherwise the issued invoice must exist and read as paid
 * (status Paid, or paidAmount covering both the invoice total and the
 * current prepaid value).
 */
export const resolveActivationEvidence = (
  contract: Pick<AssessmentContract, 'prepaid_amount' | 'data'> | null | undefined,
  invoices: Invoice[] | null | undefined,
): ActivationEvidence => {
  if (!contract) return { ok: false, kind: 'none' };
  const prepaid = Number(contract.prepaid_amount);
  if (!(prepaid > 0)) return { ok: true, kind: 'zero-value' };
  const issuedId = String((contract.data as any)?.issued_invoice_id || '').trim();
  if (!issuedId) return { ok: false, kind: 'none' };
  const invoice = (invoices || []).find(
    (inv) => String(inv?.id || '') === issuedId || String((inv as any)?.invoiceNumber || '') === issuedId,
  );
  if (isPaidInvoice(invoice, prepaid)) return { ok: true, kind: 'paid-invoice', invoiceId: issuedId };
  return { ok: false, kind: 'none' };
};

export interface AmendmentAdjustmentInput {
  prepaid_amount_adjustment?: unknown;
  assessment_count_adjustment?: unknown;
}

/**
 * Bounds validation for amendment adjustments. Returns an error message
 * or null when the resulting contract stays coherent.
 */
export const validateAmendmentAdjustments = (
  contract: Pick<AssessmentContract, 'prepaid_amount' | 'max_assessments'> | null | undefined,
  input: AmendmentAdjustmentInput | null | undefined,
): string | null => {
  if (!contract) return 'Parent contract not found.';
  const prepaidAdj = Number(input?.prepaid_amount_adjustment ?? 0);
  const countAdj = Math.floor(Number(input?.assessment_count_adjustment ?? 0));
  if (!Number.isFinite(prepaidAdj) || !Number.isFinite(countAdj)) {
    return 'Amendment adjustments must be valid numbers.';
  }
  if (Number(contract.prepaid_amount) + prepaidAdj < 0) {
    return 'Amendment would drive the prepaid amount below zero.';
  }
  if (Number(contract.max_assessments) + countAdj < 1) {
    return 'Amendment would drive the assessment entitlement below 1.';
  }
  return null;
};

// ── Dual-party signing ceremony (same-device sequential) ─────────────

export type SignatureParty = 'company' | 'customer';

export interface ContractSignatureBlock {
  name: string;
  role: string;
  signatureDataUrl: string;
  mode: 'Draw' | 'Upload';
  signedAt: string;
  signedBy: string;
}

export interface ContractSignatureEvent {
  type: 'signed' | 're-signed' | 'voided';
  party?: SignatureParty;
  at: string;
  by: string;
  reason?: string;
}

export interface ContractSignatures {
  company: ContractSignatureBlock | null;
  customer: ContractSignatureBlock | null;
  history: ContractSignatureEvent[];
}

/** Statuses on which signing (or re-signing) is permitted. */
export const SIGNABLE_CONTRACT_STATUSES: string[] = [
  'draft',
  'pending_payment',
  'active',
  'suspended',
];

export const isSignableContractStatus = (status: string | undefined): boolean =>
  SIGNABLE_CONTRACT_STATUSES.includes(String(status || ''));

export const readContractSignatures = (data: unknown): ContractSignatures => {
  const sig = (data as any)?.signatures;
  return {
    company: (sig?.company as ContractSignatureBlock | null) || null,
    customer: (sig?.customer as ContractSignatureBlock | null) || null,
    history: Array.isArray(sig?.history) ? (sig.history as ContractSignatureEvent[]) : [],
  };
};

export const isFullySigned = (data: unknown): boolean => {
  const sig = readContractSignatures(data);
  return Boolean(sig.company && sig.customer);
};

/**
 * Record a party signature. Re-signing the same party overwrites its block
 * and appends a `re-signed` history event — history is append-only.
 */
export const applyContractSignature = (
  data: Record<string, any> | null | undefined,
  party: SignatureParty,
  block: ContractSignatureBlock,
): Record<string, any> => {
  const base = { ...(data || {}) };
  const prev = readContractSignatures(base);
  return {
    ...base,
    signatures: {
      company: party === 'company' ? block : prev.company,
      customer: party === 'customer' ? block : prev.customer,
      history: [
        ...prev.history,
        {
          type: prev[party] ? 're-signed' : 'signed',
          party,
          at: block.signedAt,
          by: block.signedBy,
        } as ContractSignatureEvent,
      ],
    },
  };
};

export interface SignatureVoidInput {
  by: string;
  at: string;
  reason: string;
}

/**
 * Void existing signatures (e.g. approved amendment changes the agreed
 * terms). No-op — same data reference — when nothing is signed.
 */
export const applySignatureVoid = (
  data: Record<string, any> | null | undefined,
  input: SignatureVoidInput,
): Record<string, any> => {
  const base = (data || {}) as Record<string, any>;
  const prev = readContractSignatures(base);
  if (!prev.company && !prev.customer) return base;
  return {
    ...base,
    signatures: {
      company: null,
      customer: null,
      history: [
        ...prev.history,
        { type: 'voided', at: input.at, by: input.by, reason: input.reason } as ContractSignatureEvent,
      ],
    },
  };
};

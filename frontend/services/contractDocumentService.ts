/**
 * contractDocumentService.ts — Phase 3 §4 automatic immutable customer documents.
 *
 * Reuses existing builders (printingContractService), Zod schemas, SHA-256
 * fail-closed hashing, verification-token utilities and PDF dispatch. No
 * parallel document system.
 *
 * - Schedule: auto-issued on successful activation; new immutable version after
 *   every approved amendment that changes schedule/dates/counts/prices/terms.
 *   Never issued as activated before activation succeeds.
 * - Receipt: auto-issued after each successful canonical consumption, exactly
 *   once per assessment (deterministic id per item). Failed consumption issues
 *   nothing. Retries/replay converge (existing row returned).
 * - History preserved: superseded schedules stay VALID→SUPERSEDED under their
 *   own number/version/token/hash; receipts are append-only per assessment.
 */

import { dbService } from './db';
import {
  buildContractScheduleDoc,
  buildAssessmentCompletionReceiptDoc,
  hashContractContent,
  stableStringify,
} from './printingContractService';
import { ContractScheduleSchema, ContractCompletionReceiptSchema } from '../views/shared/components/PDF/schemas';
import { generateVerificationToken } from '../utils/documentVerification';
import type {
  AssessmentContract,
  AssessmentContractItem,
  ContractDocument,
  Customer,
} from '../types';

const STORE = 'contractDocuments' as const;

const nowIso = () => new Date().toISOString();

async function allDocs(): Promise<ContractDocument[]> {
  try {
    return ((await dbService.getAll(STORE as any)) as ContractDocument[]) || [];
  } catch {
    return [];
  }
}

export async function listContractDocuments(contractId: string): Promise<ContractDocument[]> {
  const all = await allDocs();
  return all
    .filter((d) => String(d.contract_id || (d as any)?.data?.contract_id || '') === String(contractId))
    .sort((a, b) => Number(a.documentVersion || 0) - Number(b.documentVersion || 0));
}

export async function getReceiptForAssessment(assessmentItemId: string): Promise<ContractDocument | null> {
  const all = await allDocs();
  return (
    all.find(
      (d) =>
        String(d.documentType) === 'printing_contract_completion_receipt' &&
        String(d.assessmentItemId || (d as any)?.data?.assessmentItemId || '') === String(assessmentItemId) &&
        d.status !== 'VOID',
    ) || null
  );
}

/**
 * Issue (or return existing) schedule version for an ACTIVE contract.
 * Throws if contract is not active — never issues an activated schedule early.
 */
export async function issueScheduleVersion(args: {
  contract: AssessmentContract;
  items: AssessmentContractItem[];
  customerName: string;
  schoolName?: string;
  issuedBy?: string;
}): Promise<ContractDocument> {
  const { contract, items } = args;
  if (!contract) throw new Error('issueScheduleVersion: contract is required.');
  if (String(contract.status || '') !== 'active') {
    throw new Error(
      `issueScheduleVersion: contract ${String(contract.contract_number || contract.id)} is '${String(contract.status)}' — schedules are issued only after successful activation.`,
    );
  }
  const contractNumber = String(contract.contract_number || '').trim();
  if (!contractNumber) throw new Error('issueScheduleVersion: contract_number is required.');
  const existing = (await listContractDocuments(String(contract.id))).filter(
    (d) => d.documentType === 'printing_contract_schedule' && d.contractVersion === Number(contract.version || 1) && d.status === 'VALID',
  );
  if (existing.length > 0) return existing[0];

  const doc = await buildContractScheduleDoc({
    contract,
    items,
    customerName: args.customerName,
    schoolName: args.schoolName,
  });
  const parsed = ContractScheduleSchema.parse(doc);
  const contentHash = String((parsed as any).contentHash || '');
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('issueScheduleVersion: invalid SHA-256 contentHash — refusing to issue.');

  // Supersede prior VALID schedules for this contract (history preserved).
  const prior = (await listContractDocuments(String(contract.id))).filter(
    (d) => d.documentType === 'printing_contract_schedule' && d.status === 'VALID',
  );
  const nextVersion = prior.length > 0 ? Math.max(...prior.map((d) => Number(d.documentVersion || 0))) + 1 : 1;
  const verificationToken = generateVerificationToken();
  const issuedAt = nowIso();
  const record: ContractDocument = {
    id: `SCH-${contractNumber}-v${nextVersion}`,
    contract_id: String(contract.id),
    company_id: String((contract as any).company_id || ''),
    customer_id: String((contract as any).customer_id || ''),
    documentType: 'printing_contract_schedule',
    documentNumber: contractNumber,
    documentVersion: nextVersion,
    contractVersion: Number(contract.version || 1),
    content: parsed as unknown as Record<string, any>,
    contentHash,
    verificationToken,
    issuedAt,
    issuedBy: args.issuedBy || 'system',
    status: 'VALID',
    created_at: issuedAt,
    updated_at: issuedAt,
    version: 1,
    data: { contract_id: String(contract.id), supersedes: prior.map((p) => p.id) },
  };
  for (const p of prior) {
    await dbService.put(STORE as any, { ...p, status: 'SUPERSEDED', supersededBy: record.id, updated_at: issuedAt } as any);
  }
  await dbService.put(STORE as any, record as any);
  return record;
}

/**
 * Issue (or return existing) completion receipt for a CONSUMED assessment.
 * Exactly-once per assessment: deterministic id + pre-check + unique index
 * (0049) backstop. Failed/duplicate consumption never yields a second receipt.
 */
export async function issueCompletionReceipt(args: {
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
  customer?: Pick<Customer, 'id'> | null;
  issuedBy?: string;
  consumedAtIso?: string;
}): Promise<ContractDocument> {
  const { contract, item } = args;
  if (!contract) throw new Error('issueCompletionReceipt: contract is required.');
  if (!item || String(item.status || '') !== 'consumed') {
    throw new Error('issueCompletionReceipt: a consumed assessment is required — failed consumption issues no receipt.');
  }
  const existing = await getReceiptForAssessment(String(item.id));
  if (existing) return existing;

  const doc = await buildAssessmentCompletionReceiptDoc({
    contract,
    item,
    items: args.items,
    sequence: args.sequence,
    amountDebited: args.amountDebited,
    walletBalanceAfter: args.walletBalanceAfter,
    walletTransactionId: args.walletTransactionId,
    ledgerEntryId: args.ledgerEntryId,
    customerName: args.customerName,
    schoolName: args.schoolName,
    consumedAtIso: args.consumedAtIso || (item as any).consumed_at,
  });
  const parsed = ContractCompletionReceiptSchema.parse(doc);
  const contentHash = String((parsed as any).contentHash || '');
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('issueCompletionReceipt: invalid SHA-256 contentHash — refusing to issue.');

  const contractNumber = String(contract.contract_number || '').trim();
  const receiptNumber = String((parsed as any).receiptNumber || `PCR-${contractNumber}-${String(item.id)}`);
  const id = `PCR-${String(item.id)}`;
  const already = await dbService.get(STORE as any, id).catch(() => null);
  if (already) return already as ContractDocument;
  const issuedAt = nowIso();
  const verificationToken = generateVerificationToken();
  const record: ContractDocument = {
    id,
    contract_id: String(contract.id),
    company_id: String((contract as any).company_id || ''),
    customer_id: String((contract as any).customer_id || ''),
    documentType: 'printing_contract_completion_receipt',
    documentNumber: receiptNumber,
    documentVersion: 1,
    contractVersion: Number(contract.version || 1),
    content: parsed as unknown as Record<string, any>,
    contentHash,
    verificationToken,
    assessmentItemId: String(item.id),
    walletTransactionId: String(args.walletTransactionId || ''),
    ledgerEntryId: String(args.ledgerEntryId || ''),
    issuedAt,
    issuedBy: args.issuedBy || 'system',
    status: 'VALID',
    created_at: issuedAt,
    updated_at: issuedAt,
    version: 1,
    data: { contract_id: String(contract.id), assessmentItemId: String(item.id) },
  };
  await dbService.put(STORE as any, record as any);
  return record;
}

/** Verify a persisted document: type/number/version + stored hash recomputation. */
export async function verifyPersistedDocument(id: string): Promise<{
  ok: boolean;
  reason?: string;
  document?: ContractDocument;
}> {
  const row = (await dbService.get(STORE as any, id).catch(() => null)) as ContractDocument | null;
  if (!row) return { ok: false, reason: 'document not found' };
  const content = (row as any).content || {};
  const storedHash = String((row as any).contentHash || content.contentHash || '');
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return { ok: false, reason: 'stored hash is not a SHA-256 digest', document: row };
  // Recompute over the frozen content MINUS the hash field itself is not possible
  // (builders hash the whole doc incl. metadata). Instead verify structural
  // integrity: re-hash the canonical content envelope and compare when the
  // content was issued by our builders (schedule/receipt both carry contentHash
  // computed via stableStringify over the pre-hash doc). We recompute over the
  // stored content with contentHash stripped and accept exact match OR trust the
  // stored digest when the shape validates (hash is tamper-evident at issue;
  // any post-issue edit changes the row and fails this check on next verify
  // because updated_at/content diverge from the digest — reported, never auto-fixed).
  try {
    if (row.documentType === 'printing_contract_schedule') ContractScheduleSchema.parse(content);
    else if (row.documentType === 'printing_contract_completion_receipt') ContractCompletionReceiptSchema.parse(content);
  } catch (e: any) {
    return { ok: false, reason: `schema validation failed: ${e?.message || e}`, document: row };
  }
  if (String(content.contentHash || '') !== storedHash) {
    return { ok: false, reason: 'contentHash mismatch — document was altered after issue', document: row };
  }
  // Recompute SHA-256 over the frozen content minus its hash (builders hash the
  // pre-hash doc). Fail closed on mismatch or unavailable WebCrypto.
  const forHash = { ...(content as Record<string, any>) };
  delete (forHash as Record<string, any>).contentHash;
  let recomputed: string | null = null;
  try {
    recomputed = await hashContractContent(stableStringify(forHash));
  } catch (e: any) {
    return { ok: false, reason: `secure hashing unavailable — cannot verify (${e?.message || e})`, document: row };
  }
  if (recomputed !== storedHash) {
    return { ok: false, reason: 'content hash verification failed — document was altered after issue', document: row };
  }
  return { ok: true, document: row };
}

export const contractDocumentService = {
  issueScheduleVersion,
  issueCompletionReceipt,
  listContractDocuments,
  getReceiptForAssessment,
  verifyPersistedDocument,
};

export default contractDocumentService;

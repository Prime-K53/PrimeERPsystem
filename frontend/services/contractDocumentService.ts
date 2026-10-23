/**
 * contractDocumentService.ts — Phase 3 §4 automatic immutable customer documents.
 *
 * Reuses existing builders (printingContractService), Zod schemas, SHA-256
 * fail-closed hashing, verification-token utilities and PDF dispatch. No
 * parallel document system.
 *
 * - Schedule: auto-issued on successful activation; a new immutable version is
 *   issued whenever the canonical schedule CONTENT changes (dates, counts,
 *   prices, statuses, terms, fund position) — detected by re-hashing the
 *   freshly built document against the current VALID version, so an item edit
 *   that never bumped the contract version can no longer leave a stale
 *   schedule in place, and a no-op re-issue returns the existing version.
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
  hashStableScheduleContent,
  hashLegacyScheduleContent,
  hashLegacyReceiptContent,
  SCHEDULE_HASH_VERSION,
} from './printingContractService';
import { validateDocumentInsert, validateDocumentUpdate } from './contractDocumentGuard';
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
 * The next receipt version for a contract.
 *
 * A completion receipt's NUMBER is per contract (`PCR-<contractNumber>` —
 * `printingContractService.ts:725`), so the number alone cannot identify a
 * receipt: a contract that consumes a second assessment produces a second
 * receipt with the SAME number. The version is the per-contract receipt
 * sequence, which keeps `(documentNumber, documentVersion)` unique — the key
 * migration 0049's `uq_contract_documents_number_version` enforces — so every
 * receipt of a contract can be stored and synchronized independently.
 *
 * The receipt's own identity remains its assessment item (`assessmentItemId`,
 * enforced by 0049's `uq_contract_documents_receipt_item`) and its row id
 * (`PCR-<itemId>`).
 */
async function nextReceiptVersion(contractId: string): Promise<number> {
  const all = await allDocs();
  const receipts = all.filter(
    (d) => String(d.documentType) === 'printing_contract_completion_receipt'
      && String(d.contract_id || (d as any)?.data?.contract_id || '') === String(contractId),
  );
  const highest = receipts.reduce((max, d) => Math.max(max, Number(d.documentVersion || 0)), 0);
  return highest + 1;
}

/**
 * The next revision of a document that is being superseded.
 *
 *  1. The lifecycle change itself: VALID -> SUPERSEDED plus the
 *     `supersededBy` link to the replacement version. The revision is checked
 *     against the same rules the database enforces (migration 0052) BEFORE it
 *     is queued, so the client never produces a write the server would
 *     deterministically reject.
 *
 *  2. The optimistic-concurrency base is PRESERVED, never advanced locally.
 *     `contract_documents.version` is the server's row version, and the sync
 *     gateway's write is conditional on it (`cloudSyncStore.upsertRow` PATCHes
 *     `version = eq.<payload.version>` and the server answers
 *     `version = base + 1`). The local copy therefore has to carry the base
 *     the server last returned — advancing it locally would make the very
 *     first supersede fail its own precondition. The server's new value comes
 *     back with the next pull, which is what refreshes the local base; a write
 *     that races that pull surfaces as a version conflict and is resolved by
 *     the client's existing merge path.
 */
function supersedeRevision(
  prior: ContractDocument,
  replacement: ContractDocument,
  issuedAt: string,
): ContractDocument {
  const next = {
    ...prior,
    status: 'SUPERSEDED',
    supersededBy: replacement.id,
    updated_at: issuedAt,
  } as ContractDocument;

  const check = validateDocumentUpdate(
    prior as unknown as Record<string, any>,
    next as unknown as Record<string, any>,
    { supersededByTarget: replacement as unknown as Record<string, any> },
  );
  if (!check.ok) {
    throw new Error(
      `contractDocumentService: refusing to supersede ${prior.id} - ${check.violations.map((v) => v.detail).join(' ')}`,
    );
  }
  return next;
}

/**
 * Issue (or return existing) schedule version for an ACTIVE contract.
 * Throws if contract is not active — never issues an activated schedule early.
 *
 * Idempotent on canonical content: if the freshly built schedule hashes to the
 * current VALID version's digest, that version is returned untouched. Any
 * material change supersedes it and issues the next immutable version.
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

  // The issue instant is the document's identity, not "when the build ran":
  // it is generated ONCE here, shown as the "Issued" date and persisted on the
  // record. The current time is never used as a fallback anywhere downstream.
  const issuedAt = nowIso();

  // Build the candidate version. The schedule's own verification token is
  // generated up front and embedded, so the printed QR resolves to THIS
  // version rather than to the parent contract.
  const verificationToken = generateVerificationToken();
  const doc = await buildContractScheduleDoc({
    contract,
    items,
    customerName: args.customerName,
    schoolName: args.schoolName,
    issuedAtIso: issuedAt,
    verificationToken,
  });
  const parsed = ContractScheduleSchema.parse(doc);
  const contentHash = String((parsed as any).contentHash || '');
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error('issueScheduleVersion: invalid SHA-256 contentHash — refusing to issue.');

  const contractId = String(contract.id);
  // The contract's STABLE id keys every local document. The human-readable
  // number is NOT a unique identity (live duplicate `PC-P726/022`), so keying by
  // number let one contract overwrite another's version. The number stays the
  // printed/QR number (`documentNumber`) for compatibility.
  //
  // Issuance runs inside ONE readwrite IndexedDB transaction over
  // `contractDocuments`: the read (idempotency + next version), the insert and
  // the supersede are atomic and IndexedDB serializes concurrent readwrite
  // transactions, so two callers can never both leave a VALID version behind.
  //
  // WRITE ORDER (contracted with the database, migrations 0052/0053):
  //   1. INSERT the new version (status VALID) — the row the supersede points
  //      at MUST already exist, because the database validates `supersededBy`
  //      against a real, newer row of the same contract.
  //   2. UPDATE the previous version to SUPERSEDED (pointing at the new one).
  //   The queue preserves this order (the sync enqueue walks the transaction's
  //   change map in insertion order), so the server applies the insert first
  //   and the supersede's reference always resolves.
  //
  //   Consequence: between step 1 and step 2 the server can briefly hold two
  //   VALID schedules for one contract. Migration 0053 closes that window
  //   server-side (the insert retires the older VALID schedule in the same
  //   transaction), so the public page never presents a stale schedule as the
  //   current one. The order is deliberately NOT reversed: superseding first
  //   would leave a contract with NO current schedule if the device died
  //   between the two writes.
  // The store names are passed as an ARRAY: `executeAtomicOperation` maps over
  // them (`stores.map(String)`) to open one IndexedDB transaction. A bare
  // string has no `.map`, so passing one aborted every issuance with
  // "stores.map is not a function" — the schedule could never be generated.
  return await dbService.executeAtomicOperation([STORE], async (tx: any) => {
    const store = tx.objectStore(STORE as any);
    const all = ((await store.getAll()) as ContractDocument[]) || [];
    const priorAll = all.filter(
      (d) => d.documentType === 'printing_contract_schedule'
        && String(d.contract_id || (d as any)?.data?.contract_id || '') === contractId,
    );
    const priorValid = priorAll.filter((d) => d.status === 'VALID');

    // Idempotent re-issue: unchanged canonical content hashes identically (the
    // hash covers stable content only — see SCHEDULE_HASH_VERSION), so an
    // amendment that changed nothing, or a repeat print, returns the SAME issued
    // version instead of churning the version number. A material change — an
    // edited assessment item, a date, an amount, the fund position — produces a
    // different digest and correctly supersedes the previous version.
    const unchanged = priorValid.find(
      (d) => String((d as any).contentHash || (d as any)?.content?.contentHash || '') === contentHash,
    );
    if (unchanged) {
      // A previous interrupted issue may have left another VALID version behind
      // (e.g. the insert committed but the supersede did not). Reconcile before
      // returning so every successful call converges on exactly ONE VALID.
      for (const p of priorValid) {
        if (String(p.id) === String(unchanged.id)) continue;
        await store.put(supersedeRevision(p, unchanged, issuedAt) as any);
      }
      return unchanged;
    }

    const nextVersion = priorAll.length > 0
      ? Math.max(...priorAll.map((d) => Number(d.documentVersion || 0))) + 1
      : 1;
    const documentId = `SCH-${contractId}-v${nextVersion}`;
    const record: ContractDocument = {
      id: documentId,
      contract_id: contractId,
      company_id: String((contract as any).company_id || ''),
      customer_id: String((contract as any).customer_id || ''),
      documentType: 'printing_contract_schedule',
      documentNumber: contractNumber,
      documentVersion: nextVersion,
      contractVersion: Number(contract.version || 1),
      // The version's own identity is injected into the content so the printed
      // document can name itself. It is EXCLUDED from the content hash (see
      // `SCHEDULE_VOLATILE_HASH_KEYS`): the version number is allocated after
      // the content is hashed, so covering it would make the digest depend on
      // the identity and break re-issue idempotency.
      content: {
        ...(parsed as unknown as Record<string, any>),
        documentId,
        documentVersion: nextVersion,
      },
      contentHash,
      // Hash rule version: verification must apply the SAME exclusion set the
      // builder used, or unchanged content could never round-trip.
      hashVersion: SCHEDULE_HASH_VERSION,
      verificationToken,
      issuedAt,
      issuedBy: args.issuedBy || 'system',
      status: 'VALID',
      created_at: issuedAt,
      updated_at: issuedAt,
      version: 1,
      data: { contract_id: contractId, supersedes: priorValid.map((p) => p.id) },
    };

    // The client never emits a write the database would reject: the same rules
    // the 0052 trigger enforces are checked here first (see
    // `contractDocumentGuard`). A refusal is a programming error, not a
    // recoverable condition, so it surfaces instead of being queued.
    const insertCheck = validateDocumentInsert(record as unknown as Record<string, any>);
    if (!insertCheck.ok) {
      throw new Error(
        `issueScheduleVersion: refusing to issue ${record.id} — ${insertCheck.violations.map((v) => v.detail).join(' ')}`,
      );
    }

    // Insert the NEW version first: if the insert fails, the previous version is
    // still VALID (issuance never leaves the contract with zero documents),
    // and the supersede that follows always points at an existing row.
    await store.put(record as any);
    // Then retire the previously-VALID versions (history preserved).
    for (const p of priorValid) {
      if (String(p.id) === record.id) continue;
      await store.put(supersedeRevision(p, record, issuedAt) as any);
    }
    // Self-heal within the same transaction: at most one VALID version may exist
    // per contract, whatever a concurrent/interrupted issue left behind.
    const after = ((await store.getAll()) as ContractDocument[]) || [];
    for (const d of after) {
      if (String(d.id) === record.id) continue;
      if (d.documentType !== 'printing_contract_schedule') continue;
      if (String(d.contract_id || (d as any)?.data?.contract_id || '') !== contractId) continue;
      if (d.status === 'VALID') {
        await store.put(supersedeRevision(d, record, issuedAt) as any);
      }
    }
    return record;
  });
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
  // The receipt NUMBER is per contract, so the version is the per-contract
  // receipt sequence: it keeps (documentNumber, documentVersion) unique, which
  // is the key migration 0049's number index enforces. Without it the second
  // receipt of a contract would collide with the first and could never be
  // stored. See `nextReceiptVersion`.
  const documentVersion = await nextReceiptVersion(String(contract.id));
  const record: ContractDocument = {
    id,
    contract_id: String(contract.id),
    company_id: String((contract as any).company_id || ''),
    customer_id: String((contract as any).customer_id || ''),
    documentType: 'printing_contract_completion_receipt',
    documentNumber: receiptNumber,
    documentVersion,
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
  const insertCheck = validateDocumentInsert(record as unknown as Record<string, any>);
  if (!insertCheck.ok) {
    throw new Error(
      `issueCompletionReceipt: refusing to issue ${record.id} — ${insertCheck.violations.map((v) => v.detail).join(' ')}`,
    );
  }
  await dbService.put(STORE as any, record as any);
  return record;
}

/**
 * Verify a persisted document.
 *
 * Two distinct questions are answered separately, because conflating them is
 * what let a superseded schedule report `ok: true`:
 *
 *  - `integrity` — the frozen content is intact: it still validates against its
 *    schema and still hashes to the stored digest under the rule that was used
 *    at issue (`hashVersion`). A tampered or altered row fails this.
 *  - `ok` — the document is a CURRENT, valid version: integrity holds AND it has
 *    not been superseded or voided.
 *
 * `status` and `current` are always reported so a caller can distinguish
 * "authentic but superseded" from "altered after issue".
 */
export async function verifyPersistedDocument(id: string): Promise<{
  ok: boolean;
  integrity: boolean;
  current: boolean;
  status?: string;
  reason?: string;
  document?: ContractDocument;
}> {
  const row = (await dbService.get(STORE as any, id).catch(() => null)) as ContractDocument | null;
  if (!row) return { ok: false, integrity: false, current: false, reason: 'document not found' };
  const status = String((row as any).status || '');
  const current = status === 'VALID';
  const content = (row as any).content || {};
  const storedHash = String((row as any).contentHash || content.contentHash || '');
  if (!/^[0-9a-f]{64}$/.test(storedHash)) {
    return { ok: false, integrity: false, current, status, reason: 'stored hash is not a SHA-256 digest', document: row };
  }
  try {
    if (row.documentType === 'printing_contract_schedule') ContractScheduleSchema.parse(content);
    else if (row.documentType === 'printing_contract_completion_receipt') ContractCompletionReceiptSchema.parse(content);
  } catch (e: any) {
    return { ok: false, integrity: false, current, status, reason: `schema validation failed: ${e?.message || e}`, document: row };
  }
  if (String(content.contentHash || '') !== storedHash) {
    return { ok: false, integrity: false, current, status, reason: 'contentHash mismatch — document was altered after issue', document: row };
  }
  // Recompute over the frozen content using the rule the document was issued
  // with. Version 2 schedules exclude volatile metadata (the issue date and the
  // random per-version token) so unchanged content hashes identically; legacy
  // schedules (no marker) and ALL completion receipts were hashed by the
  // pre-Phase-2 builders, whose `undefined` optionals JSONB then dropped — the
  // reconstruction restores them as `null`. Fail closed when WebCrypto is
  // unavailable.
  const hashVersion = Number((row as any).hashVersion ?? (content as any).hashVersion ?? 1);
  const usesStableEnvelope = row.documentType === 'printing_contract_schedule'
    && hashVersion >= SCHEDULE_HASH_VERSION;
  let recomputed: string | null = null;
  try {
    if (usesStableEnvelope) {
      recomputed = await hashStableScheduleContent(content as Record<string, unknown>);
    } else if (row.documentType === 'printing_contract_completion_receipt') {
      recomputed = await hashLegacyReceiptContent(content as Record<string, unknown>);
    } else {
      recomputed = await hashLegacyScheduleContent(content as Record<string, unknown>);
    }
  } catch (e: any) {
    return { ok: false, integrity: false, current, status, reason: `secure hashing unavailable — cannot verify (${e?.message || e})`, document: row };
  }
  if (recomputed !== storedHash) {
    return { ok: false, integrity: false, current, status, reason: 'content hash verification failed — document was altered after issue', document: row };
  }
  return {
    ok: current,
    integrity: true,
    current,
    status,
    ...(current ? {} : { reason: `document is ${status || 'not current'} — integrity verified, but it is no longer the current version` }),
    document: row,
  };
}

export const contractDocumentService = {
  issueScheduleVersion,
  issueCompletionReceipt,
  listContractDocuments,
  getReceiptForAssessment,
  verifyPersistedDocument,
};

export default contractDocumentService;

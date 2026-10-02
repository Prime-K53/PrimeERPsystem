/**
 * examinationInvoiceDiag.ts — read-only admin diagnostic builder for ONE
 * examination invoice's local persistence/sync state (e.g. EXM-P726/021).
 *
 * Diagnostic infrastructure only. This module performs zero I/O itself: the
 * caller supplies already-read local state (invoice row, queue operations,
 * conflict records, sync metadata) and this builder reduces it to safe,
 * displayable sections. It never writes, enqueues, replays, deletes,
 * regenerates, or repairs anything.
 *
 * Privacy: only an allow-list of safe fields is ever extracted. The
 * verification token is NEVER included — only presence, length, and the
 * one-way fingerprint from `utils/examinationInvoiceDiag.ts` (reused, not
 * reimplemented). Customer identity, financial amounts, line items, notes,
 * payloads, passwords, and credentials are never extracted.
 */

import { examDiagTokenFingerprint } from '../utils/examinationInvoiceDiag';

export const EXAM_DIAG_DEFAULT_NUMBER = 'EXM-P726/021';

export type ExamDiagConclusion =
  | 'LOCAL INVOICE ABSENT'
  | 'LOCAL INVOICE PRESENT — NO QUEUE OPERATION'
  | 'LOCAL INVOICE PRESENT — QUEUE FAILED'
  | 'LOCAL INVOICE PRESENT — QUEUED, NOT SYNCED'
  | 'LOCAL INVOICE PRESENT — SYNC AUTH FAILED'
  | 'LOCAL INVOICE PRESENT — SYNC CONFLICT'
  | 'LOCAL INVOICE PRESENT — SYNC SUCCESS RECORDED'
  | 'LOCAL STATE INSUFFICIENT — SERVER VERIFICATION REQUIRED';

export interface ExamDiagQueueOp {
  id?: unknown;
  operationId?: unknown;
  table?: unknown;
  recordId?: unknown;
  operation?: unknown;
  status?: unknown;
  createdAt?: unknown;
  lastAttempt?: unknown;
  retryCount?: unknown;
  lastError?: unknown;
  errorType?: unknown;
  syncGeneration?: unknown;
  conflictCount?: unknown;
}

export interface ExamDiagConflict {
  operationId?: unknown;
  table?: unknown;
  recordId?: unknown;
  conflictedFields?: unknown;
  resolved?: unknown;
  serverVersion?: unknown;
  timestamp?: unknown;
}

export interface ExamDiagSyncMeta {
  authBlocked?: unknown;
  enginePaused?: unknown;
  lastSyncStart?: unknown;
  lastSyncSuccess?: unknown;
  lastSyncFailure?: unknown;
}

export interface ExamDiagInput {
  invoiceNumber: string;
  invoice: Record<string, unknown> | null | undefined;
  queueOps: ReadonlyArray<ExamDiagQueueOp> | null | undefined;
  conflicts: ReadonlyArray<ExamDiagConflict> | null | undefined;
  syncMeta: ExamDiagSyncMeta | null | undefined;
}

export interface ExamDiagLocalInvoice {
  present: boolean;
  id: string | null;
  invoiceNumber: string | null;
  originModule: string | null;
  batchId: string | null;
  status: string | null;
  idEqualsNumber: boolean | null;
  tokenPresent: boolean;
  tokenLength: number;
  tokenFingerprint: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  serverVersionStamp: number | null;
}

export interface ExamDiagQueueOpView {
  opId: string | null;
  operation: string | null;
  status: string | null;
  createdAt: string | null;
  lastAttempt: string | null;
  retryCount: number | null;
  lastErrorSnippet: string | null;
  errorType: string | null;
  syncGeneration: number | null;
  conflictCount: number | null;
  retryEligibility: 'eligible' | 'blocked-reauth' | 'exhausted' | 'terminal' | 'in-flight' | 'done' | 'unknown';
}

export interface ExamDiagConflictView {
  recordId: string | null;
  resolved: string | null;
  conflictedFields: string[];
  serverVersion: number | null;
  timestamp: string | null;
}

export interface ExamDiagResult {
  invoiceNumber: string;
  localInvoice: ExamDiagLocalInvoice;
  queue: { operations: ExamDiagQueueOpView[] };
  sync: {
    authBlocked: boolean | null;
    enginePaused: boolean | null;
    lastSyncStart: string | null;
    lastSyncSuccess: string | null;
    lastSyncFailure: string | null;
  };
  identity: { idEqualsNumber: boolean | null; batchId: string | null };
  verification: { tokenPresent: boolean; note: string };
  conflicts: ExamDiagConflictView[];
  diagnosticStatus: string;
  conclusion: ExamDiagConclusion;
}

const asText = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const asNumber = (value: unknown): number | null => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/**
 * Conflicted-field names that are safe to display. Anything else (customer
 * names, amounts, line-item fields, tokens, notes, …) is shown as
 * 'redacted': only the COUNT of redacted fields is preserved so the
 * diagnostic keeps its shape without leaking field names.
 */
const SAFE_CONFLICT_FIELDS = new Set([
  'id',
  'invoiceNumber',
  'status',
  'batchId',
  'originModule',
  'origin_module',
  'origin_batch_id',
  'originBatchId',
  'origin_batchId',
  'reference',
]);

const scrubConflictedFields = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const names = (value as unknown[]).map((f) => str(f)).filter(Boolean).slice(0, 20);
  let redacted = 0;
  const kept = names.filter((name) => {
    if (SAFE_CONFLICT_FIELDS.has(name)) return true;
    redacted += 1;
    return false;
  });
  if (redacted > 0) kept.push(`redacted(${redacted})`);
  return kept;
};

const str = (value: unknown, fallback = ''): string => String(value ?? fallback);

function retryEligibilityOf(status: string | null, errorType: string | null, retryCount: number | null): ExamDiagQueueOpView['retryEligibility'] {
  if (status === 'pending' || status === 'syncing') return 'in-flight';
  if (status === 'completed') return 'done';
  if (status === 'dead_letter') return 'terminal';
  if (status === 'failed') {
    if (errorType === 'unauthorized') return 'blocked-reauth';
    if ((retryCount ?? 0) >= 10) return 'exhausted';
    return 'eligible';
  }
  return 'unknown';
}

/**
 * Pure reduction of already-read local state. Async only because token
 * fingerprinting uses WebCrypto. Never mutates its inputs.
 */
export async function buildExaminationInvoiceDiag(input: ExamDiagInput): Promise<ExamDiagResult> {
  const invoiceNumber = String(input?.invoiceNumber ?? '').trim();
  const row = input?.invoice && typeof input.invoice === 'object' ? input.invoice : null;
  const ops = Array.isArray(input?.queueOps) ? input.queueOps : [];
  const conflicts = Array.isArray(input?.conflicts) ? input.conflicts : [];
  const meta = input?.syncMeta && typeof input.syncMeta === 'object' ? input.syncMeta : {};

  const rowOps = ops.filter(
    (op) => op && typeof op === 'object' && String(op.table ?? '') === 'invoices' && String(op.recordId ?? '') === invoiceNumber
  );
  const rowConflicts = conflicts.filter(
    (c) => c && typeof c === 'object' && String(c.recordId ?? '') === invoiceNumber
  );

  const id = row ? asText(row.id) : null;
  const number = row ? asText(row.invoiceNumber) : null;
  const originModule = row ? asText(row.originModule ?? row.origin_module) : null;
  const batchId = row
    ? asText(row.batchId ?? row.origin_batch_id ?? row.originBatchId ?? row.origin_batchId)
    : null;
  const tokenText = row ? str(row.verificationToken).trim() : '';
  const tokenFingerprint = tokenText ? await examDiagTokenFingerprint(tokenText) : null;
  const versionStamp = row ? asNumber(row._version ?? row.version) : null;

  const localInvoice: ExamDiagLocalInvoice = {
    present: Boolean(row),
    id,
    invoiceNumber: number,
    originModule,
    batchId,
    status: row ? asText(row.status) : null,
    idEqualsNumber: row ? Boolean(id && number && id === number) : null,
    tokenPresent: tokenText.length > 0,
    tokenLength: tokenText.length,
    tokenFingerprint,
    createdAt: row ? asText(row.createdAt ?? row.created_at) : null,
    updatedAt: row
      ? asText(row._updatedAt ?? row.updated_at ?? row.serverUpdatedAt)
      : null,
    serverVersionStamp: versionStamp,
  };

  const operations: ExamDiagQueueOpView[] = rowOps.map((op) => {
    const status = asText(op.status);
    const errorType = asText(op.errorType);
    const retryCount = asNumber(op.retryCount);
    return {
      opId: asText(op.id),
      operation: asText(op.operation),
      status,
      createdAt: asText(op.createdAt),
      lastAttempt: asText(op.lastAttempt),
      retryCount,
      lastErrorSnippet: op.lastError != null ? str(op.lastError).slice(0, 200) || null : null,
      errorType,
      syncGeneration: asNumber(op.syncGeneration),
      conflictCount: asNumber(op.conflictCount),
      retryEligibility: retryEligibilityOf(status, errorType, retryCount),
    };
  });

  const conflictViews: ExamDiagConflictView[] = rowConflicts.map((c) => ({
    recordId: asText(c.recordId),
    resolved: asText(c.resolved),
    conflictedFields: scrubConflictedFields(c.conflictedFields),
    serverVersion: asNumber(c.serverVersion),
    timestamp: asText((c as Record<string, unknown>).timestamp ?? (c as Record<string, unknown>).createdAt),
  }));

  const authBlocked = meta.authBlocked === undefined ? null : Boolean(meta.authBlocked);
  const enginePaused = meta.enginePaused === undefined ? null : Boolean(meta.enginePaused);

  let conclusion: ExamDiagConclusion;
  let diagnosticStatus: string;
  if (!row) {
    conclusion = 'LOCAL INVOICE ABSENT';
    diagnosticStatus = 'Invoice not found locally. Check the originating device or batch linkage; server verification is still required.';
  } else if (operations.length === 0) {
    conclusion = 'LOCAL INVOICE PRESENT — NO QUEUE OPERATION';
    diagnosticStatus = 'Invoice exists locally but no durable sync operation exists for it. It cannot reach the server in this state.';
  } else if (operations.some((o) => o.errorType === 'unauthorized') || (authBlocked === true && operations.some((o) => o.status === 'failed'))) {
    conclusion = 'LOCAL INVOICE PRESENT — SYNC AUTH FAILED';
    diagnosticStatus = 'Sync was rejected for authorization (401/403). The queue holds the operation until re-authentication; automatic retry is paused by design.';
  } else if (operations.some((o) => o.status === 'dead_letter' || o.status === 'failed')) {
    conclusion = 'LOCAL INVOICE PRESENT — QUEUE FAILED';
    diagnosticStatus = 'A durable sync operation exists but is failed or dead-lettered. Inspect lastErrorSnippet; no automatic repair is offered here.';
  } else if (conflictViews.length > 0 || operations.some((o) => (o.conflictCount ?? 0) > 0)) {
    conclusion = 'LOCAL INVOICE PRESENT — SYNC CONFLICT';
    diagnosticStatus = 'The operation conflicted with a server row. Review conflictedFields; the invoice on this device may have been re-minted under a new number.';
  } else if (operations.some((o) => o.status === 'pending' || o.status === 'syncing')) {
    conclusion = 'LOCAL INVOICE PRESENT — QUEUED, NOT SYNCED';
    diagnosticStatus = 'The operation is queued but has no recorded success. Server verification is still required.';
  } else if (operations.every((o) => o.status === 'completed')) {
    conclusion = 'LOCAL INVOICE PRESENT — SYNC SUCCESS RECORDED';
    diagnosticStatus = 'The queue records success, but that alone does not prove the authoritative row. Server verification is still required.';
  } else {
    conclusion = 'LOCAL STATE INSUFFICIENT — SERVER VERIFICATION REQUIRED';
    diagnosticStatus = 'Local state is ambiguous. Server verification is still required.';
  }

  return {
    invoiceNumber,
    localInvoice,
    queue: { operations },
    sync: {
      authBlocked,
      enginePaused,
      lastSyncStart: asText(meta.lastSyncStart),
      lastSyncSuccess: asText(meta.lastSyncSuccess),
      lastSyncFailure: asText(meta.lastSyncFailure),
    },
    identity: { idEqualsNumber: localInvoice.idEqualsNumber, batchId: localInvoice.batchId },
    verification: {
      tokenPresent: localInvoice.tokenPresent,
      note: 'Local state only. Public verification requires the authoritative server row and is not checked here.',
    },
    conflicts: conflictViews,
    diagnosticStatus,
    conclusion,
  };
}

/**
 * Copy-safe text rendering: only invoice number, type, originModule, queue
 * operation IDs, statuses, timestamps, error codes/messages, and token
 * presence/length/fingerprint. Never tokens, customer data, or amounts.
 */
export function renderExamDiagCopy(result: ExamDiagResult): string {
  const lines: string[] = [
    `Examination invoice diagnostic — ${result.invoiceNumber}`,
    `Conclusion: ${result.conclusion}`,
    `Status: ${result.diagnosticStatus}`,
    `LOCAL_INVOICE present=${result.localInvoice.present} id=${result.localInvoice.id ?? '-'} ` +
      `invoiceNumber=${result.localInvoice.invoiceNumber ?? '-'} originModule=${result.localInvoice.originModule ?? '-'} ` +
      `batchId=${result.localInvoice.batchId ?? '-'} idEqualsNumber=${String(result.localInvoice.idEqualsNumber)} ` +
      `tokenPresent=${result.localInvoice.tokenPresent} tokenLength=${result.localInvoice.tokenLength} ` +
      `tokenFingerprint=${result.localInvoice.tokenFingerprint ?? '-'} ` +
      `createdAt=${result.localInvoice.createdAt ?? '-'} updatedAt=${result.localInvoice.updatedAt ?? '-'} ` +
      `serverVersionStamp=${result.localInvoice.serverVersionStamp ?? '-'}`,
  ];
  if (result.queue.operations.length === 0) {
    lines.push('QUEUE none');
  } else {
    for (const op of result.queue.operations) {
      lines.push(
        `QUEUE opId=${op.opId ?? '-'} operation=${op.operation ?? '-'} status=${op.status ?? '-'} ` +
          `createdAt=${op.createdAt ?? '-'} lastAttempt=${op.lastAttempt ?? '-'} retryCount=${op.retryCount ?? '-'} ` +
          `errorType=${op.errorType ?? '-'} retryEligibility=${op.retryEligibility} ` +
          `error=${op.lastErrorSnippet ?? '-'}`
      );
    }
  }
  lines.push(
    `SYNC authBlocked=${String(result.sync.authBlocked)} enginePaused=${String(result.sync.enginePaused)} ` +
      `lastStart=${result.sync.lastSyncStart ?? '-'} lastSuccess=${result.sync.lastSyncSuccess ?? '-'} ` +
      `lastFailure=${result.sync.lastSyncFailure ?? '-'}`
  );
  if (result.conflicts.length > 0) {
    for (const c of result.conflicts) {
      lines.push(
        `CONFLICT recordId=${c.recordId ?? '-'} resolved=${c.resolved ?? '-'} ` +
          `fields=${c.conflictedFields.join(',') || '-'}`
      );
    }
  }
  return lines.join('\n');
}

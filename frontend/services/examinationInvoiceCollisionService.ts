/**
 * examinationInvoiceCollisionService.ts — P0 stale cross-device number-race
 * protection (examination invoices ONLY).
 *
 * Problem: two devices with stale snapshots can mint the SAME canonical
 * EXM number. The first committer wins the row; the loser's push then hits
 * `version_required`, and the generic conflict path would field-merge two
 * DIFFERENT batches' invoices under one id (corruption) or tombstone the
 * winner (delete path). This module intercepts exactly that case:
 *
 *   - detect: same id, BOTH sides examination-like, disjoint batch linkage
 *   - never merge, never overwrite/tombstone the winner
 *   - re-mint a fresh unique EXM number for the loser, preserving its token
 *   - persist + requeue under the NEW id, repoint the owning batch link
 *   - complete the stale queue item so the old id is never applied
 *   - fail SAFE (dead-letter with an explicit message) when re-minting is
 *     impossible — never silently merge
 *
 * Same-linkage edits (payments, status changes on one invoice),
 * non-examination rows, tombstones and linkage-less legacy rows all fall
 * through to the normal generic merge/delete handling untouched.
 *
 * All side effects go through the injected `CollisionDeps` so this module
 * is fully unit-testable without IndexedDB; `backgroundSyncService` supplies
 * the production deps, and `persistExaminationInvoiceToFinance` reuses the
 * pure assessment for its synchronous same-device pre-flight.
 */
import { generateNextExaminationInvoiceNumber } from '../utils/helpers';
import { ensureInvoiceVerificationToken } from '../utils/invoiceVerification';
import {
  findOwningExaminationBatchId,
  getExaminationBatchLinkage,
  isDistinctExaminationInvoiceCollision,
} from '../utils/invoiceIdentity';
import type { Invoice } from '../types';

export { isDistinctExaminationInvoiceCollision as assessExaminationInvoiceCollision };

/** Backstop against pathological re-mint chains (each hop needs a FRESH independent collision). */
export const EXAMINATION_COLLISION_MAX_REMINTS = 3;

export interface CollisionDeps {
  /** Current local invoices-namespace rows (for minting against). */
  listInvoices: () => Promise<Array<Record<string, unknown>>>;
  /** Local save that also enqueues the new-id op (dbService.put semantics). */
  saveInvoiceLocal: (invoice: Record<string, unknown>) => Promise<unknown>;
  /** Pure-local removal with NO sync side effects (hardDelete semantics). */
  removeInvoiceLocal: (id: string) => Promise<void>;
  /** Local examination batches (for repointing the owning batch link). */
  listBatches: () => Promise<Array<Record<string, unknown>>>;
  /** Repoint batch.invoice_id (same mechanism as the original stamp). */
  updateBatchInvoiceLink: (batchId: string, invoiceId: string) => Promise<void>;
  /** Retire the stale queue item WITHOUT applying it. */
  completeQueueItem: (queueId: string) => Promise<void>;
  deadLetterQueueItem: (queueId: string, reason: string) => Promise<void>;
  recordConflictAudit: (entry: {
    operationId: string | null;
    table: string;
    recordId: string | null;
    conflictedFields: string[];
    resolved: 'auto' | 'review';
    serverVersion: number;
  }) => Promise<void>;
  notifyUser: (event: string, data: unknown) => void;
  /** Numbering config override; undefined falls back to the stored company config. */
  numberingConfig?: unknown;
}

export interface CollisionItem {
  id: string;
  operationId?: string | null;
  table: string;
  recordId: string | null;
  operation: string;
  payload: unknown;
  conflictCount?: number;
}

export interface CollisionServer {
  version?: number;
  updatedAt?: string | null;
  data?: Record<string, unknown> | null;
}

export type CollisionHandling =
  | { handled: true; outcome: 'conflict' | 'deadLetter'; newInvoiceId: string | null; reason: string }
  | { handled: false };

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const remintChainOf = (payload: Record<string, unknown>): string[] => {
  const chain = (payload as Record<string, unknown>).remintedFrom;
  return Array.isArray(chain) ? chain.map((entry) => String(entry || '')) : [];
};

/**
 * Pure construction of the re-minted invoice: NEW canonical id/number,
 * reference fix-up only when it pointed at the stale id, SAME
 * verificationToken and content. Never mutates its input.
 */
export function buildRemintedExaminationInvoice(
  payload: Record<string, unknown>,
  newId: string
): Record<string, unknown> {
  const oldId = String(payload.id ?? '');
  const next: Record<string, unknown> = {
    ...(payload as Record<string, unknown>),
    id: newId,
    invoiceNumber: newId,
  };
  if (String((payload as Record<string, unknown>).reference ?? '') === oldId) {
    next.reference = newId;
  }
  next.remintedFrom = [...remintChainOf(payload), oldId];
  return ensureInvoiceVerificationToken(next as Invoice & Record<string, unknown>) as unknown as Record<
    string,
    unknown
  >;
}

const differingFields = (
  local: Record<string, unknown>,
  server: Record<string, unknown>,
  cap = 20
): string[] => {
  const skip = new Set(['_updatedAt', '_cloudSource', '_version', 'version', 'updated_at', 'serverUpdatedAt']);
  const out: string[] = [];
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(server || {})]);
  for (const key of keys) {
    if (skip.has(key)) continue;
    if (out.length >= cap) break;
    try {
      if (JSON.stringify((local as Record<string, unknown>)[key]) !== JSON.stringify((server as Record<string, unknown>)[key])) {
        out.push(key);
      }
    } catch {
      out.push(key);
    }
  }
  return out;
};

/**
 * Upsert-conflict resolution for a distinct examination-invoice collision:
 * re-mint the loser under a fresh id, NEVER merge into / overwrite the winner.
 */
export async function resolveExaminationInvoiceCollision(
  item: CollisionItem,
  server: CollisionServer,
  deps: CollisionDeps
): Promise<CollisionHandling> {
  if (item.table !== 'invoices' || item.operation === 'delete') return { handled: false };
  const payload = asRecord(item.payload);
  const serverData = asRecord(server?.data);
  const oldId = String(item.recordId ?? payload.id ?? '');
  if (!oldId) return { handled: false };
  if (!isDistinctExaminationInvoiceCollision(payload, serverData)) return { handled: false };

  const failSafe = async (reason: string): Promise<CollisionHandling> => {
    await deps.deadLetterQueueItem(item.id, reason);
    await deps.recordConflictAudit({
      operationId: item.operationId ?? null,
      table: item.table,
      recordId: oldId,
      conflictedFields: ['id', 'invoiceNumber'],
      resolved: 'review',
      serverVersion: Number(server?.version ?? 0),
    });
    deps.notifyUser('dead-letter', {
      table: item.table,
      recordId: oldId,
      reason,
      examinationCollision: true,
    });
    return { handled: true, outcome: 'deadLetter', newInvoiceId: null, reason };
  };

  // Backstop: each re-mint hop requires a fresh independent collision.
  if (remintChainOf(payload).length >= EXAMINATION_COLLISION_MAX_REMINTS) {
    return failSafe(
      `Examination invoice ${oldId} collided repeatedly after re-minting; held for manual review instead of merging. Winner untouched.`
    );
  }

  // Mint against the CURRENT local namespace plus both known-taken ids, so
  // the fresh number cannot reuse the stale id even if the local row moved.
  const serverId = String(serverData.id ?? serverData.invoiceNumber ?? '');
  const localRows = await deps.listInvoices().catch(() => []);
  const probe: Array<{ id?: unknown; invoiceNumber?: unknown; date?: unknown }> = [
    ...(localRows as Array<Record<string, unknown>>),
  ];
  if (oldId) probe.push({ id: oldId });
  if (serverId && serverId !== oldId) probe.push({ id: serverId });
  const newId = generateNextExaminationInvoiceNumber(
    probe as Array<{ id?: unknown; invoiceNumber?: unknown; date?: unknown }>,
    deps.numberingConfig as never
  );
  if (!newId || newId === oldId) {
    return failSafe(
      `Examination invoice ${oldId} collided but no fresh number could be minted; held for manual review instead of merging. Winner untouched.`
    );
  }

  const reminted = buildRemintedExaminationInvoice(payload, newId);

  // Create-new-first ordering: the new row + its queue op are durable before
  // the stale identity is retired, so a crash can only orphan (visible,
  // reconcilable) — never lose — the loser's invoice.
  await deps.saveInvoiceLocal(reminted);
  try {
    await deps.removeInvoiceLocal(oldId);
  } catch {
    // Best-effort: the stale row is superseded regardless; the completed
    // queue item below guarantees the old id is never applied remotely.
  }

  // Repoint ONLY the linkage-matched owning batch; never touch other batches
  // that may legitimately reference the winner's id.
  try {
    const batches = await deps.listBatches().catch(() => []);
    const ownerId = findOwningExaminationBatchId(
      batches,
      getExaminationBatchLinkage(payload),
      oldId
    );
    if (ownerId) {
      await deps.updateBatchInvoiceLink(ownerId, newId);
    }
  } catch {
    // Best-effort: invoice correctness outranks the back-link; the batch
    // link can be repaired without touching invoice data.
  }

  await deps.completeQueueItem(item.id);
  const conflictedFields = differingFields(payload, serverData);
  await deps.recordConflictAudit({
    operationId: item.operationId ?? null,
    table: item.table,
    recordId: oldId,
    conflictedFields: ['id', 'invoiceNumber', ...conflictedFields.filter((f) => f !== 'id' && f !== 'invoiceNumber')],
    resolved: 'auto',
    serverVersion: Number(server?.version ?? 0),
  });
  deps.notifyUser('sync-conflict', {
    table: item.table,
    recordId: oldId,
    operation: item.operation,
    resolved: 'auto',
    remintedTo: newId,
    examinationCollision: true,
    conflictedFields,
    serverVersion: Number(server?.version ?? 0),
  });
  return {
    handled: true,
    outcome: 'conflict',
    newInvoiceId: newId,
    reason: `Distinct examination invoices shared ${oldId}; loser re-minted as ${newId} instead of merging. Winner untouched.`,
  };
}

/**
 * Delete guard: a delete op targeting an id whose server row is a DIFFERENT
 * examination invoice must never tombstone the winner — hold for review.
 */
export async function resolveExaminationInvoiceDelete(
  item: CollisionItem,
  localRecord: Record<string, unknown> | null | undefined,
  server: CollisionServer,
  deps: CollisionDeps
): Promise<CollisionHandling> {
  if (item.table !== 'invoices' || item.operation !== 'delete') return { handled: false };
  const serverData = asRecord(server?.data);
  const oldId = String(item.recordId ?? '');
  if (!oldId || !localRecord) return { handled: false };
  if (!isDistinctExaminationInvoiceCollision(localRecord, serverData)) return { handled: false };
  const reason =
    `Delete of examination invoice ${oldId} blocked: the server row belongs to a different ` +
    `examination batch. Held for manual review instead of tombstoning the winner.`;
  await deps.deadLetterQueueItem(item.id, reason);
  await deps.recordConflictAudit({
    operationId: item.operationId ?? null,
    table: item.table,
    recordId: oldId,
    conflictedFields: ['id'],
    resolved: 'review',
    serverVersion: Number(server?.version ?? 0),
  });
  deps.notifyUser('dead-letter', {
    table: item.table,
    recordId: oldId,
    reason,
    examinationCollision: true,
  });
  return { handled: true, outcome: 'deadLetter', newInvoiceId: null, reason };
}

/**
 * Dispatcher for the sync conflict layer: upsert collisions re-mint,
 * dangerous deletes hold, everything else falls through to generic handling.
 */
export async function tryResolveExaminationInvoiceCollision(
  item: CollisionItem,
  server: CollisionServer,
  deps: CollisionDeps & { localRecord?: Record<string, unknown> | null }
): Promise<CollisionHandling> {
  if (item.table !== 'invoices') return { handled: false };
  if (item.operation === 'delete') {
    return resolveExaminationInvoiceDelete(item, deps.localRecord ?? null, server, deps);
  }
  return resolveExaminationInvoiceCollision(item, server, deps);
}

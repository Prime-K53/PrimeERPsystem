/**
 * invoiceRecoveryService.ts
 *
 * Narrow, admin-gated recovery affordance for an existing invoice whose
 * canonical record is present locally but absent from the authoritative
 * remote system.  Re-queues the EXACT existing local record through the
 * established durable-sync pipeline — no business-field mutation, no
 * invoice recreation, no direct Supabase write.
 *
 * Safety contract:
 *   - Service-layer authorization: only an authenticated, non-expired
 *     administrator/operator session (admin / company admin / manager /
 *     super admin) may run recovery — enforced inside this service,
 *     independent of the UI. No caller-supplied auth hint is accepted.
 *   - Never modifies business fields (totals, customer, dates, status, items, …)
 *   - Never creates a new invoice
 *   - Never invokes payment/accounting/ledger logic
 *   - Reuses dbService.put() and the existing durable sync queue
 *   - Remote verification is read-only
 */

import { dbService } from './db';
import { durableSyncQueue, getLocalGeneration, isGenerationValid } from './durableSyncQueue';
import { stableStringify } from './printingContractService';
import { logger } from './logger';
import { getStoredUserSession, isSessionExpired } from './authSession';

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

export type RecoveryAuthReason =
  | 'authorized'
  | 'no_session'
  | 'invalid_session'
  | 'session_expired'
  | 'role_not_allowed';

export interface RecoveryAuthorization {
  authorized: boolean;
  reason: RecoveryAuthReason;
  userId?: string;
  role?: string;
}

export type RecoveryStage =
  | 'local_lookup'
  | 'remote_check'
  | 'generation_check'
  | 'queue_check'
  | 'reput'
  | 'sync'
  | 'remote_verify'
  | 'complete'
  | 'error';

export interface RecoveryResult {
  success: boolean;
  stage: RecoveryStage;
  message: string;
  /** Pre-recovery business-data fingerprint (deterministic JSON) */
  preSnapshot?: string;
  /** Post-re-put business-data fingerprint */
  postSnapshot?: string;
  /** The durable queue operation id (q-…) */
  queueOpId?: string;
  /** Sync operation id (crypto.randomUUID) */
  operationId?: string;
  /** Human-readable local generation */
  localGeneration?: number;
  /** Previous queue/dead-letter state that was found */
  previousQueueState?: 'none' | 'pending' | 'failed' | 'dead_letter';
  /** Whether remote non-existence was confirmed */
  remoteConfirmedAbsent?: boolean;
  /** Whether the post-write zero-delta check passed */
  zeroDeltaVerified?: boolean;
  /** Authoritative remote verification result (after sync) */
  remoteVerified?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Service-layer authorization                                       */
/* ------------------------------------------------------------------ */

/**
 * Roles allowed to run invoice recovery. Mirrors the existing UI
 * administrator/operator gate (SalesLists InvoiceList "Re-queue to Cloud"),
 * which is the app's established recovery authorization policy.
 */
const RECOVERY_AUTHORIZED_ROLES = new Set(['admin', 'company admin', 'manager']);

/**
 * Independently enforce the recovery authorization policy at the service
 * layer, using the existing authenticated session (nexus_user) — the same
 * mechanism the rest of the app uses. This gate is the authoritative check:
 * hiding the UI button does NOT grant or withhold access; the service
 * refuses to run for any caller whose stored session is missing, expired,
 * or not an administrator/operator. No caller-supplied auth hint is ever
 * accepted.
 */
export function checkRecoveryAuthorization(): RecoveryAuthorization {
  let session: Record<string, unknown> | null = null;
  try {
    session = getStoredUserSession();
  } catch {
    return { authorized: false, reason: 'invalid_session' };
  }

  if (!session || typeof session !== 'object') {
    return { authorized: false, reason: 'no_session' };
  }

  if (isSessionExpired(session)) {
    return { authorized: false, reason: 'session_expired' };
  }

  const role = String(session.role ?? '').trim().toLowerCase();
  const userId = session.id != null ? String(session.id) : undefined;

  if (session.isSuperAdmin === true || RECOVERY_AUTHORIZED_ROLES.has(role)) {
    return { authorized: true, reason: 'authorized', userId, role: role || 'super-admin' };
  }

  return { authorized: false, reason: 'role_not_allowed', userId, role: role || 'unknown' };
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                  */
/* ------------------------------------------------------------------ */

/** Fields that are synchronization metadata, not business data. */
const SYNC_METADATA_KEYS = new Set([
  '_updatedAt',
  '_cloudSource',
  '_operationId',
  '_version',
  'dependsOn',
  'deletedAt',
  'version',
  'updated_at',
  'created_at',
  '_serverVersion',
  'serverUpdatedAt',
]);

/**
 * Return a plain object containing only the invoice's business fields,
 * suitable for deterministic fingerprinting.  Nested line items are kept
 * as-is; stableStringify will sort keys recursively so the fingerprint is
 * order-independent.
 */
function extractBusinessFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (SYNC_METADATA_KEYS.has(key)) continue;
    // Skip empty / undefined values that are not meaningful business data
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

/** Deterministic fingerprint of the business fields only. */
function fingerprint(record: Record<string, unknown>): string {
  return stableStringify(extractBusinessFields(record));
}

/* ------------------------------------------------------------------ */
/*  Remote existence check                                            */
/* ------------------------------------------------------------------ */

interface RemoteCheckResult {
  exists: boolean;
  record: unknown;
  error?: string;
}

async function checkRemoteExists(invoiceId: string): Promise<RemoteCheckResult> {
  try {
    const storedUser = getStoredUserSession();
    if (storedUser && isSessionExpired(storedUser)) {
      return { exists: false, record: null, error: 'Session expired — remote check skipped' };
    }
    const token = (() => {
      try {
        const raw = sessionStorage.getItem('nexus_user');
        if (raw) {
          const session = JSON.parse(raw);
          return session?.accessToken || null;
        }
      } catch {
        // ignore
      }
      return null;
    })();

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const url = `/api/sync/ops/record/invoices/${encodeURIComponent(invoiceId)}`;

    const response = await fetch(url, { headers });

    if (!response.ok) {
      if (response.status === 404) {
        return { exists: false, record: null };
      }
      const body = await response.json().catch(() => ({}));
      return {
        exists: false,
        record: null,
        error: `Remote check failed (${response.status}): ${String(body?.error || body?.message || response.statusText)}`,
      };
    }

    const data = await response.json();
    return { exists: Boolean(data?.exists), record: data?.record || null };
  } catch (err) {
    return {
      exists: false,
      record: null,
      error: err instanceof Error ? err.message : 'Network or parsing error during remote check',
    };
  }
}

/* ------------------------------------------------------------------ */
/*  Queue state inspection                                            */
/* ------------------------------------------------------------------ */

type QueuePresence = 'none' | 'pending' | 'failed' | 'syncing' | 'dead_letter';

async function inspectQueueState(invoiceId: string): Promise<{ presence: QueuePresence; op?: unknown }> {
  const activeStatuses: QueuePresence[] = ['pending', 'syncing', 'failed'];
  const activeOps = await durableSyncQueue.getAll();
  const active = activeOps.filter(
    (op: any) => op.table === 'invoices' && op.recordId === invoiceId && activeStatuses.includes(op.status as QueuePresence)
  );

  if (active.length > 0) {
    // Return the most recent active op
    const sorted = active.sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { presence: sorted[0].status as QueuePresence, op: sorted[0] };
  }

  const deadLetters = await durableSyncQueue.getAll('dead_letter');
  const dead = deadLetters.find((op: any) => op.table === 'invoices' && op.recordId === invoiceId);
  if (dead) {
    return { presence: 'dead_letter', op: dead };
  }

  return { presence: 'none' };
}

/* ------------------------------------------------------------------ */
/*  Main recovery entry point                                         */
/* ------------------------------------------------------------------ */

/**
 * Re-queue an existing local invoice through the durable sync pipeline.
 *
 * Safety gates (in order):
 *   0. Caller is an authenticated administrator/operator (service-layer
 *      authorization — enforced independently of the UI).
 *   1. Local canonical record must exist.
 *   2. Remote record must NOT exist (read-only check).
 *   3. Sync generation must be valid.
 *   4. No existing active queue op for this invoice.
 *   5. Dead-letter ops with valid generation are retried; with invalid
 *      generation the operation stops.
 *   6. Exact existing record is re-put via dbService.put().
 *   7. Zero business-data delta is verified.
 *   8. Queue op id is returned; sync happens asynchronously.
 *
 * @returns RecoveryResult with stage, message, and diagnostic fields.
 */
export async function recoverInvoiceToCloud(invoiceId: string): Promise<RecoveryResult> {
  /* ----------------------------------------------------------------
   * STEP 0 — Service-layer authorization gate
   *
   * The recovery affordance is admin/operator-only. This check runs BEFORE
   * any read or write so an unauthorized caller (including one who bypasses
   * the UI and calls this service directly) has zero effect on local data,
   * the sync queue, or the remote system.
   * ---------------------------------------------------------------- */
  const auth = checkRecoveryAuthorization();
  if (!auth.authorized) {
    logger.warn('[InvoiceRecovery] Authorization gate rejected caller', {
      reason: auth.reason,
      role: auth.role,
      userId: auth.userId,
      invoiceId,
    });
    return {
      success: false,
      stage: 'error',
      message: `Recovery stopped: an authenticated administrator/operator session is required to run invoice recovery (reason: ${auth.reason}).`,
    };
  }

  /* ----------------------------------------------------------------
   * STEP 1 — Local canonical record
   * ---------------------------------------------------------------- */
  const localRecord = await dbService.get('invoices', invoiceId);
  if (!localRecord) {
    return {
      success: false,
      stage: 'local_lookup',
      message: 'Recovery stopped: the canonical local invoice record could not be found.',
    };
  }

  const typedRecord = localRecord as Record<string, unknown>;

  /* ----------------------------------------------------------------
   * STEP 3 — Capture zero-delta snapshot (business fields only)
   * ---------------------------------------------------------------- */
  const preSnapshot = fingerprint(typedRecord);

  /* ----------------------------------------------------------------
   * STEP 4 — Remote non-existence check
   * ---------------------------------------------------------------- */
  const remoteCheck = await checkRemoteExists(invoiceId);

  if (remoteCheck.error) {
    return {
      success: false,
      stage: 'remote_check',
      message: `Recovery stopped: remote lookup failed (${remoteCheck.error}).`,
      preSnapshot,
      remoteConfirmedAbsent: false,
    };
  }

  if (remoteCheck.exists) {
    return {
      success: false,
      stage: 'remote_check',
      message: 'Recovery stopped: this invoice already exists on the authoritative server. No local or remote changes were made.',
      preSnapshot,
      remoteConfirmedAbsent: false,
    };
  }

  /* ----------------------------------------------------------------
   * STEP 5 — Sync generation check
   * ---------------------------------------------------------------- */
  const localGen = getLocalGeneration();
  const generationValid = isGenerationValid(localGen);

  if (!generationValid) {
    return {
      success: false,
      stage: 'generation_check',
      message: `Recovery stopped: local sync generation (${localGen}) is invalid. Do not reset generation.`,
      preSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
    };
  }

  /* ----------------------------------------------------------------
   * STEP 6 — Inspect existing queue / dead-letter state
   * ---------------------------------------------------------------- */
  const queueState = await inspectQueueState(invoiceId);

  if (queueState.presence === 'pending' || queueState.presence === 'syncing' || queueState.presence === 'failed') {
    return {
      success: false,
      stage: 'queue_check',
      message: `An existing sync operation for this invoice is already pending (status: ${queueState.presence}). Let the normal sync mechanism process it.`,
      preSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
      previousQueueState: queueState.presence,
    };
  }

  if (queueState.presence === 'dead_letter') {
    const deadOp = queueState.op as Record<string, unknown> | undefined;
    const deadGen = Number(deadOp?.syncGeneration);
    const deadGenerationValid = isGenerationValid(deadGen);

    if (deadGenerationValid) {
      try {
        await durableSyncQueue.retryDeadLetter(String(deadOp?.id));
        return {
          success: true,
          stage: 'queue_check',
          message: 'Dead-letter operation for this invoice was re-armed to pending via the supported retry path.',
          preSnapshot,
          remoteConfirmedAbsent: true,
          localGeneration: localGen,
          previousQueueState: 'dead_letter',
          queueOpId: String(deadOp?.id),
          operationId: String(deadOp?.operationId),
        };
      } catch {
        return {
          success: false,
          stage: 'queue_check',
          message: 'Recovery stopped: dead-letter operation exists and the supported retry path failed.',
          preSnapshot,
          remoteConfirmedAbsent: true,
          localGeneration: localGen,
          previousQueueState: 'dead_letter',
        };
      }
    }

    return {
      success: false,
      stage: 'queue_check',
      message: 'Recovery stopped: dead-letter operation exists with invalid sync generation. Manual retry is blocked; re-save the record in the app to create a fresh operation.',
      preSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
      previousQueueState: 'dead_letter',
    };
  }

  /* ----------------------------------------------------------------
   * STEP 7 — Re-put the EXACT existing record through dbService.put()
   * ---------------------------------------------------------------- */
  // Build a shallow copy so we never accidentally mutate the cached
  // local record held by the UI / data context.
  const recordToRequeue = { ...typedRecord };
  delete (recordToRequeue as any)._cloudSource;

  let queueOpId: string | undefined;
  let operationId: string | undefined;

  try {
    const resultId = await dbService.put('invoices', recordToRequeue);
    queueOpId = resultId;

    // Look up the queue operation that was just created to get its
    // operationId and confirm status.
    const allOps = await durableSyncQueue.getAll();
    const newOp = allOps
      .filter((op: any) => op.table === 'invoices' && op.recordId === invoiceId)
      .sort((a: any, b: any) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];

    if (newOp) {
      operationId = String(newOp.operationId);
    }
  } catch (err) {
    logger.error('[InvoiceRecovery] dbService.put() failed:', err);
    return {
      success: false,
      stage: 'reput',
      message: `Recovery stopped: failed to re-queue the invoice. ${err instanceof Error ? err.message : 'Unknown error.'}`,
      preSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
      previousQueueState: queueState.presence,
    };
  }

  /* ----------------------------------------------------------------
   * STEP 8 — Post-write zero-delta verification
   * ---------------------------------------------------------------- */
  const reloaded = await dbService.get('invoices', invoiceId);
  if (!reloaded) {
    return {
      success: false,
      stage: 'reput',
      message: 'Recovery stopped: the local invoice record disappeared after re-put.',
      preSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
      previousQueueState: queueState.presence,
      queueOpId,
      operationId,
    };
  }

  const postSnapshot = fingerprint(reloaded as Record<string, unknown>);
  const zeroDelta = preSnapshot === postSnapshot;

  if (!zeroDelta) {
    logger.error('[InvoiceRecovery] Business-data delta detected', {
      invoiceId,
      preSnapshot,
      postSnapshot,
    });
    return {
      success: false,
      stage: 'reput',
      message: 'Recovery stopped: business data changed during re-put. No sync was initiated.',
      preSnapshot,
      postSnapshot,
      remoteConfirmedAbsent: true,
      localGeneration: localGen,
      previousQueueState: queueState.presence,
      queueOpId,
      operationId,
      zeroDeltaVerified: false,
    };
  }

  /* ----------------------------------------------------------------
   * STEP 10 / 11 — Normal sync + remote verification
   *
   * We wait (with timeout) for the background sync to process the
   * operation, then perform a read-only remote verification.
   * ---------------------------------------------------------------- */
  const syncResult = await waitForSyncCompletion(queueOpId, 60000);

  let remoteVerified = false;
  if (syncResult === 'completed') {
    const verifyCheck = await checkRemoteExists(invoiceId);
    remoteVerified = verifyCheck.exists;
  }

  return {
    success: syncResult === 'completed' && remoteVerified,
    stage: syncResult === 'completed' && remoteVerified ? 'complete' : 'sync',
    message: syncResult === 'completed' && remoteVerified
      ? 'Authoritative recovery confirmed. Device B should receive the invoice through normal incremental synchronization.'
      : syncResult === 'completed'
        ? 'Queue operation completed but remote verification did not confirm the record. Investigate sync logs.'
        : 'Invoice re-queued. The normal sync process will deliver it to the authoritative server.',
    preSnapshot,
    postSnapshot,
    remoteConfirmedAbsent: true,
    localGeneration: localGen,
    previousQueueState: queueState.presence,
    queueOpId,
    operationId,
    zeroDeltaVerified: true,
    remoteVerified,
  };
}

/* ------------------------------------------------------------------ */
/*  Wait for a queue operation to reach a terminal state              */
/* ------------------------------------------------------------------ */

async function waitForSyncCompletion(queueOpId: string | undefined, timeoutMs: number): Promise<'completed' | 'timeout' | 'error'> {
  if (!queueOpId) return 'error';

  const start = Date.now();
  const pollInterval = 2000;

  while (Date.now() - start < timeoutMs) {
    try {
      const ops = await durableSyncQueue.getAll();
      const op = ops.find((o: any) => o.id === queueOpId);
      if (!op) return 'error';

      if (op.status === 'completed') return 'completed';
      if (op.status === 'dead_letter') return 'error';
      if (op.status === 'failed') {
        // Give the background sync a couple more cycles
        if (Date.now() - start > timeoutMs / 2) return 'error';
      }
    } catch {
      // transient read error — keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  return 'timeout';
}

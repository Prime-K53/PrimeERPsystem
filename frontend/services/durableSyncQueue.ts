import { openDB, IDBPDatabase } from 'idb';
import { logger } from './logger';

export type QueueStatus = 'pending' | 'syncing' | 'failed' | 'completed' | 'dead_letter';
export type QueueOperation = 'insert' | 'update' | 'delete' | 'upsert';

export interface QueuedOperation {
  id: string;
  operationId: string;
  table: string;
  recordId: string | null;
  operation: QueueOperation;
  payload: unknown;
  userId: string | null;
  createdAt: string;
  retryCount: number;
  lastAttempt: string | null;
  status: QueueStatus;
  lastError: string | null;
  dependsOn: string[];
  fileRef: string | null;
  errorType?: 'retryable' | 'permanent' | 'unauthorized' | null;
  payloadSizeBytes?: number;
  /** Number of optimistic-concurrency conflicts this op survived before convergence (auto-merge cap). */
  conflictCount?: number;
  /** Sync generation at the time this operation was created. Used to detect stale operations after a company reset. */
  syncGeneration?: number;
}

export interface QueueMetrics {
  total: number;
  pending: number;
  syncing: number;
  failed: number;
  completed: number;
  deadLetter: number;
  oldestPending: string | null;
  lastSyncSuccess: string | null;
  lastSyncFailure: string | null;
  retryHistogram: Record<number, number>;
  avgRetryCount: number;
  avgSyncLatencyMs: number;
  /** Total optimistic-concurrency conflicts detected across all time (persisted counter). */
  conflictsTotal: number;
  /** Conflicts that auto-merged on disjoint/one-sided fields. */
  conflictsAuto: number;
  /** Conflicts on the same field from both sides that were LWW-resolved and flagged for review. */
  conflictsReview: number;
}

interface QueueDB {
  operations: {
    key: string;
    value: QueuedOperation;
    indexes: {
      'by-status': string;
      'by-created': string;
      'by-operationId': string;
    };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
  metrics: {
    key: string;
    value: {
      id: string;
      timestamp: string;
      metric: string;
      value: unknown;
    };
    indexes: {
      'by-metric': string;
    };
  };
}

const DB_NAME = 'PrimeERP_DurableSyncQueue';
const DB_VERSION = 3;

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

/** @internal – reset IndexedDB connection cache (used in tests) */
export function resetDbConnection(): void {
  dbPromise = null;
}

function getDb(): Promise<IDBPDatabase<QueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const store = db.createObjectStore('operations', { keyPath: 'id' });
          store.createIndex('by-status', 'status');
          store.createIndex('by-created', 'createdAt');
          store.createIndex('by-operationId', 'operationId');
        }
        if (oldVersion < 2) {
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta', { keyPath: 'key' });
          }
        }
        if (oldVersion < 3) {
          if (!db.objectStoreNames.contains('metrics')) {
            const metricsStore = db.createObjectStore('metrics', { keyPath: 'id' });
            metricsStore.createIndex('by-metric', 'metric');
          }
        }
      },
    });
  }
  return dbPromise;
}

function generateId(): string {
  return `q-${crypto.randomUUID?.() ?? Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function generateOperationId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const RETRYABLE_ERROR_PATTERNS = [
  'timeout', 'network', 'offline', 'fetch', 'abort',
  '429', '500', '502', '503', '504',
  'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'rate limit', 'too many requests',
  'service unavailable', 'internal server error',
  'bad gateway', 'gateway timeout',
];

const PERMANENT_ERROR_PATTERNS = [
  'validation', 'malformed', 'foreign key', 'not found',
  'missing required', 'unauthorized', 'forbidden',
  'deleted resource', 'schema mismatch', 'constraint',
  'duplicate key value violates unique constraint',
  'violates foreign key constraint',
  'violates not-null constraint',
  'invalid input syntax',
  'row-level security',
  '42501',
  'policy',
  // Server-side company-reset guards are terminal. The backend always returns
  // retryable:false with these, but keeping the phrase in the classifier is a
  // defensive fallback so an op is never stuck in the retry loop if a future
  // gateway response omits the flag.
  'no sync generation',
  'older than the current generation',
];

export function classifyError(message: string): 'retryable' | 'permanent' | 'unauthorized' {
  const lower = message.toLowerCase();
  // 401/403 from the sync gateway carry a sentinel prefix set by
  // syncApiClient.SyncAuthError. These are PERMANENT authorization failures —
  // the durable queue must not retry them on the periodic interval; the user
  // must re-authenticate before the queue can drain again.
  if (lower.includes('sync gateway rejected the request (401)')) return 'unauthorized';
  if (lower.includes('sync gateway rejected the request (403)')) return 'unauthorized';
  for (const pattern of PERMANENT_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return 'permanent';
  }
  for (const pattern of RETRYABLE_ERROR_PATTERNS) {
    if (lower.includes(pattern)) return 'retryable';
  }
  return 'retryable';
}

function detectCycle(dependsOn: string[], allItems: QueuedOperation[], visited: Set<string> = new Set(), path: Set<string> = new Set()): boolean {
  for (const depId of dependsOn) {
    if (path.has(depId)) return true;
    if (visited.has(depId)) continue;
    visited.add(depId);
    path.add(depId);
    const depItem = allItems.find(i => i.id === depId);
    if (depItem && depItem.dependsOn.length > 0) {
      if (detectCycle(depItem.dependsOn, allItems, visited, path)) return true;
    }
    path.delete(depId);
  }
  return false;
}const LOCAL_GENERATION_KEY = 'nexus_sync_generation';
export function getLocalGeneration(): number {
  try {
    const raw = localStorage.getItem(LOCAL_GENERATION_KEY);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 1) return n;
    }
  } catch { /* ignore */ }
  return 1;
}
export function setLocalGeneration(generation: number): void {
  try {
    localStorage.setItem(LOCAL_GENERATION_KEY, String(Math.max(1, Number(generation) || 1)));
  } catch { /* ignore */ }
}
export function isGenerationValid(gen: number | undefined): boolean {
  return Number.isFinite(gen) && gen >= 1;
}

/**
 * Generation stamped onto a NEW operation at creation/enqueue time.
 *
 * The generation MUST represent the company/sync generation under which the
 * mutation was originally created — never the generation observed later at
 * replay time. New local writes therefore always carry the generation that is
 * current on this device right now (`getLocalGeneration()`, floor of 1). A
 * caller that knows a different generation (e.g. conflict re-queues that must
 * keep provenance) can pass it explicitly.
 *
 * SAFETY: this function is ONLY used for brand-new operations. Pre-existing
 * queue records that were persisted without generation (legacy records) are
 * NEVER stamped here — they are quarantined so they cannot be replayed.
 */
function resolveCreationGeneration(explicit: number | undefined): number {
  if (isGenerationValid(explicit)) return explicit as number;
  return getLocalGeneration();
}

/** Diagnostic recorded on every quarantined legacy operation. */
export const LEGACY_GENERATION_QUARANTINE_REASON =
  'QUARANTINED: operation has no sync generation (legacy record without generation provenance). ' +
  'It was NOT replayed because its generation cannot be verified after a company reset, so replaying ' +
  'it could resurrect data into a newer company/generation. If this record is still needed, re-save ' +
  'it from the app so a new operation is created with the current generation.';
/**
 * Move a single unsafe/legacy operation to the terminal dead-letter state.
 *
 * The op keeps its full payload, table/recordId and error history so the
 * SyncHealth UI can explain exactly why it was discarded, but it is never
 * dequeued, retried or replayed. Company-reset safety is preserved because
 * an op whose generation provenance cannot be verified is never sent to the
 * backend.
 */
async function quarantineOp(db: IDBPDatabase<QueueDB>, op: QueuedOperation, reason?: string): Promise<void> {
  op.status = 'dead_letter';
  op.errorType = 'permanent';
  op.lastError = reason || LEGACY_GENERATION_QUARANTINE_REASON;
  op.lastAttempt = new Date().toISOString();
  await db.put('operations', op);
}

/**
 * Quarantine every active (pending/syncing/failed) operation that lacks a
 * valid sync generation. These are legacy records created by an older
 * implementation that predates generation metadata — their provenance cannot
 * be established, so replaying them after a company reset could resurrect
 * stale data into a newer generation. Quarantining (dead-letter) instead of
 * stamping the current generation keeps the reset guard intact.
 *
 * Idempotent: ops already in dead_letter/completed are untouched, and once an
 * op is quarantined it is no longer 'active', so a second pass is a no-op.
 * Returns the number of newly quarantined operations.
 */
export async function quarantineOperationsMissingGeneration(): Promise<number> {
  const db = await getDb();
  let count = 0;
  for (const status of ['pending', 'syncing', 'failed'] as QueueStatus[]) {
    const ops = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only(status));
    for (const op of ops) {
      if (!isGenerationValid(op.syncGeneration)) {
        await quarantineOp(db, op);
        count++;
      }
    }
  }
  if (count > 0) {
    logger.warn('[DurableQueue] quarantined legacy operations with no sync generation (never replayed)', {
      count,
      hint: 'Re-save any still-needed records from the app to create fresh operations with the current generation.',
    });
  }
  return count;
}

export const durableSyncQueue = {
  async enqueue<T>(input: {
    table: string;
    recordId: string | null;
    operation: QueueOperation;
    payload: T;
    userId?: string | null;
    dependsOn?: string[];
    fileRef?: string | null;
    /** Generation under which this mutation was created. If omitted, the
     *  queue stamps the current local generation at creation time. */
    syncGeneration?: number;
  }): Promise<QueuedOperation> {
    const now = new Date().toISOString();
    const db = await getDb();
    const payloadStr = JSON.stringify(input.payload);

    // ── Generation at CREATION time ────────────────────────────────────────
    // Every NEW locally generated operation must carry the generation under
    // which the mutation was created so the backend can reject it if a company
    // reset moves the server past that generation. The stamp happens here —
    // never later at dequeue/replay time (that would defeat the reset guard by
    // silently upgrading stale mutations into the current generation).
    //
    // Pre-existing legacy queue records that were persisted without a
    // generation are NOT upgraded here; they are quarantined (see
    // quarantineOperationsMissingGeneration) so they can never be replayed.
    const effectiveGeneration = resolveCreationGeneration(input.syncGeneration);

    // Only active operations (pending/syncing/failed) participate in
    // duplicate detection and dependency resolution. Scanning the full store
    // (which also holds 24h of completed records) made every local write
    // O(all operations) and slowed the app down as the queue grew.
    const activeLayers = await Promise.all(
      (['pending', 'syncing', 'failed'] as QueueStatus[]).map((status) =>
        db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only(status))
      )
    );
    const allExisting = ([] as QueuedOperation[]).concat(...activeLayers);

    // A brand-new local write must never merge into — or be deduplicated
    // against — a legacy active op that lacks generation provenance. If we
    // folded a fresh edit into such an op it would be quarantined along with
    // the legacy record and the legitimate new edit would silently never sync.
    // Quarantine those records here and let this new write create a fresh,
    // correctly-stamped operation instead.
    const unsafeActive = allExisting.filter((op) =>
      !isGenerationValid(op.syncGeneration)
      && op.table === input.table
      && op.recordId === (input.recordId || null)
      && (op.status === 'pending' || op.status === 'failed')
    );
    if (unsafeActive.length > 0) {
      for (const op of unsafeActive) {
        await quarantineOp(db, op);
        // Remove from the working set so the duplicate/merge checks below skip it.
        const idx = allExisting.findIndex((o) => o.id === op.id);
        if (idx >= 0) allExisting.splice(idx, 1);
      }
      logger.warn('[DurableQueue] quarantined legacy active op(s) before creating a fresh operation', {
        table: input.table,
        recordId: input.recordId,
        operation: input.operation,
        quarantined: unsafeActive.map((o) => o.id),
      });
    }

    const duplicate = allExisting.find((op) =>
      op.table === input.table
      && op.recordId === (input.recordId || null)
      && op.operation === input.operation
      && (op.status === 'pending' || op.status === 'syncing' || op.status === 'failed')
      && JSON.stringify(op.payload) === payloadStr
    );

    if (duplicate) {
      return duplicate;
    }

    // Merge: when a pending upsert exists for the same table+recordId with
    // a different payload, fold the newer fields into the existing queue item
    // instead of creating a duplicate. This prevents a fresh create (Device B
    // creating CUST-0001) from colliding with an earlier pending upsert of
    // the same record with stale data.
    if (input.operation === 'upsert' && input.recordId) {
      const existingPendingUpsert = allExisting.find((op) =>
        op.table === input.table
        && op.recordId === input.recordId
        && op.operation === 'upsert'
        && (op.status === 'pending' || op.status === 'failed')
        && JSON.stringify(op.payload) !== payloadStr
      );

      if (existingPendingUpsert) {
        // The merged item keeps the ORIGINAL operation's generation — the
        // mutation provenance of the first write, which the newer payload
        // merely extends. Both writes happened under that same generation
        // (the merge path only runs while the item is still active, which
        // ends at the next completed/dead-letter transition).
        existingPendingUpsert.payload = { ...existingPendingUpsert.payload, ...input.payload };
        const db = await getDb();
        await db.put('operations', existingPendingUpsert);
        return existingPendingUpsert;
      }
    }

    let dependsOn = [...(input.dependsOn || [])];

    if (input.operation === 'delete' && input.recordId) {
      const sameRecordOps = allExisting.filter((op) =>
        op.table === input.table
        && op.recordId === input.recordId
        && (op.status === 'pending' || op.status === 'syncing' || op.status === 'failed')
        && op.operation !== 'delete'
      );

      dependsOn = Array.from(new Set([
        ...dependsOn,
        ...sameRecordOps.filter((op) => op.status === 'syncing').map((op) => op.id),
      ]));

      for (const op of sameRecordOps) {
        if (op.status !== 'syncing') {
          await db.delete('operations', op.id);
        }
      }
    }

    if (dependsOn.length > 0) {
      const cycleCandidates = await db.getAll('operations');
      const visited = new Set<string>();
      const path = new Set<string>();
      if (detectCycle(dependsOn, cycleCandidates, visited, path)) {
        throw new Error(`Dependency cycle detected: operation would create a circular dependency`);
      }
    }

    const item: QueuedOperation = {
      id: generateId(),
      operationId: input.fileRef ? input.fileRef : generateOperationId(),
      table: input.table,
      recordId: input.recordId || null,
      operation: input.operation,
      payload: input.payload,
      userId: input.userId || null,
      createdAt: now,
      retryCount: 0,
      lastAttempt: null,
      status: 'pending',
      lastError: null,
      dependsOn,
      fileRef: input.fileRef || null,
      payloadSizeBytes: payloadStr.length,
      conflictCount: 0,
      // CRITICAL: syncGeneration is stamped at CREATION time for new operations.
      // It is the generation under which the mutation was originally created —
      // never the generation observed at replay time. This lets the backend
      // reject the operation as stale if a company reset moved it to a newer
      // generation. resolveCreationGeneration() always returns a valid number
      // (>=1) for new operations, so a freshly created item is never legacy.
      syncGeneration: effectiveGeneration,
    };

    // Log the operation creation with generation info for debugging
    logger.info('[DurableQueue] operation created', {
      id: item.id,
      table: input.table,
      recordId: input.recordId,
      operation: input.operation,
      syncGeneration: effectiveGeneration,
    });
    await db.put('operations', item);
    /* SYNC-FORENSIC suppressed: STAGE-3 durableSyncQueue.enqueue() persisted */
    return item;
  },

  async enqueueWithCache<T>(input: {
    table: string;
    recordId: string | null;
    operation: QueueOperation;
    payload: T;
    userId?: string | null;
    dependsOn?: string[];
    fileRef?: string | null;
    syncGeneration?: number;
  }, cacheWrite: () => Promise<void>): Promise<QueuedOperation> {
    const item = await this.enqueue(input);
    try {
      await cacheWrite();
    } catch {
      await this.remove(item.id);
      throw new Error('Cache write failed after queue enqueue, operation rolled back');
    }
    return item;
  },

  async dequeue(limit: number = 10): Promise<QueuedOperation[]> {
    const db = await getDb();
    const allPending = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('pending'));

    // Legacy pending ops without generation provenance are quarantined at the
    // dequeue boundary (the exact point where an op becomes actionable). This
    // guarantees they are NEVER transmitted to the backend, regardless of which
    // code path reached dequeue (periodic sync, navigation trigger, manual
    // syncNow, acceptance runner). Quarantine is a one-way, terminal transition:
    // the item is excluded from this batch and never returns to 'pending'.
    let quarantined = 0;
    const safePending: QueuedOperation[] = [];
    for (const op of allPending) {
      if (!isGenerationValid(op.syncGeneration)) {
        await quarantineOp(db, op);
        quarantined++;
      } else {
        safePending.push(op);
      }
    }
    if (quarantined > 0) {
      logger.warn('[DurableQueue] dequeue quarantined legacy operations with no sync generation (not sent to backend)', {
        quarantined,
        tableRecordIds: allPending
          .filter((op) => !isGenerationValid(op.syncGeneration))
          .slice(0, 20)
          .map((op) => `${op.table}/${op.recordId}`),
      });
    }

    // Loading every completed/dead-letter record on each dequeue was a hidden
    // O(all operations) scan. Only load them when at least one safe pending
    // item actually has dependencies (the common empty/independent case skips it).
    const hasDeps = safePending.some((op) => op.dependsOn.length > 0);
    const completedIds = new Set<string>();
    const deadLetterIds = new Set<string>();
    if (hasDeps) {
      const allCompleted = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('completed'));
      for (const op of allCompleted) completedIds.add(op.id);
      const allDead = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('dead_letter'));
      for (const op of allDead) deadLetterIds.add(op.id);
    }

    const blocked = new Set<string>(completedIds);
    for (const id of deadLetterIds) blocked.add(id);

    safePending.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const ready: QueuedOperation[] = [];
    const processingIds = new Set<string>();

    // Iteratively resolve dependencies within the batch:
    // Items with no deps are added immediately.
    // Items whose deps are blocked (completed/dead) are also added.
    // Then items whose deps are now in the current batch are added (transitive).
    let changed = true;
    while (changed && ready.length < limit) {
      changed = false;
      for (const op of safePending) {
        if (processingIds.has(op.id)) continue;
        if (ready.length >= limit) break;

        const allDepsMet = op.dependsOn.length === 0 ||
          op.dependsOn.every(depId => blocked.has(depId) || processingIds.has(depId));

        if (allDepsMet) {
          ready.push(op);
          processingIds.add(op.id);
          changed = true;
        }
      }
    }

    const now = new Date().toISOString();
    for (const op of ready) {
      op.status = 'syncing';
      op.lastAttempt = now;
      await db.put('operations', op);
    }
    /* SYNC-FORENSIC suppressed: STAGE-4 durableSyncQueue.dequeue() returned */
    return ready;
  },

  async markCompleted(id: string, serverTimestamp?: string): Promise<void> {
    const db = await getDb();
    const item = await db.get('operations', id);
    if (item) {
      item.status = 'completed';
      item.retryCount = 0;
      item.lastAttempt = serverTimestamp || new Date().toISOString();
      item.lastError = null;
      await db.put('operations', item);
    }
  },

  async markFailed(id: string, error: string, overrideErrorType?: 'retryable' | 'permanent' | 'unauthorized'): Promise<void> {
    const db = await getDb();
    const item = await db.get('operations', id);
    if (item) {
      const errorType = overrideErrorType || classifyError(error);
      // Unauthorized items stay in 'failed' — they must NEVER be retried
      // automatically. Only resumeAfterAuth() (after the user re-authenticates)
      // moves them back to 'pending'.
      item.status = errorType === 'permanent' ? 'dead_letter' : 'failed';
      if (errorType === 'unauthorized') item.status = 'failed';
      item.retryCount = item.retryCount + 1;
      item.lastAttempt = new Date().toISOString();
      item.lastError = error;
      item.errorType = errorType;
      await db.put('operations', item);
    }
  },

  /**
   * Force an item to the dead-letter queue regardless of error classification.
   * Used for conflicts that cannot converge automatically (same-field edits on
   * both devices) so the background loop stops hammering the record and the
   * item stays visible for manual review/retry.
   */
  async deadLetter(id: string, error: string): Promise<void> {
    const db = await getDb();
    const item = await db.get('operations', id);
    if (item) {
      item.status = 'dead_letter';
      item.retryCount = item.retryCount + 1;
      item.lastAttempt = new Date().toISOString();
      item.lastError = error;
      item.errorType = 'permanent';
      await db.put('operations', item);
    }
  },

  async retryDeadLetter(id: string): Promise<void> {
    const db = await getDb();
    const item = await db.get('operations', id);
    if (item && item.status === 'dead_letter') {
      // Legacy ops quarantined for missing generation provenance cannot be
      // legitimately retried — re-sending them would re-trigger the same
      // rejection (or worse, replay without provenance). The only safe path is
      // to re-create the record in the app so a fresh op is stamped with the
      // current generation. Keep it terminal.
      if (!isGenerationValid(item.syncGeneration)) {
        item.lastError = LEGACY_GENERATION_QUARANTINE_REASON +
          ' Manual retry is blocked: re-save the record in the app to create a new operation with the current generation.';
        item.lastAttempt = new Date().toISOString();
        await db.put('operations', item);
        return;
      }
      item.status = 'pending';
      item.retryCount = 0;
      item.lastError = null;
      item.errorType = null;
      await db.put('operations', item);
    }
  },

  /**
   * Requeue an operation in place with a new payload (used after an
   * optimistic-concurrency conflict is field-merged). The item keeps its
   * id, order, dependencies and retry history so the merge round-trip stays a
   * single queue entry instead of spawning a duplicate op.
   */
  async requeue<T>(id: string, payload: T, updates: Partial<Pick<QueuedOperation, 'conflictCount'>> = {}): Promise<void> {
    const db = await getDb();
    const item = await db.get('operations', id);
    if (!item) return;
    const payloadStr = JSON.stringify(payload);
    item.payload = payload;
    item.payloadSizeBytes = payloadStr.length;
    if (updates.conflictCount !== undefined) item.conflictCount = updates.conflictCount;
    item.status = 'pending';
    item.lastError = null;
    item.errorType = null;
    item.lastAttempt = new Date().toISOString();
    await db.put('operations', item);
  },

  async recordConflict(record: {
    operationId: string | null;
    table: string;
    recordId: string | null;
    conflictedFields: string[];
    resolved: 'auto' | 'review';
    serverVersion: number;
  }): Promise<void> {
    const db = await getDb();
    await db.put('metrics', {
      id: `conflict-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      metric: 'sync_conflicts_total',
      value: record,
    });
    const counter = await this.getMeta('conflicts_total');
    await this.setMeta('conflicts_total', Number(counter || 0) + 1);
  },

  async getConflictCount(): Promise<{ auto: number; review: number }> {
    const all = await this.getMetrics();
    return { auto: all.conflictsAuto, review: all.conflictsReview };
  },

  async getConflicts(limit: number = 50): Promise<unknown[]> {
    const db = await getDb();
    const all = await db.getAllFromIndex('metrics', 'by-metric', IDBKeyRange.only('sync_conflicts_total'));
    return all
      .filter((m) => (m.value as { resolved?: string })?.resolved !== undefined)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, limit)
      .map((m) => m.value);
  },

  async remove(id: string): Promise<void> {
    const db = await getDb();
    await db.delete('operations', id);
  },

  async cleanup(completedRetentionMs: number = 86400000, deadLetterRetentionMs: number = 30 * 86400000, metricsRetentionMs: number = 90 * 86400000): Promise<number> {
    const db = await getDb();
    const cutoff = new Date(Date.now() - completedRetentionMs).toISOString();
    const dlCutoff = new Date(Date.now() - deadLetterRetentionMs).toISOString();
    const metricsCutoff = new Date(Date.now() - metricsRetentionMs).toISOString();
    const all = await db.getAll('operations');
    let removed = 0;
    for (const item of all) {
      if (item.status === 'completed' && item.lastAttempt && item.lastAttempt < cutoff) {
        await db.delete('operations', item.id);
        removed++;
        continue;
      }
      // Dead-letter ops that outlive their retention are archival — their
      // payload is no longer actionable (they were never going to retry) and
      // keeping them bloats the queue forever. They are removed as part of
      // queue compaction.
      if (item.status === 'dead_letter' && item.lastAttempt && item.lastAttempt < dlCutoff) {
        await db.delete('operations', item.id);
        removed++;
      }
    }
    // Conflict/health telemetry records also accumulate. Prune anything older
    // than the metrics retention window so the bounds stay small.
    const metricsAll = await db.getAll('metrics');
    for (const rec of metricsAll) {
      if (rec.timestamp && rec.timestamp < metricsCutoff) {
        await db.delete('metrics', rec.id);
        removed++;
      }
    }
    return removed;
  },

  async countPending(): Promise<number> {
    const db = await getDb();
    return (await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('pending'))).length;
  },

  async countFailed(): Promise<number> {
    const db = await getDb();
    return (await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('failed'))).length;
  },

  async countDeadLetter(): Promise<number> {
    const db = await getDb();
    return (await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('dead_letter'))).length;
  },

  async getAll(status?: QueueStatus): Promise<QueuedOperation[]> {
    const db = await getDb();
    if (status) {
      return db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only(status));
    }
    return db.getAll('operations');
  },

  async getByOperationId(operationId: string): Promise<QueuedOperation | undefined> {
    const db = await getDb();
    const all = await db.getAllFromIndex('operations', 'by-operationId', operationId);
    return all[0];
  },

  async hasPendingMutation(table: string, recordId: string): Promise<boolean> {
    const db = await getDb();
    const activeLayers = await Promise.all(
      (['pending', 'syncing', 'failed'] as QueueStatus[]).map((status) =>
        db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only(status))
      )
    );
    const allActive = ([] as QueuedOperation[]).concat(...activeLayers);
    return allActive.some(
      (op) => op.table === table && op.recordId === recordId
    );
  },

  async retryFailed(): Promise<number> {
    const db = await getDb();
    const failed = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('failed'));
    let count = 0;
    const MAX_RETRIES = 10;
    for (const item of failed) {
      // Legacy items without generation provenance can never be safely retried:
      // a retry would re-send an operation whose generation cannot be verified
      // (and the backend would reject it with SYNC_GENERATION_MISSING anyway,
      // creating an endless fail→requeue loop). Quarantine them instead.
      if (!isGenerationValid(item.syncGeneration)) {
        await quarantineOp(db, item);
        continue;
      }
      // Permanent authorization failures (401/403) must NEVER be auto-retried.
      // They are left in 'failed' until the user re-authenticates and calls
      // resumeAfterAuth(), which stamps auth_restored and re-queues them once.
      if (item.errorType === 'unauthorized') {
        continue;
      }
      if ((item.retryCount || 0) >= MAX_RETRIES) {
        // A transient failure that never succeeded after the retry budget is
        // escalated to the terminal dead-letter state so the periodic loop
        // stops hammering it. Keep the last error for the SyncHealth UI.
        item.status = 'dead_letter';
        item.errorType = 'permanent';
        await db.put('operations', item);
      } else {
        await db.put('operations', { ...item, status: 'pending' });
        count++;
      }
    }
    return count;
  },

  /**
   * After the user has re-authenticated, the queue can safely retry the items
   * that previously failed with 401/403. We re-queue them once and clear the
   * auth-block meta key so the sync engine drains normally.
   */
  async resumeAfterAuth(): Promise<number> {
    const db = await getDb();
    const failed = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('failed'));
    let count = 0;
    for (const item of failed) {
      if (item.errorType !== 'unauthorized') continue;
      await db.put('operations', {
        ...item,
        status: 'pending',
        errorType: null,
        lastError: null,
      });
      count++;
    }
    if (count > 0) {
      await db.delete('meta', 'sync_auth_blocked_at');
    }
    return count;
  },

  /**
   * Mark the queue as authorization-blocked. Sync callers should observe this
   * via isAuthBlocked() and pause background sync until the user signs in again.
   */
  async markAuthBlocked(reason: string): Promise<void> {
    const db = await getDb();
    await db.put('meta', { key: 'sync_auth_blocked_at', value: { at: new Date().toISOString(), reason } });
  },

  async clearAuthBlocked(): Promise<void> {
    const db = await getDb();
    await db.delete('meta', 'sync_auth_blocked_at');
  },

  async isAuthBlocked(): Promise<boolean> {
    const db = await getDb();
    const record = await db.get('meta', 'sync_auth_blocked_at');
    return Boolean(record);
  },

  async getMetrics(): Promise<QueueMetrics> {
    const db = await getDb();
    const all = await db.getAll('operations');
    const byStatus: Record<string, QueuedOperation[]> = {};
    for (const op of all) {
      if (!byStatus[op.status]) byStatus[op.status] = [];
      byStatus[op.status].push(op);
    }

    const pending = (byStatus.pending || []).length;
    const syncing = (byStatus.syncing || []).length;
    const failed = (byStatus.failed || []).length;
    const completed = (byStatus.completed || []).length;
    const deadLetter = (byStatus.dead_letter || []).length;

    const sortedByCreated = [...(byStatus.pending || [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const oldestPending = sortedByCreated.length > 0 ? sortedByCreated[0].createdAt : null;

    // recordMetric stamps ids with a timestamp suffix (e.g.
    // `last_sync_success-1754...`), so telemetry lookups go through the
    // by-metric index and take the most recent record instead of an exact id.
    const lastSuccessRecs = await db.getAllFromIndex('metrics', 'by-metric', IDBKeyRange.only('last_sync_success'));
    const lastFailureRecs = await db.getAllFromIndex('metrics', 'by-metric', IDBKeyRange.only('last_sync_failure'));
    const latest = (recs: unknown[]) => (recs as { timestamp: string; value: unknown }[])
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]?.value ?? null;
    const lastSuccess = latest(lastSuccessRecs);
    const lastFailure = latest(lastFailureRecs);

    const retryCounts: Record<number, number> = {};
    for (const op of all) {
      const rc = op.retryCount || 0;
      retryCounts[rc] = (retryCounts[rc] || 0) + 1;
    }

    const totalRetries = all.reduce((sum, op) => sum + (op.retryCount || 0), 0);
    const avgRetryCount = all.length > 0 ? totalRetries / all.length : 0;

    // Real sync latency from the last batch record (previously hardcoded 0).
    let avgSyncLatencyMs = 0;
    try {
      const lastBatch = await db.get('meta', 'last_sync_batch') as { key: string; value?: { durationMs?: number; batchCount?: number } } | undefined;
      if (lastBatch?.value && lastBatch.value.batchCount && lastBatch.value.durationMs) {
        avgSyncLatencyMs = Math.round(lastBatch.value.durationMs / lastBatch.value.batchCount);
      }
    } catch {
      // best-effort latency
    }

    // Conflict telemetry: persisted counter + per-resolution-type tallies.
    const conflictsTotal = Number(await this.getMeta('conflicts_total') || 0);
    const conflictRecords = await db.getAllFromIndex('metrics', 'by-metric', IDBKeyRange.only('sync_conflicts_total'));
    let conflictsAuto = 0;
    let conflictsReview = 0;
    for (const rec of conflictRecords) {
      const r = rec.value as { resolved?: 'auto' | 'review' };
      if (r?.resolved === 'review') conflictsReview++;
      else conflictsAuto++;
    }

    return {
      total: all.length,
      pending,
      syncing,
      failed,
      completed,
      deadLetter,
      oldestPending,
      lastSyncSuccess: lastSuccess as string | null,
      lastSyncFailure: lastFailure as string | null,
      retryHistogram: retryCounts,
      avgRetryCount,
      avgSyncLatencyMs,
      conflictsTotal,
      conflictsAuto,
      conflictsReview,
    };
  },

  async recordMetric(metric: string, value: unknown): Promise<void> {
    const db = await getDb();
    await db.put('metrics', {
      id: `${metric}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      metric,
      value,
    });
  },

  async getMeta(key: string): Promise<unknown | undefined> {
    const db = await getDb();
    const record = await db.get('meta', key);
    return record?.value;
  },

  async setMeta(key: string, value: unknown): Promise<void> {
    const db = await getDb();
    await db.put('meta', { key, value });
  },

  async rebuildDependencyGraph(): Promise<number> {
    const db = await getDb();
    const pending = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only('pending'));
    const all = await db.getAll('operations');
    let recovered = 0;
    for (const op of pending) {
      if (op.dependsOn.length > 0) {
        const visited = new Set<string>();
        const path = new Set<string>();
        if (detectCycle(op.dependsOn, all, visited, path)) {
          op.lastError = `Dependency cycle detected and broken: ${op.dependsOn.join(', ')}`;
          op.dependsOn = [];
          await db.put('operations', op);
          recovered++;
        }
      }
    }
    return recovered;
  },

  /**
   * Invalidate all pending/syncing/failed operations in the queue because the
   * server rejected them as stale (sync generation mismatch). Moves them to
   * dead_letter status so they are never retried.
   */
  async invalidateStaleOperations(): Promise<number> {
    const db = await getDb();
    const staleStatuses: QueueStatus[] = ['pending', 'syncing', 'failed'];
    let count = 0;
    for (const status of staleStatuses) {
      const ops = await db.getAllFromIndex('operations', 'by-status', IDBKeyRange.only(status));
      for (const op of ops) {
        op.status = 'dead_letter';
        op.lastError = 'Invalidated: server rejected as stale sync generation';
        op.errorType = 'permanent';
        await db.put('operations', op);
        count++;
      }
    }
    return count;
  },

  /**
   * Remove all operations from the queue (all statuses). Used when the local
   * generation is known to be behind the server and the entire queue is stale.
   */
  async clearAllOperations(): Promise<void> {
    const db = await getDb();
    const all = await db.getAll('operations');
    for (const op of all) {
      await db.delete('operations', op.id);
    }
  },

  async destroy(): Promise<void> {
    const db = await getDb();
    db.close();
    dbPromise = null;
    const { deleteDB } = await import('idb');
    await deleteDB(DB_NAME);
  },
};

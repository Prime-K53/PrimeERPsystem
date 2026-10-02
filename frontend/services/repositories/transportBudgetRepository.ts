/**
 * transportBudgetRepository.ts — Phase 4: offline-first Transport Budget
 * event repository.
 *
 * Pattern: local-first IndexedDB persistence via `dbService` (store
 * `transportBudgetEvents`, durable local representation for offline events)
 * with cloud sync through the standard durable queue
 * (table `transport_budget_events` -> POST /api/sync/ops). Same architecture
 * as the referral/sales repositories: the event id and idempotency key are
 * generated client-side, so an offline-created event keeps its identity
 * through queue -> server -> pull without duplicates.
 *
 * Deliberately NOT extending BaseRepository: its update()/softDelete()
 * primitives violate append-only ledger semantics. This repository exposes
 * append + read primitives only:
 *   appendTransportBudgetEvent / appendReversal /
 *   getTransportBudgetEvent / findTransportBudgetEventByIdempotencyKey /
 *   listTransportBudgetEvents / getReversalTotal
 *
 * There are intentionally NO business-specific producers here
 * (no allocateSale / consumeLandingCost / consumeDelivery). Those belong to
 * later phases.
 *
 * Correctness layers:
 *   1. Pure validator (fail-fast, fail-closed shape checks).
 *   2. Repository pre-checks (id/key dedupe, reversal target + cumulative
 *      cap) with a per-instance append mutex so concurrent appends from this
 *      client cannot interleave read -> calculate -> write.
 *   3. Database triggers (authoritative): BEFORE INSERT validates the
 *      per-kind matrix + cumulative reversal cap under a target row lock;
 *      BEFORE UPDATE/DELETE reject every mutation on any write path.
 */

import { dbService } from '../db';
import { durableSyncQueue } from '../durableSyncQueue';
import { logger } from '../logger';
import { newId } from '../../utils/ulid';
import {
  assertValidTransportBudgetEvent,
  sameEconomicPayload,
} from '../transportBudgetValidator';
import type {
  NewTransportBudgetEventInput,
  TransportBudgetEvent,
  TransportBudgetEventFilter,
} from '../../types/transportBudget';
import {
  TRANSPORT_BUDGET_STORE_NAME,
  TRANSPORT_BUDGET_TABLE_NAME,
} from '../../types/transportBudget';

export interface TransportBudgetAppendResult {
  event: TransportBudgetEvent;
  /**
   * True when the submission resolved to an already-stored event
   * (same id retry or same idempotency key) instead of creating a row.
   */
  deduplicated: boolean;
}

export interface TransportBudgetReversalTotal {
  /** Sum of existing reversal amounts for the target (<= 0). */
  total: number;
  count: number;
}

export class TransportBudgetDuplicateIdError extends Error {
  readonly existing: TransportBudgetEvent;

  constructor(existing: TransportBudgetEvent) {
    super(
      `Transport budget event id ${existing.id} already exists with a different payload.`,
    );
    this.name = 'TransportBudgetDuplicateIdError';
    this.existing = existing;
  }
}

export class TransportBudgetReversalError extends Error {
  readonly code:
    | 'TARGET_MISSING'
    | 'TARGET_NOT_REVERSIBLE'
    | 'CAP_EXCEEDED';

  constructor(
    code: TransportBudgetReversalError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TransportBudgetReversalError';
    this.code = code;
  }
}

/** Local persistence port (IndexedDB via dbService by default). */
export interface TransportBudgetEventStore {
  get(id: string): Promise<TransportBudgetEvent | undefined>;
  getAll(): Promise<TransportBudgetEvent[]>;
  put(event: TransportBudgetEvent): Promise<void>;
}

/** Sync-queue port (durableSyncQueue by default). */
export interface TransportBudgetEventSyncQueue {
  enqueue(
    table: string,
    recordId: string,
    payload: TransportBudgetEvent,
  ): Promise<void>;
  hasPendingMutation(table: string, recordId: string): Promise<boolean>;
}

const freezeEvent = (event: TransportBudgetEvent): TransportBudgetEvent =>
  Object.freeze({ ...event });

const generateEventId = (): string => {
  try {
    if (
      typeof crypto !== 'undefined' &&
      typeof crypto.randomUUID === 'function'
    ) {
      const uuid = crypto.randomUUID();
      if (typeof uuid === 'string' && uuid.length > 0) return uuid;
    }
  } catch {
    // Fall through to the ULID fallback below.
  }
  // Offline-safe fallback (same generator dbService uses for new records).
  return newId('TBE');
};

const nowIso = (): string => new Date().toISOString();

const defaultStore: TransportBudgetEventStore = {
  async get(id: string): Promise<TransportBudgetEvent | undefined> {
    if (!id) return undefined;
    return dbService.get<TransportBudgetEvent>(
      TRANSPORT_BUDGET_STORE_NAME as never,
      id,
    );
  },
  async getAll(): Promise<TransportBudgetEvent[]> {
    return (
      (await dbService.getAll<TransportBudgetEvent>(
        TRANSPORT_BUDGET_STORE_NAME as never,
      )) || []
    );
  },
  async put(event: TransportBudgetEvent): Promise<void> {
    // Local-first write through dbService (durable IndexedDB persistence).
    // NOTE: dbService.put also performs the standard sync enqueue for
    // non-local-only stores, which is the queue step for the default path
    // (it throws on enqueue failure, matching repository convention). The
    // repository therefore only tops up the queue when no mutation is
    // pending (see ensureQueuedAfterAppend), so retries stay self-healing
    // without ever double-enqueueing.
    await dbService.put(TRANSPORT_BUDGET_STORE_NAME as never, event as never);
  },
};

const defaultQueue: TransportBudgetEventSyncQueue = {
  async enqueue(
    table: string,
    recordId: string,
    payload: TransportBudgetEvent,
  ): Promise<void> {
    await durableSyncQueue.enqueue({
      table,
      recordId,
      operation: 'upsert',
      payload,
    });
    try {
      const { backgroundSyncService } = await import(
        '../backgroundSyncService'
      );
      backgroundSyncService.trigger();
    } catch {
      // Best-effort: the periodic engine drains the queue regardless.
    }
  },
  async hasPendingMutation(
    table: string,
    recordId: string,
  ): Promise<boolean> {
    return durableSyncQueue.hasPendingMutation(table, recordId);
  },
};

export class TransportBudgetRepository {
  private readonly store: TransportBudgetEventStore;
  private readonly queue: TransportBudgetEventSyncQueue;
  /** Serializes appends so local cap checks cannot interleave. */
  private appendTail: Promise<unknown> = Promise.resolve();

  constructor(
    store: TransportBudgetEventStore = defaultStore,
    queue: TransportBudgetEventSyncQueue = defaultQueue,
  ) {
    this.store = store;
    this.queue = queue;
  }

  /**
   * Append a new event (or resolve a retry to the existing event).
   * Never edits, never deletes, never calculates business meaning.
   */
  async appendTransportBudgetEvent(
    input: NewTransportBudgetEventInput,
  ): Promise<TransportBudgetAppendResult> {
    const run: Promise<TransportBudgetAppendResult> =
      this.appendTail.then(() => this.appendInner(input));
    // Keep the chain alive for later appends regardless of outcome.
    this.appendTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Append-only reversal primitive (structural only — no sales void /
   * credit-note detection, no producer logic).
   */
  async appendReversal(
    input: Omit<NewTransportBudgetEventInput, 'kind'> & {
      kind?: 'REVERSAL';
    },
  ): Promise<TransportBudgetAppendResult> {
    if (input.kind !== undefined && input.kind !== 'REVERSAL') {
      throw new TransportBudgetReversalError(
        'TARGET_NOT_REVERSIBLE',
        'appendReversal only accepts REVERSAL events.',
      );
    }
    return this.appendTransportBudgetEvent({ ...input, kind: 'REVERSAL' });
  }

  async getTransportBudgetEvent(
    id: string,
  ): Promise<TransportBudgetEvent | null> {
    if (!id) return null;
    try {
      const found = await this.store.get(String(id));
      return found ? freezeEvent(found) : null;
    } catch (err) {
      logger.error('[TransportBudget] get failed:', err);
      return null;
    }
  }

  async findTransportBudgetEventByIdempotencyKey(
    key: string,
  ): Promise<TransportBudgetEvent | null> {
    const needle = String(key || '').trim();
    if (!needle) return null;
    const all = await this.store.getAll();
    const found = (all || []).find(
      (entry) => String(entry?.idempotencyKey || '') === needle,
    );
    return found ? freezeEvent(found) : null;
  }

  /**
   * Deterministic retrieval (businessDate ASC, then id ASC).
   * Date filtering always uses businessDate, never created_at/sync time.
   * Returns raw validated records — no generated/consumed/balance math
   * (reporting belongs to a later phase).
   */
  async listTransportBudgetEvents(
    filter: TransportBudgetEventFilter = {},
  ): Promise<TransportBudgetEvent[]> {
    const all = (await this.store.getAll()) || [];
    const filtered = all.filter((entry) => {
      if (!entry) return false;
      if (filter.kind !== undefined && entry.kind !== filter.kind) return false;
      if (
        filter.sourceEventId !== undefined &&
        (entry.sourceEventId ?? null) !== filter.sourceEventId
      ) {
        return false;
      }
      if (
        filter.fromBusinessDate !== undefined &&
        String(entry.businessDate || '') < filter.fromBusinessDate
      ) {
        return false;
      }
      if (
        filter.toBusinessDate !== undefined &&
        String(entry.businessDate || '') > filter.toBusinessDate
      ) {
        return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      const dateOrder = String(a.businessDate || '').localeCompare(
        String(b.businessDate || ''),
      );
      if (dateOrder !== 0) return dateOrder;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    return filtered.map(freezeEvent);
  }

  /** Cumulative reversal position for one allocation (all amounts <= 0). */
  async getReversalTotal(
    eventId: string,
  ): Promise<TransportBudgetReversalTotal> {
    const all = (await this.store.getAll()) || [];
    let total = 0;
    let count = 0;
    for (const entry of all) {
      if (
        entry?.kind === 'REVERSAL' &&
        (entry.reversesEventId ?? null) === String(eventId)
      ) {
        total += Number(entry.amount) || 0;
        count += 1;
      }
    }
    return { total, count };
  }

  private async appendInner(
    input: NewTransportBudgetEventInput,
  ): Promise<TransportBudgetAppendResult> {
    const timestamp = nowIso();
    const candidate = {
      ...input,
      id:
        typeof input.id === 'string' && input.id.trim() !== ''
          ? input.id.trim()
          : generateEventId(),
      occurredAt:
        typeof (input as { occurredAt?: unknown }).occurredAt === 'string' &&
        String((input as { occurredAt?: unknown }).occurredAt).trim() !== ''
          ? String((input as { occurredAt?: unknown }).occurredAt)
          : timestamp,
    };

    // 1. Fail-closed shape validation (never calculates business meaning).
    const event = assertValidTransportBudgetEvent(candidate, timestamp);

    // 2. Physical idempotency: same id already stored?
    const byId = await this.store.get(event.id);
    if (byId) {
      if (sameEconomicPayload(byId, event)) {
        await this.ensureQueued(byId);
        return { event: freezeEvent(byId), deduplicated: true };
      }
      throw new TransportBudgetDuplicateIdError(freezeEvent(byId));
    }

    // 3. Economic idempotency: same idempotency key already stored?
    const byKey = await this.findTransportBudgetEventByIdempotencyKey(
      event.idempotencyKey,
    );
    if (byKey) {
      await this.ensureQueued(byKey);
      return { event: byKey, deduplicated: true };
    }

    // 4. Reversal structural integrity + cumulative cap (fail-fast mirror of
    //    the database trigger, which remains authoritative across devices).
    if (event.kind === 'REVERSAL') {
      await this.assertReversibleTarget(event);
    }

    // 5. Durable local persistence first (offline-safe), then make sure
    // the cloud write is queued (the default store already enqueued via
    // dbService.put; custom stores rely on this top-up instead).
    const frozen = freezeEvent(event);
    await this.store.put({ ...frozen });
    await this.ensureQueuedAfterAppend(frozen);
    return { event: frozen, deduplicated: false };
  }

  private async assertReversibleTarget(
    event: TransportBudgetEvent,
  ): Promise<void> {
    const targetId = String(event.reversesEventId || '');
    const target = await this.store.get(targetId);
    if (!target) {
      throw new TransportBudgetReversalError(
        'TARGET_MISSING',
        `Reversal target ${targetId} does not exist.`,
      );
    }
    if (target.kind !== 'SALES_ALLOCATION') {
      throw new TransportBudgetReversalError(
        'TARGET_NOT_REVERSIBLE',
        `Only SALES_ALLOCATION events are reversible (target ${targetId} is ${target.kind}).`,
      );
    }
    const { total } = await this.getReversalTotal(targetId);
    const remaining = Number(target.amount) + total + Number(event.amount);
    // All amounts are 2dp integers-in-effect; epsilon guards float noise.
    if (remaining < -0.000001) {
      throw new TransportBudgetReversalError(
        'CAP_EXCEEDED',
        `Cumulative reversals would exceed allocation ${targetId} (remaining ${Number(target.amount) + total}, requested ${Math.abs(Number(event.amount))}).`,
      );
    }
  }

  /**
   * Post-append queue top-up: enqueue only when no mutation is pending.
   * The default store already queued via dbService.put (so this is a no-op
   * there); injected stores that persist without queueing are covered here.
   * A queue failure is surfaced — local durability is preserved, but the
   * caller must retry instead of assuming cloud delivery.
   */
  private async ensureQueuedAfterAppend(
    event: TransportBudgetEvent,
  ): Promise<void> {
    let pending = false;
    try {
      pending = await this.queue.hasPendingMutation(
        TRANSPORT_BUDGET_TABLE_NAME,
        event.id,
      );
    } catch {
      pending = false;
    }
    if (pending) return;
    try {
      await this.queue.enqueue(TRANSPORT_BUDGET_TABLE_NAME, event.id, {
        ...event,
      });
    } catch (err) {
      logger.warn('[TransportBudget] queue enqueue failed:', err);
      throw err;
    }
  }

  /**
   * Self-healing retries: a deduplicated event must still reach the cloud.
   * If no mutation is pending for it (e.g. an earlier queue write failed),
   * re-enqueue the stored record.
   */
  private async ensureQueued(event: TransportBudgetEvent): Promise<void> {
    try {
      const pending = await this.queue.hasPendingMutation(
        TRANSPORT_BUDGET_TABLE_NAME,
        event.id,
      );
      if (!pending) {
        await this.queue.enqueue(TRANSPORT_BUDGET_TABLE_NAME, event.id, {
          ...event,
        });
      }
    } catch (err) {
      logger.warn('[TransportBudget] ensureQueued failed:', err);
    }
  }
}

/** Default singleton wired to IndexedDB + the durable sync queue. */
export const transportBudgetRepository = new TransportBudgetRepository();

export default transportBudgetRepository;

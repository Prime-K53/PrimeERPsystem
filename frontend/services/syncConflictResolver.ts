export type ResolveResult = 'local_wins' | 'remote_wins';

const METADATA_FIELDS = new Set([
  'id', '_updatedAt', '_cloudSource', '_version',
  'version', 'updated_at', 'created_at', 'serverUpdatedAt',
]);

/**
 * Append-only financial event arrays: union by event id so a merge can never
 * drop a bill/capitalization/correction/reversal event (landingConsumption).
 * Events are immutable once written; the union of both sides is always the
 * safe merge. Applies to PO documents carrying landing consumption history.
 */
const APPEND_ONLY_EVENT_ARRAY_FIELDS = new Set(['landingConsumption']);

export function mergeLandingEventArrays(localVal: unknown, remoteVal: unknown): unknown[] | null {
  if (!Array.isArray(localVal) && !Array.isArray(remoteVal)) return null;
  const byId = new Map<string, unknown>();
  for (const arr of [localVal, remoteVal]) {
    if (!Array.isArray(arr)) {
      continue;
    }
    for (const ev of arr) {
      const id = ev && typeof ev === 'object' ? String((ev as any).id || '') : '';
      if (id) {
        if (!byId.has(id)) byId.set(id, ev);
      } else {
        byId.set(`noid-${byId.size}`, ev);
      }
    }
  }
  return [...byId.values()];
}

/**
 * Resolve conflict between local and remote records.
 * Uses server-authoritative `updated_at` as the truth, falls back to client `_updatedAt`.
 */
export function resolveConflict(
  localRecord: any,
  remoteRecord: any
): ResolveResult {
  const localVersion = Number(localRecord.version || localRecord._version || 0);
  const remoteVersion = Number(remoteRecord.version || remoteRecord._version || 0);

  if (localVersion > remoteVersion) return 'local_wins';
  if (remoteVersion > localVersion) return 'remote_wins';

  // Server timestamps are authoritative (in UTC from Supabase)
  const localTime = new Date(
    localRecord.serverUpdatedAt || localRecord.updated_at || localRecord._updatedAt || 0
  ).getTime();
  const remoteTime = new Date(
    remoteRecord.updated_at || remoteRecord._updatedAt || 0
  ).getTime();

  if (localTime >= remoteTime) return 'local_wins';
  return 'remote_wins';
}

export function mergeRecords(localRecord: any, remoteRecord: any): any {
  const winner = resolveConflict(localRecord, remoteRecord);
  const base = winner === 'local_wins'
    ? { ...remoteRecord, ...localRecord, _updatedAt: new Date().toISOString() }
    : { ...localRecord, ...remoteRecord, _updatedAt: new Date().toISOString() };
  // Append-only financial history (e.g. landingConsumption) unions by event
  // id on top of the winner-takes-all merge so no event is ever lost.
  for (const key of APPEND_ONLY_EVENT_ARRAY_FIELDS) {
    const union = mergeLandingEventArrays(localRecord?.[key], remoteRecord?.[key]);
    if (union) base[key] = union;
  }
  return base;
}

/**
 * Field-level merge: for each field, take the value from the record with the newer timestamp.
 * Uses server-authoritative `updated_at` first, falls back to client `_updatedAt`.
 *
 * This prevents silent data loss when two devices edit different fields of the same record.
 */
export function fieldLevelMerge(localRecord: any, remoteRecord: any): any {
  const localServerTime = new Date(
    localRecord.serverUpdatedAt || localRecord.updated_at || 0
  ).getTime();
  const localEditTime = new Date(localRecord._updatedAt || 0).getTime();
  const localTime = Math.max(localServerTime, localEditTime);

  const remoteTime = new Date(
    remoteRecord.updated_at || remoteRecord._updatedAt || 0
  ).getTime();

  const merged: Record<string, unknown> = {
    id: remoteRecord.id || localRecord.id,
    _updatedAt: new Date().toISOString(),
    serverUpdatedAt: remoteRecord.updated_at || remoteRecord.serverUpdatedAt || localRecord.serverUpdatedAt,
    _cloudSource: true,
  };

  const allKeys = new Set([
    ...Object.keys(localRecord || {}),
    ...Object.keys(remoteRecord || {}),
  ]);

  for (const key of allKeys) {
    if (METADATA_FIELDS.has(key)) continue;

    const localVal = localRecord?.[key];
    const remoteVal = remoteRecord?.[key];

    if (localVal === undefined && remoteVal === undefined) continue;
    if (localVal === undefined) { merged[key] = remoteVal; continue; }
    if (remoteVal === undefined) { merged[key] = localVal; continue; }

    if (JSON.stringify(localVal) === JSON.stringify(remoteVal)) {
      merged[key] = localVal;
      continue;
    }

    // Append-only financial history unions by event id instead of
    // last-write-wins: concurrent bill/capitalization events from two
    // devices both survive the merge.
    if (APPEND_ONLY_EVENT_ARRAY_FIELDS.has(key)) {
      const union = mergeLandingEventArrays(localVal, remoteVal);
      if (union) {
        merged[key] = union;
        continue;
      }
    }

    const localFieldTime = localRecord[`${key}_updatedAt`]
      ? new Date(localRecord[`${key}_updatedAt`]).getTime()
      : localTime;
    const remoteFieldTime = remoteRecord[`${key}_updatedAt`]
      ? new Date(remoteRecord[`${key}_updatedAt`]).getTime()
      : remoteTime;

    if (remoteFieldTime >= localFieldTime) {
      merged[key] = remoteVal;
    } else {
      merged[key] = localVal;
    }
  }

  // Preserve the server version so the local cache keeps participating in
  // optimistic concurrency: the next edit carries it back to the sync gateway
  // as the precondition for the write.
  merged.version = Number(
    remoteRecord?.version ?? remoteRecord?._version ?? localRecord?.version ?? localRecord?._version ?? 0
  );

  return merged;
}

export interface PushConflictResolution {
  /** Payload to re-push with a fresh `_version`, or null when there is no local delta left to push. */
  merged: Record<string, unknown> | null;
  /** True when the local payload had no domain changes vs the server row — the op is already satisfied. */
  converged: boolean;
  /** Fields both sides changed with different values; these were resolved by last-write-wins and may need user review. */
  conflictedFields: string[];
  serverVersion: number;
}

/**
 * Resolve a rejected push (optimistic-concurrency conflict). The server
 * rejected the write because another device committed a newer version of the
 * record, and returned its current snapshot. Field-merge the local payload
 * against that snapshot, stamp the fresh base version, and hand back the
 * payload to re-push.
 *
 * Fields only the local side touched are preserved. Fields both sides changed
 * with different values are resolved by last-write-wins (server commit time
 * vs local edit time) and reported in `conflictedFields` so callers can flag
 * them for user review where needed.
 */
export function resolvePushConflict(
  localPayload: Record<string, unknown>,
  serverData: Record<string, unknown> | null | undefined,
  serverMeta: { version?: number; updatedAt?: string | null }
): PushConflictResolution {
  const serverVersion = Number(serverMeta?.version ?? 0);
  const remote = {
    ...(serverData && typeof serverData === 'object' ? serverData : {}),
    updated_at: serverMeta?.updatedAt || undefined,
  };

  const merged = fieldLevelMerge(localPayload, remote) as Record<string, unknown>;
  merged._version = serverVersion;
  merged.version = serverVersion;
  merged.serverUpdatedAt = serverMeta?.updatedAt || merged.serverUpdatedAt;

  // Tombstone resurrection: when the server holds a tombstone (deleted: true)
  // but the local payload is an upsert (not a delete), strip the tombstone
  // flags so the record can be resurrected in the cloud. Without this, the
  // field-level merge inherits deleted:true from the server tombstone and the
  // create intent is silently converted to a delete.
  if (localPayload.deleted !== true) {
    delete merged.deleted;
    delete merged.deletedAt;
  }

  const serverKeys = new Set(Object.keys(remote));
  const conflictedFields: string[] = [];
  for (const key of Object.keys(localPayload)) {
    if (METADATA_FIELDS.has(key)) continue;
    if (!serverKeys.has(key) || localPayload[key] === undefined) continue;
    if (JSON.stringify(localPayload[key]) !== JSON.stringify(remote[key])) {
      conflictedFields.push(key);
    }
  }

  let hasDelta = false;
  for (const key of new Set([...Object.keys(remote), ...Object.keys(localPayload)])) {
    if (METADATA_FIELDS.has(key)) continue;
    const mergedVal = merged[key];
    const remoteVal = remote[key];
    if (mergedVal === undefined && remoteVal === undefined) continue;
    if (mergedVal === undefined || remoteVal === undefined) { hasDelta = true; break; }
    if (JSON.stringify(mergedVal) !== JSON.stringify(remoteVal)) { hasDelta = true; break; }
  }

  return {
    merged: hasDelta ? merged : null,
    converged: !hasDelta,
    conflictedFields,
    serverVersion,
  };
}

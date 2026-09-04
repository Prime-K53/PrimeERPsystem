import { API_BASE_URL } from '../config/api.js';
import { getJsonRequestHeaders } from './requestHeaders';

/**
 * syncApiClient.ts — browser-side client for the backend sync gateway
 * (`POST /api/sync/ops`).
 *
 * The durable sync queue used to write directly to Supabase. Under the
 * offline-first architecture the backend is the single gateway for ALL
 * business writes: it validates, applies idempotent upserts + tombstone
 * deletes, and writes to the cloud with the service-role key. This client
 * just forwards a batch of ops and returns the per-op results.
 */

export type SyncOpOperation = 'upsert' | 'delete';

export interface SyncOp {
  operationId?: string;
  table: string;
  recordId: string | null;
  operation: SyncOpOperation;
  payload: unknown;
  syncGeneration?: number;
}

export interface SyncOpResultServer {
  id?: string | null;
  version: number;
  updatedAt?: string | null;
  data?: Record<string, unknown> | null;
}

export interface SyncOpResult {
  operationId?: string;
  ok: boolean;
  id?: string | null;
  updatedAt?: string;
  version?: number;
  replayed?: boolean;
  noop?: boolean;
  /** True when the write was rejected by the optimistic-concurrency gate because another device changed the row since this client read it. */
  conflict?: boolean;
  conflictType?: 'version_conflict' | string;
  /** Current server-row snapshot returned alongside a conflict so the client can field-merge without a follow-up fetch. */
  server?: SyncOpResultServer;
  error?: string;
  retryable?: boolean;
  /** True when the server rejected the operation because its syncGeneration is older than the current company generation. */
  stale?: boolean;
  /** Rejection reason code: SYNC_GENERATION_STALE or SYNC_GENERATION_MISSING. */
  reason?: string;
}

export interface SyncOpsResponse {
  ok: boolean;
  processed?: number;
  succeeded?: number;
  results: SyncOpResult[];
}

const SYNC_ENDPOINT = `${API_BASE_URL}/sync/ops`;

/**
 * Sentinel error class for permanent authorization failures (401/403) from the
 * sync gateway. The durable sync queue must never retry these — they indicate
 * the current session is no longer authorized to write business data, so
 * retrying only multiplies the 401/403 storm and burns the user's quota.
 *
 * Thrown by `sendSyncOps()`; recognized by `classifyError()` in
 * durableSyncQueue.ts via the message prefix.
 */
export class SyncAuthError extends Error {
  readonly status: number;
  readonly code: 'unauthenticated' | 'forbidden';
  constructor(message: string, status: number) {
    super(message);
    this.name = 'SyncAuthError';
    this.status = status;
    this.code = status === 401 ? 'unauthenticated' : 'forbidden';
  }
}

/**
 * Get a fresh Supabase access token for the backend to verify.
 * Prefers the app session (nexus_user), falls back to supabase-js session.
 */
export async function getSyncAccessToken(): Promise<string | null> {
  try {
    const raw = sessionStorage.getItem('nexus_user');
    if (raw) {
      const session = JSON.parse(raw);
      if (session?.accessToken) return session.accessToken;
    }
  } catch {
    // ignore and fall through to supabase session
  }
  try {
    const { supabase } = await import('./supabaseClient');
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

export interface SyncSendOptions {
  timeoutMs?: number;
}

/**
 * Send a batch of operations to the backend sync gateway.
 *
 * Throws only on transport-level failures (offline / 5xx / 503 not-configured),
 * so the caller can retry the whole batch. Per-op validation failures come
 * back inside `results` with `ok:false` and must be dead-lettered individually.
 */
export async function sendSyncOps(ops: SyncOp[], options: SyncSendOptions = {}): Promise<SyncOpsResponse> {
  if (ops.length === 0) {
    return { ok: true, processed: 0, succeeded: 0, results: [] };
  }
  if (typeof fetch === 'undefined') {
    throw new Error('fetch is not available in this environment');
  }

  const token = await getSyncAccessToken();
  const headers: Record<string, string> = getJsonRequestHeaders();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  /* SYNC-FORENSIC suppressed: STAGE-8 syncApiClient.sendSyncOps() */

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 25000);

  try {
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ops }),
      signal: controller.signal,
    });

    /* SYNC-FORENSIC suppressed: STAGE-8 syncApiClient HTTP response */

    if (res.status === 503) {
      throw new Error('Cloud database is not configured on this server');
    }
    if (res.status === 429) {
      // Rate-limited by the gateway. Honor Retry-After when present and back off.
      const retryAfter = Number(res.headers.get('Retry-After') || 0);
      const hint = Number.isFinite(retryAfter) && retryAfter > 0 ? ` (retry after ${retryAfter}s)` : '';
      throw new Error(`Sync gateway rate-limited${hint}`);
    }
    if (res.status === 401 || res.status === 403) {
      // Permanent authorization failure. The durable queue must not retry
      // this — the session is no longer authorized to write business data.
      throw new SyncAuthError(`Sync gateway rejected the request (${res.status})`, res.status);
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const detail = (body as any)?.detail;
      const errorMsg = detail ? `${(body as any)?.error || 'Sync gateway failed'}: ${detail}` : ((body as any)?.error || `Sync gateway failed (${res.status})`);
      throw new Error(errorMsg);
    }

    const payload = await res.json() as SyncOpsResponse;
    if (!Array.isArray(payload?.results)) {
      throw new Error('Sync gateway returned an unexpected response');
    }
    return payload;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Sync gateway timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function isSyncGatewayConfigured(): boolean {
  return Boolean(API_BASE_URL);
}

/**
 * Count tombstones (soft-deleted rows) in a cloud table.
 * Requires a Supabase token; reads via the authenticated backend.
 */
export async function countTombstones(table: string): Promise<number> {
  try {
    const token = await getSyncAccessToken();
    const headers: Record<string, string> = getJsonRequestHeaders();
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${SYNC_ENDPOINT.replace('/ops', '')}/tombstones/count?table=${encodeURIComponent(table)}`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok) return 0;
      const body = await res.json();
      return Number(body?.count ?? 0);
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return 0;
  }
}

/**
 * Purge tombstones older than `retentionDays` for one table. The backend
 * archives each purged row (JSONL in the workspace) before hard-deleting.
 * Returns the number purged. Throws on non-2xx so the dashboard can surface it.
 */
export async function purgeTombstones(table: string, retentionDays: number): Promise<{ purged: number; archived: number; skipped: number }> {
  const token = await getSyncAccessToken();
  const headers: Record<string, string> = getJsonRequestHeaders();
  if (token) headers.Authorization = `Bearer ${token}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${SYNC_ENDPOINT.replace('/ops', '')}/tombstones/purge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ table, retentionDays }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Tombstone purge failed (${res.status})`);
    }
    const body = await res.json();
    return { purged: Number(body?.purged ?? 0), archived: Number(body?.archived ?? 0), skipped: Number(body?.skipped ?? 0) };
  } finally {
    clearTimeout(timeout);
  }
}
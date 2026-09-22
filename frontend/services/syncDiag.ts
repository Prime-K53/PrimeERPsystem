/**
 * syncDiag.ts — DEVELOPMENT-ONLY diagnostic instrumentation for the
 * Device B offline → online sync + dashboard refresh investigation.
 *
 * READ/OBSERVE ONLY. This module never changes application behavior:
 * - No network calls, no storage writes, no store updates, no timers that
 *   gate application logic (one fire-and-forget summary timer only, DEV only).
 * - Every function is a no-op unless `import.meta.env.DEV` is true, so
 *   production builds are effectively uninstrumented.
 * - Logged fields are limited to safe metadata: timestamps, event names,
 *   correlation IDs, durations, counts, HTTP method/status/path, stage names.
 *   Never: credentials, tokens, cookies, request/response bodies, customer PII,
 *   invoice/payment/accounting payloads.
 *
 * All events use the single prefix `[ERP-SYNC-DIAG]`.
 */

const PREFIX = '[ERP-SYNC-DIAG]';

function isEnabled(): boolean {
  try {
    return (
      typeof import.meta !== 'undefined' &&
      (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true
    );
  } catch {
    return false;
  }
}

type FieldValue = string | number | boolean | null | undefined;

function wallClock(): string {
  try {
    const d = new Date();
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return (
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
      `${pad(d.getMilliseconds(), 3)}`
    );
  } catch {
    return 'unknown-time';
  }
}

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function perfNow(): number {
  try {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  } catch {
    return Date.now();
  }
}

/** Core emit. Behavior-neutral: single console.debug, DEV only. */
export function diagLog(event: string, fields?: Record<string, FieldValue>): void {
  if (!isEnabled()) return;
  try {
    let line = `${PREFIX} ${wallClock()} ${event}`;
    if (fields) {
      const parts: string[] = [];
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined || v === null) continue;
        parts.push(`${k}=${String(v)}`);
      }
      if (parts.length > 0) line += ` ${parts.join(' ')}`;
    }
    // eslint-disable-next-line no-console
    console.debug(line);
  } catch {
    // diagnostics must never throw into application code
  }
}

export function diagNewSyncId(): string {
  try {
    const rand = Math.random().toString(36).slice(2, 8);
    return `SYNC-DIAG-${Date.now()}-${rand}`;
  } catch {
    return 'SYNC-DIAG-unknown';
  }
}

// ─── Session tracking (in-memory only, never persisted, never sent) ──────────

interface DiagSession {
  syncId: string | null;
  onlineDetectedAt: number | null;
  syncStartAt: number | null;
  syncEndAt: number | null;
  dashboardTriggerAt: number | null;
  dashboardTriggerSource: string | null;
  dataLoadStartAt: number | null;
  dataLoadEndAt: number | null;
  renderAt: number | null;
  pendingBefore: number | null;
  pendingRetried: number | null;
  succeeded: number | null;
  failed: number | null;
  remaining: number | null;
  syncDurationMs: number | null;
}

const session: DiagSession = {
  syncId: null,
  onlineDetectedAt: null,
  syncStartAt: null,
  syncEndAt: null,
  dashboardTriggerAt: null,
  dashboardTriggerSource: null,
  dataLoadStartAt: null,
  dataLoadEndAt: null,
  renderAt: null,
  pendingBefore: null,
  pendingRetried: null,
  succeeded: null,
  failed: null,
  remaining: null,
  syncDurationMs: null,
};

// Lifetime counters for duplicate/retry/overlap findings (counts only).
const counters = {
  syncTriggers: 0,
  syncSkippedAlreadySyncing: 0,
  syncSkippedPaused: 0,
  syncSkippedAuthBlocked: 0,
  syncSkippedZeroPending: 0,
  syncRuns: 0,
  syncFailures: 0,
  syncRetries: 0,
  dashboardRefreshTriggers: 0,
  dashboardRefreshBySource: {} as Record<string, number>,
  dashboardDataLoads: 0,
  dashboardOverlappingSkips: 0,
  dashboardFreshThresholdSkips: 0,
  dashboardRequests: 0,
  dashboardRequestFailures: 0,
  syncRequests: 0,
  syncRequestFailures: 0,
};

function visibilityState(): string {
  try {
    return typeof document !== 'undefined' ? document.visibilityState : 'unknown';
  } catch {
    return 'unknown';
  }
}

function onLine(): string {
  try {
    return typeof navigator !== 'undefined' ? String(navigator.onLine) : 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Network ────────────────────────────────────────────────────────────────

export function diagOnlineDetected(source: string): void {
  if (!isEnabled()) return;
  session.onlineDetectedAt = nowMs();
  diagLog('network_online_detected', {
    source,
    visibilityState: visibilityState(),
    navigatorOnLine: onLine(),
  });
}

export function diagOfflineDetected(source: string): void {
  if (!isEnabled()) return;
  diagLog('network_offline_detected', {
    source,
    visibilityState: visibilityState(),
    navigatorOnLine: onLine(),
  });
}

export function diagSyncTriggerInvoked(source: string): void {
  if (!isEnabled()) return;
  counters.syncTriggers++;
  diagLog('sync_trigger_invoked', {
    source,
    visibilityState: visibilityState(),
    navigatorOnLine: onLine(),
    activeSyncId: session.syncId,
    syncTriggers: counters.syncTriggers,
  });
}

export function diagSyncTriggerSkipped(source: string, reason: string): void {
  if (!isEnabled()) return;
  if (reason === 'already-syncing' || reason === 'sync-in-progress') counters.syncSkippedAlreadySyncing++;
  else if (reason === 'paused') counters.syncSkippedPaused++;
  else if (reason === 'auth-blocked') counters.syncSkippedAuthBlocked++;
  else if (reason === 'zero-pending') counters.syncSkippedZeroPending++;
  diagLog('sync_trigger_skipped', {
    source,
    reason,
    activeSyncId: session.syncId,
  });
}

/**
 * Lock-contention skip — the critical evidence for the single-consumer
 * invariant. Emitted synchronously when a second invocation arrives while
 * a cycle holds the global sync lock.
 */
export function diagSyncSkipped(activeSyncId: string | null, trigger: string, reason: string): void {
  if (!isEnabled()) return;
  if (reason === 'sync-in-progress') counters.syncSkippedAlreadySyncing++;
  diagLog('sync_skipped', {
    reason,
    activeSyncId,
    trigger,
  });
}

export function diagLockAcquired(syncId: string, trigger: string): void {
  if (!isEnabled()) return;
  diagLog('sync_lock_acquired', { id: syncId, trigger });
}

export function diagLockReleased(syncId: string, outcome: string): void {
  if (!isEnabled()) return;
  diagLog('sync_lock_released', { id: syncId, outcome });
}

// ─── Sync lifecycle ─────────────────────────────────────────────────────────

export function diagSyncStarted(pendingBefore: number, retriedFailed: number, existingId?: string): string {
  // The invocation ID is generated at lock acquisition (before any await) so
  // every entry — admitted or skipped — carries an ID. Admitted invocations
  // reuse it as the cycle correlation ID.
  const syncId = existingId || diagNewSyncId();
  if (!isEnabled()) return syncId;
  counters.syncRuns++;
  session.syncId = syncId;
  session.syncStartAt = nowMs();
  session.syncEndAt = null;
  session.dashboardTriggerAt = null;
  session.dashboardTriggerSource = null;
  session.dataLoadStartAt = null;
  session.dataLoadEndAt = null;
  session.renderAt = null;
  session.pendingBefore = pendingBefore;
  session.pendingRetried = retriedFailed;
  session.succeeded = null;
  session.failed = null;
  session.remaining = null;
  session.syncDurationMs = null;
  diagLog('sync_started', {
    id: syncId,
    pendingCountBefore: pendingBefore,
    retriedFailedCount: retriedFailed,
  });
  return syncId;
}

export function diagActiveSyncId(): string | null {
  return session.syncId;
}

export function diagPendingQueueLoaded(
  syncId: string,
  count: number,
  opCounts: { insert?: number; update?: number; upsert?: number; delete?: number; other?: number },
  durationMs: number,
  batchNumber?: number,
): void {
  if (!isEnabled()) return;
  diagLog('pending_queue_loaded', {
    id: syncId,
    batch: batchNumber ?? -1,
    count,
    inserts: opCounts.insert ?? 0,
    updates: opCounts.update ?? 0,
    upserts: opCounts.upsert ?? 0,
    deletes: opCounts.delete ?? 0,
    other: opCounts.other ?? 0,
    pending_queue_load_duration_ms: Math.round(durationMs),
  });
}

export function diagStageStarted(syncId: string | null, stage: string, extra?: Record<string, FieldValue>): void {
  if (!isEnabled()) return;
  diagLog('sync_stage_started', { id: syncId, stage, ...extra });
}

export function diagStageCompleted(
  syncId: string | null,
  stage: string,
  durationMs: number,
  extra?: Record<string, FieldValue>,
): void {
  if (!isEnabled()) return;
  diagLog('sync_stage_completed', {
    id: syncId,
    stage,
    duration_ms: Math.round(durationMs),
    ...extra,
  });
}

export function diagStageFailed(
  syncId: string | null,
  stage: string,
  errorKind: string,
  extra?: Record<string, FieldValue>,
): void {
  if (!isEnabled()) return;
  counters.syncFailures++;
  diagLog('sync_stage_failed', { id: syncId, stage, errorKind, ...extra });
}

export function diagRetryWaitStarted(syncId: string | null, waitMs: number, reason: string): void {
  if (!isEnabled()) return;
  diagLog('sync_retry_wait_started', { id: syncId, wait_ms: Math.round(waitMs), reason });
}

export function diagRetryAttempt(syncId: string | null, attempt: string, requeued: number): void {
  if (!isEnabled()) return;
  counters.syncRetries++;
  diagLog('sync_retry_attempt', { id: syncId, attempt, requeued, syncRetries: counters.syncRetries });
}

// ─── HTTP (safe metadata only) ──────────────────────────────────────────────

export function diagRequestStarted(
  method: string,
  path: string,
  extra?: Record<string, FieldValue>,
): number {
  const t0 = perfNow();
  if (!isEnabled()) return t0;
  if (extra?.kind === 'sync') counters.syncRequests++;
  else counters.dashboardRequests++;
  const { kind: _kind, ...rest } = extra ?? {};
  diagLog('request_started', { method, path, ...rest });
  return t0;
}

export function diagRequestCompleted(
  method: string,
  path: string,
  startMs: number,
  status: number | string,
  extra?: Record<string, FieldValue>,
): void {
  if (!isEnabled()) return;
  const { kind: _kindOk, ...restOk } = extra ?? {};
  diagLog('request_completed', {
    method,
    path,
    status,
    duration_ms: Math.round(perfNow() - startMs),
    ...restOk,
  });
}

export function diagRequestFailed(
  method: string,
  path: string,
  startMs: number,
  errorKind: string,
  extra?: Record<string, FieldValue>,
): void {
  if (!isEnabled()) return;
  if (extra?.kind === 'sync') counters.syncRequestFailures++;
  else counters.dashboardRequestFailures++;
  const { kind: _kindFail, ...restFail } = extra ?? {};
  diagLog('request_failed', {
    method,
    path,
    errorKind,
    duration_ms: Math.round(perfNow() - startMs),
    ...restFail,
  });
}

export function diagSyncCompleted(
  syncId: string,
  totalDurationMs: number,
  successCount: number,
  failureCount: number,
  remainingPendingCount: number | null,
): void {
  if (!isEnabled()) return;
  session.syncEndAt = nowMs();
  session.succeeded = successCount;
  session.failed = failureCount;
  session.remaining = remainingPendingCount;
  session.syncDurationMs = Math.round(totalDurationMs);
  diagLog('sync_completed', {
    id: syncId,
    total_duration_ms: Math.round(totalDurationMs),
    success_count: successCount,
    failure_count: failureCount,
    remaining_pending_count: remainingPendingCount,
  });
}

// ─── Local state / dashboard ────────────────────────────────────────────────

export function diagLocalStateRefreshStarted(source: string, force: boolean): number {
  const t0 = perfNow();
  if (!isEnabled()) return t0;
  diagLog('local_state_refresh_started', {
    source,
    force,
    activeSyncId: session.syncId,
  });
  return t0;
}

export function diagLocalStateRefreshCompleted(source: string, startMs: number, extra?: Record<string, FieldValue>): void {
  if (!isEnabled()) return;
  diagLog('local_state_refresh_completed', {
    source,
    duration_ms: Math.round(perfNow() - startMs),
    activeSyncId: session.syncId,
    ...extra,
  });
}

export function diagLocalStateRefreshSkipped(source: string, reason: string): void {
  if (!isEnabled()) return;
  if (reason === 'already-in-flight') counters.dashboardOverlappingSkips++;
  if (reason === 'fresh-threshold') counters.dashboardFreshThresholdSkips++;
  diagLog('local_state_refresh_skipped', { source, reason, activeSyncId: session.syncId });
}

export function diagDashboardRefreshTriggered(source: string, detail?: string): void {
  if (!isEnabled()) return;
  counters.dashboardRefreshTriggers++;
  counters.dashboardRefreshBySource[source] = (counters.dashboardRefreshBySource[source] ?? 0) + 1;
  if (session.syncEndAt !== null && session.dashboardTriggerAt === null) {
    session.dashboardTriggerAt = nowMs();
    session.dashboardTriggerSource = source;
  }
  diagLog('dashboard_refresh_triggered', {
    source,
    detail,
    activeSyncId: session.syncId,
    dashboardRefreshTriggers: counters.dashboardRefreshTriggers,
  });
}

export function diagRefreshSignalReceived(channel: string, detail?: string): void {
  if (!isEnabled()) return;
  diagLog('dashboard_refresh_signal_received', { channel, detail });
}

export function diagDashboardDataLoadStarted(source: string): number {
  const t0 = perfNow();
  if (!isEnabled()) return t0;
  counters.dashboardDataLoads++;
  if (session.syncEndAt !== null && session.dataLoadStartAt === null) {
    session.dataLoadStartAt = nowMs();
  }
  diagLog('dashboard_data_load_started', { source, activeSyncId: session.syncId });
  return t0;
}

export function diagDashboardDataLoadCompleted(source: string, startMs: number): void {
  if (!isEnabled()) return;
  if (session.syncEndAt !== null && session.dataLoadEndAt === null) {
    session.dataLoadEndAt = nowMs();
  }
  diagLog('dashboard_data_load_completed', {
    source,
    duration_ms: Math.round(perfNow() - startMs),
    activeSyncId: session.syncId,
  });
}

export function diagPollingScheduled(source: string, requestedIntervalMs: number, effectiveIntervalMs: number): void {
  if (!isEnabled()) return;
  diagLog('dashboard_polling_scheduled', {
    source,
    requested_interval_ms: requestedIntervalMs,
    effective_interval_ms: effectiveIntervalMs,
  });
}

export function diagDashboardRenderUpdated(source: string, counts: Record<string, number>): void {
  if (!isEnabled()) return;
  if (session.syncEndAt !== null && session.renderAt === null) {
    session.renderAt = nowMs();
  }
  diagLog('dashboard_render_data_updated', {
    source,
    activeSyncId: session.syncId,
    ...counts,
  });
  diagMaybeSummarize();
}

// ─── Session summary ────────────────────────────────────────────────────────

function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return 'n/a';
  return `${Math.round(ms)}`;
}

function pickBottleneck(a: number | null, b: number | null, c: number | null, d: number | null, e: number | null, f: number | null): string {
  if (session.syncEndAt === null) return 'SYNC_NOT_COMPLETED_YET';
  if (session.dashboardTriggerAt === null) return 'NO_AUTOMATIC_DASHBOARD_REFRESH_AFTER_SYNC';
  const entries: Array<{ key: string; v: number | null }> = [
    { key: 'NETWORK_RECONNECT_TO_SYNC_START_DELAY', v: a },
    { key: 'SYNC_DURATION', v: b },
    { key: 'POST_SYNC_DASHBOARD_REFRESH_DELAY', v: c },
    { key: 'DASHBOARD_TRIGGER_TO_LOAD_DELAY', v: d },
    { key: 'DASHBOARD_API_RESPONSE_TIME', v: e },
    { key: 'DASHBOARD_RENDER_STATE_UPDATE_DELAY', v: f },
  ];
  let best = entries[0];
  for (const en of entries) {
    if ((en.v ?? -1) > (best.v ?? -1)) best = en;
  }
  if ((best.v ?? 0) <= 0) return 'NO_DOMINANT_INTERVAL_MEASURED';
  if (counters.dashboardOverlappingSkips > 0 && best.key === 'DASHBOARD_TRIGGER_TO_LOAD_DELAY') {
    return 'OVERLAPPING_DASHBOARD_REQUESTS';
  }
  return best.key;
}

/**
 * Emit the compact session summary. Called automatically on
 * dashboard_render_data_updated after a completed sync; safe to call
 * any time (no-op when there is no completed sync cycle to summarize).
 */
export function diagMaybeSummarize(): void {
  if (!isEnabled()) return;
  if (session.syncId === null || session.syncStartAt === null || session.syncEndAt === null) return;
  if (session.renderAt === null) return;
  const a = session.onlineDetectedAt !== null && session.syncStartAt !== null
    ? session.syncStartAt - session.onlineDetectedAt : null;
  const b = session.syncDurationMs;
  const c = session.syncEndAt !== null && session.dashboardTriggerAt !== null
    ? session.dashboardTriggerAt - session.syncEndAt : null;
  const d = session.dashboardTriggerAt !== null && session.dataLoadStartAt !== null
    ? session.dataLoadStartAt - session.dashboardTriggerAt : null;
  const e = session.dataLoadStartAt !== null && session.dataLoadEndAt !== null
    ? session.dataLoadEndAt - session.dataLoadStartAt : null;
  const f = session.dataLoadEndAt !== null && session.renderAt !== null
    ? session.renderAt - session.dataLoadEndAt : null;
  const total = session.onlineDetectedAt !== null && session.renderAt !== null
    ? session.renderAt - session.onlineDetectedAt : null;
  const bySource = Object.entries(counters.dashboardRefreshBySource)
    .map(([k, v]) => `${k}:${v}`)
    .join(',');
  try {
    // eslint-disable-next-line no-console
    console.debug(
      `${PREFIX} ===== SESSION SUMMARY =====\n` +
      `${PREFIX} syncId=${session.syncId}\n` +
      `${PREFIX} online_to_sync_start_ms=${fmtDuration(a)}\n` +
      `${PREFIX} sync_duration_ms=${fmtDuration(b)}\n` +
      `${PREFIX} sync_to_dashboard_trigger_ms=${fmtDuration(c)}\n` +
      `${PREFIX} dashboard_trigger_to_load_start_ms=${fmtDuration(d)}\n` +
      `${PREFIX} dashboard_load_duration_ms=${fmtDuration(e)}\n` +
      `${PREFIX} dashboard_render_delay_ms=${fmtDuration(f)}\n` +
      `${PREFIX} total_online_to_dashboard_ms=${fmtDuration(total)}\n` +
      `${PREFIX} pending_before=${session.pendingBefore ?? 'n/a'} ` +
      `pending_retried=${session.pendingRetried ?? 'n/a'} ` +
      `pending_succeeded=${session.succeeded ?? 'n/a'} ` +
      `pending_failed=${session.failed ?? 'n/a'} ` +
      `pending_remaining=${session.remaining ?? 'n/a'}\n` +
      `${PREFIX} sync_triggers=${counters.syncTriggers} ` +
      `sync_runs=${counters.syncRuns} ` +
      `sync_requests=${counters.syncRequests} ` +
      `sync_request_failures=${counters.syncRequestFailures} ` +
      `sync_retries=${counters.syncRetries} ` +
      `sync_failures=${counters.syncFailures} ` +
      `skipped_already_syncing=${counters.syncSkippedAlreadySyncing} ` +
      `skipped_zero_pending=${counters.syncSkippedZeroPending} ` +
      `skipped_paused=${counters.syncSkippedPaused} ` +
      `skipped_auth_blocked=${counters.syncSkippedAuthBlocked}\n` +
      `${PREFIX} dashboard_requests=${counters.dashboardRequests} ` +
      `dashboard_request_failures=${counters.dashboardRequestFailures} ` +
      `dashboard_refresh_triggers=${counters.dashboardRefreshTriggers} ` +
      `dashboard_refresh_by_source={${bySource}} ` +
      `dashboard_overlapping_skips=${counters.dashboardOverlappingSkips} ` +
      `dashboard_fresh_threshold_skips=${counters.dashboardFreshThresholdSkips}\n` +
      `${PREFIX} BOTTLENECK_CANDIDATE=${pickBottleneck(a, b, c, d, e, f)}\n` +
      `${PREFIX} =================================`,
    );
  } catch {
    // never throw into application code
  }
  // Reset render marker so a subsequent render emits a fresh summary line
  // for the same cycle instead of spamming identical summaries.
  session.renderAt = null;
}

// ─── Timer lifecycle diagnostics (DEV-only observation) ─────────────────────
// Proves whether repeated "scheduled" logs are real duplicate timers, timer
// replacement, or mere schedule-intent logging. Observation only: the
// registry never influences scheduling decisions.

export type DiagTimerKind = 'periodic' | 'dashboard' | 'pull';

const timerGenerations: Record<DiagTimerKind, number> = { periodic: 0, dashboard: 0, pull: 0 };
// Key `${kind}:${source}:${generation}` → true while that interval instance is live.
const liveTimers = new Map<string, boolean>();

function timerKey(kind: DiagTimerKind, source: string, generation: number): string {
  return `${kind}:${source}:${generation}`;
}

function liveTimerCount(kind: DiagTimerKind): number {
  let n = 0;
  for (const [k, v] of liveTimers) {
    if (v && k.startsWith(`${kind}:`)) n++;
  }
  return n;
}

/** Issue the next generation number for a newly created real interval. DEV-only. */
export function diagNextTimerGeneration(kind: DiagTimerKind): number {
  timerGenerations[kind] += 1;
  return timerGenerations[kind];
}

const TIMER_EVENTS: Record<DiagTimerKind, { scheduled: string; fired: string; cleared: string; replaced: string }> = {
  periodic: {
    scheduled: 'periodic_timer_scheduled',
    fired: 'periodic_timer_fired',
    cleared: 'periodic_timer_cleared',
    replaced: 'periodic_timer_replaced',
  },
  dashboard: {
    scheduled: 'dashboard_poll_timer_scheduled',
    fired: 'dashboard_poll_timer_fired',
    cleared: 'dashboard_poll_timer_cleared',
    replaced: 'dashboard_poll_timer_replaced',
  },
  pull: {
    scheduled: 'pull_timer_scheduled',
    fired: 'pull_timer_fired',
    cleared: 'pull_timer_cleared',
    replaced: 'pull_timer_replaced',
  },
};

/** Log the creation of a REAL setInterval instance. Call only where one is created. */
export function diagTimerScheduled(
  kind: DiagTimerKind,
  source: string,
  intervalMs: number,
  generation: number,
): void {
  if (!isEnabled()) return;
  liveTimers.set(timerKey(kind, source, generation), true);
  diagLog(TIMER_EVENTS[kind].scheduled, {
    source,
    intervalMs,
    timerGeneration: generation,
    activeTimers: liveTimerCount(kind),
  });
}

/** Log an actual timer-callback execution. Call as the first line of the callback. */
export function diagTimerFired(
  kind: DiagTimerKind,
  source: string,
  intervalMs: number,
  generation: number,
  extra?: Record<string, FieldValue>,
): void {
  if (!isEnabled()) return;
  diagLog(TIMER_EVENTS[kind].fired, {
    source,
    intervalMs,
    timerGeneration: generation,
    activeTimers: liveTimerCount(kind),
    ...extra,
  });
}

/** Log a REAL clearInterval. The reason must come from the code site. */
export function diagTimerCleared(
  kind: DiagTimerKind,
  source: string,
  generation: number,
  reason: string,
): void {
  if (!isEnabled()) return;
  liveTimers.set(timerKey(kind, source, generation), false);
  diagLog(TIMER_EVENTS[kind].cleared, {
    source,
    timerGeneration: generation,
    reason,
    activeTimers: liveTimerCount(kind),
  });
}

/** Log a REAL timer replacement (old instance cleared, new instance created). */
export function diagTimerReplaced(
  kind: DiagTimerKind,
  source: string,
  oldGeneration: number,
  newGeneration: number,
  intervalMs: number,
): void {
  if (!isEnabled()) return;
  diagLog(TIMER_EVENTS[kind].replaced, {
    source,
    oldTimerGeneration: oldGeneration,
    newTimerGeneration: newGeneration,
    intervalMs,
    activeTimers: liveTimerCount(kind),
  });
}

/** Number of currently live (scheduled, not cleared) timers of a kind. For tests. */
export function diagLiveTimerCount(kind: DiagTimerKind): number {
  return liveTimerCount(kind);
}

/** Current generation counter for a kind. For tests. */
export function diagTimerGeneration(kind: DiagTimerKind): number {
  return timerGenerations[kind];
}

// ─── Caller identification (DEV-only, one line, no PII) ─────────────────────

/**
 * Compact one-line identifier of the EXTERNAL caller, e.g.
 * `loadInitData@AuthContext.tsx:601`. Skips syncDiag-internal frames and,
 * when `skipThrough` names the instrumented function itself (e.g.
 * 'startPeriodicSync'), skips through it so the true external caller is
 * reported. Returns 'unknown' outside DEV or on any failure.
 */
export function diagCaller(skipThrough?: string): string {
  if (!isEnabled()) return 'unknown';
  try {
    const stack = new Error().stack || '';
    const lines = stack.split('\n').map((l) => l.trim()).filter(Boolean);
    let skippingInstrumented = true;
    for (const line of lines) {
      if (/syncDiag\.(ts|js)|diagCaller|diagPeriodicLifecycleCall|diagPollingLifecycleCall|diagPullTriggerInvoked|diagTimer(Scheduled|Fired|Cleared|Replaced)/.test(line)) {
        continue;
      }
      if (skippingInstrumented && skipThrough && line.includes(skipThrough)) {
        continue;
      }
      skippingInstrumented = false;
      // The leading "Error" message line carries no location — skip it.
      if (!line.startsWith('at')) {
        continue;
      }
      const m = line.match(/^at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
      if (m) {
        const fn = (m[1] || 'anonymous').replace(/^(Object|Module)\./, '');
        const file = m[2].split('/').slice(-1)[0];
        return `${fn}@${file}:${m[3]}`;
      }
      continue;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Lifecycle entry diagnostics ────────────────────────────────────────────

/** Who called start/stopPeriodicSync and what was decided. Decision logic untouched. */
export function diagPeriodicLifecycleCall(
  layer: 'backgroundSync' | 'syncService',
  action: 'start' | 'stop',
  result: string,
  caller: string,
  reason?: string,
): void {
  if (!isEnabled()) return;
  diagLog('periodic_lifecycle_call', { layer, action, result, reason, caller });
}

/** Who called start/stopPolling. Polling behavior untouched. */
export function diagPollingLifecycleCall(
  source: string,
  action: 'start' | 'stop',
  caller: string,
): void {
  if (!isEnabled()) return;
  diagLog('polling_lifecycle_call', { source, action, caller });
}

/** A pull was triggered — with the REAL source (timer, startup, manual, …). */
export function diagPullTriggerInvoked(source: string): void {
  if (!isEnabled()) return;
  diagLog('pull_trigger_invoked', { source });
}

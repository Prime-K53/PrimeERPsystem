/**
 * STEP 3 — recheck active queue (must be exactly 3 LG-MIC-* + 3 zero-diff
 * warehouses; LG-OPENING-BALANCE must NOT be active) and re-verify the
 * warehouse ops are zero-diff vs remote.
 * STEP 4 — resume the sync engine via its public supported API (setPaused(false))
 * and run the normal authenticated sync (backgroundSyncService.syncNow).
 * Captures the sync result, per-op events, and post-sync remote state.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const MIC_IDS = [
  'LG-MIC-REV-1789961780893-5wvx4kqr3',
  'LG-MIC-OPENING-1789961780893-thsjuxe8o',
  'LG-MIC-CAPITAL-1789961780893-t1qzdpjki',
];
const OB_OP_ID = 'q-ba545d94-117b-4a40-b768-fb3bdda5c816-4joatv';
const WH_IDS = ['WH-MAIN', 'WH-VIR', 'WH-SHOP'];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }
console.log('page =', page.url());

const out = await page.evaluate(async ({ micIds, obOpId, whIds }) => {
  const sb = await import('/services/supabaseClient.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');
  const { backgroundSyncService } = await import('/services/backgroundSyncService.ts');
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');

  const session = await sb.supabase.auth.getSession();
  if (!session?.data?.session) return { fatal: 'NO_SESSION' };
  const userId = session.data.session.user?.id ?? null;

  // ── STEP 3: queue composition ─────────────────────────────────────
  const all = await durableSyncQueue.getAll();
  const pending = all.filter((o) => o.status === 'pending');
  const dead = all.filter((o) => o.status === 'dead_letter');
  const summary = (o) => ({ id: o.id, table: o.table, recordId: o.recordId, operation: o.operation, status: o.status, createdAt: o.createdAt ?? null });

  const micPending = pending.filter((o) => o.table === 'ledger_entries' && micIds.includes(String(o.recordId)));
  const whPending = pending.filter((o) => o.table === 'warehouses');
  const obActive = pending.some((o) => o.table === 'ledger_entries' && o.recordId === 'LG-OPENING-BALANCE');
  const obDead = dead.some((o) => o.id === obOpId);
  const others = pending.filter((o) => !micIds.includes(String(o.recordId)) && o.table !== 'warehouses');

  const compositionOk =
    micPending.length === 3 &&
    whPending.length === 3 &&
    others.length === 0 &&
    !obActive &&
    obDead;

  if (!compositionOk) {
    return {
      fatal: 'COMPOSITION_FAILED',
      pending: pending.map(summary), dead: dead.map(summary),
      micPending: micPending.length, whPending: whPending.length,
      others: others.map(summary), obActive, obDead,
    };
  }

  // ── warehouse zero-diff re-verification (read-only) ───────────────
  const whRemote = await sb.supabase.from('warehouses').select('*').in('id', whIds);
  if (whRemote.error) return { fatal: 'WAREHOUSE_READ_FAILED', error: whRemote.error.message };
  const whRemoteById = new Map((whRemote.data || []).map((r) => [r.id, r]));
  const whChecks = whPending.map((op) => {
    const r = whRemoteById.get(String(op.recordId));
    if (!r) return { recordId: op.recordId, zeroDiff: false, note: 'NO REMOTE ROW (would create new row)' };
    const payload = op.payload || {};
    const remoteData = r.data || {};
    const diffs = [];
    const keys = new Set([...Object.keys(payload), ...Object.keys(remoteData)]);
    for (const k of keys) {
      if (['_updatedAt', 'updated_at', 'version', 'id', 'serverUpdatedAt'].includes(k)) continue;
      if (String(payload[k] ?? '') !== String(remoteData[k] ?? '')) diffs.push(`${k}: local=${JSON.stringify(payload[k])} remote=${JSON.stringify(remoteData[k])}`);
    }
    return { recordId: op.recordId, zeroDiff: diffs.length === 0, remoteVersion: r.version, diffs };
  });
  const allWhZeroDiff = whChecks.every((c) => c.zeroDiff);
  if (!allWhZeroDiff) {
    return { fatal: 'WAREHOUSE_NOT_ZERO_DIFF', whChecks };
  }

  // pre-sync remote snapshot of LG-OPENING-BALANCE
  const obPre = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  const obPreRow = obPre.data?.[0] ?? null;

  const micRemotePre = await sb.supabase.from('ledger_entries').select('id').in('id', micIds);
  const micRemotePreCount = (micRemotePre.data || []).length;

  const remoteCountPre = await (async () => {
    const { count, error } = await sb.supabase.from('ledger_entries').select('id', { head: true, count: 'exact' });
    return { count, error: error?.message ?? null };
  })();

  // ── STEP 4: resume engine (public API) + normal authenticated sync ─
  const wasPaused = backgroundSyncService.isPaused();
  if (wasPaused) backgroundSyncService.setPaused(false);

  const events = [];
  const unsub = backgroundSyncService.subscribe('dl-verify-run', (event, data) => {
    try { events.push({ event, data: JSON.parse(JSON.stringify(data ?? null)) }); } catch { events.push({ event, data: null }); }
  });

  let syncError = null;
  let result = null;
  const t0 = Date.now();
  try {
    result = await backgroundSyncService.syncNow(true);
  } catch (e) { syncError = String(e?.message || e); }
  const durationMs = Date.now() - t0;

  // settle: acknowledgements / follow-up batches
  await new Promise((r) => setTimeout(r, 6000));
  unsub();

  const queueAfter = (await durableSyncQueue.getAll()).map(summary);
  const countPendingAfter = await durableSyncQueue.countPending();
  const deadAfter = (await durableSyncQueue.getAll()).filter((o) => o.status === 'dead_letter').map(summary);

  // ── post-sync remote reads ────────────────────────────────────────
  const micRemote = await sb.supabase.from('ledger_entries').select('*').in('id', micIds);
  const obPost = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  const cogsPost = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-COGS-1789787524516-mcpj3jfhj');
  const remoteCountPost = await (async () => {
    const { count, error } = await sb.supabase.from('ledger_entries').select('id', { head: true, count: 'exact' });
    return { count, error: error?.message ?? null };
  })();

  const obPostRow = obPost.data?.[0] ?? null;
  const obUnchanged = JSON.stringify(obPreRow) === JSON.stringify(obPostRow);

  // balances from full remote ledger through the authoritative engine
  const { data: allRemoteRows, error: allErr } = await sb.supabase.from('ledger_entries').select('*');
  let remoteBalances = null, remoteTrial = null, allRemoteError = allErr?.message ?? null, micInFull = 0;
  if (!allErr && Array.isArray(allRemoteRows)) {
    const ledgerShape = allRemoteRows.map((r) => ({ ...(r.data || {}), id: r.id, __version: r.version, __updated_at: r.updated_at }));
    micInFull = ledgerShape.filter((e) => micIds.includes(e.id)).length;
    const accounts = await dbService.getAll('accounts');
    const own = engine.computeOwnBalances(accounts, ledgerShape);
    const roll = engine.computeHierarchicalRollup(accounts, own);
    const trial = engine.computeTrialBalance(accounts, ledgerShape);
    remoteBalances = {
      i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null,
      i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
    };
    remoteTrial = { debits: trial.totalDebits, credits: trial.totalCredits, difference: trial.difference, balanced: trial.isBalanced };
  }

  return {
    fatal: null,
    userId,
    step3: {
      compositionOk, micPendingCount: micPending.length, whPendingCount: whPending.length,
      obActive, obDead, othersCount: others.length,
      whChecks,
      deadLetterOps: dead.map(summary),
      micRemotePreCount,
    },
    step4: {
      wasPaused, nowPaused: backgroundSyncService.isPaused(),
      syncResult: result, syncError, durationMs, events,
    },
    post: {
      queueAfter, countPendingAfter, deadAfter,
      remoteCountPre, remoteCountPost,
      micRemote: micRemote.error ? { error: micRemote.error.message } : micRemote.data,
      obUnchanged,
      obPostRow,
      cogsPostRow: cogsPost.data?.[0] ?? null,
      micInFull,
      remoteBalances, remoteTrial, allRemoteError,
    },
  };
}, { micIds: MIC_IDS, obOpId: OB_OP_ID, whIds: WH_IDS });

if (out.fatal) {
  console.error('FATAL:', JSON.stringify(out, null, 1).slice(0, 4000));
  fs.writeFileSync('verify-artifacts/dl-sync.json', JSON.stringify({ fatal: out.fatal, detail: out }, null, 1));
  process.exit(3);
}

fs.writeFileSync('verify-artifacts/dl-sync.json', JSON.stringify(out, null, 1));

console.log(JSON.stringify({
  step3: { micPendingCount: out.step3.micPendingCount, whPendingCount: out.step3.whPendingCount, obActive: out.step3.obActive, obDead: out.step3.obDead, othersCount: out.step3.othersCount, whChecks: out.step3.whChecks, micRemotePreCount: out.step3.micRemotePreCount },
  step4: { wasPaused: out.step4.wasPaused, nowPaused: out.step4.nowPaused, syncResult: out.step4.syncResult, syncError: out.step4.syncError, durationMs: out.step4.durationMs, events: out.step4.events },
  post: {
    countPendingAfter: out.post.countPendingAfter,
    queueAfter: out.post.queueAfter,
    deadAfter: out.post.deadAfter,
    remoteCountPre: out.post.remoteCountPre,
    remoteCountPost: out.post.remoteCountPost,
    micRemote: out.post.micRemote,
    obUnchanged: out.post.obUnchanged,
    obPostRow: out.post.obPostRow,
    micInFull: out.post.micInFull,
    remoteBalances: out.post.remoteBalances,
    remoteTrial: out.post.remoteTrial,
  },
}, null, 1));
process.exit(0);

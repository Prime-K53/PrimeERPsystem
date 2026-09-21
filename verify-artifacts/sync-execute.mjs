/** STEP 2 (authenticated sync via the production path) + STEP 3/4 remote verification. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const TARGETS = {
  'LG-MIC-REV-1789961780893-5wvx4kqr3': {
    date: '2026-09-21', amount: 187600, debitAccountId: 'ACC-11420', creditAccountId: 'ACC-51200',
    referenceId: 'CORR-MATINV-REV-LG-COGS-1789787524516-mcpj3jfhj',
    reversesEntryId: 'LG-COGS-1789787524516-mcpj3jfhj',
  },
  'LG-MIC-OPENING-1789961780893-thsjuxe8o': {
    date: '2026-01-01', amount: 1687500, debitAccountId: 'ACC-11420', creditAccountId: 'ACC-32000',
    referenceId: 'CORR-MATINV-OPENING-11420', reversesEntryId: null,
  },
  'LG-MIC-CAPITAL-1789961780893-t1qzdpjki': {
    date: '2026-09-16', amount: 222500000, debitAccountId: 'ACC-11420', creditAccountId: 'ACC-32000',
    referenceId: 'CORR-MATINV-CAPITAL-11420', reversesEntryId: null,
  },
};

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }

const out = await page.evaluate(async (targets) => {
  const sb = await import('/services/supabaseClient.ts');
  const { backgroundSyncService } = await import('/services/backgroundSyncService.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');

  const session = await sb.supabase.auth.getSession();
  const authOk = !!session?.data?.session;

  const q = async () => {
    const all = await durableSyncQueue.getAll();
    return all.map((o) => ({ table: o.table, recordId: o.recordId, operation: o.operation, status: o.status, createdAt: o.createdAt ?? null, error: o.error ?? null }));
  };

  const remoteCount = async () => {
    const { count, error } = await sb.supabase.from('ledger_entries').select('id', { head: true, count: 'exact' });
    return { count: count ?? null, error: error?.message ?? null };
  };

  const before = { queue: await q(), remoteLedgerCount: await remoteCount() };

  const events = [];
  const unsub = backgroundSyncService.subscribe('verify-run', (event, data) => {
    try { events.push({ event, data: JSON.parse(JSON.stringify(data ?? null)) }); } catch { events.push({ event, data: null }); }
  });

  let syncError = null;
  let result = null;
  try {
    result = await backgroundSyncService.syncNow(true);
  } catch (e) { syncError = String(e?.message || e); }

  // Let any follow-up cycle / acknowledgement settle.
  await new Promise((r) => setTimeout(r, 4000));
  unsub();

  const after = { queue: await q(), remoteLedgerCount: await remoteCount() };

  // ── STEP 3: remote persistence ───────────────────────────────────
  let remoteFetchError = null;
  let remoteRows = [];
  try {
    const { data, error } = await sb.supabase.from('ledger_entries').select('*').in('id', Object.keys(targets));
    remoteFetchError = error?.message ?? null;
    remoteRows = data || [];
  } catch (e) { remoteFetchError = String(e?.message || e); }

  const rowsById = new Map(remoteRows.map((r) => [r.id, r]));
  const perTarget = Object.entries(targets).map(([id, exp]) => {
    const r = rowsById.get(id);
    if (!r) return { id, present: false };
    const d = r.data || {};
    const diffs = [];
    for (const k of ['date', 'amount', 'debitAccountId', 'creditAccountId', 'referenceId']) {
      if (String(d[k]) !== String(exp[k])) diffs.push(`${k}: expected ${exp[k]}, remote ${d[k]}`);
    }
    const rev = d.reversesEntryId ?? null;
    if (String(rev) !== String(exp.reversesEntryId)) diffs.push(`reversesEntryId: expected ${exp.reversesEntryId}, remote ${rev}`);
    if (String(d.status) !== 'posted') diffs.push(`status: remote ${d.status}`);
    if (d.entryType !== 'material_inventory_correction') diffs.push(`entryType: remote ${d.entryType}`);
    if (d.referenceType !== 'material_inventory_correction') diffs.push(`referenceType: remote ${d.referenceType}`);
    if (!d.idempotencyKey) diffs.push('idempotencyKey missing');
    if (!d.appliedBy) diffs.push('appliedBy missing');
    if (!d.applyReason) diffs.push('applyReason missing');
    return { id, present: true, diffs, remoteData: d, meta: { version: r.version, created_at: r.created_at, updated_at: r.updated_at } };
  });

  // Whole remote ledger, mapped to the app's ledger shape
  let allRemote = [];
  let allRemoteError = null;
  try {
    const { data, error } = await sb.supabase.from('ledger_entries').select('*');
    allRemoteError = error?.message ?? null;
    allRemote = (data || []).map((r) => ({ ...(r.data || {}), id: r.id, __version: r.version, __updated_at: r.updated_at }));
  } catch (e) { allRemoteError = String(e?.message || e); }

  const corrRemote = allRemote.filter((e) => String(e.referenceId || '').startsWith('CORR-MATINV-'));
  const reversalsRemote = allRemote.filter((e) => String(e.reversesEntryId || '') === 'LG-COGS-1789787524516-mcpj3jfhj');
  const dupRemote = allRemote.find((e) => e.id === 'LG-COGS-1789787524516-mcpj3jfhj') || null;
  const dupeIds = {};
  for (const e of allRemote) dupeIds[e.id] = (dupeIds[e.id] || 0) + 1;
  const duplicatedIds = Object.entries(dupeIds).filter(([, n]) => n > 1).map(([id, n]) => ({ id, count: n }));

  const obRemote = allRemote.find((e) => e.id === 'LG-OPENING-BALANCE') || null;

  // ── STEP 4: remote balances via the authoritative engine ─────────
  const accounts = await dbService.getAll('accounts');
  const own = engine.computeOwnBalances(accounts, allRemote);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const trial = engine.computeTrialBalance(accounts, allRemote);

  return {
    authOk,
    before, after,
    syncResult: result ? JSON.parse(JSON.stringify(result)) : null,
    syncError,
    events,
    remoteFetchError,
    perTarget,
    remoteTotals: { rowCount: allRemote.length, error: allRemoteError },
    corrRemoteCount: corrRemote.length,
    corrRemoteRows: corrRemote.map((e) => ({ id: e.id, date: e.date, amount: e.amount, dr: e.debitAccountId, cr: e.creditAccountId, referenceId: e.referenceId, entryType: e.entryType, reversesEntryId: e.reversesEntryId ?? null })),
    reversalsRemote: reversalsRemote.map((e) => ({ id: e.id, referenceId: e.referenceId })),
    duplicateRowRemote: dupRemote ? { id: dupRemote.id, date: dupRemote.date, amount: dupRemote.amount, dr: dupRemote.debitAccountId, cr: dupRemote.creditAccountId, referenceId: dupRemote.referenceId, __version: dupRemote.__version } : null,
    duplicatedRowIds: duplicatedIds,
    openingBalanceRemoteAfter: obRemote ? { id: obRemote.id, date: obRemote.date, amount: obRemote.amount, dr: obRemote.debitAccountId, cr: obRemote.creditAccountId, referenceId: obRemote.referenceId, serverUpdatedAt: obRemote.serverUpdatedAt ?? null, __version: obRemote.__version, __updated_at: obRemote.__updated_at } : null,
    remoteBalances: {
      i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null, i11430: own['ACC-11430'] ?? null,
      i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
    },
    remoteTrial: { debits: trial.totalDebits, credits: trial.totalCredits, difference: trial.difference, balanced: trial.isBalanced },
  };
}, TARGETS);

fs.writeFileSync('verify-artifacts/sync-execute.json', JSON.stringify(out, null, 1));

const fmt = (s) => s ? `${s.table}:${s.recordId}=${s.status}` : '';
console.log('authOk =', out.authOk);
console.log('\n=== SYNC RESULT ===', JSON.stringify(out.syncResult), 'error:', out.syncError);
console.log('\n=== SYNC EVENTS ===');
for (const e of out.events) console.log(' ', e.event, JSON.stringify(e.data));
console.log('\n=== OUTBOX before ===');
for (const o of out.before.queue) console.log('  ', fmt(o));
console.log('  remote ledger count before:', JSON.stringify(out.before.remoteLedgerCount));
console.log('=== OUTBOX after ===');
for (const o of out.after.queue) console.log('  ', fmt(o), o.error ?? '');
console.log('  remote ledger count after:', JSON.stringify(out.after.remoteLedgerCount));
console.log('\n=== STEP 3: per-target remote verification ===');
for (const t of out.perTarget) console.log(' ', t.id, t.present ? (t.diffs.length ? 'DIFFS: ' + JSON.stringify(t.diffs) : 'OK ✅') : 'ABSENT ❌');
console.log('\n=== corr rows remotely ===', out.corrRemoteCount);
for (const r of out.corrRemoteRows) console.log('  ', JSON.stringify(r));
console.log('=== reversals linked remotely ===', JSON.stringify(out.reversalsRemote));
console.log('=== duplicate row remote ===', JSON.stringify(out.duplicateRowRemote));
console.log('=== duplicated row ids ===', JSON.stringify(out.duplicatedRowIds));
console.log('=== LG-OPENING-BALANCE remote after ===', JSON.stringify(out.openingBalanceRemoteAfter));
console.log('\n=== STEP 4: remote balances ===', JSON.stringify(out.remoteBalances));
console.log('=== remote trial ===', JSON.stringify(out.remoteTrial));
process.exit(0);

/**
 * STEP 12 — second normal authenticated sync (idempotency check).
 * STEP 13 — second normal remote pull (no duplicates; balances stable).
 * Both followed by read-only verification: no new remote rows, LG-OPENING-BALANCE
 * still isolated & unchanged, remote balances unchanged, operational inventory stable.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const MIC_IDS = [
  'LG-MIC-REV-1789961780893-5wvx4kqr3',
  'LG-MIC-OPENING-1789961780893-thsjuxe8o',
  'LG-MIC-CAPITAL-1789961780893-t1qzdpjki',
];
const OB_OP_ID = 'q-ba545d94-117b-4a40-b768-fb3bdda5c816-4joatv';
const OB_EXPECTED_DATA = {
  id: 'LG-OPENING-BALANCE',
  date: '2026-09-20T23:24:07.265Z',
  amount: 500,
  reconciled: true,
  description: 'System Initialization: Opening Cash Balance',
  referenceId: 'OPENING_BALANCE',
  debitAccountId: '11110',
  creditAccountId: '31000',
  serverUpdatedAt: '2026-09-19T09:32:48.074064+00:00',
};
const EXPECTED_BALANCES = { i11410: -448985, i11420: 222500000, i11400rollup: 222051015, eq32000: 224187500, cogs51200: 2136485 };

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }

const out = await page.evaluate(async ({ micIds, obOpId, obExpectedData, expectedBalances }) => {
  const sb = await import('/services/supabaseClient.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');
  const { backgroundSyncService } = await import('/services/backgroundSyncService.ts');
  const { pullRemoteChanges } = await import('/services/syncService.ts');
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');
  const norm = await import('/utils/inventoryNormalization.ts');

  const session = await sb.supabase.auth.getSession();
  if (!session?.data?.session) return { fatal: 'NO_SESSION' };

  const snapshot = async () => {
    const { count, error } = await sb.supabase.from('ledger_entries').select('id', { head: true, count: 'exact' });
    const mic = await sb.supabase.from('ledger_entries').select('*').in('id', micIds);
    const ob = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
    const revs = await sb.supabase.from('ledger_entries').select('id,data').contains('data', { reversesEntryId: 'LG-COGS-1789787524516-mcpj3jfhj' });
    const all = await sb.supabase.from('ledger_entries').select('*');
    const ledgerShape = (all.data || []).map((r) => ({ ...(r.data || {}), id: r.id, __version: r.version, __updated_at: r.updated_at }));
    const accounts = await dbService.getAll('accounts');
    const own = engine.computeOwnBalances(accounts, ledgerShape);
    const roll = engine.computeHierarchicalRollup(accounts, own);
    const trial = engine.computeTrialBalance(accounts, ledgerShape);

    // operational inventory (remote)
    const prods = await sb.supabase.from('products').select('*');
    const prodData = (prods.data || []).map((r) => ({ ...(r.data || {}), id: r.id }));
    const included = prodData.map((i) => ({ item: i, c: norm.classifyInventoryItem(i) })).filter((x) => x.c.included);
    const bearingValue = included.reduce((s, x) =>
      s + Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0), 0);
    const bearingUnits = included.reduce((s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0), 0);

    const revRows = (revs.data || []).map((r) => ({ id: r.id, reversesEntryId: r.data?.reversesEntryId ?? null }));

    return {
      ledgerCount: count ?? null, countError: error?.message ?? null,
      micRowCount: (mic.data || []).length,
      micVersions: Object.fromEntries((mic.data || []).map((r) => [r.id, r.version])),
      obRow: ob.data?.[0] ?? null,
      reversalRows: revRows,
      micIdsInFull: ledgerShape.filter((e) => micIds.includes(e.id)).length,
      remoteBalances: {
        i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null,
        i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
      },
      remoteTrial: { debits: trial.totalDebits, credits: trial.totalCredits, difference: trial.difference, balanced: trial.isBalanced },
      opInventory: { items: included.length, units: bearingUnits, value: bearingValue },
    };
  };

  const pre = await snapshot();

  // ── STEP 12: second sync ──────────────────────────────────────────
  const events2 = [];
  const unsub = backgroundSyncService.subscribe('dl-verify-2nd', (event, data) => {
    try { events2.push({ event, data: JSON.parse(JSON.stringify(data ?? null)) }); } catch { events2.push({ event, data: null }); }
  });
  let sync2Error = null, sync2Result = null;
  const t0 = Date.now();
  try { sync2Result = await backgroundSyncService.syncNow(true); } catch (e) { sync2Error = String(e?.message || e); }
  const sync2Ms = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 5000));
  unsub();

  const mid = await snapshot();
  const obMidUnchanged = JSON.stringify(mid.obRow?.data ?? null) === JSON.stringify(obExpectedData);
  const midBalancesOk = JSON.stringify(mid.remoteBalances) === JSON.stringify(expectedBalances);

  // outbox state between steps
  const queueMid = (await durableSyncQueue.getAll()).map((o) => ({ recordId: o.recordId, table: o.table, status: o.status }));
  const obDeadMid = queueMid.some((o) => o.recordId === 'LG-OPENING-BALANCE' && o.status === 'dead_letter');

  // ── STEP 13: second pull ──────────────────────────────────────────
  let pullError = null, pullResult = null;
  try { pullResult = await pullRemoteChanges(); } catch (e) { pullError = String(e?.message || e); }
  await new Promise((r) => setTimeout(r, 5000));

  const post = await snapshot();
  const obPostUnchanged = JSON.stringify(post.obRow?.data ?? null) === JSON.stringify(obExpectedData);
  const postBalancesOk = JSON.stringify(post.remoteBalances) === JSON.stringify(expectedBalances);

  // local checks after pull: no dupes, balances stable
  const localLedger = await dbService.getAll('ledger');
  const localMic = localLedger.filter((e) => micIds.includes(e.id));
  const localMicCounts = micIds.map((id) => localLedger.filter((e) => e.id === id).length);
  const accounts = await dbService.getAll('accounts');
  const own = engine.computeOwnBalances(accounts, localLedger);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const localBalances = {
    i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null,
    i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
  };
  const localTrial = engine.computeTrialBalance(accounts, localLedger);

  // local operational inventory after pull
  const localInventory = await dbService.getAll('inventory');
  const localIncluded = localInventory.map((i) => ({ item: i, c: norm.classifyInventoryItem(i) })).filter((x) => x.c.included);
  const localBearingValue = localIncluded.reduce((s, x) =>
    s + Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0), 0);
  const localBearingUnits = localIncluded.reduce((s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0), 0);

  const queuePost = (await durableSyncQueue.getAll()).map((o) => ({ recordId: o.recordId, table: o.table, status: o.status }));
  const obDeadPost = queuePost.some((o) => o.recordId === 'LG-OPENING-BALANCE' && o.status === 'dead_letter');
  const pendingPost = queuePost.filter((o) => o.status === 'pending');

  return {
    fatal: null,
    pre: { ledgerCount: pre.ledgerCount, micRowCount: pre.micRowCount, micVersions: pre.micVersions, reversalRows: pre.reversalRows, remoteBalances: pre.remoteBalances, opInventory: pre.opInventory },
    step12: {
      sync2Result, sync2Error, sync2Ms, events: events2,
      mid: { ledgerCount: mid.ledgerCount, micRowCount: mid.micRowCount, micVersions: mid.micVersions, reversalRows: mid.reversalRows, obMidUnchanged, midBalancesOk, remoteBalances: mid.remoteBalances, opInventory: mid.opInventory },
      obDeadMid, queueMid,
    },
    step13: {
      pullResult, pullError,
      post: {
        ledgerCount: post.ledgerCount, micRowCount: post.micRowCount, micVersions: post.micVersions,
        reversalRows: post.reversalRows, obPostUnchanged, postBalancesOk, remoteBalances: post.remoteBalances,
        remoteTrial: post.remoteTrial, opInventory: post.opInventory,
      },
      localAfterPull: {
        ledgerCount: localLedger.length,
        micCounts: localMicCounts,
        micTotal: localMic.length,
        localBalances,
        localTrial: { debits: localTrial.totalDebits, credits: localTrial.totalCredits, difference: localTrial.difference, balanced: localTrial.isBalanced },
        localOpInventory: { items: localIncluded.length, units: localBearingUnits, value: localBearingValue },
      },
      obDeadPost, pendingPost,
    },
  };
}, { micIds: MIC_IDS, obOpId: OB_OP_ID, obExpectedData: OB_EXPECTED_DATA, expectedBalances: EXPECTED_BALANCES });

if (out.fatal) {
  console.error('FATAL:', JSON.stringify(out).slice(0, 1000));
  fs.writeFileSync('verify-artifacts/dl-second-pass.json', JSON.stringify(out, null, 1));
  process.exit(3);
}

fs.writeFileSync('verify-artifacts/dl-second-pass.json', JSON.stringify(out, null, 1));

console.log(JSON.stringify({
  pre: out.pre,
  step12: { sync2Result: out.step12.sync2Result, sync2Error: out.step12.sync2Error, sync2Ms: out.step12.sync2Ms, events: out.step12.events, mid: out.step12.mid, obDeadMid: out.step12.obDeadMid },
  step13: { pullResult: out.step13.pullResult, pullError: out.step13.pullError, post: out.step13.post, localAfterPull: out.step13.localAfterPull, obDeadPost: out.step13.obDeadPost, pendingPost: out.step13.pendingPost },
}, null, 1));
process.exit(0);

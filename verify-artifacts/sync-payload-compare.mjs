/** Read-only: outbox payloads + comparison of the 4 extra pending ops vs remote. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const sb = await import('/services/supabaseClient.ts');

  const queue = await new Promise((resolve) => {
    const req = indexedDB.open('PrimeERP_DurableSyncQueue');
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('operations')) { db.close(); return resolve([]); }
      const tx = db.transaction('operations', 'readonly');
      const all = tx.objectStore('operations').getAll();
      all.onsuccess = () => { const r = all.result || []; db.close(); resolve(r); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  });

  const pending = queue.filter((op) => op.status === 'pending');

  const remote = {};
  for (const id of ['LG-OPENING-BALANCE']) {
    const { data } = await sb.supabase.from('ledger_entries').select('*').eq('id', id);
    remote[id] = (data || [])[0] ?? null;
  }
  for (const id of ['WH-MAIN', 'WH-SHOP', 'WH-VIR']) {
    const { data } = await sb.supabase.from('warehouses').select('*').eq('id', id);
    remote[id] = (data || [])[0] ?? null;
  }

  const norm = (o) => JSON.stringify(o, Object.keys(o || {}).sort());
  const compare = () => {
    const results = [];
    for (const op of pending) {
      const rid = String(op.recordId || '');
      if (/LG-MIC-/.test(rid)) continue; // in scope, expected to be new
      const r = remote[rid];
      const payload = op.payload || {};
      const remoteData = r?.data ?? null;
      const diffs = [];
      if (!r) diffs.push('NO REMOTE ROW (would be a NEW remote row)');
      else if (remoteData) {
        const keys = new Set([...Object.keys(payload), ...Object.keys(remoteData)]);
        for (const k of keys) {
          if (['_updatedAt', 'updated_at', 'version', 'id', 'serverUpdatedAt'].includes(k)) continue;
          if (String(payload[k] ?? '') !== String(remoteData[k] ?? '')) {
            diffs.push(`${k}: local=${JSON.stringify(payload[k])} remote=${JSON.stringify(remoteData[k])}`);
          }
        }
      }
      results.push({ table: op.table, recordId: rid, remoteExists: !!r, remoteVersion: r?.version ?? null, remoteUpdatedAt: r?.updated_at ?? null, diffs });
    }
    return results;
  };

  return {
    pendingCount: pending.length,
    pendingSummary: pending.map((op) => ({ table: op.table, recordId: op.recordId, status: op.status, createdAt: op.createdAt, operation: op.operation })),
    micPayloads: pending
      .filter((op) => /LG-MIC-/.test(String(op.recordId || '')))
      .map((op) => ({ recordId: op.recordId, table: op.table, payload: op.payload })),
    extraComparison: compare(),
    remoteRows: remote,
  };
});

fs.writeFileSync('verify-artifacts/sync-payload-compare.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  pendingCount: out.pendingCount,
  pendingSummary: out.pendingSummary,
  extraComparison: out.extraComparison,
}, null, 1));
console.log('=== MIC payload keys ===');
for (const m of out.micPayloads) {
  console.log(m.recordId, '->', JSON.stringify(Object.keys(m.payload || {}).sort()));
}
process.exit(0);

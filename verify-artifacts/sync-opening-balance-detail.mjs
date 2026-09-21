/** Read-only detail on the only non-identical extra pending op. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const sb = await import('/services/supabaseClient.ts');
  const { dbService } = await import('/services/db.ts');

  const queue = await new Promise((resolve) => {
    const req = indexedDB.open('PrimeERP_DurableSyncQueue');
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('operations', 'readonly');
      const all = tx.objectStore('operations').getAll();
      all.onsuccess = () => { const r = all.result || []; db.close(); resolve(r); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  });

  const op = queue.find((o) => o.recordId === 'LG-OPENING-BALANCE') || null;
  const localRow = (await dbService.getAll('ledger')).find((e) => e.id === 'LG-OPENING-BALANCE') || null;
  const { data: remoteRows } = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  const remote = (remoteRows || [])[0] || null;

  const payload = op?.payload || {};
  const remoteData = remote?.data || {};

  const allKeys = [...new Set([...Object.keys(payload), ...Object.keys(remoteData), ...Object.keys(localRow || {})])].sort();
  const table = {};
  for (const k of allKeys) {
    table[k] = {
      outboxPayload: payload[k] === undefined ? '(absent)' : payload[k],
      localIndexedDb: localRow ? (localRow[k] === undefined ? '(absent)' : localRow[k]) : '(no local row)',
      remoteData: remoteData[k] === undefined ? '(absent)' : remoteData[k],
    };
  }

  return {
    op: op ? {
      id: op.id, table: op.table, recordId: op.recordId, operation: op.operation, status: op.status,
      createdAt: op.createdAt, syncGeneration: op.syncGeneration ?? null,
      baseVersion: op.baseVersion ?? op.version ?? null,
      payloadKeys: Object.keys(payload).sort(),
      payloadVersionish: Object.fromEntries(Object.entries(payload).filter(([k]) => /version/i.test(k))),
    } : null,
    fieldTable: table,
    remoteMeta: remote ? { id: remote.id, version: remote.version, created_at: remote.created_at, updated_at: remote.updated_at } : null,
    differingFields: allKeys.filter((k) =>
      String(payload[k] ?? '') !== String(remoteData[k] ?? '')
    ),
  };
});

fs.writeFileSync('verify-artifacts/sync-opening-balance-detail.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

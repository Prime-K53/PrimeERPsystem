/**
 * STEPS 8-11 — READ-ONLY post-sync integrity verification:
 *  8: remote operational inventory (products) — items/units/value/GL mapping;
 *     quantities & stored costs unchanged vs pre-fingerprints
 *  9: Smart Stock provenance + warehouseInventory + warehouses unchanged
 * 10: LG-OPENING-BALANCE remote row unchanged (explicit re-read vs preflight)
 * 11: outbox post-state (MIC completed, OB isolated dead_letter, none pending)
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const MIC_IDS = [
  'LG-MIC-REV-1789961780893-5wvx4kqr3',
  'LG-MIC-OPENING-1789961780893-thsjuxe8o',
  'LG-MIC-CAPITAL-1789961780893-t1qzdpjki',
];
const OB_OP_ID = 'q-ba545d94-117b-4a40-b768-fb3bdda5c816-4joatv';

const probe = JSON.parse(fs.readFileSync('verify-artifacts/dl-probe.json', 'utf8'));
const fpPre = probe.fingerprintsPre;

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }

const out = await page.evaluate(async ({ micIds, obOpId, fpPre }) => {
  const sb = await import('/services/supabaseClient.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');
  const norm = await import('/utils/inventoryNormalization.ts');

  const session = await sb.supabase.auth.getSession();
  if (!session?.data?.session) return { fatal: 'NO_SESSION' };

  const fp = (rows, fields) => rows
    .map((r) => fields.map((f) => String(r[f] ?? '')).join(':')).sort().join('|');

  // ── STEP 8: remote products (inventory) ───────────────────────────
  // page through all products
  const products = [];
  {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.supabase.from('products').select('*').range(offset, offset + 1999);
      if (error) return { fatal: 'PRODUCTS_READ_FAILED', error: error.message };
      products.push(...(data || []));
      if (!data || data.length < 2000) break;
      offset += 2000;
    }
  }
  const prodData = products.map((r) => ({ ...(r.data || {}), id: r.id, __version: r.version, __updated_at: r.updated_at }));

  const classified = prodData.map((i) => ({ item: i, c: norm.classifyInventoryItem(i) }));
  const included = classified.filter((x) => x.c.included);
  const byAccount = {};
  for (const x of included) {
    const code = norm.resolveInventoryGLAccountCode(x.item) || 'UNMAPPED';
    byAccount[code] = byAccount[code] || { items: 0, units: 0, value: 0 };
    byAccount[code].items += 1;
    byAccount[code].units += Number(norm.resolveInventoryQuantity(x.item) || 0);
    byAccount[code].value += Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0);
  }
  const bearingValue = included.reduce((s, x) =>
    s + Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0), 0);
  const bearingUnits = included.reduce((s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0), 0);

  const inventoryFpRemote = fp(prodData, ['id', 'stock', 'cost']);
  const inventoryUnchanged = inventoryFpRemote === fpPre.inventory;

  // ── STEP 9: Smart Stock + warehouseInventory + warehouses ─────────
  const txns = [];
  {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.supabase.from('inventory_transactions').select('*').range(offset, offset + 1999);
      if (error) return { fatal: 'TXNS_READ_FAILED', error: error.message };
      txns.push(...(data || []));
      if (!data || data.length < 2000) break;
      offset += 2000;
    }
  }
  const txnData = txns.map((r) => ({ ...(r.data || {}), id: r.id, __version: r.version, __updated_at: r.updated_at }));
  const smartStock = txnData.filter((t) => /smart\s*stock/i.test(String(t.notes ?? t.reason ?? t.referenceId ?? '')));
  const smartStockFpRemote = fp(smartStock, ['id', 'itemId', 'quantity', 'type', 'date']);
  const smartStockUnchanged = smartStockFpRemote === fpPre.smartStock;
  const invTxnFpRemote = fp(txnData, ['id', 'itemId', 'quantity', 'type', 'date']);
  const invTxnUnchanged = invTxnFpRemote === fpPre.invTxns;

  const whInv = [];
  {
    let offset = 0;
    for (;;) {
      const { data, error } = await sb.supabase.from('warehouse_inventory').select('*').range(offset, offset + 1999);
      if (error) return { fatal: 'WHINV_READ_FAILED', error: error.message };
      whInv.push(...(data || []));
      if (!data || data.length < 2000) break;
      offset += 2000;
    }
  }
  const whInvData = whInv.map((r) => ({ ...(r.data || {}), id: r.id }));
  const whInvFpRemote = fp(whInvData, ['id', 'itemId', 'warehouseId', 'quantity']);
  const whInvUnchanged = whInvFpRemote === fpPre.whInv;

  const { data: whRows, error: whErr } = await sb.supabase.from('warehouses').select('*').in('id', ['WH-MAIN', 'WH-VIR', 'WH-SHOP']);
  if (whErr) return { fatal: 'WAREHOUSES_READ_FAILED', error: whErr.message };
  const warehouseMeta = (whRows || []).map((r) => ({ id: r.id, version: r.version, updated_at: r.updated_at }));
  const warehouseFpRemote = fp((whRows || []).map((r) => ({ ...(r.data || {}), id: r.id })), ['id', 'name', 'type', 'location']);
  const warehousesUnchanged = warehouseFpRemote === fpPre.warehouses;

  // ── STEP 10: LG-OPENING-BALANCE explicit re-read ──────────────────
  const { data: obRows, error: obErr } = await sb.supabase.from('ledger_entries').select('*').eq('id', 'LG-OPENING-BALANCE');
  if (obErr) return { fatal: 'OB_READ_FAILED', error: obErr.message };
  const obRow = obRows?.[0] ?? null;

  // ── STEP 11: outbox post-state ────────────────────────────────────
  const all = await durableSyncQueue.getAll();
  const byStatus = {};
  for (const o of all) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  const micOps = all.filter((o) => o.table === 'ledger_entries' && micIds.includes(String(o.recordId)))
    .map((o) => ({ id: o.id, recordId: o.recordId, status: o.status, retryCount: o.retryCount ?? null }));
  const obOp = all.find((o) => o.id === obOpId) || null;
  const pendingOps = all.filter((o) => o.status === 'pending').map((o) => ({ table: o.table, recordId: o.recordId }));

  return {
    fatal: null,
    step8: {
      remoteProductsCount: products.length,
      inventoryBearing: { items: included.length, units: bearingUnits, value: bearingValue },
      byAccount,
      inventoryUnchanged,
    },
    step9: {
      counts: { inventoryTransactions: txnData.length, smartStockRows: smartStock.length, warehouseInventory: whInvData.length, warehouses: (whRows || []).length },
      smartStockUnchanged, invTxnUnchanged, whInvUnchanged, warehousesUnchanged,
      warehouseMeta,
      typeBreakdown: smartStock.reduce((m, t) => { const k = String(t.type ?? '?'); m[k] = (m[k] || 0) + 1; return m; }, {}),
      refBreakdown: smartStock.reduce((m, t) => { const k = String(t.referenceId ?? '?'); m[k] = (m[k] || 0) + 1; return m; }, {}),
    },
    step10: { obRow },
    step11: { byStatus, micOps, obOpStatus: obOp?.status ?? null, obOpLastAttempt: obOp?.lastAttempt ?? null, obOpLastError: obOp?.lastError ?? null, obOpPayloadKeys: obOp ? Object.keys(obOp.payload || {}).sort() : null, pendingOps },
  };
}, { micIds: MIC_IDS, obOpId: OB_OP_ID, fpPre });

if (out.fatal) {
  console.error('FATAL:', JSON.stringify(out).slice(0, 1000));
  fs.writeFileSync('verify-artifacts/dl-integrity.json', JSON.stringify(out, null, 1));
  process.exit(3);
}

fs.writeFileSync('verify-artifacts/dl-integrity.json', JSON.stringify(out, null, 1));

console.log(JSON.stringify({
  step8: { ...out.step8, byAccount: out.step8.byAccount },
  step9: out.step9,
  step10: {
    obRowPresent: !!out.step10.obRow,
    version: out.step10.obRow?.version ?? null,
    updated_at: out.step10.obRow?.updated_at ?? null,
    data: out.step10.obRow?.data ?? null,
  },
  step11: out.step11,
}, null, 1));
process.exit(0);

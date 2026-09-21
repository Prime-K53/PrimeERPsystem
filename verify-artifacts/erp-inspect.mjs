import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
const out = await page.evaluate(async () => {
  const res = {};
  res.url = location.href;
  res.lsKeys = Object.keys(localStorage);
  res.hasErpAuth = Boolean(localStorage.getItem('prime-erp-supabase-auth'));
  res.nexusLastSyncPull = localStorage.getItem('nexus_last_sync_pull');
  try {
    const { supabase } = await import('/services/supabaseClient.ts');
    const { data } = await supabase.auth.getSession();
    res.session = { has: Boolean(data.session), userId: data.session?.user?.id || null, exp: data.session?.expires_at || null };
  } catch (e) { res.sessionErr = String(e); }

  const open = (name) => new Promise((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
  const erp = await open('PrimeERP_Final_v3_Clean');
  if (erp) {
    res.erpStores = { inventory: await new Promise(r => { const q = erp.transaction('inventory','readonly').objectStore('inventory').count(); q.onsuccess=()=>r(q.result); q.onerror=()=>r(-1); }),
      warehouses: await new Promise(r => { const q = erp.transaction('warehouses','readonly').objectStore('warehouses').count(); q.onsuccess=()=>r(q.result); q.onerror=()=>r(-1); }),
      warehouseInventory: await new Promise(r => { const q = erp.transaction('warehouseInventory','readonly').objectStore('warehouseInventory').count(); q.onsuccess=()=>r(q.result); q.onerror=()=>r(-1); }) };
    erp.close();
  }
  const q = await open('PrimeERP_DurableSyncQueue');
  if (q) {
    const ops = await new Promise(r => { const t = q.transaction('operations','readonly').objectStore('operations').getAll(); t.onsuccess=()=>r(t.result||[]); t.onerror=()=>r([]); });
    const byStatus = {};
    for (const o of ops) byStatus[o.status] = (byStatus[o.status]||0)+1;
    res.queue = { total: ops.length, byStatus, tables: [...new Set(ops.map(o=>o.table))].slice(0,20) };
    q.close();
  }
  try {
    const inv = await import('/stores/inventoryStore.ts');
    const st = inv.useInventoryStore.getState();
    res.store = { inventory: st.inventory.length, warehouses: st.warehouses.length };
  } catch (e) { res.storeErr = String(e); }
  return res;
});
console.log(JSON.stringify(out, null, 2));
process.exit(0);

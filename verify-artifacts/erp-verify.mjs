import { chromium } from '@playwright/test';
import fs from 'node:fs';

const OUT = 'verify-artifacts';
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url())) || ctx.pages()[0];
const t0 = Date.now();
const rel = () => Date.now() - t0;

const consoleLog = [];
page.on('console', (m) => consoleLog.push({ t: rel(), type: m.type(), text: m.text() }));
const netLog = [];
page.on('response', (r) => {
  const u = r.url();
  if (/supabase\.co|\/api\/sync/.test(u)) netLog.push({ t: rel(), status: r.status(), url: u.replace(/\?.*/, '') });
});

const report = {};

await page.bringToFront();

// ── 1. Authenticated session ──────────────────────────────────────────────
report.auth = await page.evaluate(async () => {
  const { supabase } = await import('/services/supabaseClient.ts');
  const { data, error } = await supabase.auth.getSession();
  return {
    hasSession: Boolean(data.session),
    userId: data.session?.user?.id || null,
    emailDomain: data.session?.user?.email ? data.session.user.email.split('@')[1] : null,
    expiresAt: data.session?.expires_at || null,
    error: error ? String(error.message) : null,
  };
});
report.urlAtStart = page.url();

// ── 2. Instrument (only from this point on) ──────────────────────────────
await page.evaluate(async () => {
  window.__dcEvents = [];
  window.__bcEvents = [];
  window.__t = Date.now();
  if (!window.__dispatchPatched) {
    const orig = window.dispatchEvent.bind(window);
    window.dispatchEvent = function (ev) {
      try {
        if (ev && ev.type === 'primeerp:data-changed') {
          window.__dcEvents.push({ t: Date.now() - window.__t, detail: ev.detail || null });
        }
      } catch {}
      return orig(ev);
    };
    window.__dispatchPatched = true;
  }
  if (window.BroadcastChannel && !window.__bcPatched) {
    const OrigBC = window.BroadcastChannel;
    window.BroadcastChannel = class extends OrigBC {
      postMessage(msg) {
        try { if (msg && msg.type === 'data-changed') window.__bcEvents.push({ t: Date.now() - window.__t, msg }); } catch {}
        return super.postMessage(msg);
      }
    };
    window.__bcPatched = true;
  }
  if (!window.__apiPatched) {
    const mod = await import('/services/api.ts');
    const api = mod.api || mod.default || mod;
    if (api && api.inventory && typeof api.inventory.getAllItems === 'function') {
      const orig = api.inventory.getAllItems.bind(api.inventory);
      const calls = [];
      api.inventory.getAllItems = async (...a) => { calls.push(Date.now() - window.__t); return orig(...a); };
      window.__getAllItemsCalls = calls;
      window.__apiPatched = true;
    }
  }
});

async function idbCounts() {
  return await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('PrimeERP_Final_v3_Clean');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const stores = ['inventory', 'products', 'warehouses', 'warehouseInventory'];
    const out = {};
    for (const s of stores) {
      out[s] = db.objectStoreNames.contains(s)
        ? await new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).count(); r.onsuccess = () => res(r.result); r.onerror = () => res(-1); })
        : null;
    }
    db.close();
    return out;
  });
}

async function storeState() {
  return await page.evaluate(async () => {
    const inv = await import('/stores/inventoryStore.ts');
    const st = inv.useInventoryStore.getState();
    return { inventory: st.inventory.length, warehouses: st.warehouses.length, isLoading: st.isLoading };
  });
}

report.baselineIdb = await idbCounts();
report.baselineStore = await storeState();

// ── 3. Trigger a pull and capture the result ─────────────────────────────
report.pull = await page.evaluate(async () => {
  const sync = await import('/services/syncService.ts');
  const incremental = await sync.pullRemoteChanges();
  let result = { mode: 'incremental', ...incremental };
  if (incremental.pulled === 0) {
    const full = await sync.pullRemoteChanges(undefined, true);
    result = { mode: 'full', ...full };
  }
  return result;
});

// Allow the debounced DataContext refresh (80ms) + refresh tasks to run.
await page.waitForTimeout(12000);

report.events = await page.evaluate(() => window.__dcEvents || []);
report.bcEvents = await page.evaluate(() => window.__bcEvents || []);
report.getAllItemsCalls = await page.evaluate(() => window.__getAllItemsCalls || []);
report.postPullIdb = await idbCounts();
report.postPullStore = await storeState();

// ── 4. UI verification ───────────────────────────────────────────────────
await page.goto('https://localhost:5173/#/supply-chain/inventory', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(7000);
report.inventoryUi = await page.evaluate(() => {
  const t = document.body.innerText;
  const m = t.match(/(\d[\d,]*)\s+item\(s\)/);
  return { itemCountText: m ? m[1] : null, tbodyRows: document.querySelectorAll('tbody tr').length };
});
await page.screenshot({ path: `${OUT}/inventory-ui.png`, fullPage: true });

report.realtime = consoleLog.filter((c) => /realtime|TIMED_OUT|CHANNEL_ERROR/i.test(c.text)).map((c) => c.text.slice(0, 200));
report.consoleLog = consoleLog;
report.netSupabase = netLog.filter((n) => /supabase\.co/.test(n.url)).slice(0, 10);
report.netSync = netLog.filter((n) => /\/api\/sync/.test(n.url)).slice(0, 10);

fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

console.log('\n===== RESULT =====');
console.log('auth:', JSON.stringify(report.auth));
console.log('url@start:', report.urlAtStart);
console.log('baseline IDB:', JSON.stringify(report.baselineIdb), '| store:', JSON.stringify(report.baselineStore));
console.log('pull:', JSON.stringify(report.pull));
console.log('data-changed events:', JSON.stringify(report.events));
console.log('getAllItems calls:', JSON.stringify(report.getAllItemsCalls));
console.log('post-pull IDB:', JSON.stringify(report.postPullIdb), '| store:', JSON.stringify(report.postPullStore));
console.log('inventory UI:', JSON.stringify(report.inventoryUi));
console.log('realtime lines:', JSON.stringify(report.realtime.slice(0, 5)));

process.exit(0);

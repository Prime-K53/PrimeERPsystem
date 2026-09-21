/** STEP 1 preflight — read-only. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const EXPECTED = {
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
console.log('page url =', page.url());

const out = await page.evaluate(async (expected) => {
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');
  const norm = await import('/utils/inventoryNormalization.ts');
  const sb = await import('/services/supabaseClient.ts');

  let auth = { hasSupabaseSession: false, userId: null, error: null, projectRef: null };
  try {
    const { data, error } = await sb.supabase.auth.getSession();
    auth.hasSupabaseSession = !!data?.session;
    auth.userId = data?.session?.user?.id ?? null;
    auth.error = error?.message ?? null;
    const url = String(sb.supabase?.supabaseUrl ?? '');
    const m = url.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
    auth.projectRef = m ? m[1] : (url || null);
  } catch (e) { auth.error = String(e?.message || e); }

  const nexusUser = (() => {
    try { return JSON.parse(sessionStorage.getItem('nexus_user') || 'null'); } catch { return null; }
  })();

  const ledger = await dbService.getAll('ledger');
  const inventory = await dbService.getAll('inventory');
  const accounts = await dbService.getAll('accounts');

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

  const rows = ledger.filter((e) => String(e.id).startsWith('LG-MIC-'));
  const checks = [];
  for (const [id, exp] of Object.entries(expected)) {
    const found = rows.filter((r) => r.id === id);
    if (found.length !== 1) { checks.push({ id, ok: false, reason: `expected exactly 1 local row, found ${found.length}` }); continue; }
    const r = found[0];
    const diffs = [];
    for (const k of ['date', 'amount', 'debitAccountId', 'creditAccountId', 'referenceId']) {
      if (String(r[k]) !== String(exp[k])) diffs.push(`${k}: expected ${exp[k]}, found ${r[k]}`);
    }
    const rev = r.reversesEntryId ?? null;
    if (String(rev) !== String(exp.reversesEntryId)) diffs.push(`reversesEntryId: expected ${exp.reversesEntryId}, found ${rev}`);
    if (r.entryType !== 'material_inventory_correction') diffs.push(`entryType: ${r.entryType}`);
    if (r.referenceType !== 'material_inventory_correction') diffs.push(`referenceType: ${r.referenceType}`);
    if (String(r.status) !== 'posted') diffs.push(`status: ${r.status}`);
    if (!r.idempotencyKey) diffs.push('idempotencyKey missing');
    if (!r.appliedBy) diffs.push('appliedBy missing');
    if (!r.applyReason) diffs.push('applyReason missing');
    checks.push({ id, ok: diffs.length === 0, diffs, row: { id: r.id, date: r.date, amount: r.amount, debitAccountId: r.debitAccountId, creditAccountId: r.creditAccountId, referenceId: r.referenceId, entryType: r.entryType, referenceType: r.referenceType, status: r.status, reversesEntryId: rev, idempotencyKey: r.idempotencyKey } });
  }

  const micQueue = queue.filter((op) => /LG-MIC-/.test(String(op.recordId || '')));
  const allQueue = queue.map((op) => ({ table: op.table, recordId: op.recordId, operation: op.operation, status: op.status, createdAt: op.createdAt ?? null }));

  const own = engine.computeOwnBalances(accounts, ledger);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const trial = engine.computeTrialBalance(accounts, ledger);

  const included = inventory.filter((i) => norm.classifyInventoryItem(i).included);
  const operationalValue = included.reduce((s, i) =>
    s + Number(norm.resolveInventoryQuantity(i) || 0) * Number(norm.resolveInventoryCostPerUnit(i) || 0), 0);
  const operationalUnits = included.reduce((s, i) => s + Number(norm.resolveInventoryQuantity(i) || 0), 0);

  const duplicate = ledger.find((e) => e.id === 'LG-COGS-1789787524516-mcpj3jfhj') || null;

  return {
    pageUrl: location.href,
    auth,
    nexusUser: nexusUser ? { authMode: nexusUser.authMode ?? null, hasId: !!nexusUser.id, email: nexusUser.email ?? null } : null,
    localStorageKeys: Object.keys(localStorage).filter((k) => /supabase|nexus/i.test(k)),
    sessionStorageKeys: Object.keys(sessionStorage),
    outbox: { total: queue.length, all: allQueue, micRecords: micQueue.map((op) => ({ table: op.table, recordId: op.recordId, operation: op.operation, status: op.status })) },
    localLedgerCount: ledger.length,
    localMicRowCount: rows.length,
    checks,
    balances: {
      i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null, i11430: own['ACC-11430'] ?? null,
      i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
    },
    trial: { difference: trial.difference, balanced: trial.isBalanced },
    operational: { items: included.length, units: operationalUnits, value: operationalValue },
    duplicateRow: duplicate ? { id: duplicate.id, date: duplicate.date, amount: duplicate.amount, debitAccountId: duplicate.debitAccountId, creditAccountId: duplicate.creditAccountId, referenceId: duplicate.referenceId, _updatedAt: duplicate._updatedAt ?? null } : null,
    accountRefs: Object.fromEntries(
      ['ACC-11420', 'ACC-11410', 'ACC-32000', 'ACC-51200', 'ACC-11400'].map((id) => {
        const a = accounts.find((x) => x.id === id);
        return [id, a ? { id: a.id, code: a.account_number ?? a.code, name: a.name } : null];
      })
    ),
  };
}, EXPECTED);

fs.writeFileSync('verify-artifacts/sync-preflight.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify({
  pageUrl: out.pageUrl, auth: out.auth, nexusUser: out.nexusUser,
  localStorageKeys: out.localStorageKeys, sessionStorageKeys: out.sessionStorageKeys,
  outbox: out.outbox, localLedgerCount: out.localLedgerCount, localMicRowCount: out.localMicRowCount,
  checks: out.checks, balances: out.balances, trial: out.trial, operational: out.operational,
}, null, 1));
process.exit(0);

/**
 * PHASE A — READ-ONLY PROBE (no writes).
 * Captures: sync-engine guard state (paused/auth-blocked/isSyncing), session,
 * full outbox state, the exact LG-OPENING-BALANCE outbox op (id + full payload),
 * pre-operation remote snapshots (LG-OPENING-BALANCE, LG-COGS dup, warehouses),
 * MIC absence remotely, local counts, integrity fingerprints, local balances.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const MIC_IDS = [
  'LG-MIC-REV-1789961780893-5wvx4kqr3',
  'LG-MIC-OPENING-1789961780893-thsjuxe8o',
  'LG-MIC-CAPITAL-1789961780893-t1qzdpjki',
];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }
console.log('page =', page.url());

const out = await page.evaluate(async (micIds) => {
  const sb = await import('/services/supabaseClient.ts');
  const { cloudDb } = await import('/services/cloudDb.ts');
  const { durableSyncQueue } = await import('/services/durableSyncQueue.ts');
  const { backgroundSyncService } = await import('/services/backgroundSyncService.ts');
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');

  // ── session ──
  const session = await sb.supabase.auth.getSession();
  const nexusUser = (() => { try { return JSON.parse(sessionStorage.getItem('nexus_user') || 'null'); } catch { return null; } })();

  // ── sync engine guards (read-only) ──
  const st = await backgroundSyncService.getState().catch((e) => ({ error: String(e) }));
  const authBlocked = await durableSyncQueue.isAuthBlocked().catch((e) => ({ error: String(e) }));
  const authBlockReason = await durableSyncQueue.getMeta('sync_auth_block_reason').catch(() => null);

  // ── full outbox ──
  const allOps = await durableSyncQueue.getAll();
  const ops = allOps.map((o) => ({
    id: o.id, table: o.table, recordId: o.recordId, operation: o.operation,
    status: o.status, createdAt: o.createdAt ?? null, syncGeneration: o.syncGeneration ?? null,
    retryCount: o.retryCount ?? null, lastError: o.lastError ?? null, dependsOn: o.dependsOn ?? [],
  }));
  const obOp = allOps.find((o) => o.table === 'ledger_entries' && o.recordId === 'LG-OPENING-BALANCE') || null;

  // ── local stores ──
  const ledger = await dbService.getAll('ledger');
  const inventory = await dbService.getAll('inventory');
  const invTxns = await dbService.getAll('inventoryTransactions');
  const whInv = await dbService.getAll('warehouseInventory');
  const warehouses = await dbService.getAll('warehouses');
  const accounts = await dbService.getAll('accounts');

  // ── fingerprints (pre) ──
  const fp = (rows, fields) => rows
    .map((r) => fields.map((f) => String(r[f] ?? '')).join(':')).sort().join('|');
  const inventoryFp = fp(inventory, ['id', 'stock', 'cost']);
  const invTxnFp = fp(invTxns, ['id', 'itemId', 'quantity', 'type', 'date']);
  const whInvFp = fp(whInv, ['id', 'itemId', 'warehouseId', 'quantity']);
  const warehouseFp = fp(warehouses, ['id', 'name', 'type', 'location']);
  const smartStock = invTxns.filter((t) => /smart\s*stock/i.test(String(t.notes ?? t.reason ?? t.referenceId ?? '')));
  const smartStockFp = fp(smartStock, ['id', 'itemId', 'quantity', 'type', 'date']);

  // ── local balances (pre) ──
  const own = engine.computeOwnBalances(accounts, ledger);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const trial = engine.computeTrialBalance(accounts, ledger);

  // ── remote snapshots (read-only, authenticated app path) ──
  const readIds = async (table, ids) => {
    const { data, error } = await sb.supabase.from(table).select('*').in('id', ids);
    return { error: error?.message ?? null, rows: data || [] };
  };
  const ledgerRemote = await readIds('ledger_entries', [...micIds, 'LG-OPENING-BALANCE', 'LG-COGS-1789787524516-mcpj3jfhj']);
  const whRemote = await readIds('warehouses', ['WH-MAIN', 'WH-VIR', 'WH-SHOP']);

  const obRow = ledgerRemote.rows.find((r) => r.id === 'LG-OPENING-BALANCE') || null;
  const cogsRow = ledgerRemote.rows.find((r) => r.id === 'LG-COGS-1789787524516-mcpj3jfhj') || null;

  const remoteLedgerCount = await (async () => {
    const { count, error } = await sb.supabase.from('ledger_entries').select('id', { head: true, count: 'exact' });
    return { count: count ?? null, error: error?.message ?? null };
  })();

  // remote products count (inventory) for post-sync comparison
  const remoteProductsCount = await (async () => {
    const { count, error } = await sb.supabase.from('products').select('id', { head: true, count: 'exact' });
    return { count: count ?? null, error: error?.message ?? null };
  })();

  return {
    auth: {
      has: !!session?.data?.session,
      userId: session?.data?.session?.user?.id ?? null,
      expiresAt: session?.data?.session?.expires_at ?? null,
      error: session?.error?.message ?? null,
    },
    nexusUser: nexusUser ? { authMode: nexusUser.authMode ?? null, hasId: !!nexusUser.id } : null,
    cloudDbConfigured: cloudDb.isConfigured(),
    syncEngine: {
      isPaused: backgroundSyncService.isPaused(),
      state: st,
      authBlocked,
      authBlockReason: authBlockReason ?? null,
    },
    outbox: {
      total: allOps.length,
      ops,
      openingBalanceOp: obOp ? {
        id: obOp.id, table: obOp.table, recordId: obOp.recordId, operation: obOp.operation,
        status: obOp.status, createdAt: obOp.createdAt ?? null, syncGeneration: obOp.syncGeneration ?? null,
        baseVersion: obOp.baseVersion ?? null, payload: obOp.payload, dependsOn: obOp.dependsOn ?? [],
      } : null,
    },
    local: {
      ledgerCount: ledger.length,
      counts: { inventory: inventory.length, invTxns: invTxns.length, whInv: whInv.length, warehouses: warehouses.length, accounts: accounts.length },
      balances: {
        i11410: own['ACC-11410'] ?? null, i11420: own['ACC-11420'] ?? null,
        i11400rollup: roll['ACC-11400'] ?? null, eq32000: own['ACC-32000'] ?? null, cogs51200: own['ACC-51200'] ?? null,
      },
      trial: { debits: trial.totalDebits, credits: trial.totalCredits, difference: trial.difference, balanced: trial.isBalanced },
    },
    fingerprintsPre: { inventory: inventoryFp, invTxns: invTxnFp, whInv: whInvFp, warehouses: warehouseFp, smartStock: smartStockFp, smartStockCount: smartStock.length },
    remotePre: {
      ledgerCount: remoteLedgerCount,
      productsCount: remoteProductsCount,
      micRows: ledgerRemote.rows.filter((r) => micIds.includes(r.id)).map((r) => r.id),
      openingBalanceRow: obRow,
      cogsRow,
      warehouseRows: whRemote,
    },
  };
}, MIC_IDS);

fs.writeFileSync('verify-artifacts/dl-probe.json', JSON.stringify(out, null, 1));

// console summary (fingerprints excluded)
const brief = {
  auth: out.auth,
  nexusUser: out.nexusUser,
  cloudDbConfigured: out.cloudDbConfigured,
  syncEngine: out.syncEngine,
  outboxSummary: out.outbox.ops,
  openingBalanceOpId: out.outbox.openingBalanceOp?.id ?? null,
  openingBalanceOpPayload: out.outbox.openingBalanceOp?.payload ?? null,
  local: out.local,
  remotePre: {
    ledgerCount: out.remotePre.ledgerCount,
    productsCount: out.remotePre.productsCount,
    micRows: out.remotePre.micRows,
    openingBalanceRow: out.remotePre.openingBalanceRow,
    cogsRow: out.remotePre.cogsRow,
  },
};
console.log(JSON.stringify(brief, null, 1));
console.log('=== fingerprints (lengths) ===');
for (const [k, v] of Object.entries(out.fingerprintsPre)) {
  console.log(k, typeof v === 'string' ? `len=${v.length}` : v);
}
process.exit(0);

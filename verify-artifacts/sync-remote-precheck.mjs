/** Pre-sync REMOTE read (read-only) via the app's authenticated Supabase path. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }

const out = await page.evaluate(async () => {
  const sb = await import('/services/supabaseClient.ts');
  const { cloudDb } = await import('/services/cloudDb.ts');

  const session = await sb.supabase.auth.getSession();
  const auth = {
    has: !!session?.data?.session,
    userId: session?.data?.session?.user?.id ?? null,
    email: session?.data?.session?.user?.email ?? null,
    error: session?.error?.message ?? null,
    expiresAt: session?.data?.session?.expires_at ?? null,
  };

  const nexusUser = (() => { try { return JSON.parse(sessionStorage.getItem('nexus_user') || 'null'); } catch { return null; } })();

  const readRows = async (table, ids) => {
    try {
      const { data, error } = await sb.supabase.from(table).select('*').in('id', ids);
      if (error) return { error: error.message, code: error.code ?? null, rows: [] };
      return { error: null, rows: data || [] };
    } catch (e) { return { error: String(e?.message || e), rows: [] }; }
  };

  const countTable = async (table) => {
    try {
      const { count, error } = await sb.supabase.from(table).select('id', { head: true, count: 'exact' });
      return { error: error?.message ?? null, count: count ?? null };
    } catch (e) { return { error: String(e?.message || e), count: null }; }
  };

  const ledgerIds = [
    'LG-MIC-REV-1789961780893-5wvx4kqr3',
    'LG-MIC-OPENING-1789961780893-thsjuxe8o',
    'LG-MIC-CAPITAL-1789961780893-t1qzdpjki',
    'LG-OPENING-BALANCE',
    'LG-COGS-1789787524516-mcpj3jfhj',
    'LG-PAY-1789817607332-zqa2stm17',
    'LG-PAY-1789830621031-y7j5vqknj',
  ];
  const whIds = ['WH-MAIN', 'WH-VIR', 'WH-SHOP'];

  const ledger = await readRows('ledger_entries', ledgerIds);
  const warehouses = await readRows('warehouses', whIds);

  // Also count remote occurrences of the correction referenceIds to catch any
  // pre-existing conflicting remote row.
  let refRows = { error: null, rows: [] };
  try {
    const { data, error } = await sb.supabase
      .from('ledger_entries')
      .select('id,referenceId')
      .like('referenceId', 'CORR-MATINV-%');
    refRows = { error: error?.message ?? null, rows: data || [] };
  } catch (e) { refRows = { error: String(e?.message || e), rows: [] }; }

  let reversalRows = { error: null, rows: [] };
  try {
    const { data, error } = await sb.supabase
      .from('ledger_entries')
      .select('id,reversesEntryId')
      .eq('reversesEntryId', 'LG-COGS-1789787524516-mcpj3jfhj');
    reversalRows = { error: error?.message ?? null, rows: data || [] };
  } catch (e) { reversalRows = { error: String(e?.message || e), rows: [] }; }

  return {
    auth,
    nexusUser: nexusUser ? { authMode: nexusUser.authMode ?? null, hasId: !!nexusUser.id } : null,
    cloudDbConfigured: cloudDb.isConfigured(),
    tableMap: { ledger: 'ledger_entries', warehouses: 'warehouses' },
    remoteLedgerCount: await countTable('ledger_entries'),
    remoteLedgerRows: ledger,
    remoteWarehouseRows: warehouses,
    remoteCorrMatinvRows: refRows,
    remoteReversalRows: reversalRows,
  };
});

fs.writeFileSync('verify-artifacts/sync-remote-precheck.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

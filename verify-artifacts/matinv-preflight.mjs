// READ-ONLY pre-flight for the approved 11420 material-inventory correction.
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const DUPLICATE_ID = 'LG-COGS-1789787524516-mcpj3jfhj';
const MARKERS = ['CORR-MATINV-REV', 'CORR-MATINV-OPENING-11420', 'CORR-MATINV-CAPITAL-11420'];

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE'); process.exit(2); }
console.log('page url =', page.url());

const out = await page.evaluate(async (args) => {
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');
  const { resolveAccountForPosting } = await import('/services/transactions/_internal.ts');
  const sb = await import('/services/supabaseClient.ts');

  let sessionInfo = { has: false, error: null };
  try {
    const { data, error } = await sb.supabase.auth.getSession();
    sessionInfo = { has: !!data?.session, userId: data?.session?.user?.id ?? null, error: error?.message ?? null };
  } catch (e) { sessionInfo = { has: false, error: String(e?.message || e) }; }

  const accounts = await dbService.getAll('accounts');
  const ledger = await dbService.getAll('ledger');

  const pick = (ref) => {
    const direct = accounts.find((a) => a.id === ref || a.code === ref || a.account_number === ref);
    const resolved = resolveAccountForPosting(ref, accounts, { allowNonPosting: false });
    const resolvedAcct = resolved ? accounts.find((a) => a.id === resolved) : null;
    return {
      ref,
      directFound: !!direct,
      resolved,
      resolvedCode: resolvedAcct ? (resolvedAcct.account_number ?? resolvedAcct.code ?? null) : null,
      resolvedName: resolvedAcct?.name ?? null,
      resolvedType: resolvedAcct ? (resolvedAcct.account_type ?? resolvedAcct.type ?? null) : null,
      resolvedAllowPosting: resolvedAcct ? (resolvedAcct.allow_posting ?? null) : null,
      resolvedIsActive: resolvedAcct ? (resolvedAcct.is_active ?? null) : null,
      resolvedParent: resolvedAcct ? (resolvedAcct.parent_account_id ?? null) : null,
      resolvedOpening: resolvedAcct ? Number(resolvedAcct.opening_balance ?? 0) : null,
      direct: direct ? { id: direct.id, code: direct.account_number ?? direct.code ?? null, name: direct.name, type: direct.account_type ?? direct.type ?? null, allow_posting: direct.allow_posting ?? null, opening_balance: Number(direct.opening_balance ?? 0) } : null,
    };
  };

  const dup = ledger.find((e) => e.id === args.duplicateId) || null;
  const reversalOfDup = ledger.filter((e) =>
    String(e.reversesEntryId || '') === args.duplicateId ||
    String(e.referenceId || '') === `REV-${args.duplicateId}` ||
    String(e.referenceId || '').includes(args.duplicateId)
  );
  const existingMarkers = ledger.filter((e) =>
    args.markers.some((m) => String(e.referenceId || '').startsWith(m) || String(e.entryType || '') === 'material_inventory_correction')
  );

  // Balances via the authoritative engine
  const own = engine.computeOwnBalances(accounts, ledger);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const balOf = (ref) => {
    const a = accounts.find((x) => x.id === ref || x.code === ref || x.account_number === ref);
    return a ? { id: a.id, own: own[a.id] ?? 0, rollup: roll[a.id] ?? 0 } : null;
  };
  const trial = engine.computeTrialBalance(accounts, ledger);

  return {
    sessionInfo,
    accounts: { a11420: pick('11420'), a11430: pick('11430'), a11410: pick('11410'), a11400: pick('11400'), a32000: pick('32000'), a51200: pick('51200') },
    duplicate: dup ? {
      id: dup.id, date: dup.date, amount: dup.amount, description: dup.description,
      debitAccountId: dup.debitAccountId, creditAccountId: dup.creditAccountId,
      referenceId: dup.referenceId, entryType: dup.entryType, referenceType: dup.referenceType,
      status: dup.status, reconciled: dup.reconciled, createdAt: dup.created_at ?? dup.createdAt ?? null,
    } : null,
    reversalOfDup: reversalOfDup.map((e) => ({ id: e.id, date: e.date, amount: e.amount, ref: e.referenceId, entryType: e.entryType })),
    existingMarkers: existingMarkers.map((e) => ({ id: e.id, date: e.date, amount: e.amount, ref: e.referenceId, entryType: e.entryType })),
    ledgerCount: ledger.length,
    balances: { b11420: balOf('11420'), b11430: balOf('11430'), b11410: balOf('11410'), b11400: balOf('11400'), b32000: balOf('32000'), b51200: balOf('51200') },
    trial: { totalDebits: trial.totalDebits, totalCredits: trial.totalCredits, difference: trial.difference, isBalanced: trial.isBalanced },
  };
}, { duplicateId: DUPLICATE_ID, markers: MARKERS });

fs.writeFileSync('verify-artifacts/matinv-preflight.json', JSON.stringify(out, null, 1));

console.log('\n=== AUTH ===', JSON.stringify(out.sessionInfo));
console.log('\n=== ACCOUNTS ===');
for (const [k, v] of Object.entries(out.accounts)) {
  console.log(k, '=>', JSON.stringify(v));
}
console.log('\n=== DUPLICATE ===', JSON.stringify(out.duplicate, null, 1));
console.log('\n=== REVERSALS OF DUPLICATE ===', JSON.stringify(out.reversalOfDup));
console.log('=== EXISTING CORRECTION MARKERS ===', JSON.stringify(out.existingMarkers));
console.log('=== LEDGER ROWS ===', out.ledgerCount);
console.log('\n=== BALANCES (own | rollup) ===');
for (const [k, v] of Object.entries(out.balances)) console.log(k, '=>', v ? `own=${v.own} rollup=${v.rollup}` : 'NOT FOUND');
console.log('=== TRIAL ===', JSON.stringify(out.trial));
process.exit(0);

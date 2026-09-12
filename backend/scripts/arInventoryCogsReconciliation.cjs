/**
 * arInventoryCogsReconciliation.cjs — READ-ONLY diagnostic.
 *
 * Reconciles, independently from displayed balances:
 *   1. AR 11310: invoice receivable postings vs payment AR-credits vs credit notes
 *   2. Inventory 11410/11420/11430 vs operational movements
 *   3. COGS 51200 vs fulfilled stocked-item costs
 *   4. Duplicates / wrong-account / wrong-status / orphan references
 *
 * SAFETY: this script performs ONLY HTTP GET (Supabase REST SELECT).
 * It never writes, patches, deletes, or enqueues anything.
 * The secret key is read from backend/.env and is NEVER printed.
 *
 * Run: node scripts/arInventoryCogsReconciliation.cjs
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    const text = fs.readFileSync(envPath, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) {
        const v = m[2].replace(/^["']|["']$/g, '');
        if (!(m[1] in process.env)) process.env[m[1]] = v;
      }
    }
  } catch { /* no .env — rely on environment */ }
}
loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rdtuzuzehfbwvfdzqliw.supabase.co';
const KEY = process.env.SUPABASE_SECRET_KEY || '';
if (!KEY) {
  console.error('SUPABASE_SECRET_KEY is not set (backend/.env or environment). Aborting.');
  process.exit(1);
}
const HEADERS = {
  apikey: KEY,
  Authorization: `Bearer ${KEY}`,
  'Content-Type': 'application/json',
};

async function getAll(table) {
  const rows = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data } = await axios.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      params: { select: '*', limit: PAGE, offset },
      headers: HEADERS,
      timeout: 30000,
    });
    if (!Array.isArray(data) || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const codeOf = (ref) => String(ref || '').replace(/^ACC-/, '').trim();
const fmt = (n) => `K${num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function classifyStatus(inv) {
  const d = inv.data || inv;
  return String(d.status || d.invoiceStatus || 'Unknown');
}

async function main() {
  console.log('=== READ-ONLY AR / INVENTORY / COGS RECONCILIATION ===\n');

  const [ledgerRows, invoiceRows, paymentRows, accountsRows] = await Promise.all([
    getAll('ledger_entries'),
    getAll('invoices').catch((e) => ({ __error: String(e.message || e) })),
    getAll('customer_payments').catch((e) => ({ __error: String(e.message || e) })),
    getAll('accounts').catch(() => []),
  ]);

  const ledger = ledgerRows.map((r) => r.data || r).filter((d) => d && typeof d === 'object');
  console.log(`ledger_entries: ${ledgerRows.length} rows (${ledger.length} with data envelope)`);
  console.log(`invoices: ${Array.isArray(invoiceRows) ? invoiceRows.length : invoiceRows.__error}`);
  console.log(`customer_payments: ${Array.isArray(paymentRows) ? paymentRows.length : paymentRows.__error}`);
  console.log(`accounts: ${Array.isArray(accountsRows) ? accountsRows.length : 0}`);

  // ---- 0. Trial balance by account ref + orphans ----
  const tb = {};
  const touch = (ref, side, amount) => {
    const c = codeOf(ref);
    if (!c) return;
    tb[c] = tb[c] || { debit: 0, credit: 0 };
    tb[c][side] += num(amount);
  };
  for (const e of ledger) {
    touch(e.debitAccountId, 'debit', e.amount);
    touch(e.creditAccountId, 'credit', e.amount);
  }
  const codes = Object.keys(tb).sort();
  let totD = 0;
  let totC = 0;
  console.log('\n--- Trial balance by account code ---');
  for (const c of codes) {
    totD += tb[c].debit;
    totC += tb[c].credit;
    console.log(`  ${c}: Dr ${fmt(tb[c].debit)} | Cr ${fmt(tb[c].credit)}`);
  }
  console.log(`  TOTAL: Dr ${fmt(totD)} = Cr ${fmt(totC)}  diff ${fmt(totD - totC)}`);

  const known = new Set();
  for (const a of Array.isArray(accountsRows) ? accountsRows : []) {
    const d = a.data || a;
    for (const k of ['id', 'code', 'account_number']) if (d[k]) known.add(String(d[k]));
    if (d.code) known.add(`ACC-${d.code}`);
  }
  // seed with canonical 5-digit codes from the spec COA
  ['11110','11210','11220','11230','11240','11310','11410','11420','11430','21110','31000','32000','33000','34000','41100','41200','51200','21300','11120'].forEach((c) => { known.add(c); known.add(`ACC-${c}`); });
  const orphans = ledger.filter((e) => (e.debitAccountId && !known.has(String(e.debitAccountId))) || (e.creditAccountId && !known.has(String(e.creditAccountId))));
  console.log(`\norphan references: ${orphans.length}`);
  orphans.slice(0, 10).forEach((e) => console.log(`  ${e.id}: Dr=${e.debitAccountId} Cr=${e.creditAccountId} amt=${e.amount} ref=${e.referenceId}`));

  // ---- 1. AR postings grouped ----
  const arDebits = ledger.filter((e) => codeOf(e.debitAccountId) === '11310');
  const arCredits = ledger.filter((e) => codeOf(e.creditAccountId) === '11310');
  const sumD = arDebits.reduce((s, e) => s + num(e.amount), 0);
  const sumC = arCredits.reduce((s, e) => s + num(e.amount), 0);
  console.log(`\n--- 11310 Trade Debtors ---`);
  console.log(`  AR debits : ${arDebits.length} entries = ${fmt(sumD)}`);
  console.log(`  AR credits: ${arCredits.length} entries = ${fmt(sumC)}`);
  console.log(`  Net 11310 = ${fmt(sumD - sumC)}`);

  // group AR debits by referenceId prefix
  const byPrefix = {};
  for (const e of arDebits) {
    const id = String(e.id || '');
    const p = id.startsWith('LG-INV-AR') ? 'LG-INV-AR' : id.startsWith('LG-QTN-INV-AR') ? 'LG-QTN-INV-AR' : id.startsWith('LG-JO-INV-AR') ? 'LG-JO-INV-AR' : id.startsWith('LG-REV-AR') ? 'LG-REV-AR' : id.startsWith('LG-INV-PAY') ? 'LG-INV-PAY?' : 'OTHER';
    byPrefix[p] = byPrefix[p] || { n: 0, amt: 0 };
    byPrefix[p].n += 1;
    byPrefix[p].amt += num(e.amount);
  }
  console.log('  AR-debit groups by entry-id prefix:');
  for (const [p, g] of Object.entries(byPrefix)) console.log(`    ${p}: ${g.n} x ${fmt(g.amt)}`);

  // duplicate AR debits per referenceId
  const arByRef = {};
  for (const e of arDebits) {
    const r = String(e.referenceId || '(none)');
    arByRef[r] = arByRef[r] || [];
    arByRef[r].push(e);
  }
  const dupRefs = Object.entries(arByRef).filter(([, v]) => v.length > 1);
  console.log(`  referenceIds with >1 AR debit: ${dupRefs.length}`);
  dupRefs.slice(0, 10).forEach(([r, v]) => console.log(`    ${r}: ${v.map((e) => `${e.id}=${e.amount}`).join(' | ')}`));

  console.log('\n  AR credits detail:');
  arCredits.forEach((e) => console.log(`    ${e.id}: ${fmt(e.amount)} ref=${e.referenceId} Dr=${e.debitAccountId} date=${e.date} desc=${String(e.description || '').slice(0, 80)}`));

  // ---- 2. Invoices ----
  const invoices = (Array.isArray(invoiceRows) ? invoiceRows : []).map((r) => r.data || r);
  console.log(`\n--- Invoices (${invoices.length}) ---`);
  if (invoices.length > 0) {
    const sample = invoices[0];
    console.log('  sample invoice keys:', Object.keys(sample).join(', '));
  }
  const invTable = [];
  for (const inv of invoices) {
    const id = inv.id || inv.invoiceNumber || '(no-id)';
    const total = num(inv.totalAmount ?? inv.total ?? inv.grandTotal);
    const paid = num(inv.paidAmount ?? inv.amountPaid ?? 0);
    const st = classifyStatus(inv);
    const arJ = arDebits.filter((e) => String(e.referenceId) === String(inv.id) || String(e.referenceId) === String(inv.invoiceNumber));
    const arSum = arJ.reduce((s, e) => s + num(e.amount), 0);
    invTable.push({ id, total, paid, outstanding: total - paid, status: st, arEntries: arJ.length, arSum });
  }
  invTable.sort((a, b) => b.total - a.total);
  console.log('  Invoice | Total | Paid | Outstanding | Status | AR entries | AR sum');
  for (const r of invTable.slice(0, 40)) {
    console.log(`  ${r.id} | ${fmt(r.total)} | ${fmt(r.paid)} | ${fmt(r.outstanding)} | ${r.status} | ${r.arEntries} | ${fmt(r.arSum)}`);
  }
  if (invTable.length > 40) console.log(`  ... and ${invTable.length - 40} more`);
  const sumInv = invTable.reduce((s, r) => s + r.total, 0);
  const sumPaid = invTable.reduce((s, r) => s + r.paid, 0);
  const sumARJ = invTable.reduce((s, r) => s + r.arSum, 0);
  console.log(`  SUM invoice totals=${fmt(sumInv)} paid=${fmt(sumPaid)} outstanding=${fmt(sumInv - sumPaid)} AR-journal=${fmt(sumARJ)}`);

  // ---- 3. Payments ----
  const payments = (Array.isArray(paymentRows) ? paymentRows : []).map((r) => r.data || r);
  console.log(`\n--- Payments (${payments.length}) ---`);
  if (payments.length > 0) {
    console.log('  sample payment keys:', Object.keys(payments[0]).join(', '));
  }
  for (const p of payments.slice(0, 40)) {
    const allocs = Array.isArray(p.allocations) ? p.allocations.map((a) => `${a.invoiceId}:${a.amount}`).join(',') : '';
    const linked = arCredits.filter((e) => String(e.referenceId) === String(p.id));
    console.log(`  ${p.id}: amt=${fmt(p.amount)} date=${p.date} method=${p.paymentMethod || p.method} status=${p.status} invoiceId=${p.invoiceId || ''} allocs=[${allocs}] AR-credits=${linked.length}x${fmt(linked.reduce((s, e) => s + num(e.amount), 0))}`);
  }

  // ---- 4. COGS + Inventory ----
  const cogs = ledger.filter((e) => codeOf(e.debitAccountId) === '51200');
  const invCredits = ledger.filter((e) => ['11410', '11420', '11430', '11400'].includes(codeOf(e.creditAccountId)));
  const invDebits = ledger.filter((e) => ['11410', '11420', '11430', '11400'].includes(codeOf(e.debitAccountId)));
  console.log(`\n--- COGS 51200: ${cogs.length} entries = ${fmt(cogs.reduce((s, e) => s + num(e.amount), 0))} ---`);
  cogs.slice(0, 20).forEach((e) => console.log(`  ${e.id}: ${fmt(e.amount)} ref=${e.referenceId} Cr=${e.creditAccountId} date=${e.date}`));
  console.log(`--- Inventory credits (114xx): ${invCredits.length} entries = ${fmt(invCredits.reduce((s, e) => s + num(e.amount), 0))} ---`);
  invCredits.slice(0, 20).forEach((e) => console.log(`  ${e.id}: ${fmt(e.amount)} ref=${e.referenceId} Cr=${e.creditAccountId} date=${e.date}`));
  console.log(`--- Inventory debits (114xx): ${invDebits.length} entries = ${fmt(invDebits.reduce((s, e) => s + num(e.amount), 0))} ---`);
  invDebits.slice(0, 20).forEach((e) => console.log(`  ${e.id}: ${fmt(e.amount)} ref=${e.referenceId} Dr=${e.debitAccountId} date=${e.date}`));

  // expected COGS per invoice from line snapshots (read-only estimate)
  console.log('\n--- Per-invoice COGS expectation (from persisted line snapshots) ---');
  const COST_KEYS = ['productionCostSnapshot', 'unitCost', 'cost_price', 'cost_per_unit', 'cost', 'costPrice'];
  for (const inv of invoices.slice(0, 40)) {
    const items = inv.items || inv.lineItems || inv.lines || [];
    if (!Array.isArray(items) || items.length === 0) continue;
    let stocked = 0;
    let service = 0;
    let estCOGS = 0;
    let hasSnapshot = false;
    for (const it of items) {
      const type = String(it.type || it.itemType || it.category || 'product');
      const qty = num(it.quantity ?? it.qty ?? 1);
      if (/service/i.test(type)) { service += 1; continue; }
      stocked += 1;
      let unit = null;
      if (it.productionCostSnapshot && num(it.productionCostSnapshot.baseProductionCost) > 0) { unit = num(it.productionCostSnapshot.baseProductionCost); hasSnapshot = true; }
      else for (const k of COST_KEYS.slice(1)) { if (num(it[k]) > 0) { unit = num(it[k]); break; } }
      if (unit != null) estCOGS += qty * unit;
    }
    const actual = cogs.filter((e) => String(e.referenceId) === String(inv.id)).reduce((s, e) => s + num(e.amount), 0);
    const cogsCount = cogs.filter((e) => String(e.referenceId) === String(inv.id)).length;
    console.log(`  ${inv.id}: stocked=${stocked} service=${service} snapshot=${hasSnapshot} estCOGS~${fmt(estCOGS)} actualCOGS=${fmt(actual)} (${cogsCount}) status=${classifyStatus(inv)} fulfill=${inv.fulfillmentStatus || inv.fulfillment_status || ''}`);
  }

  // ---- 5. Revenue split 41100 vs 41200 ----
  const rev411 = ledger.filter((e) => codeOf(e.creditAccountId) === '41100').reduce((s, e) => s + num(e.amount), 0);
  const rev412 = ledger.filter((e) => codeOf(e.creditAccountId) === '41200').reduce((s, e) => s + num(e.amount), 0);
  console.log(`\n--- Revenue: 41100=${fmt(rev411)} 41200=${fmt(rev412)} total=${fmt(rev411 + rev412)} ---`);

  console.log('\n=== END (no writes performed) ===');
}

main().catch((e) => {
  console.error('Diagnostic failed:', e.message);
  process.exit(1);
});

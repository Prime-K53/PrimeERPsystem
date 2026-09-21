import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const invoices = await dbService.getAll('invoices');
  const ledger = await dbService.getAll('ledger');
  const accounts = await dbService.getAll('accounts');
  const idToCode = {};
  for (const a of accounts) idToCode[String(a.id)] = String(a.account_number ?? a.code ?? '');
  const ledgerInv = ledger
    .map((e) => ({ ref: e.referenceId, credit: idToCode[String(e.creditAccountId)], debit: idToCode[String(e.debitAccountId)], amount: e.amount, id: e.id, date: e.date }))
    .filter((e) => ['11410', '11420', '11430'].includes(e.credit) || ['11410', '11420', '11430'].includes(e.debit));
  return { invoices: invoices.map((i) => ({ id: i.id, date: i.date, total: i.total, items: i.items || [] })), ledgerInv };
});
fs.writeFileSync('verify-artifacts/recon-lines.json', JSON.stringify(out, null, 1));

const refs = [...new Set(out.ledgerInv.map((e) => e.ref))];
console.log('inventory COGS invoices:', refs.join(', '));
let sum11410 = 0, sum11420 = 0;
for (const e of out.ledgerInv) { if (e.credit === '11410') sum11410 += e.amount; if (e.credit === '11420') sum11420 += e.amount; }
console.log('ledger 11410 total', Math.round(sum11410 * 100) / 100, '| 11420 total', Math.round(sum11420 * 100) / 100);

for (const id of refs.sort()) {
  const inv = out.invoices.find((i) => i.id === id);
  if (!inv) { console.log(id, 'INVOICE NOT FOUND'); continue; }
  const byType = {};
  for (const l of inv.items) { const t = l.type || '(none)'; byType[t] = Math.round(((byType[t] || 0) + Number(l.cost || 0) * Number(l.quantity || 0)) * 100) / 100; }
  const led = out.ledgerInv.filter((e) => e.ref === id);
  const c11410 = led.filter((e) => e.credit === '11410').reduce((s, e) => s + e.amount, 0);
  const c11420 = led.filter((e) => e.credit === '11420').reduce((s, e) => s + e.amount, 0);
  console.log(id.padEnd(14), 'led11410=' + String(Math.round(c11410 * 100) / 100).padEnd(10), 'led11420=' + String(Math.round(c11420 * 100) / 100).padEnd(10), 'nEntries=' + led.length, JSON.stringify(byType));
}
process.exit(0);

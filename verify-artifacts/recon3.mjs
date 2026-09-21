import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const accounts = await dbService.getAll('accounts');
  const items = await dbService.getAll('inventory');
  return {
    accounts: accounts.map((a) => ({ id: a.id, code: a.account_number ?? a.code, name: a.name, type: a.account_type || a.type, group: a.account_group, normal: a.normal_balance })).sort((x, y) => String(x.code).localeCompare(String(y.code))),
    bearingRaw: items.map((i) => ({ id: i.id, name: i.name, type: i.type, status: i.status, stock: i.stock, cost_price: i.cost_price, cost: i.cost })).filter((i) => ['Stationery', 'Raw Material'].includes(String(i.type)) && String(i.status).toLowerCase() !== 'deleted'),
  };
});
fs.writeFileSync('verify-artifacts/recon3.json', JSON.stringify(out, null, 1));
console.log('=== COA ===');
for (const a of out.accounts) console.log(String(a.code).padEnd(7), String(a.type).padEnd(9), String(a.group || '').padEnd(16), a.normal, a.name);
console.log('\n=== bearing raw (non-deleted stationery/raw) count', out.bearingRaw.length, '===');
process.exit(0);

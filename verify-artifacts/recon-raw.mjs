import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const items = await dbService.getAll('inventory');
  const invoices = await dbService.getAll('invoices');
  const names = new Set(['Scheme Pad - M', 'Scheme Pad - S', 'Lesson Plans - L', 'Time Book - L', 'Bic Pens (Copy)', 'Bic Pens (Original)']);
  const match = items.filter((i) => names.has(String(i.name)) || /scheme pad|lesson plan|time book|bic pens/i.test(String(i.name)));
  const deleted = items.filter((i) => String(i.status).toLowerCase() === 'deleted').map((i) => ({ id: i.id, name: i.name, type: i.type, status: i.status, stock: i.stock, cost: i.cost_price ?? i.cost }));
  const rawLines = [];
  for (const inv of invoices) {
    if (!/INV-P726\/02[1-8]/.test(String(inv.id))) continue;
    for (const l of inv.items || []) {
      rawLines.push({ invoice: inv.id, ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : v])) });
    }
  }
  return {
    matchedItems: match.map((i) => ({ id: i.id, name: i.name, type: i.type, productType: i.productType, inventoryRole: i.inventoryRole, status: i.status, stock: i.stock })),
    deleted,
    rawLines,
  };
});
fs.writeFileSync('verify-artifacts/recon-raw.json', JSON.stringify(out, null, 1));
console.log('=== items matching scheme pad / bic pens etc ==='); console.log(JSON.stringify(out.matchedItems, null, 1));
console.log('=== deleted items ==='); console.log(JSON.stringify(out.deleted, null, 1));
console.log('=== raw line fields (first 6) ==='); console.log(JSON.stringify(out.rawLines.slice(0, 6), null, 1));
process.exit(0);

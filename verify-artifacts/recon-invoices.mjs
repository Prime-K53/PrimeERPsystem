import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const norm = await import('/utils/inventoryNormalization.ts');
  const items = await dbService.getAll('inventory');
  const invoices = await dbService.getAll('invoices');
  const txns = await dbService.getAll('inventoryTransactions');

  const itemById = {};
  for (const it of items) itemById[String(it.id)] = it;
  const typeOf = (id) => {
    const it = itemById[String(id)];
    if (!it) return { type: '(item not found)', bearing: null };
    return { type: String(it._rawType ?? it.type ?? ''), bearing: norm.isInventoryBearingItem(it), acct: norm.resolveInventoryGLAccountCode(it) };
  };

  const ids = ['INV-P726/021', 'INV-P726/022', 'INV-P726/023', 'INV-P726/024', 'INV-P726/025', 'INV-P726/026', 'INV-P726/027', 'INV-P726/028'];
  const invoiceDetail = [];
  for (const inv of invoices) {
    if (!ids.includes(String(inv.id))) continue;
    const lines = (inv.items || []).map((l) => {
      const t = typeOf(l.itemId || l.id || l.productId);
      const qty = Number(l.quantity ?? l.qty ?? 0);
      const cost = Number(l.cost ?? l.costPrice ?? l.cost_price ?? itemById[String(l.itemId)]?.cost_price ?? 0);
      return {
        itemId: l.itemId || l.id || l.productId,
        name: l.name || l.description || itemById[String(l.itemId)]?.name || '',
        type: t.type, bearing: t.bearing, acct: t.acct, qty, cost,
        cogsCandidate: Math.round(qty * cost * 100) / 100,
      };
    });
    invoiceDetail.push({ id: inv.id, date: inv.date, total: inv.total, lines });
  }

  // Inventory transactions for bearing items: seed adjustments
  const bearingIds = new Set(items.filter((i) => norm.isInventoryBearingItem(i)).map((i) => String(i.id)));
  const bearingTx = txns.filter((t) => bearingIds.has(String(t.itemId))).map((t) => ({
    id: t.id, date: t.date, type: t.type, itemId: t.itemId, qty: t.quantity, ref: t.referenceId, wh: t.warehouseId, notes: t.notes,
  }));
  const seedTx = bearingTx.filter((t) => Number(t.qty) >= 500 && Number(t.qty) <= 500);
  const refBuckets = {};
  for (const t of bearingTx) { const k = String(t.ref || '(none)'); refBuckets[k] = refBuckets[k] || { n: 0, qty: 0, types: {} }; refBuckets[k].n++; refBuckets[k].qty += Number(t.qty) || 0; refBuckets[k].types[t.type] = (refBuckets[k].types[t.type] || 0) + 1; }

  return { invoiceDetail, bearingTxCount: bearingTx.length, seed500Count: seedTx.length, seed500Sample: seedTx.slice(0, 5), bearingTxSample: bearingTx.slice(0, 60), refBuckets };
});
fs.writeFileSync('verify-artifacts/recon-invoices.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.invoiceDetail, null, 1));
console.log('--- bearingTxCount', out.bearingTxCount, 'seed500Count', out.seed500Count);
console.log('--- refBuckets', JSON.stringify(out.refBuckets));
console.log('--- bearingTxSample');
for (const t of out.bearingTxSample) console.log([t.date, String(t.type).padEnd(11), String(t.itemId).padEnd(16), String(t.qty).padEnd(8), String(t.ref||'').padEnd(20), t.notes||''].join(' | '));
process.exit(0);

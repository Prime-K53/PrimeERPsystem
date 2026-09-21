/** Read-only characterisation of the Smart Stock adjustment provenance. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const norm = await import('/utils/inventoryNormalization.ts');

  const inventory = await dbService.getAll('inventory');
  const invTxns = await dbService.getAll('inventoryTransactions');

  const isSmart = (t) =>
    /smart\s*stock/i.test(String(t.notes ?? t.reason ?? t.description ?? ''));
  const rows = invTxns.filter(isSmart);
  const adds = rows.filter((t) => Number(t.quantity) > 0);

  const included = inventory.filter((i) => norm.classifyInventoryItem(i).included);
  const includedIds = new Set(included.map((i) => String(i.id)));

  const perItem = {};
  for (const t of adds) {
    const k = String(t.itemId);
    perItem[k] = perItem[k] || { units: 0, rows: 0, types: new Set() };
    perItem[k].units += Number(t.quantity || 0);
    perItem[k].rows += 1;
    perItem[k].types.add(String(t.type));
  }

  const fieldNames = [...new Set(rows.flatMap((r) => Object.keys(r)))].sort();

  return {
    totalInventoryTransactions: invTxns.length,
    smartStockRows: rows.length,
    smartStockAddRows: adds.length,
    smartStockAddUnits: adds.reduce((s, t) => s + Number(t.quantity || 0), 0),
    distinctItemsAdjusted: Object.keys(perItem).length,
    adjustedItemsThatAreInventoryBearing: Object.keys(perItem).filter((id) => includedIds.has(id)).length,
    adjustedItemsNotInventoryBearing: Object.keys(perItem).filter((id) => !includedIds.has(id)).slice(0, 20),
    eachAdjustedBy500: Object.values(perItem).every((v) => v.units === 500),
    sampleRow: rows[0] ? Object.fromEntries(Object.entries(rows[0])) : null,
    fieldNames,
    typeBreakdown: adds.reduce((acc, t) => { acc[String(t.type)] = (acc[String(t.type)] || 0) + 1; return acc; }, {}),
    referenceBreakdown: adds.reduce((acc, t) => { const k = String(t.referenceId ?? '(none)'); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    notesBreakdown: adds.reduce((acc, t) => { const k = String(t.notes ?? '(none)'); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    dateRange: {
      earliest: rows.map((r) => String(r.date ?? r.timestamp ?? '')).filter(Boolean).sort()[0] ?? null,
      latest: rows.map((r) => String(r.date ?? r.timestamp ?? '')).filter(Boolean).sort().pop() ?? null,
    },
    warehouseBreakdown: adds.reduce((acc, t) => { const k = String(t.warehouseId ?? t.warehouse ?? '(none)'); acc[k] = (acc[k] || 0) + 1; return acc; }, {}),
    bearingItemSmartStockRows: adds.filter((t) => includedIds.has(String(t.itemId))).length,
    bearingItemSmartStockUnits: adds.filter((t) => includedIds.has(String(t.itemId))).reduce((s, t) => s + Number(t.quantity || 0), 0),
  };
});

fs.writeFileSync('verify-artifacts/matinv-smartstock.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

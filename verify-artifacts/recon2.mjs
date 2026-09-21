import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const norm = await import('/utils/inventoryNormalization.ts');
  const items = await dbService.getAll('inventory');
  const txns = await dbService.getAll('inventoryTransactions');
  const accounts = await dbService.getAll('accounts');
  const ledger = await dbService.getAll('ledger');
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  const bearing = items.map(norm.classifyInventoryItem).filter((c) => c.included);
  const bearingById = {};
  for (const c of bearing) bearingById[c.itemId] = c;

  const detail = bearing.map((c) => ({
    id: c.itemId, name: c.name, type: c.rawType, qty: c.quantity, whQty: c.warehouseQuantity,
    unitCost: c.costPerUnit, value: c.inventoryValue, account: c.expectedAccount,
  }));

  const bearingTx = txns.filter((t) => bearingById[String(t.itemId)]);
  const txList = bearingTx.map((t) => ({ id: t.id, date: t.date, type: t.type, itemId: t.itemId, qty: Number(t.quantity) || 0, ref: t.referenceId, wh: t.warehouseId, notes: t.notes }));

  const addTx = txList.filter((t) => /smart stock/i.test(String(t.ref) + String(t.notes)) || t.type === 'ADJUSTMENT');
  const outTx = txList.filter((t) => t.type === 'OUT');
  const addQty = round2(addTx.reduce((s, t) => s + t.qty, 0));
  const outQty = round2(outTx.reduce((s, t) => s + t.qty, 0));
  const outValue = round2(outTx.reduce((s, t) => s + t.qty * (bearingById[String(t.itemId)]?.costPerUnit || 0), 0));
  const addValue = round2(addTx.reduce((s, t) => s + t.qty * (bearingById[String(t.itemId)]?.costPerUnit || 0), 0));

  const dates = txList.map((t) => t.date).filter(Boolean).sort();
  const addDates = addTx.map((t) => t.date).filter(Boolean).sort();
  const outDates = outTx.map((t) => t.date).filter(Boolean).sort();

  // per-item pre-seed reconstruction: current = pre + ADD - OUT  => pre = current - ADD + OUT
  const perItem = bearing.map((c) => {
    const its = txList.filter((t) => String(t.itemId) === c.itemId);
    const add = round2(its.filter((t) => t.type === 'ADJUSTMENT').reduce((s, t) => s + t.qty, 0));
    const out = round2(its.filter((t) => t.type === 'OUT').reduce((s, t) => s + t.qty, 0));
    return { id: c.itemId, name: c.name, current: c.quantity, add, out, reconstructedPre: round2(c.quantity - add - out), nTx: its.length };
  });

  // 11420 ledger entries
  const idToCode = {};
  for (const a of accounts) idToCode[String(a.id)] = String(a.account_number ?? a.code ?? '');
  const led11420 = ledger.filter((e) => idToCode[String(e.creditAccountId)] === '11420' || idToCode[String(e.debitAccountId)] === '11420')
    .map((e) => ({ id: e.id, date: e.date, amount: round2(e.amount), ref: e.referenceId, dr: idToCode[String(e.debitAccountId)], cr: idToCode[String(e.creditAccountId)], desc: e.description }));

  // item record dates for bearing items
  const itemDates = items.filter((i) => bearingById[String(i.id)]).map((i) => ({ id: i.id, created: i.created_at, updated: i.updated_at }));

  return {
    bearingCount: detail.length,
    detail,
    totalQty: round2(detail.reduce((s, d) => s + d.qty, 0)),
    totalValue: round2(detail.reduce((s, d) => s + d.value, 0)),
    txCount: txList.length,
    addCount: addTx.length, addQty, addValue,
    outCount: outTx.length, outQty, outValue: round2(outValue),
    dateRange: { min: dates[0], max: dates[dates.length - 1] },
    addDateRange: { min: addDates[0], max: addDates[addDates.length - 1] },
    outDateRange: { min: outDates[0], max: outDates[outDates.length - 1] },
    addRefs: [...new Set(addTx.map((t) => t.ref))],
    addNotes: [...new Set(addTx.map((t) => t.notes))].slice(0, 5),
    addSample: addTx.slice(0, 6),
    outSample: outTx.slice(0, 6),
    perItem,
    led11420,
    led11420Total: round2(led11420.reduce((s, e) => s + e.amount, 0)),
    itemDates: itemDates.slice(0, 5),
  };
});
fs.writeFileSync('verify-artifacts/recon2.json', JSON.stringify(out, null, 1));

console.log('bearing', out.bearingCount, 'totalQty', out.totalQty, 'totalValue', out.totalValue);
console.log('tx count', out.txCount, '| ADD', out.addCount, 'qty', out.addQty, 'value', out.addValue, '| OUT', out.outCount, 'qty', out.outQty, 'value', out.outValue);
console.log('dateRange', JSON.stringify(out.dateRange));
console.log('addDateRange', JSON.stringify(out.addDateRange), 'outDateRange', JSON.stringify(out.outDateRange));
console.log('addRefs', JSON.stringify(out.addRefs));
console.log('addNotes', JSON.stringify(out.addNotes));
console.log('addSample', JSON.stringify(out.addSample));
console.log('11420 ledger total', out.led11420Total, 'entries', out.led11420.length);
console.log('perItem:'); for (const p of out.perItem) console.log(' ', JSON.stringify(p));
process.exit(0);

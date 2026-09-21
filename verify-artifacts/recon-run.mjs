import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const { computeOwnBalances } = await import('/services/accountingEngine.ts');
  const norm = await import('/utils/inventoryNormalization.ts');
  const recovery = await import('/services/inventoryRecoveryService.ts');
  const smart = await import('/services/smartStockIncidentService.ts');

  const items = await dbService.getAll('inventory');
  const accounts = await dbService.getAll('accounts');
  const ledger = await dbService.getAll('ledger');
  const warehouseInventory = await dbService.getAll('warehouseInventory');
  const inventoryTransactions = await dbService.getAll('inventoryTransactions');
  const invoices = await dbService.getAll('invoices');

  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  const codeOf = (a) => String(a.account_number ?? a.code ?? '');
  const byCode = {};
  for (const a of accounts) byCode[codeOf(a)] = a;
  const idToCode = {};
  for (const a of accounts) idToCode[String(a.id)] = codeOf(a);

  const own = computeOwnBalances(accounts, ledger);
  const ownByCode = {};
  for (const a of accounts) {
    const c = codeOf(a);
    if (['11400', '11410', '11420', '11430', '51200'].includes(c)) ownByCode[c] = round2(own[String(a.id)] || 0);
  }

  // Ledger entries touching inventory accounts (resolve both sides to codes)
  const INV = new Set(['11400', '11410', '11420', '11430']);
  const ledgerInv = [];
  for (const e of ledger) {
    const dCode = idToCode[String(e.debitAccountId)] || String(e.debitAccountId);
    const cCode = idToCode[String(e.creditAccountId)] || String(e.creditAccountId);
    if (INV.has(dCode) || INV.has(cCode)) {
      ledgerInv.push({
        id: e.id, date: e.date, amount: round2(e.amount),
        description: e.description, referenceId: e.referenceId,
        customerId: e.customerId, customerName: e.customerName,
        debit: dCode, credit: cCode,
      });
    }
  }

  // Full ledger with resolved codes (for bridge)
  const ledgerAll = ledger.map((e) => ({
    id: e.id, date: e.date, amount: round2(e.amount), description: e.description, referenceId: e.referenceId,
    debit: idToCode[String(e.debitAccountId)] || String(e.debitAccountId),
    credit: idToCode[String(e.creditAccountId)] || String(e.creditAccountId),
  }));

  // Inventory classification
  const classified = items.map(norm.classifyInventoryItem);
  const typeBuckets = {};
  for (const it of items) {
    const t = String(it._rawType ?? it.type ?? '(none)');
    typeBuckets[t] = (typeBuckets[t] || 0) + 1;
  }
  const bearing = classified.filter((c) => c.included);
  const byAccount = { '11410': { qty: 0, whQty: 0, value: 0, n: 0 }, '11420': { qty: 0, whQty: 0, value: 0, n: 0 }, '11430': { qty: 0, whQty: 0, value: 0, n: 0 } };
  for (const c of bearing) {
    const b = byAccount[c.expectedAccount];
    if (b) { b.qty = round2(b.qty + c.quantity); b.whQty = round2(b.whQty + c.warehouseQuantity); b.value = round2(b.value + c.inventoryValue); b.n++; }
  }
  const negative = classified.filter((c) => c.quantity < 0).map((c) => ({ id: c.itemId, name: c.name, type: c.rawType, qty: c.quantity, cost: c.costPerUnit }));

  const valuation = norm.reconcileInventoryValuation(items, accounts, ledger);
  const smartReport = smart.analyzeSmartStockIncident(items);
  const recoveryReport = recovery.buildInventoryRecoveryReport(items, accounts, ledger, warehouseInventory, inventoryTransactions);

  // inventoryTransactions distribution
  const txTypes = {};
  for (const t of inventoryTransactions) txTypes[String(t.type)] = (txTypes[String(t.type)] || 0) + 1;
  const txByRef = {};
  for (const t of inventoryTransactions) {
    const r = String(t.referenceId || '');
    txByRef[r] = txByRef[r] || { n: 0, qty: 0 };
    txByRef[r].n++; txByRef[r].qty = round2(txByRef[r].qty + (Number(t.quantity) || 0));
  }

  // Invoices of interest
  const invOfInterest = invoices
    .filter((i) => /021|022|023|024|025/.test(String(i.id || '')) || /INV-P726/.test(String(i.id || '')))
    .map((i) => ({ id: i.id, date: i.date, status: i.status, total: round2(i.total), itemCount: Array.isArray(i.items) ? i.items.length : 0 }));

  return {
    ownByCode, typeBuckets,
    classifiedCounts: {
      total: classified.length, included: bearing.length,
      excludedByReason: valuation.excludedByReason,
    },
    byAccount, negative,
    valuation: {
      totalInventoryValue: valuation.totalInventoryValue,
      glInventoryByAccount: valuation.glInventoryByAccount,
      glInventoryTotal: valuation.glInventoryTotal,
      difference: valuation.difference,
    },
    bearingItems: bearing.map((c) => ({ id: c.itemId, name: c.name, type: c.rawType, acct: c.expectedAccount, qty: c.quantity, whQty: c.warehouseQuantity, cost: c.costPerUnit, value: c.inventoryValue })),
    ledgerInv, ledgerAll,
    smart: {
      bulkId: smartReport.bulkId, totalAffected: smartReport.totalAffected,
      inventoryBearingCount: smartReport.inventoryBearingCount, nonInventoryBearingCount: smartReport.nonInventoryBearingCount,
      totalSeedQuantity: smartReport.totalSeedQuantity, totalCurrentQuantity: smartReport.totalCurrentQuantity,
      totalCurrentValue: smartReport.totalCurrentValue, unrecoverableQuantityCount: smartReport.unrecoverableQuantityCount,
      affected: smartReport.affectedItems.map((i) => ({ id: i.itemId, name: i.name, type: i.type, bearing: i.isInventoryBearing, acct: i.inventoryAccount, before: i.quantityBeforeSeeding, seed: i.seedQuantity, mov: i.subsequentMovements, qty: i.currentQuantity, whQty: i.currentWarehouseQuantity, cost: resolveCostSafe(i) })),
    },
    recovery: {
      accountReconciliations: recoveryReport.accountReconciliations,
      recoverabilitySummary: recoveryReport.recoverabilitySummary,
      recommendedRecoveryModel: recoveryReport.recommendedRecoveryModel,
      totalCurrentSystemValue: recoveryReport.totalCurrentSystemValue,
      totalCurrentWarehouseValue: recoveryReport.totalCurrentWarehouseValue,
    },
    txTypes, txByRef, txCount: inventoryTransactions.length,
    whInvCount: warehouseInventory.length,
    invOfInterest,
    accountsInv: accounts.filter((a) => ['11400', '11410', '11420', '11430', '51200'].includes(codeOf(a))).map((a) => ({ id: a.id, code: codeOf(a), name: a.name, type: a.account_type || a.type, group: a.account_group, normal: a.normal_balance, parent: a.parent_account_id })),
  };

  function resolveCostSafe(i) {
    try { return norm.resolveInventoryCostPerUnit(i); } catch { return null; }
  }
});

fs.writeFileSync('verify-artifacts/recon.json', JSON.stringify(out, null, 1));
console.log('WROTE recon.json');
console.log('ownByCode:', JSON.stringify(out.ownByCode));
console.log('typeBuckets:', JSON.stringify(out.typeBuckets));
console.log('classified:', JSON.stringify(out.classifiedCounts));
console.log('byAccount:', JSON.stringify(out.byAccount));
console.log('negative:', JSON.stringify(out.negative));
console.log('valuation:', JSON.stringify(out.valuation));
console.log('smart:', JSON.stringify({ ...out.smart, affected: undefined }));
console.log('recovery accs:', JSON.stringify(out.recovery.accountReconciliations));
console.log('txTypes:', JSON.stringify(out.txTypes));
console.log('ledgerInv count:', out.ledgerInv.length);
console.log('invoices of interest:', JSON.stringify(out.invOfInterest));
process.exit(0);

/** Post-correction confirmation of untouched data + sync outbox provenance. */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const preflight = JSON.parse(fs.readFileSync('verify-artifacts/matinv-preflight.json', 'utf8'));

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async (pre) => {
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');
  const norm = await import('/utils/inventoryNormalization.ts');

  const accounts = await dbService.getAll('accounts');
  const ledger = await dbService.getAll('ledger');
  const inventory = await dbService.getAll('inventory');
  const invTxns = await dbService.getAll('inventoryTransactions');
  const whInv = await dbService.getAll('warehouseInventory');
  const warehouses = await dbService.getAll('warehouses');

  // ── Smart Stock: inspect the real field names first ────────────────
  const txnFieldSample = invTxns.slice(0, 3).map((t) => Object.keys(t));
  const smartStock = invTxns.filter((t) => {
    const blob = [t.reason, t.description, t.reference, t.type, t.note, t.notes]
      .map((v) => String(v ?? '')).join(' ');
    return /smart\s*stock/i.test(blob);
  });
  const smartStockDetail = smartStock.map((t) => ({
    id: t.id, itemId: t.itemId, type: t.type, quantity: t.quantity,
    previousQuantity: t.previousQuantity, newQuantity: t.newQuantity,
    reference: t.reference ?? null, reason: t.reason ?? null,
    timestamp: t.timestamp ?? null, performedBy: t.performedBy ?? null, unitCost: t.unitCost ?? null,
  }));

  // ── Authoritative inventory-bearing classification ────────────────
  const classified = inventory.map((i) => ({ item: i, c: norm.classifyInventoryItem(i) }));
  const included = classified.filter((x) => x.c.included);
  const excludedReasons = {};
  for (const x of classified) {
    if (!x.c.included) excludedReasons[x.c.exclusionReason || 'OTHER'] = (excludedReasons[x.c.exclusionReason || 'OTHER'] || 0) + 1;
  }
  const bearingValue = included.reduce(
    (s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0), 0
  );
  const bearingUnits = included.reduce((s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0), 0);
  const byAccount = {};
  for (const x of included) {
    const code = norm.resolveInventoryGLAccountCode(x.item) || 'UNMAPPED';
    byAccount[code] = byAccount[code] || { items: 0, units: 0, value: 0 };
    byAccount[code].items += 1;
    byAccount[code].units += Number(norm.resolveInventoryQuantity(x.item) || 0);
    byAccount[code].value += Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0);
  }
  const allAt500 = included.every((x) => Number(norm.resolveInventoryQuantity(x.item)) === 500);

  // ── Durable sync outbox ───────────────────────────────────────────
  const queue = await new Promise((resolve) => {
    const req = indexedDB.open('PrimeERP_DurableSyncQueue');
    req.onerror = () => resolve([]);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('operations')) { db.close(); return resolve([]); }
      const tx = db.transaction('operations', 'readonly');
      const all = tx.objectStore('operations').getAll();
      all.onsuccess = () => { const r = all.result || []; db.close(); resolve(r); };
      all.onerror = () => { db.close(); resolve([]); };
    };
  });
  const correctionOps = queue
    .filter((op) => /CORR-MATINV|MIC-/.test(JSON.stringify(op.payload || {})) || /CORR-MATINV/.test(String(op.recordId || '')))
    .map((op) => ({ table: op.table, recordId: op.recordId, operation: op.operation, status: op.status, createdAt: op.createdAt ?? null }));
  const queueByTable = {};
  for (const op of queue) {
    const k = `${op.table}:${op.status}`;
    queueByTable[k] = (queueByTable[k] || 0) + 1;
  }

  // ── Correction rows + immutability of the original ────────────────
  const correctionRows = ledger.filter((e) => e.entryType === 'material_inventory_correction');
  const duplicateNow = ledger.find((e) => e.id === pre.duplicate.id) || null;
  const duplicateUnchanged = !!duplicateNow && JSON.stringify({
    id: duplicateNow.id, date: duplicateNow.date, amount: duplicateNow.amount,
    description: duplicateNow.description, debitAccountId: duplicateNow.debitAccountId,
    creditAccountId: duplicateNow.creditAccountId, referenceId: duplicateNow.referenceId,
    reconciled: duplicateNow.reconciled, createdAt: duplicateNow.created_at ?? duplicateNow.createdAt ?? null,
  }) === JSON.stringify(pre.duplicate);

  const own = engine.computeOwnBalances(accounts, ledger);
  const roll = engine.computeHierarchicalRollup(accounts, own);

  return {
    smartStockCount: smartStock.length,
    smartStockDetail,
    txnFieldSample,
    inventory: {
      totalRecords: inventory.length,
      includedCount: included.length,
      excludedReasons,
      bearingUnits,
      bearingValue,
      byAccount,
      everyIncludedItemAt500Units: allAt500,
      warehouseInventoryCount: whInv.length,
      warehouseCount: warehouses.length,
      warehousesWithStock: warehouses.filter((w) => Number(w.stock ?? 0) !== 0).length,
    },
    correctionRows: correctionRows.map((e) => ({
      id: e.id, date: e.date, amount: e.amount, dr: e.debitAccountId, cr: e.creditAccountId,
      referenceId: e.referenceId, entryType: e.entryType, referenceType: e.referenceType,
      status: e.status, reversesEntryId: e.reversesEntryId ?? null,
    })),
    ledgerRowCount: ledger.length,
    accountsReferencedByCorrection: [...new Set(correctionRows.flatMap((e) => [e.debitAccountId, e.creditAccountId]))],
    duplicateUnchanged,
    balances11400: { own: own['ACC-11400'] ?? null, rollup: roll['ACC-11400'] ?? null },
    queueOpsTotal: queue.length,
    queueByTable,
    correctionOps,
  };
}, preflight);

fs.writeFileSync('verify-artifacts/matinv-confirm.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

/**
 * Final confirmation. dbService.put stamps every written record with
 * _updatedAt, so a row's _updatedAt proves whether the correction wrote to it.
 */
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

  const correctionRows = ledger.filter((e) => e.entryType === 'material_inventory_correction');
  const cutoff = correctionRows
    .map((e) => String(e._updatedAt ?? e.updatedAt ?? ''))
    .sort()[0] || '';
  // Allow a small skew: treat anything stamped at/after 1 minute before the
  // correction as "written by this correction".
  const cutoffMs = Date.parse(cutoff) - 60_000;

  const stamped = (rows) => rows.filter((r) => {
    const t = Date.parse(String(r._updatedAt ?? r.updatedAt ?? ''));
    return Number.isFinite(t) && t >= cutoffMs;
  });

  const maxStamp = (rows) => rows
    .map((r) => String(r._updatedAt ?? r.updatedAt ?? ''))
    .filter(Boolean)
    .sort()
    .pop() || null;

  const smartStock = invTxns.filter((t) => {
    const blob = [t.reason, t.description, t.reference, t.note, t.notes]
      .map((v) => String(v ?? '')).join(' ');
    return /smart\s*stock/i.test(blob);
  });

  const classified = inventory.map((i) => ({ item: i, c: norm.classifyInventoryItem(i) }));
  const included = classified.filter((x) => x.c.included);
  const excludedReasons = {};
  for (const x of classified) {
    if (!x.c.included) {
      const k = x.c.exclusionReason || 'OTHER';
      excludedReasons[k] = (excludedReasons[k] || 0) + 1;
    }
  }
  const byAccount = {};
  for (const x of included) {
    const code = norm.resolveInventoryGLAccountCode(x.item) || 'UNMAPPED';
    byAccount[code] = byAccount[code] || { items: 0, units: 0, value: 0 };
    const q = Number(norm.resolveInventoryQuantity(x.item) || 0);
    const c = Number(norm.resolveInventoryCostPerUnit(x.item) || 0);
    byAccount[code].items += 1;
    byAccount[code].units += q;
    byAccount[code].value += q * c;
  }
  const bearingValue = included.reduce((s, x) =>
    s + Number(norm.resolveInventoryQuantity(x.item) || 0) * Number(norm.resolveInventoryCostPerUnit(x.item) || 0), 0);

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
  const queueByTable = {};
  for (const op of queue) {
    const k = `${op.table}:${op.status}`;
    queueByTable[k] = (queueByTable[k] || 0) + 1;
  }
  const correctionOps = queue
    .filter((op) => /CORR-MATINV/.test(JSON.stringify(op.payload || {})) || /CORR-MATINV/.test(String(op.recordId || '')))
    .map((op) => ({ table: op.table, recordId: op.recordId, operation: op.operation, status: op.status }));

  const duplicateNow = ledger.find((e) => e.id === pre.duplicate.id) || null;
  const duplicateUnchanged = !!duplicateNow && JSON.stringify({
    id: duplicateNow.id, date: duplicateNow.date, amount: duplicateNow.amount,
    description: duplicateNow.description, debitAccountId: duplicateNow.debitAccountId,
    creditAccountId: duplicateNow.creditAccountId, referenceId: duplicateNow.referenceId,
    reconciled: duplicateNow.reconciled, createdAt: duplicateNow.created_at ?? duplicateNow.createdAt ?? null,
  }) === JSON.stringify(pre.duplicate);

  const own = engine.computeOwnBalances(accounts, ledger);
  const roll = engine.computeHierarchicalRollup(accounts, own);
  const trial = engine.computeTrialBalance(accounts, ledger);

  return {
    correctionCutoff: cutoff,
    ledgerRowCount: { before: pre.ledgerCount, now: ledger.length },
    correctionRows: correctionRows.map((e) => ({
      id: e.id, date: e.date, amount: e.amount, dr: e.debitAccountId, cr: e.creditAccountId,
      referenceId: e.referenceId, entryType: e.entryType, referenceType: e.referenceType,
      status: e.status, reversesEntryId: e.reversesEntryId ?? null, _updatedAt: e._updatedAt ?? null,
    })),
    ledgerRowCountStampedAtCorrection: stamped(ledger).length,
    // Rows in these stores stamped at the correction time = written by it.
    inventoryRowsStampedAtCorrection: stamped(inventory).length,
    inventoryTxnRowsStampedAtCorrection: stamped(invTxns).length,
    warehouseInvRowsStampedAtCorrection: stamped(whInv).length,
    warehouseRowsStampedAtCorrection: stamped(warehouses).length,
    maxUpdatedAt: {
      inventoryTransactions: maxStamp(invTxns),
      inventory: maxStamp(inventory),
      warehouseInventory: maxStamp(whInv),
      warehouses: maxStamp(warehouses),
      ledger: maxStamp(ledger),
    },
    counts: {
      inventory: inventory.length,
      inventoryTransactions: invTxns.length,
      smartStockRows: smartStock.length,
      smartStockUnits: smartStock.reduce((s, t) => s + Number(t.quantity || 0), 0),
      warehouseInventory: whInv.length,
      warehouses: warehouses.length,
    },
    inventoryBearing: {
      includedCount: included.length,
      excludedReasons,
      units: included.reduce((s, x) => s + Number(norm.resolveInventoryQuantity(x.item) || 0), 0),
      value: bearingValue,
      byAccount,
      everyIncludedItemAt500Units: included.every((x) => Number(norm.resolveInventoryQuantity(x.item)) === 500),
    },
    duplicateUnchanged,
    balances: {
      i11410: own['ACC-11410'] ?? null,
      i11420: own['ACC-11420'] ?? null,
      i11430: own['ACC-11430'] ?? null,
      i11400rollup: roll['ACC-11400'] ?? null,
      eq32000: own['ACC-32000'] ?? null,
      cogs51200: own['ACC-51200'] ?? null,
    },
    trial: { debits: trial.totalDebits, credits: trial.totalCredits, difference: trial.difference, balanced: trial.isBalanced },
    queueOpsTotal: queue.length,
    queueByTable,
    correctionOpsInOutbox: correctionOps,
  };
}, preflight);

fs.writeFileSync('verify-artifacts/matinv-final.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

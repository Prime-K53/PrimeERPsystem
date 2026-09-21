/**
 * LIVE execution + post-write verification of the approved 11420 correction.
 * Runs inside the app page so the correction goes through the app's own
 * ledger write path (dbService.put -> IndexedDB + durable sync outbox).
 *
 * Read-only work first (K350,000 pre-existing trial-balance trace), then the
 * approved correction, then verification, then an idempotency re-run.
 */
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));
if (!page) { console.error('NO ERP PAGE FOUND'); process.exit(2); }
console.log('page =', page.url());

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const engine = await import('/services/accountingEngine.ts');
  const svc = await import('/services/materialInventoryCorrectionService.ts');

  const load = async () => ({
    accounts: await dbService.getAll('accounts'),
    ledger: await dbService.getAll('ledger'),
    inventory: await dbService.getAll('inventory'),
    invTxns: await dbService.getAll('inventoryTransactions'),
    warehouses: await dbService.getAll('warehouses'),
    whInv: await dbService.getAll('warehouseInventory'),
  });

  const findAcct = (accounts, ref) =>
    accounts.find((a) => a.id === ref || a.code === ref || a.account_number === ref) || null;

  const balancesOf = (accounts, ledger) => {
    const own = engine.computeOwnBalances(accounts, ledger);
    const roll = engine.computeHierarchicalRollup(accounts, own);
    const pick = (code) => {
      const a = findAcct(accounts, code);
      return a ? { id: a.id, own: own[a.id] ?? 0, rollup: roll[a.id] ?? 0 } : null;
    };
    return {
      b11400: pick('11400'), b11410: pick('11410'), b11420: pick('11420'),
      b11430: pick('11430'), b32000: pick('32000'), b51200: pick('51200'),
    };
  };

  const loadQueue = () =>
    new Promise((resolve) => {
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

  const fingerprint = (rows, fields) =>
    rows
      .map((r) => fields.map((f) => String(r[f] ?? '')).join(':') + ':' + String(r.amount ?? ''))
      .sort()
      .join('|');

  // ── BEFORE ────────────────────────────────────────────────────────
  const before = await load();
  const balBefore = balancesOf(before.accounts, before.ledger);
  const trialBefore = engine.computeTrialBalance(before.accounts, before.ledger);

  // Read-only: root cause of the pre-existing trial-balance imbalance.
  const unresolved = before.ledger.map((e) => {
    const d = findAcct(before.accounts, e.debitAccountId);
    const c = findAcct(before.accounts, e.creditAccountId);
    return {
      id: e.id, date: e.date, amount: Number(e.amount || 0),
      debitAccountId: e.debitAccountId, debitResolves: !!d,
      creditAccountId: e.creditAccountId, creditResolves: !!c,
      referenceId: e.referenceId, entryType: e.entryType ?? null, status: e.status ?? null,
    };
  }).filter((r) => !r.debitResolves || !r.creditResolves);

  const missingDebits = unresolved.filter((r) => !r.debitResolves).reduce((s, r) => s + r.amount, 0);
  const missingCredits = unresolved.filter((r) => !r.creditResolves).reduce((s, r) => s + r.amount, 0);
  const noAmount = before.ledger.filter((e) => !Number.isFinite(Number(e.amount))).map((e) => e.id);

  const smartStockBefore = before.invTxns
    .filter((t) => /smart\s*stock/i.test(String(t.reason || t.description || '')))
    .map((t) => ({ id: t.id, itemId: t.itemId, quantity: t.quantity, previousQuantity: t.previousQuantity, newQuantity: t.newQuantity, type: t.type }));
  const smartStockFingerprint = fingerprint(smartStockBefore, ['id', 'itemId', 'quantity', 'previousQuantity', 'newQuantity']);
  const inventoryFingerprint = fingerprint(
    before.inventory.map((i) => ({ id: i.id, stock: i.stock, cost: i.cost ?? i.cost_price })), ['id', 'stock', 'cost']
  );

  // ── PREVIEW (no writes) ───────────────────────────────────────────
  const preview = svc.previewMaterialInventoryCorrection(before.ledger, before.accounts);

  // ── APPLY ─────────────────────────────────────────────────────────
  const applyResult = await svc.applyMaterialInventoryCorrection({
    confirmed: true,
    reason:
      'Approved material-inventory correction: reverse duplicate INV-P726/031 COGS leg K187,600 and capitalise verified 11420 material inventory (K1,687,500 opening + K222,500,000 verified stock) against 32000. Accountant-approved; Smart Stock and 11410 left untouched.',
  });

  const after = await load();
  const balAfter = balancesOf(after.accounts, after.ledger);
  const trialAfter = engine.computeTrialBalance(after.accounts, after.ledger);

  const createdRows = after.ledger.filter((e) => String(e.referenceId || '').startsWith('CORR-MATINV-'));
  const queueOps = (await loadQueue()).filter((op) =>
    op.table === 'ledger' && String(op.recordId || '').includes('MIC')
  );

  // ── IDEMPOTENCY RE-RUN ────────────────────────────────────────────
  const second = await svc.applyMaterialInventoryCorrection({
    confirmed: true,
    reason: 'idempotency re-run verification',
  });
  const after2 = await load();
  const balAfter2 = balancesOf(after2.accounts, after2.ledger);

  const ledgerDelta = after2.ledger.length - after.ledger.length;

  const smartStockAfter = after2.invTxns
    .filter((t) => /smart\s*stock/i.test(String(t.reason || t.description || '')))
    .map((t) => ({ id: t.id, itemId: t.itemId, quantity: t.quantity, previousQuantity: t.previousQuantity, newQuantity: t.newQuantity, type: t.type }));
  const smartStockFingerprintAfter = fingerprint(smartStockAfter, ['id', 'itemId', 'quantity', 'previousQuantity', 'newQuantity']);
  const inventoryFingerprintAfter = fingerprint(
    after2.inventory.map((i) => ({ id: i.id, stock: i.stock, cost: i.cost ?? i.cost_price })), ['id', 'stock', 'cost']
  );

  // Operational material inventory valuation (authoritative stored cost).
  const materialItems = after2.inventory.filter(
    (i) => ['Stationery', 'Raw Material'].includes(String(i.type)) &&
      String(i.status || '').toLowerCase() !== 'deleted'
  );
  const operationalValue = materialItems.reduce(
    (s, i) => s + Number(i.stock || 0) * Number(i.cost ?? i.cost_price ?? 0), 0
  );
  const operationalUnits = materialItems.reduce((s, i) => s + Number(i.stock || 0), 0);

  return {
    ledgerCount: { before: before.ledger.length, after: after.ledger.length },
    counts: {
      inventory: before.inventory.length,
      warehouses: before.warehouses.length,
      warehouseInventory: before.whInv.length,
      inventoryTransactions: before.invTxns.length,
      smartStockRecords: smartStockBefore.length,
    },
    balances: { before: balBefore, after: balAfter, after2: balAfter2 },
    trial: {
      before: { debits: trialBefore.totalDebits, credits: trialBefore.totalCredits, difference: trialBefore.difference, balanced: trialBefore.isBalanced },
      after: { debits: trialAfter.totalDebits, credits: trialAfter.totalCredits, difference: trialAfter.difference, balanced: trialAfter.isBalanced },
    },
    unresolvedLedgerRows: unresolved,
    missingDebits,
    missingCredits,
    ledgerRowsWithoutAmount: noAmount,
    preview: {
      failures: preview.failures,
      canApply: preview.canApply,
      proposed: preview.proposedEntries.map((e) => ({ component: e.component, id: e.id, date: e.date, amount: e.amount, debitAccountId: e.debitAccountId, creditAccountId: e.creditAccountId, referenceId: e.referenceId })),
      proposedCapitalisationTotal: preview.proposedCapitalisationTotal,
      proposedTotalDebit11420: preview.proposedTotalDebit11420,
    },
    applyResult: {
      status: applyResult.status,
      wroteOutOfScopeData: applyResult.wroteOutOfScopeData,
      reversal: applyResult.reversal,
      capitalisation: applyResult.capitalisation,
      capitalisationDebit11420: applyResult.capitalisationDebit11420,
      totalDebit11420: applyResult.totalDebit11420,
      failures: applyResult.failures,
    },
    createdRows: createdRows.map((e) => ({
      id: e.id, date: e.date, amount: e.amount, debitAccountId: e.debitAccountId,
      creditAccountId: e.creditAccountId, referenceId: e.referenceId,
      referenceType: e.referenceType, entryType: e.entryType, status: e.status,
      reversesEntryId: e.reversesEntryId ?? null, idempotencyKey: e.idempotencyKey ?? null,
      appliedBy: e.appliedBy ?? null, applyReason: e.applyReason ?? null,
    })),
    duplicateRowStillPresent: after2.ledger.some((e) => e.id === 'LG-COGS-1789787524516-mcpj3jfhj'),
    reversalsOfDuplicate: after2.ledger.filter((e) => e.reversesEntryId === 'LG-COGS-1789787524516-mcpj3jfhj').map((e) => e.id),
    queueOpsForLedger: queueOps.map((op) => ({ table: op.table, recordId: op.recordId, operation: op.operation, status: op.status })),
    idempotency: { secondStatus: second.status, secondTotalDebit11420: second.totalDebit11420, ledgerDeltaOnReRun: ledgerDelta },
    untouched: {
      inventoryFingerprintEqual: inventoryFingerprint === inventoryFingerprintAfter,
      smartStockFingerprintEqual: smartStockFingerprint === smartStockFingerprintAfter,
    },
    operationalMaterialInventory: { units: operationalUnits, value: operationalValue, items: materialItems.length },
  };
});

fs.writeFileSync('verify-artifacts/matinv-execute.json', JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(0);

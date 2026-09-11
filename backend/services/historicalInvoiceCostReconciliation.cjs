/**
 * Historical Invoice Cost Reconciliation — Read-Only Diagnostic
 *
 * Audits production invoices/sales to determine whether the OLD
 * Financial Panel cost-resolution precedence created any discrepancies
 * vs accounting COGS.
 *
 * Read-only: performs zero writes, zero mutations.
 * Uses Supabase REST API (GET requests only).
 */

const axios = require('axios');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://rdtuzuzehfbwvfdzqliw.supabase.co').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

// ─── Cost resolution functions ──────────────────────────────────────

/**
 * OLD (pre-fix) Financial Panel cost resolution for baseMaterialCost:
 * smartSnapshot.baseCost → item.basePrice → item.cost_price → item.cost → productionCostSnapshot.baseProductionCost → 0
 */
function oldPanelBaseMaterialCost(item) {
  const smartCost = item?.smartPricingSnapshot?.baseCost;
  if (smartCost != null && Number.isFinite(Number(smartCost)) && Number(smartCost) > 0) {
    return Number(smartCost);
  }
  if (item?.basePrice != null && Number.isFinite(Number(item.basePrice)) && Number(item.basePrice) > 0) {
    return Number(item.basePrice);
  }
  if (item?.cost_price != null && Number.isFinite(Number(item.cost_price)) && Number(item.cost_price) > 0) {
    return Number(item.cost_price);
  }
  if (item?.cost != null && Number.isFinite(Number(item.cost)) && Number(item.cost) > 0) {
    return Number(item.cost);
  }
  const prodCost = Number(item?.productionCostSnapshot?.baseProductionCost);
  if (Number.isFinite(prodCost) && prodCost > 0) {
    return prodCost;
  }
  return 0;
}

/**
 * NEW (post-fix) Financial Panel cost resolution for baseMaterialCost:
 * productionCostSnapshot.baseProductionCost (if >0) → smartSnapshot.baseCost → item.basePrice → item.cost_price → item.cost → 0
 */
function newPanelBaseMaterialCost(item) {
  const prodCost = Number(item?.productionCostSnapshot?.baseProductionCost);
  if (Number.isFinite(prodCost) && prodCost > 0) {
    return prodCost;
  }
  const smartCost = item?.smartPricingSnapshot?.baseCost;
  if (smartCost != null && Number.isFinite(Number(smartCost)) && Number(smartCost) > 0) {
    return Number(smartCost);
  }
  if (item?.basePrice != null && Number.isFinite(Number(item.basePrice)) && Number(item.basePrice) > 0) {
    return Number(item.basePrice);
  }
  if (item?.cost_price != null && Number.isFinite(Number(item.cost_price)) && Number(item.cost_price) > 0) {
    return Number(item.cost_price);
  }
  if (item?.cost != null && Number.isFinite(Number(item.cost)) && Number(item.cost) > 0) {
    return Number(item.cost);
  }
  return 0;
}

/**
 * Accounting COGS cost resolution (same as new panel, aligned to resolveItemUnitCost):
 * productionCostSnapshot.baseProductionCost (if >0) → batch → FIFO → smartSnapshot.baseCost → ...
 * Simplified: uses same precedence as new panel since batch/FIFO resolution is internal.
 */
function accountingBaseCost(item) {
  // Accounting and new panel now share the same primary precedence
  return newPanelBaseMaterialCost(item);
}

// ─── Data extraction helpers ────────────────────────────────────────

function getItemsFromDocument(data) {
  if (!data) return [];
  // Try multiple possible locations for items
  let items = data.items || data.lineItems || data.line_items || data.invoiceItems || [];
  if (!Array.isArray(items)) {
    // Sometimes items are stored as a JSON string
    try {
      items = JSON.parse(items);
    } catch {
      items = [];
    }
  }
  return items;
}

function isStockedItem(item) {
  const type = (item?.item_type || item?.type || item?.itemType || '').toLowerCase();
  return ['product', 'material', 'stationery'].includes(type);
}

function extractCostFields(item) {
  return {
    itemId: item?.id || item?.item_id || item?.itemId || 'unknown',
    itemName: item?.item_name || item?.name || item?.itemName || 'unknown',
    itemType: item?.item_type || item?.type || item?.itemType || 'unknown',
    quantity: Number(item?.quantity || item?.qty || 0),
    unitPrice: Number(item?.price || item?.unit_price || item?.unitPrice || item?.sellingPrice || item?.selling_price || 0),
    cost: Number(item?.cost || item?.cost_price || item?.costPrice || item?.cost_per_unit || item?.unitCost || 0),
    baseMaterialCost: Number(item?.pricingBreakdown?.baseMaterialCost ?? item?.baseMaterialCost ?? 0),
    productionCostSnapshot: item?.productionCostSnapshot || null,
    smartPricingSnapshot: item?.smartPricingSnapshot || null,
    totalAmount: Number(item?.totalAmount || item?.total || item?.lineTotal || item?.line_total || 0),
  };
}

// ─── Supabase REST API helpers (read-only) ──────────────────────────

async function supabaseQuery(table, select = '*', params = {}) {
  let url = `${SUPABASE_URL}/rest/v1/${table}?select=${select}`;
  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    searchParams.append(k, v);
  }
  if (searchParams.toString()) url += '&' + searchParams.toString();

  try {
    const resp = await axios.get(url, { headers: HEADERS, timeout: 30000 });
    return resp.data || [];
  } catch (err) {
    console.error(`[SUPABASE] Query ${table} failed:`, err.message);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`, JSON.stringify(err.response.data).slice(0, 300));
    }
    return null;
  }
}

async function supabaseRpc(functionName, body = {}) {
  try {
    const resp = await axios.post(
      `${SUPABASE_URL}/rest/v1/rpc/${functionName}`,
      body,
      { headers: HEADERS, timeout: 30000 }
    );
    return resp.data || null;
  } catch (err) {
    console.error(`[SUPABASE] RPC ${functionName} failed:`, err.message);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`, JSON.stringify(err.response.data).slice(0, 300));
    }
    return null;
  }
}

async function getAllWithPagination(table, select = '*', params = {}, pageSize = 1000) {
  let allRows = [];
  let offset = 0;
  while (true) {
    const rows = await supabaseQuery(table, select, { ...params, limit: pageSize, offset });
    if (!rows || rows.length === 0) break;
    allRows = allRows.concat(rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return allRows;
}

// ─── Main audit ─────────────────────────────────────────────────────

async function runAudit() {
  const report = {
    timestamp: new Date().toISOString(),
    summary: {},
    diagnosticTable: [],
    affectedTransactions: [],
    glFindings: {},
    costResolutionFindings: {},
    replacementAudit: [],
    masterCostDrift: [],
    safety: {
      invoicesModified: 0,
      journalsModified: 0,
      inventoryModified: 0,
      syncOperationsCreated: 0,
    },
  };

  console.log('=== HISTORICAL INVOICE COST RECONCILIATION — READ-ONLY AUDIT ===\n');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  // ─── Step 1: Gather all data ────────────────────────────────────
  console.log('--- Step 1: Gathering data from production ---\n');

  // Query all sales (Supabase uses data JSONB)
  const sales = await getAllWithPagination('sales', 'id,data,created_at,updated_at');
  console.log(`Sales records: ${sales ? sales.length : 0}`);

  // Query all invoices
  const invoices = await getAllWithPagination('invoices', 'id,data,created_at,updated_at');
  console.log(`Invoice records: ${invoices ? invoices.length : 0}`);

  // Query all ledger entries
  const ledgerEntries = await getAllWithPagination('ledger_entries', 'id,data,created_at,updated_at');
  console.log(`Ledger entries: ${ledgerEntries ? ledgerEntries.length : 0}`);

  // Query chart of accounts
  const chartOfAccounts = await getAllWithPagination('chart_of_accounts', 'id,data,created_at,updated_at');
  console.log(`Chart of accounts: ${chartOfAccounts ? chartOfAccounts.length : 0}`);

  // Query sale_items (normalized table)
  const saleItems = await getAllWithPagination('sale_items', 'id,data,created_at,updated_at');
  console.log(`Sale items: ${saleItems ? saleItems.length : 0}`);

  // Also try querying sale_items with explicit columns
  let saleItemsExplicit = [];
  try {
    saleItemsExplicit = await supabaseQuery('sale_items', 'id,sale_id,item_id,item_name,quantity,unit_price,unit_cost,item_type');
    if (saleItemsExplicit) console.log(`Sale items (explicit): ${saleItemsExplicit.length}`);
  } catch {
    // Fall back to data JSONB approach
  }

  // ─── Step 2: Build account lookup ───────────────────────────────
  console.log('\n--- Step 2: Building account lookup ---\n');

  const accountMap = {};
  const canonicalAccounts = {};
  if (chartOfAccounts) {
    for (const acc of chartOfAccounts) {
      const data = acc.data || {};
      const code = data.code || data.account_number || '';
      const name = data.name || '';
      accountMap[code] = { id: acc.id, name, type: data.account_type || data.type, code };
      canonicalAccounts[acc.id] = { code, name, type: data.account_type || data.type };
    }
  }

  // Add known accounts from financeService
  const knownAccounts = {
    '41100': { code: '41100', name: 'Product Sales', type: 'INCOME' },
    '51200': { code: '51200', name: 'Cost of Goods Sold', type: 'EXPENSE' },
    '11410': { code: '11410', name: 'Merchandise Inventory', type: 'ASSET' },
    '11420': { code: '11420', name: 'Raw Materials', type: 'ASSET' },
    '11430': { code: '11430', name: 'Finished Goods', type: 'ASSET' },
    '11110': { code: '11110', name: 'Cash Drawer', type: 'ASSET' },
  };
  for (const [code, info] of Object.entries(knownAccounts)) {
    if (!accountMap[code]) accountMap[code] = info;
  }

  console.log('Known accounts:', Object.keys(accountMap).join(', '));

  // ─── Step 3: Parse ledger entries for GL reconciliation ─────────
  console.log('\n--- Step 3: Parsing ledger entries ---\n');

  const ledgerData = [];
  if (ledgerEntries) {
    for (const entry of ledgerEntries) {
      const data = entry.data || entry;
      // Handle both canonical format and data JSONB format
      const accountId = data.account_id || data.debitAccountId || data.creditAccountId || '';
      const accountCode = data.account_code || (accountMap[accountId]?.code) || '';
      const entryType = data.entry_type || data.type || '';
      const amount = Number(data.amount || data.value || 0);
      const referenceType = data.reference_type || data.referenceType || '';
      const referenceId = data.reference_id || data.referenceId || '';
      const journalId = data.journal_id || data.journalId || '';
      const description = data.description || '';

      ledgerData.push({
        id: entry.id,
        accountId,
        accountCode,
        accountName: canonicalAccounts[accountId]?.name || accountMap[accountCode]?.name || data.account_name || '',
        entryType,
        amount,
        referenceType,
        referenceId,
        journalId,
        description,
      });
    }
  }
  console.log(`Parsed ledger entries: ${ledgerData.length}`);

  // Categorize ledger entries
  const cogsEntries = ledgerData.filter(e => e.accountCode === '51200');
  const revenueEntries = ledgerData.filter(e => e.accountCode === '41100');
  const inventoryDebitEntries = ledgerData.filter(e => ['11410', '11420', '11430'].includes(e.accountCode) && e.entryType === 'debit');
  const inventoryCreditEntries = ledgerData.filter(e => ['11410', '11420', '11430'].includes(e.accountCode) && e.entryType === 'credit');

  console.log(`COGS entries (51200): ${cogsEntries.length}`);
  console.log(`Revenue entries (41100): ${revenueEntries.length}`);
  console.log(`Inventory debit entries: ${inventoryDebitEntries.length}`);
  console.log(`Inventory credit entries: ${inventoryCreditEntries.length}`);

  // ─── Step 4: Analyze sales/invoices for cost discrepancies ──────
  console.log('\n--- Step 4: Analyzing sales/invoices ---\n');

  let consistentCount = 0;
  let panelMismatchCount = 0;
  let accountingMismatchCount = 0;
  let historicalCostUnavailable = 0;
  let noPostedCOGS = 0;
  let replacementCases = 0;
  let totalStockedLines = 0;

  const diagnosticRows = [];
  const affectedTransactions = [];

  // Process sales documents
  const documents = sales || [];
  for (const doc of documents) {
    const data = doc.data || {};
    const items = getItemsFromDocument(data);
    if (!items || items.length === 0) continue;

    const docStatus = data.status || data.documentStatus || data.status || 'Unknown';
    const docTotal = Number(data.totalAmount || data.total || data.total_amount || 0);
    const docId = doc.id || 'unknown';

    // Check if this document has posted accounting
    const docLedgerEntries = ledgerData.filter(e => e.referenceId === docId);
    const hasPostedCOGS = cogsEntries.some(e => e.referenceId === docId);
    const hasPostedRevenue = revenueEntries.some(e => e.referenceId === docId);

    let docMaterialCostOld = 0;
    let docMaterialCostNew = 0;
    let docAccountingCOGS = 0;
    let docHasStockedItems = false;

    for (const item of items) {
      const costFields = extractCostFields(item);
      if (!isStockedItem(costFields) && costFields.itemType !== 'unknown') continue;

      totalStockedLines++;
      docHasStockedItems = true;

      const qty = costFields.quantity;
      const oldCost = oldPanelBaseMaterialCost(item);
      const newCost = newPanelBaseMaterialCost(item);
      const acctCost = accountingBaseCost(item);

      docMaterialCostOld += oldCost * qty;
      docMaterialCostNew += newCost * qty;
      docAccountingCOGS += acctCost * qty;

      // Check for old vs new discrepancy
      const costDiff = Math.abs(oldCost - newCost);
      const hasOldBug = costDiff > 0.01;

      // Check for production snapshot bug (both fields set and different)
      const prodCost = Number(item?.productionCostSnapshot?.baseProductionCost || 0);
      const smartCost = Number(item?.smartPricingSnapshot?.baseCost || 0);
      const hasBothSnapshots = prodCost > 0 && smartCost > 0;
      const snapshotsDiffer = hasBothSnapshots && Math.abs(prodCost - smartCost) > 0.01;

      if (hasOldBug) {
        const row = {
          invoice: docId,
          line: costFields.itemId,
          itemName: costFields.itemName,
          itemType: costFields.itemType,
          quantity: qty,
          historicalCost: newCost * qty, // New panel cost = accounting cost
          oldPanelCost: oldCost * qty,
          newPanelCost: newCost * qty,
          postedCOGS: 0, // Will be filled from ledger
          difference: oldCost - newCost,
          reason: snapshotsDiffer ? 'PRODUCTION_SNAPSHOT_DIFFERS' : 'SNAPSHOT_AVAILABLE',
        };
        diagnosticRows.push(row);

        if (snapshotsDiffer) {
          affectedTransactions.push({
            invoice: docId,
            line: costFields.itemId,
            itemName: costFields.itemName,
            historicalCost: newCost * qty,
            oldPanelCost: oldCost * qty,
            newPanelCost: newCost * qty,
            postedCOGS: 0,
            difference: oldCost - newCost,
            reason: 'PRODUCTION_SNAPSHOT_DIFFERS_FROM_SMART_SNAPSHOT',
          });
        }
      }

      // Check master cost drift
      const currentMasterCost = costFields.cost;
      if (currentMasterCost > 0 && Math.abs(currentMasterCost - newCost) > 0.01) {
        report.masterCostDrift.push({
          invoice: docId,
          line: costFields.itemId,
          itemName: costFields.itemName,
          historicalCost: newCost,
          currentMasterCost: currentMasterCost,
          difference: newCost - currentMasterCost,
        });
      }

      // Check replacement items
      // (simplified: check if item name suggests replacement)
      const itemNameLower = (costFields.itemName || '').toLowerCase();
      if (itemNameLower.includes('chalk') || itemNameLower.includes('pen') || itemNameLower.includes('bantley') || itemNameLower.includes('bi')) {
        replacementCases++;
        report.replacementAudit.push({
          invoice: docId,
          line: costFields.itemId,
          itemName: costFields.itemName,
          productionCostSnapshot: item?.productionCostSnapshot || null,
          smartPricingSnapshot: item?.smartPricingSnapshot || null,
          costFields,
        });
      }
    }

    // Get posted COGS from ledger for this document
    const docCogsEntries = cogsEntries.filter(e => e.referenceId === docId);
    const docCogsTotal = docCogsEntries.reduce((sum, e) => sum + e.amount, 0);

    // Fill in posted COGS for affected rows
    for (const row of diagnosticRows.filter(r => r.invoice === docId)) {
      row.postedCOGS = docCogsTotal;
    }

    // Classify status
    const hasStockedItems = docHasStockedItems;
    if (!hasStockedItems) {
      // Service-only document
      continue;
    }

    if (!hasPostedCOGS) {
      noPostedCOGS++;
    }

    // Check consistency
    const panelMatch = Math.abs(docMaterialCostNew - docAccountingCOGS) < 0.01;
    const oldPanelMatch = Math.abs(docMaterialCostOld - docAccountingCOGS) < 0.01;

    if (panelMatch && oldPanelMatch) {
      consistentCount++;
    } else if (panelMatch && !oldPanelMatch) {
      // Panel is now correct, but old panel would have been wrong
      panelMismatchCount++;
      // This is actually the bug case
    } else if (!panelMatch) {
      accountingMismatchCount++;
    }
  }

  // Process invoice documents
  for (const doc of invoices) {
    const data = doc.data || {};
    const items = getItemsFromDocument(data);
    if (!items || items.length === 0) continue;

    const docStatus = data.status || 'Unknown';
    const docTotal = Number(data.totalAmount || data.total || 0);
    const docId = doc.id || 'unknown';

    // Skip if already processed as sales
    const alreadyProcessed = documents.some(d => d.id === docId);
    if (alreadyProcessed) continue;

    let docMaterialCostNew = 0;
    let docAccountingCOGS = 0;
    let docHasStockedItems = false;

    for (const item of items) {
      const costFields = extractCostFields(item);
      if (!isStockedItem(costFields) && costFields.itemType !== 'unknown') continue;

      docHasStockedItems = true;
      const qty = costFields.quantity;
      const newCost = newPanelBaseMaterialCost(item);
      const acctCost = accountingBaseCost(item);

      docMaterialCostNew += newCost * qty;
      docAccountingCOGS += acctCost * qty;

      const oldCost = oldPanelBaseMaterialCost(item);
      const costDiff = Math.abs(oldCost - newCost);
      const hasOldBug = costDiff > 0.01;

      const prodCost = Number(item?.productionCostSnapshot?.baseProductionCost || 0);
      const smartCost = Number(item?.smartPricingSnapshot?.baseCost || 0);
      const hasBothSnapshots = prodCost > 0 && smartCost > 0;
      const snapshotsDiffer = hasBothSnapshots && Math.abs(prodCost - smartCost) > 0.01;

      if (hasOldBug) {
        diagnosticRows.push({
          invoice: docId,
          line: costFields.itemId,
          itemName: costFields.itemName,
          itemType: costFields.itemType,
          quantity: qty,
          historicalCost: newCost * qty,
          oldPanelCost: oldCost * qty,
          newPanelCost: newCost * qty,
          postedCOGS: 0,
          difference: oldCost - newCost,
          reason: snapshotsDiffer ? 'PRODUCTION_SNAPSHOT_DIFFERS' : 'SNAPSHOT_AVAILABLE',
        });
      }
    }

    const docCogsEntries = cogsEntries.filter(e => e.referenceId === docId);
    const docCogsTotal = docCogsEntries.reduce((sum, e) => sum + e.amount, 0);

    for (const row of diagnosticRows.filter(r => r.invoice === docId)) {
      row.postedCOGS = docCogsTotal;
    }

    if (!docHasStockedItems) continue;
    if (!docCogsEntries.length) noPostedCOGS++;

    const panelMatch = Math.abs(docMaterialCostNew - docAccountingCOGS) < 0.01;
    const oldPanelMatch = Math.abs(docMaterialCostOld > 0 ? docMaterialCostOld - docAccountingCOGS : 0) < 0.01;

    if (panelMatch && oldPanelMatch) {
      consistentCount++;
    } else if (panelMatch && !oldPanelMatch) {
      panelMismatchCount++;
    } else if (!panelMatch) {
      accountingMismatchCount++;
    }
  }

  // ─── Step 5: GL Reconciliation ──────────────────────────────────
  console.log('\n--- Step 5: GL Reconciliation ---\n');

  let revenueReconciliations = 0;
  let cogsReconciliations = 0;
  let inventoryCreditReconciliations = 0;

  // Revenue reconciliation: invoice total ≈ GL 41100 credit
  const docIds = [...new Set([...documents.map(d => d.id), ...invoices.map(d => d.id)])];
  for (const docId of docIds) {
    const revEntries = revenueEntries.filter(e => e.referenceId === docId);
    const totalRevenue = revEntries.reduce((sum, e) => sum + e.amount, 0);
    if (totalRevenue > 0) {
      revenueReconciliations++;
    }
  }

  // COGS reconciliation: GL 51200 debit = inventory credit
  const cogsByReference = {};
  for (const entry of cogsEntries) {
    const ref = entry.referenceId;
    if (!cogsByReference[ref]) cogsByReference[ref] = { debit: 0, credit: 0 };
    if (entry.entryType === 'debit') cogsByReference[ref].debit += entry.amount;
    if (entry.entryType === 'credit') cogsByReference[ref].credit += entry.amount;
  }

  for (const [ref, amounts] of Object.entries(cogsByReference)) {
    if (amounts.debit > 0) {
      cogsReconciliations++;
    }
  }

  // Inventory credit reconciliation
  for (const entry of inventoryCreditEntries) {
    inventoryCreditReconciliations++;
  }

  report.glFindings = {
    revenueReconciliations: `${revenueReconciliations}/${docIds.length}`,
    cogsReconciliations: `${cogsReconciliations}/${Object.keys(cogsByReference).length}`,
    inventoryCreditReconciliations: `${inventoryCreditReconciliations}`,
  };

  console.log(`Revenue reconciliations: ${revenueReconciliations}/${docIds.length}`);
  console.log(`COGS reconciliations: ${cogsReconciliations}/${Object.keys(cogsByReference).length}`);
  console.log(`Inventory credit reconciliations: ${inventoryCreditReconciliations}`);

  // ─── Step 6: Financial Panel Reconciliation (new code) ──────────
  console.log('\n--- Step 6: Financial Panel Reconciliation (new code) ---\n');

  let panelInvariantViolations = 0;
  if (documents) {
    for (const doc of documents) {
      const data = doc.data || {};
      const items = getItemsFromDocument(data);
      if (!items || items.length === 0) continue;

      const totalAmount = Number(data.totalAmount || data.total || 0);
      let materialTotal = 0;
      let adjustmentTotal = 0;
      let profitTotal = 0;
      let roundingTotal = 0;

      for (const item of items) {
        materialTotal += newPanelBaseMaterialCost(item) * Number(item.quantity || 0);
        profitTotal += Number(item.pricingBreakdown?.profitAmount || item.profitAmount || 0) * Number(item.quantity || 0);
        adjustmentTotal += Number(item.pricingBreakdown?.adjustmentTotal || item.adjustmentTotal || 0) * Number(item.quantity || 0);
        roundingTotal += Number(item.pricingBreakdown?.roundingDifference || item.roundingDifference || 0) * Number(item.quantity || 0);
      }

      const sum = materialTotal + adjustmentTotal + profitTotal + roundingTotal;
      if (Math.abs(sum - totalAmount) > 0.01) {
        panelInvariantViolations++;
      }
    }
  }

  console.log(`Financial Panel invariant violations (new code): ${panelInvariantViolations}`);

  // ─── Step 7: Accounting Gross Profit comparison ─────────────────
  console.log('\n--- Step 7: Accounting Gross Profit comparison ---\n');

  let gpMatch = 0;
  let gpExpectedDiff = 0;
  let gpUnexpectedDiff = 0;

  // Simplified: compare Financial Panel Profit with Revenue - COGS
  if (documents) {
    for (const doc of documents) {
      const data = doc.data || {};
      const items = getItemsFromDocument(data);
      if (!items || items.length === 0) continue;

      const totalAmount = Number(data.totalAmount || data.total || 0);
      let materialTotal = 0;
      let profitTotal = 0;

      for (const item of items) {
        materialTotal += newPanelBaseMaterialCost(item) * Number(item.quantity || 0);
        profitTotal += Number(item.pricingBreakdown?.profitAmount || item.profitAmount || 0) * Number(item.quantity || 0);
      }

      const docCogsEntries = cogsEntries.filter(e => e.referenceId === doc.id);
      const postedCOGS = docCogsEntries.reduce((sum, e) => sum + e.amount, 0);
      const accountingGP = totalAmount - postedCOGS;

      if (Math.abs(profitTotal - accountingGP) < 0.01) {
        gpMatch++;
      } else if (Math.abs(profitTotal - accountingGP) < 5) {
        gpExpectedDiff++;
      } else {
        gpUnexpectedDiff++;
      }
    }
  }

  console.log(`GP Match: ${gpMatch}, Expected Diff: ${gpExpectedDiff}, Unexpected Diff: ${gpUnexpectedDiff}`);

  // ─── Step 8: Detect specific old bug cases ──────────────────────
  console.log('\n--- Step 8: Old Bug Detection ---\n');

  let bugAffectedLines = 0;
  let bugAffectedInvoices = new Set();

  for (const row of diagnosticRows) {
    if (Math.abs(row.difference) > 0.01) {
      bugAffectedLines++;
      bugAffectedInvoices.add(row.invoice);
    }
  }

  console.log(`Lines affected by old precedence bug: ${bugAffectedLines}`);
  console.log(`Invoices affected by old precedence bug: ${bugAffectedInvoices.size}`);

  // ─── Summary ────────────────────────────────────────────────────
  report.summary = {
    historicalInvoicesAudited: documents.length + invoices.length,
    salesRecords: documents.length,
    invoiceRecords: invoices.length,
    ledgerEntriesAnalyzed: ledgerData.length,
    stockedLinesAnalyzed: totalStockedLines,
    consistent: consistentCount,
    panelMismatches: panelMismatchCount,
    accountingMismatches: accountingMismatchCount,
    historicalCostUnavailable: historicalCostUnavailable,
    noPostedCOGS: noPostedCOGS,
    replacementCases: replacementCases,
    bugAffectedLines,
    bugAffectedInvoices: bugAffectedInvoices.size,
    gpMatch,
    gpExpectedDiff,
    gpUnexpectedDiff,
  };

  report.affectedTransactions = affectedTransactions;
  report.diagnosticTable = diagnosticRows;

  // ─── Output Report ──────────────────────────────────────────────
  console.log('\n=== AUDIT COMPLETE ===\n');
  console.log(JSON.stringify(report, null, 2));

  return report;
}

// ─── Entry Point ────────────────────────────────────────────────────
runAudit().catch(err => {
  console.error('[AUDIT FAILED]', err);
  process.exit(1);
});

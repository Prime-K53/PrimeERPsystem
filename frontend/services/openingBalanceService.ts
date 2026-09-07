import { dbService } from './db';
import { getGLConfig, getCompanyConfig, generateId, resolveAccountForPosting, loadAccountsFromStore } from './transactions/_internal';
import { LedgerEntry } from '../types';
import { roundToCurrency } from '../utils/helpers';
import { normalizeInventoryItems, normalizeInventoryItemForOpening, hasInventoryItems } from '../utils/inventoryNormalization';

export interface OpeningInventoryResult {
  success: boolean;
  entriesPosted: number;
  alreadyOpened: boolean;
  journalId: string;
  details: OpeningInventoryDetail[];
  totalDebit: number;
  totalCredit: number;
  variance: number;
}

export interface OpeningInventoryDetail {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: number;
  creditAmount: number;
  itemCount: number;
  physicalValue: number;
}

export interface OpeningInventoryDiagnostic {
  physicalInventoryValue: number;
  glInventoryValue: number;
  variance: number;
  merchandiseValue: number;
  rawMaterialsValue: number;
  finishedGoodsValue: number;
  unclassifiedItems: any[];
  negativeInventoryItems: any[];
  zeroCostItems: any[];
  missingAccountMapping: any[];
  duplicateItems: any[];
  openingEntriesExist: boolean;
}

const OPENING_INVENTORY_REFERENCE = 'OPENING-INVENTORY';
// Canonical default inventory child codes. The diagnostic function below
// prefers children derived from glMapping (if a custom inventory account is
// configured), otherwise falls back to these defaults.
const DEFAULT_INVENTORY_CHILD_CODES = ['11410', '11420', '11430'];

export async function computeOpeningInventoryDiagnostic(
  inventoryItems: any[],
  accounts: any[],
  ledgerEntries: any[]
): Promise<OpeningInventoryDiagnostic> {
  const normalizedItems = normalizeInventoryItems(inventoryItems);

  let merchandiseValue = 0;
  let rawMaterialsValue = 0;
  let finishedGoodsValue = 0;
  let unclassifiedItems: any[] = [];
  let negativeInventoryItems: any[] = [];
  let zeroCostItems: any[] = [];
  let missingAccountMapping: any[] = [];

  for (const item of normalizedItems) {
    if (item.type === 'Service') continue;
    const stock = item.stock || 0;
    const cost = item.cost || item.costPrice || 0;
    const value = stock * cost;

    if (stock < 0) negativeInventoryItems.push(item);
    if (cost <= 0 && stock > 0) zeroCostItems.push(item);

    const type = (item.type || '').toLowerCase();
    const accountCode = resolveInventoryAccountCodeByType(type);
    if (!accountCode) {
      missingAccountMapping.push(item);
      unclassifiedItems.push(item);
      continue;
    }

    if (type === 'product' || type === 'finished good' || type === 'finished goods') {
      if (type === 'finished goods') {
        finishedGoodsValue += value;
      } else {
        merchandiseValue += value;
      }
    } else if (type === 'material' || type === 'raw material' || type === 'raw' || type === 'consumable' || type === 'stationery') {
      rawMaterialsValue += value;
    }
  }

  const physicalInventoryValue = merchandiseValue + rawMaterialsValue + finishedGoodsValue;

  const glBalances: Record<string, number> = {};
  // Resolve the inventory child codes from glMapping + accounts, falling back to defaults
  const gl = getCompanyConfig();
  const defaultParentCode = gl?.glMapping?.defaultInventoryAccount || '11400';
  const parentAccount = accounts.find(a =>
    a.code === defaultParentCode || a.account_number === defaultParentCode || a.id === defaultParentCode
  );
  const parentIdOrCode = parentAccount?.id || defaultParentCode;
  const dynamicChildren = accounts
    .filter(a => a.parent_account_id === parentIdOrCode || a.parent_account_id === defaultParentCode)
    .map(a => a.account_number || a.code || a.id);
  const inventoryChildCodes = dynamicChildren.length > 0 ? dynamicChildren : DEFAULT_INVENTORY_CHILD_CODES;

  for (const code of inventoryChildCodes) {
    const account = accounts.find(a => a.account_number === code || a.code === code);
    if (!account) { glBalances[code] = 0; continue; }
    const balance = ledgerEntries.reduce((s: number, e: any) => {
      if (e.debitAccountId === code || e.debitAccountId === account.id) return s + e.amount;
      if (e.creditAccountId === code || e.creditAccountId === account.id) return s - e.amount;
      return s;
    }, 0);
    glBalances[code] = account.normal_balance === 'DEBIT' ? balance : -balance;
  }

  const glInventoryValue = inventoryChildCodes.reduce((s, code) => s + (glBalances[code] || 0), 0);

  const openingEntriesExist = ledgerEntries.some(
    (e: any) => e.referenceId === OPENING_INVENTORY_REFERENCE || e.entryType === 'opening_inventory'
  );

  return {
    physicalInventoryValue: roundToCurrency(physicalInventoryValue),
    glInventoryValue: roundToCurrency(glInventoryValue),
    variance: roundToCurrency(physicalInventoryValue - glInventoryValue),
    merchandiseValue: roundToCurrency(merchandiseValue),
    rawMaterialsValue: roundToCurrency(rawMaterialsValue),
    finishedGoodsValue: roundToCurrency(finishedGoodsValue),
    unclassifiedItems,
    negativeInventoryItems,
    zeroCostItems,
    missingAccountMapping,
    duplicateItems: [],
    openingEntriesExist,
  };
}

function resolveInventoryAccountCodeByType(type: string): string | null {
  const normalizedType = type.toLowerCase();
  if (normalizedType === 'finished good' || normalizedType === 'finished goods') {
    return '11430'; // Finished Goods (distinct from Merchandise)
  } else if (normalizedType === 'material' || normalizedType === 'raw material' || normalizedType === 'raw' || normalizedType === 'consumable' || normalizedType === 'stationery' || normalizedType === 'stationaries') {
    return '11420'; // Raw Materials / Stationery
  } else if (normalizedType === 'product') {
    return '11410'; // Default: Merchandise Inventory
  }
  return null;
}

export async function openInventory(): Promise<OpeningInventoryResult> {
  return dbService.executeAtomicOperation(
    ['ledger', 'accounts', 'inventory', 'idempotencyKeys'],
    async (tx) => {
      const ledgerStore = tx.objectStore('ledger');
      const inventoryStore = tx.objectStore('inventory');
      const idempotencyStore = tx.objectStore('idempotencyKeys');

      const accounts = await loadAccountsFromStore(tx);
      const companyConfig = getCompanyConfig();
      const companyId = companyConfig?.companyId;
      const accountOptions = { allowNonPosting: false, companyId };
      const resolveAcct = (ref: string | undefined) => {
        if (!ref) throw new Error('Account reference is undefined');
        const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
        if (!resolved) throw new Error(`Unable to resolve account: ${ref}`);
        return resolved;
      };

      const gl = getGLConfig();
      const openingEquityAccount = gl.ownerCapitalAccount || gl.retainedEarningsAccount || '32000';

      const allEntries = await ledgerStore.getAll();
      const existingOpening = allEntries.find(
        (e: LedgerEntry) => e.referenceId === OPENING_INVENTORY_REFERENCE
      );
      if (existingOpening) {
        return {
          success: true,
          entriesPosted: 0,
          alreadyOpened: true,
          journalId: existingOpening.id,
          details: [],
          totalDebit: 0,
          totalCredit: 0,
          variance: 0,
        };
      }

      const inventory = await inventoryStore.getAll();
      const normalizedInventory = normalizeInventoryItems(inventory);
      const activeItems = normalizedInventory.filter((item: any) => {
        if (item.status === 'Deleted' || item.status === 'Void') return false;
        if (item.type === 'Service') return false;
        return true;
      });

      if (!hasInventoryItems(activeItems)) {
        return {
          success: true,
          entriesPosted: 0,
          alreadyOpened: false,
          journalId: '',
          details: [],
          totalDebit: 0,
          totalCredit: 0,
          variance: 0,
        };
      }

      const childBalances: Record<string, { value: number; count: number }> = {};
      const unclassified: any[] = [];
      const negativeStock: any[] = [];
      const zeroCost: any[] = [];

      for (const item of activeItems) {
        const stock = item.stock || 0;
        const cost = item.cost || item.costPrice || item.cost_price || 0;
        const value = roundToCurrency(stock * cost);

        if (stock < 0) { negativeStock.push(item); continue; }
        if (cost <= 0 && stock > 0) { zeroCost.push(item); continue; }

        const type = (item.type || '').toLowerCase();
        const accountCode = resolveInventoryAccountCodeByType(type);
        if (!accountCode) { unclassified.push(item); continue; }

        const account = accounts.find(a => a.account_number === accountCode || a.code === accountCode);
        if (!account || account.allow_posting === false) { unclassified.push(item); continue; }

        const childId = account.id;
        if (!childBalances[childId]) {
          childBalances[childId] = { value: 0, count: 0 };
        }
        childBalances[childId].value += value;
        childBalances[childId].count += 1;
      }

      const debitEntries: { accountId: string; amount: number; accountCode: string; accountName: string; count: number }[] = [];
      let totalDebit = 0;

      for (const [childAccountId, data] of Object.entries(childBalances)) {
        const account = accounts.find(a => a.id === childAccountId);
        if (!account || account.allow_posting === false) continue;
        const amount = roundToCurrency(data.value);
        if (amount <= 0) continue;
        debitEntries.push({
          accountId: childAccountId,
          amount,
          accountCode: account.account_number || account.code || childAccountId,
          accountName: account.name,
          count: data.count,
        });
        totalDebit += amount;
      }

      if (totalDebit <= 0) {
        return {
          success: true,
          entriesPosted: 0,
          alreadyOpened: false,
          journalId: '',
          details: [],
          totalDebit: 0,
          totalCredit: 0,
          variance: roundToCurrency(totalDebit),
        };
      }

      const creditAccountId = resolveAcct(openingEquityAccount);
      const totalCredit = roundToCurrency(totalDebit);

      const journalId = generateId('INV-OPEN');
      const now = new Date().toISOString();
      const reconciliationEntries: LedgerEntry[] = [];

      for (const debit of debitEntries) {
        reconciliationEntries.push({
          id: generateId('LG-INV'),
          date: now,
          description: `Opening Inventory: ${debit.accountName} (${debit.count} items)`,
          debitAccountId: debit.accountId,
          creditAccountId: creditAccountId,
          amount: debit.amount,
          referenceId: OPENING_INVENTORY_REFERENCE,
          referenceType: 'opening_inventory',
          entryType: 'opening_inventory',
          journalId,
          reconciled: false,
        });
      }

      for (const entry of reconciliationEntries) {
        await ledgerStore.put(entry);
      }

      const idempotencyKey = {
        id: generateId('IK-INV'),
        scope: 'opening_inventory',
        sourceId: journalId,
        createdAt: now,
      };
      await idempotencyStore.put(idempotencyKey);

      const details: OpeningInventoryDetail[] = debitEntries.map(d => ({
        accountId: d.accountId,
        accountCode: d.accountCode,
        accountName: d.accountName,
        debitAmount: d.amount,
        creditAmount: 0,
        itemCount: d.count,
        physicalValue: d.amount,
      }));

      return {
        success: true,
        entriesPosted: reconciliationEntries.length,
        alreadyOpened: false,
        journalId,
        details,
        totalDebit: roundToCurrency(totalDebit),
        totalCredit: roundToCurrency(totalCredit),
        variance: 0,
      };
    }
  );
}

export async function getOpeningInventoryStatus(): Promise<{
  opened: boolean;
  journalId?: string;
  date?: string;
  totalDebit?: number;
  totalCredit?: number;
}> {
  const ledger = await dbService.getAll<LedgerEntry>('ledger');
  const openingEntry = ledger.find(
    (e: LedgerEntry) => e.referenceId === OPENING_INVENTORY_REFERENCE
  );
  if (openingEntry) {
    return {
      opened: true,
      journalId: openingEntry.journalId || openingEntry.id,
      date: openingEntry.date,
      totalDebit: openingEntry.amount,
      totalCredit: openingEntry.amount,
    };
  }
  return { opened: false };
}

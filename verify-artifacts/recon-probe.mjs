import { chromium } from '@playwright/test';

const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
const ctx = browser.contexts()[0];
const page = ctx.pages().find((p) => /localhost:5173/.test(p.url()));

const out = await page.evaluate(async () => {
  const { dbService } = await import('/services/db.ts');
  const stores = ['inventory', 'accounts', 'ledger', 'warehouseInventory', 'inventoryTransactions', 'invoices'];
  const data = {};
  for (const s of stores) {
    try { data[s] = await dbService.getAll(s); } catch (e) { data[s] = { error: String(e) }; }
  }
  const keys = (arr) => Array.isArray(arr) ? Object.keys(arr[0] || {}) : null;
  const acct = Array.isArray(data.accounts) ? data.accounts : [];
  const invCodes = ['11400', '11410', '11420', '11430', '51200'];
  const ledger = Array.isArray(data.ledger) ? data.ledger : [];
  return {
    counts: Object.fromEntries(stores.map((s) => [s, Array.isArray(data[s]) ? data[s].length : 'ERR'])),
    keys: Object.fromEntries(stores.map((s) => [s, keys(data[s])])),
    inventoryAccount: acct.filter((a) => invCodes.includes(String(a.account_number || a.code))).map((a) => ({
      id: a.id, code: a.account_number || a.code, name: a.name, type: a.account_type || a.type,
      normal: a.normal_balance, opening: a.opening_balance, balance: a.balance,
    })),
    ledgerSample: ledger.slice(0, 3),
    invTxnSample: Array.isArray(data.inventoryTransactions) ? data.inventoryTransactions.slice(0, 3) : null,
    whInvSample: Array.isArray(data.warehouseInventory) ? data.warehouseInventory.slice(0, 3) : null,
    invoiceIds: (Array.isArray(data.invoices) ? data.invoices : []).map((i) => i.id || i.invoiceNumber).filter(Boolean).slice(0, 30),
  };
});
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
process.exit(0);

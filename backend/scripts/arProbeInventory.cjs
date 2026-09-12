/** READ-ONLY probe: invoice 021, operational inventory tables, table census. No writes. */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
(function loadEnv() {
  try {
    for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* noop */ }
})();
const H = { apikey: process.env.SUPABASE_SECRET_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SECRET_KEY };
const BASE = process.env.SUPABASE_URL || 'https://rdtuzuzehfbwvfdzqliw.supabase.co';
async function tryGet(table) {
  try {
    const { data } = await axios.get(BASE + '/rest/v1/' + table, { params: { select: '*', limit: 1000 }, headers: H, timeout: 20000 });
    return { table, n: Array.isArray(data) ? data.length : 0, rows: Array.isArray(data) ? data : [] };
  } catch (e) {
    const st = e.response ? e.response.status : e.message;
    return { table, n: -1, status: st };
  }
}
(async () => {
  console.log('--- table census (limit 1000) ---');
  for (const t of ['invoices', 'customer_payments', 'ledger_entries', 'accounts', 'chart_of_accounts', 'products', 'inventory_items', 'inventory_movements', 'stock_movements', 'purchases', 'purchase_orders', 'goods_received', 'grn', 'stock_adjustments', 'opening_balances', 'customers', 'batches', 'product_batches']) {
    const r = await tryGet(t);
    console.log('  ' + t + ': ' + (r.n >= 0 ? r.n + ' rows' : 'ERR ' + r.status));
  }
  const inv = (await axios.get(BASE + '/rest/v1/invoices', { params: { select: '*' }, headers: H })).data;
  const d21 = (inv.find((x) => { const d = x.data || x; return d.id === 'INV-P726/021'; }) || {});
  const v21 = d21.data || d21;
  console.log('\n--- INV-P726/021 ---');
  for (const k of ['totalAmount', 'total', 'salesAccountId', 'status', 'date', 'customerId', 'customerName', 'profitMarginTotal']) console.log('  ' + k + ' = ' + JSON.stringify(v21[k]));
  console.log('  items = ' + JSON.stringify((v21.items || []).map((it) => ({ name: it.name || it.productName, type: it.type || it.itemType || it.category, qty: it.quantity ?? it.qty, price: it.price ?? it.unitPrice }))));

  // operational stock value from products table (first 1000)
  const prod = await tryGet('products');
  if (prod.n > 0) {
    let val = 0; let stocked = 0;
    for (const r of prod.rows) {
      const p = r.data || r;
      const stock = Number(p.stock ?? p.quantity ?? p.stockOnHand ?? 0);
      const cost = Number(p.cost_price ?? p.cost ?? p.costPrice ?? p.unitCost ?? 0);
      if (stock > 0) { stocked += 1; val += stock * cost; }
    }
    const keys = Object.keys(prod.rows[0].data || prod.rows[0]);
    console.log('\nproducts sample keys: ' + keys.join(', '));
    console.log('products with stock>0: ' + stocked + ' operational value(stock x cost) ~ K' + val.toLocaleString());
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

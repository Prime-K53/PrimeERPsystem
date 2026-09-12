/** READ-ONLY probe: invoice 023 totals/lines + 021 revenue account. No writes. */
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

(async () => {
  const inv = (await axios.get(BASE + '/rest/v1/invoices', { params: { select: '*' }, headers: H })).data;
  const get = (id) => {
    const r = inv.find((x) => { const d = x.data || x; return d.id === id; });
    return r ? (r.data || r) : null;
  };
  const d23 = get('INV-P726/023');
  console.log('--- INV-P726/023 money fields ---');
  for (const k of ['totalAmount', 'total', 'subtotal', 'tax', 'taxRate', 'discount', 'discountRaw', 'otherCharges', 'otherChargesCalculated', 'otherChargesPercent', 'adjustmentTotal', 'roundingTotal', 'roundingDifference', 'roundingEnabled', 'materialTotal', 'profitMarginTotal', 'salesAccountId', 'status', 'date', 'dueDate', 'customerId', 'customerName']) {
    console.log('  ' + k + ' = ' + JSON.stringify(d23[k]));
  }
  console.log('--- INV-P726/023 items ---');
  for (const it of (d23.items || [])) {
    console.log('  ' + JSON.stringify({ name: it.name || it.productName, type: it.type || it.itemType || it.category, qty: it.quantity ?? it.qty, price: it.price ?? it.unitPrice ?? it.sellingPrice, cost_price: it.cost_price, cost: it.cost, costPrice: it.costPrice, unitCost: it.unitCost, prodSnap: it.productionCostSnapshot || undefined }));
  }

  const ledger = (await axios.get(BASE + '/rest/v1/ledger_entries', { params: { select: '*' }, headers: H })).data;
  console.log('\n--- ledger entries touching INV-P726/023 or INV-P726/021 ---');
  for (const r of ledger) {
    const e = r.data || r;
    if (e.referenceId === 'INV-P726/023' || e.referenceId === 'INV-P726/021') {
      console.log('  ' + e.id + ': Dr=' + e.debitAccountId + ' Cr=' + e.creditAccountId + ' amt=' + e.amount + ' ref=' + e.referenceId + ' date=' + e.date);
    }
  }
  console.log('\n--- newest 5 ledger entries (context for 71st row) ---');
  const sorted = ledger.slice().sort((a, b) => String((b.data || b).id).localeCompare(String((a.data || a).id)));
  for (const r of sorted.slice(0, 5)) {
    const e = r.data || r;
    console.log('  ' + e.id + ': Dr=' + e.debitAccountId + ' Cr=' + e.creditAccountId + ' amt=' + e.amount + ' ref=' + e.referenceId + ' date=' + e.date + ' desc=' + String(e.description || '').slice(0, 70));
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

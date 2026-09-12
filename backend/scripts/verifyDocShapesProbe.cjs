/** READ-ONLY probe: sample rows for receipt/order/quote/delivery mappers. No writes. */
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
  const pay = (await axios.get(BASE + '/rest/v1/customer_payments', { params: { select: '*', limit: 5 }, headers: H })).data;
  console.log('customer_payments sample:');
  for (const r of pay) {
    const d = r.data || r;
    console.log('  ' + JSON.stringify({ id: d.id, date: d.date, amount: d.amount, status: d.status, method: d.paymentMethod || d.method, ref: d.reference || d.invoiceId, cust: d.customerName || d.customerId, token: !!d.verificationToken }));
  }
  const so = (await axios.get(BASE + '/rest/v1/sales_orders', { params: { select: '*', limit: 3 }, headers: H })).data;
  console.log('sales_orders sample:');
  for (const r of so) {
    const d = r.data || r;
    console.log('  ' + JSON.stringify({ id: d.id, orderNumber: d.orderNumber, date: d.orderDate || d.date, total: d.total, status: d.status, cust: d.customerName || d.customerId, token: !!d.verificationToken }));
  }
  const dn = (await axios.get(BASE + '/rest/v1/delivery_notes', { params: { select: '*', limit: 3 }, headers: H })).data;
  console.log('delivery_notes sample:');
  for (const r of dn) {
    const d = r.data || r;
    console.log('  ' + JSON.stringify({ id: d.id, num: d.dnNumber || d.number, date: d.date, status: d.status, cust: d.customerName || d.customerId, ref: d.invoiceId || d.reference, token: !!d.verificationToken }));
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

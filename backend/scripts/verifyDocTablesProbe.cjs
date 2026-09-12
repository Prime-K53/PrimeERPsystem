/** READ-ONLY probe: which document tables exist in Supabase. No writes. */
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
  for (const t of ['invoices', 'customer_payments', 'quotations', 'sales_orders', 'orders', 'purchaseOrders', 'purchases', 'delivery_notes', 'supplier_payments']) {
    try {
      const { data } = await axios.get(BASE + '/rest/v1/' + t, { params: { select: '*', limit: 1 }, headers: H, timeout: 15000 });
      const keys = data.length ? Object.keys(data[0].data || data[0]).slice(0, 12).join(',') : '(empty)';
      console.log(`  ${t}: OK rows?${data.length} keys=${keys}`);
    } catch (e) {
      console.log(`  ${t}: ERR ${e.response ? e.response.status : e.message}`);
    }
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

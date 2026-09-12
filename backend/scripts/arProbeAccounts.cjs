/** READ-ONLY probe: COA account existence/flags + invoice 022 customer. No writes. */
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
  const accounts = (await axios.get(BASE + '/rest/v1/accounts', { params: { select: '*' }, headers: H })).data;
  console.log('accounts rows: ' + accounts.length);
  const want = ['11110', '11210', '11240', '11310', '11410', '11420', '11430', '11400', '21110', '31000', '41100', '41200', '51200', '21300'];
  for (const code of want) {
    const hit = accounts.find((r) => {
      const a = r.data || r;
      return String(a.code) === code || String(a.account_number) === code || String(a.id) === code || String(a.id) === 'ACC-' + code;
    });
    if (!hit) { console.log('  ' + code + ': MISSING'); continue; }
    const a = hit.data || hit;
    console.log('  ' + code + ': id=' + a.id + ' name=' + JSON.stringify(a.name) + ' type=' + (a.account_type || a.type) + ' posting=' + (a.allow_posting ?? a.allowPosting ?? '?') + ' active=' + (a.is_active ?? a.isActive ?? '?') + ' parent=' + (a.parent_account_id || a.parentId || ''));
  }
  const inv = (await axios.get(BASE + '/rest/v1/invoices', { params: { select: '*' }, headers: H })).data;
  const g = (id) => { const r = inv.find((x) => { const d = x.data || x; return d.id === id; }); return r ? r.data || r : null; };
  const d22 = g('INV-P726/022');
  console.log('\nINV-P726/022 customerId=' + d22.customerId + ' customerName=' + d22.customerName + ' total=' + d22.totalAmount + ' paid=' + d22.paidAmount + ' status=' + d22.status);
  const pay = (await axios.get(BASE + '/rest/v1/customer_payments', { params: { select: '*' }, headers: H })).data;
  const p = (pay[0].data || pay[0]);
  console.log('PAY-P726/020 customerId=' + p.customerId + ' customerName=' + p.customerName);
  // type mix per active invoice (for COGS split relevance)
  console.log('\nline-type mix per invoice:');
  for (const r of inv) {
    const d = r.data || r;
    if (String(d.status) === 'Cancelled') continue;
    const mix = {};
    for (const it of (d.items || [])) { const t = String(it.type || it.itemType || it.category || 'product'); mix[t] = (mix[t] || 0) + 1; }
    console.log('  ' + d.id + ': ' + JSON.stringify(mix));
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

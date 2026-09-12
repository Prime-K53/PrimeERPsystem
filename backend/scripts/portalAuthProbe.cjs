/** READ-ONLY probe: portal_users + pending invite codes state. No writes. Codes are masked. */
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
const mask = (c) => (c && c.length >= 6 ? c.slice(0, 2) + '****' + c.slice(-2) : '****');
(async () => {
  const users = (await axios.get(BASE + '/rest/v1/portal_users', { params: { select: '*', order: 'created_at.desc', limit: 30 }, headers: H })).data;
  console.log('portal_users rows (latest 30): ' + users.length);
  const byCustomer = {};
  for (const u of users) {
    byCustomer[u.customer_id] = (byCustomer[u.customer_id] || 0) + 1;
    console.log(`  ${u.id} | cust=${u.customer_id} | email=${u.email} | status=${u.status} | has_hash=${!!u.password_hash} | created=${u.created_at}`);
  }
  const dupes = Object.entries(byCustomer).filter(([, n]) => n > 1);
  console.log('customers with >1 portal user: ' + (dupes.length ? JSON.stringify(dupes) : 'none'));

  let resets = [];
  try {
    resets = (await axios.get(BASE + '/rest/v1/portal_password_resets', { params: { select: '*', order: 'created_at.desc', limit: 30 }, headers: H })).data;
  } catch (e) { console.log('portal_password_resets read failed: ' + (e.response ? e.response.status : e.message)); }
  console.log('\nportal_password_resets rows (latest 30): ' + resets.length);
  const now = new Date();
  for (const r of resets) {
    const state = r.used_at ? 'USED' : (r.expires_at && new Date(r.expires_at) < now ? 'EXPIRED' : 'VALID');
    console.log(`  user=${r.portal_user_id} | code=${mask(r.code)} | ${state} | expires=${r.expires_at} | created=${r.created_at}`);
  }
})().catch((e) => { console.error('probe failed:', e.response ? JSON.stringify(e.response.data).slice(0, 300) : e.message); process.exit(1); });

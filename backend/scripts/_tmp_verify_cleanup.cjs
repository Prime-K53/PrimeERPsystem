const axios = require('axios');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const HEADERS = {
  apikey: SECRET_KEY,
  Authorization: `Bearer ${SECRET_KEY}`,
  'Content-Type': 'application/json',
};

(async () => {
  const r = await axios.get(`${SUPABASE_URL}/rest/v1/ledger_entries`, {
    params: { select: 'id,data', limit: 1000 },
    headers: HEADERS,
    timeout: 30000,
  });
  const rows = r.data || [];
  const test = rows.filter(e => String(e.id).startsWith('PH25-TEST-'));
  const zero = rows.filter(e => (e.data && e.data.account_id === '00000000-0000-0000-0000-000000000000'));
  console.log('PH25-TEST ledger entries:', test.length);
  console.log('Zero-UUID ledger entries:', zero.length);
})();

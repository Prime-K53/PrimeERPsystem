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
  const affectedIds = [
    'INV-0002','INV-P726/003','INV-P726/004','INV-P726/005','INV-P726/006',
    'INV-P726/007','INV-P726/008','INV-P726/009','INV-P726/010','INV-P726/028',
    'INV-P726/029','INV-P726/030','INV-P726/031','INV-P726/032','INV-P726/033',
    'INV-P726/034','INV-P726/035','INV-P726/036','INV-P726/037','INV-P726/038',
    'INV-P726/039','INV-P726/040','INV-P726/041','INV-P726/043'
  ];

  const r = await axios.get(`${SUPABASE_URL}/rest/v1/ledger_entries`, {
    params: { select: 'id,data', limit: 1000 },
    headers: HEADERS,
    timeout: 30000,
  });
  const rows = r.data || [];

  for (const invId of affectedIds) {
    const entries = rows.filter(row => {
      const d = row.data || {};
      return d.reference_id === invId || d.referenceId === invId;
    });
    console.log(`${invId}: ${entries.length} entries`);
  }
})();

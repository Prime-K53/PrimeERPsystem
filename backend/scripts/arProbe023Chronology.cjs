/** READ-ONLY chronology proof for INV-P726/023. No writes. */
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
  const row = inv.find((x) => { const d = x.data || x; return d.id === 'INV-P726/023'; });
  const d = row.data || row;
  console.log('--- INV-P726/023 record ---');
  for (const k of ['id', 'invoiceNumber', 'status', 'paymentStatus', 'totalAmount', 'paidAmount', 'version', 'revision', 'createdAt', 'updatedAt', 'date', 'dueDate', 'customerId', 'customerName', 'salesAccountId']) {
    console.log('  ' + k + ' = ' + JSON.stringify(d[k]));
  }
  console.log('  row-level created_at = ' + JSON.stringify(row.created_at) + ' updated_at = ' + JSON.stringify(row.updated_at));
  const items = d.items || [];
  let sum = 0;
  for (const it of items) {
    const q = Number(it.quantity ?? it.qty ?? 0);
    const p = Number(it.price ?? it.unitPrice ?? it.sellingPrice ?? 0);
    sum += q * p;
  }
  console.log('  recomputed lines sum = ' + sum.toLocaleString() + ' (items: ' + items.length + ')');

  const ledger = (await axios.get(BASE + '/rest/v1/ledger_entries', { params: { select: '*' }, headers: H })).data;
  console.log('\n--- all ledger entries with referenceId INV-P726/023 ---');
  for (const r of ledger) {
    const e = r.data || r;
    if (e.referenceId === 'INV-P726/023' || String(e.id).includes('023') || String(e.description || '').includes('023')) {
      console.log('  ' + e.id + ' | Dr=' + e.debitAccountId + ' Cr=' + e.creditAccountId + ' amt=' + e.amount + ' ref=' + e.referenceId + ' date=' + e.date + ' desc=' + JSON.stringify(e.description));
    }
  }
  console.log('\n--- any existing correction/reversal/adjustment mentioning 023 ---');
  let found = 0;
  for (const r of ledger) {
    const e = r.data || r;
    const blob = JSON.stringify(e);
    if (/CORRECTION|REVERSAL|REV-|ADJUST/i.test(blob) && blob.includes('023')) {
      found += 1;
      console.log('  ' + e.id + ' | ' + JSON.stringify(e.description) + ' | amt=' + e.amount);
    }
  }
  if (!found) console.log('  none found');
  console.log('\n--- LG id timestamp decode (entry creation time) ---');
  for (const r of ledger) {
    const e = r.data || r;
    if (e.referenceId === 'INV-P726/023') {
      const m = String(e.id).match(/(\d{12,})/);
      console.log('  ' + e.id + ' embedded ts=' + (m ? new Date(Number(m[1])).toISOString() : 'n/a'));
    }
  }
})().catch((e) => { console.error('probe failed:', e.message); process.exit(1); });

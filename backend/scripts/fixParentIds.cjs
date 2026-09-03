const https = require('https');
const SUPABASE_URL = 'https://rdtuzuzehfbwvfdzqliw.supabase.co/rest/v1';

function getAll(path) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/${path}`;
    https.get(url, {
      headers: {
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Prefer': 'return=representation'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function patch(path, body, query) {
  return new Promise((resolve, reject) => {
    const url = `${SUPABASE_URL}/${path}?${query}`;
    const data = JSON.stringify(body);
    const options = {
      hostname: 'rdtuzuzehfbwvfdzqliw.supabase.co',
      port: 443,
      path: `/rest/v1/${path}?${query}`,
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
        'Prefer': 'return=representation',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    const req = https.request(options, (res) => {
      let respData = '';
      res.on('data', chunk => respData += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(respData)); }
        catch (e) { resolve(respData); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const companyId = 'COMP-PRIME-ERP';
  const accounts = await getAll(`chart_of_accounts?data->>company_id=eq.${companyId}&limit=200`);
  console.log('Total accounts:', accounts.length);

  // Build account map
  const byNumber = {};
  accounts.forEach(r => {
    const d = r.data || {};
    if (d.account_number) byNumber[d.account_number] = { id: r.id, data: d };
  });

  // Fix parent_account_id for accounts that should have parents
  const expectedParents = {
    '11000': '10000', '11100': '11000', '11110': '11100', '11120': '11100',
    '11200': '11000', '11210': '11200', '11220': '11200', '11230': '11200',
    '11300': '11000', '11310': '11300',
    '11400': '11000', '11410': '11400', '11420': '11400', '11430': '11400',
    '11500': '11000', '11510': '11500', '11520': '11500',
    '12000': '10000', '12100': '12000', '12200': '12000', '12300': '12000', '12400': '12000', '12500': '12000',
    '21000': '20000', '21100': '21000', '21110': '21100',
    '21200': '21000', '21210': '21200', '21220': '21200',
    '21300': '21000',
    '22000': '20000', '22100': '22000', '22200': '22000',
    '31000': '30000', '32000': '30000', '33000': '30000', '34000': '30000',
    '41000': '40000', '41100': '41000', '41200': '41000',
    '42000': '40000', '42100': '42000', '42200': '42000',
    '51000': '50000', '51100': '51000', '51200': '51000', '51300': '51000',
    '52000': '50000', '52100': '52000', '52200': '52000', '52300': '52000', '52400': '52000',
    '52500': '52000', '52600': '52000', '52700': '52000', '52800': '52000', '52900': '52000', '53000': '52000',
    '54000': '50000', '54100': '54000',
  };

  let fixed = 0;
  for (const [num, parentNum] of Object.entries(expectedParents)) {
    const acct = byNumber[num];
    const parent = byNumber[parentNum];
    if (acct && parent) {
      const currentParent = (acct.data.parent_account_id || null);
      const expectedParent = parent.id;
      if (currentParent !== expectedParent) {
        // Update the account with new parent_account_id
        const result = await patch(
          'chart_of_accounts',
          { data: { ...acct.data, parent_account_id: expectedParent } },
          `id=eq.${acct.id}`
        );
        fixed++;
        if (fixed <= 3) console.log(`Fixed ${num} parent -> ${parentNum}`);
      }
    }
  }
  console.log(`Fixed ${fixed} parent_account_id values`);

  // Verify
  const after = await getAll(`chart_of_accounts?data->>company_id=eq.${companyId}&limit=200`);
  const nullParents = after.filter(r => {
    const d = r.data || {};
    return d.account_number && d.account_number !== '10000' && d.account_number !== '20000' &&
           d.account_number !== '30000' && d.account_number !== '40000' && d.account_number !== '50000' &&
           !d.parent_account_id;
  });
  console.log('Accounts still missing parent_account_id:', nullParents.length);
  nullParents.slice(0, 5).forEach(r => console.log(' ', r.data?.account_number, r.data?.name));
}

main().catch(e => console.error('Error:', e.message));

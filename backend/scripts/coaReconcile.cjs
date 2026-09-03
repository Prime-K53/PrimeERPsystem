const { execSync } = require('child_process');

function supabaseGet(path) {
  const result = execSync(
    `node -e "const https=require('https');https.get('https://rdtuzuzehfbwvfdzqliw.supabase.co/rest/v1/${path}',{headers:{apikey: process.env.SUPABASE_SERVICE_KEY,Authorization:'Bearer ' + process.env.SUPABASE_SERVICE_KEY}},(r)=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))})"`,
    { encoding: 'utf8', cwd: __dirname }
  );
  try { return JSON.parse(result); } catch { return []; }
}

async function main() {
  console.log('=== COA Reconciliation for COMP-PRIME-ERP ===\n');
  const accounts = supabaseGet('chart_of_accounts?data->>company_id=eq.COMP-PRIME-ERP&limit=200');

  // Expected 65 accounts from frontend template
  const expected = [
    '10000','11000','11100','11110','11120','11200','11210','11220','11230',
    '11300','11310','11400','11410','11420','11430','11500','11510','11520',
    '12000','12100','12200','12300','12400','12500',
    '20000','21000','21100','21110','21200','21210','21220','21300',
    '22000','22100','22200',
    '30000','31000','32000','33000','34000',
    '40000','41000','41100','41200','42000','42100','42200',
    '50000','51000','51100','51200','51300','52000','52100','52200','52300',
    '52400','52500','52600','52700','52800','52900','53000','54000','54100'
  ];

  const found = new Set();
  const byNumber = {};
  accounts.forEach(a => {
    const d = a.data || {};
    if (d.account_number) {
      found.add(d.account_number);
      byNumber[d.account_number] = { id: a.id, data: d };
    }
  });

  const missing = expected.filter(n => !found.has(n));
  const extra = Array.from(found).filter(n => !expected.includes(n));

  console.log('Expected:', expected.length);
  console.log('Actual:', accounts.length);
  console.log('Missing:', missing.length, missing);
  console.log('Extra:', extra.length, extra);

  // Normal balance verification
  console.log('\n--- Normal Balance Verification ---');
  const debitExpected = ['11110','11120','11210','11220','11230','11310','11410','11420','11430','12100','12200','12300','12400','51100','51200','51300','52100','52200','52300','52400','52500','52600','52700','52800','52900','53000','54100','34000'];
  const creditExpected = ['21110','21210','21220','21300','22100','22200','31000','32000','33000','41100','41200','42100','42200','12500'];

  console.log('\nDEBIT expected accounts:');
  debitExpected.forEach(n => {
    const a = byNumber[n];
    if (a) console.log(`  ${n} ${a.data.name}: ${a.data.normal_balance} ${a.data.normal_balance === 'DEBIT' ? 'OK' : 'WRONG'}`);
  });
  console.log('\nCREDIT expected accounts:');
  creditExpected.forEach(n => {
    const a = byNumber[n];
    if (a) console.log(`  ${n} ${a.data.name}: ${a.data.normal_balance} ${a.data.normal_balance === 'CREDIT' ? 'OK' : 'WRONG'}`);
  });

  // Hierarchy verification
  console.log('\n--- Hierarchy Verification ---');
  let hierarchyOk = 0;
  let hierarchyFail = 0;
  const expectedParents = {
    '11000':'10000','11100':'11000','11110':'11100','11120':'11100',
    '11200':'11000','11210':'11200','11220':'11200','11230':'11200',
    '11300':'11000','11310':'11300',
    '11400':'11000','11410':'11400','11420':'11400','11430':'11400',
    '11500':'11000','11510':'11500','11520':'11500',
    '12000':'10000','12100':'12000','12200':'12000','12300':'12000','12400':'12000','12500':'12000',
    '21000':'20000','21100':'21000','21110':'21100',
    '21200':'21000','21210':'21200','21220':'21200',
    '21300':'21000',
    '22000':'20000','22100':'22000','22200':'22000',
    '31000':'30000','32000':'30000','33000':'30000','34000':'30000',
    '41000':'40000','41100':'41000','41200':'41000',
    '42000':'40000','42100':'42000','42200':'42000',
    '51000':'50000','51100':'51000','51200':'51000','51300':'51000',
    '52000':'50000','52100':'52000','52200':'52000','52300':'52000','52400':'52000',
    '52500':'52000','52600':'52000','52700':'52000','52800':'52000','52900':'52000','53000':'52000',
    '54000':'50000','54100':'54000',
  };

  for (const [num, parentNum] of Object.entries(expectedParents)) {
    const child = byNumber[num];
    const parent = byNumber[parentNum];
    if (child && parent) {
      if (child.data.parent_account_id === parent.id) hierarchyOk++;
      else { hierarchyFail++; console.log(`  WRONG parent: ${num} should have parent ${parentNum} (${parent.id}), has ${child.data.parent_account_id}`); }
    }
  }
  console.log('Hierarchy correct:', hierarchyOk, '/ Failed:', hierarchyFail);
}

main().catch(e => console.error(e));

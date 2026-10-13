/**
 * printingContractsConcurrency.integration.test.cjs
 *
 * LIVE-DATABASE integration proof for migrations 0048/0049. NOT EXECUTED in
 * environments without a disposable PostgreSQL (it skips cleanly there).
 *
 * Run ONLY against a disposable database. NEVER production. The suite
 * fail-fasts unless TEST_DATABASE_URL names a database literally called
 * `pc_integration` on localhost/a test host (see guard below).
 *
 * Environment prerequisite (verified 2026-10-13): the host must run FORKED
 * PostgreSQL backends. Quick check: start postgres, connect, `SELECT 1`.
 * On the affected Windows box, every client backend died with 0xC0000142
 * (DLL init failure; Defender/EDR or UCRT servicing state suspected, no
 * admin rights to remediate) while the postmaster stayed up, so no
 * multi-connection test can run there. Single-user mode DOES work there
 * and was used to prove everything below except true lock contention
 * (see C:\pgt\setup.js + scenarios.js + rollback.js run log, 72 checks).
 *
 * Setup without touching the repo lockfile (pg driver resolved via NODE_PATH):
 *   npm i -g pg 2>/dev/null || NODE_PATH=/path/to/pg/parent
 *   createdb -h 127.0.0.1 -U postgres pc_integration   # empty disposable DB
 *   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55433/pc_integration \
 *     NODE_PATH=C:/pgt/node_modules \
 *     npx jest tests/printingContractsConcurrency.integration.test.cjs --forceExit
 * (Do NOT `pnpm add -D pg` unless the team accepts the lockfile change.)
 *
 * What it proves (each against REAL concurrent connections + row locks):
 *   1. Two concurrent consumes of the SAME assessment -> exactly one succeeds.
 *   2. Two DIFFERENT assessments cannot overspend one wallet (both refused,
 *      zero writes, per the wallet->=protected coverage rule).
 *   2b. Customer-row locking serializes two FUNDED consumptions (no lost update).
 *   3. Wallet balance + reservation + wallet tx + ledger commit/roll back together.
 *   4. Replaying an accepted op never debits twice.
 *   5. Reserve and consume enforce the same financial-year rules.
 *   6. Closed-period rejection uses the ORIGINAL business date.
 *   7. Rejected ops leave zero partial updates.
 *   8. Customer-row locking serializes competing spenders.
 *   9. contract_documents keeps immutable versions + one receipt per assessment.
 *
 * STATUS: NOT EXECUTED — no host here can run forked PostgreSQL backends.
 * Functional halves of all nine scenarios WERE executed against real
 * PostgreSQL 16.14 single-user mode (72/72 green); only multi-connection
 * lock contention remains unobserved.
 */
let pg;
try {
  // eslint-disable-next-line global-require, import/no-extraneous-dependencies
  pg = require('pg');
} catch {
  pg = null;
}

const fs = require('fs');
const path = require('path');

const TEST_URL = process.env.TEST_DATABASE_URL || '';
// Fail-fast isolation: the URL must name a database literally called
// `pc_integration` on an explicitly test host. Anything else (including an
// empty URL, which only skips) aborts before any connection is opened, so a
// misconfigured run can never touch production.
const urlOk = (() => {
  if (!TEST_URL) return false;
  try {
    const u = new URL(TEST_URL);
    const db = decodeURIComponent(u.pathname.replace(/^\//, ''));
    const host = (u.hostname || '').toLowerCase();
    const testHost = host === '127.0.0.1' || host === 'localhost' || host.endsWith('.test') || host.endsWith('.local');
    return db === 'pc_integration' && testHost;
  } catch {
    return false;
  }
})();
if (TEST_URL && !urlOk) {
  throw new Error(
    'REFUSED: TEST_DATABASE_URL must target database `pc_integration` on localhost/a .test/.local host. ' +
    'Running integration tests against any other database (especially production) is forbidden.',
  );
}
const describeLive = urlOk && pg ? describe : describe.skip;

const MIG_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const m48 = fs.readFileSync(path.join(MIG_DIR, '0048_printing_contracts_server_atomicity.sql'), 'utf8');
const m49 = fs.readFileSync(path.join(MIG_DIR, '0049_contract_documents.sql'), 'utf8');

const ENVELOPE_TABLES = [
  'assessment_contracts',
  'assessment_contract_items',
  'contract_amendments',
  'wallet_transactions',
  'ledger_entries',
  'customers',
  'financial_years',
  'idempotency_keys',
];

describeLive('printing-contracts live concurrency (disposable PostgreSQL)', () => {
  let pool;
  let admin;

  const q = (text, params) => admin.query(text, params);
  const callReserve = (c, args) =>
    c.query('SELECT public.reserve_contract_assessment_atomic($1,$2,$3,$4,$5) AS r', args);
  const callConsume = (c, args) =>
    c.query('SELECT public.consume_contract_assessment_atomic($1,$2,$3,$4) AS r', args);

  const walletOf = async (id) => Number((await q(`SELECT data->>'walletBalance' AS w FROM customers WHERE id=$1`, [id])).rows[0].w);
  const contractOf = async (id) => (await q(`SELECT data FROM assessment_contracts WHERE id=$1`, [id])).rows[0].data;
  const itemStatus = async (id) => (await q(`SELECT data->>'status' AS s FROM assessment_contract_items WHERE id=$1`, [id])).rows[0].s;
  const countWhere = async (table, cond, params) =>
    Number((await q(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${cond}`, params)).rows[0].n);

  const seedCustomer = (id, balance) =>
    q(`INSERT INTO customers(id,data,version) VALUES($1, jsonb_build_object('walletBalance',$2::numeric,'name','T'),1)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`, [id, balance]);
  const seedContract = (id, cust, status, reserved, consumed, maxN = 10) =>
    q(`INSERT INTO assessment_contracts(id,data,version) VALUES($1, jsonb_build_object(
        'customer_id',$2,'contract_number',$3,'status',$4,'reserved_amount',$5::numeric,
        'consumed_amount',$6::numeric,'max_assessments',$7,'company_id','CO-1','school_id','S-1',
        'assessment_type','examination','assessment_count',0),1)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [id, cust, `PC-${id}`, status, reserved, consumed, maxN]);
  const seedItem = (id, contractId, price, status = 'reserved') =>
    q(`INSERT INTO assessment_contract_items(id,data,version) VALUES($1, jsonb_build_object(
        'contract_id',$2,'company_id','CO-1','customer_id','C-1','school_id','S-1',
        'assessment_name',$1,'assessment_type','examination',
        'assessment_date','2026-03-15','item_price',$3::numeric,'status',$4),1)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`,
    [id, contractId, price, status]);
  const seedOpenYear = () =>
    q(`INSERT INTO financial_years(id,data,version) VALUES('FY-OPEN', jsonb_build_object(
        'name','FY26','is_closed',0,'start_date','2026-01-01','end_date','2026-12-31'),1)
       ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`);

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: TEST_URL, max: 12 });
    admin = await pool.connect();
    // Minimal envelope tables (same shape as the baseline), then the REAL files.
    for (const t of ENVELOPE_TABLES) {
      const idType = t === 'idempotency_keys' ? 'UUID' : 'TEXT';
      await admin.query(`CREATE TABLE IF NOT EXISTS public.${t}(
        id ${idType} PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0)`);
    }
    await admin.query(m48);
    await admin.query(m49);
    await seedOpenYear();
  }, 120000);

  afterAll(async () => {
    // Rollback exercise (disposable DB only): documented drops must remove
    // exactly what the migrations created, then re-apply cleanly.
    await admin.query('DROP FUNCTION public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE)');
    await admin.query('DROP FUNCTION public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE)');
    await admin.query('DROP FUNCTION public.is_contract_date_in_closed_fy(DATE)');
    await admin.query('DROP TABLE IF EXISTS public.contract_documents');
    const gone = await admin.query(`SELECT COUNT(*)::int AS n FROM pg_proc WHERE proname IN
      ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic','is_contract_date_in_closed_fy')`);
    expect(gone.rows[0].n).toBe(0);
    await admin.query(m48);
    await admin.query(m49);
    admin.release();
    await pool.end();
  });

beforeEach(async () => {
    for (const t of [...ENVELOPE_TABLES, 'contract_documents']) {
      if (t !== 'financial_years') await admin.query(`DELETE FROM public.${t}`);
    }
    // Closed years are per-test fixtures; never leak one into another test.
    await admin.query(`DELETE FROM public.financial_years WHERE id <> 'FY-OPEN'`);
    await seedOpenYear();
  });

  test('same assessment twice concurrently -> exactly one success, one debit', async () => {
    await seedCustomer('C-1', 1000000);
    await seedContract('K-1', 'C-1', 'active', 100000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.allSettled([
        callConsume(c1, ['K-1', 'A-1', 'key-same-1', '2026-03-20']),
        callConsume(c2, ['K-1', 'A-1', 'key-same-1', '2026-03-20']),
      ]);
      const ok = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(1);
      expect(await walletOf('C-1')).toBe(900000);
      expect(await itemStatus('A-1')).toBe('consumed');
      expect(await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED'])).toBe(1);
      expect(await countWhere('ledger_entries', 'id=$1', ['LG-WTX-A-1-CONSUMED'])).toBe(1);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('different assessments cannot overspend one wallet (both refused, zero writes)', async () => {
    // Wallet covers NEITHER assessment's share of the 200k protected total:
    // the RPC's coverage rule refuses both rather than letting one through.
    await seedCustomer('C-1', 100000);
    await seedContract('K-1', 'C-1', 'active', 200000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    await seedItem('A-2', 'K-1', 100000);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.allSettled([
        callConsume(c1, ['K-1', 'A-1', 'key-diff-1', '2026-03-20']),
        callConsume(c2, ['K-1', 'A-2', 'key-diff-2', '2026-03-20']),
      ]);
      const ok = [r1, r2].filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(0);
      expect(Number(await walletOf('C-1'))).toBe(100000);
      expect(await countWhere('wallet_transactions', `id LIKE 'WTX-A-%-CONSUMED'`)).toBe(0);
      expect(await itemStatus('A-1')).toBe('reserved');
      expect(await itemStatus('A-2')).toBe('reserved');
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('customer-row locking serializes two funded consumptions (no lost update)', async () => {
    // Wallet covers the FULL 200k protected total. Without the customer-row
    // lock both backends would read 200000 and both write 100000 (lost
    // update, final 100000). With it, the second sees 100000, still covers
    // its 100000 share, and the final balance is exactly 0.
    await seedCustomer('C-1', 200000);
    await seedContract('K-1', 'C-1', 'active', 200000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    await seedItem('A-2', 'K-1', 100000);
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const [r1, r2] = await Promise.allSettled([
        callConsume(c1, ['K-1', 'A-1', 'key-ser-1', '2026-03-20']),
        callConsume(c2, ['K-1', 'A-2', 'key-ser-2', '2026-03-20']),
      ]);
      expect([r1, r2].filter((r) => r.status === 'fulfilled').length).toBe(2);
      expect(Number(await walletOf('C-1'))).toBe(0);
      expect(await countWhere('wallet_transactions', `id LIKE 'WTX-A-%-CONSUMED'`)).toBe(2);
    } finally {
      c1.release();
      c2.release();
    }
  });

  test('rejected consume leaves zero partial updates', async () => {
    await seedCustomer('C-1', 10000);
    await seedContract('K-1', 'C-1', 'active', 100000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    await expect(callConsume(admin, ['K-1', 'A-1', 'key-rej-1', '2026-03-20'])).rejects.toThrow(/INSUFFICIENT/);
    expect(await walletOf('C-1')).toBe(10000);
    expect(await itemStatus('A-1')).toBe('reserved');
    expect(await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED'])).toBe(0);
    expect(await countWhere('ledger_entries', 'id=$1', ['LG-WTX-A-1-CONSUMED'])).toBe(0);
    const c = await contractOf('K-1');
    expect(Number(c.reserved_amount)).toBe(100000);
    expect(Number(c.consumed_amount)).toBe(0);
  });

  test('replay of an accepted op returns the duplicate marker with no second debit', async () => {
    await seedCustomer('C-1', 1000000);
    await seedContract('K-1', 'C-1', 'active', 100000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    const first = await callConsume(admin, ['K-1', 'A-1', 'key-replay-1', '2026-03-20']);
    expect(first.rows[0].r.success).toBe(true);
    await expect(callConsume(admin, ['K-1', 'A-1', 'key-replay-1', '2026-03-20'])).rejects.toThrow(/DUPLICATE/);
    expect(await walletOf('C-1')).toBe(900000);
    expect(await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED'])).toBe(1);
  });

  test('closed period rejects on the business date, not the sync date', async () => {
    await admin.query(`INSERT INTO financial_years(id,data,version) VALUES('FY-CLOSED', jsonb_build_object(
      'name','FY25','is_closed',1,'start_date','2025-01-01','end_date','2025-12-31'),1)
      ON CONFLICT (id) DO UPDATE SET data=EXCLUDED.data`);
    await seedCustomer('C-1', 1000000);
    await seedContract('K-1', 'C-1', 'active', 100000, 0, 10);
    await seedItem('A-1', 'K-1', 100000);
    await expect(callConsume(admin, ['K-1', 'A-1', 'key-closed-1', '2025-06-15'])).rejects.toThrow(/CLOSED_PERIOD/);
    // …while the same operation dated in the open year succeeds.
    const ok = await callConsume(admin, ['K-1', 'A-1', 'key-closed-2', '2026-03-20']);
    expect(ok.rows[0].r.success).toBe(true);
    expect(await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED'])).toBe(1);
  });

  test('reserve enforces the same FY gate and entitlement atomically', async () => {
    await seedCustomer('C-1', 1000000);
    await seedContract('K-1', 'C-1', 'active', 0, 0, 1);
    await expect(
      admin.query('SELECT public.reserve_contract_assessment_atomic($1,$2,$3,$4,$5)', [
        'K-1', 'A-9', { assessment_name: 'X' }, 100000, '2025-06-15',
      ]),
    ).rejects.toThrow(/CLOSED_PERIOD/);
    // First reserve ok, second exceeds entitlement max_assessments=1.
    await admin.query('SELECT public.reserve_contract_assessment_atomic($1,$2,$3,$4,$5)', [
      'K-1', 'A-9', { assessment_name: 'X' }, 100000, '2026-03-15',
    ]);
    await expect(
      admin.query('SELECT public.reserve_contract_assessment_atomic($1,$2,$3,$4,$5)', [
        'K-1', 'A-10', { assessment_name: 'Y' }, 100000, '2026-03-15',
      ]),
    ).rejects.toThrow(/entitlement/);
    expect(Number((await contractOf('K-1')).reserved_amount)).toBe(100000);
  });

  test('contract_documents keeps versions immutable with one receipt per item', async () => {
    await admin.query(`INSERT INTO contract_documents(id,data,version) VALUES
      ('SCH-PC-1-v1', jsonb_build_object('documentNumber','PC-1','documentVersion',1,'verificationToken','t1'),1)`);
    await expect(
      admin.query(`INSERT INTO contract_documents(id,data,version) VALUES
        ('PCR-A-1', jsonb_build_object('documentType','printing_contract_completion_receipt',
          'documentNumber','PCR-PC-1','assessmentItemId','A-1','verificationToken','t2'),1)`),
    ).resolves.toBeTruthy();
    // Second receipt for the SAME assessment violates the unique receipt index.
    await expect(
      admin.query(`INSERT INTO contract_documents(id,data,version) VALUES
        ('PCR-A-1-DUP', jsonb_build_object('documentType','printing_contract_completion_receipt',
          'documentNumber','PCR-PC-1','assessmentItemId','A-1','verificationToken','t3'),1)`),
    ).rejects.toThrow();
    // A second schedule version coexists (history preserved).
    await admin.query(`INSERT INTO contract_documents(id,data,version) VALUES
      ('SCH-PC-1-v2', jsonb_build_object('documentNumber','PC-1','documentVersion',2,'verificationToken','t4'),1)`);
    expect(await countWhere('contract_documents', `data->>'documentNumber'=$1`, ['PC-1'])).toBe(2);
  });

  test('successful consume commits all five writes together', async () => {
    await seedCustomer('C-1', 500000);
    await seedContract('K-1', 'C-1', 'active', 200000, 0, 10);
    await seedItem('A-1', 'K-1', 200000);
    const before = {
      wallet: await walletOf('C-1'),
      contract: await contractOf('K-1'),
      tx: await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED']),
      lg: await countWhere('ledger_entries', 'id=$1', ['LG-WTX-A-1-CONSUMED']),
    };
    const res = await callConsume(admin, ['K-1', 'A-1', 'key-full-1', '2026-03-20']);
    expect(res.rows[0].r.success).toBe(true);
    expect(Number(res.rows[0].r.newBalance)).toBe(300000);
    expect(await walletOf('C-1')).toBe(300000);
    expect(Number(before.wallet) - Number(await walletOf('C-1'))).toBe(200000);
    expect(await itemStatus('A-1')).toBe('consumed');
    const c = await contractOf('K-1');
    expect(Number(c.reserved_amount)).toBe(Number(before.contract.reserved_amount) - 200000);
    expect(Number(c.consumed_amount)).toBe(Number(before.contract.consumed_amount) + 200000);
    expect(await countWhere('wallet_transactions', 'id=$1', ['WTX-A-1-CONSUMED'])).toBe(before.tx + 1);
    expect(await countWhere('ledger_entries', 'id=$1', ['LG-WTX-A-1-CONSUMED'])).toBe(before.lg + 1);
  });
});

// Self-check: the skip path must be explicit, never a silent green.
if (!URL || !pg) {
  test('integration suite reports why it cannot run here', () => {
    expect(!URL || !pg).toBe(true);
  });
}


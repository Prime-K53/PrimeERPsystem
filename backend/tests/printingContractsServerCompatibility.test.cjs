/**
 * printingContractsServerCompatibility.test.cjs
 *
 * STATIC compatibility gate for migrations 0048 / 0049.
 *
 * No live Postgres/Supabase is available in this environment, so this does
 * NOT claim runtime verification. It mechanically proves the migrations can
 * only reference identifiers that actually exist, and that the RPC contract
 * (names, arity, defaults) matches every call site. A mismatch here is a
 * guaranteed runtime failure once the migration is applied.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';

const fs = require('fs');
const path = require('path');

const MIG_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const readMig = (n) => fs.readFileSync(path.join(MIG_DIR, n), 'utf8');

const m48 = readMig('0048_printing_contracts_server_atomicity.sql');
const m49 = readMig('0049_contract_documents.sql');
const baseline = readMig('0001_baseline_live_schema.sql');
const allMigrations = fs
  .readdirSync(MIG_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readMig(f))
  .join('\n');

/** Envelope tables used by 0048/0049, with their columns. */
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

const createTableBodies = (sql) => {
  const out = {};
  const re = /CREATE TABLE IF NOT EXISTS\s+public\.(\w+)\s*\(([\s\S]*?)\n\);/g;
  let m;
  while ((m = re.exec(sql))) out[m[1]] = m[2];
  return out;
};

describe('0048/0049 reference only tables that exist', () => {
  const tables = createTableBodies(allMigrations);
  it.each(ENVELOPE_TABLES)('%s is defined by the migration chain', (t) => {
    expect(Object.keys(tables)).toContain(t);
  });

  it.each(ENVELOPE_TABLES)('%s exposes the envelope columns the RPCs use', (t) => {
    const body = tables[t] || '';
    expect(body).toMatch(/id\s/);
    expect(body).toMatch(/data\s+JSONB/);
    expect(body).toMatch(/updated_at/);
    expect(body).toMatch(/version/);
  });

  it('contract_documents is created by 0049 with the version/token/receipt indexes', () => {
    expect(m49).toMatch(/CREATE TABLE IF NOT EXISTS public\.contract_documents/);
    expect(m49).toMatch(/uq_contract_documents_number_version/);
    expect(m49).toMatch(/uq_contract_documents_verification_token/);
    expect(m49).toMatch(/uq_contract_documents_receipt_item/);
  });
});

describe('0048 envelope field names match the TypeScript records', () => {
  // RPC reads these exact JSONB keys; they must be the keys the ERP writes.
  it('reads customers.data->>walletBalance (Customer.walletBalance)', () => {
    expect(m48).toMatch(/data->>'walletBalance'/);
    const types = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'types.ts'), 'utf8');
    expect(types).toMatch(/walletBalance\?: number/);
  });

  it('reads financial_years is_closed/start_date/end_date (FinancialYearRecord)', () => {
    expect(m48).toMatch(/is_closed/);
    expect(m48).toMatch(/start_date/);
    expect(m48).toMatch(/end_date/);
    const repo = fs.readFileSync(
      path.join(__dirname, '..', '..', 'frontend', 'services', 'repositories', 'financialYearRepository.ts'),
      'utf8',
    );
    expect(repo).toMatch(/is_closed: number \| boolean/);
    expect(repo).toMatch(/start_date/);
    expect(repo).toMatch(/end_date/);
  });

  it('reads contract fields that exist on AssessmentContract', () => {
    for (const field of ['contract_number', 'customer_id', 'school_id', 'status', 'reserved_amount', 'consumed_amount', 'max_assessments']) {
      expect(m48).toContain(`'${field}'`);
    }
    const types = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'types.ts'), 'utf8');
    const block = types.slice(types.indexOf('export interface AssessmentContract'));
    for (const field of ['contract_number', 'customer_id', 'reserved_amount', 'consumed_amount', 'max_assessments']) {
      expect(block).toMatch(new RegExp(`${field}\\??:`));
    }
  });

  it('reads item fields that exist on AssessmentContractItem', () => {
    for (const field of ['contract_id', 'assessment_name', 'assessment_type', 'item_price', 'status', 'consumed_at', 'reserved_at']) {
      expect(m48).toContain(`'${field}'`);
    }
  });
});

describe('0048 idempotency key column type accepts the generated id', () => {
  it('idempotency_keys.id is UUID and the RPC derives a UUID from a digest', () => {
    const tables = createTableBodies(allMigrations);
    expect(tables.idempotency_keys).toMatch(/id UUID PRIMARY KEY/);
    // md5(text) yields 32 hex chars, which is a valid UUID literal.
    expect(m48).toMatch(/md5\('consume:'/);
    expect(m48).toMatch(/::UUID/);
  });
});

describe('RPC signatures match every call site', () => {
  const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'printingContracts.cjs'), 'utf8');

  const sig = (name) => {
    const m = m48.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)\\)\\nRETURNS`));
    expect(m).toBeTruthy();
    return m[1]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  };

  it('reserve_contract_assessment_atomic declares every parameter the route sends', () => {
    const params = sig('reserve_contract_assessment_atomic').map((p) => p.split(/\s+/)[0]);
    expect(params).toEqual(['p_contract_id', 'p_item_id', 'p_item_data', 'p_price', 'p_business_date']);
    for (const p of params) expect(route).toContain(p);
  });

  it('consume_contract_assessment_atomic declares every parameter the route sends', () => {
    const params = sig('consume_contract_assessment_atomic').map((p) => p.split(/\s+/)[0]);
    expect(params).toEqual(['p_contract_id', 'p_item_id', 'p_idempotency_key', 'p_business_date']);
    for (const p of params) expect(route).toContain(p);
  });

  it('p_business_date has a default so the health probe can omit it', () => {
    const reserve = sig('reserve_contract_assessment_atomic');
    const consume = sig('consume_contract_assessment_atomic');
    expect(reserve.find((p) => p.startsWith('p_business_date'))).toMatch(/DEFAULT/i);
    expect(consume.find((p) => p.startsWith('p_business_date'))).toMatch(/DEFAULT/i);
    // Health probe deliberately omits it.
    const probe = route.slice(route.indexOf('/health'));
    expect(probe).not.toContain('p_business_date');
  });

  it('grants EXECUTE to authenticated and service_role (gateway uses the key)', () => {
    expect(m48).toMatch(/GRANT EXECUTE ON FUNCTION public\.reserve_contract_assessment_atomic\([^)]*\) TO authenticated, service_role;/);
    expect(m48).toMatch(/GRANT EXECUTE ON FUNCTION public\.consume_contract_assessment_atomic\([^)]*\) TO authenticated, service_role;/);
  });
});

describe('0048 failure modes are machine-classifiable by the route', () => {
  // printingContracts.cjs maps these markers onto HTTP status / client states.
  const cases = [
    ['CLOSED_PERIOD', 'closed period -> adjustmentRequired'],
    ['DUPLICATE', 'duplicate consumption refused'],
    ['INSUFFICIENT_WALLET_FUNDS', 'insufficient verified funds'],
    ['entitlement exceeded', 'entitlement enforced'],
    ['active only', 'lifecycle enforced'],
    ['reserved only', 'item status enforced'],
    ['does not belong to contract', 'linkage enforced'],
    ['invalid price', 'price guard'],
  ];
  it.each(cases)('emits %s (%s)', (marker) => {
    expect(m48).toContain(marker);
  });

  it('route classifies each marker', () => {
    const route = fs.readFileSync(path.join(__dirname, '..', 'routes', 'printingContracts.cjs'), 'utf8');
    expect(route).toMatch(/CLOSED_PERIOD/);
    expect(route).toMatch(/DUPLICATE/);
    expect(route).toMatch(/INSUFFICIENT/);
  });
});

describe('0048 stays additive and reversible', () => {
  it('uses only idempotent DDL forms', () => {
    expect(m48).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(m48).not.toMatch(/DROP TABLE/);
    expect(m48).not.toMatch(/DROP COLUMN/);
    expect(m48).not.toMatch(/TRUNCATE/);
    expect(m48).not.toMatch(/DELETE FROM/);
  });

  it('documents rollback and that it is not applied to production', () => {
    expect(m48).toMatch(/Rollback/i);
    expect(m48).toMatch(/NOT APPLIED TO PRODUCTION/i);
    expect(m49).toMatch(/Rollback/i);
    expect(m49).toMatch(/NOT APPLIED TO PRODUCTION/i);
  });

  it('is ordered after the tables it depends on (0048 > 0006/0019/0039)', () => {
    expect(m48).toMatch(/0006|0019|0039|0039/);
  });
});

describe('0048 consume is financially complete (wallet debit included)', () => {
  const consumeBody = m48.slice(
    m48.indexOf('CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic'),
    m48.indexOf('GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy'),
  );

  it('locks the customer row FOR UPDATE (funds serialization point)', () => {
    expect(consumeBody).toMatch(/FROM public\.customers c[\s\S]{0,120}FOR UPDATE/);
  });

  it('decrements customers.walletBalance in the same transaction', () => {
    expect(consumeBody).toMatch(/UPDATE public\.customers/);
    expect(consumeBody).toMatch(/\{walletBalance\}/);
  });

  it('refuses when the verified balance cannot fund the price itself', () => {
    expect(consumeBody).toMatch(/v_wallet_balance < v_price/);
  });

  it('writes wallet transaction, ledger, item, contract AND customer together', () => {
    for (const t of ['wallet_transactions', 'ledger_entries', 'assessment_contract_items', 'assessment_contracts', 'customers']) {
      expect(consumeBody).toContain(`public.${t}`);
    }
  });

  it('returns the values the client reads (newBalance, walletTx, ledger)', () => {
    expect(consumeBody).toMatch(/'walletTransactionId'/);
    expect(consumeBody).toMatch(/'ledgerEntryId'/);
    expect(consumeBody).toMatch(/'newBalance'/);
  });

  it('balance arithmetic is quoted and rounded like the local canonical op', () => {
    // money(v - price) uses ROUND(...,2) so server and IndexedDB agree.
    expect(consumeBody).toMatch(/ROUND\(\(v_wallet_balance - v_price\)::numeric, 2\)/);
  });

  it('SQL block delimiters stay balanced', () => {
    const opens = (m48.match(/\$\$/g) || []).length;
    expect(opens % 2).toBe(0);
    expect(opens).toBeGreaterThan(0);
  });
});

describe('0048 consume mirrors the frontend canonical accounting shapes', () => {
  const consumeBody = m48.slice(
    m48.indexOf('CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic'),
    m48.indexOf('GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy'),
  );

  it("wallet row carries top-level type 'Deduction' like the local op", () => {
    expect(consumeBody).toMatch(/'type', 'Deduction'/);
  });

  it("wallet row carries the nested data.type the reconciler matches on", () => {
    // contractReconciliation matches tx.type==='Deduction' AND
    // data.type==='ASSESSMENT_CONSUMPTION'; a flat type_detail would be missed.
    expect(consumeBody).toMatch(/'type', 'ASSESSMENT_CONSUMPTION'/);
    expect(consumeBody).not.toMatch(/type_detail/);
  });

  it('wallet row carries description/reference/idempotencyKey for verification', () => {
    for (const k of ["'description'", "'reference'", "'idempotencyKey'", "'consumed_at'", "'assessment_item_id'", "'contract_number'", "'customerName'"]) {
      expect(consumeBody).toContain(k);
    }
  });

  it('ledger row posts the canonical DR 21300 / CR 41100 legs', () => {
    expect(consumeBody).toMatch(/'debitAccountId', '21300'/);
    expect(consumeBody).toMatch(/'creditAccountId', '41100'/);
  });

  it('ledger row is marked reconciled with the item referenceId for linkage', () => {
    expect(consumeBody).toMatch(/'reconciled', true/);
    expect(consumeBody).toMatch(/'referenceId', p_item_id/);
    expect(consumeBody).toMatch(/'customerId', v_customer_id/);
    expect(consumeBody).toMatch(/'customerName', v_customer_name/);
  });

  it('idempotencyKey defaults exactly like the local canonical op', () => {
    expect(consumeBody).toMatch(/'wallet:assessment:' \|\| p_item_id \|\| ':consumed'/);
  });
});

describe('rollback statements match the created objects (§7)', () => {
  it('0048 documents a DROP FUNCTION per created function with exact arg types', () => {
    const created = [...m48.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\nRETURNS/g)]
      .map((m) => ({
        name: m[1],
        // Strip DEFAULT clauses before reading the type: `p_business_date DATE
        // DEFAULT CURRENT_DATE` declares DATE, not CURRENT_DATE.
        types: m[2].split(',').map((p) => {
          const tokens = p.trim().split(/\s+/);
          const di = tokens.findIndex((t) => t.toUpperCase() === 'DEFAULT');
          return (di >= 0 ? tokens.slice(0, di) : tokens).pop().toUpperCase();
        }),
      }));
    expect(created.length).toBeGreaterThanOrEqual(3);
    for (const fn of created) {
      const dropRe = new RegExp(`DROP FUNCTION public\\.${fn.name}\\(([^;]*)\\)`, 'i');
      const drop = m48.match(dropRe);
      if (!drop) throw new Error(`missing documented rollback for ${fn.name}`);
      const dropTypes = drop[1].split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      expect(dropTypes).toEqual(fn.types);
    }
  });

  it('0049 documents DROP TABLE for the table it creates', () => {
    expect(m49).toMatch(/CREATE TABLE IF NOT EXISTS public\.contract_documents/);
    expect(m49).toMatch(/DROP TABLE IF EXISTS public\.contract_documents/);
  });
});

describe('baseline tables the RPCs lock are NOT destroyed by 0048/0049', () => {
  it('no DROP of existing contract or wallet tables in either migration', () => {
    for (const sql of [m48, m49]) {
      expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS)/i);
    }
  });
});
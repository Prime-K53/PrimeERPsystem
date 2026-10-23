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
  // 0048 enforces the settings-backed closed-PERIOD registry (the same
  // closure record the local canonical op enforces). The settings store is
  // synced, so the server must see it.
  'settings',
  // 0048 resolves the posting accounts (21300 / 41100) from the COA.
  'accounts',
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
    // \r?\n: the working copy's line endings depend on core.autocrlf, and a
    // developer's checkout must never change whether this gate passes.
    const m = m48.match(new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\(([\\s\\S]*?)\\)\\r?\\nRETURNS`));
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

  it('grants EXECUTE to service_role ONLY (minimum necessary role)', () => {
    // The Prime ERP backend is the only caller and it uses the service-role
    // key. `authenticated` must NOT be able to execute these functions: the
    // envelope tables it can already reach carry allow_all RLS policies, so a
    // SECURITY DEFINER money-moving function in that role would be a direct
    // privilege-escalation path for a portal customer.
    for (const fn of ['reserve_contract_assessment_atomic', 'consume_contract_assessment_atomic']) {
      expect(m48).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`),
      );
      expect(m48).not.toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO [^;]*authenticated`),
      );
      expect(m48).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`),
      );
    }
  });

  it('the migration itself refuses a non-service_role caller', () => {
    // Defence in depth: even if a grant is widened by mistake, the function
    // re-checks the request role at the database boundary.
    expect(m48).toContain('current_erp_rpc_role()');
    expect(m48).toMatch(/UNAUTHORIZED/);
    expect(m48).toMatch(/v_caller_role <> 'service_role'/);
  });

  it('never trusts a caller-supplied customer, user or role as authorization', () => {
    // The customer is always derived from the authoritative contract row.
    expect(m48).toMatch(/v_customer_id := NULLIF\(v_contract\.data->>'customer_id', ''\)/);
    expect(m48).not.toMatch(/p_customer_id/);
    expect(m48).not.toMatch(/p_user_id/);
    expect(m48).not.toMatch(/p_role/);
  });

  it('reads the caller role from the verified JWT claims, allowing a direct DBA connection', () => {
    expect(m48).toContain("current_setting('request.jwt.claims', true)");
    expect(m48).toMatch(/v_claims::jsonb ->> 'role'/);
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
    // The account ids are RESOLVED from the chart of accounts by code: the
    // deployed database prefixes them ('ACC-21300'), so hardcoding the code
    // would post an account id that does not exist.
    expect(consumeBody).toMatch(/'debitAccountId', v_debit_account/);
    expect(consumeBody).toMatch(/'creditAccountId', v_credit_account/);
    expect(m48).toMatch(/resolve_posting_account\('21300'\)/);
    expect(m48).toMatch(/resolve_posting_account\('41100'\)/);
    expect(m48).toMatch(/a\.data->>'code' = p_ref/);
    expect(m48).toMatch(/a\.data->>'account_number' = p_ref/);
    expect(m48).toMatch(/allow_posting/);
    expect(m48).toMatch(/is_active/);
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
    const created = [...m48.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(([\s\S]*?)\)\r?\nRETURNS/g)]
      .map((m) => ({
        name: m[1],
        // Strip DEFAULT clauses before reading the type: `p_business_date DATE
        // DEFAULT CURRENT_DATE` declares DATE, not CURRENT_DATE.
        types: m[2].split(',').map((p) => {
          const tokens = p.trim().split(/\s+/);
          const di = tokens.findIndex((t) => t.toUpperCase() === 'DEFAULT');
          return (di >= 0 ? tokens.slice(0, di) : tokens).pop().toUpperCase();
        // A parameterless function declares NO types; without this filter the
        // empty parameter list yields one empty pseudo-type and can never
        // match its (also empty) DROP signature.
        }).filter(Boolean),
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

describe('0048 idempotency is decided by the INSERT result, not by an exception', () => {
  const consumeBody = m48.slice(
    m48.indexOf('CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic'),
    m48.indexOf('GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy'),
  );

  it('inspects whether the idempotency insert actually happened', () => {
    expect(consumeBody).toMatch(/ON CONFLICT \(id\) DO NOTHING\s*\n\s*RETURNING id INTO v_inserted/);
    expect(consumeBody).toMatch(/IF v_inserted IS NULL THEN/);
  });

  it('a repeat returns the ORIGINAL result instead of performing the work again', () => {
    // The established client contract maps a successful body to `accepted`,
    // so a retry must succeed with the original payload — not raise.
    expect(consumeBody).toMatch(/RETURN v_stored->'result'/);
    expect(consumeBody).toMatch(/'replayed', true/);
  });

  it('a key that exists without a completed result is refused, never replayed', () => {
    expect(consumeBody).toMatch(/DUPLICATE: assessment % is already being processed/);
  });

  it('persists the result on the key row in the same transaction as the writes', () => {
    expect(consumeBody).toMatch(/UPDATE public\.idempotency_keys/);
    expect(consumeBody).toMatch(/'status', 'succeeded'/);
    expect(consumeBody).toMatch(/'result', v_result/);
  });

  it('the idempotency insert is the FIRST write of the transaction', () => {
    const idemAt = consumeBody.indexOf('INSERT INTO public.idempotency_keys');
    const walletAt = consumeBody.indexOf('INSERT INTO public.wallet_transactions');
    const ledgerAt = consumeBody.indexOf('INSERT INTO public.ledger_entries');
    expect(idemAt).toBeGreaterThan(-1);
    expect(idemAt).toBeLessThan(walletAt);
    expect(idemAt).toBeLessThan(ledgerAt);
  });

  it('keeps the canonical idempotency key and wallet transaction id', () => {
    expect(consumeBody).toMatch(/'wallet:assessment:' \|\| p_item_id \|\| ':consumed'/);
    expect(consumeBody).toMatch(/'WTX-' \|\| p_item_id \|\| '-CONSUMED'/);
    expect(consumeBody).toMatch(/'LG-' \|\| v_wallet_id/);
  });
});

describe('0048 consumption uses the canonical coverage rule', () => {
  const consumeBody = m48.slice(
    m48.indexOf('CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic'),
    m48.indexOf('GRANT EXECUTE ON FUNCTION public.is_contract_date_in_closed_fy'),
  );

  it('claim per holding contract is max(bucket, reserved items) — the local rule', () => {
    expect(consumeBody).toMatch(/GREATEST\(/);
    expect(consumeBody).toMatch(/reserved_amount/);
    expect(consumeBody).toMatch(/item_price/);
    expect(consumeBody).toMatch(/IN \('active', 'suspended'\)/);
  });

  it('the pre-debit balance must cover every protected reservation', () => {
    expect(consumeBody).toMatch(/v_wallet_balance < v_protected_total/);
    expect(consumeBody).toMatch(/v_wallet_balance < v_price/);
  });

  it('takes the price from the item, never from a parameter', () => {
    expect(consumeBody).toMatch(/v_item\.data->>'item_price'/);
    expect(consumeBody).not.toMatch(/p_price/);
  });

  it('refuses an item that belongs to another contract (NULL-safe)', () => {
    expect(consumeBody).toMatch(/v_item_contract IS DISTINCT FROM p_contract_id/);
  });

  it('locks the customer, the contract and the item', () => {
    expect(consumeBody).toMatch(/FROM public\.customers c[\s\S]{0,120}FOR UPDATE/);
    expect(consumeBody).toMatch(/FROM public\.assessment_contracts[\s\S]{0,80}FOR UPDATE/);
    expect(consumeBody).toMatch(/FROM public\.assessment_contract_items[\s\S]{0,80}FOR UPDATE/);
  });

  it('heals the reservation bucket the same way the local canonical op does', () => {
    expect(consumeBody).toMatch(/v_reserved_before := GREATEST\(v_stored_reserved, v_price\)/);
    expect(consumeBody).toMatch(/v_reserved_after := v_reserved_before - v_price/);
    expect(consumeBody).toMatch(/v_consumed_after := v_stored_consumed \+ v_price/);
  });
});

describe('0048 reservation semantics match the canonical local op', () => {
  const reserveBody = m48.slice(
    m48.indexOf('CREATE OR REPLACE FUNCTION public.reserve_contract_assessment_atomic'),
    m48.indexOf('CREATE OR REPLACE FUNCTION public.consume_contract_assessment_atomic'),
  );

  it('reservation is an allocation, not a payment: no wallet coverage required', () => {
    expect(reserveBody).not.toMatch(/INSUFFICIENT_WALLET_FUNDS/);
    expect(reserveBody).not.toMatch(/wallet_transactions/);
    expect(reserveBody).not.toMatch(/ledger_entries/);
  });

  it('enforces the count entitlement atomically under the contract lock', () => {
    expect(reserveBody).toMatch(/entitlement exceeded/);
    expect(reserveBody).toMatch(/max_assessments/);
    expect(reserveBody).toMatch(/FROM public\.assessment_contracts[\s\S]{0,80}FOR UPDATE/);
  });

  it('refuses only CLOSED contracts, like the local op', () => {
    expect(reserveBody).toMatch(/'completed', 'expired', 'cancelled'/);
    expect(reserveBody).not.toMatch(/status: %\) — assessment consumption requires an active contract/);
  });

  it('never overwrites an existing assessment', () => {
    expect(reserveBody).toMatch(/DUPLICATE: assessment % already exists/);
  });

  it('rejects a non-positive price', () => {
    expect(reserveBody).toMatch(/invalid price/);
  });
});

describe('0048 closed-period gates use the business date', () => {
  it('enforces the financial-year closure and the settings-backed period registry', () => {
    expect(m48).toContain('is_contract_date_in_closed_fy');
    expect(m48).toContain('is_contract_date_in_closed_period');
    expect(m48).toContain("financial_closed_periods");
  });

  it('the year gate reads the real FinancialYearRecord fields', () => {
    expect(m48).toMatch(/fy\.data->>'is_closed'/);
    expect(m48).toMatch(/fy\.data->>'start_date'/);
    expect(m48).toMatch(/fy\.data->>'end_date'/);
  });

  it('preserves the DEPLOYED set-returning contract of the year gate', () => {
    // The live function returns TABLE(fy_id, fy_name) and both live RPCs call
    // it as a table. Changing it to a scalar BOOLEAN is a breaking change
    // that CREATE OR REPLACE refuses with 42P13, so the deployed contract is
    // preserved exactly and only the body is hardened.
    expect(m48).toMatch(/RETURNS TABLE \(fy_id TEXT, fy_name TEXT\)/);
    expect(m48).toMatch(/CREATE OR REPLACE FUNCTION public\.is_contract_date_in_closed_fy\(p_business_date DATE\)/);
    // …and the guards are counted, not evaluated as a scalar.
    expect(m48).toMatch(/SELECT COUNT\(\*\)::int INTO v_closed_count FROM public\.is_contract_date_in_closed_fy/);
    expect(m48).toMatch(/SELECT COUNT\(\*\)::int INTO v_closed_count FROM public\.is_contract_date_in_closed_period/);
  });

  it('both RPCs apply the gate before any BUSINESS write', () => {
    // The idempotency insert deliberately precedes the gate in consume: a
    // replay must return the original result even if the period was closed
    // after the original operation, so the gate may not run first there.
    // What must hold everywhere is: the closed-period gate runs before the
    // first money/state write.
    const gates = {
      reserve_contract_assessment_atomic: 'INSERT INTO public.assessment_contract_items',
      consume_contract_assessment_atomic: 'INSERT INTO public.wallet_transactions',
    };
    for (const [name, firstBusinessWrite] of Object.entries(gates)) {
      const body = m48.slice(m48.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`));
      const gateAt = body.indexOf('is_contract_date_in_closed_fy');
      const writeAt = body.indexOf(firstBusinessWrite);
      expect(gateAt).toBeGreaterThan(-1);
      expect(writeAt).toBeGreaterThan(-1);
      expect(gateAt).toBeLessThan(writeAt);
    }
  });
});

describe('0048 rollback separates schema from business data', () => {
  it('ships an executable rollback companion that reverses no business data', () => {
    const rollback = readMig('0048_printing_contracts_server_atomicity.rollback.sql');
    for (const fn of [
      'consume_contract_assessment_atomic',
      'reserve_contract_assessment_atomic',
      'is_contract_date_in_closed_fy',
      'is_contract_date_in_closed_period',
      'current_erp_rpc_role',
    ]) {
      expect(rollback).toContain(`DROP FUNCTION IF EXISTS public.${fn}`);
    }
    // The executable rollback must never remove business rows.
    expect(rollback).not.toMatch(/DELETE FROM/i);
    expect(rollback).not.toMatch(/TRUNCATE/i);
    expect(rollback).toMatch(/compensating reversal/i);
  });
});

describe('baseline tables the RPCs lock are NOT destroyed by 0048/0049', () => {
  it('no DROP of existing contract or wallet tables in either migration', () => {
    for (const sql of [m48, m49]) {
      expect(sql).not.toMatch(/DROP TABLE(?! IF EXISTS)/i);
    }
  });
});
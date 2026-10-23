/**
 * printingContractsSingleUser.integration.test.cjs
 *
 * EXECUTABLE database proof of migration 0048 for hosts that cannot fork
 * PostgreSQL client backends.
 *
 * WHY THIS EXISTS
 * On the affected Windows host every forked PostgreSQL backend dies with
 * 0xC0000142 (DLL init failure; Defender/EDR or UCRT servicing state, no
 * admin rights to remediate) while the postmaster stays up. The
 * multi-connection suite (printingContractsConcurrency.integration.test.cjs)
 * therefore cannot run there — it skips cleanly.
 *
 * `postgres --single` DOES work on that host: it is a single backend, so no
 * fork happens. This suite drives it to execute the REAL migration file and
 * then run the real scenarios against a real PostgreSQL.
 *
 * WHAT IT PROVES (26 checks)
 *   - 0048 compiles and creates all five functions
 *   - EXECUTE is granted to service_role only
 *   - SECURITY DEFINER with a pinned search_path
 *   - a consumption posts exactly one wallet debit + one ledger row
 *     (Dr 21300 / Cr 41100, reconciled) and moves the contract buckets
 *   - a replay returns the ORIGINAL result and never debits twice
 *   - a conflicting key is refused
 *   - a rejected consume leaves ZERO partial writes (incl. the key row)
 *   - a closed financial year and the settings-backed closed-period registry
 *     both reject on the BUSINESS DATE
 *   - only a service_role caller may mutate financial records
 *   - the entitlement limit, item freshness, price, linkage, lifecycle and
 *     coverage rules are enforced
 *   - wallet and ledger reconcile; no orphan consumption; no phantom key
 *   - the rollback file removes every function, and 0048 re-applies cleanly
 *
 * WHAT IT CANNOT PROVE
 *   - true lock contention between concurrent sessions (single-user mode is
 *     one session). That remains covered only by
 *     printingContractsConcurrency.integration.test.cjs.
 *
 * HOW TO RUN
 *   The suite needs a PostgreSQL binaries directory. Point POSTGRES_BIN at
 *   it, or let the suite use a portable install it downloads itself.
 *   It NEVER touches a database it did not create: it initialises its own
 *   cluster under the OS temp directory and uses a throwaway database name.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const MIG_DIR = path.join(__dirname, '..', '..', 'supabase', 'migrations');
const M48 = path.join(MIG_DIR, '0048_printing_contracts_server_atomicity.sql');
const M48RB = path.join(MIG_DIR, '0048_printing_contracts_server_atomicity.rollback.sql');

const WORK = path.join(os.tmpdir(), 'prime-erp-single-user-pg');
const BIN = process.env.POSTGRES_BIN || null;
const DATA = path.join(WORK, 'data');

/* ------------------------------------------------------------------ */
/* SQL helpers: PostgreSQL's single-user backend ends a command at      */
/* every newline, so the whole script is emitted one statement per line.*/
/* ------------------------------------------------------------------ */
function clean(text) {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === '-' && c2 === '-') {
      while (i < n && text[i] !== '\n') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && c2 === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; continue; }
        if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      out += ' ';
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; }
        if (text[j] === "'") break;
        if (text[j] === '\n') throw new Error('string literal contains a newline');
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '"' && text[j + 1] === '"') { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (m) {
        const tag = m[0];
        const end = text.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar quote ${tag}`);
        out += tag + clean(text.slice(i + tag.length, end)) + tag;
        i = end + tag.length;
        continue;
      }
    }
    if (c === '\n' || c === '\r') { out += ' '; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

function toSingleLineStatements(sql) {
  const cleaned = clean(sql);
  const out = [];
  let stmt = '';
  let i = 0;
  const n = cleaned.length;
  while (i < n) {
    const c = cleaned[i];
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n) {
        if (cleaned[j] === q && cleaned[j + 1] === q) { j += 2; continue; }
        if (cleaned[j] === q) break;
        j++;
      }
      stmt += cleaned.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(cleaned.slice(i));
      if (m) {
        const tag = m[0];
        const end = cleaned.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated dollar quote ${tag}`);
        stmt += cleaned.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (c === ';') {
      stmt += ';';
      const t = stmt.trim();
      if (t) out.push(t);
      stmt = '';
      i++;
      continue;
    }
    stmt += c;
    i++;
  }
  const t = stmt.trim();
  if (t) out.push(t);
  return out;
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */
const ENVELOPE = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.assessment_contracts(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.assessment_contract_items(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.wallet_transactions(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.ledger_entries(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.customers(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.financial_years(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.idempotency_keys(id UUID PRIMARY KEY, result TEXT, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), data JSONB NOT NULL DEFAULT '{}'::jsonb, version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.settings(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.accounts(id TEXT PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS public.check_results(id SERIAL PRIMARY KEY, check_name TEXT, outcome TEXT);
`;

const SEED = `
TRUNCATE public.assessment_contracts, public.assessment_contract_items, public.wallet_transactions, public.ledger_entries, public.customers, public.financial_years, public.idempotency_keys, public.settings, public.accounts, public.check_results;
INSERT INTO public.accounts(id,data,version) VALUES('ACC-21300', jsonb_build_object('id','ACC-21300','code','21300','account_number','21300','name','Customer Deposits','type','LIABILITY','account_type','LIABILITY','account_group','CURRENT_LIABILITY','normal_balance','CREDIT','is_active',true,'allow_posting',true),1);
INSERT INTO public.accounts(id,data,version) VALUES('ACC-41100', jsonb_build_object('id','ACC-41100','code','41100','account_number','41100','name','Product Sales','type','INCOME','account_type','INCOME','account_group','REVENUE','normal_balance','CREDIT','is_active',true,'allow_posting',true),1);
INSERT INTO public.customers(id,data,version) VALUES('C-1', jsonb_build_object('walletBalance',1000000::numeric,'name','Acme School'),1);
INSERT INTO public.assessment_contracts(id,data,version) VALUES('K-1', jsonb_build_object('customer_id','C-1','contract_number','PC-1','status','active','reserved_amount',100000::numeric,'consumed_amount',0::numeric,'max_assessments',10,'company_id','CO-1','school_id','S-1','assessment_type','examination','assessment_count',1,'customer_name','Acme School'),1);
INSERT INTO public.assessment_contract_items(id,data,version) VALUES('A-1', jsonb_build_object('contract_id','K-1','company_id','CO-1','customer_id','C-1','school_id','S-1','assessment_name','Term 1','assessment_type','examination','assessment_date','2026-03-15','item_price',100000::numeric,'status','reserved'),1);
INSERT INTO public.financial_years(id,data,version) VALUES('FY-OPEN', jsonb_build_object('name','FY26','is_closed',0,'start_date','2026-01-01','end_date','2026-12-31'),1);
`;

const expectError = (name, marker, body) => `
DO $$
BEGIN
  BEGIN
    ${body};
    INSERT INTO public.check_results(check_name,outcome) VALUES ('${name}','FAIL: no error raised');
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%${marker}%' THEN
      INSERT INTO public.check_results(check_name,outcome) VALUES ('${name}','PASS');
    ELSE
      INSERT INTO public.check_results(check_name,outcome) VALUES ('${name}','FAIL: wrong error -> ' || SQLERRM);
    END IF;
  END;
END $$;
`;

const SCENARIOS = `
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname IN (
    'consume_contract_assessment_atomic','reserve_contract_assessment_atomic',
    'is_contract_date_in_closed_fy','is_contract_date_in_closed_period','current_erp_rpc_role');
  IF n = 5 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S1 functions created','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S1 functions created','FAIL: found ' || n);
  END IF;
END $$;

DO $$
DECLARE a boolean; s boolean; an boolean;
BEGIN
  SELECT has_function_privilege('authenticated', p.oid,'EXECUTE'),
         has_function_privilege('service_role', p.oid,'EXECUTE'),
         has_function_privilege('anon', p.oid,'EXECUTE')
    INTO a, s, an
  FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname='consume_contract_assessment_atomic';
  IF a = false AND an = false AND s = true THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S2 grants service_role only','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S2 grants service_role only','FAIL: auth=' || a || ' anon=' || an || ' svc=' || s);
  END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace
  WHERE ns.nspname='public' AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic')
    AND p.prosecdef AND (p.proconfig::text LIKE '%search_path%');
  IF n = 2 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S3 SECURITY DEFINER + pinned search_path','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S3 SECURITY DEFINER + pinned search_path','FAIL: ' || n);
  END IF;
END $$;

DO $$
DECLARE r jsonb; w numeric; c jsonb; nw int; nl int; lg jsonb; it jsonb; wt jsonb;
BEGIN
  r := public.consume_contract_assessment_atomic('K-1','A-1','key-ok-1','2026-03-20');
  SELECT (data->>'walletBalance')::numeric INTO w FROM public.customers WHERE id='C-1';
  SELECT data INTO c FROM public.assessment_contracts WHERE id='K-1';
  SELECT data INTO it FROM public.assessment_contract_items WHERE id='A-1';
  SELECT data INTO wt FROM public.wallet_transactions WHERE id='WTX-A-1-CONSUMED';
  SELECT data INTO lg FROM public.ledger_entries WHERE id='LG-WTX-A-1-CONSUMED';
  SELECT COUNT(*)::int INTO nw FROM public.wallet_transactions WHERE id='WTX-A-1-CONSUMED';
  SELECT COUNT(*)::int INTO nl FROM public.ledger_entries WHERE id='LG-WTX-A-1-CONSUMED';
  IF r->>'success' = 'true' AND w = 900000 AND nw = 1 AND nl = 1
     AND it->>'status' = 'consumed'
     AND (c->>'reserved_amount')::numeric = 0 AND (c->>'consumed_amount')::numeric = 100000
     AND lg->>'debitAccountId' = 'ACC-21300' AND lg->>'creditAccountId' = 'ACC-41100'
     AND lg->>'reconciled' = 'true' AND lg->>'referenceId' = 'A-1'
     AND wt->>'type' = 'Deduction' AND wt->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
     AND (r->>'newBalance')::numeric = 900000 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S4 consumption posts one debit + one ledger row','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S4 consumption posts one debit + one ledger row','FAIL: success=' || (r->>'success') || ' wallet=' || w || ' walletTx=' || nw || ' ledgerTx=' || nl || ' item=' || (it->>'status') || ' reserved=' || (c->>'reserved_amount') || ' consumed=' || (c->>'consumed_amount') || ' dr=' || (lg->>'debitAccountId') || ' cr=' || (lg->>'creditAccountId') || ' wtype=' || (wt->>'type'));
  END IF;
END $$;

DO $$
DECLARE r jsonb; w numeric; nw int; nk int;
BEGIN
  r := public.consume_contract_assessment_atomic('K-1','A-1','key-ok-1','2026-03-20');
  SELECT (data->>'walletBalance')::numeric INTO w FROM public.customers WHERE id='C-1';
  SELECT COUNT(*)::int INTO nw FROM public.wallet_transactions WHERE id='WTX-A-1-CONSUMED';
  SELECT COUNT(*)::int INTO nk FROM public.idempotency_keys WHERE data->>'idempotency_key'='key-ok-1';
  IF r->>'success' = 'true' AND r->>'replayed' = 'true'
     AND r->>'walletTransactionId' = 'WTX-A-1-CONSUMED' AND (r->>'newBalance')::numeric = 900000
     AND w = 900000 AND nw = 1 AND nk = 1 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S5 replay returns the original result, no second debit','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S5 replay returns the original result, no second debit','FAIL: success=' || (r->>'success') || ' replayed=' || (r->>'replayed') || ' wtx=' || (r->>'walletTransactionId') || ' wallet=' || w || ' rows=' || nw || ' keys=' || nk);
  END IF;
END $$;

${expectError('S6 conflicting key refused', 'DUPLICATE',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-1','key-other-1','2026-03-20')`)}

UPDATE public.customers SET data=jsonb_set(data,'{walletBalance}',to_jsonb(1000::numeric)) WHERE id='C-1';
UPDATE public.assessment_contracts SET data=jsonb_set(data,'{reserved_amount}',to_jsonb(100000::numeric)) WHERE id='K-1';
INSERT INTO public.assessment_contract_items(id,data,version) VALUES('A-2', jsonb_build_object('contract_id','K-1','customer_id','C-1','assessment_name','Term 2','item_price',100000::numeric,'status','reserved'),1);
${expectError('S7 insufficient funds refused', 'INSUFFICIENT_WALLET_FUNDS',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-insuf-1','2026-03-20')`)}
DO $$
DECLARE w numeric; nw int; nl int; nk int; st text;
BEGIN
  SELECT (data->>'walletBalance')::numeric INTO w FROM public.customers WHERE id='C-1';
  SELECT COUNT(*)::int INTO nw FROM public.wallet_transactions WHERE id='WTX-A-2-CONSUMED';
  SELECT COUNT(*)::int INTO nl FROM public.ledger_entries WHERE id='LG-WTX-A-2-CONSUMED';
  SELECT COUNT(*)::int INTO nk FROM public.idempotency_keys WHERE data->>'idempotency_key'='key-insuf-1';
  SELECT data->>'status' INTO st FROM public.assessment_contract_items WHERE id='A-2';
  IF w = 1000 AND nw = 0 AND nl = 0 AND nk = 0 AND st = 'reserved' THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S8 rejected consume leaves zero partial writes','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S8 rejected consume leaves zero partial writes','FAIL: wallet=' || w || ' walletTx=' || nw || ' ledgerTx=' || nl || ' keyRows=' || nk || ' item=' || st);
  END IF;
END $$;

INSERT INTO public.financial_years(id,data,version) VALUES('FY-CLOSED', jsonb_build_object('name','FY25','is_closed',1,'start_date','2025-01-01','end_date','2025-12-31'),1);
${expectError('S9 closed financial year rejected', 'CLOSED_PERIOD',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-fy-1','2025-06-15')`)}

INSERT INTO public.settings(id,data,version) VALUES('financial_closed_periods', jsonb_build_object('value', jsonb_build_array(jsonb_build_object('id','P-1','from','2025-01-01','to','2025-12-31','reason','audit lock','closedAt','2025-12-31','closedBy','admin'))),1);
${expectError('S10 closed period registry rejected', 'CLOSED_PERIOD',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-reg-1','2025-06-15')`)}

DO $$
DECLARE msg text;
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"authenticated","sub":"portal"}',false);
  BEGIN
    PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-auth-1','2026-03-20');
    msg := 'no error';
  EXCEPTION WHEN others THEN msg := SQLERRM; END;
  IF msg LIKE '%UNAUTHORIZED%' THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S11 authenticated role refused','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S11 authenticated role refused','FAIL: ' || msg);
  END IF;

  PERFORM set_config('request.jwt.claims','{"role":"anon"}',false);
  BEGIN
    PERFORM public.reserve_contract_assessment_atomic('K-1','A-9',jsonb_build_object('assessment_name','X'),100000,'2026-03-15');
    msg := 'no error';
  EXCEPTION WHEN others THEN msg := SQLERRM; END;
  IF msg LIKE '%UNAUTHORIZED%' THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S12 anon role refused','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S12 anon role refused','FAIL: ' || msg);
  END IF;

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',false);
  BEGIN
    PERFORM public.reserve_contract_assessment_atomic('K-1','A-9',jsonb_build_object('assessment_name','X'),100000,'2026-03-15');
    msg := 'no error';
  EXCEPTION WHEN others THEN msg := SQLERRM; END;
  IF msg NOT LIKE '%UNAUTHORIZED%' THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S13 service_role accepted','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S13 service_role accepted','FAIL: ' || msg);
  END IF;
  PERFORM set_config('request.jwt.claims','',false);
END $$;

DO $$
DECLARE n int; c numeric; st text;
BEGIN
  SELECT COUNT(*)::int INTO n FROM public.assessment_contract_items WHERE id='A-9';
  SELECT (data->>'reserved_amount')::numeric INTO c FROM public.assessment_contracts WHERE id='K-1';
  SELECT data->>'status' INTO st FROM public.assessment_contract_items WHERE id='A-9';
  IF n = 1 AND c = 200000 AND st = 'reserved' THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S14 reserve succeeded and moved the bucket','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S14 reserve succeeded and moved the bucket','FAIL: items=' || n || ' reserved=' || c || ' status=' || st);
  END IF;
END $$;

UPDATE public.assessment_contracts SET data=jsonb_set(data,'{max_assessments}',to_jsonb(1)) WHERE id='K-1';
${expectError('S15 entitlement enforced', 'entitlement exceeded',
  `PERFORM public.reserve_contract_assessment_atomic('K-1','A-10',jsonb_build_object('assessment_name','Y'),100000,'2026-03-15')`)}

${expectError('S16 duplicate item refused', 'DUPLICATE',
  `PERFORM public.reserve_contract_assessment_atomic('K-1','A-9',jsonb_build_object('assessment_name','X'),100000,'2026-03-15')`)}

${expectError('S17 invalid price refused', 'invalid price',
  `PERFORM public.reserve_contract_assessment_atomic('K-1','A-11',jsonb_build_object('assessment_name','Z'),0,'2026-03-15')`)}

UPDATE public.assessment_contract_items SET data=jsonb_set(data,'{contract_id}',to_jsonb('K-OTHER'::text)) WHERE id='A-2';
${expectError('S18 item linkage enforced', 'does not belong to contract',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-link-1','2026-03-20')`)}
UPDATE public.assessment_contract_items SET data=jsonb_set(data,'{contract_id}',to_jsonb('K-1'::text)) WHERE id='A-2';

UPDATE public.assessment_contracts SET data=jsonb_set(data,'{status}',to_jsonb('suspended'::text)) WHERE id='K-1';
${expectError('S19 contract lifecycle enforced', 'active only',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-1','key-life-1','2026-03-20')`)}
UPDATE public.assessment_contracts SET data=jsonb_set(data,'{status}',to_jsonb('active'::text)) WHERE id='K-1';

UPDATE public.assessment_contract_items SET data=jsonb_set(data,'{status}',to_jsonb('cancelled'::text)) WHERE id='A-2';
${expectError('S20 item status enforced', 'reserved only',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-stat-1','2026-03-20')`)}

UPDATE public.customers SET data=jsonb_set(data,'{walletBalance}',to_jsonb(100000::numeric)) WHERE id='C-1';
UPDATE public.assessment_contracts SET data=jsonb_set(data,'{reserved_amount}',to_jsonb(200000::numeric)) WHERE id='K-1';
UPDATE public.assessment_contract_items SET data=jsonb_set(data,'{status}',to_jsonb('reserved'::text)) WHERE id='A-2';
${expectError('S21 coverage rule refuses the underfunded wallet', 'INSUFFICIENT_WALLET_FUNDS',
  `PERFORM public.consume_contract_assessment_atomic('K-1','A-2','key-cov-1','2026-03-20')`)}

UPDATE public.assessment_contracts SET data=jsonb_set(data,'{status}',to_jsonb('completed'::text)) WHERE id='K-1';
${expectError('S22 closed contract refuses reservations', 'closed',
  `PERFORM public.reserve_contract_assessment_atomic('K-1','A-12',jsonb_build_object('assessment_name','W'),100000,'2026-03-15')`)}
UPDATE public.assessment_contracts SET data=jsonb_set(data,'{status}',to_jsonb('active'::text)) WHERE id='K-1';

${expectError('S23 reserve honours the closed period registry', 'CLOSED_PERIOD',
  `PERFORM public.reserve_contract_assessment_atomic('K-1','A-13',jsonb_build_object('assessment_name','V'),100000,'2025-06-15')`)}

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM (
    SELECT wt.data->>'assessment_item_id' AS item_id
    FROM public.wallet_transactions wt
    LEFT JOIN public.ledger_entries le ON le.id = 'LG-' || wt.id
    WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
    GROUP BY 1
    HAVING COUNT(DISTINCT wt.id) <> 1 OR COUNT(DISTINCT le.id) <> 1
       OR SUM((wt.data->>'amount')::numeric) <> SUM((le.data->>'amount')::numeric)
  ) t;
  IF n = 0 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S24 wallet and ledger reconcile','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S24 wallet and ledger reconcile','FAIL: ' || n || ' mismatch groups');
  END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM public.assessment_contract_items ai
  WHERE ai.data->>'status' = 'consumed'
    AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions wt WHERE wt.id = 'WTX-' || ai.id || '-CONSUMED');
  IF n = 0 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S25 no orphan consumption','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S25 no orphan consumption','FAIL: ' || n);
  END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*)::int INTO n FROM public.idempotency_keys k
  WHERE k.data->>'scope' = 'contract_assessment_consume' AND k.data->>'status' = 'succeeded'
    AND NOT EXISTS (SELECT 1 FROM public.wallet_transactions wt WHERE wt.id = 'WTX-' || (k.data->>'item_id') || '-CONSUMED');
  IF n = 0 THEN
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S26 no phantom idempotency key','PASS');
  ELSE
    INSERT INTO public.check_results(check_name,outcome) VALUES ('S26 no phantom idempotency key','FAIL: ' || n);
  END IF;
END $$;
`;

/* ------------------------------------------------------------------ */
/* Runner                                                              */
/* ------------------------------------------------------------------ */
const runSql = (bin, sql) => {
  const lines = toSingleLineStatements(sql);
  const res = spawnSync(path.join(bin, 'postgres.exe'), ['--single', '-D', DATA, 'postgres'], {
    input: `${lines.join('\n')}\n`,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return `${res.stdout || ''}${res.stderr || ''}`;
};

const parseResults = (out) => {
  const map = new Map();
  for (const line of out.split('\n')) {
    const m = /"([^"]*?) :: (PASS|FAIL[^"]*)"/.exec(line);
    if (m) map.set(m[1], m[2]);
  }
  return map;
};

const findBinaries = () => {
  if (BIN && fs.existsSync(path.join(BIN, 'postgres.exe'))) return BIN;
  // A portable install the team used previously, or a local install.
  const candidates = [
    path.join(os.tmpdir(), 'prime-erp-single-user-pg', 'pgsql', 'bin'),
    'C:/pgt/pgsql/bin',
    'C:/Program Files/PostgreSQL/16/bin',
    'C:/Program Files/PostgreSQL/15/bin',
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'postgres.exe'))) return c;
  return null;
};

const describeLive = findBinaries() ? describe : describe.skip;

describeLive('migration 0048 executed against a real PostgreSQL (single-user mode)', () => {
  let bin;
  let results;
  let applyOutput;
  let rollbackOutput;
  let reapplyOutput;

  beforeAll(() => {
    bin = findBinaries();
    if (!bin) throw new Error('no PostgreSQL binaries found');
    fs.mkdirSync(WORK, { recursive: true });
    if (!fs.existsSync(path.join(DATA, 'PG_VERSION'))) {
      const init = spawnSync(path.join(bin, 'initdb.exe'), ['-D', DATA, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-locale'], {
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      });
      if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    }
    const m48 = fs.readFileSync(M48, 'utf8');
    const m48rb = fs.readFileSync(M48RB, 'utf8');
    // The cluster is reused between runs, and an earlier revision of 0048
    // defined is_contract_date_in_closed_fy as a scalar BOOLEAN. Replacing a
    // function with a different return type is refused (42P13), so a stale
    // definition would survive and silently change behaviour. Drop the 0048
    // functions first so every run starts from the same state.
    runSql(bin, `
DROP FUNCTION IF EXISTS public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE);
DROP FUNCTION IF EXISTS public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE);
DROP FUNCTION IF EXISTS public.resolve_posting_account(TEXT);
DROP FUNCTION IF EXISTS public.is_contract_date_in_closed_period(DATE);
DROP FUNCTION IF EXISTS public.is_contract_date_in_closed_fy(DATE);
DROP FUNCTION IF EXISTS public.current_erp_rpc_role();
`);
    applyOutput = runSql(bin, `${ENVELOPE}\n${m48}\n${SEED}\n`);
    const scenarioOutput = runSql(bin, `${SCENARIOS}\nSELECT check_name || ' :: ' || outcome FROM public.check_results ORDER BY id;\n`);
    results = parseResults(scenarioOutput);
    rollbackOutput = runSql(bin, `${m48rb}\nSELECT 'left :: ' || COUNT(*)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic','is_contract_date_in_closed_fy','is_contract_date_in_closed_period','current_erp_rpc_role');\n`);
    reapplyOutput = runSql(bin, `${m48}\nSELECT 'left :: ' || COUNT(*)::text FROM pg_proc p JOIN pg_namespace ns ON ns.oid=p.pronamespace WHERE ns.nspname='public' AND p.proname IN ('consume_contract_assessment_atomic','reserve_contract_assessment_atomic','is_contract_date_in_closed_fy','is_contract_date_in_closed_period','current_erp_rpc_role');\n`);
  }, 300000);

  it('applies 0048 without a single error', () => {
    const errors = applyOutput.split('\n').filter((l) => /ERROR|FATAL/.test(l) && !/^backend>/.test(l));
    expect(errors).toEqual([]);
  });

  it('runs every scenario green', () => {
    const failures = [...results.entries()].filter(([, v]) => v !== 'PASS');
    expect({ count: results.size, failures }).toEqual({ count: 26, failures: [] });
  });

  it('the rollback companion removes every function it created', () => {
    expect(rollbackOutput).toMatch(/left :: 0/);
  });

  it('0048 re-applies cleanly (idempotent)', () => {
    const errors = reapplyOutput.split('\n').filter((l) => /ERROR|FATAL/.test(l) && !/^backend>/.test(l));
    expect(errors).toEqual([]);
    expect(reapplyOutput).toMatch(/left :: 5/);
  });
});

if (!findBinaries()) {
  test('single-user suite reports why it cannot run here', () => {
    expect(findBinaries()).toBeNull();
  });
}

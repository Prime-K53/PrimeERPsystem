/**
 * Phase 4 — Transport Budget Event Ledger: registration + scope-guard tests.
 *
 * Verifies (without booting express) that:
 *   1. The sync gateway allow-list includes `transport_budget_events`
 *      exactly once (offline -> queue -> server path).
 *   2. Migration 0029 creates the table with the append-only contract:
 *      RLS enabled, SELECT + INSERT policies only (no UPDATE/DELETE),
 *      idempotency uniqueness, reversal-cap + immutability triggers,
 *      realtime membership, and NO tenant/organization/company columns.
 *   3. All frontend sync registrations exist (db.ts store + cloud map +
 *      pull list, cloudDb map, repositories index map).
 *   4. Scope guard: the new Phase 4 modules contain no producer or
 *      accounting integration (no processSale/processInvoice/POS/order/
 *      Landing Cost/GRN/ShippingManager/delivery/expense/COA/ledger_entries/
 *      PDF/Portal/statement wiring).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const syncSource = read('backend/routes/sync.cjs');
const migrationSource = read(
  'supabase/migrations/0029_transport_budget_events.sql',
);
const hardeningSource = read(
  'supabase/migrations/0030_transport_budget_ledger_hardening.sql',
);

function extractAllowedTables(source) {
  const match = source.match(/const ALLOWED_TABLES = new Set\(\[([\s\S]*?)\]\)/);
  if (!match) throw new Error('ALLOWED_TABLES not found in sync.cjs');
  const tables = [];
  const re = /'([a-z_][a-z0-9_]*)'/g;
  let m;
  while ((m = re.exec(match[1])) !== null) tables.push(m[1]);
  return tables;
}

describe('Phase 4 — transport budget ledger registration', () => {
  it('sync gateway allow-list contains transport_budget_events exactly once', () => {
    const tables = extractAllowedTables(syncSource);
    expect(tables.filter((t) => t === 'transport_budget_events')).toHaveLength(1);
  });

  it('migration 0029 creates the envelope table with integrity objects', () => {
    expect(migrationSource).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.transport_budget_events \(/,
    );
    // Standard sync envelope (id PK, data JSONB, timestamps, OCC version).
    expect(migrationSource).toMatch(/id TEXT PRIMARY KEY/);
    expect(migrationSource).toMatch(/data JSONB NOT NULL/);
    expect(migrationSource).toMatch(/version INTEGER NOT NULL DEFAULT 0/);
    // Canonical kinds only.
    for (const kind of [
      'SALES_ALLOCATION',
      'REVERSAL',
      'INBOUND_CONSUMPTION',
      'OUTBOUND_CONSUMPTION',
    ]) {
      expect(migrationSource).toContain(`'${kind}'`);
    }
    // Idempotency uniqueness + retrieval indexes.
    expect(migrationSource).toContain(
      'uq_transport_budget_events_idempotency_key',
    );
    expect(migrationSource).toContain('idx_transport_budget_events_kind');
    expect(migrationSource).toContain(
      'idx_transport_budget_events_business_date',
    );
    // Atomic reversal-cap trigger + append-only mutation block.
    expect(migrationSource).toContain(
      'transport_budget_events_validate_insert',
    );
    expect(migrationSource).toContain(
      'trg_transport_budget_events_block_update',
    );
    expect(migrationSource).toContain(
      'trg_transport_budget_events_block_delete',
    );
    expect(migrationSource).toContain('append_transport_budget_event');
    // Realtime membership for UI refresh (grants no access by itself).
    expect(migrationSource).toMatch(
      /ADD TABLE public\.transport_budget_events/,
    );
  });

  it('migration enforces append-only RLS (SELECT + INSERT, no UPDATE/DELETE)', () => {
    expect(migrationSource).toMatch(
      /ENABLE ROW LEVEL SECURITY/,
    );
    expect(migrationSource).toMatch(/FOR SELECT TO authenticated/);
    expect(migrationSource).toMatch(/FOR INSERT TO authenticated/);
    expect(migrationSource).not.toMatch(
      /ON public\.transport_budget_events FOR UPDATE/,
    );
    expect(migrationSource).not.toMatch(
      /ON public\.transport_budget_events FOR DELETE/,
    );
    expect(migrationSource).not.toMatch(
      /ON public\.transport_budget_events FOR ALL/,
    );
  });

  it('migration has no multi-tenant partitioning', () => {
    // Documentation prose intentionally names the forbidden columns ("NO
    // tenant_id ..."); assert against executable DDL only (comments stripped).
    // Documentation prose and the verification block's own string literals
    // intentionally name the forbidden columns; assert against bare
    // identifiers only (an actual column definition would be unquoted).
    const ddl = migrationSource
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toContain('tenant_id');
    expect(ddl).not.toContain('organization_id');
    expect(ddl).not.toContain('company_id');
  });

  it('frontend sync registrations reference the new store/table', () => {
    const dbSource = read('frontend/services/db.ts');
    expect(dbSource).toContain("transportBudgetEvents: 'transport_budget_events'");
    expect(dbSource).toContain('transportBudgetEvents: { key: string; value: TransportBudgetEvent; }');
    expect(dbSource).toContain("'transportBudgetEvents'");

    const cloudSource = read('frontend/services/cloudDb.ts');
    expect(cloudSource).toContain("transportBudgetEvents: 'transport_budget_events'");

    const syncServiceSource = read('frontend/services/syncService.ts');
    expect(syncServiceSource).toContain(
      "transportBudgetEvents: 'transport_budget_events'",
    );
    expect(syncServiceSource).toContain("'transportBudgetEvents'");

    const repoIndexSource = read(
      'frontend/services/repositories/index.ts',
    );
    expect(repoIndexSource).toContain(
      "transportBudgetEvents: 'transport_budget_events'",
    );
  });
});

describe('Phase 4 — business-logic isolation guard', () => {
  const phase4Files = {
    'frontend/types/transportBudget.ts': read(
      'frontend/types/transportBudget.ts',
    ),
    'frontend/services/transportBudgetValidator.ts': read(
      'frontend/services/transportBudgetValidator.ts',
    ),
    'frontend/services/repositories/transportBudgetRepository.ts': read(
      'frontend/services/repositories/transportBudgetRepository.ts',
    ),
  };
  const phase4Sources = Object.values(phase4Files).join('\n');

  it('imports only ledger-owned + generic infrastructure modules', () => {
    const allowedModules = new Set([
      '../types/transportBudget',
      '../../types/transportBudget',
      '../transportBudgetValidator',
      '../db',
      '../durableSyncQueue',
      '../logger',
      '../../utils/ulid',
      '../utils/roundingUtils',
      '../backgroundSyncService',
    ]);
    const importRe =
      /(?:import|export)[^'"]*from\s*'([^']+)'|(?:require|import)\('([^']+)'\)/g;
    const imports = [];
    let m;
    while ((m = importRe.exec(phase4Sources)) !== null) {
      imports.push(m[1] || m[2]);
    }
    expect(imports.length).toBeGreaterThan(0);
    for (const modulePath of imports) {
      expect(allowedModules.has(modulePath)).toBe(true);
    }
  });

  it.each([
    "'ledger'",
    "'ledger_entries'",
    "'sales'",
    "'invoices'",
    "'delivery_notes'",
    "'shipments'",
    "'expenses'",
    "'accounts'",
    "'customers'",
    "'statement_snapshots'",
    "'portal_ads'",
  ])('Phase 4 modules never touch store/table %s', (literal) => {
    expect(phase4Sources).not.toContain(literal);
  });

  it('Phase 4 modules define/call no business producers', () => {
    expect(phase4Sources).not.toMatch(/process(Sale|Invoice|Order)\s*\(/);
    expect(phase4Sources).not.toMatch(/allocate(Sale|Order)?\s*\(/);
    expect(phase4Sources).not.toMatch(/consume(LandingCost|Delivery)\s*\(/);
    expect(phase4Sources).not.toMatch(/post(Journal|Ledger|Accounting)\s*\(/);
  });

  it('Phase 4 modules never consult configuration for validity', () => {
    // The future producer resolves the rate; the ledger only validates the
    // structural shape of the supplied value.
    expect(phase4Sources).not.toMatch(/resolveTransportBudgetRate\s*\(/);
    expect(phase4Sources).not.toMatch(/getTransportBudgetPolicyState\s*\(/);
    expect(phase4Sources).not.toMatch(
      /from\s*'[^']*transportBudgetPolicy[^']*'/,
    );
    expect(phase4Sources).not.toMatch(/CompanyConfig\s*\./);
  });
});

describe('Phase 5 — sales allocation producer scope guard', () => {
  const fsLocal = require('fs');
  const producerSource = read(
    'frontend/services/transportBudgetSalesAllocation.ts',
  );
  const transactionSource = read('frontend/services/transactionService.ts');
  const apiSource = read('frontend/services/api.ts');

  it('producer imports only ledger-owned + generic infrastructure modules', () => {
    const allowedModules = new Set([
      './db',
      './logger',
      '../utils/roundingUtils',
      '../utils/revenueRecognition',
      '../utils/transportBudgetPolicy',
      './repositories/transportBudgetRepository',
      '../types',
      '../types/transportBudget',
    ]);
    const importRe =
      /(?:import|export)[^'"]*from\s*'([^']+)'|(?:require|import)\('([^']+)'\)/g;
    const imports = [];
    let m;
    while ((m = importRe.exec(producerSource)) !== null) {
      imports.push(m[1] || m[2]);
    }
    expect(imports.length).toBeGreaterThan(0);
    for (const modulePath of imports) {
      expect(allowedModules.has(modulePath)).toBe(true);
    }
  });

  it('producer performs no accounting, ledger, or customer writes', () => {
    expect(producerSource).not.toMatch(/ledgerStore|createJournalEntry|ledger_entries/);
    expect(producerSource).not.toMatch(/debitAccountId|creditAccountId/);
    expect(producerSource).not.toMatch(/post(Journal|Ledger|Accounting)\s*\(/);
    expect(producerSource).not.toMatch(/process(Sale|Invoice|Order)\s*\(/);
    expect(producerSource).not.toMatch(
      /allocateSale\s*\(|consumeLandingCost\s*\(|consumeDelivery\s*\(/,
    );
  });

  it('posting funnels hook only the allocation producer (fire-and-forget)', () => {
    for (const source of [transactionSource, apiSource]) {
      expect(source).toContain('transportBudgetSalesAllocation');
    }
    expect(transactionSource).toContain('allocateForPostedSale');
    expect(transactionSource).toContain('allocateForPostedInvoice');
    expect(apiSource).toContain('allocateForPostedInvoice');
  });

  it('forbidden files carry no producer wiring', () => {
    const forbidden = [
      'frontend/services/landingAllocation.ts',
      'frontend/utils/saleProfit.ts',
      'frontend/utils/pricingBreakdown.ts',
      'frontend/views/Settings.tsx',
      'frontend/utils/transportBudgetPolicy.ts',
      'frontend/context/AuthContext.tsx',
      'frontend/utils/companyConfigSync.ts',
    ];
    for (const rel of forbidden) {
      expect(read(rel)).not.toContain('transportBudgetSalesAllocation');
    }
  });

  it('no new database migration for the producer (ledger schema reused)', () => {
    const dir = require('path').join(ROOT, 'supabase', 'migrations');
    const transportMigrations = fsLocal
      .readdirSync(dir)
      .filter((name) => /transport/i.test(name))
      .sort();
    // Phase 7E ledger hardening (0032) and the Phase 7G-1 snapshot amendment
    // (0033) are the approved exceptions: they extend the LEDGER contract
    // (CONSUMPTION_CORRECTION kind/linkage/caps/snapshots) without adding
    // any producer. Producer phases must still reuse the schema.
    expect(transportMigrations).toEqual([
      '0029_transport_budget_events.sql',
      '0030_transport_budget_ledger_hardening.sql',
      '0032_transport_budget_consumption_correction.sql',
      '0033_transport_budget_correction_source_snapshot.sql',
    ]);
  });
});

describe('Phase 4A — RPC authorization audit (0029 baseline finding)', () => {
  it('0029 RPC is invoker-rights with no authorization check', () => {
    // No SECURITY DEFINER escalation…
    expect(migrationSource).not.toMatch(/SECURITY DEFINER/i);
    // …granted to authenticated clients…
    expect(migrationSource).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.append_transport_budget_event\(JSONB\)[\s\S]*?TO authenticated/,
    );
    // …guarded only by shape triggers (no role/producer check anywhere).
    expect(migrationSource).not.toMatch(/current_user|session_user/i);
    expect(migrationSource).not.toMatch(/auth\.(uid|jwt)\(\)/i);
  });

  it('0029 permitted direct authenticated INSERT (the finding)', () => {
    expect(migrationSource).toMatch(
      /FOR INSERT TO authenticated/,
    );
  });
});

describe('Phase 4A — hardening migration 0030', () => {
  it('tightens the rate boundary to 4 decimals without rounding', () => {
    expect(hardeningSource).toContain('chk_transport_budget_events_rate');
    expect(hardeningSource).toMatch(/0-9\]\{1,4\}/);
    expect(hardeningSource).toMatch(/BETWEEN 0 AND 100/);
    expect(hardeningSource).not.toMatch(/round\s*\(/i);
  });

  it('denies direct authenticated appends but keeps reads', () => {
    expect(hardeningSource).toMatch(
      /DROP POLICY IF EXISTS "allow_insert_transport_budget_events"/,
    );
    expect(hardeningSource).not.toMatch(/DROP POLICY[^;]*allow_select/);
  });

  it('restricts the append RPC to the service role', () => {
    expect(hardeningSource).toMatch(
      /REVOKE ALL ON FUNCTION public\.append_transport_budget_event\(JSONB\)[\s\S]*?FROM PUBLIC, authenticated/,
    );
    expect(hardeningSource).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.append_transport_budget_event\(JSONB\)[\s\S]*?TO service_role/,
    );
  });

  it('verifies exactly one (SELECT) policy plus the grant boundary', () => {
    expect(hardeningSource).toMatch(/v_policy_count <> 1/);
    expect(hardeningSource).toMatch(/cmd = 'INSERT'/);
    expect(hardeningSource).toMatch(/has_function_privilege/);
  });

  it('touches only the transport budget ledger (no other tables)', () => {
    const ddl = hardeningSource
      .replace(/--[^\n]*/g, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'[^']*'/g, "''");
    const tables = new Set();
    const tableRe =
      /(?:ALTER TABLE|DROP POLICY IF EXISTS\s+"?\w+"?\s+ON|CREATE POLICY\s+"?\w+"?\s+ON)\s+public\.([a-z_][a-z0-9_]*)/g;
    let m;
    while ((m = tableRe.exec(ddl)) !== null) tables.add(m[1]);
    expect([...tables]).toEqual(['transport_budget_events']);
    expect(ddl).not.toContain('tenant_id');
    expect(ddl).not.toContain('organization_id');
    expect(ddl).not.toContain('company_id');
  });
});

describe('Phase 4A — database-bypass enforcement (static contract)', () => {
  it('database rejects malformed rates even bypassing the validator', () => {
    // 4-decimal structural boundary lives in a CHECK, not in TypeScript.
    expect(migrationSource).toMatch(/chk_transport_budget_events_rate/);
    expect(hardeningSource).toContain("(data->>'allocationRatePercent')");
  });

  it('database reversibility rule admits only SALES_ALLOCATION targets', () => {
    expect(migrationSource).toMatch(
      /IF v_target_kind <> 'SALES_ALLOCATION' THEN/,
    );
    expect(migrationSource).toMatch(
      /only SALES_ALLOCATION events are reversible/,
    );
  });

  it('database enforces the signed-sum cumulative cap under a row lock', () => {
    // Canonical signed sum (NOT generated-minus-reversed): allocation (+)
    // + existing reversals (−) + new reversal (−) must stay >= 0.
    expect(migrationSource).toMatch(/FOR UPDATE;/);
    expect(migrationSource).toMatch(
      /IF v_target_amount \+ v_reversed_total \+ v_new_amount < 0 THEN/,
    );
    expect(migrationSource).not.toMatch(/Generated - negativeReversal/);
  });

  it('database blocks every UPDATE and DELETE path', () => {
    expect(migrationSource).toMatch(
      /trg_transport_budget_events_block_update/,
    );
    expect(migrationSource).toMatch(
      /trg_transport_budget_events_block_delete/,
    );
  });

  it('offline sync path still submits through the service-role gateway', () => {
    // The gateway allow-list (existing test) plus the queue-based repository
    // (functional tests) are unchanged; 0030 only narrows direct access.
    const tables = [];
    const match = syncSource.match(
      /const ALLOWED_TABLES = new Set\(\[([\s\S]*?)\]\)/,
    );
    const re = /'([a-z_][a-z0-9_]*)'/g;
    let m;
    while ((m = re.exec(match[1])) !== null) tables.push(m[1]);
    expect(tables).toContain('transport_budget_events');
    // 0030 carries no queue/gateway/offline DDL of its own: the existing
    // offline -> queue -> gateway path is unchanged (see "touches only"
    // test above for the table proof).
    expect(hardeningSource).not.toMatch(/CREATE TABLE|ALTER TABLE public\.(?!transport_budget_events)/);
  });
});

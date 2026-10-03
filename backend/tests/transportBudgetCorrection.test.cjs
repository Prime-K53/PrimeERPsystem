/**
 * Phase 7E — Transport Budget CONSUMPTION_CORRECTION ledger hardening.
 *
 * 1. Backend validator parity: the frozen Phase 7D-2 correction shape
 *    (positive delta, duplicate-field rule, required snapshots, forbidden
 *    links/rate) is enforced identically to the frontend validator.
 * 2. Migration 0032 static contract: the new kind, sign branch, linkage
 *    shape CHECKs, single-correction uniqueness, trigger branches, and the
 *    unchanged security posture (SELECT-only RLS, service-role RPC, no
 *    tenant columns, no global-balance gate).
 *
 * No producers are added here (Phase 7E establishes the ledger only).
 * No outbound logic. No Landing Cost changes.
 */
const fs = require('fs');
const path = require('path');
const {
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
} = require('../services/transportBudgetEventValidator.cjs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const migrationSource = read(
  'supabase/migrations/0032_transport_budget_consumption_correction.sql',
);
const amendmentSource = read(
  'supabase/migrations/0033_transport_budget_correction_source_snapshot.sql',
);
const hardeningSource = read(
  'supabase/migrations/0030_transport_budget_ledger_hardening.sql',
);

const NOW = '2026-10-02T09:00:00.000Z';

const VALID_CORRECTION = {
  id: 'evt-corr-001',
  kind: 'CONSUMPTION_CORRECTION',
  idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-001',
  sourceEventId: 'evt-in-001',
  sourceAmount: 20000,
  allocationRatePercent: null,
  amount: 2000,
  method: 'LANDING_COST_FREIGHT',
  providerId: 'SUP-1',
  reversesEventId: null,
  correctsEventId: 'evt-in-001',
  businessDate: '2026-10-02',
  occurredAt: NOW,
};

describe('Phase 7E: backend correction validator parity', () => {
  test('accepts a valid CONSUMPTION_CORRECTION', () => {
    const event = assertValidTransportBudgetEvent(VALID_CORRECTION, NOW);
    expect(event.kind).toBe('CONSUMPTION_CORRECTION');
    expect(event.amount).toBe(2000);
    expect(event.sourceEventId).toBe(event.correctsEventId);
  });

  test('rejects zero and negative correction amounts', () => {
    for (const amount of [0, -2000, -0.01]) {
      const result = validateTransportBudgetEvent({
        ...VALID_CORRECTION,
        amount,
      });
      expect(result.ok).toBe(false);
    }
  });

  test('rejects a missing or mismatched correction link', () => {
    const missing = validateTransportBudgetEvent({
      ...VALID_CORRECTION,
      correctsEventId: null,
    });
    expect(missing.ok).toBe(false);
    expect(
      missing.issues.some((i) => i.code === 'MISSING_CORRECTION_LINK'),
    ).toBe(true);
    const mismatched = validateTransportBudgetEvent({
      ...VALID_CORRECTION,
      sourceEventId: 'evt-in-999',
    });
    expect(mismatched.ok).toBe(false);
  });

  test('rejects missing snapshots and wrong method', () => {
    for (const patch of [
      { sourceEventId: null },
      { sourceAmount: null },
      { sourceAmount: 0 },
      { method: null },
      { method: 'OUTBOUND_TRANSPORT' },
      { providerId: null },
    ]) {
      expect(
        validateTransportBudgetEvent({ ...VALID_CORRECTION, ...patch }).ok,
      ).toBe(false);
    }
  });

  test('rejects reversesEventId and allocationRatePercent on corrections', () => {
    expect(
      validateTransportBudgetEvent({
        ...VALID_CORRECTION,
        reversesEventId: 'evt-in-001',
      }).ok,
    ).toBe(false);
    expect(
      validateTransportBudgetEvent({
        ...VALID_CORRECTION,
        allocationRatePercent: 3,
      }).ok,
    ).toBe(false);
  });

  test('rejects correctsEventId on every other kind', () => {
    const others = [
      { ...VALID_CORRECTION, kind: 'SALES_ALLOCATION', amount: 2000 },
      { ...VALID_CORRECTION, kind: 'REVERSAL', amount: -2000 },
      { ...VALID_CORRECTION, kind: 'INBOUND_CONSUMPTION', amount: -2000 },
      { ...VALID_CORRECTION, kind: 'OUTBOUND_CONSUMPTION', amount: -2000 },
    ];
    for (const candidate of others) {
      const result = validateTransportBudgetEvent(candidate);
      expect(result.ok).toBe(false);
      expect(
        result.issues.some((i) => i.code === 'FORBIDDEN_CORRECTION_LINK'),
      ).toBe(true);
    }
  });

  test('rejects self-referencing corrections', () => {
    expect(
      validateTransportBudgetEvent({
        ...VALID_CORRECTION,
        id: 'evt-same',
        sourceEventId: 'evt-same',
        correctsEventId: 'evt-same',
      }).ok,
    ).toBe(false);
  });

  test('partial-scope shape passes validation (equality is contextual)', () => {
    // Shape-only layer: sourceAmount 100000 with amount 30000 is well-formed.
    // The parent-snapshot equality is enforced at repository/DB append time.
    const result = validateTransportBudgetEvent({
      ...VALID_CORRECTION,
      sourceAmount: 100000,
      amount: 30000,
    });
    expect(result.ok).toBe(true);
  });

  test('sameEconomicPayload covers correctsEventId', () => {
    const {
      sameEconomicPayload,
    } = require('../services/transportBudgetEventValidator.cjs');
    const a = assertValidTransportBudgetEvent(VALID_CORRECTION, NOW);
    const b = assertValidTransportBudgetEvent(
      { ...VALID_CORRECTION, createdAt: '2026-10-03T00:00:00.000Z' },
      NOW,
    );
    expect(sameEconomicPayload(a, b)).toBe(true);
    const c = assertValidTransportBudgetEvent(
      {
        ...VALID_CORRECTION,
        id: 'evt-corr-001',
        sourceEventId: 'evt-in-002',
        correctsEventId: 'evt-in-002',
        idempotencyKey: 'CONSUMPTION_CORRECTION:evt-in-002',
      },
      NOW,
    );
    expect(sameEconomicPayload(a, c)).toBe(false);
  });
});

describe('Phase 7E: migration 0032 static contract', () => {
  test('adds the CONSUMPTION_CORRECTION kind literal', () => {
    expect(migrationSource).toContain("'CONSUMPTION_CORRECTION'");
    expect(migrationSource).toContain(
      'chk_transport_budget_events_kind',
    );
  });

  test('extends the sign CHECK with the positive-correction branch', () => {
    expect(migrationSource).toContain(
      'chk_transport_budget_events_sign',
    );
    expect(migrationSource).toMatch(
      /WHEN 'CONSUMPTION_CORRECTION' THEN \(data->>'amount'\)::numeric > 0/,
    );
    // Consumption rules are untouched: the ELSE branch stays negative.
    expect(migrationSource).toMatch(
      /ELSE \(data->>'amount'\)::numeric < 0/,
    );
  });

  test('adds correction-linkage shape CHECKs (no reversesEventId reuse)', () => {
    expect(migrationSource).toContain(
      'chk_transport_budget_events_correction_shape',
    );
    expect(migrationSource).toContain(
      'chk_transport_budget_events_correction_identity',
    );
    expect(migrationSource).toContain('sourceEventId');
    expect(migrationSource).not.toMatch(
      /CONSUMPTION_CORRECTION[\s\S]{0,400}reversesEventId.*IFF/,
    );
  });

  test('adds the single-correction uniqueness backstop', () => {
    expect(migrationSource).toContain(
      'uq_transport_budget_events_corrects',
    );
    expect(migrationSource).toContain(
      'idx_transport_budget_events_corrects',
    );
  });

  test('trigger enforces target, snapshots, single, and caps', () => {
    expect(migrationSource).toContain(
      'transport_budget_events_validate_insert',
    );
    expect(migrationSource).toContain(
      'only INBOUND_CONSUMPTION events are correctible',
    );
    expect(migrationSource).toContain('ALREADY_CORRECTED');
    expect(migrationSource).toContain(
      'would exceed original consumption',
    );
    expect(migrationSource).toContain('LANDING_COST_FREIGHT');
    expect(migrationSource).toContain(
      'must not precede the original consumption businessDate',
    );
    // Reversal semantics preserved verbatim.
    expect(migrationSource).toContain(
      'only SALES_ALLOCATION events are reversible',
    );
    expect(migrationSource).toContain('FOR UPDATE');
  });

  test('source-cap is conditional and advisory-locked (no global lock)', () => {
    expect(migrationSource).toContain('would exceed source cap');
    expect(migrationSource).toContain('pg_advisory_xact_lock');
    // No global-balance gate: assert against executable DDL only (comments
    // intentionally document that negative Available is legal).
    const ddl = migrationSource
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toMatch(/CONSTRAINT\s+\w*balance\w*/i);
    expect(ddl).not.toMatch(/CONSTRAINT\s+\w*overdraft\w*/i);
    expect(ddl).not.toMatch(/Available\s*>=/);
    // No global-balance CHECK constraint is introduced.
    expect(migrationSource).not.toContain('chk_transport_budget_events_balance');
  });

  test('security posture unchanged (SELECT-only RLS, service-role RPC)', () => {
    expect(migrationSource).not.toMatch(/FOR INSERT TO authenticated/);
    expect(migrationSource).not.toMatch(/GRANT EXECUTE[\s\S]*TO authenticated/);
    expect(migrationSource).not.toMatch(/SECURITY DEFINER/);
  });

  test('migration is additive and tenant-free', () => {
    expect(migrationSource).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
    const ddl = migrationSource
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toContain('tenant_id');
    expect(ddl).not.toContain('organization_id');
    expect(ddl).not.toContain('company_id');
    // Only the ledger table is touched (the FUNCTION-name substring inside
    // EXECUTE FUNCTION ... is not a table reference).
    const touched = [...migrationSource.matchAll(/ON public\.(\w+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'transport_budget_events_validate_insert');
    expect(new Set(touched)).toEqual(new Set(['transport_budget_events']));
  });

  test('hardening chain intact: 0030 still denies authenticated appends', () => {
    expect(hardeningSource).toMatch(
      /DROP POLICY IF EXISTS "allow_insert_transport_budget_events"/,
    );
  });
});

describe('Phase 7G-1: migration 0033 source-snapshot amendment', () => {
  // Static assertions target the trigger body only: the file's own
  // verification block intentionally names both messages.
  const triggerBody = amendmentSource.split('2. POST-MIGRATION VERIFICATION')[0];

  test('amends only the correction snapshot equality predicate', () => {
    expect(amendmentSource).toContain(
      'must equal the original inbound sourceAmount',
    );
    expect(triggerBody).not.toContain(
      'must equal abs(original consumption amount)',
    );
  });

  test('preserves every unrelated invariant verbatim', () => {
    for (const snippet of [
      'only INBOUND_CONSUMPTION events are correctible',
      'correction cannot reference itself',
      'must not carry reversesEventId',
      'CONSUMPTION_CORRECTION method must be LANDING_COST_FREIGHT',
      'ALREADY_CORRECTED',
      'would exceed original consumption',
      'must not precede the original consumption businessDate',
      'would exceed source cap',
      'pg_advisory_xact_lock',
      'FOR UPDATE',
      'only SALES_ALLOCATION events are reversible',
      'cumulative reversals (%) would exceed allocation',
    ]) {
      expect(amendmentSource).toContain(snippet);
    }
  });

  test('guards snapshot-less targets fail-closed', () => {
    expect(amendmentSource).toContain('carries no source snapshot');
  });

  test('migration is additive, single-table, tenant-free, RLS-neutral', () => {
    expect(amendmentSource).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
    expect(amendmentSource).not.toMatch(/FOR INSERT TO authenticated/);
    expect(amendmentSource).not.toMatch(/GRANT EXECUTE[\s\S]*TO authenticated/);
    expect(amendmentSource).not.toMatch(/SECURITY DEFINER/);
    const ddl = amendmentSource
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toContain('tenant_id');
    expect(ddl).not.toContain('organization_id');
    expect(ddl).not.toContain('company_id');
    const touched = [...amendmentSource.matchAll(/ON public\.(\w+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'transport_budget_events_validate_insert');
    expect(new Set(touched)).toEqual(new Set(['transport_budget_events']));
  });

  test('0032 itself still carries the superseded predicate (history intact)', () => {
    expect(migrationSource).toContain(
      'must equal abs(original consumption amount %)',
    );
  });
});

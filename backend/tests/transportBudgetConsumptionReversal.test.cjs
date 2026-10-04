/**
 * Phase 8D — Transport Budget CONSUMPTION_REVERSAL ledger contract.
 *
 * 1. Backend validator parity: the frozen Phase 8D reversal shape
 *    (positive full amount, dedicated reversesEventId link to
 *    OUTBOUND_CONSUMPTION only, null snapshot hygiene) is enforced
 *    identically to the frontend validator.
 * 2. Migration 0035 static contract: the new kind, sign branch, linkage
 *    shape, single-reversal uniqueness, trigger branch, and the unchanged
 *    security posture (SELECT-only RLS, service-role RPC, no tenant
 *    columns, no global-balance gate).
 *
 * No producers are added here (Phase 8D establishes the ledger only).
 * No outbound producer. No Landing Cost changes.
 */
const fs = require('fs');
const path = require('path');
const {
  validateTransportBudgetEvent,
  assertValidTransportBudgetEvent,
  sameEconomicPayload,
} = require('../services/transportBudgetEventValidator.cjs');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const migrationSource = read(
  'supabase/migrations/0035_transport_budget_consumption_reversal.sql',
);

const NOW = '2026-10-02T10:00:00.000Z';

const VALID_REVERSAL = {
  id: 'evt-crev-001',
  kind: 'CONSUMPTION_REVERSAL',
  idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-001',
  sourceEventId: null,
  sourceAmount: null,
  allocationRatePercent: null,
  amount: 20000,
  method: null,
  providerId: null,
  reversesEventId: 'evt-out-001',
  correctsEventId: null,
  businessDate: '2026-10-02',
  occurredAt: NOW,
};

describe('Phase 8D: backend consumption-reversal validator parity', () => {
  test('accepts a valid CONSUMPTION_REVERSAL', () => {
    const event = assertValidTransportBudgetEvent(VALID_REVERSAL, NOW);
    expect(event.kind).toBe('CONSUMPTION_REVERSAL');
    expect(event.amount).toBe(20000);
    expect(event.reversesEventId).toBe('evt-out-001');
  });

  test('rejects zero and negative reversal amounts', () => {
    for (const amount of [0, -20000, -0.01]) {
      const result = validateTransportBudgetEvent({
        ...VALID_REVERSAL,
        amount,
      });
      expect(result.ok).toBe(false);
      expect(
        result.issues.some((i) => i.code === 'INVALID_SIGN' || i.code === 'INVALID_AMOUNT'),
      ).toBe(true);
    }
  });

  test('rejects a missing reversesEventId and self-links', () => {
    const missing = validateTransportBudgetEvent({
      ...VALID_REVERSAL,
      reversesEventId: null,
    });
    expect(missing.ok).toBe(false);
    expect(
      missing.issues.some((i) => i.code === 'MISSING_REVERSAL_LINK'),
    ).toBe(true);
    expect(
      validateTransportBudgetEvent({
        ...VALID_REVERSAL,
        id: 'evt-same',
        reversesEventId: 'evt-same',
      }).ok,
    ).toBe(false);
  });

  test('enforces the CONSUMPTION_REVERSAL key namespace', () => {
    const namespaced = validateTransportBudgetEvent(VALID_REVERSAL);
    expect(namespaced.ok).toBe(true);
    for (const key of [
      'REVERSAL:evt-out-001',
      'OUTBOUND_CONSUMPTION:EXP-7:DLV-7',
      'RANDOM-KEY-1',
    ]) {
      const result = validateTransportBudgetEvent({
        ...VALID_REVERSAL,
        idempotencyKey: key,
      });
      expect(result.ok).toBe(false);
      expect(
        result.issues.some((i) => i.code === 'INVALID_IDEMPOTENCY_KEY'),
      ).toBe(true);
    }
    // Suffixed operational keys stay in-namespace (binding is enforced at
    // append by ALREADY_REVERSED/full-amount, not by the validator).
    expect(
      validateTransportBudgetEvent({
        ...VALID_REVERSAL,
        idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-001:2',
      }).ok,
    ).toBe(true);
  });

  test('rejects snapshot fields on reversals (null hygiene)', () => {
    for (const patch of [
      { sourceEventId: 'evt-out-001' },
      { sourceAmount: 20000 },
      { method: 'OUTBOUND_TRANSPORT' },
      { providerId: 'SUP-1' },
      { allocationRatePercent: 3 },
      { correctsEventId: 'evt-out-001' },
    ]) {
      expect(
        validateTransportBudgetEvent({ ...VALID_REVERSAL, ...patch }).ok,
      ).toBe(false);
    }
  });

  test('rejects reversesEventId on every other kind', () => {
    const others = [
      { ...VALID_REVERSAL, kind: 'SALES_ALLOCATION', amount: 20000 },
      { ...VALID_REVERSAL, kind: 'INBOUND_CONSUMPTION', amount: -20000 },
      { ...VALID_REVERSAL, kind: 'OUTBOUND_CONSUMPTION', amount: -20000 },
      { ...VALID_REVERSAL, kind: 'CONSUMPTION_CORRECTION', amount: 20000 },
    ];
    for (const candidate of others) {
      const result = validateTransportBudgetEvent(candidate);
      expect(result.ok).toBe(false);
      expect(
        result.issues.some((i) => i.code === 'FORBIDDEN_REVERSAL_LINK'),
      ).toBe(true);
    }
  });

  test('sameEconomicPayload covers kind + reversesEventId', () => {
    const a = assertValidTransportBudgetEvent(VALID_REVERSAL, NOW);
    const b = assertValidTransportBudgetEvent(
      { ...VALID_REVERSAL, createdAt: '2026-10-03T00:00:00.000Z' },
      NOW,
    );
    expect(sameEconomicPayload(a, b)).toBe(true);
    const c = assertValidTransportBudgetEvent(
      {
        ...VALID_REVERSAL,
        id: 'evt-crev-001',
        reversesEventId: 'evt-out-999',
        idempotencyKey: 'CONSUMPTION_REVERSAL:evt-out-999',
      },
      NOW,
    );
    expect(sameEconomicPayload(a, c)).toBe(false);
  });
});

describe('Phase 8D: migration 0035 static contract', () => {
  test('adds the CONSUMPTION_REVERSAL kind literal', () => {
    expect(migrationSource).toContain("'CONSUMPTION_REVERSAL'");
    expect(migrationSource).toContain(
      'chk_transport_budget_events_kind',
    );
  });

  test('extends the sign CHECK with the explicit positive-reversal branch', () => {
    expect(migrationSource).toContain(
      'chk_transport_budget_events_sign',
    );
    expect(migrationSource).toMatch(
      /WHEN 'CONSUMPTION_REVERSAL' THEN \(data->>'amount'\)::numeric > 0/,
    );
    // No generic positive rule: the ELSE branch stays negative, keeping
    // OUTBOUND_CONSUMPTION (and REVERSAL/INBOUND_CONSUMPTION) negative.
    expect(migrationSource).toMatch(
      /ELSE \(data->>'amount'\)::numeric < 0/,
    );
    // The 0035 verification block pins the negative ELSE explicitly.
    expect(migrationSource).toMatch(
      /OUTBOUND_CONSUMPTION must remain negative/,
    );
  });

  test('extends reversal linkage shape without touching correction shape', () => {
    expect(migrationSource).toContain(
      'chk_transport_budget_events_reversal_shape',
    );
    expect(migrationSource).toMatch(
      /WHEN 'CONSUMPTION_REVERSAL' THEN COALESCE\(data->>'reversesEventId', ''\) <> ''/,
    );
  });

  test('adds the kind-scoped single-reversal uniqueness backstop', () => {
    expect(migrationSource).toContain(
      'uq_transport_budget_events_consumption_reversal',
    );
    expect(migrationSource).toContain(
      'idx_transport_budget_events_consumption_reversal',
    );
    // Existing indexes are not generalized.
    expect(migrationSource).not.toMatch(/DROP INDEX.*corrects|DROP INDEX.*reverses/);
  });

  test('trigger enforces outbound-only target, single, and full amount', () => {
    expect(migrationSource).toContain(
      'transport_budget_events_validate_insert',
    );
    expect(migrationSource).toContain(
      'only OUTBOUND_CONSUMPTION events are consumption-reversible',
    );
    expect(migrationSource).toContain('ALREADY_REVERSED');
    expect(migrationSource).toContain(
      'must equal original consumption',
    );
    expect(migrationSource).toContain('FOR UPDATE');
    // Allocation reversal semantics preserved verbatim.
    expect(migrationSource).toContain(
      'only SALES_ALLOCATION events are reversible',
    );
    expect(migrationSource).toContain(
      'cumulative reversals (%) would exceed allocation',
    );
    // Inbound correction semantics preserved verbatim.
    expect(migrationSource).toContain(
      'only INBOUND_CONSUMPTION events are correctible',
    );
    expect(migrationSource).toContain('ALREADY_CORRECTED');
  });

  test('no global-balance gate and no source-cap for the new kind', () => {
    const ddl = migrationSource
      .replace(/--[^\n]*/g, '')
      .replace(/'[^']*'/g, "''");
    expect(ddl).not.toMatch(/CONSTRAINT\s+\w*balance\w*/i);
    expect(ddl).not.toMatch(/CONSTRAINT\s+\w*overdraft\w*/i);
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
    const touched = [...migrationSource.matchAll(/ON public\.(\w+)/g)]
      .map((m) => m[1])
      .filter((name) => name !== 'transport_budget_events_validate_insert');
    expect(new Set(touched)).toEqual(new Set(['transport_budget_events']));
  });
});

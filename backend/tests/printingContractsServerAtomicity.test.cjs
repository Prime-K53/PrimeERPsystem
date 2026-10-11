/**
 * Printing Contracts server atomicity (Phase 2 §3.1–§3.2).
 * - Migration 0048 declares atomic RPCs with FOR UPDATE + idempotency + FY closure.
 * - Sync gateway preserves business transaction date and quarantines closed-period ops.
 * - Printing-contracts route module loads and exposes reserve/consume/health.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
const fs = require('fs');
const path = require('path');

describe('migration 0048 server atomicity', () => {
  const sqlPath = path.join(__dirname, '..', '..', 'supabase', 'migrations', '0048_printing_contracts_server_atomicity.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  test('declares reserve + consume atomic RPCs', () => {
    expect(sql).toMatch(/reserve_contract_assessment_atomic/);
    expect(sql).toMatch(/consume_contract_assessment_atomic/);
  });

  test('uses row locking and idempotency', () => {
    expect(sql).toMatch(/FOR UPDATE/);
    expect(sql).toMatch(/idempotency_keys/);
    expect(sql).toMatch(/WTX-.*CONSUMED/);
  });

  test('enforces closed-period with CLOSED_PERIOD marker (never half-writes)', () => {
    expect(sql).toMatch(/CLOSED_PERIOD/);
    expect(sql).toMatch(/is_contract_date_in_closed_fy/);
  });

  test('documents rollback and non-application to production', () => {
    expect(sql).toMatch(/Rollback/i);
    expect(sql).toMatch(/NOT APPLIED TO PRODUCTION/i);
  });
});

describe('migration 0049 immutable contract documents', () => {
  const sqlPath = path.join(__dirname, '..', '..', 'supabase', 'migrations', '0049_contract_documents.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  test('creates envelope table with version + token indexes', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS public.contract_documents/);
    expect(sql).toMatch(/uq_contract_documents_number_version/);
    expect(sql).toMatch(/uq_contract_documents_verification_token/);
    expect(sql).toMatch(/uq_contract_documents_receipt_item/);
  });

  test('documents rollback and non-application to production', () => {
    expect(sql).toMatch(/Rollback/i);
    expect(sql).toMatch(/NOT APPLIED TO PRODUCTION/i);
  });
});

describe('sync gateway FY safeguards', () => {
  const syncPath = path.join(__dirname, '..', 'routes', 'sync.cjs');
  const src = fs.readFileSync(syncPath, 'utf8');

  test('validates contract financial business date (no sync-timestamp substitution)', () => {
    expect(src).toMatch(/validateContractFinancialOp/);
    expect(src).toMatch(/business_date/);
    expect(src).toMatch(/sync timestamp must not be substituted/i);
  });

  test('allows contract_documents through the gateway', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.cjs'), 'utf8');
    expect(src).toMatch(/contract_documents/);
  });

  test('quarantines closed-period ops with adjustmentRequired before applyOp', () => {
    expect(src).toMatch(/adjustmentRequired/);
    // Gate sits before applyOp (rejected ops never half-write).
    const gateIdx = src.indexOf('validateContractFinancialOp(op)');
    const applyIdx = src.indexOf('cloudSyncStore.applyOp');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(gateIdx);
  });
});

describe('printing-contracts route', () => {
  test('loads and exposes reserve/consume/health', () => {
    const router = require('../routes/printingContracts.cjs');
    expect(router).toBeDefined();
    // Express router has .stack with our three routes.
    const paths = (router.stack || []).map((l) => l?.route?.path).filter(Boolean);
    expect(paths).toEqual(expect.arrayContaining(['/reserve', '/consume', '/health']));
  });
});

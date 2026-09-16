/**
 * Phase 1 — Critical CoA + Market Adjustment fixes.
 *
 * Covers:
 *  A2: parent_account_id accepts ACC-*, numeric codes, uuids (not uuid-only)
 *  A5: boolean coercion tolerates "true"/"false"/"1"/"0", missing allow_posting defaults to postable
 *  B1: resolveEffectiveClassAdjustments filters inactive/deleted (WHERE actually used)
 */
const { describe, it, expect } = require('@jest/globals');
const fs = require('node:fs');
const path = require('node:path');

describe('A2: account validation parent_account_id', () => {
  const { accountSchemas } = require('../middleware/validation.cjs');

  it.each([['11110'], ['ACC-11310'], ['ACC-41100-1'], ['550e8400-e29b-41d4-a716-446655440000']])(
    'accepts %s',
    (id) => {
      expect(() =>
        accountSchemas.create.parse({ name: 'T', account_type: 'ASSET', parent_account_id: id })
      ).not.toThrow();
      expect(() =>
        accountSchemas.update.parse({ parent_account_id: id })
      ).not.toThrow();
    }
  );

  it('accepts null/undefined (root accounts)', () => {
    expect(() =>
      accountSchemas.create.parse({ name: 'T', account_type: 'ASSET', parent_account_id: null })
    ).not.toThrow();
    expect(() =>
      accountSchemas.create.parse({ name: 'T', account_type: 'ASSET' })
    ).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() =>
      accountSchemas.create.parse({ name: 'T', account_type: 'ASSET', parent_account_id: '' })
    ).toThrow();
  });
});

describe('A5: finance boolean normalization', () => {
  const FinanceService = require('../services/financeService.cjs');
  const svc = new FinanceService();

  it('treats "false"/"0"/0/false as false, "true"/"1"/1/true as true', () => {
    const n = svc._normalizeAccount({
      account_type: 'ASSET',
      is_active: 'false',
      allow_posting: 'true',
      is_system_account: '1',
    });
    expect(n.is_active).toBe(false);
    expect(n.allow_posting).toBe(true);
    expect(n.is_system_account).toBe(true);

    const n2 = svc._normalizeAccount({
      account_type: 'ASSET',
      is_active: '0',
      allow_posting: '0',
      is_system_account: 'false',
    });
    expect(n2.is_active).toBe(false);
    expect(n2.allow_posting).toBe(false);
    expect(n2.is_system_account).toBe(false);
  });

  it('defaults missing allow_posting/is_active to postable/active (never blocked)', () => {
    const n = svc._normalizeAccount({ account_type: 'INCOME' });
    expect(n.allow_posting).toBe(true);
    expect(n.is_active).toBe(true);
    expect(n.is_system_account).toBe(false);
  });
});

describe('B1: inactive market adjustments are filtered', () => {
  it('resolveEffectiveClassAdjustments query includes WHERE clause', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'services', 'examinationService.cjs'),
      'utf8'
    );
    // The built whereSql must be interpolated into the SELECT, not just constructed.
    expect(src).toMatch(/SELECT \* FROM market_adjustments\s+\$\{whereSql\}/);
  });
});

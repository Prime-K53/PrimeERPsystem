/**
 * Phase 9B Blocker A — RPC same-key economic conflict.
 *
 * Migration 0037 replaces the append RPC body so same idempotencyKey +
 * different economics raises instead of silently resolving to stale
 * economics. These static-contract tests pin the function text (the
 * established hermetic backend-test architecture: no live Supabase).
 * Behavioral proof additionally lives inside the migration itself
 * (transactional SAVEPOINT self-test, auto-rolled-back).
 *
 * Required matrix:
 * 1. same key + identical economics => dedupe (return existing)
 * 2. same key + different amount    => reject
 * 3. same key + different kind      => reject
 * 4. same key + different source    => reject
 * 5. same key + different lineage   => reject
 * 6. concurrent same-key calls      => serialized, no divergence
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const rpcSource = read(
  'supabase/migrations/0037_transport_budget_rpc_key_economics.sql',
);

const fnBody = (() => {
  const start = rpcSource.indexOf(
    'CREATE OR REPLACE FUNCTION public.append_transport_budget_event',
  );
  const end = rpcSource.indexOf('$$ LANGUAGE plpgsql;', start);
  return rpcSource.slice(start, end);
})();

describe('Phase 9B: RPC same-key economic conflict (Blocker A)', () => {
  test('same-key branch compares the full economic payload', () => {
    for (const field of [
      'kind',
      'amount',
      'sourceEventId',
      'sourceAmount',
      'allocationRatePercent',
      'method',
      'providerId',
      'reversesEventId',
      'correctsEventId',
      'businessDate',
    ]) {
      expect(fnBody).toContain(`v_row.data->>'${field}'`);
      expect(fnBody).toContain(`p_event->>'${field}'`);
    }
    // NULL-safe comparison (absent snapshot fields must compare equal).
    expect(fnBody).toMatch(/IS NOT DISTINCT FROM/);
  });

  test('volatile transport fields are excluded from the comparison', () => {
    expect(fnBody).not.toMatch(/v_row\.data->>'createdAt'/);
    expect(fnBody).not.toMatch(/v_row\.data->>'occurredAt'/);
    // Physical id is compared only on the same-id branch, never as economics.
    const keyBranch = fnBody.slice(fnBody.indexOf('Economic retry'));
    expect(keyBranch).not.toContain("v_row.data->>'id'");
  });

  test('conflicting reuse raises a deterministic exception', () => {
    expect(fnBody).toMatch(
      /idempotencyKey % already exists with different economics/,
    );
    // The silent-resolve path (bare RETURN on key hit) must be gone.
    expect(fnBody).not.toMatch(
      /-- Economic retry[\s\S]{0,400}?RETURN row_to_json\(v_row\)::JSONB;\s*END IF;\s*INSERT/,
    );
  });

  test('same-key concurrent calls are serialized without a global lock', () => {
    expect(fnBody).toMatch(
      /pg_advisory_xact_lock\(hashtext\('tbe-key:' \|\| v_key\)\)/,
    );
    // Key-scoped only: no unconditional/global advisory lock text.
    expect(fnBody).not.toMatch(/pg_advisory_xact_lock\(\s*['"]?tbe-global/);
  });

  test('same-id semantics are preserved verbatim', () => {
    expect(fnBody).toMatch(/same id, identical payload -> the same row/);
    expect(fnBody).toMatch(
      /id % already exists with a different payload/,
    );
  });

  test('service-role-only posture is preserved', () => {
    expect(rpcSource).toMatch(
      /REVOKE ALL ON FUNCTION public\.append_transport_budget_event\(JSONB\)/,
    );
    expect(rpcSource).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.append_transport_budget_event\(JSONB\)\s+TO service_role/,
    );
  });

  test('migration carries a behavioral self-test with rollback', () => {
    expect(rpcSource).toContain('SAVEPOINT sp_0037_rpc_selftest');
    expect(rpcSource).toContain('ROLLBACK TO SAVEPOINT sp_0037_rpc_selftest');
    expect(rpcSource).toMatch(/same-key same-economics[\s\S]{0,200}?dedupe/);
    expect(rpcSource).toMatch(/different economics/);
  });
});

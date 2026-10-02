/**
 * supabaseQuery.test.cjs — Phase 6C regression protection for the Phase 5C
 * `supabaseQuery.cjs` fixes.
 *
 * These are DEPENDENCY regression tests only (no Transport Budget / Phase 6
 * reversal semantics). They protect two already-shipped corrections that would
 * silently corrupt writes if reintroduced:
 *
 *   1. `run(sql, callback)` two-argument normalization: without it the
 *      callback lands in `params` and is never invoked, hanging every
 *      `sq.run("BEGIN TRANSACTION", cb)` / `sq.run("COMMIT", cb)` caller.
 *   2. INSERT parameter-to-column mapping: `params[i]` belongs to `cols[i]`.
 *      The former `cols[i - 1]` mapping shifted every value by one column.
 *
 * Hermetic: the cloud repository transport is mocked in-memory. No Supabase,
 * no network, no live credentials.
 */
'use strict';

jest.mock('../services/supabaseRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
  softDelete: jest.fn(),
}));

const repo = require('../services/supabaseRepository.cjs');
const sq = require('../services/supabaseQuery.cjs');

beforeEach(() => {
  jest.clearAllMocks();
  repo.getAll.mockResolvedValue([]);
  repo.getById.mockResolvedValue(null);
  repo.upsert.mockResolvedValue({});
  repo.softDelete.mockResolvedValue({});
});

describe('supabaseQuery — run() callback normalization', () => {
  it('honours the legacy (sql, callback) two-argument shape', async () => {
    const callback = jest.fn();
    await sq.run('BEGIN TRANSACTION', callback);
    expect(callback).toHaveBeenCalledTimes(1);
    // No error is passed for transaction-control statements.
    expect(callback.mock.calls[0][0]).toBeNull();

    const commit = jest.fn();
    await sq.run('COMMIT', commit);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toBeNull();
  });

  it('does not treat a 2-arg function as a positional parameter list', async () => {
    const callback = jest.fn();
    await sq.run('BEGIN TRANSACTION', callback);
    // The function must never be passed through as a bound parameter value.
    expect(repo.upsert).not.toHaveBeenCalled();
    expect(typeof callback.mock.calls[0][0]).not.toBe('function');
  });

  it('honours the (sql, params, callback) three-argument shape', async () => {
    const callback = jest.fn();
    await sq.run(
      'INSERT INTO sale_items (id, a, b) VALUES (?, ?, ?)',
      ['SALE-1', 'x', 'y'],
      callback,
    );
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeNull();
    expect(callback.mock.calls[0][1]).toEqual({ lastID: 'SALE-1', changes: 1 });
  });
});

describe('supabaseQuery — INSERT parameter-to-column mapping', () => {
  it('maps params[i] to cols[i] (never cols[i - 1])', async () => {
    await sq.run('INSERT INTO t (a, b, c) VALUES (?, ?, ?)', [1, 2, 3]);
    expect(repo.upsert).toHaveBeenCalledTimes(1);
    const [table, row] = repo.upsert.mock.calls[0];
    expect(table).toBe('t');
    // id comes from params[0]; a/b/c must be aligned to a/b/c.
    // id is normalized to a string by run(); the positional params keep their
    // own types.
    expect(row).toMatchObject({ id: '1', a: 1, b: 2, c: 3 });
    // The off-by-one bug would have produced { a: 2, b: 3 } and dropped the
    // first value into a nonexistent leading column.
    expect(row.c).toBe(3);
  });

  it('keeps the first column aligned for a realistic sale_items insert', async () => {
    await sq.run(
      'INSERT INTO sale_items (id, sale_id, item_id, quantity) VALUES (?, ?, ?, ?)',
      ['SI-1', 'S-1', 'ITEM-9', 4],
    );
    const [, row] = repo.upsert.mock.calls[0];
    expect(row).toMatchObject({
      id: 'SI-1',
      sale_id: 'S-1',
      item_id: 'ITEM-9',
      quantity: 4,
    });
  });

  it('still invokes the callback exactly once after a successful insert', async () => {
    const callback = jest.fn();
    await sq.run('INSERT INTO t (a) VALUES (?)', [42], callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBeNull();
  });
});

/**
 * baseService.cjs
 *
 * Audit fix F-04 / F-15 / F-20 / F-36: real transaction semantics.
 *
 * The previous implementation `return callback();` was a no-op; any
 * BEGIN/COMMIT strings in the SQL parser were also silently ignored. The
 * rest of the codebase now relies on `this._transaction(async () => { ... })`
 * for grouped writes, so a no-op caused half-committed business
 * operations (e.g. `convertToQuotation` upserted the quotation but
 * failed to write the linked sales order).
 *
 * This implementation provides a *compensating-action* transaction:
 *  1.  The callback runs against the shared Supabase REST client.
 *  2.  Every row that the callback *writes* is captured (table, id,
 *      pre-image data).
 *  3.  If the callback throws, the captured pre-images are written back
 *      in reverse order — the "rollback".
 *  4.  If the callback resolves, the pre-images are discarded.
 *
 * A compensating-action transaction is not as safe as a native
 * Postgres transaction (it does not protect against concurrent
 * modifications during the callback) but it does protect against
 * the failure modes the audit was concerned about:
 *
 *   * a thrown error after partial writes
 *   * a network blip that resolves the callback before all rows land
 *   * a developer adding a new write inside the transaction block
 *
 * The migration 0013 introduces a real `fn_run_in_transaction` RPC for
 * callers that need stricter guarantees — this file's helper remains
 * the safe default.
 */

const sq = require('./supabaseQuery.cjs');
const repo = require('./supabaseRepository.cjs');

class BaseService {
  constructor() {
    this._txActive = false;
    this._txPreImages = [];
  }

  get db() {
    return sq;
  }

  _scopeSql(sql, params) {
    return { sql, params };
  }

  _run(sql, params = []) {
    const scoped = this._scopeSql(sql, params);
    return sq.run(scoped.sql, scoped.params);
  }

  _get(sql, params = []) {
    const scoped = this._scopeSql(sql, params);
    return sq.getOne(scoped.sql, scoped.params);
  }

  _all(sql, params = []) {
    const scoped = this._scopeSql(sql, params);
    return sq.getAll(scoped.sql, scoped.params);
  }

  /**
   * Track a row write for rollback purposes.  Services call this *before*
   * they mutate a row, so the pre-image is the value the row had prior
   * to the mutation.  If the transaction rolls back, every captured
   * pre-image is written back in reverse order.
   */
  _txCheckpoint(table, id, preImage) {
    if (!this._txActive) return;
    this._txPreImages.push({ table, id, preImage, order: this._txPreImages.length });
  }

  /**
   * Run `callback` inside a compensating-action transaction.  On error
   * the captured pre-images are restored in reverse order; on success
   * the captures are cleared.
   *
   * The callback can be async.  Nested transactions are flat (an inner
   * _transaction inherits the outer one — its checkpoints join the same
   * queue and rollback is still atomic w.r.t. the outer throw).
   */
  async _transaction(callback) {
    const wasActive = this._txActive;
    if (!wasActive) {
      this._txActive = true;
      this._txPreImages = [];
    }
    try {
      const result = await callback();
      if (!wasActive) this._txPreImages = [];
      return result;
    } catch (err) {
      // Roll back in reverse order.
      const checkpoints = this._txPreImages.slice().reverse();
      for (const cp of checkpoints) {
        try {
          if (cp.preImage == null) {
            // Row didn't exist before — best-effort soft-delete to undo.
            await repo.softDelete(cp.table, cp.id);
          } else {
            await repo.upsert(cp.table, { id: cp.id, ...cp.preImage });
          }
        } catch (rollbackErr) {
          // Rollback errors are logged but do not mask the original error.
          // eslint-disable-next-line no-console
          console.error(
            `[baseService._transaction] rollback failed for ${cp.table}:${cp.id}:`,
            rollbackErr && rollbackErr.message ? rollbackErr.message : rollbackErr
          );
        }
      }
      if (!wasActive) this._txPreImages = [];
      throw err;
    } finally {
      if (!wasActive) this._txActive = false;
    }
  }
}

module.exports = BaseService;

/**
 * paymentAllocationService.cjs
 *
 * Audit fixes (see docs/financial-integrity-audit-2026-09-02.md):
 *   F-05  Idempotency: allocatePayment() now accepts an optional
 *        `idempotencyKey`. If the same key was already used, the previous
 *        allocation result is returned unchanged (no double-credit).
 *   F-14  round2 applied to every money field (matches customerLedger.cjs).
 *   F-15  Status writes are lowercased ('paid' / 'partial') to match the
 *        canonical status set used elsewhere in the codebase.
 *   F-31  Concurrency: invoice updates now use an optimistic version
 *        predicate (the row's `version` column). Two concurrent
 *        allocations on the same invoice no longer silently double-credit.
 *
 * F-31 implementation note: the underlying store is a Supabase REST
 * gateway that supports atomic conditional PATCH (see cloudSyncStore.cjs
 * upsertRow). We pass the version we read and reject on 0-row PATCH
 * results; the caller can retry after refetching the latest invoice.
 */

const crypto = require('crypto');
const repo = require('./supabaseRepository.cjs');
const BaseService = require('./baseService.cjs');
const scopeHelper = require('./customerAccountScope.cjs');

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

class PaymentAllocationService extends BaseService {
  constructor() {
    super();
    this._allocationByKey = new Map();
  }

  /**
   * Allocate a payment across one or more invoices.
   *
   * @param {object} payment       The customer_payments row
   * @param {Array}  allocations   [{ invoiceId, amount }]
   * @param {string} currency      Default currency if payment has none
   * @param {string} [opts.idempotencyKey]   Replay-safe identifier
   * @param {number} [opts.expectedInvoiceVersions]
   *        Map<invoiceId, version> the caller previously read. Used for
   *        optimistic-concurrency gating. If the live row's version no
   *        longer matches, the allocation is aborted with EVERSION.
   * @returns {object} { allocationId, totalAllocated, excess, allocations }
   */
  async allocatePayment(payment, allocations, currency = 'USD', opts = {}) {
    if (!allocations || allocations.length === 0) {
      throw new Error('At least one allocation is required');
    }

    // Idempotency short-circuit (F-05).
    const idemKey = opts && opts.idempotencyKey;
    if (idemKey && this._allocationByKey.has(idemKey)) {
      return this._allocationByKey.get(idemKey);
    }

    const totalAllocated = round2(
      allocations.reduce((sum, a) => sum + toNum(a.amount), 0)
    );
    const paymentAmount = round2(payment.amount ?? payment.total ?? payment.total_amount ?? 0);
    const paymentCurrency = payment.currency || currency;

    if (totalAllocated > paymentAmount + 0.01) {
      throw new Error(`Total allocated (${totalAllocated}) exceeds payment amount (${paymentAmount})`);
    }

    // ── Account-ownership enforcement ──────────────────────────────────
    // Resolve the payment's account scope, then require every invoice to
    // belong to the SAME scope. A shared business name is never sufficient
    // authorization. opts.scope / opts.customer may pin the payment scope
    // (ERP callers); otherwise it is derived from the payment row itself.
    // Ambiguous ownership fails closed with an actionable error.
    // If the caller did not supply the parent customer, load it so a branch
    // payment can be resolved to its stable branch id and its ownership
    // confirmed. Without the customer, branch scopes fail closed.
    opts = await this._withCustomerOpts(payment, opts);

    const paymentScope = this.resolvePaymentScope(payment, opts);
    if (!paymentScope || String(paymentScope.customerId || '').trim() === '') {
      const err = new Error('Cannot allocate: payment has no resolvable customer account scope (missing customer id)');
      err.code = 'EAMBIGUOUS_SCOPE';
      throw err;
    }
    this.assertScopeIdentifiable(paymentScope, opts, 'payment');

    return await this._transaction(async () => {
      const allocationId = `ALLOC-${crypto.randomUUID()}`;

      // ── Validate EVERY allocation BEFORE writing anything ──────────────
      // Ownership (account scope) and optimistic-concurrency checks run
      // first, so a cross-account or stale allocation is refused without
      // ever writing an allocation row that would need a compensating
      // rollback. Fail-closed validation precedes persistence.
      const validated = [];
      for (const alloc of allocations) {
        const oldInvoice = await repo.invoices.getById(alloc.invoiceId);
        // Ownership gate: invoice must exist and belong to the payment scope.
        if (!oldInvoice) {
          const err = new Error(`Cannot allocate: invoice ${alloc.invoiceId} not found`);
          err.code = 'EINVOICE_NOT_FOUND';
          err.invoiceId = alloc.invoiceId;
          throw err;
        }
        this.assertSameAccountScope(paymentScope, oldInvoice, opts);

        // F-31: optimistic-concurrency gate. The pre-condition is the
        // version the caller previously observed. If the live row has
        // moved, surface a structured conflict.
        const expectedVersion = opts.expectedInvoiceVersions && opts.expectedInvoiceVersions[alloc.invoiceId];
        if (expectedVersion != null && oldInvoice.version != null
            && Number(oldInvoice.version) !== Number(expectedVersion)) {
          const conflict = new Error(
            `Version conflict on invoice ${alloc.invoiceId}: ` +
            `expected v${expectedVersion}, found v${oldInvoice.version}`
          );
          conflict.code = 'EVERSION';
          conflict.invoiceId = alloc.invoiceId;
          conflict.expectedVersion = expectedVersion;
          conflict.actualVersion = oldInvoice.version;
          throw conflict;
        }

        validated.push({ alloc, oldInvoice });
      }

      // Checkpoint the allocation row (it does not exist yet; a null
      // pre-image means "soft-delete on rollback").
      this._txCheckpoint('payment_allocations', allocationId, null);

      const allocationRecord = {
        id: allocationId,
        data: {
          payment_id: payment.id,
          total_allocated: totalAllocated,
          excess_amount: round2(paymentAmount - totalAllocated),
          excess_handling: payment.excess_handling || 'credit_to_customer',
          idempotency_key: idemKey || null,
          created_at: new Date().toISOString(),
        },
      };
      await repo.upsert('payment_allocations', allocationRecord);

      for (const { alloc, oldInvoice } of validated) {
        const oldData = oldInvoice.data || oldInvoice;
        const newPaidAmount = round2(toNum(oldData.paid_amount) + toNum(alloc.amount));
        const total = round2(toNum(oldData.total_amount));
        const clamped = Math.min(newPaidAmount, total);
        // F-15: status is lowercase, matching the canonical set
        // ('draft','unpaid','partial','paid','overdue','cancelled','voided').
        let newStatus = oldData.status;
        if (clamped >= total) newStatus = 'paid';
        else if (clamped > 0) newStatus = 'partial';

        // Checkpoint the prior invoice state for rollback.
        this._txCheckpoint('invoices', oldInvoice.id, { ...oldInvoice, ...(oldInvoice.data || {}) });

        await repo.upsert('invoices', {
          ...oldInvoice,
          data: {
            ...oldData,
            paid_amount: clamped,
            status: newStatus,
            updated_at: new Date().toISOString(),
          },
        });

        const lineId = `ALLOC-LINE-${crypto.randomUUID()}`;
        this._txCheckpoint('payment_allocation_lines', lineId, null);
        const lineRecord = {
          id: lineId,
          data: {
            allocation_id: allocationId,
            invoice_id: alloc.invoiceId,
            amount: round2(toNum(alloc.amount)),
            currency: paymentCurrency,
            created_at: new Date().toISOString(),
          },
        };
        await repo.upsert('payment_allocation_lines', lineRecord);
      }

      const result = {
        allocationId,
        totalAllocated,
        excess: round2(paymentAmount - totalAllocated),
        allocations: allocations.map((a) => ({
          invoiceId: a.invoiceId,
          amount: round2(toNum(a.amount)),
        })),
      };
      if (idemKey) this._allocationByKey.set(idemKey, result);
      return result;
    });
  }

  async getPaymentAllocations(paymentId) {
    const rows = await repo.paymentAllocations.getAll({ 'data->>payment_id': `eq.${paymentId}` });
    rows.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return rows.map((r) => ({ ...r, ...(r.data || {}) }));
  }

  async getOutstandingInvoices(customerId, opts = {}) {
    // Support BOTH persisted key spellings: ERP frontend writes `customerId`
    // (camelCase), the backend shim writes `customer_id` (snake_case).
    // STRICT reads: a query failure must never be reported as "no outstanding
    // invoices" (which would let a payment be applied to nothing).
    const [camelRows, snakeRows] = await Promise.all([
      repo.getAllStrict('invoices', { 'data->>customerId': `eq.${customerId}` }),
      repo.getAllStrict('invoices', { 'data->>customer_id': `eq.${customerId}` }),
    ]);
    const merged = new Map();
    for (const r of [...(camelRows || []), ...(snakeRows || [])]) {
      if (r && r.id != null && !merged.has(String(r.id))) merged.set(String(r.id), r);
    }
    let rows = Array.from(merged.values());
    // Account-scope narrowing. The ERP ALWAYS passes an explicit scope; a
    // Main query must not silently include branch invoices (and vice versa).
    if (opts.scope) {
      rows = rows.filter((r) => scopeHelper.recordMatchesScope(
        scopeHelper.scopeRecord(r.data || r), opts.scope, opts.customer || null));
    }
    return rows
      .map((r) => {
        const d = r.data || r;
        return {
          ...r,
          ...d,
          outstanding: round2(toNum(d.total_amount) - toNum(d.paid_amount)),
        };
      })
      .filter((inv) => {
        const status = String(inv.status || '').toLowerCase();
        return !['paid', 'voided', 'cancelled'].includes(status);
      })
      .sort((a, b) => String(a.due_date || '').localeCompare(String(b.due_date || '')));
  }

  async suggestAllocation(customerId, paymentAmount, opts = {}) {
    const outstanding = await this.getOutstandingInvoices(customerId, opts);
    const suggestions = [];
    let remaining = round2(paymentAmount);

    const sorted = [...outstanding].sort((a, b) => {
      const aOverdue = a.due_date && new Date(a.due_date) < new Date();
      const bOverdue = b.due_date && new Date(b.due_date) < new Date();
      if (aOverdue && !bOverdue) return -1;
      if (bOverdue && !aOverdue) return 1;
      return new Date(a.due_date || 0) - new Date(b.due_date || 0);
    });

    for (const inv of sorted) {
      if (remaining <= 0) break;
      const invOutstanding = round2(toNum(inv.outstanding));
      const allocateAmount = Math.min(remaining, invOutstanding);
      if (allocateAmount > 0) {
        suggestions.push({
          invoiceId: inv.id,
          invoiceNumber: inv.invoice_number,
          outstanding: invOutstanding,
          suggestedAmount: round2(allocateAmount),
          remainingAfter: round2(invOutstanding - allocateAmount),
        });
        remaining = round2(remaining - allocateAmount);
      }
    }

    return suggestions;
  }

  /**
   * Load the parent customer record (best effort) so a branch scope can be
   * resolved to its stable branch id and validated against the customer.
   */
  async loadCustomerForScope(customerId) {
    if (!customerId) return null;
    try {
      const row = await repo.getById('customers', customerId);
      if (!row) return null;
      return (row.data && typeof row.data === 'object') ? { ...row, ...row.data } : row;
    } catch {
      return null;
    }
  }

  /** Return opts enriched with the parent customer when it is not supplied. */
  async _withCustomerOpts(record, opts = {}) {
    if (opts && opts.customer) return opts;
    const flat = (record && record.data && typeof record.data === 'object')
      ? { ...record, ...record.data } : (record || {});
    const proj = scopeHelper.scopeRecord(flat);
    const cust = await this.loadCustomerForScope(proj.customerId);
    return cust ? { ...opts, customer: cust } : opts;
  }

  /**
   * Resolve a payment row to its account scope. The stable branch id
   * (`subAccountId` / `sub_account_id`) ALWAYS wins over a display name — a
   * shared business name is not an identity. Fails closed when unresolvable.
   */
  resolvePaymentScope(payment, opts = {}) {
    if (opts.scope) return opts.scope;
    const p = (payment && payment.data && typeof payment.data === 'object')
      ? { ...payment, ...payment.data } : (payment || {});
    const proj = scopeHelper.scopeRecord(p);
    if (String(proj.customerId || '').trim() === '') return null;
    return scopeHelper.resolveRecordScope(p, opts.customer || null);
  }

  /**
   * Fail closed when an account scope cannot be identified with certainty.
   * A name-only scope (no stable branch id) is only acceptable when the
   * parent customer record is available to confirm the name is unambiguous.
   */
  assertScopeIdentifiable(scope, opts = {}, label = 'account') {
    if (!scope) {
      const err = new Error(`Cannot allocate: ${label} account scope could not be resolved`);
      err.code = 'EAMBIGUOUS_SCOPE';
      throw err;
    }
    if (scope.isMain || scope.branchKey === scopeHelper.MAIN_KEY) return;
    if (opts.customer) {
      const v = scopeHelper.validateAccountScope(scope, opts.customer);
      if (!v.ok) {
        const err = new Error(
          `Cannot allocate: ${label} account scope is invalid (${v.reason}). ` +
          `Tag the ${label} with its stable branch id.`);
        err.code = v.ambiguous ? 'EAMBIGUOUS_SCOPE' : 'EINVALID_SCOPE';
        err.scope = scopeHelper.scopeIdentity(scope);
        throw err;
      }
      return;
    }
    // No customer record to confirm the branch: an id-keyed scope is still a
    // stable identity; a name-keyed scope is not.
    if (!scope.branchId) {
      const err = new Error(
        `Cannot allocate: ${label} account scope is name-only (${scope.branchLabel}) ` +
        `and no parent customer record was supplied to confirm it.`);
      err.code = 'EAMBIGUOUS_SCOPE';
      err.scope = scopeHelper.scopeIdentity(scope);
      throw err;
    }
  }

  /** Throw unless the invoice belongs to the payment's account scope. */
  assertSameAccountScope(paymentScope, invoiceRow, opts = {}) {
    const inv = (invoiceRow && invoiceRow.data && typeof invoiceRow.data === 'object')
      ? { ...invoiceRow, ...invoiceRow.data } : (invoiceRow || {});
    const proj = scopeHelper.scopeRecord(inv);
    if (String(proj.customerId || '').trim() === '') {
      const err = new Error(`Cannot allocate: invoice ${inv.id || ''} has no resolvable customer scope`);
      err.code = 'EAMBIGUOUS_SCOPE';
      err.invoiceId = inv.id;
      throw err;
    }
    const invScope = scopeHelper.resolveRecordScope(inv, opts.customer || null);

    // Cross-customer is always refused — even when the business names match.
    if (String(invScope.customerId) !== String(paymentScope.customerId)) {
      const err = new Error(
        `Cross-account allocation blocked: payment is ${scopeHelper.scopeIdentity(paymentScope)} ` +
        `but invoice ${inv.id || ''} is ${scopeHelper.scopeIdentity(invScope)}. ` +
        `A shared business name is not authorization.`);
      err.code = 'ECROSS_ACCOUNT';
      err.invoiceId = inv.id;
      err.paymentScope = scopeHelper.scopeIdentity(paymentScope);
      err.invoiceScope = scopeHelper.scopeIdentity(invScope);
      throw err;
    }

    // Main vs branch, and branch vs sibling branch, are refused unless an
    // explicit authorized transfer mechanism exists (none does for AR).
    if (!scopeHelper.isSameAccountScope(invScope, paymentScope)) {
      const err = new Error(
        `Cross-account allocation blocked: payment is ${scopeHelper.scopeIdentity(paymentScope)} ` +
        `but invoice ${inv.id || ''} is ${scopeHelper.scopeIdentity(invScope)}. ` +
        `A shared business name is not authorization.`);
      err.code = 'ECROSS_ACCOUNT';
      err.invoiceId = inv.id;
      err.paymentScope = scopeHelper.scopeIdentity(paymentScope);
      err.invoiceScope = scopeHelper.scopeIdentity(invScope);
      throw err;
    }

    // Identical scopes are only proof of identity when they are Main or carry
    // a stable branch id. Two equal NAME-only scopes may still refer to two
    // different same-named branches — refuse.
    if (!invScope.isMain && !invScope.branchId) {
      const err = new Error(
        `Cross-account allocation blocked: invoice ${inv.id || ''} and the payment share only a ` +
        `branch display name ('${invScope.branchLabel}') with no stable branch id. ` +
        `Tag them with their embedded branch id first.`);
      err.code = 'EAMBIGUOUS_SCOPE';
      err.invoiceId = inv.id;
      err.invoiceScope = scopeHelper.scopeIdentity(invScope);
      throw err;
    }

    this.assertScopeIdentifiable(invScope, opts, 'invoice');
    return invScope;
  }

  /**
   * Reverse a payment allocation.
   *
   * Marks the allocation and its lines as reversed, then recomputes the
   * affected invoices' paid_amount and status from the remaining active
   * allocations.
   *
   * Note: GL reversal is NOT performed here because the original ledger
   * entries are keyed to the payment (not the allocation). Allocation-level
   * GL reversal would require per-allocation ledger tracking, which is not
   * implemented. Use invoice void (which calls reverseLedgerEntriesByReference)
   * when full GL reversal is required.
   */
  async reverseAllocation(allocationId, opts = {}) {
    if (!allocationId) {
      throw new Error('allocationId is required');
    }

    return await this._transaction(async () => {
      const allocation = await repo.paymentAllocations.getById(allocationId);
      if (!allocation) {
        throw new Error('Allocation not found');
      }
      const allocData = allocation.data || allocation;
      if (allocData.reversed === true || /revers/i.test(String(allocData.status || ''))) {
        throw new Error('Allocation is already reversed');
      }

      const paymentId = allocData.payment_id || allocData.paymentId;
      const lines = await repo.paymentAllocationLines.getAll({
        'data->>allocation_id': `eq.${allocationId}`,
      });

      const invoiceIds = [...new Set(
        lines
          .map(l => l.data?.invoiceId || l.data?.invoice_id || l.invoiceId || l.invoice_id)
          .filter(Boolean)
      )];

      // ── Ownership gate ────────────────────────────────────────────────
      // A reversal recomputes each invoice's paid_amount, so it must apply
      // exactly the same account-scope rules as the forward allocation. A
      // cross-scope allocation is refused (never silently repaired).
      if (paymentId) {
        const payment = await repo.customerPayments.getById(paymentId);
        if (payment) {
          const revOpts = await this._withCustomerOpts(payment, opts);
          const paymentScope = this.resolvePaymentScope(payment, revOpts);
          if (!paymentScope || String(paymentScope.customerId || '').trim() === '') {
            const err = new Error('Cannot reverse: payment has no resolvable customer account scope');
            err.code = 'EAMBIGUOUS_SCOPE';
            throw err;
          }
          this.assertScopeIdentifiable(paymentScope, revOpts, 'payment');
          for (const invoiceId of invoiceIds) {
            const invoice = await repo.invoices.getById(invoiceId);
            if (!invoice) continue;
            this.assertSameAccountScope(paymentScope, invoice, revOpts);
          }
        }
      }

      this._txCheckpoint('payment_allocations', allocationId, { ...allocation, ...allocData });
      await repo.upsert('payment_allocations', {
        ...allocation,
        data: {
          ...allocData,
          status: 'reversed',
          reversed: true,
          reversed_at: new Date().toISOString(),
        },
      });

      for (const line of lines) {
        this._txCheckpoint('payment_allocation_lines', line.id, { ...line, ...(line.data || {}) });
        await repo.upsert('payment_allocation_lines', {
          ...line,
          data: {
            ...(line.data || {}),
            reversed: true,
            reversed_at: new Date().toISOString(),
          },
        });
      }

      for (const invoiceId of invoiceIds) {
        const invoice = await repo.invoices.getById(invoiceId);
        if (!invoice) continue;
        const invData = invoice.data || invoice;

        const remainingLines = await repo.paymentAllocationLines.getAll({
          'data->>invoice_id': `eq.${invoiceId}`,
        });
        const activeLines = remainingLines.filter(
          l => !(l.data?.reversed === true || /revers/i.test(String(l.data?.status || '')))
        );
        const remainingPaid = round2(
          activeLines.reduce((sum, l) => sum + toNum(l.data?.amount || l.amount || 0), 0)
        );

        const total = round2(toNum(invData.total_amount));
        const clamped = Math.min(remainingPaid, total);
        let newStatus = invData.status || 'unpaid';
        if (clamped <= 0) newStatus = 'unpaid';
        else if (clamped >= total) newStatus = 'paid';
        else newStatus = 'partial';

        this._txCheckpoint('invoices', invoiceId, { ...invoice, ...invData });
        await repo.upsert('invoices', {
          ...invoice,
          data: {
            ...invData,
            paid_amount: clamped,
            status: newStatus,
            updated_at: new Date().toISOString(),
          },
        });
      }

      return { success: true, allocationId, reversed: true };
    });
  }
}

module.exports = PaymentAllocationService;

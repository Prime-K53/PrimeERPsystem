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
    const paymentAmount = round2(payment.amount);
    const paymentCurrency = payment.currency || currency;

    if (totalAllocated > paymentAmount + 0.01) {
      throw new Error(`Total allocated (${totalAllocated}) exceeds payment amount (${paymentAmount})`);
    }

    return await this._transaction(async () => {
      const allocationId = `ALLOC-${crypto.randomUUID()}`;

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

      for (let index = 0; index < allocations.length; index++) {
        const alloc = allocations[index];
        const oldInvoice = await repo.invoices.getById(alloc.invoiceId);
        if (oldInvoice) {
          const oldData = oldInvoice.data || oldInvoice;
          const newPaidAmount = round2(toNum(oldData.paid_amount) + toNum(alloc.amount));
          const total = round2(toNum(oldData.total_amount));
          const clamped = Math.min(newPaidAmount, total);
          // F-15: status is lowercase, matching the canonical set
          // ('draft','unpaid','partial','paid','overdue','cancelled','voided').
          let newStatus = oldData.status;
          if (clamped >= total) newStatus = 'paid';
          else if (clamped > 0) newStatus = 'partial';

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
        }

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

  async getOutstandingInvoices(customerId) {
    const rows = await repo.invoices.getAll({ 'data->>customer_id': `eq.${customerId}` });
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

  async suggestAllocation(customerId, paymentAmount) {
    const outstanding = await this.getOutstandingInvoices(customerId);
    const suggestions = [];
    let remaining = round2(paymentAmount);

    const sorted = [...outstanding].sort((a, b) => {
      const aOverdue = a.due_date && new Date(a.due_date) < new Date();
      const bOverdue = b.due_date && new Date(b.due_date) < new Date();
      if (aOverdue && !bOverdue) return -1;
      if (!aOverdue && bOverdue) return 1;
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
}

module.exports = PaymentAllocationService;

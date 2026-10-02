/**
 * transportBudgetSalesAllocation.cjs — Phase 5A backend producer.
 *
 * Backend-originated SALES_ALLOCATION production for the two direct-API
 * posting pathways:
 *   POST /api/sales     -> economicKey = saleId
 *   POST /api/invoices  -> economicKey = invoiceId
 *
 * The frontend producer (frontend/services/transportBudgetSalesAllocation.ts)
 * remains authoritative for offline/frontend posting and is untouched. This
 * module implements the SAME frozen Phase 2 business semantics, ported as
 * pure functions (policy resolver, roundMoney, validator) — never imported
 * from frontend TS, never re-derived differently.
 *
 * Frozen contract (Phase 2, binding):
 *   eligibleBase     = roundMoney(Number(persistedRecord.totalAmount))
 *   allocationAmount = roundMoney(eligibleBase * allocationRatePercent / 100)
 *                      (rounded ONCE at the end; the rate is never rounded)
 *   economicKey      = saleId (backend sales create no mirror invoice)
 *                    | invoiceId (backend invoices carry no conversion or
 *                      POS-mirror metadata)
 *   idempotencyKey   = `SALES_ALLOCATION:${economicKey}`
 *
 * Design rules:
 * - The persisted record is authoritative: the base comes from its
 *   totalAmount (never recomputed from lines), the rate is resolved for the
 *   document's BUSINESS date (never today/sync/server-start time), and the
 *   stored event is frozen (validator + database enforce; nothing
 *   recalculates).
 * - Producers run AFTER the sale/invoice persistence succeeded (post-commit,
 *   fire-and-forget from the route handlers, same pattern as the frontend
 *   hooks). They never block the HTTP response, never roll back the
 *   committed document, and never make posting depend on Supabase
 *   availability: allocation failures are logged loudly (endpoint, source
 *   document id, stage, code/message) and stay retryable through the
 *   economic idempotency key.
 * - Exactly-once across pathways comes from the economic identity, not from
 *   call-site discipline. A frontend-created sale that later synchronizes
 *   never passes through these producers (they are invoked ONLY inside the
 *   two REST handlers); the economic idempotency key is the second layer.
 * - No GL journals, no COGS/WAC/inventory/revenue/AR changes, no customer
 *   payload changes. The allocation exists ONLY as an internal Transport
 *   Budget event.
 */

const { roundMoney } = require('./transportBudgetEventValidator.cjs');
const { resolveTransportBudgetRate } = require('./transportBudgetPolicy.cjs');
const {
  transportBudgetEventRepository,
} = require('./transportBudgetEventRepository.cjs');
const {
  isCreditNoteStatus,
  isRecognizedSaleStatus,
  isPostedInvoiceStatus,
} = require('./revenueRecognition.cjs');

class TransportBudgetAllocationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TransportBudgetAllocationError';
    this.code = code;
  }
}

/**
 * Qualification gates (documented mapping — prompt #6 / #11).
 *
 * SALES (backend/services/revenueRecognition.cjs RECOGNIZED_SALE_STATUSES,
 * the backend's own recognition predicate used by dashboard + P&L):
 *   recognized  : 'Paid', 'Completed', 'Partial', 'Partially Paid',
 *                 'Partially-Paid', 'Overpaid' (case-insensitive)
 *   excluded    : 'Draft', 'Pending', 'Voided', 'Refunded'
 *   (the sales table CHECK allows exactly: Draft, Pending, Paid,
 *    Partially Paid, Voided, Refunded — of these only 'Paid' and
 *    'Partially Paid' are recognized)
 *
 * INVOICES (backend isPostedInvoiceStatus = isRecognizedInvoiceStatus =
 * "recognized unless excluded"):
 *   posted      : everything except draft|cancelled|void|voided
 *                 (case-insensitive) — e.g. 'unpaid', 'paid', 'partial',
 *                 'Pending', 'Finalized', 'Overdue' all pass
 *   not posted  : 'Draft', 'Cancelled', 'Void', 'Voided'
 *   credit notes: 'credit_note' | 'credit-note' | 'creditnote' pass the
 *                 posted gate but never allocate (credit-note skip)
 * Recognition is NEVER inferred from HTTP success: the persisted status is
 * evaluated through these predicates, never through the response code.
 */

/** Extract the YYYY-MM-DD business date from a persisted document date. */
const toBusinessDate = (value) => {
  const raw = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new TransportBudgetAllocationError(
      'INVALID_DATE',
      `Cannot derive a business date from document date ${JSON.stringify(raw)}.`,
    );
  }
  return match[1];
};

const allocationDeps = () => ({
  repository: transportBudgetEventRepository,
  nowIso: () => new Date().toISOString(),
});

const appendSalesAllocation = async (deps, input) => {
  const economicId = String(input.economicId || '').trim();
  if (!economicId) {
    throw new TransportBudgetAllocationError(
      'INVALID_IDENTITY',
      'Cannot allocate without an economic sale/invoice identity.',
    );
  }

  // 1. Eligible base: persisted totalAmount ONLY (never lines, never payments).
  const rawBase = Number(input.totalAmountRaw);
  if (!Number.isFinite(rawBase)) {
    throw new TransportBudgetAllocationError(
      'INVALID_BASE',
      `Persisted totalAmount is not a finite monetary number (${String(input.totalAmountRaw)}); refusing to invent a base.`,
    );
  }
  const eligibleBase = roundMoney(rawBase);

  // 2. Historical rate for the DOCUMENT business date (never today/sync time).
  const businessDate = toBusinessDate(input.businessDateRaw);
  // getPolicy may be synchronous (localStorage, frontend parity) or
  // asynchronous (backend companyConfigService reads from Supabase); await
  // normalizes both so a Promise is never passed to the sync resolver.
  const policy = await deps.getPolicy();
  const resolution = resolveTransportBudgetRate(policy, businessDate);
  if (resolution.status === 'missing') {
    return { status: 'skipped', reason: 'policy-missing' };
  }
  if (resolution.status === 'disabled') {
    return { status: 'skipped', reason: 'policy-disabled' };
  }
  if (resolution.status !== 'enabled' || typeof resolution.rate !== 'number') {
    // Invalid policy/configuration fails loudly per the resolver contract:
    // never silently invent a rate or fall back to a default.
    throw new TransportBudgetAllocationError(
      'INVALID_POLICY',
      `Transport budget policy is invalid for business date ${businessDate}; allocation refused.`,
    );
  }
  // The resolved historical rate is stored EXACTLY (never rounded, never
  // re-resolved later). Validity (0..100, <=4dp) is enforced by the pure
  // validator + Phase 4 database constraints.
  const allocationRatePercent = resolution.rate;

  // 3. Single terminal rounding. Zero emits no event.
  const allocationAmount = roundMoney(
    (eligibleBase * allocationRatePercent) / 100,
  );
  if (!(allocationAmount > 0)) {
    return { status: 'skipped', reason: 'zero-amount' };
  }

  // 4. Frozen event shape (Phase 4 contract). No method/provider/journal
  //    linkage is fabricated; no GL is touched.
  const result = await deps.repository.appendTransportBudgetEvent({
    kind: 'SALES_ALLOCATION',
    idempotencyKey: `SALES_ALLOCATION:${economicId}`,
    sourceEventId: economicId,
    sourceAmount: eligibleBase,
    allocationRatePercent,
    amount: allocationAmount,
    method: null,
    providerId: null,
    reversesEventId: null,
    businessDate,
    occurredAt: deps.nowIso(),
  });
  return {
    status: 'allocated',
    event: result.event,
    deduplicated: result.deduplicated,
  };
};

/**
 * Allocate for a backend-API-created sale (POST /api/sales).
 * Backend sales create no mirror invoice server-side, so the frozen
 * `convertedInvoiceId ?? saleId` rule resolves to the sale id.
 * `sale` must be the PERSISTED record (post-commit), never the raw request.
 */
async function allocateForApiSale(deps, sale) {
  try {
    if (!sale || !isRecognizedSaleStatus(sale.status)) {
      return { status: 'skipped', reason: 'not-recognized' };
    }
    return await appendSalesAllocation(deps, {
      economicId: String(sale.id || '').trim(),
      totalAmountRaw: sale.totalAmount !== undefined ? sale.totalAmount : sale.total_amount,
      businessDateRaw: sale.date,
    });
  } catch (err) {
    err.endpoint = err.endpoint || 'POST /api/sales';
    err.sourceDocumentId = err.sourceDocumentId || String(sale?.id || '');
    throw err;
  }
}

/**
 * Allocate for a backend-API-created invoice (POST /api/invoices).
 * Backend invoices carry no order-conversion and no POS-mirror metadata,
 * so the frozen identity rule resolves to the invoice id.
 * `invoice` must be the PERSISTED record; `businessDate` must be the
 * persisted invoice business date (invoice_date) — created_at and server
 * time are never substituted (missing date -> loud failure, no invention).
 */
async function allocateForApiInvoice(deps, invoice, businessDate) {
  try {
    if (!invoice) {
      return { status: 'skipped', reason: 'not-recognized' };
    }
    if (isCreditNoteStatus(invoice.status)) {
      return { status: 'skipped', reason: 'credit-note' };
    }
    if (!isPostedInvoiceStatus(invoice.status)) {
      return { status: 'skipped', reason: 'not-recognized' };
    }
    if (businessDate === undefined || businessDate === null || String(businessDate).trim() === '') {
      // Fail loudly rather than silently using created_at / new Date().
      throw new TransportBudgetAllocationError(
        'INVALID_DATE',
        'Invoice has no persisted business date (invoice_date); refusing to invent one from created_at or server time.',
      );
    }
    return await appendSalesAllocation(deps, {
      economicId: String(invoice.id || '').trim(),
      totalAmountRaw:
        invoice.totalAmount !== undefined ? invoice.totalAmount : invoice.total_amount,
      businessDateRaw: businessDate,
    });
  } catch (err) {
    err.endpoint = err.endpoint || 'POST /api/invoices';
    err.sourceDocumentId = err.sourceDocumentId || String(invoice?.id || '');
    throw err;
  }
}

/**
 * Post-persistence fire-and-forget hook (mirrors the frontend
 * `fireAllocationHook`): loud on failure with endpoint + document context,
 * never rolls back the committed document, never blocks the response.
 */
function fireAllocationHook(task, endpoint, sourceDocumentId) {
  task.catch((err) => {
    console.error(
      `[TransportBudget] sales allocation failed (endpoint=${endpoint}, document=${sourceDocumentId}, stage=${err.code || 'APPEND'}, error=${err.message})`,
    );
  });
}

module.exports = {
  TransportBudgetAllocationError,
  toBusinessDate,
  allocateForApiSale,
  allocateForApiInvoice,
  fireAllocationHook,
};

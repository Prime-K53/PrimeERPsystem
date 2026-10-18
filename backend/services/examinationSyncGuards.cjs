/**
 * Examination sync guards — server-side business rules for the envelope tables.
 *
 * Design contract: every rule here is expressed as a PostgREST filter that is
 * appended to the SAME conditional PATCH that performs the write. The rule is
 * therefore evaluated by PostgreSQL inside the write's transaction, not by a
 * prior read. Any `require` here must stay side-effect free and pure so it can
 * be unit tested without a database.
 */

const EXAMINATION_BATCH_TABLE = 'examination_batches';
const INVOICE_TABLE = 'invoices';

/** Statuses whose pricing snapshot is frozen. Mirrors the canonical client set. */
const LOCKED_BATCH_STATUSES = ['approved', 'invoiced', 'completed', 'paid'];

/**
 * Allowed authoritative predecessor statuses per incoming status.
 * A write is admitted only when the stored row's status is in this set, which
 * PostgREST evaluates as `data->>status=in.(...)` on the conditional PATCH.
 */
const ALLOWED_PREDECESSOR_STATUSES = {
  draft: ['draft'],
  calculated: ['draft', 'calculated'],
  approved: ['draft', 'calculated', 'approved'],
  invoiced: ['approved', 'invoiced'],
  completed: ['approved', 'invoiced', 'completed'],
  paid: ['invoiced', 'completed', 'paid'],
};

const normalizeStatus = (value) => String(value == null ? '' : value).trim().toLowerCase();

const isLockedStatus = (status) => LOCKED_BATCH_STATUSES.includes(normalizeStatus(status));

const toList = (values) => `in.(${values.join(',')})`;

/**
 * Precondition for an examination_batches upsert, derived from the incoming
 * status alone so no read is required to decide the guard.
 * Returns null when no status precondition applies (e.g. a create with no status).
 */
const buildBatchUpsertPrecondition = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const incoming = normalizeStatus(payload.status);
  if (!incoming) return null;
  const allowed = ALLOWED_PREDECESSOR_STATUSES[incoming];
  if (!allowed) {
    return { filters: { 'data->>status': `not.in.(${LOCKED_BATCH_STATUSES.join(',')})` } };
  }
  return { filters: { 'data->>status': toList(allowed) } };
};

/**
 * Tombstones may only land on batches that carry no financial commitment.
 * Encoded as a status exclusion on the same conditional PATCH that writes the
 * tombstone, so a stale device cannot tombstone a batch that another device
 * approved or invoiced in the meantime.
 */
const buildBatchDeletePrecondition = () => ({
  filters: { 'data->>status': `not.in.(${LOCKED_BATCH_STATUSES.join(',')})` },
});

const isExaminationInvoice = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  const module = normalizeStatus(payload.originModule || payload.origin_module);
  return module === 'examination';
};

const readInvoiceBatchId = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.originBatchId || payload.origin_batch_id || payload.batchId || payload.batch_id;
  const value = String(raw == null ? '' : raw).trim();
  return value || null;
};

const readInvoiceNumber = (payload) => {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.id || payload.invoiceNumber || payload.invoice_number;
  const value = String(raw == null ? '' : raw).trim();
  return /^EXM-/i.test(value) ? value.toUpperCase() : null;
};

const isInvoiceTombstone = (payload) => {
  if (!payload || typeof payload !== 'object') return false;
  return payload.deleted === true || Boolean(payload.deletedAt);
};

const CONFLICT_REASONS = {
  BATCH_STATUS_PRECONDITION_FAILED: 'BATCH_STATUS_PRECONDITION_FAILED',
  BATCH_TOMBSTONE_FORBIDDEN: 'BATCH_TOMBSTONE_FORBIDDEN',
  INVOICE_BATCH_LINK_MISSING: 'INVOICE_BATCH_LINK_MISSING',
  INVOICE_IDENTITY_MISSING: 'INVOICE_IDENTITY_MISSING',
};

/**
 * Shape-level validation for an invoice op. Returns an error string or null.
 * Enforces the examination identity contract before the write is attempted so a
 * malformed record never reaches the ledger-backed envelope.
 *
 * Scope note: only an invoice that actually claims the batch-invoice contract is
 * validated — one carrying an EXM number OR a batch link. Examination invoices
 * raised from JOBS (examinationJobService.createInvoiceFromJobs) use a plain
 * sales number and carry no batch link; they are out of this contract and are
 * deliberately left untouched rather than being blocked by it.
 */
const validateInvoicePayloadShape = (op) => {
  const payload = op && op.payload;
  if (!payload || typeof payload !== 'object') return 'invoice payload must be an object';
  if (isInvoiceTombstone(payload)) return null;
  if (!isExaminationInvoice(payload)) return null;

  const invoiceNumber = readInvoiceNumber(payload);
  const batchRef = readInvoiceBatchId(payload);

  // Neither marker present -> not a batch-issued examination invoice.
  if (!invoiceNumber && !batchRef) return null;

  if (!invoiceNumber) {
    return `${CONFLICT_REASONS.INVOICE_IDENTITY_MISSING}: an examination invoice requires an EXM- invoice number`;
  }
  if (!batchRef) {
    return `${CONFLICT_REASONS.INVOICE_BATCH_LINK_MISSING}: an examination invoice requires a batch reference`;
  }
  return null;
};

/**
 * Posting-boundary rejection.
 *
 * Once the authoritative posting boundary is enabled, the server writes the
 * Examination invoice and its ledger entry directly. Any Examination invoice
 * arriving through the generic sync gateway at that point is a CLIENT trying to
 * commit a financial record independently — which is exactly the bypass that let
 * two devices bill one batch twice — and must be refused.
 *
 * Gated by the caller on the same feature flag that enables posting, so this is
 * inert until the server-side boundary is live and tested. Non-Examination
 * invoices and tombstones are untouched.
 */
const validateInvoicePostingBoundary = (op, options = {}) => {
  if (!options.postingEnabled) return null;
  const payload = op && op.payload;
  if (!payload || typeof payload !== 'object') return null;
  if (op && op.operation === 'delete') return null;
  if (isInvoiceTombstone(payload)) return null;
  if (!isExaminationInvoice(payload)) return null;

  // Only the BATCH invoice contract is owned by the server. Examination
  // invoices raised from JOBS (examinationJobService.createInvoiceFromJobs)
  // carry a plain sales number and no batch link; they still post through the
  // generic path and must not be blocked here.
  const invoiceNumber = readInvoiceNumber(payload);
  const batchRef = readInvoiceBatchId(payload);
  if (!invoiceNumber && !batchRef) return null;

  // A row the server itself stamped is legitimate if it ever does flow back
  // through the gateway (adoption/reconciliation), so it is not a bypass.
  if (String(payload.postedBy || '').trim().toLowerCase() === 'server') return null;

  return 'EXAM_POSTING_BOUNDARY: Examination batch invoices must be committed through '
    + 'POST /api/examination/batches/:id/post, not the generic sync gateway';
};

module.exports = {
  EXAMINATION_BATCH_TABLE,
  INVOICE_TABLE,
  LOCKED_BATCH_STATUSES,
  ALLOWED_PREDECESSOR_STATUSES,
  CONFLICT_REASONS,
  normalizeStatus,
  isLockedStatus,
  buildBatchUpsertPrecondition,
  buildBatchDeletePrecondition,
  isExaminationInvoice,
  isInvoiceTombstone,
  readInvoiceBatchId,
  readInvoiceNumber,
  validateInvoicePayloadShape,
  validateInvoicePostingBoundary,
};
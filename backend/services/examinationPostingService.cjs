/**
 * examinationPostingService.cjs — server-authoritative Examination financial
 * posting.
 *
 * This is the ONLY supported way to commit an Examination invoice or to void
 * one. It delegates the entire decision to the PostgreSQL functions installed
 * by 0051_examination_posting_and_void.sql, which lock the batch and invoice
 * rows FOR UPDATE and perform every write in one transaction. Nothing here
 * decides financial policy — the database does.
 *
 * What the client may no longer do independently:
 *   - commit its own Examination ledger entry
 *   - decide that a batch is still un-invoiced
 *   - retry a posting by minting a new invoice identity
 *
 * Idempotency: every call carries a caller-supplied stable key. A repeat with
 * the same key returns the FIRST committed result rather than posting again,
 * which is what makes a client timeout safe to retry.
 */

const axios = require('axios');

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

/**
 * Off by default. Turning this on makes the server the financial boundary, so
 * it must not be enabled until the integration suite has run against real
 * PostgreSQL and the client has been switched over in the same release.
 */
const POSTING_ENABLED_ENV = 'EXAMINATION_AUTHORITATIVE_POSTING';

const isPostingEnabled = () => String(process.env[POSTING_ENABLED_ENV] || '').trim().toLowerCase() === 'true';

const isConfigured = () => Boolean(
  SUPABASE_URL && SECRET_KEY
  && !SUPABASE_URL.includes('placeholder')
  && !SECRET_KEY.includes('placeholder')
);

const rpcHttp = typeof axios.create === 'function'
  ? axios.create({ validateStatus: (status) => status >= 200 && status < 300 })
  : axios;

class ExaminationPostingError extends Error {
  constructor(message, { code, retryable = false, httpStatus = 409 } = {}) {
    super(message);
    this.name = 'ExaminationPostingError';
    this.code = code || 'EXAM_POSTING_FAILED';
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

/** Extract the EXAM_* code the plpgsql function raised, or a transport code. */
const classifyRpcFailure = (err) => {
  const status = err?.response?.status;
  const body = err?.response?.data;
  const raw = (typeof body === 'string' ? body : JSON.stringify(body || '')) || err?.message || '';
  const message = String(raw);

  const codeMatch = message.match(/\b(EXAM_[A-Z_]+|CLOSED_PERIOD:[A-Z_]*)\b/);
  const code = codeMatch ? codeMatch[1] : (status ? `HTTP_${status}` : 'TRANSPORT');

  // 40001 serialization_failure and transport faults are genuinely retryable.
  // Every EXAM_POST_* / EXAM_VOID_* business failure is terminal: retrying the
  // same request can never make it legal, so it must surface, not loop.
  const retryable = !code.startsWith('EXAM_')
    && (status === 409 || status === 429 || (status >= 500) || !status);

  return new ExaminationPostingError(
    message.replace(/^.*?(EXAM_[A-Z_]+)/s, '$1').slice(0, 500) || 'Examination posting failed',
    { code, retryable, httpStatus: status === 404 ? 503 : (status || 503) }
  );
};

const callRpc = async (fn, params) => {
  if (!isConfigured()) {
    throw new ExaminationPostingError(
      'Examination posting is not configured (SUPABASE_URL / SUPABASE_SECRET_KEY missing)',
      { code: 'EXAM_POSTING_NOT_CONFIGURED', retryable: true, httpStatus: 503 }
    );
  }
  try {
    const res = await rpcHttp.post(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, params, {
      headers: {
        apikey: SECRET_KEY,
        Authorization: `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
    const data = res && res.data;
    if (!data || typeof data !== 'object') {
      throw new ExaminationPostingError(
        `Examination posting RPC ${fn} returned no committed result`,
        { code: 'EXAM_POSTING_EMPTY_RESULT', retryable: true, httpStatus: 503 }
      );
    }
    return data;
  } catch (err) {
    if (err instanceof ExaminationPostingError) throw err;
    throw classifyRpcFailure(err);
  }
};

const assertEnabled = () => {
  if (!isPostingEnabled()) {
    throw new ExaminationPostingError(
      'Authoritative Examination posting is not enabled on this server',
      { code: 'EXAM_POSTING_DISABLED', retryable: false, httpStatus: 503 }
    );
  }
};

/**
 * Commit exactly one canonical Examination invoice for a batch.
 *
 * p_expectedVersion is optional but should always be sent: it is what stops a
 * device that never saw the approval from posting against a batch that has since
 * moved on.
 */
const postExaminationInvoice = async ({
  batchId,
  invoiceNumber,
  idempotencyKey,
  expectedVersion = null,
  invoiceData,
  ledgerData,
  businessDate = null,
}) => {
  assertEnabled();

  if (!batchId || !invoiceNumber || !idempotencyKey) {
    throw new ExaminationPostingError('batchId, invoiceNumber and idempotencyKey are all required', {
      code: 'EXAM_POST_INVALID', retryable: false, httpStatus: 400,
    });
  }
  if (!/^EXM-/i.test(invoiceNumber)) {
    throw new ExaminationPostingError('An Examination invoice requires an EXM- invoice number', {
      code: 'EXAM_POST_INVALID', retryable: false, httpStatus: 400,
    });
  }

  const result = await callRpc('post_examination_invoice_atomic', {
    p_batch_id: batchId,
    p_invoice_number: invoiceNumber,
    p_idempotency_key: idempotencyKey,
    p_expected_version: Number.isFinite(Number(expectedVersion)) ? Number(expectedVersion) : null,
    p_invoice_data: invoiceData,
    p_ledger_data: ledgerData,
    p_business_date: businessDate || null,
  });

  return {
    invoiceNumber: String(result.invoiceNumber || invoiceNumber),
    invoiceId: String(result.invoiceId || result.invoiceNumber || invoiceNumber),
    totalAmount: Number(result.totalAmount || 0),
    status: String(result.status || 'committed'),
    batchVersion: Number.isFinite(Number(result.batchVersion)) ? Number(result.batchVersion) : null,
    replayed: result.replayed === true,
  };
};

/**
 * Void one Examination invoice, reversing its ledger entries and any recorded
 * inventory movements. The batch stays closed; see the migration header for the
 * reissue policy.
 *
 * p_deductionIds is explicit on purpose: the reversal credits only movements
 * the caller can name, never a guess.
 */
const voidExaminationInvoice = async ({
  batchId = null,
  invoiceNumber,
  idempotencyKey,
  voidReason = 'Voided',
  performedBy = 'system',
  deductionIds = null,
  businessDate = null,
}) => {
  assertEnabled();

  if (!invoiceNumber || !idempotencyKey) {
    throw new ExaminationPostingError('invoiceNumber and idempotencyKey are both required', {
      code: 'EXAM_VOID_INVALID', retryable: false, httpStatus: 400,
    });
  }
  if (!/^EXM-/i.test(invoiceNumber)) {
    throw new ExaminationPostingError('Only an EXM- Examination invoice can be voided here', {
      code: 'EXAM_VOID_INVALID', retryable: false, httpStatus: 400,
    });
  }

  const result = await callRpc('void_examination_invoice_atomic', {
    p_batch_id: batchId || null,
    p_invoice_number: invoiceNumber,
    p_idempotency_key: idempotencyKey,
    p_void_reason: voidReason,
    p_performed_by: performedBy,
    p_deduction_ids: Array.isArray(deductionIds) && deductionIds.length ? deductionIds : null,
    p_business_date: businessDate || null,
  });

  return {
    invoiceNumber: String(result.invoiceNumber || invoiceNumber),
    status: String(result.status || 'voided'),
    ledgerEntriesReversed: Number(result.ledgerEntriesReversed || 0),
    inventoryMovementsReversed: Number(result.inventoryMovementsReversed || 0),
    skipped: Number(result.skipped || 0),
    batchClosed: result.batchClosed !== false,
    replayed: result.replayed === true,
  };
};

module.exports = {
  POSTING_ENABLED_ENV,
  ExaminationPostingError,
  isPostingEnabled,
  isConfigured,
  postExaminationInvoice,
  voidExaminationInvoice,
};
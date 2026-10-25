import { API_BASE_URL } from '../config/api.js';
import { getJsonRequestHeaders } from './requestHeaders';
import { dbService } from './db';
import { isSessionExpired, getStoredUserSession } from './authSession';
import { traceExamInvoice } from '../utils/examinationInvoiceDiag';

/**
 * examinationPostingClient.ts — browser client for the authoritative
 * Examination posting boundary (migration 0051).
 *
 * Why this module exists
 * ----------------------
 * The canonical posting path used to be entirely client-side: the browser
 * derived the amounts and wrote both the invoice and its AR/revenue ledger entry
 * into IndexedDB, which later mirrored to the cloud through the generic sync
 * gateway. Two devices offline could both post AR against one batch, because
 * the only guard lived in one device's IndexedDB. The server now owns the
 * decision; this module is how the browser asks.
 *
 * What the client must NOT do any more
 * ------------------------------------
 *   - post its own Examination ledger entry
 *   - decide on its own that a batch is still un-invoiced
 *   - re-mint an invoice identity to escape a failure
 *
 * Durable idempotency
 * -------------------
 * The idempotency key is DERIVED, not generated: `EXAM-POST:<batchId>:<invoiceNumber>`.
 * That is deliberate. A generated key survives only as long as the in-memory
 * caller, so a refresh, a crash or a second retry after a timeout would mint a
 * new one and post twice. A derived key is a pure function of the intent, so
 * every attempt at the same posting — from any device, in any session, after any
 * interruption — collapses onto one server-side operation. The record is
 * persisted BEFORE the request and reconciled AFTER it, so an uncertain response
 * resolves by asking again with the same key rather than by posting again.
 *
 * Offline behaviour
 * -----------------
 * A posting request cannot be committed while disconnected — the identity claim
 * already fails closed offline, so no new invoice can even be numbered. This
 * module therefore never fabricates a committed invoice offline: it leaves the
 * durable request PENDING and reports `pending`, and the invoice is only ever
 * written to IndexedDB from the server's committed result.
 */

const POST_ENDPOINT = (batchId: string) => `${API_BASE_URL}/examination/batches/${encodeURIComponent(batchId)}/post`;
const VOID_ENDPOINT = (batchId: string) => `${API_BASE_URL}/examination/batches/${encodeURIComponent(batchId)}/void`;

const POSTING_STORE = 'examinationPostingRequests';
const CAPABILITY_ENDPOINT = `${API_BASE_URL}/examination/posting/capability`;
const CAPABILITY_PROBE_TIMEOUT_MS = 5000;

export type PostingRequestState = 'PENDING' | 'COMMITTED' | 'FAILED';

export interface ExaminationPostingRequest {
  id: string;
  batchId: string;
  invoiceNumber: string;
  invoiceData: Record<string, unknown>;
  ledgerData: Record<string, unknown>;
  expectedVersion: number | null;
  state: PostingRequestState;
  result: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type PostingOutcome =
  | { status: 'committed'; replayed: boolean; result: Record<string, unknown>; request: ExaminationPostingRequest }
  | { status: 'pending'; reason: string; request: ExaminationPostingRequest }
  | { status: 'rejected'; code: string; message: string; retryable: boolean; request: ExaminationPostingRequest };

/** Deterministic and stable across refreshes, retries and devices. */
export const buildPostingIdempotencyKey = (batchId: string, invoiceNumber: string): string =>
  `EXAM-POST:${String(batchId || '')}:${String(invoiceNumber || '')}`;

const buildVoidIdempotencyKey = (batchId: string, invoiceNumber: string): string =>
  `EXAM-VOID:${String(batchId || '')}:${String(invoiceNumber || '')}`;

const now = () => new Date().toISOString();

/**
 * Whether the server is running the authoritative boundary.
 *
 * This is a SERVER capability, not a local preference: it is probed once per
 * session from `GET /examination/posting/capability`. The old implementation
 * read a settings key that nothing ever wrote, so the boundary was permanently
 * unreachable in production and every invoice silently used the legacy path.
 *
 * Probe result semantics:
 *   enabled      server explicitly says the boundary is on
 *   disabled     server explicitly says off, or does not expose the endpoint
 *                (an older build); the legacy path is the only option there
 *   unavailable  the probe could not be completed (offline/timeout/5xx)
 *
 * `unavailable` deliberately maps to AUTHORITATIVE, not legacy. Falling back to
 * the legacy path on a failed probe would let a blocked probe re-open the
 * independent client-side posting path — the exact bypass this boundary exists
 * to close. With the server flag on, a misrouted legacy write is rejected by
 * the sync gateway anyway; failing closed keeps the guarantee local too.
 */
type PostingCapability = 'unknown' | 'enabled' | 'disabled' | 'unavailable';

let capabilityCache: PostingCapability = 'unknown';
let capabilityProbe: Promise<PostingCapability> | null = null;

export const resetPostingCapabilityCache = () => {
  capabilityCache = 'unknown';
  capabilityProbe = null;
};

const probePostingCapability = async (): Promise<PostingCapability> => {
  if (typeof fetch === 'undefined') return 'unavailable';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPABILITY_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(CAPABILITY_ENDPOINT, {
      method: 'GET',
      headers: getJsonRequestHeaders(),
      cache: 'no-store',
      signal: controller.signal,
    });

    // An older backend that predates the capability endpoint has no
    // authoritative boundary to use.
    if (res.status === 404 || res.status === 405) return 'disabled';
    if (!res.ok) return 'unavailable';

    const body = await res.json().catch(() => null) as { enabled?: unknown } | null;
    if (body?.enabled === true) return 'enabled';
    if (body?.enabled === false) return 'disabled';

    // A 200 without the boolean is not an assertion that posting is on.
    return 'disabled';
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timer);
  }
};

export const isAuthoritativePostingAvailable = async (): Promise<boolean> => {
  if (capabilityCache === 'unknown') {
    if (!capabilityProbe) {
      capabilityProbe = probePostingCapability().then((value) => {
        capabilityCache = value;
        capabilityProbe = null;
        return value;
      });
    }
    await capabilityProbe;
  }
  return capabilityCache === 'enabled' || capabilityCache === 'unavailable';
};

class PostingTransportError extends Error {
  retryable: boolean;
  code: string;
  constructor(message: string, code: string, retryable: boolean) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

const assertUsable = () => {
  if (typeof fetch === 'undefined') {
    throw new PostingTransportError('Network is unavailable', 'unavailable', true);
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new PostingTransportError('You are offline', 'offline', true);
  }
  const storedUser = getStoredUserSession();
  if (storedUser && isSessionExpired(storedUser)) {
    throw new PostingTransportError('Your session has expired', 'unauthenticated', false);
  }
};

const postJson = async (
  url: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
  timeoutMs = 30000
): Promise<Record<string, unknown>> => {
  const headers: Record<string, string> = getJsonRequestHeaders();
  const { getSyncAccessToken } = await import('./syncApiClient');
  const token = await getSyncAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  headers['X-Idempotency-Key'] = idempotencyKey;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await res.json().catch(() => ({}));

    if (res.status === 401) {
      throw new PostingTransportError('Your session has expired', 'unauthenticated', false);
    }
    if (res.status === 403) {
      throw new PostingTransportError('Your role cannot post examination invoices', 'forbidden', false);
    }
    if (res.status === 503 && payload?.code === 'EXAM_POSTING_DISABLED') {
      capabilityCache = 'disabled';
      throw new PostingTransportError('Authoritative posting is disabled on the server', 'disabled', true);
    }
    if (!res.ok) {
      const code = String(payload?.code || `HTTP_${res.status}`);
      const message = String(payload?.error || `The server rejected the posting (${res.status}).`);
      // A business rejection can never become legal on retry, so it must
      // surface; only transport/5xx faults are worth repeating.
      const retryable = payload?.retryable === true;
      throw new PostingTransportError(message, code, retryable);
    }

    capabilityCache = 'enabled';
    return payload as Record<string, unknown>;
  } catch (err) {
    if (err instanceof PostingTransportError) throw err;
    // Abort, socket hang-up, DNS — all "we do not know if it committed".
    throw new PostingTransportError(
      String((err as Error)?.message || 'The posting request could not be completed'),
      'transport',
      true
    );
  } finally {
    clearTimeout(timer);
  }
};

const loadRequest = async (id: string): Promise<ExaminationPostingRequest | null> => {
  try {
    const row = await dbService.get<ExaminationPostingRequest>(POSTING_STORE, id);
    return row ? { ...row } : null;
  } catch {
    return null;
  }
};

const saveRequest = async (request: ExaminationPostingRequest): Promise<ExaminationPostingRequest> => {
  const next = { ...request, updatedAt: now() };
  await dbService.put(POSTING_STORE, next);
  return next;
};

/**
 * Submit an Examination invoice for authoritative posting.
 *
 * The returned `status` is the whole contract:
 *   committed — the server confirmed; `result` is canonical
 *   pending   — the outcome is UNKNOWN (timeout / offline). Safe to call again
 *               with the same arguments; it will not post twice.
 *   rejected  — terminal; the operator must act, retrying cannot help.
 */
export async function submitExaminationInvoicePosting(args: {
  batchId: string;
  invoice: Record<string, unknown>;
  ledgerEntry: Record<string, unknown>;
  expectedVersion?: number | null;
  timeoutMs?: number;
}): Promise<PostingOutcome> {
  const batchId = String(args?.batchId || '').trim();
  const invoiceNumber = String((args?.invoice?.invoiceNumber || args?.invoice?.id) || '').trim();
  if (!batchId || !invoiceNumber) {
    throw new PostingTransportError('A batch id and invoice number are required to post', 'invalid', false);
  }

  const idempotencyKey = buildPostingIdempotencyKey(batchId, invoiceNumber);

  // Persist intent BEFORE the request. If this device dies mid-flight the next
  // attempt finds this row and reuses the same key rather than re-minting.
  const existing = await loadRequest(idempotencyKey);
  let request: ExaminationPostingRequest = existing || {
    id: idempotencyKey,
    batchId,
    invoiceNumber,
    invoiceData: args.invoice as Record<string, unknown>,
    ledgerData: args.ledgerEntry as Record<string, unknown>,
    expectedVersion:
      args.expectedVersion === null || args.expectedVersion === undefined
        ? null
        : Number(args.expectedVersion),
    state: 'PENDING',
    result: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    attempts: 0,
    createdAt: now(),
    updatedAt: now(),
  };

  // Already confirmed: never ask again, and never re-post.
  if (request.state === 'COMMITTED' && request.result) {
    return { status: 'committed', replayed: true, result: request.result, request };
  }

  request = await saveRequest({ ...request, attempts: (request.attempts || 0) + 1, state: 'PENDING', errorCode: null, errorMessage: null });

  try {
    assertUsable();
    const result = await postJson(
      POST_ENDPOINT(batchId),
      {
        invoiceNumber,
        expectedVersion: request.expectedVersion,
        invoiceData: request.invoiceData,
        ledgerData: request.ledgerData,
      },
      idempotencyKey,
      args.timeoutMs
    );

    const committed = await saveRequest({
      ...request,
      state: 'COMMITTED',
      result,
      retryable: false,
      errorCode: null,
      errorMessage: null,
    });

    await traceExamInvoice('authoritative-post', { id: invoiceNumber, invoiceNumber }, {
      batchId, committed: true, replayed: result?.replayed === true,
    });

    return { status: 'committed', replayed: result?.replayed === true, result, request: committed };
  } catch (err) {
    const transportError = err as PostingTransportError;

    if (transportError.code === 'disabled') {
      // The boundary is not live. Surface it as pending rather than silently
      // falling back, so nothing is ever presented as committed that is not.
      const pending = await saveRequest({ ...request, state: 'PENDING', errorCode: 'disabled', errorMessage: transportError.message, retryable: true });
      return { status: 'pending', reason: transportError.message, request: pending };
    }

    if (transportError.retryable) {
      const pending = await saveRequest({
        ...request,
        state: 'PENDING',
        errorCode: transportError.code,
        errorMessage: transportError.message,
        retryable: true,
      });
      await traceExamInvoice('authoritative-post-pending', { id: invoiceNumber, invoiceNumber }, {
        batchId, committed: false, reason: transportError.code,
      });
      return { status: 'pending', reason: transportError.message, request: pending };
    }

    const rejected = await saveRequest({
      ...request,
      state: 'FAILED',
      errorCode: transportError.code,
      errorMessage: transportError.message,
      retryable: false,
    });
    await traceExamInvoice('authoritative-post-rejected', { id: invoiceNumber, invoiceNumber }, {
      batchId, committed: false, code: transportError.code,
    });
    return {
      status: 'rejected',
      code: transportError.code,
      message: transportError.message,
      retryable: false,
      request: rejected,
    };
  }
}

/**
 * Resolve an outstanding posting request — used on reconnect and after a
 * refresh, when a previous attempt left the outcome unknown. Asking again with
 * the SAME derived key is what turns "we do not know" into either a committed
 * result or a definite rejection, without risking a second posting.
 */
export async function resolveExaminationPostingRequest(
  batchId: string,
  invoiceNumber: string
): Promise<PostingOutcome | null> {
  const id = buildPostingIdempotencyKey(batchId, invoiceNumber);
  const existing = await loadRequest(id);
  if (!existing || existing.state === 'COMMITTED') return null;
  return submitExaminationInvoicePosting({
    batchId,
    invoice: existing.invoiceData,
    ledgerEntry: existing.ledgerData,
    expectedVersion: existing.expectedVersion,
  });
}

export async function listPendingExaminationPostings(): Promise<ExaminationPostingRequest[]> {
  try {
    const rows = await dbService.getAll<ExaminationPostingRequest>(POSTING_STORE);
    return (Array.isArray(rows) ? rows : []).filter((row) => row?.state === 'PENDING');
  } catch {
    return [];
  }
}

export async function submitExaminationInvoiceVoid(args: {
  batchId: string;
  invoiceNumber: string;
  reason: string;
  deductionIds?: string[] | null;
  timeoutMs?: number;
}): Promise<PostingOutcome> {
  const batchId = String(args?.batchId || '').trim();
  const invoiceNumber = String(args?.invoiceNumber || '').trim();
  if (!invoiceNumber) {
    throw new PostingTransportError('An invoice number is required to void', 'invalid', false);
  }
  const idempotencyKey = buildVoidIdempotencyKey(batchId, invoiceNumber);

  const existing = await loadRequest(idempotencyKey);
  const request: ExaminationPostingRequest = existing || {
    id: idempotencyKey,
    batchId,
    invoiceNumber,
    invoiceData: {},
    ledgerData: {},
    expectedVersion: null,
    state: 'PENDING',
    result: null,
    errorCode: null,
    errorMessage: null,
    retryable: true,
    attempts: 0,
    createdAt: now(),
    updatedAt: now(),
  };

  if (request.state === 'COMMITTED' && request.result) {
    return { status: 'committed', replayed: true, result: request.result, request };
  }

  const armed = await saveRequest({ ...request, attempts: (request.attempts || 0) + 1, state: 'PENDING' });

  try {
    assertUsable();
    const result = await postJson(
      VOID_ENDPOINT(batchId),
      { invoiceNumber, reason: args.reason, deductionIds: args.deductionIds || null },
      idempotencyKey,
      args.timeoutMs
    );
    const committed = await saveRequest({ ...armed, state: 'COMMITTED', result, retryable: false });
    return { status: 'committed', replayed: result?.replayed === true, result, request: committed };
  } catch (err) {
    const transportError = err as PostingTransportError;
    if (transportError.retryable) {
      const pending = await saveRequest({ ...armed, state: 'PENDING', errorCode: transportError.code, errorMessage: transportError.message, retryable: true });
      return { status: 'pending', reason: transportError.message, request: pending };
    }
    const rejected = await saveRequest({ ...armed, state: 'FAILED', errorCode: transportError.code, errorMessage: transportError.message, retryable: false });
    return { status: 'rejected', code: transportError.code, message: transportError.message, retryable: false, request: rejected };
  }
}

/**
 * Build the Examination ledger entry the server is asked to commit.
 *
 * This reproduces EXACTLY the pair transactionService.processInvoice already
 * posts (DR accounts receivable / CR service income, referenceId = invoice id)
 * using the SAME account-resolution helpers, so the accounting model is
 * unchanged. Examination lines are all type 'Service', which the existing
 * revenue resolution maps to service income, and no COGS is posted because
 * Service lines are non-inventory-bearing.
 *
 * The entry is only ever a REQUEST. The server writes the authoritative row;
 * the client must not put this into the `ledger` store itself, because a local
 * ledger write is exactly the independent posting this boundary removes.
 */
export async function buildExaminationLedgerEntry(invoice: Record<string, unknown>): Promise<Record<string, unknown>> {
  const [{ getGLConfig, loadAccountsFromStore, resolveAccountForPosting, getCompanyConfig }, { resolveInvoiceRevenueAccount }] =
    await Promise.all([
      import('./transactions/_internal'),
      import('../utils/revenueRecognition'),
    ]);

  const gl = getGLConfig();
  const companyConfig = getCompanyConfig();
  const accounts = await loadAccountsFromStore();
  const companyId = (companyConfig as any)?.companyId;
  const accountOptions = { allowNonPosting: false, companyId };

  const resolve = (ref: string | undefined): string => {
    const resolved = ref ? resolveAccountForPosting(ref, accounts, accountOptions) : null;
    if (!resolved) {
      // Fail closed: an unresolved account must never be posted as a guess.
      throw new PostingTransportError(
        `Examination posting halted: account "${ref || 'undefined'}" could not be resolved`,
        'account_unresolved',
        false
      );
    }
    return resolved;
  };

  const revenueAccountRef = resolveInvoiceRevenueAccount(invoice as any, gl.defaultSalesAccount);
  const totalAmount = Number(invoice?.totalAmount ?? invoice?.total ?? 0) || 0;
  const invoiceNumber = String(invoice?.invoiceNumber || invoice?.id || '');

  return {
    // Deterministic so a client-side retry and the server agree on one row.
    id: `LG-INV-${invoiceNumber}`,
    date: new Date().toISOString(),
    description: `Invoice #${invoiceNumber}`,
    debitAccountId: resolve(gl.accountsReceivable),
    creditAccountId: resolve(revenueAccountRef),
    amount: totalAmount,
    referenceId: invoiceNumber,
    reconciled: false,
    customerId: invoice?.customerId ?? null,
    customerName: invoice?.customerName ?? null,
  };
}

export const examinationPostingClient = {
  buildPostingIdempotencyKey,
  buildVoidIdempotencyKey,
  buildExaminationLedgerEntry,
  isAuthoritativePostingAvailable,
  resetPostingCapabilityCache,
  submitExaminationInvoicePosting,
  submitExaminationInvoiceVoid,
  resolveExaminationPostingRequest,
  listPendingExaminationPostings,
};
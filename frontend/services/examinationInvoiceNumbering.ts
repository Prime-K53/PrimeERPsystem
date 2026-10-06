import { API_BASE_URL } from '../config/api.js';
import { getJsonRequestHeaders } from './requestHeaders';
import { logger } from './logger';
import { isSessionExpired, getStoredUserSession } from './authSession';

/**
 * examinationInvoiceNumbering.ts — browser-side client for the authoritative
 * Examination Invoice identity claim (`POST /api/sync/numbers/examination-invoice`).
 *
 * WHY A PRE-SAVE CLAIM (and not the Sales Order "mint after local save" flow):
 *   For a Sales Order the stable primary key is a ULID and the official number
 *   is a separate display field, so the gateway can stamp it after the local
 *   save and the client adopts it. An Examination Invoice is structurally
 *   different: `Invoice.id` IS the official number AND is the ledger
 *   `referenceId` (`transactionService.processInvoice` posts
 *   `referenceId: invoice.id`). Once AR is posted the identity can never be
 *   rewritten without corrupting the ledger. The identity must therefore be
 *   authoritative BEFORE the invoice — and therefore before the AR posting —
 *   exists. This client is that pre-save claim.
 *
 * Same architecture as the ORD flow (migration 0027): service-role RPC claim,
 * series resolved from the company numbering settings, history in `invoices`
 * and `ledger_entries` always beating the counter row.
 *
 * FAIL CLOSED, ALWAYS. There is deliberately no local-minting fallback here:
 *   A device-local namespace scan is exactly what let two batches both become
 *   `EXM-P726/022` and post AR onto one shared `referenceId`. If the cloud
 *   cannot hand out an authoritative identity, a NEW examination invoice must
 *   not be created at all — the caller surfaces the failure and the operator
 *   retries when connectivity returns.
 *
 *   Same-batch EDITS are unaffected and never call this module: an edit keeps
 *   its existing identity and posts a ledger correction instead.
 */

const CLAIM_ENDPOINT = `${API_BASE_URL}/sync/numbers/examination-invoice`;

export type ExaminationIdentityClaimFailure =
  | 'offline'
  | 'unauthenticated'
  | 'forbidden'
  | 'unavailable'
  | 'invalid-response';

/** Raised when no authoritative identity could be claimed. Never recoverable by local minting. */
export class ExaminationIdentityClaimError extends Error {
  readonly reason: ExaminationIdentityClaimFailure;
  readonly serverReason: string | null;

  constructor(message: string, reason: ExaminationIdentityClaimFailure, serverReason: string | null = null) {
    super(message);
    this.name = 'ExaminationIdentityClaimError';
    this.reason = reason;
    this.serverReason = serverReason;
  }
}

export interface ExaminationIdentityClaimResult {
  /** The authoritative EXM identity — e.g. `EXM-P726/023`. */
  invoiceNumber: string;
  series: string | null;
}

const EXAM_PREFIX = /^EXM-/i;

/**
 * Guard the response: only a well-formed EXM identity is ever accepted, so a
 * malformed or proxied value can never become an accounting identity.
 */
const assertExaminationIdentity = (value: unknown): string => {
  const text = String(value ?? '').trim();
  if (!text || !EXAM_PREFIX.test(text)) {
    throw new ExaminationIdentityClaimError(
      'The server did not return a valid examination invoice identity',
      'invalid-response',
    );
  }
  return text;
};

async function getSyncAccessToken(): Promise<string | null> {
  try {
    const raw = sessionStorage.getItem('nexus_user');
    if (raw) {
      const session = JSON.parse(raw);
      if (session?.accessToken) return session.accessToken;
    }
  } catch {
    // ignore and fall through to the supabase session
  }
  try {
    const { supabase } = await import('./supabaseClient');
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch {
    return null;
  }
}

/**
 * Claim ONE authoritative Examination Invoice identity from the cloud.
 *
 * Throws `ExaminationIdentityClaimError` on every failure path. Callers must
 * treat a throw as "do not create a new examination invoice" — never as a
 * reason to mint locally.
 */
export async function claimExaminationInvoiceIdentity(
  options: { timeoutMs?: number; series?: string } = {}
): Promise<ExaminationIdentityClaimResult> {
  if (typeof fetch === 'undefined') {
    throw new ExaminationIdentityClaimError('fetch is not available in this environment', 'unavailable');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ExaminationIdentityClaimError(
      'You are offline. A new examination invoice identity can only be issued by the server.',
      'offline'
    );
  }

  const storedUser = getStoredUserSession();
  if (storedUser && isSessionExpired(storedUser)) {
    throw new ExaminationIdentityClaimError(
      'Your session has expired. Sign in again to issue a new examination invoice.',
      'unauthenticated'
    );
  }

  const headers: Record<string, string> = getJsonRequestHeaders();
  const token = await getSyncAccessToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20000);

  try {
    const res = await fetch(CLAIM_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(options.series ? { series: options.series } : {}),
      signal: controller.signal,
    });

    if (res.status === 401) {
      throw new ExaminationIdentityClaimError(
        'The server rejected the examination invoice identity claim (401).',
        'unauthenticated'
      );
    }
    if (res.status === 403) {
      throw new ExaminationIdentityClaimError(
        'Your role is not allowed to issue examination invoice identities.',
        'forbidden'
      );
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const serverReason = body?.reason ? String(body.reason) : null;
      throw new ExaminationIdentityClaimError(
        body?.message || body?.error || `The server could not issue an examination invoice identity (${res.status}).`,
        'unavailable',
        serverReason
      );
    }

    const payload = (await res.json()) as { invoiceNumber?: unknown; series?: unknown };
    const invoiceNumber = assertExaminationIdentity(payload?.invoiceNumber);
    logger.info('[ExaminationInvoiceNumbering] authoritative identity claimed', { series: payload?.series ?? null });
    return {
      invoiceNumber,
      series: typeof payload?.series === 'string' ? payload.series : null,
    };
  } catch (error) {
    if (error instanceof ExaminationIdentityClaimError) throw error;
    const aborted = (error as { name?: string })?.name === 'AbortError';
    throw new ExaminationIdentityClaimError(
      aborted
        ? 'The examination invoice identity request timed out. Nothing was created.'
        : 'Could not reach the server to issue an examination invoice identity. Nothing was created.',
      'unavailable'
    );
  } finally {
    clearTimeout(timeout);
  }
}
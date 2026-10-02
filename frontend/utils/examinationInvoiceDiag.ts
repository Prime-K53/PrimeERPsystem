/**
 * Temporary local-only diagnostic trace for ONE examination invoice
 * (EXM-P726/021) — investigation instrumentation only.
 *
 * READ-ONLY with respect to business data: this module only observes and
 * emits safe metadata via console.debug so the originating device's
 * create → persist → queue → sync lifecycle can be reconstructed from its
 * own logs. It never modifies, regenerates, replays, deletes, or moves any
 * record, token, or queue entry, and it never throws.
 *
 * Privacy: the verification token itself is NEVER emitted. Only presence,
 * length, and a one-way SHA-256 fingerprint are logged. Callers must pass
 * only scalar metadata in `extra` (no customer objects, amounts, or payloads).
 *
 * Scoping: every emitter checks `isExamDiagTarget()` first; all other
 * invoices cost one string comparison and produce zero output.
 */

export const EXAM_DIAG_INVOICE_NUMBER = 'EXM-P726/021';

export function isExamDiagTarget(...values: unknown[]): boolean {
  for (const value of values) {
    if (String(value ?? '').trim() === EXAM_DIAG_INVOICE_NUMBER) return true;
  }
  return false;
}

/**
 * One-way fingerprint (hex) of a token, preferring SHA-256. Returns null
 * for empty input, 'unavailable' when WebCrypto is missing. Never returns
 * the input. (Some non-browser runtimes answer a shorter digest; whatever
 * length is returned is still one-way, deterministic, and sufficient to
 * correlate supplied vs stored tokens without revealing either.)
 */
export async function examDiagTokenFingerprint(token: unknown): Promise<string | null> {
  try {
    const text = String(token ?? '').trim();
    if (!text) return null;
    const subtle = (globalThis as any)?.crypto?.subtle;
    if (!subtle?.digest) return 'unavailable';
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return 'unavailable';
  }
}

export interface ExamDiagSnapshot {
  id?: unknown;
  invoiceNumber?: unknown;
  recordId?: unknown;
  originModule?: unknown;
  /** Hashed before emission — the raw value never reaches the log. */
  verificationToken?: unknown;
}

export type ExamDiagExtra = Record<string, string | number | boolean | null | undefined>;

/**
 * Emit one diagnostic line when (and only when) the snapshot identifies
 * EXM-P726/021 via id, invoiceNumber, or recordId. Returns true when traced.
 * Never throws, never mutates its inputs.
 */
export async function traceExamInvoice(
  stage: string,
  record: ExamDiagSnapshot | null | undefined,
  extra?: ExamDiagExtra
): Promise<boolean> {
  try {
    if (!record || typeof record !== 'object') return false;
    const id = record.id !== undefined ? String(record.id ?? '') : undefined;
    const invoiceNumber =
      record.invoiceNumber !== undefined ? String(record.invoiceNumber ?? '') : undefined;
    const recordId = record.recordId !== undefined ? String(record.recordId ?? '') : undefined;
    if (!isExamDiagTarget(id, invoiceNumber, recordId)) return false;
    const tokenText = String(record.verificationToken ?? '');
    const tokenTrimmed = tokenText.trim();
    const fingerprint = tokenTrimmed ? await examDiagTokenFingerprint(tokenTrimmed) : null;
    console.debug(
      '[ExamInvoiceDiag]',
      JSON.stringify({
        target: EXAM_DIAG_INVOICE_NUMBER,
        stage: String(stage),
        at: new Date().toISOString(),
        ...(id !== undefined ? { id } : {}),
        ...(invoiceNumber !== undefined ? { invoiceNumber } : {}),
        ...(recordId !== undefined ? { recordId } : {}),
        ...(record.originModule !== undefined
          ? { originModule: String(record.originModule ?? '') }
          : {}),
        tokenPresent: tokenTrimmed.length > 0,
        tokenLength: tokenTrimmed.length,
        tokenFingerprint: fingerprint,
        ...(extra ?? {}),
      })
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Canonical invoice identity + resolution — single home for the rule.
 *
 * Canonical invariant (examination invoices):
 *   persisted Invoice.id === Invoice.invoiceNumber === batch.invoice_id
 *                                    === sync.invoiceId
 *
 * History: examination conversion used to mint an opaque
 * `local-exam-invoice-*` shadow id next to the real EXM number, and each
 * examination UI path picked a slightly different fallback key. A shadow id
 * is not a valid key in the canonical invoices namespace (local IndexedDB +
 * Supabase PK) and must never be persisted, synced, or navigated to.
 *
 * Opening a document must be deterministic: exact `id` first, exact
 * `invoiceNumber` second. Never fuzzy-match (customer name, notes,
 * reference, …) when deciding WHICH invoice opens. Slash-containing numbers
 * (EXM-P726/0001, INV-P726/023) resolve by plain string equality — no URL
 * splitting/decoding happens on this path.
 */

export const SHADOW_EXAMINATION_INVOICE_ID_PREFIX = 'local-exam-invoice-';

export const isShadowExaminationInvoiceId = (value: unknown): boolean =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .startsWith(SHADOW_EXAMINATION_INVOICE_ID_PREFIX);

const cleanNavigationKey = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // Shadow ids and throwaway numeric ids are never canonical keys.
  if (isShadowExaminationInvoiceId(text)) return null;
  if (/^\d+$/.test(text)) return null;
  return text;
};

export interface ExaminationInvoiceKeyInput {
  syncInvoiceId?: unknown;
  invoiceNumber?: unknown;
  id?: unknown;
}

/**
 * Canonical examination invoice navigation key.
 * Priority: persisted sync.invoiceId → canonical invoiceNumber → id.
 * Returns null when no canonical key is available (caller must NOT navigate
 * with a shadow/throwaway key — fall back to the plain list route).
 */
export function resolveExaminationInvoiceNavigationKey(
  input: ExaminationInvoiceKeyInput | null | undefined
): string | null {
  if (!input) return null;
  return (
    cleanNavigationKey(input.syncInvoiceId) ??
    cleanNavigationKey(input.invoiceNumber) ??
    cleanNavigationKey(input.id) ??
    null
  );
}

export interface ExaminationInvoiceViewState {
  action: 'view';
  type: 'Invoice';
  id: string;
  filterInvoiceId: string;
  source: 'examination';
}

export function buildExaminationInvoiceViewState(canonicalId: string): ExaminationInvoiceViewState {
  return {
    action: 'view',
    type: 'Invoice',
    id: canonicalId,
    filterInvoiceId: canonicalId,
    source: 'examination',
  };
}

export interface InvoiceIdentity {
  id?: unknown;
  invoiceNumber?: unknown;
}

/**
 * Deterministic invoice resolution for detail hydration and deep-links:
 * exact `id` first, exact `invoiceNumber` second. No fuzzy matching.
 */
export function findInvoiceByIdOrNumber<T extends InvoiceIdentity>(
  invoices: readonly T[] | null | undefined,
  key: unknown
): T | undefined {
  const text = String(key ?? '').trim();
  if (!text || !Array.isArray(invoices)) return undefined;
  const byId = (invoices as readonly T[]).find((invoice) => String(invoice?.id ?? '') === text);
  if (byId) return byId;
  return (invoices as readonly T[]).find(
    (invoice) => String(invoice?.invoiceNumber ?? '') === text
  );
}

export interface ExaminationBatchLinkage {
  /** Normalised batch keys identifying WHICH batch an examination invoice belongs to. */
  keys: string[];
}

const normalizeLinkKey = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!text) return null;
  // Batch-reference forms identify the batch, not the invoice — strip the
  // prefix so all spellings compare equally. Both prefixes occur in the
  // wild: idempotency keys use EXAM-BATCH-<batch>, older checks/docs use
  // EXM-BATCH-<batch>.
  const upper = text.toUpperCase();
  if (upper.startsWith('EXM-BATCH-')) return upper.slice('EXM-BATCH-'.length);
  if (upper.startsWith('EXAM-BATCH-')) return upper.slice('EXAM-BATCH-'.length);
  return upper;
};

/**
 * Batch linkage of an examination invoice: the set of batch identifiers it
 * claims (batchId / origin_batch_id / originBatchId / conversion source /
 * EXM-BATCH-* reference). Two examination invoices sharing one canonical id
 * are the SAME document if and only if their linkage sets intersect.
 * Case-insensitive; empty when the record carries no batch linkage.
 */
export function getExaminationBatchLinkage(record: Record<string, unknown> | null | undefined): string[] {
  if (!record || typeof record !== 'object') return [];
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const key = normalizeLinkKey(value);
    if (key) keys.add(key);
  };
  add((record as Record<string, unknown>).batchId);
  add((record as Record<string, unknown>).origin_batch_id);
  add((record as Record<string, unknown>).originBatchId);
  add((record as Record<string, unknown>).origin_batchId);
  add((record as Record<string, unknown>).reference);
  const conversion = (record as Record<string, unknown>).conversionDetails as
    | Record<string, unknown>
    | undefined;
  if (conversion && typeof conversion === 'object') {
    add(conversion.sourceNumber);
  }
  return Array.from(keys);
}

const isExaminationLike = (record: Record<string, unknown> | null | undefined): boolean => {
  if (!record || typeof record !== 'object') return false;
  const module = String(
    (record as Record<string, unknown>).originModule ??
      (record as Record<string, unknown>).origin_module ??
      ''
  ).toLowerCase();
  if (module === 'examination') return true;
  if (String((record as Record<string, unknown>).category ?? '').toLowerCase() === 'examination') return true;
  if (isShadowExaminationInvoiceId((record as Record<string, unknown>).id)) return true;
  const reference = String((record as Record<string, unknown>).reference ?? '').toUpperCase();
  if (reference.startsWith('EXM-BATCH-') || reference.startsWith('EXAM-BATCH-')) return true;
  return getExaminationBatchLinkage(record).length > 0;
};

/**
 * Owning batch for an examination invoice: the batch whose `invoice_id`
 * equals the stale invoice id AND whose own identity (id / batch_number /
 * batchNumber / name) intersects the invoice's batch linkage. Returns the
 * batch `id` or null. Never matches across batches — a batch that merely
 * references the winner's id without linkage intersection is left alone.
 */
export function findOwningExaminationBatchId(
  batches: ReadonlyArray<Record<string, unknown>> | null | undefined,
  linkKeys: ReadonlyArray<string> | null | undefined,
  invoiceId: unknown
): string | null {
  if (!Array.isArray(batches) || !Array.isArray(linkKeys)) return null;
  const wanted = String(invoiceId ?? '').trim().toUpperCase();
  if (!wanted) return null;
  const keySet = new Set(
    linkKeys.map((key) => String(key ?? '').trim().toUpperCase()).filter(Boolean)
  );
  if (keySet.size === 0) return null;
  const match = batches.find((batch) => {
    if (!batch || typeof batch !== 'object') return false;
    if (String(batch.invoice_id ?? '').trim().toUpperCase() !== wanted) return false;
    const batchKeys = [batch.id, batch.batch_number, batch.batchNumber, batch.name].map((value) =>
      String(value ?? '').trim().toUpperCase()
    );
    return batchKeys.some((key) => key && keySet.has(key));
  });
  const id = match ? String(match.id ?? '').trim() : '';
  return id || null;
}

/**
 * Distinct-document test for same-id collisions: returns true only when
 * BOTH records look like examination invoices AND both carry batch linkage
 * AND the linkages are disjoint — i.e. two DIFFERENT batches' invoices
 * sharing one canonical id. Same-linkage edits (payments, status changes),
 * non-examination rows, tombstones and linkage-less legacy rows all return
 * false so the normal merge path keeps handling them exactly as today.
 */
export function isDistinctExaminationInvoiceCollision(
  localRecord: Record<string, unknown> | null | undefined,
  serverRecord: Record<string, unknown> | null | undefined
): boolean {
  if (!isExaminationLike(localRecord) || !isExaminationLike(serverRecord)) return false;
  if (
    (serverRecord as Record<string, unknown>).deleted === true ||
    (localRecord as Record<string, unknown>).deleted === true
  ) {
    return false;
  }
  const localKeys = new Set(getExaminationBatchLinkage(localRecord));
  const serverKeys = new Set(getExaminationBatchLinkage(serverRecord));
  // The shared invoice id/number itself is NEVER linkage evidence: both rows
  // can carry it (e.g. as `reference`), and counting it would make two
  // distinct invoices look like one document.
  for (const selfRef of [
    localRecord.id,
    localRecord.invoiceNumber,
    serverRecord.id,
    serverRecord.invoiceNumber,
  ]) {
    const key = String(selfRef ?? '').trim().toUpperCase();
    if (key) {
      localKeys.delete(key);
      serverKeys.delete(key);
    }
  }
  if (localKeys.size === 0 || serverKeys.size === 0) return false;
  for (const key of localKeys) {
    if (serverKeys.has(key)) return false;
  }
  return true;
}

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

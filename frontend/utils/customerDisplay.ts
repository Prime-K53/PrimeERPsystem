export interface CustomerDisplayInputs {
  businessName?: string | null;
  companyName?: string | null;
  contactName?: string | null;
  legacyCustomerName?: string | null;
}

/**
 * Values that LOOK like a customer name field but are not names: blank strings,
 * typographic placeholders and the internal customer key (`CUST-0035`).
 *
 * These must never be persisted as a customer/business name or printed on a
 * customer-facing document — a placeholder in the name field is a missing
 * reference, and the caller has to resolve the customer by id instead.
 */
const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  '-', '--', '---', '—', '–', '_', '__', '.', '..', 'n/a', 'na', 'none', 'null',
  'nil', 'undefined', 'customer', 'unknown', 'unknown customer', 'tbd',
]);

/** True when `value` cannot serve as a customer/business name. */
export const isPlaceholderCustomerName = (value?: string | null): boolean => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return true;
  if (PLACEHOLDER_CUSTOMER_NAMES.has(text.toLowerCase())) return true;
  // Only punctuation/symbols (e.g. "—", "-", "_"): no name characters at all.
  // Unicode-aware so non-Latin business names are never mistaken for noise.
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  // The internal customer key is a reference, never a name.
  if (/^CUST[-\s]?\d{3,}$/i.test(text)) return true;
  return false;
};

const firstUsableName = (...values: Array<string | null | undefined>): string => {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text && !isPlaceholderCustomerName(text)) return text;
  }
  return '';
};

/**
 * Authoritative CUSTOMER / BUSINESS display name resolver.
 *
 * Contract:
 *   1. businessName (preferred customer identity)
 *   2. companyName
 *   3. legacy customer name field (backward compat only when businessName missing)
 *
 * Placeholders (`_`, `-`, `—`, `n/a`, a bare `CUST-…` key, …) are NOT names:
 * each candidate is skipped so a real name behind them can still be found.
 *
 * contactName MUST NOT be used as the customer/business display name.
 */
export const getCustomerDisplayName = ({
  businessName,
  companyName,
  legacyCustomerName,
}: CustomerDisplayInputs): string =>
  firstUsableName(businessName, companyName, legacyCustomerName);

/**
 * Authoritative CONTACT PERSON resolver.
 *
 * This is intentionally separate from getCustomerDisplayName so the two concepts
 * cannot be accidentally mixed.
 */
export const getCustomerContactName = ({
  contactName,
}: CustomerDisplayInputs): string => {
  if (typeof contactName === 'string' && contactName.trim().length > 0) {
    return contactName.trim();
  }
  return '';
};

export const resolveCustomerDisplay = (
  customer: { businessName?: string | null; companyName?: string | null; contactName?: string | null; name?: string | null } | null
): { displayName: string; contactName: string } => {
  if (!customer) {
    return { displayName: '', contactName: '' };
  }
  return {
    displayName: getCustomerDisplayName({
      businessName: customer.businessName ?? null,
      companyName: customer.companyName ?? null,
      legacyCustomerName: customer.name ?? null,
    }),
    contactName: getCustomerContactName({ contactName: customer.contactName ?? null }),
  };
};

/**
 * Label for customer <option> / search-dropdown rows.
 *
 * NON-NEGOTIABLE: always the Business Name, never the contact name.
 * Falls back to the customer id (never blank) when no business identity
 * exists, so dropdowns cannot render empty options.
 */
export const getCustomerOptionLabel = (
  customer: {
    id?: string | null;
    name?: string | null;
    businessName?: string | null;
    companyName?: string | null;
  } | null | undefined
): string => {
  if (!customer) return 'Unknown customer';
  return (
    getCustomerDisplayName({
      businessName: customer.businessName ?? null,
      companyName: customer.companyName ?? null,
      legacyCustomerName: customer.name ?? null,
    }) ||
    String(customer.id || '').trim() ||
    'Unknown customer'
  );
};

/**
 * Business name for a customer id — resolved strictly by the stable id, never
 * by a display string. Returns `''` when the customer is not in the provided
 * list or carries no usable business name, so callers can surface an
 * actionable error instead of writing a placeholder into a record.
 */
export const resolveCustomerNameById = (
  id?: string | null,
  customers?: Array<{ id?: string | null; name?: string | null; businessName?: string | null; companyName?: string | null } | null>,
): string => {
  const reference = String(id ?? '').trim();
  if (!reference) return '';
  const customer = (customers || []).find((c) => String(c?.id ?? '').trim() === reference);
  if (!customer) return '';
  return getCustomerDisplayName({
    businessName: customer.businessName ?? null,
    companyName: customer.companyName ?? null,
    legacyCustomerName: customer.name ?? null,
  });
};

/**
 * Shared customer display-name resolver used by printing contracts and
 * reconciliation views. Looks up a customer by id in the provided list and
 * returns the business/legacy name. The id is returned only as an actionable
 * last resort for internal screens — never as a name on a document.
 */
export const customerNameOf = (
  id?: string,
  customers?: Array<{ id?: string | null; name?: string | null; businessName?: string | null; companyName?: string | null } | null>,
): string => {
  const reference = String(id ?? '').trim();
  const displayName = resolveCustomerNameById(reference, customers);
  return displayName || reference || '—';
};

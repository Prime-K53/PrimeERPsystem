/**
 * customerDisplay.cjs — server-side mirror of the customer-identity display
 * rules in `frontend/utils/customerDisplay.ts` and the display-only document
 * resolvers in `frontend/services/printingContractService.ts`.
 *
 * A customer NAME field can hold a placeholder (`_`, `-`, `—`, `n/a`, a bare
 * `CUST-0035` key). That is a MISSING reference, not a party: a placeholder
 * must never be persisted, printed or echoed by a verification endpoint, and
 * each candidate is skipped so a real name behind it is still found.
 *
 * These helpers are DISPLAY ONLY. They are deliberately NOT used by the
 * integrity snapshots (`documentIntegrity.cjs` / `buildContractIntegritySnapshot`)
 * whose bytes must stay identical on both sides of the wire.
 *
 * READ-ONLY and pure. No network, no writes.
 */
const { stripCustomerIdSuffix } = require('./documentIntegrity.cjs');

/**
 * Values that LOOK like a customer name field but are not names: blank
 * strings, typographic placeholders and the internal customer key.
 */
const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  '-', '--', '---', '—', '–', '_', '__', '.', '..', 'n/a', 'na', 'none', 'null',
  'nil', 'undefined', 'customer', 'unknown', 'unknown customer', 'tbd',
]);

const normalizeText = (value) => String(value === undefined || value === null ? '' : value)
  .replace(/\s+/g, ' ')
  .trim();

/** True when `value` cannot serve as a customer/business name. */
function isPlaceholderCustomerName(value) {
  const textValue = normalizeText(value);
  if (!textValue) return true;
  if (PLACEHOLDER_CUSTOMER_NAMES.has(textValue.toLowerCase())) return true;
  // Only punctuation/symbols (e.g. "—", "-", "_"): no name characters at all.
  // Unicode-aware so non-Latin business names are never mistaken for noise.
  if (!/[\p{L}\p{N}]/u.test(textValue)) return true;
  // The internal customer key is a reference, never a name.
  if (/^CUST[-\s]?\d{3,}$/i.test(textValue)) return true;
  return false;
}

/** First candidate that can serve as a name (placeholders skipped), else ''. */
function firstUsableName(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const textValue = value.trim();
    if (textValue && !isPlaceholderCustomerName(textValue)) return textValue;
  }
  return '';
}

/**
 * Authoritative CUSTOMER / BUSINESS display name resolver.
 * Mirrors the frontend `getCustomerDisplayName` contract:
 *   1. businessName (preferred customer identity)
 *   2. companyName
 *   3. legacy customer name field (backward compat only)
 * Contact persons are resolved separately and never accepted here.
 */
function getCustomerDisplayName({ businessName, companyName, legacyCustomerName } = {}) {
  return firstUsableName(businessName, companyName, legacyCustomerName);
}

/**
 * Display-only resolver for customer-facing documents: same id-suffix
 * stripping as the hash-side resolver, but a placeholder (`_`, `-`, `—`, …)
 * is treated as "no name" so the fallback wins instead.
 *
 * NOT part of any stored digest: safe to tighten without invalidating
 * already-issued documents. Mirrors `resolveCustomerNameForDocument`.
 */
function resolveCustomerNameForDocument(customerName, schoolName) {
  const clean = (value) => {
    const stripped = stripCustomerIdSuffix(
      String(value === undefined || value === null ? '' : value),
    ).trim();
    return stripped && !isPlaceholderCustomerName(stripped) ? stripped : '';
  };
  return clean(customerName) || clean(schoolName) || '';
}

/**
 * School/branch name for a document: id-stripped, placeholder-free, or
 * `undefined`. Mirrors `resolveSchoolNameForDocument`.
 */
function resolveSchoolNameForDocument(schoolName) {
  const stripped = stripCustomerIdSuffix(
    String(schoolName === undefined || schoolName === null ? '' : schoolName),
  ).trim();
  return stripped && !isPlaceholderCustomerName(stripped) ? stripped : undefined;
}

/**
 * Party display name for a printing-contract record: the customer/business
 * name with the school name falling back in, handling both camelCase and
 * snake_case spellings and a nested `data` envelope. `''` when nothing usable
 * is found — callers then decide the generic label.
 */
function resolveContractPartyName(record) {
  const row = record && typeof record === 'object' ? record : {};
  const inner = row.data && typeof row.data === 'object' ? row.data : {};
  const groups = [
    [row.customerName, row.customer_name],
    [row.businessName, row.business_name],
    [row.companyName, row.company_name],
    [row.clientName, row.client_name],
    [row.schoolName, row.school_name],
    [inner.customer_name, inner.customerName],
    [inner.school_name, inner.schoolName],
  ];
  for (const [primary, secondary] of groups) {
    const name = resolveCustomerNameForDocument(primary, secondary);
    if (name) return name;
  }
  return '';
}

module.exports = {
  PLACEHOLDER_CUSTOMER_NAMES,
  isPlaceholderCustomerName,
  firstUsableName,
  getCustomerDisplayName,
  resolveCustomerNameForDocument,
  resolveSchoolNameForDocument,
  resolveContractPartyName,
};

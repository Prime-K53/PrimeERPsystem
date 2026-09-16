/**
 * marketLedgerSplit.cjs (Phase 2 / B3 + Phase 4 / C5+C6)
 *
 * Backend mirror of frontend marketPosting.ts + split math for invoice/sale
 * ledger postings. Pure functions — no DB access — directly unit-testable.
 */

const toNonNegative = (value) => {
  const n = Number(value || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
};

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

const normalizeType = (account) =>
  String(account?.account_type ?? account?.type ?? '').trim().toUpperCase();

const isPostable = (account) =>
  account?.allow_posting !== false && account?.allow_posting !== 0;

const isActive = (account) =>
  account?.is_active !== false && account?.is_active !== 0;

/**
 * Resolve the configured market-adjustment account id against the loaded
 * chart_of_accounts rows. Returns the account row or null when unset,
 * unknown, inactive, non-posting, or not an income account.
 */
const resolveMarketLedgerAccount = (allAccounts, configuredId) => {
  const key = String(configuredId || '').trim();
  if (!key) return null;
  const rows = Array.isArray(allAccounts) ? allAccounts : [];
  const found =
    rows.find((a) => String(a?.id || '') === key) ||
    rows.find((a) => String(a?.data?.code || a?.code || '') === key) ||
    rows.find((a) => String(a?.data?.account_number || a?.account_number || '') === key);
  if (!found) return null;
  if (!isActive(found) || !isPostable(found)) return null;
  const t = normalizeType(found?.data || found);
  if (t !== 'INCOME' && t !== 'REVENUE') return null;
  return found;
};

/**
 * Split an examination invoice total into market/tax/revenue legs.
 * Identity: total === market + tax + revenue (all >= 0, 2dp).
 * Rounding stays inside revenue (mirrors POS: revenue = total - rounding,
 * with no separate rounding leg).
 */
const splitInvoiceLedgerAmounts = ({ totalAmount, taxAmount, marketAmount }) => {
  const total = toNonNegative(totalAmount);
  const tax = Math.min(total, toNonNegative(taxAmount));
  const market = Math.min(total - tax, toNonNegative(marketAmount));
  const revenue = Math.round(((total - tax - market + Number.EPSILON)) * 100) / 100;
  return { total, tax, market, revenue: Math.max(0, revenue) };
};

/**
 * Split a POS sale total into balanced ledger legs (Phase 4 / C5).
 * Identity: debits (AR + COGS) === credits (revenue + market + tax + inventory).
 * Rounding stays inside revenue (mirrors the frontend POS posting).
 */
const splitSaleLedgerAmounts = ({ totalAmount, taxAmount, marketAmount, materialTotal }) => {
  const total = toNonNegative(totalAmount);
  const tax = Math.min(total, toNonNegative(taxAmount));
  const market = Math.min(Math.max(0, total - tax), toNonNegative(marketAmount));
  const revenue = Math.max(0, round2(total - tax - market));
  const material = toNonNegative(materialTotal);
  return { total, tax, market, revenue, cogs: material, inventory: material };
};

/**
 * Revenue account selector for sale/invoice AR postings (Phase 4 / C6).
 * Explicit salesAccountId always wins (validated by the caller); service-only
 * item lists fall back to 41200, everything else to defaultCode (41100).
 */
const isServiceOnlyItems = (items) =>
  Array.isArray(items) && items.length > 0 && items.every((i) => i?.type === 'Service');

const resolveSaleRevenueCode = ({ salesAccountId, items, defaultCode = '41100' } = {}) => {
  const explicit = String(salesAccountId || '').trim();
  if (explicit) return explicit;
  if (isServiceOnlyItems(items)) return '41200';
  return defaultCode;
};

module.exports = {
  toNonNegative,
  resolveMarketLedgerAccount,
  splitInvoiceLedgerAmounts,
  splitSaleLedgerAmounts,
  isServiceOnlyItems,
  resolveSaleRevenueCode,
};

/**
 * Prime ERP money formatting for the responsive table system.
 *
 * Existing convention: `K` prefix + thousands separators. Most ERP list cells
 * render whole Kwacha (`(n).toLocaleString()`); the portal `formatK` renders
 * 2 decimals. This helper preserves the numeric value exactly (display only,
 * no rounding logic changes) and defaults to 0 decimals per the table UX spec.
 */
export interface KwachaOptions {
  symbol?: string;
  decimals?: number;
}

export function formatKwacha(
  value: number | string | null | undefined,
  opts: KwachaOptions = {},
): string {
  const { symbol = 'K', decimals = 0 } = opts;
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return `${symbol}0`;
  return (
    `${symbol}` +
    num.toLocaleString('en-US', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

/** Compact variant for tight mobile slots (e.g. K1.2M). Value untouched. */
export function formatKwachaCompact(value: number | string | null | undefined): string {
  const num = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(num)) return 'K0';
  const abs = Math.abs(num);
  if (abs >= 1_000_000) return `K${(num / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `K${Math.round(num / 1_000).toLocaleString('en-US')}K`;
  return formatKwacha(num);
}

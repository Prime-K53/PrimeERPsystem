import type { VATConfig } from '../types';

/**
 * Independent VAT / market-adjustment posting switches (Phase 5 / B10).
 *
 * Legacy configs only carry `pricingMode: 'VAT' | 'MarketAdjustment'`
 * (mutually exclusive). New configs carry explicit
 * `applyVatOnSales` / `applyMarketAdjustmentsOnSales` flags that compose:
 * both legs may post on one sale (tax first, then market — the identity
 * revenue + market + tax + rounding === total holds either way).
 *
 * `undefined` flags fall back to the legacy `pricingMode` derivation, so
 * existing companies see zero behavior change until they opt into compose
 * in Settings.
 */
export const isVatPostingActive = (vat: VATConfig | undefined | null): boolean => {
  if (!vat) return false;
  if (vat.enabled === false) return false;
  if (vat.applyVatOnSales !== undefined && vat.applyVatOnSales !== null) {
    return vat.applyVatOnSales;
  }
  return vat.pricingMode === 'VAT';
};

export const isMarketPostingActive = (vat: VATConfig | undefined | null): boolean => {
  if (!vat) return false;
  if (
    vat.applyMarketAdjustmentsOnSales !== undefined &&
    vat.applyMarketAdjustmentsOnSales !== null
  ) {
    return vat.applyMarketAdjustmentsOnSales;
  }
  return vat.pricingMode === 'MarketAdjustment';
};

/**
 * Legacy `pricingMode` value kept in sync for old readers:
 * VAT wins when both are on (matches the pre-compose default).
 */
export const derivePricingMode = (vat: Partial<VATConfig>): 'VAT' | 'MarketAdjustment' =>
  isMarketPostingActive({ pricingMode: 'VAT', enabled: true, rate: 0, filingFrequency: 'Monthly', ...vat }) &&
  !isVatPostingActive({ pricingMode: 'VAT', enabled: true, rate: 0, filingFrequency: 'Monthly', ...vat })
    ? 'MarketAdjustment'
    : 'VAT';

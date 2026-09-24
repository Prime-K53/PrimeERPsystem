import { listOfflineMarginSettingsAsync, resolveOfflineEffectiveMargin } from '../services/offlineProfitMargins';

export interface EffectiveMargin {
  margin_value: number;
  margin_type: 'percentage' | 'fixed_amount';
  source: 'line_item' | 'category' | 'global' | 'system';
  apply_volume_margins?: boolean;
}

const cache = new Map<string, EffectiveMargin>();

export async function getEffectiveMargin(
  lineItemId?: string | null,
  categoryId?: string | null,
  useCache = true
): Promise<EffectiveMargin> {
  const cacheKey = `${lineItemId ?? ''}|${categoryId ?? ''}`;

  if (useCache && cache.has(cacheKey)) {
    return cache.get(cacheKey)!;
  }

  const localMargin = resolveOfflineEffectiveMargin(lineItemId, categoryId);
  if (useCache) cache.set(cacheKey, localMargin);
  return localMargin;
}

/**
 * Canonical global-margin loader for examination pricing surfaces.
 * Uses the async offline store (localStorage + IndexedDB fallback) so it
 * matches the Settings > Profit Markup page, which can show a value that
 * the synchronous localStorage-only path would miss (and would render as 0%).
 */
export async function getGlobalMargin(): Promise<EffectiveMargin> {
  try {
    const settings = await listOfflineMarginSettingsAsync();
    const global = (settings || []).find((setting) => (
      setting.scope === 'global'
      && !setting.deleted_at
      && (setting.is_active === true || setting.is_active === 1 || String(setting.is_active).toLowerCase() === 'true')
    ));
    if (global) {
      invalidateMarginCache();
      return {
        margin_value: Number(global.margin_value) || 0,
        margin_type: global.margin_type === 'fixed_amount' ? 'fixed_amount' : 'percentage',
        source: 'global',
        apply_volume_margins: Boolean(global.apply_volume_margins)
      };
    }
  } catch {
    // Fall through to the synchronous offline path below.
  }
  invalidateMarginCache();
  return resolveOfflineEffectiveMargin(null, null);
}

export function formatMarginDisplay(margin: EffectiveMargin | null | undefined): string {
  if (!margin || margin.source === 'system' || !(Number(margin.margin_value) > 0)) return '0%';
  if (margin.margin_type === 'fixed_amount') return `MWK ${Number(margin.margin_value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `${Number(margin.margin_value).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

export function invalidateMarginCache(lineItemId?: string, categoryId?: string) {
  if (!lineItemId && !categoryId) {
    cache.clear();
    return;
  }

  for (const key of cache.keys()) {
    const [cachedLineItemId, cachedCategoryId] = key.split('|');
    if (
      (lineItemId && cachedLineItemId === lineItemId)
      || (categoryId && cachedCategoryId === categoryId)
    ) {
      cache.delete(key);
    }
  }
}

export function applyMargin(baseCost: number, margin: EffectiveMargin): number {
  if (margin.margin_type === 'percentage') {
    return baseCost * (1 + margin.margin_value / 100);
  }

  return baseCost + margin.margin_value;
}

export async function getSellingPrice(
  baseCost: number,
  lineItemId?: string | null,
  categoryId?: string | null
): Promise<{ sellingPrice: number; margin: EffectiveMargin }> {
  const margin = await getEffectiveMargin(lineItemId, categoryId);
  return { sellingPrice: applyMargin(baseCost, margin), margin };
}

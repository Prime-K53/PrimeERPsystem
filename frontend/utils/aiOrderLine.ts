import type { CartItem, Item } from '../types';
import {
  resolveStoredCalculatedPrice,
  resolveStoredCost,
  resolveStoredSellingPrice,
} from './pricing';
import { roundToCurrency } from './helpers';

export interface AiExtractedLine {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
}

const normalizeToken = (value: unknown): string =>
  String(value ?? '').toLowerCase().replace(/s$/, '');

/**
 * AI Invoice → Order Form product matching.
 *
 * Mirrors the matching previously inline in OrderForm's AIGeneratorCard
 * onPopulate handler (exact/substring pass, then single-word fuzzy pass).
 * Extracted here so the normalization boundary is unit-testable.
 * Returns the matched inventory item, or null when nothing matches.
 */
export function matchAiLineToProduct(
  description: string,
  inventory: Item[]
): Item | null {
  const desc = String(description || '').toLowerCase();
  if (!desc || !Array.isArray(inventory)) return null;

  const exact = inventory.find((inv: any) => {
    const invName = inv.name?.toLowerCase() || '';
    return (
      invName === desc ||
      invName.includes(desc) ||
      desc.includes(invName) ||
      normalizeToken(invName) === normalizeToken(desc) ||
      normalizeToken(invName).includes(normalizeToken(desc)) ||
      normalizeToken(desc).includes(normalizeToken(invName))
    );
  });
  if (exact) return exact;

  const similar = inventory.find((inv: any) => {
    const a = inv.name?.toLowerCase() || '';
    const words = desc.split(/\s+/);
    for (const word of words) {
      if (word.length > 2 && a.includes(word)) return true;
      if (word.length > 2 && normalizeToken(a).includes(normalizeToken(word))) return true;
    }
    const invWords = a.split(/\s+/);
    for (const w of invWords) {
      if (w.length > 2 && desc.includes(w)) return true;
      if (w.length > 2 && normalizeToken(desc).includes(normalizeToken(w))) return true;
    }
    return false;
  });
  return similar || null;
}

const toSafeQty = (value: unknown): number => {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const toSafeMoney = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? roundToCurrency(parsed) : 0;
};

/**
 * Build ONE canonical Order Form line from an AI-extracted invoice line.
 *
 * This is the earliest correct state transition for the AI → Order Form
 * boundary and the single place where AI lines enter Order Form state.
 *
 * Matched product (exact or fuzzy):
 * - id/productId use the master id so every downstream inventory lookup
 *   (cost fallback, quantity restore, persistence productId) resolves —
 *   the same identity a normally-added line carries.
 * - CP comes from resolveStoredCost (authoritative cost resolver, also used
 *   by getInventoryPrices). Never fabricated, never the AI price.
 * - SP comes from resolveStoredSellingPrice (authoritative selling-price
 *   resolver, also used by handleAddItem). The AI-extracted unit price is
 *   used ONLY as a fallback when the master carries no SP. AI never
 *   overwrites master pricing.
 * - All canonical SP aliases (price/unitPrice/selling_price) and CP
 *   aliases (cost/cost_price) are populated together so the profit engine
 *   (saleProfit, which reads price + cost aliases) and the persisted
 *   pricing breakdown observe identical state however the line is added.
 * - basePrice follows the dominant non-variant convention
 *   (handleAddItem stamps basePrice = finalUnitPrice, i.e. SP semantics).
 *
 * Unmatched item:
 * - Keeps the AI-extracted unit price as the initial SP (extracted data,
 *   not invented; stays 0 when the AI had no price).
 * - CP stays 0: never fabricated. Profit is therefore 0 until priced,
 *   never a false figure derived from an invented cost.
 */
export function buildAiOrderFormLine(
  aiItem: AiExtractedLine,
  inventory: Item[],
  index: number,
  nowMs: number = Date.now()
): CartItem {
  const quantity = toSafeQty(aiItem?.quantity);
  const aiUnitPrice = toSafeMoney(aiItem?.unitPrice);
  const taxRate = Math.max(0, Number(aiItem?.taxRate) || 0);
  const description = String(aiItem?.description || '').trim();

  const match = matchAiLineToProduct(description, inventory);

  if (match) {
    const costPrice = resolveStoredCost(match as any);
    const storedSp = resolveStoredSellingPrice(match as any);
    // Authoritative master SP wins; AI price is only a fallback when the
    // master carries no SP (e.g. unpriced parent). Never the reverse.
    const sellingPrice = storedSp > 0 ? storedSp : aiUnitPrice;
    const calculated = resolveStoredCalculatedPrice(match as any) || sellingPrice;

    return {
      ...(match as object),
      id: match.id,
      productId: match.id,
      name: match.name,
      description,
      quantity,
      price: sellingPrice,
      unitPrice: sellingPrice,
      selling_price: sellingPrice,
      calculated_price: calculated,
      cost: costPrice,
      cost_price: costPrice,
      basePrice: sellingPrice,
      baseUnitPrice: sellingPrice,
      customerPriceAdjusted: false,
      customerPricingTier: '',
      customerPricingSegment: '',
      discount: 0,
      taxRate,
      adjustmentSnapshots: [],
      adjustmentTotal: 0,
      lineTotalNet: roundToCurrency(quantity * sellingPrice),
    } as CartItem;
  }

  return {
    id: `AI-${nowMs}-${index}`,
    productId: '',
    name: description,
    description,
    quantity,
    price: aiUnitPrice,
    unitPrice: aiUnitPrice,
    selling_price: aiUnitPrice,
    calculated_price: aiUnitPrice,
    cost: 0,
    cost_price: 0,
    basePrice: aiUnitPrice,
    baseUnitPrice: aiUnitPrice,
    type: 'Service',
    category: 'Service',
    discount: 0,
    taxRate,
    adjustmentSnapshots: [],
    adjustmentTotal: 0,
    lineTotalNet: roundToCurrency(quantity * aiUnitPrice),
  } as CartItem;
}

/**
 * Pure canonical manual-price update for a sales Order Form line.
 *
 * Sales-mode invariant: editing SP syncs every canonical SP alias
 * (price/unitPrice/selling_price) so the grid, the Amount cell, the
 * saleProfit engine and the pricing-breakdown snapshot all observe the
 * same selling price. CP aliases are deliberately untouched: a selling-
 * price edit must never rewrite stored cost.
 */
export function withManualUnitPrice<T extends Record<string, any>>(
  line: T,
  newPrice: number | string
): T {
  const safePrice = roundToCurrency(Math.max(0, Number(newPrice) || 0));
  const serviceDetails = (line as any).serviceDetails
    ? {
        ...(line as any).serviceDetails,
        unitPricePerCopy: safePrice,
        totalPrice: safePrice * (Number((line as any).quantity) || 1),
      }
    : (line as any).serviceDetails;

  return {
    ...line,
    price: safePrice,
    unitPrice: safePrice,
    selling_price: safePrice,
    manual_override: true,
    serviceDetails,
  };
}

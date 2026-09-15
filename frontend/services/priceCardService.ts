import type { Customer, CustomerPricingTier, Item } from '../types';
import { getUnitPrice, resolveStoredSellingPrice } from '../utils/pricing';
import { getCustomerPricingTier, resolveCustomerPrice } from './customerPricingService';
import { getCustomerDisplayName } from '../utils/customerDisplay';

/**
 * priceCardService — informational Price Card data layer (ERP only).
 *
 * A Price Card is a customer-facing price communication artifact. It is NOT a
 * transactional document: building card data performs zero writes — no sales,
 * quotations, orders, invoices, payments, receipts, ledger entries, stock
 * movements, or customer-balance changes.
 *
 * Pricing is never calculated here. The final customer-facing selling price
 * always comes from the same authoritative chain used by POS and Order Form:
 *   1. `resolveStoredSellingPrice` / `getUnitPrice` (utils/pricing) — stored
 *      SmartPricing value incl. market adjustment, rounding and volume tiers.
 *   2. Customer-tier multiplier via `resolveCustomerPrice`
 *      (services/customerPricingService) — applied exactly like POS when a
 *      customer with a pricing tier is selected.
 */

export const PRICE_CARD_MAX_LINES = 5;
export const PRICE_CARD_HISTORY_KEY = 'prime_price_card_history';
export const PRICE_CARD_HISTORY_LIMIT = 50;
export const PRICE_CARD_REFERENCE_PREFIX = 'PC';

export type PriceAvailability = 'ok' | 'missing' | 'zero';

/** Explicit customer-facing line — the ONLY product fields that may be rendered. */
export interface PriceCardLine {
  productName: string;
  description?: string;
  unit?: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  imageUrl?: string;
}

export interface PriceCardLineInput {
  item: Item;
  variantId?: string;
  quantity?: number;
}

export interface PriceCardBusiness {
  name: string;
  phone?: string;
  address?: string;
  logoUrl?: string;
  currency: string;
}

export interface PriceCardData {
  reference: string;
  issuedAt: string;
  lines: PriceCardLine[];
  /** True when every line has quantity 1 (unit-price presentation). */
  unitOnly: boolean;
  grandTotal: number;
  customerName?: string;
  business: PriceCardBusiness;
}

export interface PriceCardHistoryEntry {
  reference: string;
  issuedAt: string;
  productNames: string[];
  grandTotal: number;
  currency: string;
  customerName?: string;
}

export class PriceCardError extends Error {
  code: 'missing-price' | 'zero-price' | 'too-many-lines' | 'no-lines' | 'product-not-found';
  constructor(code: PriceCardError['code'], message: string) {
    super(message);
    this.name = 'PriceCardError';
    this.code = code;
  }
}

export interface PriceCardDeps {
  /** Override for the customer-tier lookup (offline-safe default; injectable for tests). */
  fetchCustomerTier?: (customerId: string) => Promise<CustomerPricingTier | null>;
}

const defaultFetchTier = (customerId: string): Promise<CustomerPricingTier | null> =>
  getCustomerPricingTier(customerId).catch(() => null);

const toFinite = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Distinguish "price missing" from "explicit zero" — they must never be
 * confused. Missing (no finite price field at all) and zero/negative prices
 * both block generation, but with different messages.
 */
export function assessPriceAvailability(source?: Record<string, any> | null): PriceAvailability {
  if (!source) return 'missing';
  const candidates = [
    source.smartPricingSnapshot?.roundedPrice,
    source.selling_price,
    source.sellingPrice,
    source.price,
    source.calculated_price,
  ];
  const finite = candidates.map(toFinite).filter((v): v is number => v !== undefined);
  if (finite.length === 0) return 'missing';
  return finite.some((v) => v > 0) ? 'ok' : 'zero';
}

const pickProductImage = (item: Item): string | undefined => {
  const raw = (item as Record<string, any>)?.imageUrl
    ?? (item as Record<string, any>)?.image
    ?? (item as Record<string, any>)?.photoUrl
    ?? (item as Record<string, any>)?.pictureUrl;
  const url = String(raw ?? '').trim();
  return url ? url : undefined;
};

const cleanText = (value: unknown): string => String(value ?? '').trim();

/**
 * Customer-tier multiplier, computed exactly like POS (commitAddToCart):
 * resolveCustomerPrice(100, tier, segment) / 100. Falls back to 1 when the
 * customer has no tier or the lookup fails (offline-safe).
 */
export async function resolvePriceCardMultiplier(
  customer: Customer | null | undefined,
  deps?: PriceCardDeps,
): Promise<number> {
  if (!customer?.id) return 1;
  try {
    const fetchTier = deps?.fetchCustomerTier ?? defaultFetchTier;
    const tier = await fetchTier(customer.id);
    const adjusted = resolveCustomerPrice(100, tier, (customer as Customer).segment || '');
    const multiplier = Number(adjusted) / 100;
    return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
  } catch {
    return 1;
  }
}

export interface BuildPriceCardInput {
  lines: PriceCardLineInput[];
  customer?: Customer | null;
  business: PriceCardBusiness;
  reference: string;
  issuedAt?: string;
}

/**
 * Build render-ready Price Card data. Read-only: resolves prices through the
 * authoritative chain, selects only customer-safe fields, and throws a
 * user-facing PriceCardError when generation must be blocked.
 */
export async function buildPriceCardData(
  input: BuildPriceCardInput,
  deps?: PriceCardDeps,
): Promise<PriceCardData> {
  const lines = input.lines ?? [];
  if (lines.length === 0) {
    throw new PriceCardError('no-lines', 'Add at least one product to create a Price Card.');
  }
  if (lines.length > PRICE_CARD_MAX_LINES) {
    throw new PriceCardError(
      'too-many-lines',
      `A Price Card holds at most ${PRICE_CARD_MAX_LINES} products so it stays readable on a phone screen. Create another card for the rest.`,
    );
  }

  const multiplier = await resolvePriceCardMultiplier(input.customer ?? null, deps);
  const customerName = input.customer
    ? getCustomerDisplayName({
        businessName: (input.customer as Customer).businessName ?? null,
        companyName: (input.customer as Customer).companyName ?? null,
        legacyCustomerName: (input.customer as Customer).name ?? null,
      })
    : '';

  const cardLines: PriceCardLine[] = lines.map((entry) => {
    const item = entry.item;
    if (!item) {
      throw new PriceCardError('product-not-found', 'One of the selected products is no longer available.');
    }
    const variant = entry.variantId && Array.isArray(item.variants)
      ? item.variants.find((v: any) => v?.id === entry.variantId)
      : undefined;
    const pricedSource = (variant as Record<string, any> | undefined) ?? (item as Record<string, any>);
    const availability = assessPriceAvailability(pricedSource);
    if (availability === 'missing') {
      throw new PriceCardError(
        'missing-price',
        `Price unavailable for "${item.name}". Check the product's selling price before generating a card.`,
      );
    }

    const quantity = Math.max(1, Math.floor(Number(entry.quantity) || 1));
    // Authoritative chain: stored selling price -> volume tiers -> customer tier.
    const tierBase = getUnitPrice(item, quantity, entry.variantId);
    const unitPrice = tierBase * multiplier;
    if (!(unitPrice > 0)) {
      throw new PriceCardError(
        'zero-price',
        `Price unavailable for "${item.name}". A Price Card is never generated with K0.`,
      );
    }

    const productName = cleanText((variant as any)?.name) || cleanText(item.name) || 'Product';
    const description = cleanText((variant as any)?.description) || cleanText(item.description) || undefined;
    const unit = cleanText((variant as any)?.unit) || cleanText(item.unit) || undefined;
    const imageUrl = pickProductImage(item);
    const line: PriceCardLine = {
      productName,
      quantity,
      unitPrice,
      lineTotal: unitPrice * quantity,
    };
    if (description !== undefined) line.description = description;
    if (unit !== undefined) line.unit = unit;
    if (imageUrl !== undefined) line.imageUrl = imageUrl;
    return line;
  });

  return {
    reference: input.reference,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    lines: cardLines,
    unitOnly: cardLines.every((line) => line.quantity === 1),
    grandTotal: cardLines.reduce((sum, line) => sum + line.lineTotal, 0),
    customerName: customerName || undefined,
    business: input.business,
  };
}

/** Next `PC-YYYY-NNNN` reference, sequenced within local card history only. */
export function generatePriceCardReference(history: PriceCardHistoryEntry[]): string {
  const year = new Date().getFullYear();
  const pattern = new RegExp(`^${PRICE_CARD_REFERENCE_PREFIX}-${year}-(\\d+)$`, 'i');
  let max = 0;
  for (const entry of history ?? []) {
    const match = String(entry?.reference ?? '').trim().match(pattern);
    if (!match) continue;
    const parsed = parseInt(match[1], 10);
    if (!Number.isNaN(parsed) && parsed > max) max = parsed;
  }
  return `${PRICE_CARD_REFERENCE_PREFIX}-${year}-${String(max + 1).padStart(4, '0')}`;
}

export function loadPriceCardHistory(): PriceCardHistoryEntry[] {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return [];
    const raw = window.localStorage.getItem(PRICE_CARD_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((e) => e && typeof e.reference === 'string') : [];
  } catch {
    return [];
  }
}

export function recordPriceCardHistory(data: PriceCardData): PriceCardHistoryEntry[] {
  const entry: PriceCardHistoryEntry = {
    reference: data.reference,
    issuedAt: data.issuedAt,
    productNames: data.lines.map((line) => line.productName),
    grandTotal: data.grandTotal,
    currency: data.business.currency,
    customerName: data.customerName,
  };
  const next = [entry, ...loadPriceCardHistory()].slice(0, PRICE_CARD_HISTORY_LIMIT);
  try {
    window.localStorage.setItem(PRICE_CARD_HISTORY_KEY, JSON.stringify(next));
  } catch { /* storage unavailable — history is best-effort */ }
  return next;
}

export function sanitizeFileNameSegment(value: string): string {
  return cleanText(value)
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'Price-Card';
}

export function buildPriceCardFileName(data: PriceCardData): string {
  const productPart = data.lines.length === 1
    ? sanitizeFileNameSegment(data.lines[0].productName)
    : `${data.lines.length}-items`;
  const businessPart = sanitizeFileNameSegment(data.business.name || 'Prime-Printing');
  return `${businessPart}-Price-Card-${productPart}-${data.reference}.png`;
}

/** `K 12,000.00` — same shape as the ERP `money()` convention. */
export function formatPriceCardAmount(value: number, currency: string): string {
  const symbol = cleanText(currency) || 'K';
  const amount = Number(value) || 0;
  return `${symbol} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `15 Sep 2026 • 05:12` in the business locale. */
export function formatPriceCardTimestamp(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  const safe = Number.isNaN(date.getTime()) ? new Date() : date;
  const day = safe.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const time = safe.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} • ${time}`;
}

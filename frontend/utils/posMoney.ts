import { normalizeCurrencyCode } from './helpers';

/**
 * Money formatting for POS surfaces.
 *
 * Two defects this replaces:
 *  1. `+${symbol}${formatNumber(v)}` produced "+K-50.00" for negative market
 *     adjustments. The sign is now carried by Intl, never concatenated.
 *  2. `formatNumber` hardcodes the 'en-US' locale, so an MWK tenant saw
 *     en-US grouping regardless of their configured currency.
 */

const CURRENCY_DECIMALS: Record<string, number> = {
    MWK: 0,
    JPY: 0,
    KRW: 0,
    VND: 0,
    CLP: 0,
    ISK: 0,
};

const cache = new Map<string, Intl.NumberFormat>();

function formatterFor(code: string): Intl.NumberFormat {
    const cached = cache.get(code);
    if (cached) return cached;
    const decimals = CURRENCY_DECIMALS[code] ?? 2;
    let fmt: Intl.NumberFormat;
    try {
        fmt = new Intl.NumberFormat(undefined, {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
    } catch {
        fmt = new Intl.NumberFormat('en-US', {
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
        });
    }
    cache.set(code, fmt);
    return fmt;
}

/** Locale-aware digits only. The symbol is supplied by the caller. */
export function formatAmount(amount: number, currency?: string | null): string {
    const value = Number.isFinite(amount) ? amount : 0;
    return formatterFor(normalizeCurrencyCode(currency)).format(value);
}

/** Signed amount with an explicit leading + or −. Use for deltas. */
export function formatSignedAmount(amount: number, currency?: string | null): string {
    const value = Number.isFinite(amount) ? amount : 0;
    const body = formatAmount(Math.abs(value), currency);
    if (value > 0) return `+${body}`;
    if (value < 0) return `−${body}`;
    return body;
}

/** Amount with the currency symbol prefix. */
export function formatMoney(amount: number, symbol: string, currency?: string | null): string {
    const value = Number.isFinite(amount) ? amount : 0;
    const prefix = value < 0 ? '−' : '';
    return `${prefix}${symbol}${formatAmount(Math.abs(value), currency)}`;
}

/** Signed amount with the currency symbol prefix. Use for adjustments/deltas. */
export function formatSignedMoney(amount: number, symbol: string, currency?: string | null): string {
    const value = Number.isFinite(amount) ? amount : 0;
    const body = `${symbol}${formatAmount(Math.abs(value), currency)}`;
    if (value > 0) return `+${body}`;
    if (value < 0) return `−${body}`;
    return body;
}

/** True when the currency has no minor unit — such amounts must be whole. */
export function currencyIsZeroDecimal(currency?: string | null): boolean {
    return (CURRENCY_DECIMALS[normalizeCurrencyCode(currency)] ?? 2) === 0;
}

/**
 * Tender denominations for quick-cash chips, scaled to the currency so the
 * presets are meaningful instead of hardcoded 5,000 / 10,000.
 */
export function getQuickCashPresets(currency?: string | null): number[] {
    switch (normalizeCurrencyCode(currency)) {
        case 'MWK':
            return [2000, 5000, 10000, 20000];
        case 'KES':
        case 'UGX':
        case 'TZS':
        case 'ZMW':
            return [500, 1000, 2000, 5000];
        case 'NGN':
            return [1000, 2000, 5000, 10000];
        case 'USD':
        case 'EUR':
        case 'GBP':
        case 'ZAR':
            return [5, 10, 20, 50];
        case 'INR':
            return [100, 500, 1000, 2000];
        default:
            return [1000, 5000, 10000, 20000];
    }
}
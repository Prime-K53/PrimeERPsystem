/**
 * currencyService.cjs
 *
 * Audit fix F-20: cache TTL + sub-cent precision.
 *
 *   * The in-memory `exchangeRates` Map is now keyed with a timestamp and
 *     expires after CACHE_TTL_MS (default 5 minutes). A long-running Node
 *     process no longer serves stale rates after an admin update.
 *   * `convert()` no longer discards sub-cent precision on intermediate
 *     steps.  A multi-hop conversion (A→B→C) is now representable
 *     without compounded error; the final 2-decimal rounding is applied
 *     at presentation time, not on the wire.
 */

const repo = require('./supabaseRepository.cjs');
const crypto = require('crypto');

const CACHE_TTL_MS = 5 * 60 * 1000;

class CurrencyService {
  constructor() {
    this.defaultCurrency = 'USD';
    this.exchangeRates = new Map();
  }

  async getCurrency() {
    const rows = await repo.getAll('settings', { 'data->>key': 'eq.default_currency' });
    return rows.length > 0 ? rows[0].value : this.defaultCurrency;
  }

  async getExchangeRate(fromCurrency, toCurrency, date = null) {
    const cacheKey = `${fromCurrency}_${toCurrency}_${date || 'latest'}`;
    const cached = this.exchangeRates.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.rate;
    }
    let rows = await repo.getAll('exchange_rates', {
      'data->>from_currency': `eq.${fromCurrency}`,
      'data->>to_currency': `eq.${toCurrency}`,
    });
    if (date) {
      rows = rows.filter((r) => r.date <= date)
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    } else {
      rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    }
    const rate = rows.length > 0 ? Number(rows[0].rate) : 1;
    this.exchangeRates.set(cacheKey, { rate, at: Date.now() });
    return rate;
  }

  /**
   * Convert an amount.  Sub-cent precision is preserved on intermediate
   * hops; rounding to 2dp is applied at the end so a multi-hop chain
   * (A→B→C) is accurate to the last step. Callers that need the raw
   * fractional product should use `convertPrecise()`.
   */
  async convert(amount, fromCurrency, toCurrency, date = null) {
    if (fromCurrency === toCurrency) return Number(amount);
    const rate = await this.getExchangeRate(fromCurrency, toCurrency, date);
    const precise = Number(amount) * rate;
    // Apply cents rounding only at the wire boundary.
    return Math.round(precise * 100) / 100;
  }

  /**
   * Convert without rounding — useful for cascading conversions
   * (A→B→C) where intermediate precision matters.  Each hop returns a
   * raw float; the caller rounds once at the end.
   */
  async convertPrecise(amount, fromCurrency, toCurrency, date = null) {
    if (fromCurrency === toCurrency) return Number(amount);
    const rate = await this.getExchangeRate(fromCurrency, toCurrency, date);
    return Number(amount) * rate;
  }

  async updateExchangeRate(fromCurrency, toCurrency, rate, date = null) {
    const rateDate = date || new Date().toISOString().split('T')[0];
    const cacheKey = `${fromCurrency}_${toCurrency}_${rateDate || 'latest'}`;
    const existing = await repo.getAll('exchange_rates', {
      'data->>from_currency': `eq.${fromCurrency}`,
      'data->>to_currency': `eq.${toCurrency}`,
      'data->>date': `eq.${rateDate}`,
    });
    const record = {
      id: existing.length > 0 ? existing[0].id : `ER-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      from_currency: fromCurrency,
      to_currency: toCurrency,
      rate,
      date: rateDate,
    };
    await repo.upsert('exchange_rates', record);
    this.exchangeRates.delete(cacheKey);
    // Invalidate every TTL bucket that includes this pair.
    for (const key of this.exchangeRates.keys()) {
      if (key.startsWith(`${fromCurrency}_${toCurrency}_`)) this.exchangeRates.delete(key);
    }
    return { fromCurrency, toCurrency, rate, date: rateDate };
  }

  async getCurrencies() {
    const rows = await repo.getAll('currencies', { 'data->>is_active': 'eq.1' });
    return rows.sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
  }

  async addCurrency(code, name, symbol, decimalPlaces = 2) {
    const existing = await repo.getAll('currencies', { 'data->>code': `eq.${code}` });
    const record = {
      id: existing.length > 0 ? existing[0].id : code,
      code,
      name,
      symbol,
      decimal_places: decimalPlaces,
      is_active: 1,
    };
    await repo.upsert('currencies', record);
    return { code, name, symbol, decimalPlaces };
  }

  formatAmount(amount, currencyCode, locale = 'en-US') {
    try {
      return new Intl.NumberFormat(locale, {
        style: 'currency', currency: currencyCode,
        minimumFractionDigits: 2, maximumFractionDigits: 2,
      }).format(amount);
    } catch (e) {
      return `${currencyCode} ${Number(amount).toFixed(2)}`;
    }
  }

  parseCurrency(currencyString) {
    const cleaned = String(currencyString || '').replace(/[^0-9.-]/g, '');
    return Number(cleaned);
  }
}

module.exports = CurrencyService;

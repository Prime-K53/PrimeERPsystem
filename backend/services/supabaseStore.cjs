const axios = require('axios');

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';
const KEY = SECRET_KEY || PUBLISHABLE_KEY;

const CACHE_TTL_MS = 15 * 1000;
const cache = new Map();

const isConfigured = () => Boolean(SUPABASE_URL && KEY && !SUPABASE_URL.includes('placeholder'));

async function request(table, params = {}, options = {}) {
  if (!isConfigured()) return null;
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    'User-Agent': options.userAgent || 'supabase-js/2',
  };
  try {
    const { data } = await axios.get(url, { params, headers, timeout: options.timeout || 10000 });
    return Array.isArray(data) ? data : null;
  } catch (err) {
    const status = err.response && err.response.status;
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : '';
    console.warn(`[SupabaseStore] ${table} read failed (${status || err.message}): ${detail}`);
    return null;
  }
}

async function cached(key, fetcher) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fetcher();
  cache.set(key, { at: Date.now(), value });
  return value;
}

const { normalizeInvoiceLineItems, normalizeInvoiceRow, num } = require('./invoiceLineItemNormalization.cjs');

// ─── Catalog (products) ────────────────────────────────────────────────

async function listCatalogItems() {
  return cached('catalog', async () => {
    const rows = await request('products', { select: 'id,data' }, { timeout: 20000 });
    if (!rows || rows.length === 0) return [];
    const items = [];
    for (const row of rows) {
      const d = (row && typeof row.data === 'object' && row.data) ? row.data : {};
      if (String(d.status || '').toLowerCase() === 'deleted') continue;
      if (String(d.inventoryRole || '').toLowerCase() === 'internal') continue;
      items.push({
        id: row.id,
        name: d.name || row.name || row.id,
        sku: d.sku || null,
        unit: d.unit || '',
        price: num(d.sellingPrice ?? d.selling_price ?? d.price),
        quantity: num(d.stock),
        category: d.category || d.type || 'General',
        status: d.status || 'Active',
      });
    }
    return items;
  });
}

// ─── Sales (POS receipts — real ERP activity) ─────────────────────────

async function listSales(customerId) {
  if (!customerId) return [];
  return cached(`sales:${customerId}`, async () => {
    const rows = await request('sales', { select: 'id,data', 'data->>customerId': 'eq.' + customerId, limit: 1000 }, { timeout: 20000 });
    if (!rows || rows.length === 0) return [];
    return rows.map((row) => {
      const d = (row && typeof row.data === 'object' && row.data) ? row.data : {};
      return {
        id: row.id,
        date: d.date || d.paid_at || d.created_at || null,
        totalAmount: num(d.totalAmount ?? d.total ?? d.total_amount),
        customerName: d.customerName || '',
        status: d.status || 'Paid',
      };
    });
  });
}

// ─── Customers ──────────────────────────────────────────────────────────

async function getCustomer(customerId) {
  if (!customerId) return null;
  const rows = await request('customers', { id: 'eq.' + customerId, select: 'id,data' });
  if (!rows || rows.length === 0) return null;
  const row = rows[0];
  const d = (row && typeof row.data === 'object' && row.data) ? row.data : {};
  return {
    id: row.id,
    name: d.name || row.name || '',
    email: d.email || row.email || '',
    phone: d.phone || row.phone || '',
    address: d.billingAddress || d.address || '',
    city: d.city || '',
    state: d.state || '',
    zip: d.zip || '',
    country: d.country || '',
    balance: num(d.balance),
    walletBalance: num(d.walletBalance),
    creditLimit: num(d.creditLimit),
    outstandingBalance: num(d.outstandingBalance ?? d.balance),
    status: d.status || row.status || '',
  };
}

// ─── Invoices ───────────────────────────────────────────────────────────
// Delegates to the shared normalization layer so every payment status and
// legacy field shape (items / line_items / lineItems / lines / invoiceItems /
// line_items_json etc.) maps to a consistent portal structure. The layer treats
// an empty array as "no items" and falls through to the next candidate, fixing
// the unpaid-invoice bug where `items: []` shadowed the real data in
// `line_items_json`/`line_items`.

function mapInvoice(row) {
  const normalized = normalizeInvoiceRow(row);
  // Preserve the exact shape portalService and the portal UI expect, while
  // keeping the normalized line items. The shared layer already handles
  // empty-array fallback, legacy keys, quantity/unit_price/line_total
  // preservation, and customerId vs customer_id.
  const result = {
    id: normalized.id,
    invoice_number: normalized.invoice_number,
    customer_name: normalized.customer_name,
    total_amount: normalized.total_amount,
    paid_amount: normalized.paid_amount,
    status: normalized.status,
    due_date: normalized.due_date,
    created_at: normalized.created_at,
    currency: normalized.currency,
    subtotal: normalized.subtotal,
    other_charges: normalized.other_charges,
    notes: normalized.notes,
    document_title: normalized.document_title,
    line_items: normalized.line_items,
    items: normalized.items,
    paymentTerms: normalized.paymentTerms,
    payment_terms: normalized.payment_terms,
    _customerId: normalized._customerId,
  };
  // Also expose _customerId fallback for snake_case so auth does not falsely
  // reject backend-created invoices (customer_id).
  if (!result._customerId && normalized._raw) {
    const raw = normalized._raw;
    result._customerId = raw.customerId ?? raw.customer_id ?? null;
  }
  return result;
}

// Keep legacy helpers exported for backward compatibility (tests may import them)
// but they now delegate to the shared layer.
function mapInvoiceLineItems(items) {
  const { mapInvoiceLineItems: sharedMap } = require('./invoiceLineItemNormalization.cjs');
  return sharedMap(items);
}
function mapInvoiceLineItemsWithFallback(d) {
  const { normalizeInvoiceLineItems: sharedNorm } = require('./invoiceLineItemNormalization.cjs');
  return sharedNorm(d);
}

async function listInvoices(customerId) {
  if (!customerId) return [];
  return cached(`invoices:${customerId}`, async () => {
    // Handle both ERP frontend (customerId) and backend shim (customer_id) spellings.
    // The PostgREST `or` clause mirrors portalScope.customerFilter('invoices', …)
    // but is inlined here because this module uses raw axios, not repo.
    const rows = await request(
      'invoices',
      {
        select: 'id,data',
        or: `(data->>customerId.eq.${customerId},data->>customer_id.eq.${customerId})`,
        limit: 1000,
      },
      { timeout: 20000 }
    );
    if (!rows || rows.length === 0) return [];
    return rows
      .map((row) => mapInvoice(row))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  });
}

async function getInvoice(invoiceId, customerId) {
  if (!invoiceId) return null;
  const rows = await request('invoices', { select: 'id,data', id: 'eq.' + invoiceId, limit: 1 }, { timeout: 15000 });
  if (!rows || rows.length === 0) return null;
  const invoice = mapInvoice(rows[0]);
  if (customerId && invoice._customerId !== customerId) return null;
  delete invoice._customerId;
  return invoice;
}

// ─── Cloud health (for SQLite fallback decisions) ──────────────────────

async function cloudAvailable() {
  const items = await listCatalogItems();
  return Array.isArray(items) && items.length > 0;
}

module.exports = {
  isConfigured,
  listCatalogItems,
  getCustomer,
  listInvoices,
  getInvoice,
  listSales,
  cloudAvailable,
};
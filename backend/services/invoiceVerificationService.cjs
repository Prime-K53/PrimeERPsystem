/**
 * invoiceVerificationService.cjs — public invoice QR verification.
 *
 * READ-ONLY: verifies an invoice number + token against the authoritative
 * invoice record and returns a strictly allow-listed safe shape. Never
 * writes, never requires admin auth, never exposes internals.
 *
 * Data source: the same Supabase `invoices` table the ERP syncs to
 * (data-envelope rows), read with the service key like portalAuthService.
 */
const axios = require('axios');
const crypto = require('crypto');

const GENERIC_FAILURE = 'Invoice could not be verified against Prime Printing records.';

function getConfig() {
  return {
    base: String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, ''),
    key: process.env.SUPABASE_SECRET_KEY || '',
    company: String(process.env.COMPANY_NAME || 'Prime Printing Service'),
  };
}

function sanitizeInvoiceNumber(value) {
  const v = String(value || '').trim().slice(0, 64);
  // Invoice numbers never contain filter syntax; reject it outright (generic).
  if (!v || /[,()"]/.test(v)) return null;
  return v;
}

function timingSafeEqualHex(a, b) {
  try {
    const da = crypto.createHash('sha256').update(String(a || ''), 'utf8').digest();
    const db = crypto.createHash('sha256').update(String(b || ''), 'utf8').digest();
    return crypto.timingSafeEqual(da, db);
  } catch {
    return false;
  }
}

async function fetchInvoiceRows(invoiceNumber, httpGet) {
  const { base, key } = getConfig();
  if (!base || !key) {
    const err = new Error('verification store unavailable');
    err.code = 'STORE_UNAVAILABLE';
    throw err;
  }
  const get = httpGet || axios.get;
  const filter = `(data->>id.eq.${invoiceNumber},data->>invoiceNumber.eq.${invoiceNumber})`;
  const { data } = await get(`${base}/rest/v1/invoices`, {
    params: { select: '*', or: filter, limit: 5 },
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    timeout: 15000,
  });
  return Array.isArray(data) ? data : [];
}

/**
 * Canonical invoice status for verification — mirrors the ERP mapper rules
 * (paid-in-full > partial > explicit > unpaid; cancelled/void is VOID).
 */
function mapVerificationStatus(inv) {
  const s = String(inv.status || '').toLowerCase().trim();
  if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'VOID';
  const total = Number(inv.totalAmount ?? inv.total ?? 0);
  const paid = Number(inv.paidAmount ?? inv.amountPaid ?? 0);
  if (paid >= total && total > 0) return 'PAID';
  if (paid > 0) return 'PARTIALLY PAID';
  if (s === 'paid') return 'PAID';
  if (['partial', 'partially paid', 'partially_paid'].includes(s)) return 'PARTIALLY PAID';
  if (s === 'overdue') return 'OVERDUE';
  return 'UNPAID';
}

function toSafeResult(inv, company) {
  const total = Number(inv.totalAmount ?? inv.total ?? 0);
  const paid = Number(inv.paidAmount ?? inv.amountPaid ?? 0);
  const storedDue = inv.balanceDue ?? inv.dueBalance ?? inv.balance;
  return {
    verified: true,
    invoiceNumber: String(inv.id || inv.invoiceNumber || ''),
    invoiceDate: String(inv.date || ''),
    companyName: String(inv.companyName || company),
    customerName: String(inv.businessName || inv.business_name || inv.customerName || inv.customer_name || 'Customer'),
    currency: String(inv.currency || 'MWK'),
    subtotal: Number(inv.subtotal ?? total),
    tax: Number(inv.tax ?? 0),
    total,
    amountPaid: paid,
    balanceDue: storedDue !== undefined && storedDue !== null ? Number(storedDue) : total - paid,
    status: mapVerificationStatus(inv),
  };
}

/**
 * Verify an invoice. Returns { ok:true, data } or { ok:false } — the route
 * maps every failure to the same generic response (no enumeration oracle).
 */
async function verifyInvoice(invoiceNumber, token, deps) {
  const clean = sanitizeInvoiceNumber(invoiceNumber);
  const supplied = String(token || '').trim();
  if (!clean || !supplied) return { ok: false };
  const httpGet = deps && deps.httpGet;
  let rows;
  try {
    rows = await fetchInvoiceRows(clean, httpGet);
  } catch {
    return { ok: false };
  }
  const match = rows
    .map((r) => r.data || r)
    .find((d) => {
      const ids = [d.id, d.invoiceNumber].map((v) => String(v || ''));
      if (!ids.includes(clean)) return false;
      const stored = String(d.verificationToken || '');
      if (!stored) return false;
      return timingSafeEqualHex(supplied, stored);
    });
  if (!match) return { ok: false };
  return { ok: true, data: toSafeResult(match, getConfig().company) };
}

module.exports = {
  verifyInvoice,
  mapVerificationStatus,
  sanitizeInvoiceNumber,
  GENERIC_FAILURE,
};

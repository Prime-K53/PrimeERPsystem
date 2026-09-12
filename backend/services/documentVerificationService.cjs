/**
 * documentVerificationService.cjs — generic public document verification.
 *
 * ONE verification architecture for every supported official document.
 * The invoice implementation was refactored into this registry; invoices
 * behave exactly as before (same lookup, same VOID semantics, same
 * 12-field allow-list).
 *
 * Supported types (stable number + persistent record + existing PDF):
 *   invoice, receipt, quotation, sales_order, purchase_order, delivery_note
 *
 * Intentionally NOT supported: credit_note (status pseudo-type on invoice
 * rows, no own number/store/PDF), debit_note (no infrastructure),
 * supplier_payment (no status field), statement (generated on the fly, no
 * persistent record to bind a token to).
 *
 * READ-ONLY. Every failure maps to { ok:false } (generic 404 at the route).
 */
const axios = require('axios');
const crypto = require('crypto');

const GENERIC_FAILURE = 'Document could not be verified against Prime Printing records.';

function getConfig() {
  return {
    base: String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, ''),
    key: process.env.SUPABASE_SECRET_KEY || '',
    company: String(process.env.COMPANY_NAME || 'Prime Printing Service'),
  };
}

function sanitizeDocumentNumber(value) {
  const v = String(value || '').trim().slice(0, 64);
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

const upper = (v, fallback = '') => {
  const s = String(v ?? fallback).trim();
  return s ? s.toUpperCase() : fallback;
};

/** Canonical invoice statuses (mirrors the ERP invoice mapper rules). */
function mapInvoiceStatus(inv) {
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

/** Customer receipt statuses (live values: Cleared/Paid/Partial...). */
function mapReceiptStatus(pay) {
  const s = String(pay.status || '').toLowerCase().trim();
  if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'VOID';
  if (['paid', 'cleared', 'completed', 'cleared_payment'].includes(s)) return 'PAID';
  if (['partial', 'partially paid', 'partially_paid'].includes(s)) return 'PARTIALLY PAID';
  if (['overpaid', 'overpayment'].includes(s)) return 'OVERPAID';
  return upper(pay.status, 'PAID');
}

/** Pass-through canonical statuses for order-type documents. */
function mapCanonicalStatus(raw, cancelledWords, fallback) {
  const s = String(raw || '').trim();
  if (!s) return fallback;
  if (cancelledWords.includes(s.toLowerCase())) return 'CANCELLED';
  return upper(s[0]) + s.slice(1).toLowerCase() === s.toUpperCase()
    ? s.toUpperCase()
    : s;
}

function customerNameOf(d) {
  return String(d.businessName || d.business_name || d.customerName || d.customer_name || d.clientName || 'Customer');
}

// Registry: type -> { table, idFields, statusOf, toSafe }
const REGISTRY = {
  invoice: {
    table: 'invoices',
    idFields: ['id', 'invoiceNumber'],
    statusOf: mapInvoiceStatus,
    terminalInvalid: (status) => status === 'VOID',
    toSafe: (inv, company, status) => {
      const total = Number(inv.totalAmount ?? inv.total ?? 0);
      const paid = Number(inv.paidAmount ?? inv.amountPaid ?? 0);
      const storedDue = inv.balanceDue ?? inv.dueBalance ?? inv.balance;
      return {
        verified: true,
        documentType: 'invoice',
        invoiceNumber: String(inv.id || inv.invoiceNumber || ''),
        invoiceDate: String(inv.date || ''),
        companyName: String(inv.companyName || company),
        customerName: customerNameOf(inv),
        currency: String(inv.currency || 'MWK'),
        subtotal: Number(inv.subtotal ?? total),
        tax: Number(inv.tax ?? 0),
        total,
        amountPaid: paid,
        balanceDue: storedDue !== undefined && storedDue !== null ? Number(storedDue) : total - paid,
        status,
      };
    },
  },
  receipt: {
    table: 'customer_payments',
    idFields: ['id'],
    statusOf: mapReceiptStatus,
    terminalInvalid: () => false,
    toSafe: (pay, company, status) => ({
      verified: true,
      documentType: 'receipt',
      receiptNumber: String(pay.id || ''),
      receiptDate: String(pay.date || ''),
      companyName: String(pay.companyName || company),
      customerName: customerNameOf(pay),
      currency: String(pay.currency || 'MWK'),
      amount: Number(pay.amount ?? 0),
      paymentMethod: String(pay.paymentMethod || pay.method || ''),
      reference: String(pay.reference || pay.invoiceId || ''),
      status,
    }),
  },
  quotation: {
    table: 'quotations',
    idFields: ['id'],
    statusOf: (q) => {
      const s = String(q.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided', 'rejected'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return upper(s[0]) + s.slice(1);
    },
    terminalInvalid: () => false,
    toSafe: (q, company, status) => {
      const total = Number(q.totalAmount ?? q.total ?? 0);
      return {
        verified: true,
        documentType: 'quotation',
        quotationNumber: String(q.id || ''),
        quotationDate: String(q.date || ''),
        companyName: String(q.companyName || company),
        customerName: customerNameOf(q),
        currency: String(q.currency || 'MWK'),
        subtotal: Number(q.subtotal ?? total),
        tax: Number(q.tax ?? 0),
        total,
        validUntil: String(q.validUntil || q.dueDate || q.expiryDate || ''),
        status,
      };
    },
  },
  sales_order: {
    table: 'sales_orders',
    idFields: ['id', 'orderNumber'],
    statusOf: (o) => {
      const s = String(o.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return upper(s[0]) + s.slice(1);
    },
    terminalInvalid: () => false,
    toSafe: (o, company, status) => ({
      verified: true,
      documentType: 'sales_order',
      orderNumber: String(o.orderNumber || o.id || ''),
      orderDate: String(o.orderDate || o.date || ''),
      companyName: String(o.companyName || company),
      customerName: customerNameOf(o),
      currency: String(o.currency || 'MWK'),
      total: Number(o.total ?? o.totalAmount ?? 0),
      status,
    }),
  },
  purchase_order: {
    // Canonical purchaseOrders store has no Supabase table; the live
    // `purchases` table is the verifiable source (documented limitation).
    table: 'purchases',
    idFields: ['id', 'order_number', 'orderNumber'],
    statusOf: (o) => {
      const s = String(o.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return upper(s[0]) + s.slice(1);
    },
    terminalInvalid: () => false,
    toSafe: (o, company, status) => ({
      verified: true,
      documentType: 'purchase_order',
      purchaseOrderNumber: String(o.order_number || o.orderNumber || o.id || ''),
      orderDate: String(o.order_date || o.orderDate || o.date || ''),
      companyName: String(o.companyName || company),
      supplierName: String(o.supplierName || o.supplier_name || o.supplier_id || 'Supplier'),
      currency: String(o.currency || 'MWK'),
      total: Number(o.total_amount ?? o.total ?? o.totalAmount ?? 0),
      status,
    }),
  },
  delivery_note: {
    table: 'delivery_notes',
    idFields: ['id', 'dnNumber', 'number'],
    statusOf: (d) => {
      const s = String(d.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return upper(s[0]) + s.slice(1);
    },
    terminalInvalid: () => false,
    toSafe: (d, company, status) => ({
      verified: true,
      documentType: 'delivery_note',
      deliveryNoteNumber: String(d.dnNumber || d.number || d.id || ''),
      deliveryDate: String(d.date || ''),
      companyName: String(d.companyName || company),
      customerName: customerNameOf(d),
      reference: String(d.invoiceId || d.reference || ''),
      status,
    }),
  },
};

function supportedDocumentTypes() {
  return Object.keys(REGISTRY);
}

async function fetchDocumentRows(type, documentNumber, httpGet, axiosImpl) {
  const { base, key } = getConfig();
  if (!base || !key) {
    const err = new Error('verification store unavailable');
    err.code = 'STORE_UNAVAILABLE';
    throw err;
  }
  const get = httpGet || axiosImpl || axios;
  const entry = REGISTRY[type];
  const ors = entry.idFields.map((f) => `(data->>${f}.eq.${documentNumber})`);
  // Flat rows (sales_orders, delivery_notes) store fields at top level:
  // query both envelope and flat shapes in one round trip.
  const flatOrs = entry.idFields.map((f) => `${f}.eq.${documentNumber}`);
  const { data } = await get(`${base}/rest/v1/${entry.table}`, {
    params: { select: '*', or: `(${ors.join(',')})`, limit: 5 },
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    timeout: 15000,
  });
  let rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) {
    const flat = await get(`${base}/rest/v1/${entry.table}`, {
      params: { select: '*', or: `(${flatOrs.join(',')})`, limit: 5 },
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    rows = Array.isArray(flat.data) ? flat.data : [];
  }
  return rows;
}

function matchRow(type, documentNumber, rows, token) {
  const entry = REGISTRY[type];
  return rows
    .map((r) => r.data || r)
    .find((d) => {
      const hit = entry.idFields.some((f) => String(d[f] ?? '') === documentNumber);
      if (!hit) return false;
      const stored = String(d.verificationToken || '');
      if (!stored) return false;
      return timingSafeEqualHex(token, stored);
    });
}

/**
 * Generic verify. Returns { ok:true, data } or { ok:false } — the route maps
 * every failure to the same generic response (no enumeration oracle).
 * VOID/CANCELLED records verify as authentic with their terminal status.
 */
async function verifyDocument(documentType, documentNumber, token, deps) {
  if (!REGISTRY[documentType]) return { ok: false };
  const clean = sanitizeDocumentNumber(documentNumber);
  const supplied = String(token || '').trim();
  if (!clean || !supplied) return { ok: false };
  const httpGet = deps && deps.httpGet;
  let rows;
  try {
    rows = await fetchDocumentRows(documentType, clean, httpGet);
  } catch {
    return { ok: false };
  }
  const match = matchRow(documentType, clean, rows, supplied);
  if (!match) return { ok: false };
  const entry = REGISTRY[documentType];
  return { ok: true, data: entry.toSafe(match, getConfig().company, entry.statusOf(match)) };
}

module.exports = {
  verifyDocument,
  supportedDocumentTypes,
  mapInvoiceStatus,
  sanitizeDocumentNumber,
  GENERIC_FAILURE,
};

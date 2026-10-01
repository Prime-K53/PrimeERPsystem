/**
 * documentVerificationService.cjs — generic public document verification.
 *
 * ONE verification architecture for every supported official document.
 * The invoice implementation was refactored into this registry; invoices
 * behave exactly as before (same lookup, same VOID semantics, same
 * 12-field allow-list).
 *
 * Supported types (stable number + persistent record + existing PDF):
 *   invoice, receipt, quotation, sales_order, purchase_order, delivery_note,
 *   supplier_payment, statement, printing_contract
 *
 * printing_contract reads assessment_contracts (official number =
 * contract_number, PC- prefix; token persisted on the record envelope).
 * Cancelled contracts verify as authentic with terminal CANCELLED status.
 *
 * purchase_order reads the CANONICAL purchase_orders table first (the ERP
 * record created by procurementService, synced through dbService); the
 * legacy purchases table is a read fallback for documents issued before
 * the canonical sync mapping existed.
 *
 * supplier_payment reads supplier_payments (official payment record; the
 * ERP treats the record id as the official payment number). Only safe
 * display fields are exposed — never account numbers, GL ids or user ids.
 *
 * statement reads statement_snapshots (immutable snapshots). The token
 * identifies the exact snapshot/period — never live customer data, and the
 * full transaction history is never exposed publicly.
 *
 * Intentionally NOT supported: credit_note (status pseudo-type on invoice
 * rows, no own number/store/PDF), debit_note (no infrastructure).
 *
 * READ-ONLY. Every failure maps to { ok:false } (generic 404 at the route).
 */
const axios = require('axios');
const crypto = require('crypto');

const GENERIC_FAILURE = 'Document could not be verified against Prime Printing records.';

// ─── Temporary scoped diagnostics (EXM-P726/021 only, observational) ───────
// READ-ONLY: logs structural facts for one invoice; never alters lookup
// semantics, return values, or HTTP responses. Never logs token values,
// secrets, headers, or customer data — only booleans, lengths, key names,
// and one-way SHA-256 fingerprints.
const DIAG_DOC_TYPE = 'invoice';
const DIAG_DOC_NUMBER = 'EXM-P726/021';

function diagFingerprint(value) {
  try {
    return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
  } catch {
    return 'unavailable';
  }
}

function isDiagTarget(type, clean) {
  return type === DIAG_DOC_TYPE && clean === DIAG_DOC_NUMBER;
}

function diagLog(fields) {
  try {
    console.log('[VerifyDiag]', JSON.stringify({ target: DIAG_DOC_NUMBER, ...fields }));
  } catch {
    // Diagnostics must never break verification.
  }
}

function classifyDiagRowShape(r) {
  try {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'ROW_SHAPE_UNEXPECTED';
    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data) && r.data.data && typeof r.data.data === 'object') {
      return 'DOUBLE_WRAPPED_ENVELOPE';
    }
    if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) return 'CANONICAL_ENVELOPE';
    return 'FLAT_ROW';
  } catch {
    return 'ROW_SHAPE_UNEXPECTED';
  }
}

// ─── Temporary upstream-error diagnostics (EXM-P726/021 only) ─────────────
// Surfaces the Supabase/PostgREST rejection behind fetch failures. Logs only
// non-sensitive upstream fields (status, error code/message/hint/details,
// benign response headers, query path + filter structure). Never logs hosts
// with credentials, keys, auth headers, tokens, or customer data. The wrapped
// query is rethrown unchanged — lookup semantics are identical.
function diagSafeUpstream(err) {
  try {
    const resp = err && err.response ? err.response : null;
    const out = {
      upstreamStatus: resp && resp.status ? Number(resp.status) : null,
      upstreamCode: err && err.code ? String(err.code).slice(0, 80) : null,
      upstreamMessage: null,
      upstreamHint: null,
      upstreamDetails: null,
      upstreamHeaders: {},
    };
    const data = resp ? resp.data : null;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      if (data.code !== undefined) out.upstreamCode = String(data.code).slice(0, 80);
      if (data.message !== undefined) out.upstreamMessage = String(data.message).slice(0, 500);
      if (data.hint !== undefined) out.upstreamHint = String(data.hint).slice(0, 500);
      if (data.details !== undefined) out.upstreamDetails = String(data.details).slice(0, 500);
      if (out.upstreamMessage === null) out.upstreamMessage = JSON.stringify(data).slice(0, 500);
    } else if (data !== null && data !== undefined) {
      out.upstreamMessage = String(data).slice(0, 500);
    } else if (err && err.message) {
      out.upstreamMessage = String(err.message).slice(0, 200);
    }
    const headers = resp && resp.headers && typeof resp.headers === 'object' ? resp.headers : {};
    for (const k of ['content-type', 'content-length', 'date', 'server']) {
      if (headers[k] !== undefined) out.upstreamHeaders[k] = String(headers[k]).slice(0, 120);
    }
    return out;
  } catch {
    return { upstreamStatus: null, upstreamCode: null, upstreamMessage: 'unavailable', upstreamHint: null, upstreamDetails: null, upstreamHeaders: {} };
  }
}

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
    // order_number is the canonical official field (P726 unified numbers and
    // legacy backend officials live here); orderNumber is compatibility.
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
      documentType: 'sales_order',
      orderNumber: String(o.order_number || o.orderNumber || o.id || ''),
      orderDate: String(o.orderDate || o.date || ''),
      companyName: String(o.companyName || company),
      customerName: customerNameOf(o),
      currency: String(o.currency || 'MWK'),
      total: Number(o.total ?? o.totalAmount ?? 0),
      status,
    }),
  },
  purchase_order: {
    // Canonical first (purchase_orders), legacy purchases as fallback.
    tables: ['purchase_orders', 'purchases'],
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
  supplier_payment: {
    table: 'supplier_payments',
    idFields: ['id', 'paymentNumber', 'paymentId'],
    statusOf: (p) => {
      const s = String(p.status || '').toLowerCase().trim();
      if (['void', 'voided', 'cancelled', 'canceled'].includes(s)) return 'VOID';
      if (['paid', 'cleared', 'completed'].includes(s)) return 'PAID';
      if (['pending', 'processing'].includes(s)) return 'PENDING';
      if (!s) return 'PAID';
      return upper(s[0]) + s.slice(1);
    },
    terminalInvalid: (status) => status === 'VOID',
    toSafe: (p, company, status) => ({
      verified: true,
      documentType: 'supplier_payment',
      // Official payment number: explicit paymentNumber, else the payment
      // record id (which the ERP treats as the official payment number).
      paymentNumber: String(p.paymentNumber || p.paymentId || p.id || ''),
      paymentDate: String(p.paymentDate || p.date || ''),
      companyName: String(p.companyName || company),
      supplierName: String(p.supplierName || p.supplier_name || 'Supplier'),
      currency: String(p.currency || 'MWK'),
      amount: Number(p.amount ?? p.amountPaid ?? 0),
      // Safe display value only — never account numbers or GL references.
      paymentMethod: String(p.paymentMethod || p.method || ''),
      reference: String(p.reference || ''),
      status,
    }),
  },
  statement: {
    table: 'statement_snapshots',
    idFields: ['id', 'statementNumber'],
    statusOf: (s) => {
      const raw = String(s.status || 'VALID').toLowerCase().trim();
      if (['void', 'voided', 'cancelled', 'canceled'].includes(raw)) return 'VOID';
      if (raw === 'superseded') return 'SUPERSEDED';
      return 'VALID';
    },
    // VOID and SUPERSEDED snapshots verify as authentic but terminal: the
    // portal renders their dedicated states (never a green VERIFIED).
    terminalInvalid: (status) => status !== 'VALID',
    // Limited verification result: snapshot identity + frozen summary.
    // The transaction history and customer contact data are NEVER exposed.
    toSafe: (s, company, status) => ({
      verified: true,
      documentType: 'statement',
      statementNumber: String(s.statementNumber || s.id || ''),
      statementDate: String(s.statementDate || s.date || ''),
      statementPeriodStart: String(s.periodStart || s.startDate || ''),
      statementPeriodEnd: String(s.periodEnd || s.endDate || ''),
      companyName: String(s.companyName || company),
      customerName: String(s.customerName || s.clientName || 'Customer'),
      currency: String(s.currency || 'MWK'),
      openingBalance: Number(s.openingBalance ?? 0),
      totalInvoiced: Number(s.totalInvoiced ?? 0),
      totalReceived: Number(s.totalReceived ?? 0),
      closingBalance: Number(s.closingBalance ?? s.finalBalance ?? 0),
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
  printing_contract: {
    table: 'assessment_contracts',
    idFields: ['contract_number'],
    statusOf: (c) => {
      const s = String(c.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return s.toUpperCase();
    },
    terminalInvalid: (status) => status === 'CANCELLED',
    // Only safe display fields — never tokens, user ids or audit internals.
    toSafe: (c, company, status) => ({
      verified: true,
      documentType: 'printing_contract',
      contractNumber: String(c.contract_number || ''),
      contractDate: String(c.starts_at || c.created_at || ''),
      companyName: String(c.companyName || company),
      customerName: customerNameOf(c),
      currency: String(c.currency || 'MWK'),
      prepaidTotal: Number(c.prepaid_amount ?? 0),
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
  // Multi-table entries (purchase_order: canonical purchase_orders first,
  // legacy purchases as fallback) query each table in order and merge.
  const tables = entry.tables || [entry.table];
  // PostgREST `or` grammar: items are bare `field.op.value` separated by
  // commas inside ONE outer paren pair — `(a.eq.1,b.eq.2)`. Wrapping each
  // item in its own parens (`((a.eq.1),(b.eq.2))`) is a PGRST100 parse
  // error (HTTP 400), which used to fail EVERY lookup at that layer.
  // Values that contain special characters (e.g. `/` in INV-P726/023) must
  // be double-quoted so PostgREST treats them as string literals.
  const quoted = documentNumber.replace(/"/g, '""');
  const ors = entry.idFields.map((f) => `data->>${f}.eq."${quoted}"`);
  // Flat rows (sales_orders, delivery_notes) store fields at top level:
  // query both envelope and flat shapes in one round trip.
  const flatOrs = entry.idFields.map((f) => `${f}.eq."${quoted}"`);
  const rows = [];
  const diagFetch = type === DIAG_DOC_TYPE && documentNumber === DIAG_DOC_NUMBER;
  for (const table of tables) {
    const envelopeOr = `(${ors.join(',')})`;
    let data;
    try {
      ({ data } = await get(`${base}/rest/v1/${table}`, {
        params: { select: '*', or: envelopeOr, limit: 5 },
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        timeout: 15000,
      }));
    } catch (err) {
      if (diagFetch) {
        diagLog({
          stage: 'upstream-error',
          query: 'envelope',
          method: 'GET',
          path: `/rest/v1/${table}`,
          paramNames: ['select', 'or', 'limit'],
          orFilter: envelopeOr,
          ...diagSafeUpstream(err),
        });
      }
      throw err;
    }
    if (Array.isArray(data)) rows.push(...data);
    if (rows.length === 0) {
      const flatOr = `(${flatOrs.join(',')})`;
      try {
        const flat = await get(`${base}/rest/v1/${table}`, {
          params: { select: '*', or: flatOr, limit: 5 },
          headers: { apikey: key, Authorization: `Bearer ${key}` },
          timeout: 15000,
        });
        if (Array.isArray(flat.data)) rows.push(...flat.data);
      } catch (err) {
        if (diagFetch) {
          diagLog({
            stage: 'upstream-error',
            query: 'flat',
            method: 'GET',
            path: `/rest/v1/${table}`,
            paramNames: ['select', 'or', 'limit'],
            orFilter: flatOr,
            ...diagSafeUpstream(err),
          });
        }
        throw err;
      }
    }
    if (rows.length > 0 && tables.length > 1) break;
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
  if (!clean || !supplied) {
    if (String(documentType) === DIAG_DOC_TYPE && String(documentNumber || '').trim() === DIAG_DOC_NUMBER) {
      diagLog({ stage: 'reject-input', clean: clean || null, tokenSupplied: Boolean(supplied) });
    }
    return { ok: false };
  }
  const diag = isDiagTarget(documentType, clean);
  const httpGet = deps && deps.httpGet;
  if (diag) {
    const cfg = getConfig();
    diagLog({
      stage: 'start',
      documentType,
      sanitizedDocumentNumber: clean,
      tokenSupplied: true,
      tokenLength: supplied.length,
      tokenFingerprint: diagFingerprint(supplied),
      registryTable: (REGISTRY[documentType].tables || [REGISTRY[documentType].table]).join(','),
      idFields: REGISTRY[documentType].idFields,
      storeConfigured: Boolean(cfg.base && cfg.key),
    });
  }
  let rows;
  try {
    rows = await fetchDocumentRows(documentType, clean, httpGet);
  } catch (err) {
    if (diag) {
      diagLog({
        stage: 'store-error',
        category: 'STORE_ERROR',
        message: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
        code: err && err.code ? String(err.code).slice(0, 80) : null,
        status: err && err.response && err.response.status ? Number(err.response.status) : null,
      });
    }
    return { ok: false };
  }
  if (diag) {
    const list = Array.isArray(rows) ? rows : [];
    const detail = list.slice(0, 5).map((r) => {
      const shape = classifyDiagRowShape(r);
      const d = (r && typeof r === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? r.data : r;
      const dObj = d && typeof d === 'object' ? d : {};
      const idMatch = String(dObj.id ?? '') === clean;
      const numberMatch = String(dObj.invoiceNumber ?? '') === clean;
      const storedLen = String(dObj.verificationToken || '').length;
      return {
        shape,
        hasData: Boolean(r && typeof r === 'object' && r.data !== undefined),
        dataType: r && typeof r === 'object' && r.data !== undefined ? (Array.isArray(r.data) ? 'array' : typeof r.data) : 'absent',
        dataKeys: dObj && typeof dObj === 'object' ? Object.keys(dObj).slice(0, 25) : [],
        idMatch,
        invoiceNumberMatch: numberMatch,
        hasVerificationToken: storedLen > 0,
        verificationTokenLength: storedLen,
        tokenFingerprint: storedLen > 0 ? diagFingerprint(dObj.verificationToken) : null,
        tokenMatchesSupplied: storedLen > 0 ? timingSafeEqualHex(supplied, String(dObj.verificationToken || '')) : false,
      };
    });
    const anyId = detail.some((x) => x.idMatch);
    const anyNum = detail.some((x) => x.invoiceNumberMatch);
    const anyTok = detail.some((x) => x.hasVerificationToken);
    const doubleWrapped = detail.some((x) => x.shape === 'DOUBLE_WRAPPED_ENVELOPE');
    diagLog({
      stage: 'rows',
      rowCount: list.length,
      anyIdMatch: anyId,
      anyInvoiceNumberMatch: anyNum,
      anyVerificationTokenPresent: anyTok,
      anyDoubleWrappedEnvelope: doubleWrapped,
      rows: detail,
    });
  }
  const entry = REGISTRY[documentType];
  const match = matchRow(documentType, clean, rows, supplied);
  if (diag) {
    if (match) {
      diagLog({ stage: 'result', matched: true, category: 'MATCH' });
    } else {
      const list = Array.isArray(rows) ? rows : [];
      let category = 'OTHER';
      if (list.length === 0) {
        category = 'NO_ROWS';
      } else {
        const ds = list.map((r) => (r && typeof r === 'object' && r.data && typeof r.data === 'object' && !Array.isArray(r.data) ? r.data : r));
        const numHit = ds.some((d) => d && typeof d === 'object'
          && (String(d.id ?? '') === clean || String(d.invoiceNumber ?? '') === clean));
        if (!numHit) {
          const innerHit = list.some((r) => {
            const inner = r && typeof r === 'object' && r.data && typeof r.data === 'object' ? r.data.data : null;
            return inner && typeof inner === 'object'
              && (String(inner.id ?? '') === clean || String(inner.invoiceNumber ?? '') === clean);
          });
          category = innerHit ? 'ROW_SHAPE_UNEXPECTED' : 'NUMBER_NOT_FOUND';
        } else {
          const withTok = ds.some((d) => d && typeof d === 'object' && String(d.verificationToken || ''));
          category = withTok ? 'TOKEN_MISMATCH' : 'TOKEN_MISSING';
        }
      }
      diagLog({ stage: 'result', matched: false, category });
    }
  }
  if (!match) return { ok: false };
  return { ok: true, data: entry.toSafe(match, getConfig().company, entry.statusOf(match)) };
}

/**
 * Returns the raw matched database row for a document type/number/token
 * combination. Used by the public download endpoint to feed the
 * authoritative renderer — the raw record (not the safe shape) is
 * required because the renderer needs the full authoritative data.
 * Returns null on any failure (same generic 404 semantics as verifyDocument).
 */
async function getDocumentRecord(documentType, documentNumber, token, deps) {
  if (!REGISTRY[documentType]) return null;
  const clean = sanitizeDocumentNumber(documentNumber);
  const supplied = String(token || '').trim();
  if (!clean || !supplied) return null;
  const httpGet = deps && deps.httpGet;
  let rows;
  try {
    rows = await fetchDocumentRows(documentType, clean, httpGet);
  } catch {
    return null;
  }
  const entry = REGISTRY[documentType];
  const match = matchRow(documentType, clean, rows, supplied);
  if (!match) return null;
  return match;
}

module.exports = {
  verifyDocument,
  getDocumentRecord,
  supportedDocumentTypes,
  mapInvoiceStatus,
  sanitizeDocumentNumber,
  GENERIC_FAILURE,
};

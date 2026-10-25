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
 *   supplier_payment, statement, printing_contract, printing_contract_schedule
 *
 * printing_contract reads assessment_contracts (official number =
 * contract_number, PC- prefix; token persisted on the record envelope).
 * Cancelled contracts verify as authentic with terminal CANCELLED status.
 *
 * printing_contract_schedule reads contract_documents — one immutable row per
 * ISSUED VERSION, each with its own token/hash/status — so a schedule verifies
 * as the exact version its QR was printed from. A legacy contract-token QR
 * (printed before per-version documents) falls back to assessment_contracts and
 * is reported with verificationScope 'contract': the contract is affirmed, the
 * version is not claimed. SUPERSEDED and VOID versions verify as authentic but
 * terminal, never as current.
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
const integrity = require('./documentIntegrity.cjs');
const customerDisplay = require('./customerDisplay.cjs');

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

/**
 * Completion progress for a printing contract.
 *
 * Completed means a genuinely consumed assessment. Reserved (not yet
 * completed), cancelled, released/reversed, voided, pending and soft-deleted
 * rows do not count. Rows are de-duplicated by their canonical item id so a
 * duplicate delivery cannot inflate the count. The contractual total is
 * `max_assessments`; a zero/missing total is valid and resolves to 0 / 0.
 *
 * The count is derived from assessment_contract_items (the authoritative
 * assessment records), never from prepaid/consumed monetary amounts, payment
 * status, invoice counts or receipt counts.
 */
async function assessmentProgress(contract, httpGet) {
  const total = Math.max(0, Math.floor(Number(contract.max_assessments) || 0));
  const contractId = String(contract.id || '').trim();
  if (!contractId) return null;

  const { base, key } = getConfig();
  if (!base || !key) return null;

  const get = httpGet || axios;
  let rows;
  try {
    const { data } = await get(`${base}/rest/v1/assessment_contract_items`, {
      params: {
        select: 'id,data',
        'data->>contract_id': `eq.${contractId}`,
        limit: 1000,
      },
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      timeout: 15000,
    });
    if (!Array.isArray(data)) return null;
    rows = data;
  } catch {
    // Verification must still work if the progress roll-up is unavailable.
    // The public view omits the progress rows rather than inventing a count.
    return null;
  }

  const seen = new Set();
  let consumed = 0;
  for (const row of rows) {
    const item = (row && row.data) || row || {};
    if (String(item.contract_id || '') !== contractId) continue;
    if (item.deleted === true || item.deleted === 'true' || item.deleted_at || item.deletedAt) continue;
    const itemId = String((row && row.id) || item.id || '');
    if (itemId) {
      if (seen.has(itemId)) continue;
      seen.add(itemId);
    }
    if (String(item.status || '').trim().toLowerCase() === 'consumed') consumed += 1;
  }

  const completed = total === 0 ? 0 : Math.min(consumed, total);
  return {
    totalAssessments: total,
    completedToDate: completed,
    remainingAssessments: Math.max(0, total - completed),
  };
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

/**
 * Safe display name for a document's customer. A placeholder stored in a name
 * field (`_`, `—`, a bare `CUST-…` key) is a MISSING reference — candidates are
 * skipped so a real name behind them is found, and the customer id is never
 * echoed. `'Customer'` is the last-resort generic label.
 */
function customerNameOf(d) {
  const record = d && typeof d === 'object' ? d : {};
  return customerDisplay.resolveCustomerNameForDocument(record.businessName, record.business_name)
    || customerDisplay.resolveCustomerNameForDocument(record.companyName, record.company_name)
    || customerDisplay.resolveCustomerNameForDocument(record.customerName, record.customer_name)
    || customerDisplay.resolveCustomerNameForDocument(record.clientName, record.client_name)
    || 'Customer';
}

/** Contract-party resolver: customer/business name with the school falling back in. */
function contractCustomerNameOf(c) {
  return customerDisplay.resolveContractPartyName(c) || 'Customer';
}

/**
 * True for an immutable per-version `contract_documents` envelope (as opposed
 * to a legacy parent-contract row). The documentType is stamped by the issue
 * service and is the only reliable discriminator between the two tables this
 * one registry entry reads.
 */
function isScheduleVersionRow(d) {
  return String((d && d.documentType) || '') === 'printing_contract_schedule';
}

/**
 * A completion receipt is a VERSION row of its own: an immutable
 * `contract_documents` row with its own number, token, hash and frozen
 * content. A row that is not one is the legacy contract-level shape.
 */
function isReceiptVersionRow(d) {
  return String((d && d.documentType) || '') === 'printing_contract_completion_receipt';
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
      customerName: customerDisplay.resolveCustomerNameForDocument(s.customerName, s.clientName) || 'Customer',
      currency: String(s.currency || 'MWK'),
      openingBalance: Number(s.openingBalance ?? 0),
      totalInvoiced: Number(s.totalInvoiced ?? 0),
      totalReceived: Number(s.totalReceived ?? 0),
      closingBalance: Number(s.closingBalance ?? s.finalBalance ?? 0),
      // Account scope. Verification must never present a BRANCH statement as
      // the customer's Main statement. A snapshot with no branch field predates
      // account scope; it is displayed as Main but flagged as untagged so the
      // verifier knows the account was not recorded.
      //
      // `branchKey` encodes the stable branch identity (`main` / `id:<branchId>`
      // / `name:<slug>`), so the raw `subAccountId` field is deliberately NOT
      // duplicated here: it would collide with the verification allow-list's
      // `accountid` guard for no added information.
      branchKey: s.branchKey ? String(s.branchKey) : null,
      branchLabel: s.branchLabel ? String(s.branchLabel) : null,
      scopeAmbiguous: Boolean(s.scopeAmbiguous) || !s.branchKey,
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
      customerName: contractCustomerNameOf(c),
      currency: String(c.currency || 'MWK'),
      prepaidTotal: Number(c.prepaid_amount ?? 0),
      totalAssessments: Number(c.max_assessments ?? 0),
      status,
    }),
  },
  // A contract schedule verifies as ITS OWN ISSUED VERSION, not as the parent
  // contract. Every issue is an immutable row in `contract_documents` carrying
  // its own number/version/token/hash/status, so the token alone identifies the
  // exact version the QR was printed from.
  //
  // `assessment_contracts` is queried as a LEGACY fallback and never as a
  // version match: schedules printed before per-version documents existed
  // encoded the CONTRACT's token. Those resolve honestly as
  // `verificationScope: 'contract'` — the contract is affirmed, the specific
  // version is not claimed.
  printing_contract_schedule: {
    tables: ['contract_documents', 'assessment_contracts'],
    // Query every table and merge: a clear-on-first-hit lookup would 404 a
    // legacy contract-token QR as soon as the contract owned any version row.
    allTables: true,
    idFields: ['documentNumber', 'contract_number'],
    // The status of a schedule is the VERSION's own lifecycle state
    // (VALID / SUPERSEDED / VOID) — never the contract's lifecycle. A
    // superseded or voided version must never present as a current document.
    statusOf: (d) => {
      if (!isScheduleVersionRow(d)) {
        const s = String(d.status || '').toLowerCase().trim();
        if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'VOID';
        if (!s) return 'DRAFT';
        return s.toUpperCase();
      }
      const raw = String(d.status || '').toLowerCase().trim();
      if (raw === 'superseded') return 'SUPERSEDED';
      if (['void', 'voided', 'cancelled', 'canceled'].includes(raw)) return 'VOID';
      if (raw === 'valid') return 'VALID';
      return upper(raw[0], '');
    },
    // Authentic but no longer current. Verification still succeeds so the
    // distinction between "issued and intact" and "still the current version"
    // survives — the status itself is what disqualifies it.
    terminalInvalid: (status) => status !== 'VALID',
    toSafe: (d, company, status) => {
      if (!isScheduleVersionRow(d)) {
        const contractStatus = (() => {
          const s = String(d.status || '').toLowerCase().trim();
          if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'VOID';
          return upper(s, 'DRAFT');
        })();
        return {
          verified: true,
          documentType: 'printing_contract_schedule',
          verificationScope: 'contract',
          contractNumber: String(d.contract_number || ''),
          companyName: String(d.companyName || company),
          customerName: contractCustomerNameOf(d),
          status: contractStatus,
        };
      }
      const content = d.content || {};
      return {
        verified: true,
        documentType: 'printing_contract_schedule',
        verificationScope: 'version',
        // The issued version's OWN identity. It is deliberately NOT printed on
        // the document (the printout carries the QR only, like every other
        // Prime ERP document): the customer scans the QR and reads the id,
        // version, issue date and status here.
        documentId: String(d.id || ''),
        contractNumber: String(d.documentNumber || ''),
        scheduleVersion: Number(d.documentVersion || 0),
        issuedAt: String(d.issuedAt || ''),
        companyName: String(d.companyName || company),
        customerName: customerDisplay.resolveCustomerNameForDocument(content.customerName, content.schoolName) || 'Customer',
        currency: String(content.currency || 'MWK'),
        periodStart: String(content.periodStart || ''),
        periodEnd: String(content.periodEnd || ''),
        // Content integrity is SEPARATE from status: the frozen bytes still
        // hash to the digest stored at issue. `status` (below) says whether the
        // version is still current; this says whether it is unaltered.
        // The digest of the frozen content, so the customer can compare it with
        // the "Content hash" printed on the schedule itself.
        contentHash: String(d.contentHash || ''),
        integrity: 'sha256-verified',
        // Deliberately NOT exposing fund amounts or per-assessment detail to
        // an unauthenticated caller: the schedule summary is enough to confirm
        // identity/current-ness, and the QR holder already has the paper.
        status,
      };
    },
    // The download renders the FROZEN ISSUED CONTENT. A legacy contract-level
    // match yields null (fail closed): the exact printed version cannot be
    // reproduced from a live contract row, so it is not served at all.
    //
    // Content integrity is enforced here (server-side): a version whose frozen
    // content no longer matches its stored digest is NOT served, so a tampered
    // row cannot be rendered as authentic. The matched row's OWN token is
    // overlaid onto the render payload (never persisted, never mutating the
    // frozen content) so a historical download re-embeds the version token it
    // was issued with, not the parent contract token.
    recordOf: (match) => {
      if (!isScheduleVersionRow(match)) return null;
      const content = match.content || null;
      if (!content) return null;
      if (!integrity.verifyScheduleRow(match).ok) return null;
      const token = String(match.verificationToken || '').trim();
      return token ? { ...content, verificationToken: token } : content;
    },
  },
  // A completion receipt verifies as ITS OWN issued receipt, not as the
  // parent contract. Every issue is an immutable row in `contract_documents`
  // carrying its own number, token, hash and frozen content, so the token
  // identifies the exact receipt the QR was printed from.
  //
  // The legacy shape (a receipt printed before per-version documents existed)
  // encoded the CONTRACT's number and token: it resolves honestly as
  // `verificationScope: 'contract'` — the contract is affirmed, the receipt is
  // not claimed.
  printing_contract_completion_receipt: {
    tables: ['contract_documents', 'assessment_contracts'],
    allTables: true,
    // The receipt's own number (`PCR-<contract>`) and, for the legacy shape,
    // the contract number it was printed against.
    idFields: ['documentNumber', 'receiptNumber', 'contract_number'],
    // A legacy receipt print encoded the CONTRACT number and the contract's
    // token: it must still resolve (as contract scope), while the receipt's
    // own version row resolves under its own number.
    numberVariants: (n) => [String(n).replace(/^PCR-/i, '')],
    statusOf: (d) => {
      if (isReceiptVersionRow(d)) {
        const raw = String(d.status || '').toLowerCase().trim();
        if (raw === 'superseded') return 'SUPERSEDED';
        if (['void', 'voided', 'cancelled', 'canceled'].includes(raw)) return 'VOID';
        if (raw === 'valid') return 'VALID';
        return upper(raw[0], '');
      }
      const s = String(d.status || '').toLowerCase().trim();
      if (['cancelled', 'canceled', 'void', 'voided'].includes(s)) return 'CANCELLED';
      if (!s) return 'DRAFT';
      return s.toUpperCase();
    },
    // A superseded or voided receipt is still AUTHENTIC (it was issued and is
    // intact); the status says it is no longer the current one.
    terminalInvalid: () => false,
    toSafe: async (d, company, status, deps) => {
      if (!isReceiptVersionRow(d)) {
        // Legacy print: the parent contract is affirmed, no receipt version is
        // claimed. Completion progress comes from the assessment records, never
        // from prepaid/consumed monetary amounts, so the prepaid total is
        // deliberately absent from this safe shape.
        const progress = await assessmentProgress(d, deps && deps.httpGet);
        return {
          verified: true,
          documentType: 'printing_contract_completion_receipt',
          verificationScope: 'contract',
          receiptNumber: `PCR-${String(d.contract_number || '')}`,
          contractNumber: String(d.contract_number || ''),
          contractDate: String(d.starts_at || d.created_at || ''),
          companyName: String(d.companyName || company),
          customerName: contractCustomerNameOf(d),
          currency: String(d.currency || 'MWK'),
          totalAssessments: Number(d.max_assessments ?? 0),
          ...(progress || {}),
          status,
        };
      }
      const content = d.content || {};
      return {
        verified: true,
        documentType: 'printing_contract_completion_receipt',
        verificationScope: 'version',
        // The receipt's own identity — never printed on the receipt, read
        // here after the QR is scanned.
        documentId: String(d.id || ''),
        receiptNumber: String(d.documentNumber || content.receiptNumber || ''),
        contractNumber: String(content.contractNumber || ''),
        issuedAt: String(d.issuedAt || content.date || ''),
        companyName: String(d.companyName || company),
        customerName: customerDisplay.resolveCustomerNameForDocument(content.customerName, content.schoolName)
          || contractCustomerNameOf(d),
        schoolName: customerDisplay.resolveSchoolNameForDocument(content.schoolName) || '',
        currency: String(content.currency || 'MWK'),
        // What the receipt actually says: the assessment it closed, what was
        // debited, and the fund position it left behind.
        assessmentName: (() => {
          const item = (content.item && typeof content.item === 'object') ? content.item : {};
          return [item.assessmentName, item.grade, item.subject]
            .map((part) => String(part || '').trim())
            .filter(Boolean)
            .join(' - ');
        })(),
        amountDebited: Number(content.amountDebited ?? 0),
        completedToDate: Number(content.completedToDate ?? 0),
        totalConsumedToDate: Number(content.totalConsumedToDate ?? 0),
        totalAssessments: Number(content.totalAssessments ?? 0),
        remainingAssessments: Number(content.remainingAssessments ?? 0),
        remainingReservedFunds: Number(content.remainingReservedFunds ?? 0),
        unallocatedFunds: Number(content.unallocatedFunds ?? 0),
        contractValue: Number(content.contractValue ?? 0),
        walletBalanceAfter: Number(content.walletBalanceAfter ?? 0),
        // The digest of the frozen receipt, so the customer can compare it
        // with the one printed on the receipt.
        contentHash: String(d.contentHash || content.contentHash || ''),
        integrity: 'sha256-verified',
        status,
      };
    },
    // The download renders the FROZEN ISSUED RECEIPT. A version row is served
    // from its own content after the stored digest is re-verified, so a
    // tampered row can never be rendered as authentic.
    //
    // LEGACY PAPER RECEIPTS encoded the CONTRACT's number and token (the
    // per-version token was allocated after the receipt builder ran). The QR
    // therefore cannot say WHICH receipt of the contract it was printed from;
    // it is only served when that contract has exactly ONE non-void issued
    // receipt — then the receipt number identifies it unambiguously. With more
    // than one, the request fails closed rather than serving the wrong paper.
    recordOf: (match, rows) => {
      if (isReceiptVersionRow(match)) {
        const content = match.content || null;
        if (!content || !integrity.verifyReceiptRow(match).ok) return null;
        return content;
      }
      const contractNumber = String(match.contract_number || '').trim();
      const supplied = String(match.verificationToken || '');
      if (!contractNumber || !supplied) return null;
      const receiptNumber = `PCR-${contractNumber}`;
      const candidates = (rows || [])
        .map((r) => r.data || r)
        .filter((r) => isReceiptVersionRow(r)
          && String(r.documentNumber || '') === receiptNumber
          && String((r.content || {}).verificationToken || '') === supplied
          && String(r.status || '').toUpperCase() !== 'VOID'
          && integrity.verifyReceiptRow(r).ok);
      return candidates.length === 1 ? candidates[0].content : null;
    },
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
  // Envelope-only: every authoritative verification table is envelope-shaped
  // `(id PK, data JSONB, ...)` — see supabase/migrations/0001. There are no
  // top-level `invoiceNumber`/`order_number`/etc. columns, so a flat-column
  // fallback queries nonexistent columns (Postgres 42703, e.g. EXM-P726/021)
  // and masks the real lookup result. `data->>` filters never 42703.
  const quoted = documentNumber.replace(/"/g, '""');
  // A type may be reachable under more than one number form (a completion
  // receipt's own number `PCR-<contract>` AND the contract number a legacy
  // print encoded). Every form is queried, and every form is accepted when
  // the token matches.
  const variants = numberVariants(entry, documentNumber);
  const ors = [];
  for (const variant of variants) {
    const safe = variant.replace(/"/g, '""');
    for (const f of entry.idFields) ors.push(`data->>${f}.eq."${safe}"`);
  }
  const rows = [];
  const missingTables = [];
  for (const table of tables) {
    let data;
    try {
      ({ data } = await get(`${base}/rest/v1/${table}`, {
        params: { select: '*', or: `(${ors.join(',')})`, limit: 5 },
        headers: { apikey: key, Authorization: `Bearer ${key}` },
        timeout: 15000,
      }));
    } catch (err) {
      // A table that does not exist in this environment must not take down the
      // whole lookup: the caller may still verify the same document through the
      // other configured table (e.g. a legacy contract-token schedule when
      // `contract_documents` is not deployed). Permanent schema absence is
      // recorded so the failure stays internally distinguishable from an
      // invalid token or a nonexistent document.
      const body = err && err.response ? err.response.data : undefined;
      const code = body && typeof body === 'object' ? String(body.code || '') : '';
      // Only a PostgREST "not in schema cache" (or Postgres undefined_table)
      // counts as a MISSING table. A bare 404 from a misconfigured base URL is
      // a store failure, not a schema condition, and must not be advertised as
      // "apply a migration".
      const missing = code === 'PGRST205'
        || code === '42P01'
        || /could not find the table|schema cache|relation .* does not exist/i.test(String((err && err.message) || ''));
      if (missing) { missingTables.push(table); continue; }
      throw err;
    }
    if (Array.isArray(data)) rows.push(...data);
    // Multi-table entries normally stop at the first table that answers. An
    // entry with `allTables` (schedule: version rows first, legacy contract
    // rows second) merges every table instead, so a legacy contract-token QR
    // still resolves once the contract also owns version rows.
    if (rows.length > 0 && tables.length > 1 && !entry.allTables) break;
  }
  // Every configured table is absent: this is a schema/deployment condition,
  // not "no such document". Surface it distinctly (never publicly).
  if (missingTables.length === tables.length) {
    const err = new Error(`verification table(s) missing: ${missingTables.join(', ')}`);
    err.code = 'TABLE_MISSING';
    err.tables = missingTables;
    throw err;
  }
  return rows;
}

/**
 * The number forms a document may be looked up under. The first is the number
 * as supplied; a type may declare extra forms (the completion receipt's
 * legacy print encoded the CONTRACT number, `PC-...`, under the receipt
 * number `PCR-PC-...`).
 */
function numberVariants(entry, documentNumber) {
  const base = String(documentNumber || '').trim();
  const extra = entry && typeof entry.numberVariants === 'function'
    ? entry.numberVariants(base)
    : [];
  const all = [base, ...(Array.isArray(extra) ? extra : [extra])]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  return Array.from(new Set(all));
}

function matchRow(type, documentNumber, rows, token) {
  const entry = REGISTRY[type];
  const variants = numberVariants(entry, documentNumber);
  return rows
    .map((r) => r.data || r)
    .find((d) => {
      const hit = entry.idFields.some((f) => variants.some((v) => String(d[f] ?? '') === v));
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
  const entry = REGISTRY[documentType];
  const clean = entry.normalize
    ? entry.normalize(sanitizeDocumentNumber(documentNumber))
    : sanitizeDocumentNumber(documentNumber);
  const supplied = String(token || '').trim();
  if (!clean || !supplied) return { ok: false };
  const httpGet = deps && deps.httpGet;
  let rows;
  try {
    rows = await fetchDocumentRows(documentType, clean, httpGet);
  } catch (e) {
    // Internal diagnostic only — the public route collapses every failure into
    // the same generic response (no enumeration oracle, no schema disclosure).
    const reason = e && e.code === 'TABLE_MISSING' ? 'table_missing'
      : e && e.code === 'STORE_UNAVAILABLE' ? 'store_unavailable'
      : 'store_error';
    return { ok: false, reason };
  }
  const match = matchRow(documentType, clean, rows, supplied);
  if (!match) return { ok: false, reason: clarityReason(rows) };
  // The schedule and the receipt are the two entries with their own frozen
  // content hash. Verify the EXACT persisted version's integrity before
  // reporting a successful result: a tampered or mismatched row fails closed
  // rather than verifying as issued.
  if (documentType === 'printing_contract_schedule' && isScheduleVersionRow(match)) {
    const check = integrity.verifyScheduleRow(match);
    if (!check.ok) return { ok: false, reason: `integrity_${check.reason}` };
  }
  if (documentType === 'printing_contract_completion_receipt' && isReceiptVersionRow(match)) {
    const check = integrity.verifyReceiptRow(match);
    if (!check.ok) return { ok: false, reason: `integrity_${check.reason}` };
  }
  return { ok: true, data: await entry.toSafe(match, getConfig().company, entry.statusOf(match), deps) };
}

/** Distinguishes "nothing matched" from "the store answered with no rows". */
function clarityReason(rows) {
  return Array.isArray(rows) && rows.length > 0 ? 'token_mismatch' : 'no_match';
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
  const entry = REGISTRY[documentType];
  const clean = entry.normalize
    ? entry.normalize(sanitizeDocumentNumber(documentNumber))
    : sanitizeDocumentNumber(documentNumber);
  const supplied = String(token || '').trim();
  if (!clean || !supplied) return null;
  const httpGet = deps && deps.httpGet;
  let rows;
  try {
    rows = await fetchDocumentRows(documentType, clean, httpGet);
  } catch {
    return null;
  }
  const match = matchRow(documentType, clean, rows, supplied);
  if (!match) return null;
  // Most entries hand the raw record to the renderer. An entry may instead
  // declare `recordOf` to select the renderable payload — the schedule returns
  // its FROZEN ISSUED CONTENT, and returns null (fail closed) for a legacy
  // contract-level match, because a live contract row cannot reproduce the
  // exact version that was printed.
  if (typeof entry.recordOf === 'function') return entry.recordOf(match, rows, clean);
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

/**
 * Official Document Service (portal-facing)
 *
 * Bridges authenticated portal requests to THE authoritative ERP document
 * renderer. The renderer bundle (officialDocument/primeRenderer.cjs) is built
 * from the ERP frontend's own PrimeDocument pipeline — there is exactly ONE
 * document generator in the system; this service only feeds it authoritative
 * ERP records and streams the resulting application/pdf bytes.
 *
 * Security contract enforced by CALLERS (routes/portal.cjs):
 *   - customer identity comes from the portal JWT
 *   - the record is fetched through the existing customer-scoped getters,
 *     so an id belonging to another customer resolves to NOT_FOUND
 */

const path = require('path');
const repo = require('./supabaseRepository.cjs');

const portalPdfPostProcess = require('./portalPdfPostProcess.cjs');

let rendererPromise = null;

function loadRenderer() {
  if (!rendererPromise) {
    const bundlePath = path.resolve(__dirname, 'officialDocument', 'primeRenderer.cjs');
    rendererPromise = Promise.resolve()
      .then(() => require(bundlePath))
      .then((mod) => {
        const fn = mod.renderOfficialDocumentPdf || mod.default;
        if (typeof fn !== 'function') throw new Error('renderer entrypoint missing');
        console.log('[OfficialDocumentService] Official document renderer: READY');
        console.log(`[OfficialDocumentService] Renderer bundle: ${bundlePath}`);
        return fn;
      })
      .catch((err) => {
        rendererPromise = null; // allow retry after a build/deploy fix
        console.error(`[OfficialDocumentService] Failed to load renderer bundle (${bundlePath}): ${err.stack || err.message}`);
        const error = new Error(`Official document renderer unavailable: ${err.message}`);
        error.code = 'RENDERER_UNAVAILABLE';
        throw error;
      });
  }
  return rendererPromise;
}

async function isRendererAvailable() {
  try { await loadRenderer(); return true; } catch { return false; }
}

/**
 * Company configuration for branding/terms. Read from the cloud settings
 * table when present; otherwise null — the canonical mapper falls back to the
 * same safe placeholders the staff UI uses on a fresh install.
 */
async function getCompanyConfig() {
  let config = null;
  try {
    const rows = await repo.getAll('settings', { 'data->>key': 'eq.companyConfig' });
    let row = (rows || [])[0];
    if (!row) {
      const allSettings = await repo.getAll('settings');
      row = (allSettings || []).find(
        (s) => s.key === 'companyConfig' || s.key === 'nexus_company_config' || s.id === 'companyConfig'
      );
    }
    if (row) {
      const val = row.value ?? row.val ?? row.data?.value ?? row;
      config = typeof val === 'string' ? JSON.parse(val) : val;
    }
  } catch (_) { /* branding is best-effort */ }

  const defaultConfig = {
    companyName: 'Prime Printing Service',
    companyAddress: 'Along M5 Road Mtakataka',
    companyPhone: '+265 992 526 222',
    companyEmail: 'info@primeprinting.mw',
    currencySymbol: 'K',
    invoiceTemplates: {
      engine: 'Classic',
      accentColor: '#3b82f6',
      companyNameFontSize: 18,
      bodyFontSize: 12,
      fontFamily: 'Helvetica',
      logoWidth: 140,
      showCompanyLogo: true,
      showPaymentTerms: true,
      showDueDate: true,
      showOutstandingAndWalletBalances: true,
      showAccountSummary: true,
    },
  };

  if (!config) return defaultConfig;
  return {
    ...defaultConfig,
    ...config,
    companyName: config.companyName || config.name || defaultConfig.companyName,
    companyAddress: config.companyAddress || config.address || defaultConfig.companyAddress,
    companyPhone: config.companyPhone || config.phone || defaultConfig.companyPhone,
    companyEmail: config.companyEmail || config.email || defaultConfig.companyEmail,
    invoiceTemplates: {
      ...defaultConfig.invoiceTemplates,
      ...(config.invoiceTemplates || {}),
      showOutstandingAndWalletBalances: config.invoiceTemplates?.showOutstandingAndWalletBalances !== false,
      showAccountSummary: config.invoiceTemplates?.showAccountSummary !== false,
    },
  };
}

/**
 * Normalize a stored/mapped ERP record into the shape the canonical document
 * mapper expects (same as what the ERP finance layer feeds its renderer):
 * items[] as an array of {description, quantity, price, total, …} regardless
 * of whether the source spelled them line_items/items_json/name-vs-desc.
 */
function normalizeRecordForRenderer(raw) {
  const record = { ...(raw || {}) };
  
  const invoiceDate = record.invoiceDate || record.invoice_number_date || record.invoice_date || record.date || record.orderDate || record.order_date || record.created_at || record.issued_at || record.issuedAt;
  if (invoiceDate) {
    record.date = invoiceDate;
    record.invoiceDate = invoiceDate;
  }
  
  const dueDate = record.dueDate || record.due_date || record.due_at || record.validUntil || record.expiryDate;
  if (dueDate) {
    record.dueDate = dueDate;
    record.due_date = dueDate;
  }

  let items = Array.isArray(record.items) ? record.items : null;
  if (!items) {
    for (const key of ['line_items', 'lineItems', 'items_json']) {
      const value = record[key];
      if (Array.isArray(value)) { items = value; break; }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value);
          if (Array.isArray(parsed)) { items = parsed; break; }
        } catch (_) { /* not JSON — skip */ }
      }
    }
  }
  if (!items) items = [];
  record.items = items.map((it) => {
    const description = String(
      it?.desc || it?.description || it?.name || it?.productName || it?.product_name || it?.item_description || it?.itemDescription || 'Item'
    );
    const quantity = Number(it?.quantity ?? it?.qty ?? 0) || 0;
    const price = Number(it?.price ?? it?.unitPrice ?? it?.unit_price ?? 0) || 0;
    return {
      ...it,
      desc: description,
      description,
      name: it?.name || description,
      productName: it?.productName || description,
      quantity,
      qty: quantity,
      price,
      unitPrice: price,
      total: Number(it?.total ?? it?.lineTotal ?? it?.line_total ?? quantity * price) || 0,
    };
  });
  return record;
}

/**
 * Render the OFFICIAL pdf for a record already proven to belong to the
 * requesting customer.
 *
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function renderOfficialPdf({ type, rawData, customers = [], source = 'erp' }) {
  const render = await loadRenderer();
  const companyConfig = await getCompanyConfig();
  let buffer = await render({
    type,
    rawData: normalizeRecordForRenderer(rawData),
    companyConfig,
    customers,
    source,
  });

  if (source === 'portal') {
    buffer = await portalPdfPostProcess.applyPortalPermissions(buffer, {
      companyName: companyConfig?.companyName,
    });
  }

  return { buffer, contentType: 'application/pdf' };
}

/** RFC 6266-ish filename for Content-Disposition (ASCII-safe). */
function buildContentDisposition(filename) {
  const safe = String(filename || 'document.pdf')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'document.pdf';
  if (!/\.pdf$/i.test(safe)) return `attachment; filename="${safe}.pdf"`;
  return `attachment; filename="${safe}"`;
}

module.exports = {
  loadRenderer,
  isRendererAvailable,
  getCompanyConfig,
  renderOfficialPdf,
  buildContentDisposition,
};

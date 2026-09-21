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
const fs = require('fs');
const { getCompanyConfig } = require('./companyConfigService.cjs');

let rendererPromise = null;

/**
 * Font path resolver for the server-side renderer bundle.
 *
 * The renderer (primeRenderer.cjs) was built for browser use and registers
 * fonts with web-relative paths like "/fonts/comic.ttf". When @react-pdf/renderer
 * runs in Node.js it calls fs.promises.readFile() on that string, which on Windows
 * resolves to "D:\fonts\comic.ttf" — a path that doesn't exist.
 *
 * This patches fs.promises.readFile (once) so any access to an absolute path
 * ending in /fonts/<name>.ttf|.otf is transparently redirected to the
 * frontend/public/fonts/ directory where the files actually live.
 *
 * The patch is idempotent and only touches font file reads.
 */
const FONT_DIR = path.resolve(__dirname, '..', '..', 'frontend', 'public', 'fonts');
let _fontPathsPatched = false;

function ensureFontPaths() {
  if (_fontPathsPatched) return;
  _fontPathsPatched = true;

  const origReadFile = fs.promises.readFile;
  fs.promises.readFile = function (filename, ...args) {
    if (
      typeof filename === 'string' &&
      /[/\\]fonts[/\\][^/\\]+\.(ttf|otf)$/i.test(filename) &&
      !filename.startsWith(FONT_DIR)
    ) {
      const fontName = path.basename(filename);
      const resolved = path.join(FONT_DIR, fontName);
      console.log(
        `[OfficialDocumentService] Font path redirect: "${filename}" → "${resolved}"`
      );
      filename = resolved;
    }
    return origReadFile.call(this, filename, ...args);
  };

  console.log(`[OfficialDocumentService] Font path resolver active (FONT_DIR: ${FONT_DIR})`);
}

/**
 * Server-side renderer environment propagation (public verification URLs).
 *
 * The renderer bundle (officialDocument/primeRenderer.cjs) is built with
 * `import.meta.env` mapped to `globalThis.__PRIME_DOC_VITE_ENV__`, so the
 * canonical verification URL builder inside the bundle reads the Portal
 * origin from that global. This populates it from the server runtime
 * environment BEFORE the bundle is required (the bundle banner only
 * installs defaults while the global is still undefined).
 *
 * Canonical variable: VITE_PUBLIC_PORTAL_URL — the same name the browser
 * build uses; backend/.env or the platform environment provides it. When
 * it is absent the global simply carries no Portal origin and the bundled
 * builder keeps its production fail-closed behavior (legacy QR payload,
 * never an ERP-origin fallback). No verification logic is touched here.
 */
function ensureRendererEnv() {
  const fromEnv = String(process.env.VITE_PUBLIC_PORTAL_URL || '').trim();
  const existing = globalThis.__PRIME_DOC_VITE_ENV__;
  if (existing && typeof existing === 'object') {
    if (fromEnv) existing.VITE_PUBLIC_PORTAL_URL = fromEnv;
    return existing;
  }
  globalThis.__PRIME_DOC_VITE_ENV__ = {
    DEV: false,
    PROD: true,
    MODE: 'production',
    ...(fromEnv ? { VITE_PUBLIC_PORTAL_URL: fromEnv } : {}),
  };
  return globalThis.__PRIME_DOC_VITE_ENV__;
}

function loadRenderer() {
  if (!rendererPromise) {
    ensureFontPaths();   // must be before require() so fs.promises.readFile is patched
    ensureRendererEnv();
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
 * Helper to resolve the authoritative line item description from an ERP line item object.
 * Checks historical line description first, then item/product master names, ignoring empty/whitespace strings.
 */
function resolveItemDescription(it) {
  if (!it) return 'Item';
  const candidates = [
    it.description,
    it.desc,
    it.item_description,
    it.itemDescription,
    it.item_name,
    it.itemName,
    it.name,
    it.productName,
    it.product_name,
    it.title,
    it.label,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return 'Item';
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

  const paymentTerms = record.paymentTerms || record.payment_terms || record.terms;
  if (paymentTerms) {
    record.paymentTerms = paymentTerms;
    record.payment_terms = paymentTerms;
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
    const description = resolveItemDescription(it);
    const quantity = Number(it?.quantity ?? it?.qty ?? 0) || 0;
    const price = Number(it?.price ?? it?.unitPrice ?? it?.unit_price ?? it?.selling_price ?? 0) || 0;
    const total = Number(it?.total ?? it?.lineTotal ?? it?.line_total ?? it?.subtotal ?? it?.totalAmount ?? (quantity * price)) || 0;
    return {
      ...it,
      desc: description,
      description,
      name: it?.name || description,
      productName: it?.productName || description,
      item_name: it?.item_name || description,
      quantity,
      qty: quantity,
      price,
      unitPrice: price,
      total,
    };
  });
  return record;
}

/**
 * OfficialDocumentChannel — the ONLY thing that changes between an ERP copy
 * and a Portal copy is the native PORTAL COPY watermark inside the PDF.
 *
 *   - 'erp'    → clean official document (no watermark)
 *   - 'portal' → the SAME authoritative document rendered with PORTAL COPY
 *                drawn into the PDF by the renderer itself (no byte
 *                post-processing anywhere in this pipeline).
 *
 * The channel is established by the CALLER (routes/portal.cjs) server-side;
 * it is never derived from browser-supplied input. 'source' is accepted as a
 * legacy alias so older callers keep working during the migration.
 *
 * Security: for channel === 'portal' the watermark is part of the rendered
 * PDF. If rendering fails, this throws — the Portal receives an error, never
 * a silently clean/unwatermarked PDF.
 */
async function renderOfficialPdf({ type, rawData, customers = [], channel, source } = {}) {
  const effectiveChannel = channel || (source === 'portal' ? 'portal' : 'erp');
  const render = await loadRenderer();
  const companyConfig = await getCompanyConfig();
  const buffer = await render({
    type,
    rawData: normalizeRecordForRenderer(rawData),
    companyConfig,
    customers,
    channel: effectiveChannel,
  });

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
  ensureRendererEnv,
  isRendererAvailable,
  getCompanyConfig,
  normalizeRecordForRenderer,
  renderOfficialPdf,
  buildContentDisposition,
};

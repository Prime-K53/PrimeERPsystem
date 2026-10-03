'use strict';

/**
 * salesOrderNumbering.cjs — ONE authoritative minter for unified official
 * Sales Order numbers, for ANY configured document series.
 *
 * The series (e.g. P726 today, P727 tomorrow) is a user-configurable
 * preference read from the company numbering settings
 * (`transactionSettings.numbering`, shared/global rule first). It is NEVER
 * hard-coded here: every pattern, counter identity and RPC call is
 * parameterized by the resolved series.
 *
 * Business rule — ONE official numbering family: ORD.
 * Every Sales Order, regardless of creation source, receives
 *   ORD-{series}/NNN
 * `creation_source` (DIRECT_ERP / PORTAL_CONVERSION / INVOICE_DERIVED, with
 * request/quotation linkage as a backwards-compatible fallback) is
 * provenance/audit metadata only and MUST NOT affect the number. There is
 * no SO prefix and no TMP identifier in Sales Order numbering.
 * ONE numeric sequence PER SERIES (migration 0027: one counter row per
 * series; different series never interfere). No separate SO/ORD counters.
 * Historical official ORD numbers are never renumbered; historical SO
 * shapes remain parseable for reading history only and are never minted
 * or adopted for new rows.
 *
 * Atomicity: numbers are claimed with the single-statement-per-series
 * Postgres function `claim_next_sales_order_number(series)` (row lock +
 * advisory lock for first-use initialization). Never SELECT MAX()+1, never
 * an in-memory counter, never IndexedDB/localStorage, and never the legacy
 * orderNumber unique index (which guards the compatibility field, not the
 * canonical one).
 *
 * Canonical field: `data.order_number` is authoritative for official numbers;
 * `data.orderNumber` is legacy/provisional compatibility only.
 *
 * Portal requests (QTR-YYYY/SO-YYYY request_number) NEVER consume this
 * sequence — only ERP conversion/completion and direct-ERP sync creates do.
 *
 * Historical recognition vs current allocation: parsing/reading functions
 * accept an optional series; OMITTED means any series (so historical numbers
 * stay readable after a series change). Allocation ALWAYS resolves the
 * current configured series explicitly.
 */

const axios = require('axios');

const cloudHttp = typeof axios.create === 'function'
  ? axios.create({ validateStatus: (status) => status >= 200 && status < 300 })
  : axios;

function cloudConfig() {
  const base = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY || '';
  return { base, key, configured: Boolean(base && key && !base.includes('placeholder') && !key.includes('placeholder')) };
}

/**
 * Official unified shape. ORD-{series}/NNN is the ONLY allocated family.
 * The SO- alternative is recognized here for reading historical numbers
 * only (migration 0027 seeds, legacy rows) — it is never minted or adopted.
 */
const SALES_ORDER_OFFICIAL_PATTERN = /^(SO|ORD)-([A-Za-z0-9]+)\/(\d+)$/i;
/** The only prefix ever allocated for Sales Orders. */
const OFFICIAL_PREFIX = 'ORD';
/** Legacy backend official numbers (kept, never minted anymore). */
const LEGACY_ORD_YEAR_PATTERN = /^ORD-\d{4}-\d{6}$/;

const ORIGIN_DIRECT = 'DIRECT_ERP';
const ORIGIN_CONVERSION = 'QUOTATION_REQUEST';
/** Canonical portal origin per business rules (SO sequence). Legacy alias: QUOTATION_REQUEST. */
const ORIGIN_PORTAL = 'PORTAL_CONVERSION';
/** Invoice-derived origin (direct-invoice Order → Invoice chain). Uses the ORD sequence. */
const ORIGIN_INVOICE = 'INVOICE_DERIVED';

const CREATION_SOURCES = Object.freeze([ORIGIN_DIRECT, ORIGIN_PORTAL, ORIGIN_INVOICE]);

/**
 * Pure: normalize an explicit persisted creation source to its canonical
 * value. Accepts the spec values DIRECT_ERP / PORTAL_CONVERSION /
 * INVOICE_DERIVED plus the legacy QUOTATION_REQUEST portal alias (and
 * common casings). Returns null when missing/invalid — callers must NOT
 * treat null as portal/SO.
 */
function normalizeCreationSource(value) {
  const text = String(value || '').trim().toUpperCase();
  if (!text) return null;
  if (text === ORIGIN_DIRECT) return ORIGIN_DIRECT;
  if (text === ORIGIN_PORTAL) return ORIGIN_PORTAL;
  if (text === ORIGIN_INVOICE) return ORIGIN_INVOICE;
  if (text === ORIGIN_CONVERSION) return ORIGIN_PORTAL;
  return null;
}

/**
 * Pure: read the explicit persisted creation source from a domain record.
 * Supports snake_case (Supabase data envelope) and camelCase (IndexedDB /
 * frontend) spellings. Returns the canonical source or null.
 */
function readCreationSource(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  const raw =
    d.creation_source != null ? d.creation_source
    : d.creationSource != null ? d.creationSource
    : d.origin != null ? d.origin
    : null;
  return normalizeCreationSource(raw);
}

/**
 * Pure: decide provenance origin from the explicit persisted creation
 * source first, with request/quotation linkage as a backwards-compatible
 * fallback (never from number prefixes). Provenance only — every origin
 * resolves to the ORD numbering family.
 *
 *   creation_source DIRECT_ERP      → DIRECT_ERP
 *   creation_source PORTAL_CONVERSION (+ legacy QUOTATION_REQUEST) → PORTAL
 *   creation_source INVOICE_DERIVED → INVOICE_DERIVED
 *   no explicit source + linkage   → QUOTATION_REQUEST (portal fallback)
 *   no explicit source, no linkage → DIRECT_ERP (safe fallback)
 */
function determineSalesOrderOrigin(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  const explicit = readCreationSource(d);
  if (explicit === ORIGIN_DIRECT) return ORIGIN_DIRECT;
  if (explicit === ORIGIN_PORTAL) return ORIGIN_PORTAL;
  if (explicit === ORIGIN_INVOICE) return ORIGIN_INVOICE;
  const linked =
    String(d.source_request_id || d.sourceRequestId || '').trim() ||
    String(d.source_request_number || d.sourceRequestNumber || '').trim() ||
    String(d.quotation_id || d.quotationId || '').trim();
  return linked ? ORIGIN_CONVERSION : ORIGIN_DIRECT;
}

/**
 * Prefix for a Sales Order origin. Single-family model: ALWAYS 'ORD',
 * regardless of origin. The parameter is retained so existing callers and
 * the shared format helper keep working unchanged; creation source is
 * provenance only and never affects numbering.
 */
function prefixForOrigin(origin) {
  void origin;
  return OFFICIAL_PREFIX;
}

/**
 * Pure: parse an official Sales Order number into structured parts.
 * Returns { kind:'sales_order', origin:'DIRECT'|'CONVERSION', series, sequence }
 * or null when the value is not an official unified shape.
 * NOTE: origin here is INFERRED from the prefix and is valid ONLY for
 * reading/parsing historical numbers. Creation/provenance decisions must
 * always use persisted provenance fields (determineSalesOrderOrigin), never
 * this inference.
 */
function parseOfficialSalesOrderNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(SALES_ORDER_OFFICIAL_PATTERN);
  if (!match) return null;
  return {
    kind: 'sales_order',
    origin: match[1].toUpperCase() === 'SO' ? 'CONVERSION' : 'DIRECT',
    series: String(match[2]).toUpperCase(),
    sequence: Number(match[3]),
  };
}

/**
 * Pure: is this an official unified number? With `series` given, the value
 * must belong to THAT series (allocation-time check); omitted means any
 * series (historical read path — never gate history on the current series).
 */
function isOfficialSalesOrderNumber(value, series) {
  const parsed = parseOfficialSalesOrderNumber(value);
  if (!parsed) return false;
  if (series == null) return true;
  return parsed.series === String(series).trim().toUpperCase();
}

/**
 * Pure: is a client-supplied number adoptable as an official Sales Order
 * number? Single-family model: only ORD-{series}/NNN unifies official
 * numbers are adoptable. SO-/TMP-shaped candidates are never adopted for
 * new rows (a fresh ORD is minted instead); historical rows keep their
 * stored numbers through the existing-row preservation path, never here.
 * The domain parameter is retained for caller compatibility.
 */
function prefixMatchesOrigin(candidate, domain) {
  void domain;
  const parsed = parseOfficialSalesOrderNumber(candidate);
  if (!parsed) return false;
  return parsed.origin === 'DIRECT';
}

/**
 * Pure: resolve the branch series the same way the frontend does —
 * shared/global numbering rule first, then any rule carrying an extension.
 * Returns null when unconfigured (caller must fail closed, never invent one).
 */
function resolveSalesOrderSeries(companyConfig) {
  const numbering =
    (companyConfig && companyConfig.transactionSettings && companyConfig.transactionSettings.numbering) || {};
  const keys = Object.keys(numbering || {});
  const sharedFirst = [
    ...keys.filter((k) => /^(shared|global)$/i.test(String(k))),
    ...keys.filter((k) => !/^(shared|global)$/i.test(String(k))),
  ];
  for (const key of sharedFirst) {
    const ext = String((numbering[key] || {}).extension || '').trim();
    if (ext) return ext;
  }
  return null;
}

/**
 * Pure: resolve series padding from the shared/global rule, mirroring the
 * frontend default (DEFAULT_PADDING). Observed rows use the configured
 * deployment padding; callers pass the company config through.
 */
function resolveSeriesPadding(companyConfig, fallback = 4) {
  const numbering =
    (companyConfig && companyConfig.transactionSettings && companyConfig.transactionSettings.numbering) || {};
  for (const key of Object.keys(numbering || {})) {
    if (!/^(shared|global)$/i.test(String(key))) continue;
    const padding = Number((numbering[key] || {}).padding);
    if (Number.isInteger(padding) && padding > 0) return padding;
  }
  const parsed = Number(fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 4;
}

function formatOfficialSalesOrderNumber(origin, series, sequence, padding = 4) {
  const prefix = prefixForOrigin(origin);
  const width = Number.isInteger(Number(padding)) && Number(padding) > 0 ? Number(padding) : 4;
  const padded = String(Math.max(0, Math.floor(Number(sequence) || 0))).padStart(width, '0');
  return `${prefix}-${String(series).trim()}/${padded}`;
}

function isLegacyOfficialNumber(value) {
  return LEGACY_ORD_YEAR_PATTERN.test(String(value || '').trim());
}

/**
 * Pure: does this payload still need an official number? There is no
 * provisional-number concept: anything without an official ORD unified
 * number (any series) or a legacy ORD official number in `order_number`
 * needs minting. SO-/TMP-shaped values are never official and always
 * need a fresh ORD mint.
 */
function needsOfficialNumber(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  const current = String(d.order_number || '').trim();
  if (!current) return true;
  const parsed = parseOfficialSalesOrderNumber(current);
  if (parsed && parsed.origin === 'DIRECT') return false;
  if (isLegacyOfficialNumber(current)) return false;
  return true;
}

/**
 * Atomic claim of the next sequence integer FOR ONE SERIES.
 * Single RPC round-trip; the row lock (plus advisory lock on first use)
 * serializes same-series claimants, while different series never block each
 * other. Throws on transport/cloud failure — callers decide fail-open
 * (gateway) vs fail-closed (admin conversion).
 */
async function claimNextSeriesSequence(series, deps) {
  const clean = String(series || '').trim();
  if (!clean || !/^[A-Za-z0-9]+$/.test(clean)) {
    const err = new Error('Sales order series is missing or invalid');
    err.code = 'SERIES_INVALID';
    throw err;
  }
  const httpPost = (deps && deps.httpPost) || null;
  // Injected transports (tests, alternate runtimes) bypass the environment
  // gate — they carry their own endpoint. The default live path requires it.
  if (!httpPost) {
    const { configured } = cloudConfig();
    if (!configured) {
      const err = new Error('Sales order sequence store unavailable (Supabase not configured)');
      err.code = 'SEQUENCE_UNAVAILABLE';
      throw err;
    }
  }
  const { base, key } = cloudConfig();
  const post = httpPost
    || ((url, body, headers) => cloudHttp.post(url, body, { headers, timeout: 15000 }));
  const res = await post(`${base}/rest/v1/rpc/claim_next_sales_order_number`, { p_series: clean }, {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  });
  const value = Array.isArray(res.data) ? res.data[0] : res.data;
  const seq = Number(value);
  if (!Number.isInteger(seq) || seq <= 0) {
    const err = new Error('Sales order sequence claim returned an invalid value');
    err.code = 'SEQUENCE_INVALID';
    throw err;
  }
  return seq;
}

/**
 * Check whether an official number is already taken (either number field or
 * row id — legacy rows use their number as their id). Used only to validate
 * a client-supplied official number before adopting it; the counter itself
 * never needs this check. `excludeId` exempts one row id (the row being
 * written) so legitimate replays are not mistaken for collisions.
 */
async function isOfficialNumberTaken(number, deps) {
  const get = (deps && deps.httpGet) || null;
  const excludeId = deps && deps.excludeId != null ? String(deps.excludeId) : null;
  if (!get) {
    const { configured } = cloudConfig();
    if (!configured) return false;
  }
  const { base, key } = cloudConfig();
  const quoted = String(number).replace(/"/g, '""');
  const params = {
    select: 'id',
    or: `(data->>order_number.eq."${quoted}",data->>orderNumber.eq."${quoted}",id.eq."${quoted}")`,
    limit: 1,
  };
  const run = get
    || ((url, options) => cloudHttp.get(url, options));
  const res = await run(`${base}/rest/v1/sales_orders`, {
    params,
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    timeout: 15000,
  });
  if (!Array.isArray(res.data) || res.data.length === 0) return false;
  if (excludeId && res.data.every((row) => String(row && row.id) === excludeId)) return false;
  return true;
}

/**
 * Pure: is this axios-style failure a unique-constraint violation
 * (PostgREST 409 + Postgres 23505)? Used to bound retries when a kept
 * client-supplied number loses a race it should never have entered.
 */
function isUniqueViolation(err) {
  const status = err && err.response ? err.response.status : err && err.status;
  if (Number(status) !== 409) return false;
  const data = (err && err.response && err.response.data) || {};
  const code = String(data.code || err.code || '');
  const message = String(data.message || data.details || err.message || '');
  return code === '23505' || /duplicate key|unique constraint|already exists/i.test(message);
}

/**
 * Full mint for one official order in the CURRENT configured series:
 * resolve series → claim (that series' counter) → format ORD.
 * Origin (`originOverride` or the explicit creation_source with linkage
 * fallback) is provenance only and never affects the prefix: every mint
 * produces ORD-{series}/NNN. `seriesOverride` pins the series (tests,
 * tooling); otherwise the company config decides.
 */
async function mintOfficialSalesOrderNumber(domain, deps) {
  const getConfig = (deps && deps.getCompanyConfig) || null;
  let companyConfig = null;
  if (getConfig) {
    companyConfig = await getConfig();
  } else {
    try {
      const companyConfigService = require('./companyConfigService.cjs');
      companyConfig = await companyConfigService.getCompanyConfig();
    } catch {
      companyConfig = null;
    }
  }
  const series = (deps && deps.seriesOverride) || resolveSalesOrderSeries(companyConfig);
  if (!series) {
    const err = new Error('Sales order series is not configured (company numbering settings)');
    err.code = 'SERIES_UNCONFIGURED';
    throw err;
  }
  const padding = resolveSeriesPadding(companyConfig);
  const origin = (deps && deps.originOverride) || determineSalesOrderOrigin(domain);
  const seq = await claimNextSeriesSequence(series, deps);
  return formatOfficialSalesOrderNumber(origin, series, seq, padding);
}

module.exports = {
  SALES_ORDER_OFFICIAL_PATTERN,
  LEGACY_ORD_YEAR_PATTERN,
  ORIGIN_DIRECT,
  ORIGIN_CONVERSION,
  ORIGIN_PORTAL,
  ORIGIN_INVOICE,
  CREATION_SOURCES,
  normalizeCreationSource,
  readCreationSource,
  determineSalesOrderOrigin,
  prefixForOrigin,
  parseOfficialSalesOrderNumber,
  prefixMatchesOrigin,
  isOfficialSalesOrderNumber,
  resolveSalesOrderSeries,
  resolveSeriesPadding,
  formatOfficialSalesOrderNumber,
  isLegacyOfficialNumber,
  isUniqueViolation,
  needsOfficialNumber,
  claimNextSeriesSequence,
  isOfficialNumberTaken,
  mintOfficialSalesOrderNumber,
};

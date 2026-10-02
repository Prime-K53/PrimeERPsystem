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
 * Business rule (never infer origin from a prefix — origin comes from
 * the explicit persisted `creation_source`, with request/quotation linkage
 * as a backwards-compatible fallback):
 *   DIRECT_ERP origin (explicit creation_source, or no linkage)
 *     → ORD-{series}/NNN
 *   PORTAL_CONVERSION origin (explicit creation_source; legacy alias
 *     QUOTATION_REQUEST, or source_request_id/number or quotation_id set)
 *     → SO-{series}/NNN
 *   INVOICE_DERIVED origin (explicit creation_source for direct-invoice
 *     orders that preserve the Order → Invoice chain)
 *     → ORD-{series}/NNN (ERP family sequence, never portal SO)
 * Both prefixes consume ONE numeric sequence PER SERIES (migration 0027:
 * one counter row per series; different series never interfere).
 * Missing/invalid sources never default to portal/SO — the safe fallback
 * is DIRECT_ERP/ORD.
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

/** Official unified shape: SO-{series}/NNN (conversion) or ORD-{series}/NNN (direct). */
const SALES_ORDER_OFFICIAL_PATTERN = /^(SO|ORD)-([A-Za-z0-9]+)\/(\d+)$/i;
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
 * Pure: decide origin from the explicit persisted creation source first,
 * with request/quotation linkage as a backwards-compatible fallback
 * (never from number prefixes).
 *
 *   creation_source DIRECT_ERP      → DIRECT_ERP (ORD)
 *   creation_source PORTAL_CONVERSION (+ legacy QUOTATION_REQUEST) → PORTAL (SO)
 *   creation_source INVOICE_DERIVED → INVOICE_DERIVED (ORD, ERP family)
 *   no explicit source + linkage   → QUOTATION_REQUEST (SO, legacy path)
 *   no explicit source, no linkage → DIRECT_ERP (ORD, safe fallback)
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

function prefixForOrigin(origin) {
  const normalized = normalizeCreationSource(origin) || origin;
  if (normalized === ORIGIN_PORTAL || normalized === ORIGIN_CONVERSION) return 'SO';
  // DIRECT_ERP, INVOICE_DERIVED and any unknown/safe fallback use ORD.
  return 'ORD';
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
 * Pure: does a candidate official number's prefix agree with the domain's
 * persisted origin? Guards adoption of client-supplied numbers (a direct-ERP
 * or invoice-derived row must never keep an SO- number, and a portal row
 * must never keep an ORD- number). Series-agnostic: only the origin prefix
 * is compared, never any particular series value.
 */
function prefixMatchesOrigin(candidate, domain) {
  const parsed = parseOfficialSalesOrderNumber(candidate);
  if (!parsed) return false;
  const expectedPrefix = prefixForOrigin(determineSalesOrderOrigin(domain));
  const candidatePrefix = parsed.origin === 'CONVERSION' ? 'SO' : 'ORD';
  return candidatePrefix === expectedPrefix;
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
 * Pure: is this payload still provisional (must be officially numbered)?
 * Explicit flag wins; otherwise anything that is not already an official
 * unified number (any series) and not a legacy official number needs minting.
 */
function needsOfficialNumber(domain) {
  const d = domain && typeof domain === 'object' ? domain : {};
  if (d.orderNumberProvisional === true) return true;
  const current = String(d.order_number || '').trim();
  if (!current) return true;
  if (isOfficialSalesOrderNumber(current)) return false;
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
 * resolve series → claim (that series' counter) → format.
 * `originOverride` forces a prefix (portal conversion callers pass
 * ORIGIN_PORTAL/ORIGIN_CONVERSION explicitly for SO); otherwise origin is
 * derived from the explicit creation_source with linkage fallback.
 * `seriesOverride` pins the series (tests, tooling); otherwise the company
 * config decides.
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

'use strict';

/**
 * examinationInvoiceNumbering.cjs — ONE authoritative minter for Examination
 * Invoice identities (EXM-{series}/NNN).
 *
 * Mirrors `salesOrderNumbering.cjs` (migration 0027) exactly in shape:
 * series-keyed atomic counter → format → return the authoritative identity.
 * It is deliberately NOT a second numbering system: same pattern, same
 * service-role-only RPC claim, same series resolution, same failure codes.
 *
 * WHY EXM cannot use the sales-order "mint after local save" flow:
 *   For a Sales Order the stable primary key is a ULID and the official
 *   number is a separate display field (`data.order_number`), so the server
 *   can stamp/rename it after the local save and the client adopts it.
 *   An Examination Invoice is different: `Invoice.id` IS the official number
 *   AND is the ledger `referenceId` (transactionService posts
 *   `referenceId: invoice.id`). Once AR is posted the identity can never be
 *   rewritten without corrupting the ledger. Therefore the authoritative
 *   identity MUST be claimed BEFORE the invoice — and therefore before the
 *   ledger row — is written. That is the only ordering that makes
 *   "different batch -> different invoice identity -> different ledger
 *   referenceId" enforceable.
 *
 * Business rule enforced here: a NEW examination invoice identity is never
 * finalized from a device-local scan. The cloud counter is authoritative;
 * history in `invoices` AND `ledger_entries` always wins over the counter row,
 * so an identity the ledger already uses can never be issued again.
 *
 * Single-company: no tenancy / organization / company scoping is introduced.
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

/** Official EXM shape: EXM-{series}/NNN. The only family ever allocated. */
const EXAMINATION_INVOICE_PATTERN = /^EXM-([A-Za-z0-9]+)\/(\d+)$/i;
/** The only prefix ever allocated for Examination Invoices. */
const OFFICIAL_PREFIX = 'EXM';

/**
 * Pure: is this an official Examination Invoice number? With `series` given the
 * value must belong to THAT series (allocation-time check); omitted means any
 * series (historical read path only).
 */
function isExaminationInvoiceNumber(value, series) {
  const text = String(value || '').trim();
  const match = text.match(EXAMINATION_INVOICE_PATTERN);
  if (!match) return false;
  if (series == null) return true;
  return match[1].toUpperCase() === String(series).trim().toUpperCase();
}

/**
 * Pure: parse into structured parts. Returns { series, sequence } or null.
 */
function parseExaminationInvoiceNumber(value) {
  const text = String(value || '').trim();
  const match = text.match(EXAMINATION_INVOICE_PATTERN);
  if (!match) return null;
  return { series: String(match[1]).toUpperCase(), sequence: Number(match[2]) };
}

/**
 * Pure: resolve the branch series the same way the frontend and the Sales Order
 * minter do — shared/global numbering rule first, then any rule carrying an
 * extension. Returns null when unconfigured (caller must fail closed, never
 * invent a series).
 */
function resolveExaminationSeries(companyConfig) {
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
 * frontend. Observed deployment rows use `EXM-P726/022` (padding 3).
 */
function resolveSeriesPadding(companyConfig, fallback = 3) {
  const numbering =
    (companyConfig && companyConfig.transactionSettings && companyConfig.transactionSettings.numbering) || {};
  for (const key of Object.keys(numbering || {})) {
    if (!/^(shared|global)$/i.test(String(key))) continue;
    const padding = Number((numbering[key] || {}).padding);
    if (Number.isInteger(padding) && padding > 0) return padding;
  }
  const parsed = Number(fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

/**
 * Byte-identical to the frontend `formatConfiguredDocumentNumber` for the EXM
 * rule: `${prefix}${prefixSeparator}${extension}/${padded}${suffix}`.
 * `buildPrefixSeparator` in utils/numbering.ts yields '' when the prefix
 * already ends with - / / or whitespace, otherwise '-'.
 */
function buildPrefixSeparator(prefix) {
  if (!prefix) return '';
  return /[-/\s]$/.test(prefix) ? '' : '-';
}

function formatExaminationInvoiceNumber(series, sequence, padding = 3, suffix = '') {
  const width = Number.isInteger(Number(padding)) && Number(padding) > 0 ? Number(padding) : 3;
  const padded = String(Math.max(0, Math.floor(Number(sequence) || 0))).padStart(width, '0');
  const extensionPart = `${String(series).trim()}/`;
  return `${OFFICIAL_PREFIX}${buildPrefixSeparator(OFFICIAL_PREFIX)}${extensionPart}${padded}${String(suffix || '')}`;
}

/**
 * Atomic claim of the next sequence integer FOR ONE SERIES.
 * Single RPC round-trip; the advisory lock serializes same-series claimants
 * while different series never block each other. Throws on transport/cloud
 * failure — callers must fail CLOSED (a new identity is never fabricated).
 */
async function claimNextSeriesSequence(series, deps) {
  const clean = String(series || '').trim();
  if (!clean || !/^[A-Za-z0-9]+$/.test(clean)) {
    const err = new Error('Examination invoice series is missing or invalid');
    err.code = 'SERIES_INVALID';
    throw err;
  }
  const httpPost = (deps && deps.httpPost) || null;
  if (!httpPost) {
    const { configured } = cloudConfig();
    if (!configured) {
      const err = new Error('Examination invoice sequence store unavailable (Supabase not configured)');
      err.code = 'SEQUENCE_UNAVAILABLE';
      throw err;
    }
  }
  const { base, key } = cloudConfig();
  const post = httpPost
    || ((url, body, headers) => cloudHttp.post(url, body, { headers, timeout: 15000 }));
  const res = await post(`${base}/rest/v1/rpc/claim_next_examination_invoice_number`, { p_series: clean }, {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  });
  const value = Array.isArray(res.data) ? res.data[0] : res.data;
  const seq = Number(value);
  if (!Number.isInteger(seq) || seq <= 0) {
    const err = new Error('Examination invoice sequence claim returned an invalid value');
    err.code = 'SEQUENCE_INVALID';
    throw err;
  }
  return seq;
}

/**
 * Full mint for one examination invoice in the CURRENT configured series:
 * resolve series -> claim (that series' counter) -> format EXM.
 * Throws when the series is unconfigured or the counter is unreachable.
 */
async function mintExaminationInvoiceNumber(domain, deps) {
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
  const series = (deps && deps.seriesOverride) || resolveExaminationSeries(companyConfig);
  if (!series) {
    const err = new Error('Examination invoice series is not configured (company numbering settings)');
    err.code = 'SERIES_UNCONFIGURED';
    throw err;
  }
  const padding = resolveSeriesPadding(companyConfig);
  const suffix = (() => {
    const numbering =
      (companyConfig && companyConfig.transactionSettings && companyConfig.transactionSettings.numbering) || {};
    for (const key of Object.keys(numbering || {})) {
      if (/^(shared|global)$/i.test(String(key))) return String((numbering[key] || {}).suffix || '');
    }
    return '';
  })();
  const seq = await claimNextSeriesSequence(series, deps);
  void domain;
  return formatExaminationInvoiceNumber(series, seq, padding, suffix);
}

module.exports = {
  EXAMINATION_INVOICE_PATTERN,
  OFFICIAL_PREFIX,
  isExaminationInvoiceNumber,
  parseExaminationInvoiceNumber,
  resolveExaminationSeries,
  resolveSeriesPadding,
  buildPrefixSeparator,
  formatExaminationInvoiceNumber,
  claimNextSeriesSequence,
  mintExaminationInvoiceNumber,
};
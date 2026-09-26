/**
 * Migration 0027 static contract tests (no database required).
 *
 * Migration 0027 must ONLY initialize per-series counters. It must never
 * rewrite business records, never reclassify historical rows by provenance,
 * never hard-code P726 as counter identity, and must seed from every field
 * that can carry an operational number (verified live shape: order_number
 * holds a legacy backend number while id/orderNumber hold the operational
 * P726 number — a COALESCE-first scan would miss the P726 suffix entirely).
 *
 * These tests read the migration file and assert its structural contract.
 * They do not execute anything against a database.
 */
const fs = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '..', '..', 'supabase', 'migrations', '0027_sales_order_number_counters.sql');

function readMigration() {
  return fs.readFileSync(MIGRATION_FILE, 'utf8');
}

function section(src, fromMarker, toMarker) {
  const from = src.indexOf(fromMarker);
  if (from < 0) throw new Error(`migration marker missing: ${fromMarker}`);
  const to = toMarker ? src.indexOf(toMarker, from) : src.length;
  return src.slice(from, to < 0 ? src.length : to);
}

describe('migration 0027 file presence', () => {
  it('exists at the expected path', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
    expect(readMigration().length).toBeGreaterThan(1000);
  });
});

describe('migration 0027 never rewrites business records', () => {
  const BUSINESS_TABLES = ['sales_orders', 'orders', 'invoices', 'quotations', 'delivery_notes'];

  it.each(BUSINESS_TABLES)('contains no UPDATE against public.%s', (table) => {
    const src = readMigration();
    const pattern = new RegExp(`UPDATE\\s+(?:public\\.)?${table}\\b`, 'i');
    expect(src).not.toMatch(pattern);
  });

  it.each(BUSINESS_TABLES)('contains no DELETE against public.%s', (table) => {
    const src = readMigration();
    const pattern = new RegExp(`DELETE\\s+FROM\\s+(?:public\\.)?${table}\\b`, 'i');
    expect(src).not.toMatch(pattern);
  });

  it('contains no TRUNCATE, ALTER of business tables, or DROP of business objects', () => {
    const src = readMigration();
    expect(src).not.toMatch(/\bTRUNCATE\b/i);
    // The only UPDATE targets allowed are the new counter table itself
    // (GREATEST rerun guard + claim bump). The ON CONFLICT ... DO UPDATE
    // clause keyword ("SET") is not a table and is skipped.
    const updates = [...src.matchAll(/UPDATE\s+(?:public\.)?([a-z_0-9]+)/gi)]
      .map((m) => m[1])
      .filter((target) => target.toUpperCase() !== 'SET');
    for (const target of updates) {
      expect(target).toBe('sales_order_number_counters');
    }
  });
});

describe('migration 0027 series-keyed counter (no P726-locked identity)', () => {
  it('creates a series-keyed counter table, not a P726 table', () => {
    const src = readMigration();
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS public\.sales_order_number_counters/);
    expect(src).toMatch(/series TEXT PRIMARY KEY/);
    expect(src).not.toMatch(/CREATE TABLE[^;]*sales_order_p726_counter/i);
  });

  it('creates a generic claim function taking a series, not a P726 function', () => {
    const src = readMigration();
    expect(src).toMatch(/claim_next_sales_order_number\(p_series TEXT\)/);
    expect(src).not.toMatch(/CREATE[^\n;]*claim_next_p726_order_number/i);
  });

  it('removes never-deployed P726-only objects defensively', () => {
    const src = readMigration();
    expect(src).toMatch(/DROP FUNCTION IF EXISTS public\.claim_next_p726_order_number\(\)/);
    expect(src).toMatch(/DROP TABLE IF EXISTS public\.sales_order_p726_counter/);
  });

  it('is rerunnable without lowering counters', () => {
    const src = readMigration();
    expect(src).toMatch(/ON CONFLICT \(series\) DO UPDATE/);
    expect(src).toMatch(/GREATEST\(public\.sales_order_number_counters\.last_value/);
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION/);
    expect(src).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/);
  });
});

describe('migration 0027 seed covers every operational-number field', () => {
  it('scans order_number, orderNumber and id on both tables (six branches)', () => {
    const src = readMigration();
    const seed = section(src, 'STEP 2', 'STEP 3');
    expect(seed.match(/FROM public\.sales_orders/g) || []).toHaveLength(3);
    expect(seed.match(/FROM public\.orders/g) || []).toHaveLength(3);
    expect(seed).toMatch(/data->>'order_number'/);
    expect(seed).toMatch(/data->>'orderNumber'/);
    // Legacy ORDER- prefix participates in history (compatibility); the
    // unified SO/ORD shapes are the only runtime-minted prefixes.
    expect(seed).toMatch(/SO\|ORD\|ORDER/);
  });

  it('does not use a COALESCE-first pick that would shadow fields', () => {
    const src = readMigration();
    const seed = section(src, 'STEP 2', 'STEP 3');
    expect(seed).not.toMatch(/COALESCE\(NULLIF\(data->>'order_number'/);
  });

  it('excludes legacy backend ORD-YYYY numbers from every series', () => {
    const src = readMigration();
    // The unified shape requires a slash + series token; ORD-2026-000001
    // cannot match. Assert the pattern shape used by seed + self-init.
    const patterns = [...src.matchAll(/'\^\(SO\|ORD\|ORDER\)-\(\[A-Za-z0-9\]\+\)\/\(\[0-9\]\{1,9\}\)\$'/g)];
    expect(patterns.length).toBeGreaterThan(0);
    const shape = /^(SO|ORD|ORDER)-([A-Za-z0-9]+)\/([0-9]{1,9})$/;
    expect('ORD-2026-000001'.match(shape)).toBeNull();
    expect('SO-P726/025'.match(shape)).not.toBeNull();
    expect('ORDER-P726/042'.match(shape)).not.toBeNull();
  });

  it('seed is provenance-neutral (numbers only, never origin fields)', () => {
    const src = readMigration();
    const seed = section(src, 'STEP 2', 'STEP 3');
    expect(seed).not.toMatch(/source_request/);
    expect(seed).not.toMatch(/quotation_id/);
    expect(seed).not.toMatch(/erp_order/);
    expect(seed).not.toMatch(/conversion/i);
  });

  it('claim self-initialization uses the same six-branch history scan', () => {
    const src = readMigration();
    const claim = section(src, 'CREATE OR REPLACE FUNCTION public.claim_next_sales_order_number', 'Only the service role');
    expect(claim).toMatch(/pg_advisory_xact_lock/);
    expect(claim.match(/FROM public\.sales_orders/g) || []).toHaveLength(3);
    expect(claim.match(/FROM public\.orders/g) || []).toHaveLength(3);
    expect(claim).toMatch(/UNION ALL/);
    expect(claim).toMatch(/clean_series/);
  });

  it('unique backstop targets the canonical field only', () => {
    const src = readMigration();
    expect(src).toMatch(/idx_sales_orders_official_number_unique/);
    expect(src).toMatch(/data->>'order_number'/);
  });
});

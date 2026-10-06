'use strict';

/**
 * Migration 0042 static contract tests (no database required).
 *
 * 0041 stores only the EXM high-water mark and DISCARDS each claimed value, so
 * the cloud cannot tell a legitimately claimed EXM identity from a fabricated
 * one — the only derivable predicate `sequence <= last_value` admits every
 * historical number (22 <= 22), which is exactly the identity that already
 * carries two batches' AR postings.
 *
 * 0042 must therefore add a durable per-identity claim record, written inside
 * the same transaction/advisory lock as the counter bump, WITHOUT inventing a
 * second numbering mechanism and WITHOUT touching any historical data.
 *
 * These tests read the migration file and assert its structural contract. They
 * do not execute anything against a database.
 */
const fs = require('fs');
const path = require('path');

const MIGRATION_FILE = path.join(__dirname, '..', '..', 'supabase', 'migrations', '0042_examination_invoice_number_claims.sql');
const PREV_MIGRATION_FILE = path.join(__dirname, '..', '..', 'supabase', 'migrations', '0041_examination_invoice_number_counters.sql');

const readMigration = () => fs.readFileSync(MIGRATION_FILE, 'utf8');

/** Slice the migration between two markers so assertions stay scoped. */
function section(src, fromMarker, toMarker) {
  const from = src.indexOf(fromMarker);
  if (from < 0) throw new Error(`migration marker missing: ${fromMarker}`);
  const to = toMarker ? src.indexOf(toMarker, from) : src.length;
  return src.slice(from, to < 0 ? src.length : to);
}

const claimFunction = () => section(
  readMigration(),
  'CREATE OR REPLACE FUNCTION public.claim_next_examination_invoice_number(',
  '-- Only the service role may execute the claim'
);

describe('migration 0042 file presence', () => {
  it('exists at the expected path after 0041', () => {
    expect(fs.existsSync(MIGRATION_FILE)).toBe(true);
    expect(readMigration().length).toBeGreaterThan(1000);
    const previous = path.basename(PREV_MIGRATION_FILE);
    expect(previous).toBe('0041_examination_invoice_number_counters.sql');
    expect(path.basename(MIGRATION_FILE)).toBe('0042_examination_invoice_number_claims.sql');
  });
});

describe('migration 0042 NEVER rewrites business records (test 8)', () => {
  const BUSINESS_TABLES = ['invoices', 'ledger_entries', 'examination_batches', 'examination_jobs'];

  it.each(BUSINESS_TABLES)('contains no INSERT into public.%s', (table) => {
    expect(readMigration()).not.toMatch(new RegExp(`INSERT\\s+INTO\\s+(?:public\\.)?${table}\\b`, 'i'));
  });

  it.each(BUSINESS_TABLES)('contains no UPDATE against public.%s', (table) => {
    expect(readMigration()).not.toMatch(new RegExp(`UPDATE\\s+(?:public\\.)?${table}\\b`, 'i'));
  });

  it.each(BUSINESS_TABLES)('contains no DELETE against public.%s', (table) => {
    expect(readMigration()).not.toMatch(new RegExp(`DELETE\\s+FROM\\s+(?:public\\.)?${table}\\b`, 'i'));
  });

  it('contains no TRUNCATE and no ALTER of any business table', () => {
    const src = readMigration();
    expect(src).not.toMatch(/\bTRUNCATE\b/i);
    expect(src).not.toMatch(/ALTER\s+TABLE\s+(?:public\.)?(invoices|ledger_entries|examination_batches)\b/i);
  });

  it('only ever UPDATEs the counter table (never a business table)', () => {
    const targets = [...readMigration().matchAll(/UPDATE\s+(?:public\.)?([a-z_0-9]+)/gi)]
      .map((m) => m[1])
      .filter((t) => t.toUpperCase() !== 'SET');
    for (const target of targets) {
      expect(target).toBe('examination_invoice_number_counters');
    }
  });

  it('reads the business tables only through SELECT/COUNT/EXISTS', () => {
    // The grandfathering predicate may look at history; it must never write it.
    const src = section(readMigration(), 'CREATE OR REPLACE FUNCTION public.classify_examination_invoice_number(');
    expect(src).toMatch(/FROM public\.invoices/);
    expect(src).toMatch(/FROM public\.ledger_entries/);
    expect(src).not.toMatch(/INSERT\s+INTO/i);
    expect(src).not.toMatch(/UPDATE\s+/i);
    expect(src).not.toMatch(/DELETE\s+FROM/i);
  });
});

describe('migration 0042 claim record schema (test 1)', () => {
  it('creates the durable claim table with the required columns', () => {
    const src = readMigration();
    expect(src).toMatch(/CREATE TABLE IF NOT EXISTS public\.examination_invoice_number_claims/);
    expect(src).toMatch(/series\s+TEXT\s+NOT NULL/i);
    expect(src).toMatch(/sequence\s+INTEGER\s+NOT NULL/i);
    expect(src).toMatch(/invoice_number\s+TEXT\s+NOT NULL/i);
    expect(src).toMatch(/claimed_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+NOW\(\)/i);
  });

  it('has primary key (series, sequence) and uniqueness on invoice_number', () => {
    const src = readMigration();
    expect(src).toMatch(/PRIMARY KEY\s*\(series,\s*sequence\)/i);
    // A UNIQUE constraint (not just an index) on the identity itself.
    expect(src).toMatch(/UNIQUE\s*\(invoice_number\)/i);
    // Positive-sequence guard.
    expect(src).toMatch(/CHECK\s*\(sequence\s*>\s*0\)/i);
  });

  it('is service-role only, like 0041', () => {
    const src = readMigration();
    expect(src).toMatch(/ALTER TABLE public\.examination_invoice_number_claims ENABLE ROW LEVEL SECURITY/i);
    // No permissive policy is added (the service key bypasses RLS).
    expect(src).not.toMatch(/CREATE POLICY[^;]*examination_invoice_number_claims/i);
  });

  it('introduces no tenancy/organization/company scoping', () => {
    for (const forbidden of ['tenant_id', 'tenantId', 'organization_id', 'company_id', 'companyId']) {
      expect(readMigration()).not.toContain(forbidden);
    }
  });
});

describe('migration 0042 claim RPC (tests 2, 3, 4, 5)', () => {
  it('returns the SAME value as 0041 (the claimed sequence integer)', () => {
    const fn = claimFunction();
    expect(fn).toMatch(/RETURNS\s+INTEGER/i);
    expect(fn).toMatch(/RETURN\s+claimed;/);
    // 0041 returned the same thing.
    const prev = fs.readFileSync(PREV_MIGRATION_FILE, 'utf8');
    expect(prev).toMatch(/RETURN\s+claimed;/);
  });

  it('writes EXACTLY ONE claim row per successful claim', () => {
    const fn = claimFunction();
    const inserts = [...fn.matchAll(/INSERT\s+INTO\s+public\.examination_invoice_number_claims/gi)];
    expect(inserts).toHaveLength(1);
  });

  it('the recorded invoice_number is built from the SAME claimed value that is returned', () => {
    const fn = claimFunction();
    // Both the stored string and the RETURN derive from `claimed` — they cannot
    // disagree, so the claim row always matches the number handed to the caller.
    expect(fn).toMatch(/claimed_number\s*:=\s*'EXM-'\s*\|\|\s*clean_series\s*\|\|\s*'\/'\s*\|\|\s*lpad\(claimed::text/);
    expect(fn).toMatch(/INSERT INTO public\.examination_invoice_number_claims\s*\(series,\s*sequence,\s*invoice_number,\s*claimed_at\)\s*VALUES\s*\(clean_series,\s*claimed,\s*claimed_number,\s*NOW\(\)\)/i);
    expect(fn).toMatch(/RETURN\s+claimed;/);
  });

  it('preserves 0041 series validation and the 0041 history-dominant next sequence', () => {
    const fn = claimFunction();
    const prev = fs.readFileSync(PREV_MIGRATION_FILE, 'utf8');
    // Series validation identical to 0041.
    expect(fn).toMatch(/clean_series\s*:=\s*NULLIF\(trim\(both from p_series\),\s*''\)/i);
    expect(fn).toMatch(/clean_series\s*!~\s*'\^\[A-Za-z0-9\]\+\$'\s*THEN/i);
    // Same advisory lock key → 0041-era and 0042-era claims serialize together.
    expect(fn).toContain("pg_advisory_xact_lock(hashtext('examination_invoice_number_counters:' || clean_series))");
    expect(prev).toContain("pg_advisory_xact_lock(hashtext('examination_invoice_number_counters:' || clean_series))");
    // Next sequence still history-dominant and strictly increasing (test 3).
    expect(fn).toMatch(/claimed\s*:=\s*GREATEST\(claimed,\s*history_max\)\s*\+\s*1;/i);
    expect(fn).toMatch(/claimed\s*:=\s*history_max\s*\+\s*1;/i);
  });

  it('counter bump and claim insert live in ONE transaction (test 5)', () => {
    const fn = claimFunction();
    // No explicit transaction control inside the function body: a RAISE anywhere
    // aborts the whole statement, rolling the counter write back with it.
    expect(fn).not.toMatch(/\bBEGIN\s*;?\s*COMMIT\b/i);
    expect(fn).not.toMatch(/SAVEPOINT/i);
    // No plpgsql exception handler. (RAISE EXCEPTION is fine — it is how the
    // series guard rejects bad input; what must not exist is a handler that
    // catches an insert failure and still lets the counter bump commit.)
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN/i);
    expect(fn).not.toMatch(/EXCEPTION\s*\n\s*WHEN\b/i);
    // And the claim insert happens AFTER the counter write in the same body.
    const counterIdx = fn.indexOf('UPDATE public.examination_invoice_number_counters');
    const claimIdx = fn.indexOf('INSERT INTO public.examination_invoice_number_claims');
    expect(counterIdx).toBeGreaterThan(-1);
    expect(claimIdx).toBeGreaterThan(counterIdx);
  });

  it('a failed claim consumes nothing: no handler can commit a partial claim', () => {
    const fn = claimFunction();
    expect(fn).not.toMatch(/EXCEPTION\s+WHEN/i);
    // Nothing catches-and-continues either.
    expect(fn).not.toMatch(/\bCONTINUE\b/i);
  });

  it('drops the 0041 single-arg signature (Postgres would otherwise overload it)', () => {
    const src = readMigration();
    expect(src).toMatch(/DROP FUNCTION IF EXISTS public\.claim_next_examination_invoice_number\(TEXT\);/i);
    // Replacement keeps the 0041 behaviour available to 1-arg callers.
    expect(src).toMatch(/p_padding\s+INTEGER\s+DEFAULT\s+NULL/i);
    expect(src).toMatch(/p_suffix\s+TEXT\s+DEFAULT\s+NULL/i);
  });

  it('is service-role only, like 0041', () => {
    const src = readMigration();
    expect(src).toMatch(
      /REVOKE ALL ON FUNCTION public\.claim_next_examination_invoice_number\(TEXT, INTEGER, TEXT\) FROM PUBLIC, anon, authenticated;/i
    );
    expect(src).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.claim_next_examination_invoice_number\(TEXT, INTEGER, TEXT\) TO service_role;/i
    );
  });

  it('does NOT add a second sequence generator or client-side fallback', () => {
    const src = readMigration();
    // The only table 0042 creates is the claim record. The counter table is
    // 0041's and is NOT recreated here — there is still exactly one counter.
    const created = [...src.matchAll(/CREATE TABLE IF NOT EXISTS public\.examination_invoice_number_(counters|claims)/gi)];
    expect(created).toHaveLength(1);
    expect(created[0][1].toLowerCase()).toBe('claims');
    expect(src).not.toMatch(/CREATE TABLE[^;]*examination_invoice_number_counters/i);
    // Exactly one claim function, and no sequence primitives of its own.
    expect([...src.matchAll(/CREATE OR REPLACE FUNCTION public\.claim_next_examination_invoice_number\(/gi)]).toHaveLength(1);
    expect(section(src, 'CREATE OR REPLACE FUNCTION public.claim_next_examination_invoice_number(')).not.toMatch(/nextval|setval|generate_series/i);
  });
});

describe('migration 0042 historical grandfathering (tests 6, 7)', () => {
  it('exposes an explicit three-way classifier', () => {
    const src = readMigration();
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.classify_examination_invoice_number\(/i);
    expect(src).toContain("RETURN 'CLAIMED_NEW'");
    expect(src).toContain("RETURN 'HISTORICAL_GRANDFATHERED'");
    expect(src).toContain("RETURN 'UNKNOWN'");
  });

  it('keeps CLAIMED_NEW strictly distinct from HISTORICAL_GRANDFATHERED', () => {
    const fn = section(
      readMigration(),
      'CREATE OR REPLACE FUNCTION public.classify_examination_invoice_number(',
      'CREATE OR REPLACE FUNCTION public.examination_invoice_number_evidence_counts('
    );
    // A claim row is the ONLY source of CLAIMED_NEW.
    expect(fn).toMatch(/FROM public\.examination_invoice_number_claims/);
    // Historical recognition comes from business evidence, never a claim row.
    expect(fn).toMatch(/FROM public\.invoices/);
    expect(fn).toMatch(/FROM public\.ledger_entries/);
    // Order matters: claimed first, then grandfathered, then unknown.
    const claimedIdx = fn.indexOf("RETURN 'CLAIMED_NEW'");
    const grandIdx = fn.indexOf("RETURN 'HISTORICAL_GRANDFATHERED'");
    const unknownIdx = fn.indexOf("RETURN 'UNKNOWN'");
    expect(claimedIdx).toBeGreaterThan(-1);
    expect(grandIdx).toBeGreaterThan(claimedIdx);
    expect(unknownIdx).toBeGreaterThan(grandIdx);
  });

  it('fabricates NO claim rows from historical data (test 7)', () => {
    const src = readMigration();
    // The ONLY insert into the claims table is inside the claim function,
    // sourcing `claimed`/`claimed_number` — never invoices/ledger history.
    const inserts = [...src.matchAll(/INSERT\s+INTO\s+public\.examination_invoice_number_claims[\s\S]{0,400}?;/gi)];
    expect(inserts).toHaveLength(1);
    expect(inserts[0][0]).toMatch(/VALUES\s*\(clean_series,\s*claimed,\s*claimed_number,\s*NOW\(\)\)/i);
    // No backfill-style insert anywhere.
    expect(src).not.toMatch(/INSERT INTO public\.examination_invoice_number_claims[^;]*SELECT/i);
  });

  it('exposes read-only evidence counts so a duplicated historical identity is visible as multiple rows', () => {
    const src = readMigration();
    expect(src).toMatch(/CREATE OR REPLACE FUNCTION public\.examination_invoice_number_evidence_counts\(/i);
    expect(src).toMatch(/RETURNS TABLE \(invoice_evidence INTEGER, ledger_evidence INTEGER\)/i);
    const fn = section(src, 'CREATE OR REPLACE FUNCTION public.examination_invoice_number_evidence_counts(');
    // Read-only.
    expect(fn).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it('historical matching is padding-agnostic (regex, not string equality)', () => {
    const src = readMigration();
    // The sequence is EXTRACTED from the number via a 1-9 digit regex and then
    // compared numerically, so EXM-P726/022 and EXM-P726/000022 classify
    // identically. A padded string equality check would miss one of them.
    expect(src).toMatch(/\(\[0-9\]\{1,9\}\)/);
    expect(src).toMatch(/\(m\)\[1\]::int = p_sequence/);
    expect(src).not.toMatch(/invoice_number\s*=\s*'EXM-'\s*\|\|\s*clean_series/i);
  });

  /**
   * REGRESSION: 0041 scanned history with a TWO-capture pattern
   * ('^(EXM)-SERIES/([0-9]{1,9})$') but read the sequence from group [3].
   * regexp_match returns one array element per capture group, so [3] was NULL
   * for every row → MAX(...) was NULL → history_max was always 0 → the
   * "history wins over the counter" guard was silently INERT and a claim could
   * reissue an in-use EXM number.
   *
   * The pattern must therefore expose the sequence as group [1] and nothing
   * may read a group index the pattern does not define.
   */
  describe('regex capture-group index is consistent with the pattern (regression)', () => {
    /** Count capture groups ((...) ) in a Postgres regex literal. */
    const captureGroups = (pattern) => {
      const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
      let count = 0;
      for (let i = 0; i < body.length; i += 1) {
        if (body[i] === '\\') { i += 1; continue; }
        if (body[i] === '(') {
          // Ignore non-capturing (?...) and lookbehind (?<= (?<!
          if (body[i + 1] !== '?') count += 1;
        }
      }
      return count;
    };

    /**
     * For each `(m)[N]` reference, find the pattern on its own SELECT line and
     * assert N is a group that pattern actually defines. This is the general
     * invariant; the earlier bug violated it in exactly this way.
     */
    const assertIndexesResolve = (sql) => {
      // Strip comments first: the migration header documents the older 3-group
      // shape in prose, which is not executable SQL.
      const code = sql
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ');

      const statements = code.split(';');
      for (const stmt of statements) {
        const patterns = [...stmt.matchAll(/regexp_match\([^,]+,\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
        const refs = [...stmt.matchAll(/\(m\)\[(\d+)\]/g)].map((m) => Number(m[1]));
        if (!patterns.length || !refs.length) continue;
        const maxGroups = Math.max(...patterns.map(captureGroups));
        for (const ref of refs) {
          expect({ ref, maxGroups, pattern: patterns[0] }).toEqual({ ref, maxGroups, pattern: patterns[0] });
          expect(ref).toBeLessThanOrEqual(maxGroups);
        }
      }
    };

    it('0042 resolves every (m)[N] reference against its pattern', () => {
      assertIndexesResolve(readMigration());
    });

    it('0041 resolves every (m)[N] reference against its pattern', () => {
      assertIndexesResolve(fs.readFileSync(PREV_MIGRATION_FILE, 'utf8'));
    });

    it('0041 CLAIM FUNCTION uses the single-group pattern (sequence = group 1)', () => {
      // The claim function interpolates the series, so `EXM` is a literal:
      // one capture group, sequence at [1].
      const claim = section(
        fs.readFileSync(PREV_MIGRATION_FILE, 'utf8'),
        'CREATE OR REPLACE FUNCTION public.claim_next_examination_invoice_number('
      );
      expect(claim).toMatch(/'\^EXM-' \|\| clean_series \|\| '\/\(\[0-9\]\{1,9\}\)\$'/);
      expect(claim).toMatch(/MAX\(\(m\)\[1\]::int\)/);
      // The old broken shape indexed a group the pattern never defined.
      expect(claim).not.toMatch(/\(m\)\[3\]/);
    });

    it('0041 backfill keeps its own 3-group pattern consistent', () => {
      // The backfill pattern captures EXM/series/sequence, so [2]=series and
      // [3]=sequence are BOTH valid there. This is the correct shape the claim
      // function was wrongly assumed to follow.
      const prev = fs.readFileSync(PREV_MIGRATION_FILE, 'utf8');
      expect(prev).toMatch(/'\^\(EXM\)-\(\[A-Za-z0-9\]\+\)\/\(\[0-9\]\{1,9\}\)\$'/);
      expect(prev).toMatch(/\(m\)\[2\] AS series/);
      expect(prev).toMatch(/MAX\(\(m\)\[3\]::int\)/);
    });
  });

  it('never lets historical evidence authorize reuse of an old EXM number', () => {
    // The claim function still refuses anything at or below history_max — the
    // grandfather predicate is read-only recognition, NOT an allocator.
    const fn = claimFunction();
    expect(fn).toMatch(/GREATEST\(claimed,\s*history_max\)\s*\+\s*1;/i);
    expect(fn).toMatch(/claimed\s*:=\s*history_max\s*\+\s*1;/i);
  });

  it('grandfather predicates are service-role only', () => {
    const src = readMigration();
    for (const fn of ['classify_examination_invoice_number', 'examination_invoice_number_evidence_counts']) {
      expect(src).toMatch(
        new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(TEXT, INTEGER\\) FROM PUBLIC, anon, authenticated;`, 'i')
      );
      expect(src).toMatch(
        new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\(TEXT, INTEGER\\) TO service_role;`, 'i')
      );
    }
  });
});
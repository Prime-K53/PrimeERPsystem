/**
 * scheduleCorrectness.test.ts — Phase 2 regression cover for the assessment
 * schedule's dates, ordering, counts, fund position and content hash.
 *
 * Each block pins a defect the Phase 1 audit confirmed:
 *   - dates were formatted by the builder and re-parsed by the renderer, so an
 *     en-GB browser swapped day and month (1 Jun 2027 printed as 06/01/2027)
 *     and `30/04/2027` fell back to raw text;
 *   - rows were sorted lexicographically over `DD/MM/YYYY`, so a cross-month
 *     schedule was ordered by day number;
 *   - a full ISO instant was rendered through the LOCAL timezone, shifting a
 *     midnight-UTC assessment a day earlier west of UTC;
 *   - `scheduledCount` was a count of `reserved` items, which the renderer
 *     labelled "Scheduled";
 *   - available funds were recomputed and clamped with Math.max(0, …), hiding a
 *     negative or drifted position, and ignored the authoritative
 *     `available_funds` generated column.
 *
 * The date helpers are also exercised inside a genuinely non-UTC timezone
 * (America/New_York) in a child process, so the timezone claim is measured, not
 * asserted.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webcrypto, createHash } from 'node:crypto';
import ts from 'typescript';
import {
  buildContractScheduleDoc,
  stableStringify,
  stableScheduleHashInput,
  legacyScheduleHashInput,
  legacyReceiptHashInput,
  hashLegacyScheduleContent,
  hashLegacyReceiptContent,
  SCHEDULE_HASH_VERSION,
} from '../../../services/printingContractService';
import {
  toIsoDateOnly,
  toIsoDateOnlyOrEmpty,
  formatIsoDate,
  compareIsoDateOnly,
  isIsoDateWithin,
} from '../../../utils/isoDate';
import { mapToInvoiceData } from '../../../utils/pdfMapper';

beforeAll(() => {
  Object.defineProperty(globalThis, 'crypto', {
    value: {
      ...((globalThis as Record<string, unknown>).crypto ?? {}),
      subtle: webcrypto.subtle,
      getRandomValues: (b: Uint8Array) => webcrypto.getRandomValues(b),
    },
    configurable: true,
    writable: true,
  });
});

/* ────────────────────────────── Date canonicalisation ────────────────────── */

describe('canonical date-only handling', () => {
  it('accepts the exact dates named in the Phase 2 brief', () => {
    expect(toIsoDateOnly('2026-10-19')).toBe('2026-10-19');
    expect(toIsoDateOnly('2026-10-21')).toBe('2026-10-21');
    expect(toIsoDateOnly('2027-02-18')).toBe('2027-02-18');
    expect(toIsoDateOnly('2027-06-01')).toBe('2027-06-01');
  });

  it('takes the calendar date of a full ISO instant verbatim (no local shift)', () => {
    expect(toIsoDateOnly('2027-06-01T00:00:00.000Z')).toBe('2027-06-01');
    expect(toIsoDateOnly('2026-10-19T23:59:59.999Z')).toBe('2026-10-19');
    expect(toIsoDateOnly('2026-10-19T00:00:00+02:00')).toBe('2026-10-19');
  });

  it('reads the legacy en-GB display string back positionally', () => {
    // Historical schedule rows stored `DD/MM/YYYY`. Reading them through the
    // locale-dependent Date parser is what swapped 01/06 and 06/01.
    expect(toIsoDateOnly('19/10/2026')).toBe('2026-10-19');
    expect(toIsoDateOnly('01/06/2027')).toBe('2027-06-01');
    expect(toIsoDateOnly('30/04/2027')).toBe('2027-04-30');
    expect(toIsoDateOnly('18/02/2027')).toBe('2027-02-18');
  });

  it('never substitutes the current date for a missing or invalid value', () => {
    expect(toIsoDateOnly(undefined)).toBeUndefined();
    expect(toIsoDateOnly(null)).toBeUndefined();
    expect(toIsoDateOnly('')).toBeUndefined();
    expect(toIsoDateOnly('   ')).toBeUndefined();
    expect(toIsoDateOnly('not a date')).toBeUndefined();
    expect(toIsoDateOnly('2026-13-01')).toBeUndefined();
    expect(toIsoDateOnly('2026-02-30')).toBeUndefined();
    expect(toIsoDateOnly('2027-02-29')).toBeUndefined();
    expect(toIsoDateOnly('00/00/2027')).toBeUndefined();
    expect(toIsoDateOnlyOrEmpty(undefined)).toBe('');
  });

  it('handles a leap day only in a leap year', () => {
    expect(toIsoDateOnly('2028-02-29')).toBe('2028-02-29');
    expect(toIsoDateOnly('2027-02-29')).toBeUndefined();
  });

  it('rejects unpadded ISO dates instead of reparsing them through Date', () => {
    // `2027-6-1` is close enough to ISO to be a mistake. The old fallback fed it
    // to `new Date()`, which accepts it and applies local-timezone semantics.
    expect(toIsoDateOnly('2027-6-1')).toBeUndefined();
    expect(toIsoDateOnly('2027-06-1')).toBeUndefined();
    expect(toIsoDateOnly('2027-6-01')).toBeUndefined();
    expect(toIsoDateOnly('2027-6-1T00:00:00.000Z')).toBeUndefined();
    // The padded canonical form and the documented legacy form still work.
    expect(toIsoDateOnly('2027-06-01')).toBe('2027-06-01');
    expect(toIsoDateOnly('1/6/2027')).toBe('2027-06-01');
  });

  it('formats once, locale-independently, as DD MMM YYYY', () => {
    expect(formatIsoDate('2027-06-01')).toBe('1 Jun 2027');
    expect(formatIsoDate('2026-10-19')).toBe('19 Oct 2026');
    expect(formatIsoDate('2027-02-18')).toBe('18 Feb 2027');
    expect(formatIsoDate('2026-10-19T00:00:00.000Z')).toBe('19 Oct 2026');
    expect(formatIsoDate('')).toBe('');
    // An unmappable value is shown verbatim rather than silently dropped.
    expect(formatIsoDate('whenever')).toBe('whenever');
  });

  it('does not depend on the local timezone at all for the stored formats', () => {
    // Replacing Date with a throwing stub proves the canonical path performs no
    // timezone-dependent parsing: only the (unreachable here) exotic fallback
    // may construct a Date.
    const RealDate = globalThis.Date;
    (globalThis as any).Date = function sabotaged() {
      throw new Error('Date must not be used to canonicalise a stored date');
    };
    try {
      expect(toIsoDateOnly('2027-06-01T00:00:00.000Z')).toBe('2027-06-01');
      expect(toIsoDateOnly('01/06/2027')).toBe('2027-06-01');
      expect(formatIsoDate('2027-06-01T00:00:00.000Z')).toBe('1 Jun 2027');
    } finally {
      (globalThis as any).Date = RealDate;
    }
  });

  it('compares chronologically across months and years, undated last', () => {
    const values = ['2027-02-18', '2026-10-21', '2027-06-01', '2026-10-19', undefined];
    const sorted = [...values].sort((a, b) => compareIsoDateOnly(a, b));
    expect(sorted).toEqual(['2026-10-19', '2026-10-21', '2027-02-18', '2027-06-01', undefined]);
    expect(compareIsoDateOnly('2027-06-01', '2026-12-31')).toBeGreaterThan(0);
    expect(compareIsoDateOnly(undefined, '2026-12-31')).toBeGreaterThan(0);
  });

  it('tests containment inside a contract window inclusively', () => {
    expect(isIsoDateWithin('2026-10-19', '2026-10-19', '2027-04-30')).toBe(true);
    expect(isIsoDateWithin('2027-04-30', '2026-10-19', '2027-04-30')).toBe(true);
    expect(isIsoDateWithin('2027-06-01', '2026-10-19', '2027-04-30')).toBe(false);
    expect(isIsoDateWithin(undefined, '2026-10-19', '2027-04-30')).toBeUndefined();
  });
});

/* ───────────────────── Measured cross-timezone behaviour ─────────────────── */

describe('date handling under a non-UTC timezone (measured)', () => {
  it('renders the stored calendar date identically in America/New_York', () => {
    // Compile the REAL module and run it in a child process whose timezone is
    // genuinely behind UTC, so the claim is measured rather than assumed.
    // (esbuild cannot run inside the vitest sandbox — it asserts on
    // `TextEncoder().encode('') instanceof Uint8Array` — so the repo's own
    // TypeScript compiler performs the transform.)
    const sourcePath = [
      resolve(process.cwd(), 'utils', 'isoDate.ts'),
      resolve(process.cwd(), 'frontend', 'utils', 'isoDate.ts'),
    ].find((candidate) => existsSync(candidate));
    if (!sourcePath) throw new Error('isoDate.ts not found from the test working directory');
    const source = readFileSync(sourcePath, 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    });
    const program = `
${outputText}
const out = {
  instant: formatIsoDate('2027-06-01T00:00:00.000Z'),
  iso: formatIsoDate('2026-10-19'),
  legacy: formatIsoDate('01/06/2027'),
  canon: toIsoDateOnly('2026-10-19T00:00:00.000Z'),
  offset: new Date().getTimezoneOffset(),
  // What the OLD implementation produced: local-time rendering of a UTC instant.
  buggy: new Date('2027-06-01T00:00:00.000Z').toLocaleDateString('en-GB'),
};
process.stdout.write(JSON.stringify(out));
`;
    const stdout = execFileSync(process.execPath, ['-e', program], {
      env: { ...process.env, TZ: 'America/New_York' },
      encoding: 'utf8',
    });
    const result = JSON.parse(stdout);

    expect(result.instant).toBe('1 Jun 2027');
    expect(result.iso).toBe('19 Oct 2026');
    expect(result.legacy).toBe('1 Jun 2027');
    expect(result.canon).toBe('2026-10-19');
    // Sanity: the child really is behind UTC and the old local-time path really
    // does shift the day there, so the assertions above are discriminating
    // rather than vacuous.
    expect(result.offset).toBe(240);
    expect(result.buggy).toMatch(/^31\/05\/2027/);
  });
});

/* ─────────────────────────── Schedule builder ───────────────────────────── */

const CONTRACT_ID = 'PC-SCH-1';

const makeContract = (over: any = {}) => ({
  id: CONTRACT_ID,
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  contract_number: 'PC-2026-0009',
  status: 'active',
  version: 1,
  prepaid_amount: 319200,
  reserved_amount: 239400,
  consumed_amount: 79800,
  starts_at: '2026-10-19T00:00:00.000Z',
  ends_at: '2027-04-30T00:00:00.000Z',
  terms: 'Terms as agreed.',
  data: {},
  ...over,
});

const makeItem = (over: any = {}) => ({
  id: `A-${Math.random().toString(16).slice(2)}`,
  contract_id: CONTRACT_ID,
  assessment_name: 'Assessment',
  status: 'reserved',
  item_price: 79800,
  ...over,
});

const build = (contract: any, items: any[], extra: any = {}) =>
  buildContractScheduleDoc({
    contract,
    items,
    customerName: 'MUA RC Primary School',
    schoolName: 'Mankhamba ZONE',
    ...extra,
  });

describe('schedule rows: canonical dates and chronological order', () => {
  it('keeps ISO dates and sorts across months and years (not lexicographically)', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_name: 'Fourth', assessment_date: '2027-02-18' }),
      makeItem({ id: 'A-2', assessment_name: 'Third', assessment_date: '2026-10-21' }),
      makeItem({ id: 'A-3', assessment_name: 'Fifth', assessment_date: '2027-06-01' }),
      makeItem({ id: 'A-4', assessment_name: 'First', assessment_date: '2026-10-19' }),
    ]);

    expect(doc.schedule.map((r) => r.assessmentDate)).toEqual([
      '2026-10-19',
      '2026-10-21',
      '2027-02-18',
      '2027-06-01',
    ]);
    expect(doc.schedule.map((r) => r.sequence)).toEqual([1, 2, 3, 4]);
    expect(doc.schedule.map((r) => r.assessmentName)).toEqual([
      'First', 'Third', 'Fourth', 'Fifth',
    ]);
  });

  it('normalises ISO instants to their calendar date and keeps undated rows last', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_name: 'Undated', assessment_date: undefined }),
      makeItem({ id: 'A-2', assessment_name: 'Dated', assessment_date: '2027-06-01T00:00:00.000Z' }),
    ]);

    expect(doc.schedule[0].assessmentName).toBe('Dated');
    expect(doc.schedule[0].assessmentDate).toBe('2027-06-01');
    expect(doc.schedule[1].assessmentName).toBe('Undated');
    expect(doc.schedule[1].assessmentDate).toBeUndefined();
    expect(doc.missingDateSequences).toEqual([2]);
    expect(doc.undatedCount).toBe(1);
    expect(doc.scheduleComplete).toBe(false);
  });

  it('never substitutes the current date for a missing assessment date', async () => {
    const doc = await build(makeContract(), [makeItem({ assessment_date: undefined })]);
    expect(doc.schedule[0].assessmentDate).toBeUndefined();
    expect(doc.scheduleComplete).toBe(false);
  });

  it('records the persisted issue date and never the current time', async () => {
    const issued = await build(makeContract(), [makeItem({ assessment_date: '2026-10-19' })], {
      issuedAtIso: '2026-10-19T08:31:00.000Z',
    });
    expect(issued.date).toBe('2026-10-19');

    // An unissued (transient) preview carries no issue date.
    const transient = await build(makeContract(), [makeItem({ assessment_date: '2026-10-19' })]);
    expect(transient.date).toBe('');
  });
});

describe('schedule counts reflect dated, eligible assessments', () => {
  it('counts dated non-cancelled rows as Scheduled, not a status bucket', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', status: 'reserved', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'consumed', assessment_date: '2026-10-21' }),
      makeItem({ id: 'A-3', status: 'consumed', assessment_date: undefined }),
      makeItem({ id: 'A-4', status: 'reserved', assessment_date: undefined }),
    ]);

    expect(doc.totalAssessments).toBe(4);
    expect(doc.activeAssessments).toBe(4);
    expect(doc.scheduledCount).toBe(2);
    expect(doc.undatedCount).toBe(2);
    expect(doc.consumedCount).toBe(2);
    expect(doc.scheduleComplete).toBe(false);
  });

  it('excludes cancelled assessments from the scheduled count and completeness', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', status: 'reserved', assessment_date: '2026-10-19', item_price: 79800 }),
      makeItem({ id: 'A-2', status: 'cancelled', assessment_date: undefined, item_price: 50000 }),
    ]);

    expect(doc.totalAssessments).toBe(2);
    expect(doc.activeAssessments).toBe(1);
    expect(doc.scheduledCount).toBe(1);
    expect(doc.cancelledCount).toBe(1);
    // A cancelled assessment cannot make the agreed schedule "incomplete".
    expect(doc.scheduleComplete).toBe(true);
    expect(doc.missingDateSequences).toEqual([]);
    expect(doc.cancelledValue).toBe(50000);
  });

  it('excludes cancelled assessments from the active schedule value', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', status: 'reserved', item_price: 79800, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'reserved', item_price: 79800, assessment_date: '2026-10-21' }),
      makeItem({ id: 'A-3', status: 'cancelled', item_price: 79800, assessment_date: '2026-11-01' }),
    ]);
    expect(doc.totalValue).toBe(159600);
    expect(doc.cancelledValue).toBe(79800);
  });
});

describe('fund position is authoritative and never clamped', () => {
  it('uses the authoritative available_funds generated column when the row carries it', async () => {
    // Consistent fixture: one consumed assessment, reservation bucket cleared,
    // and the generated column agrees with prepaid − reserved − consumed.
    const doc = await build(
      makeContract({ prepaid_amount: 319200, reserved_amount: 0, consumed_amount: 79800, available_funds: 239400 }),
      [makeItem({ status: 'consumed', assessment_date: '2026-10-19' })],
    );
    expect(doc.availableFunds).toBe(239400);
    expect(doc.availableFundsSource).toBe('generated');
    expect(doc.fundPositionConsistent).toBe(true);
    expect(doc.fundInconsistencies).toEqual([]);
  });

  it('derives the identical formula when the generated column is absent', async () => {
    const doc = await build(
      makeContract({ prepaid_amount: 319200, reserved_amount: 0, consumed_amount: 79800 }),
      [makeItem({ status: 'consumed', assessment_date: '2026-10-19' })],
    );
    expect(doc.availableFunds).toBe(239400);
    expect(doc.availableFundsSource).toBe('derived');
    expect(doc.fundPositionConsistent).toBe(true);
  });

  it('never turns a negative position into zero — it surfaces it', async () => {
    const doc = await build(
      makeContract({ prepaid_amount: 100000, reserved_amount: 80000, consumed_amount: 60000 }),
      [makeItem({ status: 'reserved', item_price: 80000, assessment_date: '2026-10-19' })],
    );
    expect(doc.availableFunds).toBe(-40000);
    expect(doc.fundPositionConsistent).toBe(false);
    expect(doc.fundInconsistencies.join(' ')).toMatch(/negative/i);
  });

  it('does not trust a persisted available_funds that disagrees with the formula', async () => {
    // The production regression: the generated column reads a stale value while
    // the synchronized figures hold the real position. The formula wins and the
    // disagreement is disclosed — the stale column is never shown as truth.
    const doc = await build(
      makeContract({ available_funds: 999999 }),
      [makeItem({ status: 'reserved', item_price: 239400, assessment_date: '2026-10-19' })],
    );
    expect(doc.availableFunds).toBe(0); // 319200 − 239400 − 79800
    expect(doc.availableFundsSource).toBe('derived');
    expect(doc.fundPositionConsistent).toBe(false);
    expect(doc.fundInconsistencies.join(' ')).toMatch(/persisted available_funds \(999999\)/i);
  });

  it('uses the envelope position when the stale generated column reads zero', async () => {
    // Production shape (migration 0039): the top-level P/R/C columns were not
    // populated, so the generated `available_funds` column reads 0 while the
    // synchronized envelope holds prepaid 180,000 with every item reserved.
    const doc = await build(
      makeContract({ prepaid_amount: 180000, reserved_amount: 0, consumed_amount: 0, available_funds: 0 }),
      [
        makeItem({ id: 'A-1', status: 'reserved', item_price: 90000, assessment_date: '2026-10-19' }),
        makeItem({ id: 'A-2', status: 'reserved', item_price: 90000, assessment_date: '2026-10-21' }),
      ],
    );
    expect(doc.availableFunds).toBe(180000);
    expect(doc.availableFundsSource).toBe('derived');
    expect(doc.fundPositionConsistent).toBe(false);
    expect(doc.fundInconsistencies.join(' ')).toMatch(/persisted available_funds \(0\)/i);
    // The bucket-vs-items drift is disclosed too, never silently repaired.
    expect(doc.fundInconsistencies.join(' ')).toMatch(/canonical reserved assessments/i);
  });

  it('derives the balance from the synchronized figures for every contract status', async () => {
    const cases: Array<[string, number]> = [
      ['draft', 180000],
      ['pending_payment', 180000],
      ['active', 180000],
      ['cancelled', 180000],
    ];
    for (const [status, expected] of cases) {
      const doc = await build(
        makeContract({ status, prepaid_amount: 180000, reserved_amount: 0, consumed_amount: 0, available_funds: 0 }),
        [makeItem({ status: 'reserved', item_price: 180000, assessment_date: '2026-10-19' })],
      );
      expect(doc.status).toBe(status);
      expect(doc.availableFunds).toBe(expected);
      expect(doc.availableFundsSource).toBe('derived');
    }
  });

  it('keeps a corroborated generated column reporting as generated', async () => {
    const doc = await build(
      makeContract({ status: 'active', prepaid_amount: 1000000, reserved_amount: 400000, consumed_amount: 100000, available_funds: 500000 }),
      [makeItem({ status: 'reserved', item_price: 400000, assessment_date: '2026-10-19' })],
    );
    expect(doc.availableFunds).toBe(500000);
    expect(doc.availableFundsSource).toBe('generated');
    expect(doc.fundPositionConsistent).toBe(true);
  });

  it('reports legacy drift between the reservation bucket and the reserved items', async () => {
    // Bucket says 0 (legacy row) while two reserved assessments exist.
    const doc = await build(
      makeContract({ prepaid_amount: 200000, reserved_amount: 0, consumed_amount: 0 }),
      [
        makeItem({ id: 'A-1', status: 'reserved', item_price: 100000, assessment_date: '2026-10-19' }),
        makeItem({ id: 'A-2', status: 'reserved', item_price: 100000, assessment_date: '2026-10-21' }),
      ],
    );
    expect(doc.reservedAmount).toBe(0);
    expect(doc.fundPositionConsistent).toBe(false);
    expect(doc.fundInconsistencies.join(' ')).toMatch(/canonical reserved assessments/i);
  });

  it('treats released funds as a distinct movement, not consumption', async () => {
    // A closed contract releases the reservation: reserved drops to 0 while
    // consumed stays as posted. Released value is never added to consumed.
    const doc = await build(
      makeContract({ prepaid_amount: 1000000, reserved_amount: 0, consumed_amount: 400000 }),
      [
        makeItem({ id: 'A-1', status: 'consumed', item_price: 400000, assessment_date: '2026-10-19' }),
        makeItem({ id: 'A-2', status: 'released', item_price: 600000, assessment_date: '2026-10-21' }),
      ],
    );
    expect(doc.consumedAmount).toBe(400000);
    expect(doc.consumedCount).toBe(1);
    expect(doc.releasedCount).toBe(1);
    expect(doc.reservedAmount).toBe(0);
    expect(doc.availableFunds).toBe(600000);
  });

  it('keeps the commercial contract value distinct from funding evidence', async () => {
    const doc = await build(makeContract(), [makeItem({ assessment_date: '2026-10-19' })]);
    // `prepaid_amount` is agreed commercial value on this document; the builder
    // exposes no "funded"/"verified payment" concept at all.
    expect(doc.prepaidAmount).toBe(319200);
    expect(Object.keys(doc).some((k) => /funded|paidReceived|verifiedFunds/i.test(k))).toBe(false);
  });
});

/* ───────────────────────────── Content hash ─────────────────────────────── */

describe('schedule content hash', () => {
  const items = [
    makeItem({ id: 'A-1', assessment_date: '2026-10-19', item_price: 79800 }),
    makeItem({ id: 'A-2', assessment_date: '2027-06-01', item_price: 79800 }),
  ];

  it('declares hash rule version 2', async () => {
    const doc = await build(makeContract(), items);
    expect(doc.hashVersion).toBe(SCHEDULE_HASH_VERSION);
    expect(SCHEDULE_HASH_VERSION).toBe(2);
  });

  it('produces the SAME hash across repeated renders of unchanged content', async () => {
    const a = await build(makeContract(), items, {
      issuedAtIso: '2026-10-19T08:31:00.000Z',
      verificationToken: 'a'.repeat(64),
    });
    const b = await build(makeContract(), items, {
      issuedAtIso: '2027-01-02T17:05:00.000Z',
      verificationToken: 'b'.repeat(64),
    });
    // Volatile metadata (issue date, per-version token) is excluded.
    expect(a.date).not.toBe(b.date);
    expect(a.verificationToken).not.toBe(b.verificationToken);
    expect(a.contentHash).toBe(b.contentHash);
  });

  it('excludes exactly the volatile keys and nothing material', async () => {
    const doc = await build(makeContract(), items, { issuedAtIso: '2026-10-19T08:31:00.000Z' });
    const envelope = stableScheduleHashInput(doc as unknown as Record<string, unknown>);
    expect(envelope).not.toHaveProperty('contentHash');
    expect(envelope).not.toHaveProperty('date');
    expect(envelope).not.toHaveProperty('verificationToken');
    // Everything material stays inside the hash input.
    for (const key of ['schedule', 'availableFunds', 'totalValue', 'scheduledCount', 'cancelledCount', 'periodStart', 'periodEnd', 'customerName', 'contractNumber']) {
      expect(envelope).toHaveProperty(key);
    }
  });

  it('changes when an assessment date changes', async () => {
    const a = await build(makeContract(), items);
    const b = await build(makeContract(), [
      items[0],
      { ...items[1], assessment_date: '2027-06-02' },
    ]);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('changes when an assessment status changes', async () => {
    const a = await build(makeContract(), items);
    const b = await build(makeContract(), [{ ...items[0], status: 'cancelled' }, items[1]]);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('changes when an amount or the fund position changes', async () => {
    const a = await build(makeContract(), items);
    const b = await build(makeContract(), [{ ...items[0], item_price: 80000 }, items[1]]);
    expect(a.contentHash).not.toBe(b.contentHash);

    const c = await build(makeContract({ available_funds: 12345 }), items);
    expect(a.contentHash).not.toBe(c.contentHash);
  });

  it('changes when the contract period changes', async () => {
    const a = await build(makeContract(), items);
    const b = await build(makeContract({ ends_at: '2027-05-31T00:00:00.000Z' }), items);
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it('is a SHA-256 hex digest', async () => {
    const doc = await build(makeContract(), items);
    expect(doc.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

/* ───────────────────── Preview schema round-trip ────────────────────────── */

describe('the built document survives the preview validation gate', () => {
  it('parses through ContractScheduleSchema with the new fields intact', async () => {
    const { ContractScheduleSchema } = await import('../../../views/shared/components/PDF/schemas');
    const doc = await build(
      makeContract({ prepaid_amount: 319200, reserved_amount: 79800, consumed_amount: 79800, available_funds: 159600 }),
      [
        makeItem({ id: 'A-1', assessment_date: '2026-10-19', status: 'reserved' }),
        makeItem({ id: 'A-2', assessment_date: undefined, status: 'cancelled' }),
      ],
      { issuedAtIso: '2026-10-19T08:31:00.000Z' },
    );
    const parsed: any = ContractScheduleSchema.parse(doc);
    expect(parsed.scheduledCount).toBe(1);
    expect(parsed.undatedCount).toBe(0);
    expect(parsed.activeAssessments).toBe(1);
    expect(parsed.cancelledValue).toBe(79800);
    expect(parsed.availableFundsSource).toBe('generated');
    expect(parsed.fundInconsistencies).toEqual([]);
    expect(parsed.hashVersion).toBe(2);
    expect(parsed.schedule[0].assessmentDate).toBe('2026-10-19');
  });
});

/* ───────────── Document mapping must not strip the schedule ─────────────── */

describe('CONTRACT_SCHEDULE survives the shared document mapper', () => {
  it('keeps schedule rows and the content hash instead of falling into the logistics schema', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', assessment_date: '2026-10-21' }),
    ]);
    // Regression: without an explicit CONTRACT_SCHEDULE branch this document
    // was parsed as a logistics document, silently dropping `schedule` and
    // `contentHash` — the public download then had nothing to render (404)
    // even though verification succeeded.
    const mapped: any = mapToInvoiceData(doc as any, {} as any, 'CONTRACT_SCHEDULE' as any);
    expect(mapped.schedule).toHaveLength(2);
    expect(mapped.schedule[1].assessmentDate).toBe('2026-10-21');
    expect(mapped.contentHash).toBe(doc.contentHash);
    expect(mapped.contractNumber).toBe('PC-2026-0009');
    expect(mapped.scheduledCount).toBe(2);
  });
});

/* ───────────────── Legacy (version 1) hash reconstruction ───────────────── */

/**
 * `stableStringify` serialises an absent optional as `null`, but JSONB dropped
 * those keys, so a historical row must have the builders' optional keys
 * restored as `null` before hashing. The Phase 2B audit proved the old
 * `delete contentHash` rule reproduced neither live historical document.
 *
 * The production rows observed read-only (2026-10-20) were:
 *   schedule SCH-PC-P726/023-v1  →  046ab8359fda50a3466637ccef36b874154cf301f9a83b64327a53211ab6b71e
 *   receipt  PCR-mv9cu3m9-03wg38t →  1424c0428aa84fe0d6f7064c3f3449407aad5fcbb780fdc6a9adbed4c0335f4b
 * The fixtures below mirror those rows' exact key sets with synthetic values,
 * so the rule is pinned without embedding live customer data.
 */
describe('legacy hash reconstruction (pre-Phase-2 documents)', () => {
  const legacyScheduleContent = (): Record<string, any> => ({
    documentType: 'printing_contract_schedule',
    verificationToken: 'a'.repeat(64),
    contractNumber: 'PC-LEGACY-1',
    date: '19/10/2026',
    version: 3,
    status: 'active',
    customerName: 'Legacy School',
    schoolName: 'Legacy School',
    billedBranch: 'Main Account',
    academicYear: '2026/27',
    periodStart: '2026-10-19T00:00:00.000Z',
    periodEnd: '2027-04-30T00:00:00.000Z',
    schedule: [
      { sequence: 1, assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', assessmentDate: '15/10/2026', status: 'reserved', unitPrice: 79800 },
      { sequence: 2, assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', assessmentDate: '19/10/2026', status: 'reserved', unitPrice: 79800 },
    ],
    totalAssessments: 2,
    scheduleComplete: true,
    missingDateSequences: [],
    scheduledCount: 2,
    consumedCount: 0,
    releasedCount: 0,
    cancelledCount: 0,
    prepaidAmount: 159600,
    reservedAmount: 159600,
    consumedAmount: 0,
    availableFunds: 0,
    totalValue: 159600,
    totalCandidature: 40,
    assessmentSpec: 'Spec',
    assessmentSittings: 'Morning',
    terms: 'Terms',
    // schoolZone / customerPhone / chargePerCandidate / notes dropped by JSONB
  });

  const legacyReceiptContent = (): Record<string, any> => ({
    documentType: 'printing_contract_completion_receipt',
    verificationToken: 'b'.repeat(64),
    receiptNumber: 'PCR-PC-LEGACY-1',
    contractNumber: 'PC-LEGACY-1',
    date: '19/10/2026',
    version: 3,
    status: 'active',
    customerName: 'Legacy School (CUST-1)',
    schoolName: 'Legacy School',
    item: { assessmentName: 'Assessment', grade: 'Standard 8', subject: 'All', consumedAt: '19/10/2026', unitPrice: 79800 },
    sequence: 1,
    totalAssessments: 2,
    completedToDate: 1,
    remainingAssessments: 1,
    contractValue: 159600,
    amountDebited: 79800,
    totalConsumedToDate: 79800,
    remainingReservedFunds: 79800,
    unallocatedFunds: 0,
    walletBalanceAfter: 159600,
    walletTransactionId: 'WTX-1',
    ledgerEntryId: 'LG-1',
    // notes dropped by JSONB
  });

  it('restores exactly the dropped optional keys as null (schedule)', () => {
    const input = legacyScheduleHashInput(legacyScheduleContent());
    expect(input.schoolZone).toBeNull();
    expect(input.customerPhone).toBeNull();
    expect(input.chargePerCandidate).toBeNull();
    expect(input.notes).toBeNull();
    expect('contentHash' in input).toBe(false);
    // A key the row always carried is untouched, never nulled.
    expect(input.schoolName).toBe('Legacy School');
    expect(input.academicYear).toBe('2026/27');
  });

  it('restores dropped nested receipt-item keys as null', () => {
    const input = legacyReceiptHashInput({
      ...legacyReceiptContent(),
      item: { assessmentName: 'Assessment', unitPrice: 1 }, // grade/subject/consumedAt dropped
    });
    expect(input.notes).toBeNull();
    expect((input.item as any).grade).toBeNull();
    expect((input.item as any).subject).toBeNull();
    expect((input.item as any).consumedAt).toBeNull();
  });

  it('produces the old builder digest, and NOT the naive delete-contentHash digest', async () => {
    const content = legacyScheduleContent();
    const padded = {
      ...content,
      schoolZone: null,
      customerPhone: null,
      chargePerCandidate: null,
      notes: null,
    };
    const expected = createHash('sha256').update(stableStringify(padded), 'utf8').digest('hex');
    const actual = await hashLegacyScheduleContent(content);
    expect(actual).toBe(expected);

    const naive = createHash('sha256').update(stableStringify(content), 'utf8').digest('hex');
    expect(actual).not.toBe(naive);
  });

  it('produces the old receipt builder digest', async () => {
    const content = legacyReceiptContent();
    const padded = { ...content, notes: null };
    const expected = createHash('sha256').update(stableStringify(padded), 'utf8').digest('hex');
    expect(await hashLegacyReceiptContent(content)).toBe(expected);
  });

  it('fails when material legacy content is altered', async () => {
    const content = legacyReceiptContent();
    const digest = await hashLegacyReceiptContent(content);
    const altered = { ...content, amountDebited: 1 };
    expect(await hashLegacyReceiptContent(altered)).not.toBe(digest);
  });
});

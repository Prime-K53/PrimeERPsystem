/**
 * scheduleExceptions.test.ts — the assessment schedule's disclosed exceptions
 * and its content-hash parity with the PERSISTED content.
 *
 * Three classes of defect are pinned here:
 *
 *   1. HASH PARITY (P0). `stableStringify` rendered an absent value as the
 *      literal `null`, but JSONB DROPS a key whose value is `undefined`. The
 *      builder therefore hashed a shape the verifier could never reproduce:
 *      every schedule with an absent optional field was born unverifiable —
 *      the public verification page called it altered, and the issuing device
 *      failed its own integrity check. The digest written at issue MUST equal
 *      the digest recomputed from the content as it is persisted.
 *
 *   2. DISCLOSED EXCEPTIONS. An assessment scheduled outside the contract
 *      period, and a price that disagrees with the agreed per-candidate
 *      pricing basis, are printed on the document verbatim — never corrected.
 *
 *   3. RELEASED IS A MOVEMENT, NOT AN ENTITLEMENT. A released assessment is
 *      still listed, but its value is no longer owed: it was returned to the
 *      available balance, so it is excluded from the schedule value and shown
 *      as a memo — never added to the balance.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { webcrypto } from 'node:crypto';
import {
  buildContractScheduleDoc,
  hashStableScheduleContent,
} from '../../../services/printingContractService';
import { ContractScheduleSchema } from '../../../views/shared/components/PDF/schemas';

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

const CONTRACT_ID = 'PC-SCH-X';

const makeContract = (over: any = {}) => ({
  id: CONTRACT_ID,
  company_id: 'CO-1',
  customer_id: 'CUST-1',
  school_id: 'SCH-1',
  contract_number: 'PC-2026-0042',
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
    schoolName: 'Mankhamba Zone',
    ...extra,
  });

describe('content hash parity with the persisted content', () => {
  it('digests the content exactly as it is persisted', async () => {
    // A contract with NO optional profile fields: every optional key is
    // absent, so JSONB drops it while the pre-serialisation document still
    // carried it. This is the shape that used to break verification.
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
    ]);
    const persisted = JSON.parse(JSON.stringify(ContractScheduleSchema.parse(doc)));
    const recomputed = await hashStableScheduleContent(persisted);
    expect(recomputed).toBe(doc.contentHash);
  });

  it('digests identically when the issued identity is injected into the content', async () => {
    // The version identity is allocated AFTER the content is hashed, so it is
    // excluded from the digest. Injecting it must not change the digest.
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
    ]);
    const withIdentity = {
      ...(ContractScheduleSchema.parse(doc) as Record<string, unknown>),
      documentId: 'SCH-PC-SCH-X-v3',
      documentVersion: 3,
    };
    expect(await hashStableScheduleContent(withIdentity)).toBe(doc.contentHash);
  });

  it('keeps a clean schedule byte-identical, so no contract is re-issued', async () => {
    const items = [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', assessment_date: '2026-10-21' }),
    ];
    const contract = makeContract();
    const first = await build(contract, items);
    const second = await build(contract, items);
    expect(second.contentHash).toBe(first.contentHash);
    // Nothing to disclose → nothing added to the content.
    expect(first.outOfPeriodRows).toBeUndefined();
    expect(first.pricingMismatches).toBeUndefined();
    expect(first.releasedAmount).toBeUndefined();
    expect(JSON.parse(JSON.stringify(first))).toEqual(JSON.parse(JSON.stringify(second)));
  });
});

describe('scheduled dates against the contract period', () => {
  it('discloses an assessment scheduled after the period ends', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', assessment_date: '2027-06-01' }),
    ]);
    expect(doc.outOfPeriodRows).toHaveLength(1);
    expect(doc.outOfPeriodRows?.[0].assessmentDate).toBe('2027-06-01');
    expect(doc.outOfPeriodRows?.[0].reason).toBe('after_period_end');
  });

  it('discloses an assessment scheduled before the period starts', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-09-01' }),
    ]);
    expect(doc.outOfPeriodRows?.[0].reason).toBe('before_period_start');
  });

  it('compares calendar dates, never instants or display strings', async () => {
    // The contract stores the period as ISO instants; the assessment as an
    // instant too. The last day of the period is inside it.
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2027-04-30T00:00:00.000Z' }),
    ]);
    expect(doc.outOfPeriodRows).toBeUndefined();
  });

  it('reports nothing when every dated assessment falls inside the period', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', assessment_date: '2027-02-18' }),
    ]);
    expect(doc.outOfPeriodRows).toBeUndefined();
  });
});

describe('the pricing basis', () => {
  const priced = (over: any = {}) => makeContract({
    data: {
      total_candidature: 42,
      charge_per_candidate: 1900,
      pricing_rules: { model: 'per_candidate' },
      ...(over.data || {}),
    },
    ...over,
  });

  it('discloses a price that disagrees with candidature × charge', async () => {
    const doc = await build(priced(), [
      makeItem({ id: 'A-1', item_price: 79800, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', item_price: 90000, assessment_date: '2026-10-21' }),
    ]);
    expect(doc.pricingMismatches).toHaveLength(1);
    expect(doc.pricingMismatches?.[0]).toMatchObject({ expected: 79800, recorded: 90000 });
  });

  it('reports nothing when every price agrees with the basis', async () => {
    const doc = await build(priced(), [
      makeItem({ id: 'A-1', item_price: 79800, assessment_date: '2026-10-19' }),
    ]);
    expect(doc.pricingMismatches).toBeUndefined();
  });

  it('does not apply the basis to a contract priced another way', async () => {
    const doc = await build(priced({
      data: { total_candidature: 42, charge_per_candidate: 1900, pricing_rules: { model: 'per_line' } },
    }), [
      makeItem({ id: 'A-1', item_price: 90000, assessment_date: '2026-10-19' }),
    ]);
    expect(doc.pricingMismatches).toBeUndefined();
  });

  it('does not apply the basis when the contract records no pricing basis', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', item_price: 90000, assessment_date: '2026-10-19' }),
    ]);
    expect(doc.pricingMismatches).toBeUndefined();
  });
});

describe('a released assessment is a movement, not an entitlement', () => {
  it('excludes the released value from the schedule value and reports it', async () => {
    const doc = await build(makeContract({
      prepaid_amount: 1000000,
      reserved_amount: 0,
      consumed_amount: 400000,
      data: { closure: { status: 'closed', releasedValue: 600000 } },
    }), [
      makeItem({ id: 'A-1', status: 'consumed', item_price: 400000, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'released', item_price: 600000, assessment_date: '2026-10-21' }),
    ]);
    // The schedule value is what the contract still owes.
    expect(doc.totalValue).toBe(400000);
    // The released value is disclosed, and it is already inside the balance.
    expect(doc.releasedAmount).toBe(600000);
    expect(doc.availableFunds).toBe(600000);
    expect(doc.consumedAmount).toBe(400000);
    expect(doc.fundPositionConsistent).toBe(true);
  });

  it('discloses a released total that disagrees with the recorded closure', async () => {
    const doc = await build(makeContract({
      prepaid_amount: 1000000,
      reserved_amount: 0,
      consumed_amount: 400000,
      data: { closure: { status: 'closed', releasedValue: 500000 } },
    }), [
      makeItem({ id: 'A-1', status: 'consumed', item_price: 400000, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'released', item_price: 600000, assessment_date: '2026-10-21' }),
    ]);
    expect(doc.fundPositionConsistent).toBe(false);
    expect(doc.fundInconsistencies.join(' ')).toMatch(/recorded closure release/i);
  });

  it('leaves an untouched contract value untouched', async () => {
    const doc = await build(makeContract(), [
      makeItem({ id: 'A-1', status: 'reserved', item_price: 239400, assessment_date: '2026-10-19' }),
      makeItem({ id: 'A-2', status: 'consumed', item_price: 79800, assessment_date: '2026-10-21' }),
    ]);
    expect(doc.totalValue).toBe(319200);
    expect(doc.releasedAmount).toBeUndefined();
  });
});

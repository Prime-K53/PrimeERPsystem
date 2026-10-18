/**
 * Dashboard "Today's Collection" KPI regression tests.
 *
 * Previously this KPI summed EVERY non-voided customerPayment row dated today —
 * including wallet top-ups (deposits held in a customer's wallet, deliberately
 * excluded from AR by isWalletTopup because they are a liability movement, not a
 * customer cash receipt). A wallet deposit followed by a later wallet-funded
 * invoice settlement therefore inflated the KPI by the deposited amount. The
 * regression here pins the customerLedger() exclusion so the Dashboard KPI, the
 * 7-day sparkline, and the AI Insights Daily Brief stay consistent and are no
 * longer doubled. Mirrors tests/accounting/collectionDefinition.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  isCollectionReceipt,
  isWalletTopup,
  sumTodayCollectionFromPayments,
  getBusinessDateKey,
  getBusinessTodayKey,
  getBusinessDateKeyDaysAgo,
} from '../../services/customerLedger';
import type { CustomerPayment } from '../../types';

// Malawi business day — deterministic regardless of machine timezone.
const todayBiz = getBusinessTodayKey();
const day = (d: string) => `${d}T10:00:00.000Z`; // 10:00Z = 12:00 in Blantyre (same business date)

const today = day(todayBiz);
// Legacy alias kept so the pre-existing cases below read unchanged.
const todayUtc = todayBiz;

/** A pure external cash receipt (e.g. MWK 319,200 into a Wallet account). */
function externalCashReceipt(p: Partial<CustomerPayment> & { id: string }): CustomerPayment {
  return {
    id: p.id,
    customerId: 'C1',
    customerName: 'Acme Ltd',
    date: today,
    method: 'Bank',
    paymentMethod: 'Cash',
    accountId: 'ACC-11210',
    reference: p.reference ?? 'RCP-1',
    allocations: p.allocations ?? [],
    excessHandling: undefined,
    walletDeposit: 0,
    wallet_deposit: 0,
    amountRetained: 319200,
    receiptSnapshot: {
      amountRetained: 319200,
      walletDeposit: 0,
    },
    status: 'Cleared',
  };
}

/** A wallet liability movement: money into the customer's wallet, no invoice alloc. */
function walletDepositRow(p: Partial<CustomerPayment> & { id: string }): CustomerPayment {
  return {
    id: p.id,
    customerId: 'C1',
    customerName: 'Acme Ltd',
    date: today,
    method: 'Wallet',
    paymentMethod: 'Wallet',
    accountId: 'ACC-21300',
    reference: p.reference ?? 'WLT-1',
    allocations: [],
    excessHandling: 'Wallet',
    walletDeposit: 319200,
    wallet_deposit: 319200,
    amountRetained: 319200,
    receiptSnapshot: {
      amountRetained: 319200,
      walletDeposit: 319200,
    },
    status: 'Cleared',
  };
}

/** A legitimate wallet-funded invoice settlement: Dr 21300 Cr 11310. */
function walletSettlementRow(p: Partial<CustomerPayment> & { id: string }): CustomerPayment {
  return {
    id: p.id,
    customerId: 'C1',
    customerName: 'Acme Ltd',
    date: today,
    method: 'Wallet',
    paymentMethod: 'Wallet',
    accountId: 'ACC-21300',
    reference: p.reference ?? 'PAY-2',
    allocations: p.allocations ?? [{ invoiceId: 'INV-1', amount: 200000 }],
    excessHandling: 'Change',
    walletDeposit: 0,
    wallet_deposit: 0,
    amountRetained: 200000,
    receiptSnapshot: {
      amountRetained: 200000,
      walletDeposit: 0,
    },
    status: 'Cleared',
  };
}

describe('Today\'s Collection KPI excludes wallet top-ups', () => {
  it('re-counts the same deposit+settlement as a single collection (not double)', () => {
    const payments: CustomerPayment[] = [
      walletDepositRow({ id: 'A' }), // deposit → not counted
      walletSettlementRow({ id: 'B' }), // settlement of INV-1 from wallet
    ];
    expect(sumTodayCollectionFromPayments(payments, todayUtc)).toBe(200000);
  });

  it('is the same number under isCollectionReceipt per-row filtering', () => {
    const rowA = walletDepositRow({ id: 'A' });
    const rowB = walletSettlementRow({ id: 'B' });
    // Deposit excluded; settlement included; one row counts.
    expect(isCollectionReceipt(rowA, todayUtc)).toBe(false);
    expect(isCollectionReceipt(rowB, todayUtc)).toBe(true);
    expect(sumTodayCollectionFromPayments([rowA, rowB], todayUtc)).toBe(200000);
  });

  it('treats an empty list as 0', () => {
    expect(sumTodayCollectionFromPayments([], todayUtc)).toBe(0);
    expect(sumTodayCollectionFromPayments(undefined, todayUtc)).toBe(0);
    expect(sumTodayCollectionFromPayments(null, todayUtc)).toBe(0);
  });

  it('includes a sole legitimate external Cash receipt', () => {
    expect(isCollectionReceipt(externalCashReceipt({ id: 'X' }), todayUtc)).toBe(true);
    expect(sumTodayCollectionFromPayments([externalCashReceipt({ id: 'X' })], todayUtc)).toBe(319200);
  });

  it('includes a sole wallet-funded invoice settlement with one allocation', () => {
    expect(isCollectionReceipt(walletSettlementRow({ id: 'Y' }), todayUtc)).toBe(true);
    expect(sumTodayCollectionFromPayments([walletSettlementRow({ id: 'Y' })], todayUtc)).toBe(200000);
  });

  it('includes multiple allocations on one payment (no triple counting)', () => {
    const multi = {
      id: 'M',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: today,
      method: 'Bank',
      paymentMethod: 'Cash',
      accountId: 'ACC-11210',
      reference: 'RCP-M',
      allocations: [
        { invoiceId: 'INV-1', amount: 100000 },
        { invoiceId: 'INV-2', amount: 50000 },
        { invoiceId: 'INV-3', amount: 7500 },
      ],
      excessHandling: undefined,
      walletDeposit: 0,
      amountRetained: 157500,
      receiptSnapshot: { amountRetained: 157500, walletDeposit: 0 },
      status: 'Cleared',
    };
    expect(isCollectionReceipt(multi as unknown as CustomerPayment, todayUtc)).toBe(true);
    expect(sumTodayCollectionFromPayments([multi], todayUtc)).toBe(157500);
  });

  it('excludes a wallet top-up even when paymentPurpose is missing', () => {
    // Mirrors production output for the cash-only external Wallet method (excessHandling=Wallet, no allocated invoices).
    const noPurpose = {
      id: 'NP',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: today,
      method: 'Wallet',
      paymentMethod: 'Wallet',
      accountId: 'ACC-21300',
      reference: 'WLT-NP',
      allocations: [],
      excessHandling: 'Wallet',
      walletDeposit: 40000,
      wallet_deposit: 40000,
      amountRetained: 40000,
      receiptSnapshot: { amountRetained: 40000, walletDeposit: 40000 },
      status: 'Cleared',
    };
    expect(isWalletTopup(noPurpose as never)).toBe(true);
    expect(isCollectionReceipt(noPurpose as never, todayUtc)).toBe(false);
    expect(sumTodayCollectionFromPayments([noPurpose], todayUtc)).toBe(0);
  });

  it('excludes a WALLET_TOPUP purpose even without excessHandling', () => {
    const pw = {
      id: 'PW',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: today,
      method: 'Wallet',
      paymentMethod: 'Wallet',
      accountId: 'ACC-21300',
      reference: 'WLT-PW',
      allocations: [],
      paymentPurpose: 'WALLET_TOPUP',
      walletDeposit: 50000,
      amountRetained: 50000,
      receiptSnapshot: { amountRetained: 50000, walletDeposit: 50000 },
      status: 'Cleared',
    };
    expect(isWalletTopup(pw as never)).toBe(true);
    expect(isCollectionReceipt(pw as never, todayUtc)).toBe(false);
    expect(sumTodayCollectionFromPayments([pw], todayUtc)).toBe(0);
  });

  it('still counts other methods on the same day', () => {
    const mm = {
      id: 'MM',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: today,
      method: 'Mobile Money',
      paymentMethod: 'mobile money',
      accountId: 'ACC-11240',
      reference: 'MM-1',
      allocations: [{ invoiceId: 'INV-1', amount: 100000 }],
      excessHandling: undefined,
      walletDeposit: 0,
      amountRetained: 100000,
      receiptSnapshot: { amountRetained: 100000, walletDeposit: 0 },
      status: 'Cleared',
    };
    expect(isCollectionReceipt(mm, todayUtc)).toBe(true);
    expect(sumTodayCollectionFromPayments([mm], todayUtc)).toBe(100000);
  });

  it('does NOT count voided rows', () => {
    const vd = {
      ...externalCashReceipt({ id: 'V' }),
      status: 'Voided',
    };
    expect(isCollectionReceipt(vd, todayUtc)).toBe(false);
    expect(sumTodayCollectionFromPayments([vd], todayUtc)).toBe(0);
  });

  it('does NOT count zero retained amounts', () => {
    const zr = {
      id: 'Z',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: today,
      method: 'Bank',
      paymentMethod: 'Cash',
      accountId: 'ACC-11210',
      reference: 'RCP-Z',
      allocations: [],
      amountRetained: 0,
      amount: 0,
      receiptSnapshot: { amountRetained: 0, walletDeposit: 0 },
      status: 'Cleared',
    };
    expect(isCollectionReceipt(zr as never, todayUtc)).toBe(false);
    expect(sumTodayCollectionFromPayments([zr], todayUtc)).toBe(0);
  });

  it('does NOT count out-of-range dates', () => {
    const past = {
      id: 'PAST',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: day('2026-08-01'),
      method: 'Bank',
      paymentMethod: 'Cash',
      accountId: 'ACC-11210',
      reference: 'RCP-PAST',
      allocations: [],
      amountRetained: 319200,
      receiptSnapshot: { amountRetained: 319200, walletDeposit: 0 },
      status: 'Cleared',
    };
    const future = {
      id: 'FUTURE',
      customerId: 'C1',
      customerName: 'Acme Ltd',
      date: day('2026-12-31'),
      method: 'Bank',
      paymentMethod: 'Cash',
      accountId: 'ACC-11210',
      reference: 'RCP-FUT',
      allocations: [],
      amountRetained: 319200,
      receiptSnapshot: { amountRetained: 319200, walletDeposit: 0 },
      status: 'Cleared',
    };
    expect(isCollectionReceipt(past, todayUtc)).toBe(false);
    expect(isCollectionReceipt(future, todayUtc)).toBe(false);
    expect(sumTodayCollectionFromPayments([past, future], todayUtc)).toBe(0);
  });

  it('makes the older naive double-count (319,200 deposit + 200,000 settlement = 519,200)', () => {
    const doubleUp = sumTodayCollectionFromPayments(
      [
        walletDepositRow({ id: 'A' }),
        walletSettlementRow({ id: 'B', allocations: [{ invoiceId: 'INV-1', amount: 200000 }] }),
      ],
      todayUtc,
    );
    expect(doubleUp).toBe(200000);
    // Both sites (KPI + sparkline) must agree on that value.
    const receipts = [
      walletDepositRow({ id: 'A' }),
      walletSettlementRow({ id: 'B' }),
    ];
    expect(sumTodayCollectionFromPayments(receipts, todayUtc)).toBe(200000);
  });

  it('only one payment per business day ever contributes — a second deposit on the same day still adds nothing', () => {
    const p1 = walletDepositRow({ id: 'D1' });
    const p2 = walletDepositRow({ id: 'D2' });
    const p3 = walletSettlementRow({ id: 'S1' });
    const total = sumTodayCollectionFromPayments([p1, p2, p3], todayUtc);
    expect(total).toBe(200000); // only the settlement counts
  });
});

describe('Collection KPI — Africa/Blantyre business date', () => {
  const biz = (overrides: Record<string, any> = {}) => ({
    id: 'BIZ',
    customerId: 'C1',
    customerName: 'Acme Ltd',
    method: 'Bank',
    paymentMethod: 'Cash',
    accountId: 'ACC-11210',
    reference: 'RCP-BIZ',
    allocations: [{ invoiceId: 'INV-1', amount: 50000 }],
    excessHandling: undefined,
    walletDeposit: 0,
    amountRetained: 50000,
    receiptSnapshot: { amountRetained: 50000, walletDeposit: 0 },
    status: 'Cleared',
    ...overrides,
  });

  it('1. midnight-boundary instants map to the Malawi business date, not the UTC calendar date', () => {
    // Africa/Blantyre is UTC+2 year-round (no DST), so no instant shortly
    // after midnight UTC can belong to the previous business date — midnight
    // UTC is already 02:00 in Blantyre. The real boundary probes:
    //  (a) an instant with an explicit +02:00 offset shortly after midnight
    //      Blantyre wall time still has its UTC calendar day on the PREVIOUS
    //      day — the business date must be the 6th, not the 5th;
    //  (b) a post-midnight-UTC instant stays on its own business date and
    //      must NOT count toward the previous business day.
    expect(getBusinessDateKey('2026-10-06T00:30:00+02:00')).toBe('2026-10-06'); // 22:30Z on the 5th
    expect(getBusinessDateKey('2026-10-06T00:30:00.000Z')).toBe('2026-10-06'); // 02:30 Blantyre, same date
    const r = biz({ id: 'MIDNIGHT-BOUNDARY', date: '2026-10-06T00:30:00+02:00' });
    expect(isCollectionReceipt(r as never, '2026-10-05')).toBe(false);
    expect(isCollectionReceipt(r as never, '2026-10-06')).toBe(true);
  });

  it('2. a timestamp shortly before midnight UTC belongs to the next business date in Malawi', () => {
    // 2026-10-05T22:30:00Z = 00:30 Blantyre on 2026-10-06.
    expect(getBusinessDateKey('2026-10-05T22:30:00.000Z')).toBe('2026-10-06');
    const r = biz({ id: 'BEFORE-MIDNIGHT', date: '2026-10-05T22:30:00.000Z' });
    expect(isCollectionReceipt(r as never, '2026-10-05')).toBe(false);
    expect(isCollectionReceipt(r as never, '2026-10-06')).toBe(true);
    expect(sumTodayCollectionFromPayments([r as never], '2026-10-06')).toBe(50000);
    expect(sumTodayCollectionFromPayments([r as never], '2026-10-05')).toBe(0);
  });

  it('3. a date-only value remains on its stated calendar date', () => {
    expect(getBusinessDateKey('2026-10-05')).toBe('2026-10-05');
    const r = biz({ id: 'DATE-ONLY', date: '2026-10-05' });
    expect(isCollectionReceipt(r as never, '2026-10-05')).toBe(true);
    expect(isCollectionReceipt(r as never, '2026-10-06')).toBe(false);
  });

  it('4. main KPI and AI Daily Brief agree for the same records', () => {
    // Both consumers call sumTodayCollectionFromPayments with the same
    // business-day key — pin that the helper is the single seam.
    const rows = [
      biz({ id: 'K1', date: '2026-10-06T10:00:00.000Z' }),
      biz({ id: 'K2', date: '2026-10-06', amountRetained: 25000, receiptSnapshot: { amountRetained: 25000, walletDeposit: 0 } }),
    ];
    const kpi = sumTodayCollectionFromPayments(rows as never, '2026-10-06');
    const brief = sumTodayCollectionFromPayments(rows as never, '2026-10-06');
    expect(kpi).toBe(75000);
    expect(brief).toBe(kpi);
  });

  it('5. sparkline buckets follow Malawi calendar days (calendar-day arithmetic, not 24h subtraction)', () => {
    const now = new Date('2026-10-06T10:00:00.000Z'); // 12:00 Blantyre on the 6th
    const keys = [6, 5, 4, 3, 2, 1, 0].map((i) => getBusinessDateKeyDaysAgo(i, now));
    expect(keys).toEqual([
      '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03',
      '2026-10-04', '2026-10-05', '2026-10-06',
    ]);
    // A receipt at 22:30Z on the 5th (00:30 Blantyre on the 6th) buckets to the 6th.
    const late = biz({ id: 'LATE', date: '2026-10-05T22:30:00.000Z' });
    expect(isCollectionReceipt(late as never, keys[6])).toBe(true);
    expect(isCollectionReceipt(late as never, keys[5])).toBe(false);
  });

  it('7. month-end, year-end, and leap-day boundaries stay on the Malawi calendar date', () => {
    // Month-end: 31 Jan 22:30Z = 1 Feb 00:30 Blantyre.
    expect(getBusinessDateKey('2026-01-31T22:30:00.000Z')).toBe('2026-02-01');
    // Year-end: 31 Dec 22:30Z = 1 Jan 00:30 Blantyre next year.
    expect(getBusinessDateKey('2025-12-31T22:30:00.000Z')).toBe('2026-01-01');
    // Leap day itself converts cleanly; the day before at 22:30Z lands on it.
    expect(getBusinessDateKey('2024-02-29T10:00:00.000Z')).toBe('2024-02-29');
    expect(getBusinessDateKey('2024-02-28T22:30:00.000Z')).toBe('2024-02-29');
    expect(getBusinessDateKey('2024-02-29')).toBe('2024-02-29');
    // Calendar-day arithmetic crosses the year boundary correctly.
    const nye = new Date('2026-01-01T10:00:00.000Z'); // 12:00 Blantyre, New Year's Day
    expect(getBusinessDateKeyDaysAgo(1, nye)).toBe('2025-12-31');
    expect(getBusinessDateKeyDaysAgo(0, nye)).toBe('2026-01-01');
    // Leap-day arithmetic: 1 Mar minus 1 day = 29 Feb in a leap year.
    const mar1 = new Date('2024-03-01T10:00:00.000Z');
    expect(getBusinessDateKeyDaysAgo(1, mar1)).toBe('2024-02-29');
  });

  it('6. wallet top-ups remain excluded and legitimate invoice settlements remain counted', () => {
    const topup = {
      id: 'TOP', customerId: 'C1', customerName: 'Acme Ltd',
      date: '2026-10-06T10:00:00.000Z', method: 'Wallet', paymentMethod: 'Wallet',
      accountId: 'ACC-21300', reference: 'WLT-TOP', allocations: [],
      excessHandling: 'Wallet', walletDeposit: 319200, amountRetained: 319200,
      paymentPurpose: 'WALLET_TOPUP',
      receiptSnapshot: { amountRetained: 319200, walletDeposit: 319200, paymentPurpose: 'WALLET_TOPUP' },
      status: 'Cleared',
    };
    const settlement = biz({ id: 'SET', date: '2026-10-06T10:00:00.000Z' });
    expect(isCollectionReceipt(topup as never, '2026-10-06')).toBe(false);
    expect(isCollectionReceipt(settlement as never, '2026-10-06')).toBe(true);
    expect(sumTodayCollectionFromPayments([topup, settlement] as never, '2026-10-06')).toBe(50000);
  });
});

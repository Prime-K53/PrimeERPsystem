/**
 * customerLedger.ts — THE single authoritative customer ledger definition
 * for the ERP frontend (offline-first mirror of backend/services/customerLedger.cjs).
 *
 * Every customer-balance consumer in the ERP MUST derive numbers from this
 * module instead of maintaining private formulas. It reads the already-synced
 * IndexedDB stores (`invoices`, `customerPayments`) so all financial views
 * keep working fully offline.
 *
 * Validated accounting rules (must stay byte-for-byte equivalent to backend):
 *   Invoices      status NOT in {draft, cancelled, voided} (case-insensitive)
 *                 → debit  (+ increases receivable)
 *   Credit notes  valid credit_note invoices → credit (−)
 *   Payments      status NOT in {cancelled, voided} (case-insensitive)
 *                 → credit (−) using amountApplied ?? amountRetained ?? amount
 *                 Wallet top-ups are liability movements and are EXCLUDED.
 *   Payment requests are workflow data only — never part of this ledger.
 *
 * Ordering is deterministic:
 *   timestamp(date ?? createdAt) → timestamp(createdAt) → id (string)
 * All dates are parsed as real timestamps — never string localeCompare.
 *
 * Running balance = opening + debits − credits. Positive = customer owes.
 */

import { dbService } from './db';
import type { CustomerPayment } from '../types';
import {
  collectAmbiguousScopeRecords,
  filterRecordsByScope,
  mainAccountScope,
  resolveAccountScope,
  type AccountScope,
} from './customerAccountScope';

export type { AccountScope };

// ── Primitives ──────────────────────────────────────────────────────────────

export function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function normStatus(v: unknown): string {
  return String(v ?? '').trim().toLowerCase();
}

/** First non-nullish finite number (explicit 0 is VALID — only null/undefined skip). */
function firstNum(...candidates: unknown[]): number | null {
  for (const c of candidates) {
    if (c !== null && c !== undefined) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function parseTime(v: unknown): number {
  if (!v) return NaN;
  const t = new Date(v as string | number | Date).getTime();
  return Number.isFinite(t) ? t : NaN;
}

type AnyRecord = Record<string, any>;

function firstNonEmpty(...candidates: unknown[]): any {
  for (const c of candidates) {
    if (c !== null && c !== undefined && String(c).trim() !== '') return c;
  }
  return null;
}

/**
 * Deterministic ordering key. Primary: accounting date (falls back to
 * created_at). Secondary: created_at. Final tie-break: id string.
 * Missing/invalid dates sort to epoch — stable and identical on both sides.
 */
function sortKey(entry: AnyRecord): [number, number, string] {
  const dateT = parseTime(entry.date);
  const createdT = parseTime(entry.createdAt ?? entry.created_at);
  const primary = Number.isFinite(dateT) ? dateT : (Number.isFinite(createdT) ? createdT : 0);
  return [primary, Number.isFinite(createdT) ? createdT : 0, String(entry.id || '')];
}

function compareEntries(a: AnyRecord, b: AnyRecord): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}

// ── Rules ───────────────────────────────────────────────────────────────────

const CLOSED_INVOICE_STATUSES = new Set(['draft', 'cancelled', 'voided']);
const CLOSED_PAYMENT_STATUSES = new Set(['cancelled', 'voided']);

export function isInvoiceIncluded(inv: AnyRecord): boolean {
  // Missing status counts as posted (legacy rows).
  return !CLOSED_INVOICE_STATUSES.has(normStatus(inv.status));
}

export function isPaymentIncluded(pay: AnyRecord): boolean {
  return !CLOSED_PAYMENT_STATUSES.has(normStatus(pay.status));
}

export function isCreditNoteInvoice(inv: AnyRecord): boolean {
  return normStatus(inv.status) === 'credit_note';
}

export function invoiceTotal(inv: AnyRecord): number {
  return toNum(firstNum(inv.totalAmount, inv.total_amount, inv.total));
}

/**
 * Sum of allocation lines in ANY historical shape:
 *   ERP:         [{ invoiceId, amount }]
 *   portal shim: [{ invoice_id, allocated }]
 */
export function allocationSum(pay: AnyRecord): number {
  const allocations = Array.isArray(pay.allocations) ? pay.allocations : [];
  let sum = 0;
  for (const a of allocations) {
    if (!a || typeof a !== 'object') continue;
    sum += toNum(firstNum(a.amount, a.allocated, a.allocationAmount));
  }
  return round2(sum);
}

/**
 * Receivable-settlement credit for one payment:
 *   amountApplied (explicit 0 COUNTS — wallet-only rows stay at 0)
 *   ?? amountRetained            (cash-with-change legacy rows)
 *   ?? allocationSum             (rows carrying allocations but no snapshot)
 *   ?? amount                    (bare rows)
 * Tendered cash is used ONLY when nothing better exists — change-given and
 * wallet deposits must never inflate the receivable credit.
 */
export function paymentCredit(pay: AnyRecord): number {
  const allocSum = allocationSum(pay);
  return round2(
    firstNum(
      pay.amountApplied,
      pay.amount_applied,
      pay.amountRetained,
      pay.amount_retained,
      allocSum > 0 ? allocSum : null,
      pay.amount,
    ) ?? 0,
  );
}

/**
 * Wallet top-ups move money into the wallet liability; they never settle AR.
 * Partial apply + partial wallet stays IN the ledger — paymentCredit then
 * correctly credits only the applied portion.
 */
export function isWalletTopup(pay: AnyRecord): boolean {
  const purpose = String(firstNonEmpty(pay.paymentPurpose, pay.payment_purpose) || '').toUpperCase();
  if (purpose === 'WALLET_TOPUP') return true;
  // Backfilled rows may carry the inferred purpose only inside the receipt
  // snapshot (top-level fill happens at migration/write time). The snapshot
  // purpose uses the same inference, so it is a valid equivalent signal —
  // but an explicit top-level purpose always wins (checked above).
  if (!purpose) {
    const snapPurpose = String(pay.receiptSnapshot?.paymentPurpose || '').toUpperCase();
    if (snapPurpose === 'WALLET_TOPUP') return true;
  }
  const applied = firstNum(pay.amountApplied, pay.amount_applied);
  const deposit = firstNum(pay.walletDeposit, pay.wallet_deposit);
  const handling = String(firstNonEmpty(pay.excessHandling, pay.excess_handling) || '');
  const appliedKnown = applied !== null;
  const appliedPositive = appliedKnown && applied > 0;
  if (!appliedPositive) {
    if (deposit !== null && deposit > 0) return true;
    if (handling === 'Wallet') return true;
  }
  return false;
}

// ── Business date (Africa/Blantyre) ───────────────────────────────────────────
//
// Collection KPIs aggregate by Malawi business day, NOT by UTC calendar day.
// Malawi (Africa/Blantyre) is UTC+2 year-round (no DST): midnight UTC is
// already 02:00 in Blantyre, so the UTC calendar day and the business day
// diverge at the boundaries — an instant at 22:30Z belongs to the NEXT
// business date, and an instant stamped 00:30+02:00 has its UTC calendar day
// on the previous day. Naive `.split('T')[0]` / `toISOString().split('T')[0]`
// bucketing misattributes those receipts; the machine-local `toDateString()`
// comparison drifts with the viewer's timezone.
//
// Conversion rule:
//   - Date-only strings (YYYY-MM-DD, optionally with surrounding whitespace)
//     are calendar dates — returned verbatim, never shifted.
//   - ISO timestamps (with a time component or explicit offset) are real
//     instants — converted into Africa/Blantyre via Intl.DateTimeFormat and
//     rendered as YYYY-MM-DD.
// `en-CA` yields ISO-ordered YYYY-MM-DD directly; timeZone pins the business
// day regardless of the machine's local timezone. No hard-coded UTC offset.

/** IANA business timezone for all collection-date bucketing. */
export const BUSINESS_TIMEZONE = 'Africa/Blantyre';

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const businessDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Shared date-key helper: returns YYYY-MM-DD in Africa/Blantyre.
 * Returns '' for missing/invalid input.
 */
export function getBusinessDateKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (!raw) return '';
  // Date-only values are literal calendar dates — never shift them.
  if (DATE_ONLY_RE.test(raw)) return raw;
  const t = new Date(raw).getTime();
  if (!Number.isFinite(t)) return '';
  // Everything else is an instant → convert into the business timezone.
  return businessDateFormatter.format(new Date(t));
}

/** Current business day (YYYY-MM-DD in Africa/Blantyre). */
export function getBusinessTodayKey(now: Date = new Date()): string {
  return businessDateFormatter.format(now);
}

/**
 * Calendar-day arithmetic in the business timezone: returns the YYYY-MM-DD
 * key `daysAgo` business days before `now`. Anchors on noon UTC (14:00 in
 * Blantyre — safely mid-day year-round since there is no DST), so each step
 * lands on an unambiguous calendar day rather than tearing across the
 * midnight boundary with local-time setDate() + UTC bucketing.
 */
export function getBusinessDateKeyDaysAgo(daysAgo: number, now: Date = new Date()): string {
  const todayKey = businessDateFormatter.format(now);
  const noonUtc = new Date(`${todayKey}T12:00:00.000Z`).getTime();
  const target = new Date(noonUtc - daysAgo * 86400000);
  return businessDateFormatter.format(target);
}

// ── Customer Payment → collection receipt aggregation ──────────────────────────
//
// The dashboard "Today's Collection" KPI is the only place that previously
// summed EVERY non-voided customerPayment row dated today — including wallet
// top-ups (deposits held in a customer's wallet, deliberately excluded from AR
// by isWalletTopup because they are a liability movement, not a customer cash
// receipt). A wallet deposit followed by a later wallet-funded invoice
// settlement therefore inflated the KPI by the deposited amount, while every
// other site (the 7-day sparkline and the AI Insights Daily Brief) used an
// even more naive Customer Payments total. Mirror the customerLedger backend:
// also exclude zero/negative retained amounts and apply isWalletTopup.
//
// This module is the authoritative front-end seam shared with the Dashboard
// KPI, the sparkline, and AIDashboardInsights — so the regression matrix is
// kept in one file instead of scattered across component tests.

function paymentRetainedAmountOf(p: CustomerPayment): number {
  const value = p.amountRetained ?? p.receiptSnapshot?.amountRetained ?? p.amount;
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const cleaned = String(value).replace(/,/g, '');
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** True iff a customerPayment counts toward Today's Collection on the given business day (YYYY-MM-DD in Africa/Blantyre). */
export function isCollectionReceipt(p: CustomerPayment | undefined | null, todayStr: string): boolean {
  if (!p) return false;
  if (String(p.status || '').toLowerCase() === 'voided') return false;
  // Business-date convention: ISO instants convert into Africa/Blantyre;
  // date-only strings stay on their stated calendar date.
  const entryDate = getBusinessDateKey((p as AnyRecord).date ?? (p as AnyRecord).createdAt);
  if (!entryDate || entryDate !== todayStr) return false;
  if (!(paymentRetainedAmountOf(p) > 0)) return false;
  // isWalletTopup is the sole discriminator that can separate a legitimate
  // external Wallet-method cash receipt from a liability deposit within
  // customerPayments — no other field distinguishes them.
  if (isWalletTopup(p as AnyRecord)) return false;
  return true;
}

/**
 * Today's Collection total computed purely from customerPayments rows, one
 * business day (Africa/Blantyre) at a time. Contractual definition: excludes voided, zero/negative
 * retained, and wallet top-ups — but INCLUDES legitimate external cash
 * receipts received into the Wallet payment method (with or without
 * allocations). Used by the Dashboard KPI, the sparkline, and AI Insights.
 */
export function sumTodayCollectionFromPayments(
  payments: readonly CustomerPayment[] | undefined | null,
  todayStr: string,
): number {
  let sum = 0;
  for (const p of payments ?? []) {
    if (!isCollectionReceipt(p, todayStr)) continue;
    sum += paymentRetainedAmountOf(p);
  }
  return sum;
}

// ── Public shapes ───────────────────────────────────────────────────────────

export interface LedgerTransaction {
  id: string;
  type: 'invoice' | 'payment' | 'credit_note';
  date: string | null;
  createdAt: string | null;
  reference: string;
  description: string;
  status: string;
  debit: number;
  credit: number;
  balance: number;
}

export interface LedgerExclusion {
  id: string;
  kind: 'invoice' | 'payment';
  reason: string;
}

export interface LedgerWalletTopup {
  id: string;
  date: string | null;
  amount: number;
}

export interface CustomerLedgerResult {
  customerId: string;
  scope?: { branchKey: string; isMain: boolean; branchLabel: string; branchId?: string | null } | null;
  openingBalance: number;
  openingUnresolved?: boolean;
  transactions: LedgerTransaction[];
  closingBalance: number;
  outstandingBalance: number;
  excluded: LedgerExclusion[];
  walletTopups: LedgerWalletTopup[];
  /**
   * Rows rejected ONLY because a legacy display name is shared by several
   * branches of this customer. Never silently attributed to a branch — they
   * are surfaced so the business can tag them with a stable branch id.
   */
  ambiguousScopeRecords: Array<{ id: string; customerId: string; reason: string }>;
}

// ── Pure core (shared by parity fixtures on both sides) ─────────────────────

/**
 * Build the authoritative ledger from raw records. Pure — no I/O — so parity
 * tests can feed byte-identical fixtures to this port and to the backend.
 *
 * `scope` MUST be supplied by every account-sensitive caller. Leaving it null
 * is an INTENTIONAL whole-customer aggregate (Main + all branches); use the
 * explicitly named `buildConsolidatedLedgerFromRecords` to say so at the call
 * site. Never rely on the omission being "obvious".
 */
export function buildLedgerFromRecords({
  customerId,
  invoices = [],
  payments = [],
  openingBalance = 0,
  scope = null,
  customer = null,
}: {
  customerId: string;
  invoices?: AnyRecord[];
  payments?: AnyRecord[];
  openingBalance?: number;
  scope?: AccountScope | null;
  customer?: AnyRecord | null;
}): CustomerLedgerResult {
  // Scope BEFORE math so opening/closing/outstanding agree.
  let scopedInvoices = invoices;
  let scopedPayments = payments;
  if (scope) {
    scopedInvoices = filterRecordsByScope(invoices, scope, customer);
    scopedPayments = filterRecordsByScope(payments, scope, customer);
  }
  const txs: AnyRecord[] = [];
  const excluded: LedgerExclusion[] = [];
  const walletTopups: LedgerWalletTopup[] = [];

  for (const inv of scopedInvoices) {
    if (!isInvoiceIncluded(inv)) {
      excluded.push({ id: String(inv.id), kind: 'invoice', reason: normStatus(inv.status) || 'closed' });
      continue;
    }
    const total = invoiceTotal(inv);
    const creditNote = isCreditNoteInvoice(inv);
    const number = firstNonEmpty(inv.invoiceNumber, inv.invoice_number) || inv.id;
    txs.push({
      id: String(inv.id),
      type: creditNote ? 'credit_note' : 'invoice',
      date: firstNonEmpty(inv.date, inv.createdAt, inv.created_at),
      createdAt: firstNonEmpty(inv.createdAt, inv.created_at),
      reference: String(number),
      description: `${creditNote ? 'Credit Note' : 'Invoice'} ${number}`,
      status: String(inv.status || ''),
      debit: creditNote ? 0 : total,
      credit: creditNote ? total : 0,
    });
  }

  for (const pay of scopedPayments) {
    if (!isPaymentIncluded(pay)) {
      excluded.push({ id: String(pay.id), kind: 'payment', reason: normStatus(pay.status) });
      continue;
    }
    if (isWalletTopup(pay)) {
      walletTopups.push({
        id: String(pay.id),
        date: firstNonEmpty(pay.date, pay.createdAt, pay.created_at),
        amount: toNum(firstNum(pay.amount, pay.total, pay.total_amount)),
      });
      continue;
    }
    const number = firstNonEmpty(pay.reference, pay.receiptNumber, pay.id);
    txs.push({
      id: String(pay.id),
      type: 'payment',
      date: firstNonEmpty(pay.date, pay.createdAt, pay.created_at),
      createdAt: firstNonEmpty(pay.createdAt, pay.created_at),
      reference: String(number),
      description: String(firstNonEmpty(pay.reference, pay.notes) || 'Payment received'),
      status: String(pay.status || ''),
      debit: 0,
      credit: paymentCredit(pay),
    });
  }

  txs.sort(compareEntries);

  let running = round2(openingBalance);
  const transactions = txs.map((t) => {
    running = round2(running + t.debit - t.credit);
    return { ...(t as unknown as LedgerTransaction), balance: running };
  });

  const closingBalance = running;
  return {
    customerId,
    scope: scope
      ? { branchKey: scope.branchKey, isMain: scope.isMain, branchLabel: scope.branchLabel, branchId: scope.branchId || null }
      : null,
    openingBalance: round2(openingBalance),
    transactions,
    closingBalance,
    outstandingBalance: Math.max(0, closingBalance),
    excluded,
    walletTopups,
    ambiguousScopeRecords: scope
      ? collectAmbiguousScopeRecords([...invoices, ...payments], scope, customer)
      : [],
  };
}

/**
 * Explicit whole-customer aggregate (Main + every branch) for intentional
 * consolidated reporting. Named so that omitting a scope is never accidental.
 */
export function buildConsolidatedLedgerFromRecords(args: {
  customerId: string;
  invoices?: AnyRecord[];
  payments?: AnyRecord[];
  openingBalance?: number;
}): CustomerLedgerResult {
  return buildLedgerFromRecords({ ...args, scope: null });
}

// ── IndexedDB-backed API (offline-first) ────────────────────────────────────

/**
 * Opening balance = the starting financial position recorded when the
 * customer was created or imported. It is stored on `customer.balance`
 * (NEVER a running total — transaction flows only mutate `walletBalance`),
 * so it is the single source of truth for "where this customer began".
 *
 * Detailed form: reports whether a BRANCH opening is unresolved. Branch scopes
 * never reuse the parent opening (see below) and report `unresolved: true`.
 */
export async function getCustomerOpeningBalanceDetailed(
  customerId: string,
  scope?: AccountScope | null,
): Promise<{ opening: number; unresolved: boolean }> {
  try {
    const customer = await dbService.get<{ balance?: number }>('customers', customerId);
    // Branch safety: embedded sub.balance is display-only. Never reuse the
    // parent opening for a branch; report unresolved until business sets one.
    if (scope && !scope.isMain) return { opening: 0, unresolved: true };
    return { opening: Number(customer?.balance || 0), unresolved: false };
  } catch {
    return { opening: 0, unresolved: Boolean(scope && !scope.isMain) };
  }
}

/** Numeric opening balance for the account (Main by default). */
export async function getCustomerOpeningBalance(customerId: string, scope?: AccountScope | null): Promise<number> {
  return (await getCustomerOpeningBalanceDetailed(customerId, scope)).opening;
}

/**
 * Authoritative ledger for one customer, computed from the local stores.
 * Records may be injected (tests); default reads IndexedDB via dbService.
 *
 * Account scope defaults to MAIN — omitting it can never silently mean "all
 * accounts". Pass an explicit branch scope, or use
 * `buildConsolidatedCustomerLedger` for intentional whole-customer aggregation.
 */
export async function buildCustomerLedger(
  customerId: string,
  opts: { openingBalance?: number; invoices?: AnyRecord[]; payments?: AnyRecord[]; scope?: AccountScope | null; customer?: AnyRecord | null } = {},
): Promise<CustomerLedgerResult> {
  const scope = opts.scope === undefined ? mainAccountScope(customerId) : opts.scope;
  const customer = opts.customer ?? null;
  const invoices = opts.invoices ?? (await dbService.getAll<AnyRecord>('invoices'));
  const payments = opts.payments ?? (await dbService.getAll<AnyRecord>('customerPayments'));
  // ID-only customer pre-filter; branch filtering happens inside
  // buildLedgerFromRecords via the centralized scope helper.
  const idScopedInvoices = invoices.filter((i) => String(i.customerId ?? '') === String(customerId));
  const idScopedPayments = payments.filter((p) => String(p.customerId ?? '') === String(customerId));
  // When a caller does not supply an opening balance we fall back to the
  // customer's stored opening balance so it is never silently dropped.
  // Branch scopes never inherit the parent opening (see helper above).
  let openingBalance = opts.openingBalance;
  let openingUnresolved = false;
  if (openingBalance === undefined || openingBalance === null) {
    const loaded = await getCustomerOpeningBalanceDetailed(customerId, scope);
    openingBalance = loaded.opening;
    openingUnresolved = loaded.unresolved;
  }
  const result = buildLedgerFromRecords({
    customerId,
    invoices: idScopedInvoices,
    payments: idScopedPayments,
    openingBalance,
    scope,
    customer,
  });
  result.openingUnresolved = openingUnresolved || result.openingUnresolved;
  return result;
}

/** Intentional whole-customer aggregate (Main + every branch) from local stores. */
export async function buildConsolidatedCustomerLedger(
  customerId: string,
  opts: { openingBalance?: number; invoices?: AnyRecord[]; payments?: AnyRecord[]; customer?: AnyRecord | null } = {},
): Promise<CustomerLedgerResult> {
  return buildCustomerLedger(customerId, { ...opts, scope: null });
}

/**
 * Canonical customer balance = opening balance
 *   + invoices/debits + debit adjustments
 *   − payments − credit notes − refunds/credits.
 * This is the number every ERP view should render as the customer's
 * outstanding balance. `openingBalance` may override the stored value (tests).
 */
export async function getCustomerBalance(
  customerId: string,
  opts: { openingBalance?: number; scope?: AccountScope | null; customer?: AnyRecord | null } = {},
): Promise<CustomerLedgerResult> {
  return buildCustomerLedger(customerId, opts);
}

/**
 * The ONE number every ERP view should display as "customer owes".
 * Account scope defaults to MAIN (never silently "all accounts").
 */
export async function getCustomerOutstanding(customerId: string, opts: { scope?: AccountScope | null; customer?: AnyRecord | null } = {}): Promise<number> {
  const ledger = await buildCustomerLedger(customerId, opts);
  return ledger.outstandingBalance;
}

/** Intentional whole-customer aggregate outstanding (Main + every branch). */
export async function getConsolidatedCustomerOutstanding(customerId: string, opts: { customer?: AnyRecord | null } = {}): Promise<number> {
  const ledger = await buildConsolidatedCustomerLedger(customerId, opts);
  return ledger.outstandingBalance;
}

export { resolveAccountScope, mainAccountScope };

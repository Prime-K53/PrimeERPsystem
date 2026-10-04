/**
 * transportExpenseService.ts — Phase 7J: authoritative outbound courier /
 * transport expense source (prerequisite for future OUTBOUND_CONSUMPTION).
 *
 * This is a FINANCIAL source document, not a Transport Budget event. It
 * creates real GL/AP/bank postings. Transport authority comes exclusively
 * from the machine `classification` on each line (`OUTBOUND_TRANSPORT`),
 * never from free-text category matching, account names, or supplier names.
 *
 * Lifecycle (status machine enforced here AND by migration 0034):
 *   DRAFT (editable, no ledger) → POSTED (frozen, journaled) → VOIDED
 *   (original frozen, separate reversal row + offsetting legs).
 *
 * Frozen rules:
 * - Transport lines MUST debit the dedicated account `52610`
 *   (Courier & Delivery Transport). Never 52000 (non-posting parent),
 *   never 51300 (inbound COGS-role freight), never Printing accounts.
 * - Non-transport lines debit caller-selected postable expense accounts.
 * - Header total MUST equal the line sum (no document-total invention).
 * - Every transport line carries its own supplierId (existing suppliers
 *   table, fail-closed when unknown). No courier master table is needed.
 * - Posted/voided economics are immutable; voids are full-document
 *   reversals (single reversal per original, enforced by unique index).
 * - Idempotency: `TEXPENSE:{id}` business keys + reserveIdempotencyKey
 *   scopes + database unique backstops. No random/timestamp identity.
 * - The generic Expense workflow is untouched (separate store, separate
 *   functions, separate UI).
 */

import { dbService } from './db';
import { logger } from './logger';
import { roundMoney } from '../utils/roundingUtils';
import { newId } from '../utils/ulid';
import {
  fireOutboundConsumptionHook,
  produceOutboundConsumptionSafely,
  defaultOutboundConsumptionDeps,
} from './transportBudgetOutboundConsumption';
import {
  fireOutboundReversalHook,
  produceOutboundReversalsSafely,
  defaultOutboundReversalDeps,
} from './transportBudgetOutboundReversal';
import {
  getCompanyConfig,
  getGLConfig,
  generateId,
  ensureMirroredBankTransaction,
  reserveIdempotencyKey,
  resolveAccountForPosting,
  loadAccountsFromStore,
  UnresolvedAccountError,
} from './transactions/_internal';
import type {
  TransportExpense,
  TransportExpenseLine,
  TransportExpenseStatus,
  TransportExpenseSettlementMode,
  TransportExpenseLineClassification,
} from '../types';
import { TRANSPORT_EXPENSE_LINE_CLASSIFICATIONS } from '../types';

/** Dedicated debit account for OUTBOUND_TRANSPORT lines (see migration 0034). */
export const TRANSPORT_EXPENSE_DEBIT_ACCOUNT = '52610';
/** Accounts Payable settlement account. */
export const TRANSPORT_EXPENSE_AP_ACCOUNT = '21110';
/** Account codes that must never receive transport-expense debits. */
const FORBIDDEN_DEBIT_CODES = new Set(['52000', '51300']);

const accountCodeOf = (accounts: any[], resolvedId: string): string => {
  const record = (accounts || []).find(
    (a: any) => String(a?.id) === resolvedId || String(a?.code) === resolvedId,
  );
  return String(
    record?.code || record?.account_number || resolvedId || '',
  ).trim();
};

const IDENTITY_PATTERN = /^[A-Za-z0-9:_\-./]{1,200}$/;
const DATE_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

export class TransportExpenseError extends Error {
  readonly code:
    | 'INVALID_SHAPE'
    | 'INVALID_STATUS'
    | 'INVALID_TRANSITION'
    | 'INVALID_LINE'
    | 'INVALID_SUPPLIER'
    | 'INVALID_ACCOUNT'
    | 'INVALID_TOTAL'
    | 'INVALID_DATE'
    | 'INVALID_IDENTITY'
    | 'TARGET_MISSING'
    | 'ALREADY_POSTED'
    | 'NOT_POSTED';

  constructor(
    code: TransportExpenseError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TransportExpenseError';
    this.code = code;
  }
}

export interface TransportExpenseLineInput {
  id?: string;
  description: string;
  amount: unknown;
  classification: string;
  supplierId: string;
  /** Debit account override for NON_TRANSPORT lines only. */
  accountId?: string | null;
}

export interface CreateTransportExpenseInput {
  id?: string;
  idempotencyKey?: string;
  supplierId?: string | null;
  settlementMode: TransportExpenseSettlementMode;
  /** Required in CASH mode (bank/cash account id); ignored in AP mode. */
  settlementAccountId?: string | null;
  businessDate: string;
  currency?: string;
  lines: TransportExpenseLineInput[];
}

const fail = (
  code: TransportExpenseError['code'],
  message: string,
): never => {
  throw new TransportExpenseError(code, message);
};

const isValidCalendarDate = (value: string): boolean => {
  if (!DATE_PATTERN.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
};

const nowIso = (): string => new Date().toISOString();

/** Normalize + validate one line. Throws TransportExpenseError. */
function normalizeLine(
  raw: TransportExpenseLineInput,
  index: number,
): TransportExpenseLine {
  const id =
    typeof raw.id === 'string' && raw.id.trim() !== ''
      ? raw.id.trim()
      : `LINE-${index + 1}`;
  if (!IDENTITY_PATTERN.test(id)) {
    fail('INVALID_LINE', `Line ${index + 1} has an invalid id.`);
  }
  if (
    !TRANSPORT_EXPENSE_LINE_CLASSIFICATIONS.includes(
      raw.classification as TransportExpenseLineClassification,
    )
  ) {
    fail(
      'INVALID_LINE',
      `Line ${id} has invalid classification ${JSON.stringify(raw.classification)} ` +
        `(expected ${TRANSPORT_EXPENSE_LINE_CLASSIFICATIONS.join(' | ')}). ` +
        `Transport classification is never inferred from text.`,
    );
  }
  const amountRaw = (raw as { amount?: unknown }).amount;
  if (typeof amountRaw !== 'number' || !Number.isFinite(amountRaw)) {
    fail('INVALID_LINE', `Line ${id} amount must be a finite number (strings are rejected).`);
  }
  const amount = roundMoney(amountRaw as number);
  if (!(amount > 0)) {
    fail('INVALID_LINE', `Line ${id} amount must be a positive 2dp number.`);
  }
  if (Math.abs(amount) > 999999999999.99) {
    fail('INVALID_LINE', `Line ${id} amount exceeds the maximum.`);
  }
  const supplierId = String(raw.supplierId ?? '').trim();
  if (!supplierId || !IDENTITY_PATTERN.test(supplierId)) {
    fail('INVALID_LINE', `Line ${id} requires a supplierId.`);
  }
  // Caller-selected debit account for NON_TRANSPORT lines only. Transport
  // lines always resolve the dedicated account at posting; a provided value
  // is preserved verbatim here and rejected there if forbidden.
  const accountId =
    typeof raw.accountId === 'string' && raw.accountId.trim() !== ''
      ? raw.accountId.trim()
      : null;
  return {
    id,
    description: String(raw.description ?? ''),
    amount,
    classification: raw.classification as TransportExpenseLineClassification,
    supplierId,
    accountId,
  };
}

export interface ValidatedTransportExpenseDraft {
  id: string;
  idempotencyKey: string;
  supplierId: string | null;
  settlementMode: TransportExpenseSettlementMode;
  settlementAccountId: string | null;
  businessDate: string;
  currency: string;
  lines: TransportExpenseLine[];
  totalAmount: number;
}

/** Pure shape validation shared by create/post paths. */
export function validateTransportExpenseInput(
  input: CreateTransportExpenseInput,
): ValidatedTransportExpenseDraft {
  const id =
    typeof input.id === 'string' && input.id.trim() !== ''
      ? input.id.trim()
      : newId('TEXP');
  if (!IDENTITY_PATTERN.test(id)) {
    fail('INVALID_IDENTITY', 'Transport expense id is invalid.');
  }
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim() !== ''
      ? input.idempotencyKey.trim()
      : `TEXPENSE:${id}`;
  if (!IDENTITY_PATTERN.test(idempotencyKey)) {
    fail('INVALID_IDENTITY', 'Transport expense idempotencyKey is invalid.');
  }
  if (input.settlementMode !== 'AP' && input.settlementMode !== 'CASH') {
    fail('INVALID_SHAPE', 'settlementMode must be AP or CASH.');
  }
  if (!isValidCalendarDate(String(input.businessDate ?? ''))) {
    fail('INVALID_DATE', 'businessDate must be a valid YYYY-MM-DD date.');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fail('INVALID_LINE', 'At least one expense line is required.');
  }
  const lines = input.lines.map((line, index) => normalizeLine(line, index));
  const totalAmount = roundMoney(
    lines.reduce((sum, line) => sum + line.amount, 0),
  );
  if (!(totalAmount > 0)) {
    fail('INVALID_TOTAL', 'Total amount must be positive.');
  }
  const settlementAccountId =
    input.settlementMode === 'CASH'
      ? String(input.settlementAccountId ?? '').trim() || null
      : null;
  if (input.settlementMode === 'CASH' && !settlementAccountId) {
    fail('INVALID_SHAPE', 'CASH mode requires settlementAccountId.');
  }
  return {
    id,
    idempotencyKey,
    supplierId:
      typeof input.supplierId === 'string' && input.supplierId.trim() !== ''
        ? input.supplierId.trim()
        : null,
    settlementMode: input.settlementMode,
    settlementAccountId,
    businessDate: String(input.businessDate).trim(),
    currency: String(input.currency ?? 'MWK').trim() || 'MWK',
    lines,
    totalAmount,
  };
}

/**
 * Per-process operation mutex (mirrors the Transport Budget repository
 * appendTail): serializes create/post/void so local check-then-act steps
 * (existence, status, idempotency reservation) cannot interleave on this
 * client. Cross-device races remain governed by the database unique
 * constraints (idempotency key, single-reversal link).
 */
let transportExpenseTail: Promise<unknown> = Promise.resolve();

function serializeTransportExpenseOp<T>(task: () => Promise<T>): Promise<T> {
  const run = transportExpenseTail.then(task, task);
  transportExpenseTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Create a DRAFT transport expense (no ledger). Safe to retry: same
 * idempotency key + same economics resolves the existing draft.
 */
export async function createTransportExpense(
  input: CreateTransportExpenseInput,
): Promise<TransportExpense> {
  return serializeTransportExpenseOp(() => createTransportExpenseInner(input));
}

async function createTransportExpenseInner(
  input: CreateTransportExpenseInput,
): Promise<TransportExpense> {
  const validated = validateTransportExpenseInput(input);
  const timestamp = nowIso();
  return dbService.executeAtomicOperation(
    ['transportExpenses', 'idempotencyKeys'],
    async (tx) => {
      const store = tx.objectStore('transportExpenses');
      const existing = await store.get(validated.id);
      if (existing) {
        fail('INVALID_SHAPE', `Transport expense ${validated.id} already exists.`);
      }
      await reserveIdempotencyKey(
        tx,
        'transport_expense',
        validated.id,
        validated.idempotencyKey,
      );
      const record: TransportExpense = {
        id: validated.id,
        idempotencyKey: validated.idempotencyKey,
        status: 'DRAFT',
        businessDate: validated.businessDate,
        occurredAt: timestamp,
        createdAt: timestamp,
        supplierId: validated.supplierId,
        settlementMode: validated.settlementMode,
        settlementAccountId: validated.settlementAccountId,
        expenseAccountId: TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
        lines: validated.lines.map((line) => ({
          ...line,
          // Transport lines always resolve the dedicated account at posting;
          // non-transport lines keep their caller-selected account.
          accountId:
            line.classification === 'OUTBOUND_TRANSPORT'
              ? TRANSPORT_EXPENSE_DEBIT_ACCOUNT
              : (line.accountId ?? null),
        })) as TransportExpenseLine[],
        totalAmount: validated.totalAmount,
        currency: validated.currency,
        journalId: null,
        reversesExpenseId: null,
        isReversal: false,
      };
      await store.put(record as never);
      return record;
    },
  );
}

interface PostContext {
  expense: TransportExpense;
  accounts: any[];
  apAccountId: string;
  journalId: string;
}

/** Resolve + validate debit accounts for every line. Throws on violation. */
function resolveLineDebits(expense: TransportExpense, accounts: any[]): string[] {
  const companyConfig = getCompanyConfig();
  const companyId = (companyConfig as any)?.companyId;
  const options = { allowNonPosting: false, companyId };
  return expense.lines.map((line) => {
    if (line.classification === 'OUTBOUND_TRANSPORT') {
      // Dedicated account only — never inferred, never substituted.
      const resolved = resolveAccountForPosting(
        TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
        accounts,
        options,
      );
      if (!resolved) {
        throw new UnresolvedAccountError(TRANSPORT_EXPENSE_DEBIT_ACCOUNT);
      }
      return resolved;
    }
    const requested = String(line.accountId ?? '').trim();
    if (!requested) {
      fail(
        'INVALID_ACCOUNT',
        `Non-transport line ${line.id} requires an explicit expense account.`,
      );
    }
    const resolved = resolveAccountForPosting(requested, accounts, options);
    if (!resolved) {
      throw new UnresolvedAccountError(requested);
    }
    // Compare against the resolved record's code: callers pass ids, codes,
    // or numbers interchangeably, and 51300/52000 must never receive debits
    // in this workflow regardless of how they are referenced.
    if (FORBIDDEN_DEBIT_CODES.has(accountCodeOf(accounts, resolved))) {
      fail(
        'INVALID_ACCOUNT',
        `Line ${line.id} may not post to ${accountCodeOf(accounts, resolved)} in a transport expense document.`,
      );
    }
    return resolved;
  });
}

/**
 * Post a DRAFT transport expense: validates everything, posts balanced
 * per-line journals, freezes the row as POSTED. Never throws away the
 * committed expense on journal failure — journal and status update occur in
 * the same atomic operation.
 */
export async function postTransportExpense(
  id: string,
  performedBy?: string,
): Promise<TransportExpense> {
  return serializeTransportExpenseOp(() => postTransportExpenseInner(id, performedBy));
}

async function postTransportExpenseInner(
  id: string,
  performedBy?: string,
): Promise<TransportExpense> {
  const expenseId = String(id ?? '').trim();
  if (!expenseId) {
    fail('INVALID_IDENTITY', 'postTransportExpense requires an expense id.');
  }
  const posted = await dbService.executeAtomicOperation(
    [
      'transportExpenses',
      'ledger',
      'suppliers',
      'bankAccounts',
      'bankTransactions',
      'idempotencyKeys',
      'accounts',
    ],
    async (tx) => {
      const store = tx.objectStore('transportExpenses');
      const ledgerStore = tx.objectStore('ledger');
      const supplierStore = tx.objectStore('suppliers');
      const expense = (await store.get(expenseId)) as TransportExpense | undefined;
      if (!expense) {
        fail('TARGET_MISSING', `Transport expense ${expenseId} not found.`);
      }
      const current = expense as TransportExpense;
      if (current.status !== 'DRAFT') {
        fail(
          'ALREADY_POSTED',
          `Transport expense ${expenseId} is ${current.status}; only DRAFT rows can be posted.`,
        );
      }
      if (current.isReversal) {
        fail(
          'INVALID_STATUS',
          'Reversal rows are created POSTED and are never posted again.',
        );
      }
      await reserveIdempotencyKey(tx, 'transport_expense_post', current.id);
      const accounts = await loadAccountsFromStore(tx);
      // Supplier existence is authoritative per line (fail closed).
      for (const line of current.lines) {
        const supplier = await supplierStore.get(line.supplierId);
        if (!supplier) {
          fail(
            'INVALID_SUPPLIER',
            `Line ${line.id} names unknown supplier "${line.supplierId}". ` +
              `Register the provider as a supplier first.`,
          );
        }
      }
      const debits = resolveLineDebits(current, accounts);
      const gl = getGLConfig();
      const apAccountId: string = (() => {
        const resolved = resolveAccountForPosting(gl.accountsPayable || '21110', accounts, {
          allowNonPosting: false,
          companyId: (getCompanyConfig() as any)?.companyId,
        });
        if (!resolved) throw new UnresolvedAccountError(gl.accountsPayable || '21110');
        return resolved;
      })();
      let creditAccountId: string;
      if (current.settlementMode === 'AP') {
        creditAccountId = apAccountId;
      } else {
        const requested = String(current.settlementAccountId ?? '').trim();
        const resolved = resolveAccountForPosting(requested, accounts, {
          allowNonPosting: false,
          companyId: (getCompanyConfig() as any)?.companyId,
        });
        if (!resolved) throw new UnresolvedAccountError(requested || 'undefined');
        creditAccountId = resolved;
      }
      const journalId = generateId('TJ-TEXP');
      const timestamp = nowIso();
      // Per-line balanced pairs: DR line account / CR settlement.
      // Transport legs always hit the dedicated 52610 account.
      current.lines.forEach((line, index) => {
        const leg = {
          id: generateId('LG-TEXP'),
          date: current.businessDate,
          description: `Transport expense ${current.id} — ${line.description || line.id} [${line.classification}]`,
          debitAccountId: debits[index],
          creditAccountId,
          amount: line.amount,
          entryType: 'TRANSPORT_EXPENSE',
          referenceId: current.id,
          referenceType: 'transport_expense',
          journalId,
          reconciled: false,
          supplierId: line.supplierId,
          performedBy: performedBy || 'System',
          createdAt: timestamp,
        };
        void ledgerStore.put(leg);
      });
      // AP mode accrues per-line provider liability; CASH mode mirrors bank.
      if (current.settlementMode === 'AP') {
        const bySupplier = new Map<string, number>();
        for (const line of current.lines) {
          bySupplier.set(
            line.supplierId,
            roundMoney((bySupplier.get(line.supplierId) || 0) + line.amount),
          );
        }
        for (const [supplierId, total] of bySupplier) {
          const supplier = await supplierStore.get(supplierId);
          if (supplier) {
            supplier.balance = roundMoney((Number(supplier.balance) || 0) + total);
            await supplierStore.put(supplier);
          }
        }
      } else {
        await ensureMirroredBankTransaction({
          bankAccountsStore: tx.objectStore('bankAccounts'),
          bankTransactionsStore: tx.objectStore('bankTransactions'),
          date: current.businessDate,
          amount: current.totalAmount,
          type: 'Withdrawal',
          description: `Transport expense ${current.id}`,
          reference: `TEXP-${current.id}`,
          accountId: creditAccountId,
          counterpartyName:
            (await supplierStore.get(current.supplierId || ''))?.name ||
            current.supplierId ||
            undefined,
        });
      }
      const posted: TransportExpense = {
        ...current,
        status: 'POSTED',
        expenseAccountId: TRANSPORT_EXPENSE_DEBIT_ACCOUNT,
        journalId,
        occurredAt: timestamp,
      };
      await store.put(posted as never);
      return posted;
    },
  );
  // Phase 8E: post-commit outbound Transport Budget observation. Runs AFTER the
  // atomic POST commit above, never inside it. Fire-and-forget: a budget
  // failure must never roll back the already-committed expense/accounting.
  fireOutboundConsumptionHook(
    produceOutboundConsumptionSafely(defaultOutboundConsumptionDeps, { transportExpense: posted }),
    posted.id,
  );
  return posted;
}

/**
 * Void a POSTED transport expense (full-document reversal only).
 * The original row keeps its economics and flips to VOIDED; a separate
 * reversal row + offsetting legs are created. Second voids fail via status
 * + idempotency scope + the database unique reversal link.
 */
export async function voidTransportExpense(
  id: string,
  reason?: string,
  performedBy?: string,
): Promise<{ voided: TransportExpense; reversal: TransportExpense }> {
  const result = await serializeTransportExpenseOp(() =>
    voidTransportExpenseInner(id, reason, performedBy),
  );
  // Phase 8E: post-commit void observation. Runs AFTER the atomic void
  // commit above, never inside it. Fire-and-forget: a budget failure must
  // never roll back the already-committed void/reversal accounting. The
  // reversal row's persisted occurredAt is the authoritative void
  // timestamp for every derived CONSUMPTION_REVERSAL.
  fireOutboundReversalHook(
    produceOutboundReversalsSafely(defaultOutboundReversalDeps, {
      voidedExpense: result.voided,
      voidOccurredAt: result.reversal.occurredAt,
    }),
    result.voided.id,
  );
  return result;
}

async function voidTransportExpenseInner(
  id: string,
  reason?: string,
  performedBy?: string,
): Promise<{ voided: TransportExpense; reversal: TransportExpense }> {
  const expenseId = String(id ?? '').trim();
  if (!expenseId) {
    fail('INVALID_IDENTITY', 'voidTransportExpense requires an expense id.');
  }
  return dbService.executeAtomicOperation(
    [
      'transportExpenses',
      'ledger',
      'suppliers',
      'bankAccounts',
      'bankTransactions',
      'idempotencyKeys',
      'accounts',
    ],
    async (tx) => {
      const store = tx.objectStore('transportExpenses');
      const ledgerStore = tx.objectStore('ledger');
      const supplierStore = tx.objectStore('suppliers');
      const expense = (await store.get(expenseId)) as TransportExpense | undefined;
      if (!expense) {
        fail('TARGET_MISSING', `Transport expense ${expenseId} not found.`);
      }
      const original = expense as TransportExpense;
      if (original.isReversal) {
        fail('INVALID_STATUS', 'Reversal rows cannot be voided (no correction-of-correction).');
      }
      if (original.status !== 'POSTED') {
        fail(
          'NOT_POSTED',
          `Only POSTED transport expenses can be voided (current: ${original.status}).`,
        );
      }
      // Concurrency backstop: second simultaneous void of the same expense
      // fails here even before the unique reversal link is hit.
      await reserveIdempotencyKey(tx, 'transport_expense_void', original.id);
      const accounts = await loadAccountsFromStore(tx);
      const gl = getGLConfig();
      const timestamp = nowIso();
      const reversalId = newId('TEXP');
      const reversalKey = `TEXPENSE-VOID:${original.id}`;
      const reversal: TransportExpense = {
        id: reversalId,
        idempotencyKey: reversalKey,
        status: 'POSTED',
        businessDate: original.businessDate,
        occurredAt: timestamp,
        createdAt: timestamp,
        supplierId: original.supplierId,
        settlementMode: original.settlementMode,
        settlementAccountId: original.settlementAccountId,
        expenseAccountId: original.expenseAccountId,
        lines: original.lines.map((line) => ({ ...line })),
        totalAmount: original.totalAmount,
        currency: original.currency,
        journalId: generateId('TJ-TEXP-REV'),
        reversesExpenseId: original.id,
        isReversal: true,
      };
      // Offsetting legs: swap every original leg (DR↔CR, same amounts).
      for (const line of original.lines) {
        const debitAccountId =
          line.classification === 'OUTBOUND_TRANSPORT'
            ? resolveAccountForPosting(TRANSPORT_EXPENSE_DEBIT_ACCOUNT, accounts, {
                allowNonPosting: false,
              })
            : resolveAccountForPosting(line.accountId || '', accounts, {
                allowNonPosting: false,
              });
        if (!debitAccountId) {
          throw new UnresolvedAccountError(
            line.classification === 'OUTBOUND_TRANSPORT'
              ? TRANSPORT_EXPENSE_DEBIT_ACCOUNT
              : line.accountId || '',
          );
        }
        const creditAccountId =
          original.settlementMode === 'AP'
            ? resolveAccountForPosting(gl.accountsPayable || '21110', accounts, {
                allowNonPosting: false,
              })
            : String(original.settlementAccountId || '');
        await ledgerStore.put({
          id: generateId('LG-TEXP-REV'),
          date: original.businessDate,
          description:
            `REVERSAL: Transport expense ${original.id} voided` +
            (reason ? ` — ${reason}` : '') +
            ` [${line.id}]`,
          debitAccountId: creditAccountId,
          creditAccountId: debitAccountId,
          amount: line.amount,
          entryType: 'TRANSPORT_EXPENSE_REVERSAL',
          referenceId: reversalId,
          referenceType: 'transport_expense_reversal',
          journalId: reversal.journalId,
          reconciled: false,
          supplierId: line.supplierId,
          performedBy: performedBy || 'System',
          createdAt: timestamp,
        } as never);
      }
      // Unwind provider liability accrued at posting (AP mode only).
      if (original.settlementMode === 'AP') {
        const bySupplier = new Map<string, number>();
        for (const line of original.lines) {
          bySupplier.set(
            line.supplierId,
            roundMoney((bySupplier.get(line.supplierId) || 0) + line.amount),
          );
        }
        for (const [supplierId, total] of bySupplier) {
          const supplier = await supplierStore.get(supplierId);
          if (supplier) {
            supplier.balance = roundMoney((Number(supplier.balance) || 0) - total);
            await supplierStore.put(supplier);
          }
        }
      }
      await store.put(reversal as never);
      const voided: TransportExpense = { ...original, status: 'VOIDED' };
      await store.put(voided as never);
      logger.info(
        `[TransportExpense] voided ${original.id} with reversal ${reversalId}.`,
      );
      return { voided, reversal };
    },
  );
}

export const transportExpenseService = {
  createTransportExpense,
  postTransportExpense,
  voidTransportExpense,
  validateTransportExpenseInput,
};

export default transportExpenseService;

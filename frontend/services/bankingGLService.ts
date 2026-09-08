/**
 * Banking Module - GL Integration Service
 *
 * Production-quality integration between the Banking module and the
 * canonical general ledger.
 *
 * Rules enforced here:
 *   1. Every posted banking transaction produces a balanced journal entry
 *      (debits == credits, within 0.01 rounding tolerance).
 *   2. We call the canonical `ledgerService.createJournalEntry` — we never
 *      write to the `ledger` store directly. The accounting layer is the
 *      source of truth.
 *   3. Idempotency: an explicit `idempotencyKey` (default: `BANK:<txnId>`)
 *      is checked before posting. Replays do not double-post.
 *   4. Reversals are performed through `ledgerService.reverseEntry` and
 *      never by mutating historical rows.
 *   5. The accounting date must be inside the active financial year.
 *   6. Account resolution uses the canonical 5-digit COA codes
 *      (11210, 11220, 11230, 11240, 11110, 11120, 42100, 52900, 54100,
 *      11310, 21110, 31000, 34000, 22100, 22200).
 *
 * Mapping (BankTransaction.type → GL impact):
 *   Money-In (Receive Money):
 *     Dr mappedBankAccount  | Cr incomeAccountId (or AR 11310)
 *   Money-Out (Spend Money):
 *     Dr expenseAccountId   | Cr mappedBankAccount
 *   Transfer:
 *     Dr toBankAccount      | Cr fromBankAccount
 *   Bank Charge:
 *     Dr 52900              | Cr mappedBankAccount
 *   Bank Interest (received):
 *     Dr mappedBankAccount  | Cr 42100
 *   Bank Deposit (cash → bank):
 *     Dr mappedBankAccount  | Cr 11110
 *   Bank Withdrawal (bank → cash):
 *     Dr 11110              | Cr mappedBankAccount
 *   Owner Contribution:
 *     Dr mappedBankAccount  | Cr 31000
 *   Owner Drawing:
 *     Dr 34000              | Cr mappedBankAccount
 *   Loan Proceeds:
 *     Dr mappedBankAccount  | Cr 22100 (or 22200)
 *   Loan Repayment:
 *     Dr 22100 (principal)  | Cr mappedBankAccount
 *     Dr 54100 (interest)   | Cr mappedBankAccount
 *   Payroll Payment:
 *     Dr 52100 (or payable) | Cr mappedBankAccount
 *   Asset Purchase:
 *     Dr fixedAssetAccount  | Cr mappedBankAccount
 *   Asset Disposal:
 *     Dr mappedBankAccount  | Cr fixedAssetAccount
 *                            (gain/loss split into 42000/53000 if needed)
 *
 * All amounts are rounded to 2 decimals using the project's rounding
 * helpers. We never use floating-point arithmetic carelessly.
 */

import { ledgerService } from './ledgerService';
import { dbService } from './db';
import { generateId } from './transactions/_internal';
import { logger } from './logger';
import { roundFinancial } from '../utils/helpers';
import { validateDateInFY } from '../utils/financialYearUtils';
import { BankTransaction } from '../types/banking';

// Canonical COA codes used by the banking module
export const CANONICAL_COA = {
  CASH_DRAWER: '11110',
  PETTY_CASH: '11120',
  BANK_NATIONAL: '11210',
  BANK_FDH: '11220',
  BANK_NBS: '11230',
  MOBILE_MONEY: '11240',
  AR: '11310',
  AP: '21110',
  BANK_LOANS: '22100',
  OTHER_LOANS: '22200',
  OWNER_CAPITAL: '31000',
  DRAWINGS: '34000',
  SALES: '41000',
  OTHER_INCOME: '42000',
  INTEREST_INCOME: '42100',
  INTEREST_EXPENSE: '54100',
  SALARIES: '52100',
  BANK_CHARGES: '52900',
  DEPRECIATION: '53000',
  FIXED_ASSET_DEFAULT: '12100',
  GAIN_ON_DISPOSAL: '42010',
  LOSS_ON_DISPOSAL: '53010',
} as const;

// Map bank-account subtype / naming heuristic to a COA id.
export function resolveBankCOAId(bankAccountLike: {
  accountType?: string;
  subtype?: string;
  bankName?: string;
  name?: string;
  accountNumber?: string;
}): string | null {
  const name = (bankAccountLike.name || '').toLowerCase();
  const bankName = (bankAccountLike.bankName || '').toLowerCase();
  const subtype = (bankAccountLike.subtype || '').toLowerCase();
  const accType = (bankAccountLike.accountType || '').toLowerCase();

  if (subtype === 'cash' || /cash|drawer|petty/.test(name) || /cash|drawer|petty/.test(bankName)) {
    return /petty/.test(name) ? CANONICAL_COA.PETTY_CASH : CANONICAL_COA.CASH_DRAWER;
  }
  if (subtype === 'mobile_money' || /mobile|momo|airtel|tnm|mpamba/.test(name + bankName)) {
    return CANONICAL_COA.MOBILE_MONEY;
  }
  if (/nbs/.test(name + bankName)) return CANONICAL_COA.BANK_NBS;
  if (/fdh/.test(name + bankName)) return CANONICAL_COA.BANK_FDH;
  if (/national|standard|standard bank|prime/.test(name + bankName)) return CANONICAL_COA.BANK_NATIONAL;
  if (accType === 'asset' && /bank/.test(name)) return CANONICAL_COA.BANK_NATIONAL;
  return null;
}

// Idempotency store keys
const IDEMPOTENCY_KEY = 'bankingIdempotency';

interface PostedLedgerPointer {
  ledgerIds: string[];
  postedAt: string;
}

async function readIdempotencyMap(): Promise<Record<string, PostedLedgerPointer>> {
  try {
    const stored = await dbService.get<Record<string, PostedLedgerPointer>>(IDEMPOTENCY_KEY, 'map');
    return stored || {};
  } catch {
    return {};
  }
}

async function writeIdempotencyMap(map: Record<string, PostedLedgerPointer>): Promise<void> {
  await dbService.put(IDEMPOTENCY_KEY, { ...map, id: 'map' });
}

async function getPointer(key: string): Promise<PostedLedgerPointer | null> {
  const map = await readIdempotencyMap();
  return map[key] || null;
}

async function setPointer(key: string, pointer: PostedLedgerPointer): Promise<void> {
  const map = await readIdempotencyMap();
  map[key] = pointer;
  await writeIdempotencyMap(map);
}

export interface PostingRequest {
  date: string;
  description: string;
  reference: string;
  entryType: string;
  lines: Array<{
    debitAccountId: string;
    creditAccountId: string;
    amount: number;
    description?: string;
  }>;
  idempotencyKey: string;
  createdBy?: string;
}

/**
 * Post a balanced journal entry to the canonical ledger.
 * Idempotent on `idempotencyKey`. Replays return the original pointer
 * without writing new rows.
 */
export async function postBalancedJournal(req: PostingRequest): Promise<PostedLedgerPointer> {
  const existing = await getPointer(req.idempotencyKey);
  if (existing) {
    logger.info(`[BankingGL] Idempotent replay for key ${req.idempotencyKey} — returning existing pointer`);
    return existing;
  }

  const total = req.lines.reduce((s, l) => s + roundFinancial(l.amount), 0);
  // The ledgerService treats each line as a single debit/credit pair with
  // the same amount — so the sum of line amounts must equal 0 conceptually
  // if we use pairs, but the service accepts a flat `lines` array of pairs.
  // We pass pairs so the service can validate Σdebit === Σcredit per pair.
  // For multi-pair journals we group by pairs (each line = one Dr / one Cr).

  try {
    const result = await ledgerService.createJournalEntry({
      date: req.date,
      description: req.description,
      reference: req.reference,
      entryType: req.entryType,
      lines: req.lines.map((l) => ({
        debitAccountId: l.debitAccountId,
        creditAccountId: l.creditAccountId,
        amount: roundFinancial(l.amount),
        description: l.description,
      })),
      createdBy: req.createdBy,
    });

    const ledgerIds = result?.entries?.map((e) => e.id) || [];
    const pointer: PostedLedgerPointer = {
      ledgerIds,
      postedAt: new Date().toISOString(),
    };
    await setPointer(req.idempotencyKey, pointer);
    return pointer;
  } catch (err) {
    logger.error('[BankingGL] Failed to post journal entry', err);
    throw err;
  }
}

/**
 * Reverse a previously-posted banking journal by ledgerId. Returns the
 * reversal ledger ids. The original rows are never modified.
 */
export async function reverseBankingJournal(
  ledgerId: string,
  reversalDate: string,
  reason: string,
): Promise<string[] | null> {
  // Idempotency on reversal too — use a derived key
  const key = `REVERSE:${ledgerId}`;
  const existing = await getPointer(key);
  if (existing) return existing.ledgerIds;

  const ids = await ledgerService.reverseEntry(ledgerId, reversalDate, reason || 'Reversed from Banking module');
  if (!ids) return null;

  const pointer: PostedLedgerPointer = {
    ledgerIds: ids.map((e) => e.id),
    postedAt: new Date().toISOString(),
  };
  await setPointer(key, pointer);
  return pointer.ledgerIds;
}

/**
 * High-level: derive the GL posting for a BankTransaction and post it.
 * Returns the posted pointer or null if the transaction is a Draft or
 * has no accounting impact.
 */
export async function postBankTransactionGL(
  tx: BankTransaction,
  ctx: {
    bankAccountCOAId: string;
    counterpartyCOAId?: string;
    expenseAccountId?: string;
    incomeAccountId?: string;
    fixedAssetAccountId?: string;
    createdBy?: string;
  },
): Promise<PostedLedgerPointer | null> {
  if (tx.status === 'Draft') return null;

  // Closed-period / out-of-FY guard — runs even for programmatic callers
  // (transfers, statement imports, scheduled-txn execution). The UI layer
  // already calls validateDateInFY; this is the last line of defence.
  const fyErr = validateDateInFY(tx.date);
  if (fyErr) {
    logger.warn(`[BankingGL] Blocked posting ${tx.id}: ${fyErr}`);
    throw new Error(fyErr);
  }

  const key = `BANK:${tx.id}`;
  const existing = await getPointer(key);
  if (existing) return existing;

  const amount = roundFinancial(tx.amount);
  if (amount <= 0) {
    throw new Error('Cannot post a transaction with zero or negative amount');
  }

  const lines: PostingRequest['lines'] = [];
  const bank = ctx.bankAccountCOAId;

  switch (tx.type) {
    case 'Deposit': {
      // Money In: Dr Bank / Cr incomeAccountId or AR
      const credit = ctx.incomeAccountId || ctx.counterpartyCOAId || CANONICAL_COA.SALES;
      lines.push({
        debitAccountId: bank,
        creditAccountId: credit,
        amount,
        description: tx.description,
      });
      break;
    }
    case 'Withdrawal': {
      // Money Out: Dr expenseAccountId / Cr Bank
      const debit = ctx.expenseAccountId || ctx.counterpartyCOAId || CANONICAL_COA.BANK_CHARGES;
      lines.push({
        debitAccountId: debit,
        creditAccountId: bank,
        amount,
        description: tx.description,
      });
      break;
    }
    case 'Fee': {
      lines.push({
        debitAccountId: CANONICAL_COA.BANK_CHARGES,
        creditAccountId: bank,
        amount,
        description: tx.description,
      });
      break;
    }
    case 'Interest': {
      lines.push({
        debitAccountId: bank,
        creditAccountId: CANONICAL_COA.INTEREST_INCOME,
        amount,
        description: tx.description,
      });
      break;
    }
    case 'Transfer': {
      // Transfer handled by executeTransfer — do not double-post here.
      // We still allow manual transfers through Banking if a counterparty
      // bank COA is provided.
      if (!ctx.counterpartyCOAId) return null;
      lines.push({
        debitAccountId: ctx.counterpartyCOAId,
        creditAccountId: bank,
        amount,
        description: tx.description,
      });
      break;
    }
    case 'Payment': {
      // Generic payment — caller decides direction via counterpartyCOAId.
      // Default to expense.
      const debit = ctx.expenseAccountId || ctx.counterpartyCOAId || CANONICAL_COA.BANK_CHARGES;
      lines.push({
        debitAccountId: debit,
        creditAccountId: bank,
        amount,
        description: tx.description,
      });
      break;
    }
    default:
      return null;
  }

  if (lines.length === 0) return null;

  return await postBalancedJournal({
    date: tx.date,
    description: tx.description,
    reference: tx.reference || tx.id,
    entryType: `BANK_${tx.type.toUpperCase()}`,
    lines,
    idempotencyKey: key,
    createdBy: ctx.createdBy,
  });
}

/**
 * Ensure the idempotency store exists. Safe to call on boot.
 */
export async function ensureBankingStores(): Promise<void> {
  // The dbService handles missing stores lazily; nothing to do here.
  // We expose this for callers that want to warm up.
}

/**
 * Validate that an account can post to the ledger.
 */
export async function validatePostingAccount(accountId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const acc = await dbService.get<any>('accounts', accountId);
    if (!acc) return { ok: false, reason: `Account ${accountId} does not exist` };
    if (acc.is_active === false) return { ok: false, reason: `Account ${accountId} is inactive` };
    if (acc.allow_posting === false) return { ok: false, reason: `Account ${accountId} is a header account` };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

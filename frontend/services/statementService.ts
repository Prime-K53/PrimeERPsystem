/**
 * statementService.ts — immutable customer statement snapshots.
 *
 * Statements are generated on the fly from live ledger data, so a bare
 * statement can never carry a permanent verification token: the "document"
 * would change every time the customer transacts. Instead, issuing a
 * statement snapshot freezes it:
 *
 *   ledger at issue time -> immutable snapshot (number + period + totals)
 *   -> verificationToken -> dbService persistence -> durable sync queue
 *   -> Supabase statement_snapshots -> PDF + QR
 *
 * The QR verifies THAT snapshot — never "whatever the customer's current
 * balance happens to be". Later activity cannot mutate it; a correction
 * marks the original SUPERSEDED (or VOID) and issues a new snapshot with
 * a new number + token. The original stays verifiable as SUPERSEDED.
 *
 * Offline-safe: snapshot creation is local-first through dbService (no
 * network required); the sync queue carries it to the cloud for public
 * verification. No accounting writes — read-only against the ledger.
 */
import { dbService } from './db';
import { ensureDocumentVerificationToken } from '../utils/documentVerification';
import { generateNextId } from '../utils/helpers';
import type { CompanyConfig, StatementSnapshot } from '../types';
import { logger } from './logger';

const STORE = 'statementSnapshots' as const;

export interface CreateStatementSnapshotInput {
  customerId: string;
  customerName: string;
  customerCode?: string;
  address?: string;
  phone?: string;
  email?: string;
  periodStart: string;
  periodEnd: string;
  currency?: string;
  openingBalance: number;
  transactions: Array<{
    date: string;
    reference: string;
    memo?: string;
    debit: number;
    credit: number;
    runningBalance: number;
  }>;
  totalInvoiced: number;
  totalReceived: number;
  closingBalance: number;
}

const round2 = (v: unknown): number =>
  Math.round((Number(v || 0) + Number.EPSILON) * 100) / 100;

/**
 * Issue a new statement snapshot. Any still-VALID snapshot for the same
 * customer + period is superseded first (original keeps its number/token
 * and stays verifiable as SUPERSEDED).
 */
export async function createStatementSnapshot(
  input: CreateStatementSnapshotInput,
  companyConfig?: CompanyConfig | null
): Promise<StatementSnapshot> {
  const existing = await dbService.getAll<StatementSnapshot>(STORE as any).catch(() => []);
  const samePeriod = (existing || []).filter(
    (s) =>
      String(s.customerId) === String(input.customerId) &&
      String(s.periodStart) === String(input.periodStart) &&
      String(s.periodEnd) === String(input.periodEnd) &&
      String(s.status || 'VALID').toUpperCase() === 'VALID'
  );

  const statementNumber = generateNextId('STMT', (existing || []) as any[], companyConfig as any);
  const now = new Date().toISOString();
  const base: StatementSnapshot = {
    id: statementNumber,
    statementNumber,
    statementDate: now.slice(0, 10),
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    customerId: input.customerId,
    customerName: input.customerName,
    customerCode: input.customerCode || '',
    address: input.address || '',
    phone: input.phone || '',
    email: input.email || '',
    currency: input.currency || 'MWK',
    openingBalance: round2(input.openingBalance),
    transactions: (input.transactions || []).map((t) => ({
      date: String(t.date || ''),
      reference: String(t.reference || ''),
      memo: t.memo ? String(t.memo) : undefined,
      debit: round2(t.debit),
      credit: round2(t.credit),
      runningBalance: round2(t.runningBalance),
    })),
    totalInvoiced: round2(input.totalInvoiced),
    totalReceived: round2(input.totalReceived),
    closingBalance: round2(input.closingBalance),
    status: 'VALID' as const,
    createdAt: now,
  };
  const snapshot = ensureDocumentVerificationToken(base);

  // Supersede prior VALID snapshots for the same period (they remain
  // verifiable — as SUPERSEDED — under their own number + token).
  for (const prior of samePeriod) {
    try {
      await dbService.put(STORE as any, {
        ...prior,
        status: 'SUPERSEDED',
        supersededBy: statementNumber,
      } as any);
    } catch (err) {
      logger.warn(`[statementService] Failed to supersede ${prior.statementNumber}:`, err);
    }
  }

  await dbService.put(STORE as any, snapshot as any);
  return snapshot;
}

export async function getStatementSnapshot(statementNumber: string): Promise<StatementSnapshot | null> {
  try {
    return (await dbService.get<StatementSnapshot>(STORE as any, statementNumber)) || null;
  } catch {
    return null;
  }
}

export async function listStatementSnapshots(): Promise<StatementSnapshot[]> {
  try {
    return (await dbService.getAll<StatementSnapshot>(STORE as any)) || [];
  } catch {
    return [];
  }
}

/** Mark a snapshot VOID (issued in error). It stays verifiable as VOID. */
export async function voidStatementSnapshot(statementNumber: string): Promise<void> {
  const existing = await getStatementSnapshot(statementNumber);
  if (!existing) throw new Error(`Statement ${statementNumber} not found`);
  await dbService.put(STORE as any, { ...existing, status: 'VOID' } as any);
}

export const statementService = {
  STORE,
  createStatementSnapshot,
  getStatementSnapshot,
  listStatementSnapshots,
  voidStatementSnapshot,
};

export default statementService;

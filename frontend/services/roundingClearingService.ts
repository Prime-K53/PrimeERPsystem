import { dbService } from './db';
import { resolveAccountForPosting, UnresolvedAccountError } from './transactions/_internal';

interface RoundingGLConfig {
    roundingClearingAccount: string;
    roundingAccrualAccount: string;
}

const getRoundingGLConfig = (): RoundingGLConfig => {
  const saved = localStorage.getItem('nexus_company_config');
  const defaultConfig: RoundingGLConfig = {
    roundingClearingAccount: '4998',
    roundingAccrualAccount: '2290',
  };
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return { ...defaultConfig, ...(parsed.glMapping || {}) };
    } catch { }
  }
  return defaultConfig;
};

export interface RoundingClearanceSummary {
  periodStart: string;
  periodEnd: string;
  netRoundingAmount: number;
  positiveRoundingCount: number;
  negativeRoundingCount: number;
  transactionCount: number;
  journalEntryId: string;
  clearedAt: string;
}

export async function getUnclearedRoundingTotal(): Promise<number> {
  const logs = await dbService.getAll<any>('roundingLogs');
  const allLedger = await dbService.getAll<any>('ledger');
  const clearedEntryIds = new Set(
    allLedger
      .filter((l: any) => l.id?.startsWith('LG-RNDCLR'))
      .map((l: any) => l.id)
  );
  return logs.reduce((sum: number, l: any) => sum + (l.rounding_difference || 0), 0);
}

const resolveGLAccountRef = (ref: string, accounts: any[], companyId?: string): string => {
    const resolved = resolveAccountForPosting(ref, accounts, { allowNonPosting: false, companyId });
    if (!resolved) {
        throw new UnresolvedAccountError(ref);
    }
    return resolved;
};

export async function clearRoundingForPeriod(
  periodStart: string,
  periodEnd: string,
  performedBy: string = 'System',
): Promise<RoundingClearanceSummary> {
  const logs = await dbService.getAll<any>('roundingLogs');
  const inRange = logs.filter((l: any) => {
    const d = l.date || l.createdAt || '';
    return d >= periodStart && d <= periodEnd;
  });
  if (inRange.length === 0) {
    throw new Error('No rounding logs found in the specified period');
  }

  const netAmount = inRange.reduce((sum: number, l: any) => sum + (l.rounding_difference || 0), 0);
  const positiveCount = inRange.filter((l: any) => (l.rounding_difference || 0) > 0).length;
  const negativeCount = inRange.filter((l: any) => (l.rounding_difference || 0) < 0).length;
  const clearedAt = new Date().toISOString();

  const journalEntryId = `LG-RNDCLR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const absAmount = Math.abs(Math.round(netAmount * 100) / 100);

  const glConfig = getRoundingGLConfig();
  const accounts = (await dbService.getAll<any>('accounts')) || [];
  const companyConfig = JSON.parse(localStorage.getItem('nexus_company_config') || '{}');
  const companyId = companyConfig?.companyId;

  const roundingClearingAccount = resolveGLAccountRef(glConfig.roundingClearingAccount, accounts, companyId);
  const roundingAccrualAccount = resolveGLAccountRef(glConfig.roundingAccrualAccount, accounts, companyId);

  const entry: any = {
    id: journalEntryId,
    date: clearedAt,
    description: `Rounding clearance ${periodStart.slice(0, 10)} to ${periodEnd.slice(0, 10)}`,
    referenceId: `RNDCLR-${periodStart.slice(0, 7)}`,
    reconciled: false,
    performedBy,
    type: 'rounding_clearance',
  };

  if (netAmount > 0) {
    entry.debitAccountId = roundingAccrualAccount;
    entry.creditAccountId = roundingClearingAccount;
    entry.amount = absAmount;
  } else if (netAmount < 0) {
    entry.debitAccountId = roundingClearingAccount;
    entry.creditAccountId = roundingAccrualAccount;
    entry.amount = absAmount;
  } else {
    throw new Error('Net rounding amount is zero — nothing to clear');
  }

  await dbService.put('ledger', entry);

  return {
    periodStart,
    periodEnd,
    netRoundingAmount: Math.round(netAmount * 100) / 100,
    positiveRoundingCount: positiveCount,
    negativeRoundingCount: negativeCount,
    transactionCount: inRange.length,
    journalEntryId,
    clearedAt,
  };
}

export async function getRoundingClearanceHistory(): Promise<RoundingClearanceSummary[]> {
  const allLedger = await dbService.getAll<any>('ledger');
  const glConfig = getRoundingGLConfig();
  
  const clearingAccountId = glConfig.roundingClearingAccount;
  const accrualAccountId = glConfig.roundingAccrualAccount;
  
  return allLedger
    .filter((l: any) => l.description?.startsWith('Rounding clearance'))
    .map((l: any) => ({
      periodStart: l.description?.match(/Rounding clearance (.+?) to/)?.[1] || '',
      periodEnd: l.description?.match(/to (.+?)$/)?.[1] || '',
      netRoundingAmount: l.amount * (l.debitAccountId === accrualAccountId ? 1 : -1),
      positiveRoundingCount: 0,
      negativeRoundingCount: 0,
      transactionCount: 0,
      journalEntryId: l.id,
      clearedAt: l.date || l.timestamp || '',
    }))
    .sort((a: any, b: any) => new Date(b.clearedAt).getTime() - new Date(a.clearedAt).getTime());
}

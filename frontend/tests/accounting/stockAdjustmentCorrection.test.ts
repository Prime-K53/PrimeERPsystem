/**
 * stockAdjustmentCorrection.test.ts
 *
 * Validates the safe historical correction for the Sept-12 defect:
 *  - identifies exactly the affected stock-adjustment rows crediting 42100
 *  - dry-run totals match the forensic anchors (102 rows, K348,704,525,
 *    11420=K246,250,000, 11410=K102,454,525, other-42100=0)
 *  - proposed reclassification is balanced (DR 42100 / CR 31000 per row)
 *  - correction referenceType is NOT 'reversal' (stays included in
 *    trial-balance/P&L/GL reports so it nets against the original)
 *  - idempotent: already-corrected rows are excluded; applying twice posts once
 *  - originals are never mutated or deleted
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const memStores = vi.hoisted(() => ({
  tables: new Map<string, Map<string, any>>(),
}));

vi.mock('../../services/db', () => {
  const getTable = (name: string) => {
    if (!memStores.tables.has(name)) memStores.tables.set(name, new Map());
    return memStores.tables.get(name)!;
  };
  const txStore = (name: string) => ({
    get: async (id: string) => getTable(name).get(String(id)),
    getAll: async () => [...getTable(name).values()],
    put: async (obj: any) => {
      getTable(name).set(String(obj.id), obj);
    },
    delete: async (id: string) => {
      getTable(name).delete(String(id));
    },
  });
  return {
    dbService: {
      getAll: async (table: string) => [...getTable(table).values()],
      get: async (table: string, id: string) => getTable(table).get(String(id)),
      put: async (table: string, obj: any) => {
        getTable(table).set(String(obj.id), obj);
      },
      executeAtomicOperation: async (_stores: string[], fn: (tx: any) => Promise<any>) =>
        fn({ objectStore: (name: string) => txStore(name) }),
    },
  };
});

import {
  findAffectedStockAdjustments,
  buildCorrectionPreview,
  previewStockAdjustmentCorrection,
  applyStockAdjustmentCorrection,
  STOCK_ADJUSTMENT_CORRECTION_REFERENCE,
  STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE,
} from '../../services/stockAdjustmentCorrectionService';
import { computeTrialBalance } from '../../services/accountingEngine';
import { dbService } from '../../services/db';

function coaFixture(): any[] {
  const acc = (
    code: string,
    name: string,
    account_type: string,
    parent: string | null = null,
    extra: any = {}
  ) => ({
    id: `ACC-${code}`,
    code,
    account_number: code,
    name,
    account_type,
    type:
      account_type === 'ASSET'
        ? 'Asset'
        : account_type === 'EQUITY'
          ? 'Equity'
          : account_type === 'INCOME'
            ? 'Revenue'
            : 'Expense',
    normal_balance:
      account_type === 'ASSET' || account_type === 'EXPENSE' ? 'DEBIT' : 'CREDIT',
    parent_account_id: parent ? `ACC-${parent}` : null,
    is_active: true,
    allow_posting: true,
    ...extra,
  });
  return [
    acc('11410', 'Merchandise Inventory', 'ASSET', null),
    acc('11420', 'Raw Materials', 'ASSET', null),
    acc('11430', 'Finished Goods', 'ASSET', null),
    acc('31000', "Owner's Capital", 'EQUITY', null),
    acc('32000', 'Retained Earnings', 'EQUITY', null),
    acc('42000', 'Other Income', 'INCOME', null, { allow_posting: false }),
    acc('42100', 'Interest Income', 'INCOME', '42000'),
    acc('51200', 'Cost of Goods Sold', 'EXPENSE', null),
  ];
}

/** Reproduce the forensic shape: 33x 11420 + 69x 11410, all CR 42100. */
function forensicLedger(): any[] {
  const rows: any[] = [];
  // 33 Raw Materials rows totalling K246,250,000 (avg 7,462,121.21 — use exact split)
  const rawEach = Math.floor(246250000 / 33);
  const rawRemainder = 246250000 - rawEach * 33;
  for (let i = 0; i < 33; i++) {
    rows.push({
      id: `LG-SEPT12-RM-${String(i).padStart(3, '0')}`,
      date: '2026-09-12T15:56:10.000Z',
      description: 'Stock Adjustment: Smart stock adjustment (ADD) (Smart stock adjustment (ADD))',
      debitAccountId: 'ACC-11420',
      creditAccountId: 'ACC-42100',
      amount: i === 0 ? rawEach + rawRemainder : rawEach,
      referenceId: `INV-MAT-${String(i + 1).padStart(3, '0')}`,
      reconciled: false,
    });
  }
  // 69 Merchandise rows totalling K102,454,525
  const merchEach = Math.floor(102454525 / 69);
  const merchRemainder = 102454525 - merchEach * 69;
  for (let i = 0; i < 69; i++) {
    rows.push({
      id: `LG-SEPT12-PRD-${String(i).padStart(3, '0')}`,
      date: '2026-09-12T15:56:20.000Z',
      description: 'Stock Adjustment: Smart stock adjustment (ADD) (Smart stock adjustment (ADD))',
      debitAccountId: 'ACC-11410',
      creditAccountId: 'ACC-42100',
      amount: i === 0 ? merchEach + merchRemainder : merchEach,
      referenceId: `INV-PRD-${String(i + 1).padStart(3, '0')}`,
      reconciled: false,
    });
  }
  return rows;
}

function seedStores(ledger: any[], accounts = coaFixture()) {
  memStores.tables.clear();
  memStores.tables.set('ledger', new Map(ledger.map((e: any) => [String(e.id), e])));
  memStores.tables.set('accounts', new Map(accounts.map((a: any) => [String(a.id), a])));
  memStores.tables.set('idempotencyKeys', new Map());
  memStores.tables.set('inventory', new Map());
}

describe('stockAdjustmentCorrection — forensic identification', () => {
  beforeEach(() => memStores.tables.clear());

  it('identifies exactly 102 affected rows totalling K348,704,525', () => {
    const ledger = forensicLedger();
    const { affected, other42100 } = findAffectedStockAdjustments(ledger, coaFixture());
    expect(affected.length).toBe(102);
    const total = affected.reduce((s, e) => s + e.amount, 0);
    expect(total).toBe(348704525);
    expect(other42100.length).toBe(0);
  });

  it('dry-run preview matches debit distribution and is balanced', () => {
    const ledger = forensicLedger();
    const { affected, other42100 } = findAffectedStockAdjustments(ledger, coaFixture());
    const preview = buildCorrectionPreview({ affected, other42100, accounts: coaFixture() });
    expect(preview.affectedCount).toBe(102);
    expect(preview.affectedTotal).toBe(348704525);
    expect(preview.debitDistribution['11420']).toBe(246250000);
    expect(preview.debitDistribution['11410']).toBe(102454525);
    expect(preview.incorrectCreditTotal).toBe(348704525);
    expect(preview.other42100Count).toBe(0);
    expect(preview.balanced).toBe(true);
    expect(preview.debitCorrectionCode).toBe('42100');
    expect(preview.creditCorrectionCode).toBe('31000');
    expect(preview.wouldPostCount).toBe(102);
  });

  it('proposed corrections reclassify DR 42100 / CR 31000 with audit linkage (never reversal)', () => {
    const ledger = forensicLedger();
    const { affected, other42100 } = findAffectedStockAdjustments(ledger, coaFixture());
    const preview = buildCorrectionPreview({ affected, other42100, accounts: coaFixture() });
    for (const c of preview.proposedCorrections) {
      expect(c.debitAccountId).toBe('ACC-42100');
      expect(c.creditAccountId).toBe('ACC-31000');
      expect(c.correctionId).toBe(`LG-CORR-${c.reversesEntryId}`);
    }
    expect(STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE).not.toBe('reversal');
    expect(STOCK_ADJUSTMENT_CORRECTION_REFERENCE).toBe(
      'CORRECTION-STOCK-ADJUSTMENT-20260912'
    );
  });

  it('excludes unrelated 42100 rows from the affected set but reports them', () => {
    const ledger = [
      ...forensicLedger(),
      {
        id: 'LG-LEGIT-001',
        date: '2026-09-13T10:00:00.000Z',
        description: 'Bank interest for September',
        debitAccountId: 'ACC-11210',
        creditAccountId: 'ACC-42100',
        amount: 5000,
        referenceId: 'INT-001',
        reconciled: false,
      },
    ];
    const { affected, other42100 } = findAffectedStockAdjustments(ledger, coaFixture());
    expect(affected.length).toBe(102);
    expect(other42100.length).toBe(1);
    expect(other42100[0].id).toBe('LG-LEGIT-001');
  });

  it('already-corrected rows are not re-proposed (idempotent preview)', () => {
    const ledger = forensicLedger();
    // Simulate one prior correction row for the first original.
    ledger.push({
      id: `LG-CORR-${ledger[0].id}`,
      date: '2026-09-13T00:00:00.000Z',
      description: 'CORRECTION: Reclassify ...',
      debitAccountId: 'ACC-42100',
      creditAccountId: 'ACC-31000',
      amount: ledger[0].amount,
      referenceId: STOCK_ADJUSTMENT_CORRECTION_REFERENCE,
      referenceType: STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE,
      entryType: STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE,
      reversesEntryId: ledger[0].id,
      reconciled: false,
    });
    const { affected } = findAffectedStockAdjustments(ledger, coaFixture());
    expect(affected.length).toBe(101);
  });
});

describe('stockAdjustmentCorrection — apply (dry-run + idempotent, auditable)', () => {
  beforeEach(() => memStores.tables.clear());

  it('dry-run writes nothing', async () => {
    seedStores(forensicLedger());
    const res = await applyStockAdjustmentCorrection({ dryRun: true });
    expect(res.applied).toBe(false);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(102);
  });

  it('requires explicit confirmation', async () => {
    seedStores(forensicLedger());
    await expect(applyStockAdjustmentCorrection({})).rejects.toThrow(/explicit confirmation/i);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(102);
  });

  it('applies exactly 102 balanced corrections once; second run posts zero', async () => {
    seedStores(forensicLedger());
    const first = await applyStockAdjustmentCorrection({
      confirmed: true,
      reason: 'Test correction — reclassify Sept-12 Smart Adjust batch to opening equity',
    });
    expect(first.applied).toBe(true);
    expect(first.entriesPosted).toBe(102);
    expect(first.total).toBe(348704525);

    let ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(204);

    // Originals untouched.
    const originals = ledger.filter((e: any) => String(e.id).startsWith('LG-SEPT12-'));
    expect(originals.length).toBe(102);
    for (const o of originals) {
      expect(o.creditAccountId).toBe('ACC-42100');
    }

    // Corrections link back 1:1 and are correction-typed (included in reports).
    const corrections = ledger.filter(
      (e: any) => e.referenceId === STOCK_ADJUSTMENT_CORRECTION_REFERENCE
    );
    expect(corrections.length).toBe(102);
    for (const c of corrections) {
      expect(c.referenceType).toBe(STOCK_ADJUSTMENT_CORRECTION_ENTRY_TYPE);
      expect(c.referenceType).not.toBe('reversal');
      expect(c.debitAccountId).toBe('ACC-42100');
      expect(c.creditAccountId).toBe('ACC-31000');
      expect(c.reversesEntryId).toBeTruthy();
    }

    const second = await applyStockAdjustmentCorrection({
      confirmed: true,
      reason: 'second run must be a no-op',
    });
    expect(second.applied).toBe(false);
    expect(second.entriesPosted).toBe(0);
    ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(204);
  });

  it('trial balance stays balanced and 42100 nets to zero for the batch after correction', async () => {
    seedStores(forensicLedger());
    await applyStockAdjustmentCorrection({ confirmed: true, reason: 'TB check' });
    const ledger = await dbService.getAll<any>('ledger');
    const accounts = await dbService.getAll<any>('accounts');
    const tb = computeTrialBalance(accounts, ledger);
    expect(tb.isBalanced).toBe(true);
    expect(tb.difference).toBe(0);
    const line42100 = tb.lines.find((l) => l.accountCode === '42100')!;
    // DR corrections (102) net the CR originals (102) exactly.
    expect(line42100.totalDebit).toBe(348704525);
    expect(line42100.totalCredit).toBe(348704525);
    expect(line42100.balance).toBe(0);
    const line31000 = tb.lines.find((l) => l.accountCode === '31000')!;
    expect(line31000.totalCredit).toBe(348704525);
  });

  it('previewStockAdjustmentCorrection is read-only', async () => {
    seedStores(forensicLedger());
    const preview = await previewStockAdjustmentCorrection();
    expect(preview.affectedCount).toBe(102);
    const ledger = await dbService.getAll<any>('ledger');
    expect(ledger.length).toBe(102);
  });
});

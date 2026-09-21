/**
 * Material Inventory Correction Service — unit tests.
 *
 * Pure preview logic is exercised directly; the apply path runs against an
 * in-memory ledger so no real accounting data is touched.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  state: {
    ledger: [] as any[],
    accounts: [] as any[],
  },
}));

vi.mock('../../services/db', () => ({
  dbService: {
    getAll: vi.fn(async (store: string) =>
      store === 'ledger' ? [...h.state.ledger] : [...h.state.accounts]
    ),
    getById: vi.fn(async (store: string, id: string) =>
      store === 'ledger' ? h.state.ledger.find((e) => e.id === id) ?? null : null
    ),
    put: vi.fn(async (store: string, item: any) => {
      if (store === 'ledger') {
        const idx = h.state.ledger.findIndex((e) => e.id === item.id);
        if (idx >= 0) h.state.ledger[idx] = item;
        else h.state.ledger.push(item);
      }
      return item.id;
    }),
    executeAtomicOperation: vi.fn(async (_stores: string[], op: (tx: any) => Promise<any>) =>
      op({
        objectStore: () => ({
          getAll: async () => [...h.state.ledger],
          put: async (item: any) => {
            const idx = h.state.ledger.findIndex((e) => e.id === item.id);
            if (idx >= 0) h.state.ledger[idx] = item;
            else h.state.ledger.push(item);
          },
        }),
      })
    ),
  },
}));

import {
  previewMaterialInventoryCorrection,
  applyMaterialInventoryCorrection,
  MATINV_DUPLICATE_LEDGER_ID,
  MATINV_REVERSAL_REFERENCE,
  MATINV_REVERSAL_DATE,
  MATINV_EXPECTED_11420,
} from '../../services/materialInventoryCorrectionService';
import { computeOwnBalances, computeTrialBalance, isPostedLedgerEntry } from '../../services/accountingEngine';

const MOCK_ACCOUNTS = [
  { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', account_type: 'ASSET', allow_posting: false, is_active: true, parent_account_id: null },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', allow_posting: true, is_active: true, parent_account_id: 'ACC-11400' },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', allow_posting: true, is_active: true, parent_account_id: 'ACC-11400' },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', allow_posting: true, is_active: true, parent_account_id: 'ACC-11400' },
  { id: 'ACC-32000', code: '32000', account_number: '32000', name: 'Retained Earnings', account_type: 'EQUITY', allow_posting: true, is_active: true, parent_account_id: null },
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', account_type: 'EXPENSE', allow_posting: true, is_active: true, parent_account_id: null },
];

function makeDuplicate(overrides: Record<string, any> = {}) {
  return {
    id: MATINV_DUPLICATE_LEDGER_ID,
    date: '2026-01-17',
    description: 'COGS - Invoice #INV-P726/031',
    debitAccountId: 'ACC-51200',
    creditAccountId: 'ACC-11420',
    amount: 187600,
    referenceId: 'INV-P726/031',
    status: 'posted',
    ...overrides,
  };
}

/**
 * Miniature reproduction of the live ledger's relevant rows:
 *   11420 credits total K1,875,100 (incl. the approved duplicate)
 *   11410 credits total K448,985 (Product issue — out of scope)
 *   51200 debits total K2,324,085
 */
function seedExistingIssues() {
  return [
    makeDuplicate(),
    { id: 'LG-COGS-031A', date: '2026-01-17', description: 'COGS - Invoice #INV-P726/031', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11420', amount: 187600, referenceId: 'INV-P726/031', status: 'posted' },
    { id: 'LG-COGS-021', date: '2026-01-17', description: 'COGS - Invoice #INV-P726/021', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11420', amount: 199000, referenceId: 'INV-P726/021', status: 'posted' },
    { id: 'LG-COGS-REST', date: '2026-01-17', description: 'COGS - remaining material issues', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11420', amount: 1300900, referenceId: 'INV-P726/MATERIAL', status: 'posted' },
    { id: 'LG-COGS-PROD', date: '2026-01-17', description: 'COGS - Product line (out of scope)', debitAccountId: 'ACC-51200', creditAccountId: 'ACC-11410', amount: 448985, referenceId: 'INV-P726/PRODUCT', status: 'posted' },
  ];
}

function appliedRows() {
  return [
    { id: 'LG-MIC-REV-1', date: '2026-09-16', description: 'REVERSAL', debitAccountId: 'ACC-11420', creditAccountId: 'ACC-51200', amount: 187600, referenceId: MATINV_REVERSAL_REFERENCE, entryType: 'material_inventory_correction', referenceType: 'material_inventory_correction', reversesEntryId: MATINV_DUPLICATE_LEDGER_ID, status: 'posted' },
    { id: 'LG-MIC-OPENING-1', date: '2026-01-01', description: 'OPENING', debitAccountId: 'ACC-11420', creditAccountId: 'ACC-32000', amount: 1687500, referenceId: 'CORR-MATINV-OPENING-11420', entryType: 'material_inventory_correction', referenceType: 'material_inventory_correction', status: 'posted' },
    { id: 'LG-MIC-CAPITAL-1', date: '2026-09-16', description: 'CAPITAL', debitAccountId: 'ACC-11420', creditAccountId: 'ACC-32000', amount: 222500000, referenceId: 'CORR-MATINV-CAPITAL-11420', entryType: 'material_inventory_correction', referenceType: 'material_inventory_correction', status: 'posted' },
  ];
}

beforeEach(() => {
  h.state.ledger = seedExistingIssues();
  h.state.accounts = MOCK_ACCOUNTS;
});

describe('MaterialInventoryCorrectionService — preview', () => {
  it('verifies the approved duplicate and proposes reversal + both capitalisation components', () => {
    const preview = previewMaterialInventoryCorrection(h.state.ledger, MOCK_ACCOUNTS);

    expect(preview.failures).toHaveLength(0);
    expect(preview.duplicateFound).toBe(true);
    expect(preview.proposedEntries).toHaveLength(3);
    expect(preview.proposedEntries.map((e) => e.component)).toEqual(['REVERSAL', 'OPENING', 'CAPITAL']);
    // Approved capitalisation alone, then every leg that debits 11420.
    expect(preview.proposedCapitalisationTotal).toBe(224187500);
    expect(preview.proposedTotalDebit11420).toBe(224375100);
    expect(preview.canApply).toBe(true);
  });

  it('proposes exactly the approved journal amounts, dates and account pair', () => {
    const preview = previewMaterialInventoryCorrection(h.state.ledger, MOCK_ACCOUNTS);

    const opening = preview.proposedEntries.find((e) => e.component === 'OPENING')!;
    expect(opening.date).toBe('2026-01-01');
    expect(opening.amount).toBe(1687500);
    expect(opening.debitAccountId).toBe('ACC-11420');
    expect(opening.creditAccountId).toBe('ACC-32000');

    const capital = preview.proposedEntries.find((e) => e.component === 'CAPITAL')!;
    expect(capital.date).toBe('2026-09-16');
    expect(capital.amount).toBe(222500000);
    expect(capital.debitAccountId).toBe('ACC-11420');
    expect(capital.creditAccountId).toBe('ACC-32000');
  });

  it('proposes an offsetting reversal that survives the posted-entry filter', () => {
    const preview = previewMaterialInventoryCorrection(h.state.ledger, MOCK_ACCOUNTS);
    const reversal = preview.proposedEntries.find((e) => e.component === 'REVERSAL')!;

    expect(reversal.debitAccountId).toBe('ACC-11420');
    expect(reversal.creditAccountId).toBe('ACC-51200');
    expect(reversal.amount).toBe(187600);
    expect(reversal.referenceId).toBe(MATINV_REVERSAL_REFERENCE);
    expect(reversal.revertsEntryId).toBe(MATINV_DUPLICATE_LEDGER_ID);
    expect(reversal.date).toBe(MATINV_REVERSAL_DATE);
    expect(MATINV_REVERSAL_DATE).toBe('2026-09-21');
    // The row must stay posted so it nets the original; 'Reversal' would be
    // excluded by the canonical filter and the original would never net.
    expect(isPostedLedgerEntry({ ...reversal, entryType: 'material_inventory_correction' })).toBe(true);
    expect(isPostedLedgerEntry({ ...reversal, entryType: 'Reversal' })).toBe(false);
  });

  it('aborts when the duplicate row is missing', () => {
    const preview = previewMaterialInventoryCorrection([], MOCK_ACCOUNTS);
    expect(preview.proposedEntries).toHaveLength(0);
    expect(preview.failures.some((f) => f.reason === 'MISSING_ENTRY')).toBe(true);
    expect(preview.canApply).toBe(false);
  });

  it('rejects a duplicate with the wrong amount', () => {
    const preview = previewMaterialInventoryCorrection([makeDuplicate({ amount: 187609 })], MOCK_ACCOUNTS);
    expect(preview.failures.some((f) => f.reason === 'AMOUNT_MISMATCH')).toBe(true);
    expect(preview.proposedEntries).toHaveLength(0);
  });

  it('rejects a duplicate with the wrong invoice reference', () => {
    const preview = previewMaterialInventoryCorrection([makeDuplicate({ referenceId: 'INV-P726/030' })], MOCK_ACCOUNTS);
    expect(preview.failures.some((f) => f.reason === 'INVOICE_REFERENCE_MISMATCH')).toBe(true);
  });

  it('rejects a duplicate with the wrong credit account', () => {
    const preview = previewMaterialInventoryCorrection([makeDuplicate({ creditAccountId: 'ACC-11410' })], MOCK_ACCOUNTS);
    expect(preview.failures.some((f) => f.reason === 'CREDIT_ACCOUNT_MISMATCH')).toBe(true);
  });

  it('rejects a duplicate with the wrong debit account', () => {
    const preview = previewMaterialInventoryCorrection([makeDuplicate({ debitAccountId: 'ACC-11410' })], MOCK_ACCOUNTS);
    expect(preview.failures.some((f) => f.reason === 'DEBIT_ACCOUNT_MISMATCH')).toBe(true);
  });

  it('rejects a duplicate with the wrong date', () => {
    const preview = previewMaterialInventoryCorrection([makeDuplicate({ date: '2026-01-18' })], MOCK_ACCOUNTS);
    expect(preview.failures.some((f) => f.reason === 'DATE_MISMATCH')).toBe(true);
  });

  it('aborts when a required account is missing from the chart', () => {
    const preview = previewMaterialInventoryCorrection(
      h.state.ledger,
      MOCK_ACCOUNTS.filter((a) => a.code !== '32000')
    );
    expect(preview.failures.some((f) => f.reason === 'ACCOUNT_NOT_RESOLVED')).toBe(true);
    expect(preview.proposedEntries).toHaveLength(0);
  });

  it('aborts when a required account is a GROUP (non-posting) account', () => {
    const groupOnly = MOCK_ACCOUNTS.map((a) =>
      a.code === '11420' ? { ...a, allow_posting: false } : a
    ).filter((a) => a.code !== '32000');
    const preview = previewMaterialInventoryCorrection(h.state.ledger, groupOnly);
    expect(preview.failures.length).toBeGreaterThan(0);
    expect(preview.proposedEntries).toHaveLength(0);
  });

  it('does not propose a second reversal when one already exists', () => {
    const preview = previewMaterialInventoryCorrection(
      [...seedExistingIssues(), appliedRows()[0]],
      MOCK_ACCOUNTS
    );

    expect(preview.duplicateIdempotency.reversalAlreadyApplied).toBe(true);
    expect(preview.proposedEntries.map((e) => e.component)).toEqual(['OPENING', 'CAPITAL']);
    // Only the capitalisation legs remain, so no reversal leg is re-proposed.
    expect(preview.proposedCapitalisationTotal).toBe(224187500);
    expect(preview.proposedTotalDebit11420).toBe(224187500);
  });

  it('reports fully applied once every component exists', () => {
    const preview = previewMaterialInventoryCorrection(
      [...seedExistingIssues(), ...appliedRows()],
      MOCK_ACCOUNTS
    );

    expect(preview.fullyApplied).toBe(true);
    expect(preview.proposedEntries).toHaveLength(0);
    expect(preview.canApply).toBe(false);
    expect(preview.duplicateIdempotency.openingAlreadyApplied).toBe(true);
    expect(preview.duplicateIdempotency.capitalisationAlreadyApplied).toBe(true);
  });
});

describe('MaterialInventoryCorrectionService — apply', () => {
  it('requires confirmed: true', async () => {
    await expect(
      applyMaterialInventoryCorrection({ confirmed: false as any, reason: 'x' })
    ).rejects.toThrow(/confirmed/);
  });

  it('requires a non-empty reason', async () => {
    await expect(
      applyMaterialInventoryCorrection({ confirmed: true, reason: '   ' })
    ).rejects.toThrow(/reason/);
  });

  it('writes nothing in dry-run mode', async () => {
    const before = h.state.ledger.length;

    const result = await applyMaterialInventoryCorrection({
      confirmed: true,
      reason: 'unit test',
      dryRun: true,
    });

    expect(result.status).toBe('dry-run');
    expect(result.reversal.created).toBe(true);
    expect(h.state.ledger).toHaveLength(before);
  });

  it('posts the reversal + both capitalisation journals and lands 11420 on the verified value', async () => {
    const result = await applyMaterialInventoryCorrection({
      confirmed: true,
      reason: 'approved material inventory capitalisation',
    });

    expect(result.status).toBe('applied');
    expect(result.wroteOutOfScopeData).toBe(false);
    expect(result.reversal.created).toBe(true);
    expect(result.reversal.reversalEntryId).toBeTruthy();
    expect(result.capitalisationDebit11420).toBe(224187500);
    expect(result.totalDebit11420).toBe(224375100);
    expect(result.capitalisation.map((c) => c.component).sort()).toEqual(['CAPITAL', 'OPENING']);
    expect(result.capitalisation.every((c) => c.created)).toBe(true);
    expect(h.state.ledger).toHaveLength(seedExistingIssues().length + 3);

    const balances = computeOwnBalances(MOCK_ACCOUNTS, h.state.ledger);
    expect(balances['ACC-11420']).toBe(MATINV_EXPECTED_11420);
    // The 11410 Product issue is explicitly out of scope and untouched.
    expect(balances['ACC-11410']).toBe(-448985);
    // Material COGS after the single reversal: 2,324,085 - 187,600.
    expect(balances['ACC-51200']).toBe(2136485);
    expect(balances['ACC-32000']).toBe(224187500);
  });

  it('keeps the reversal entry posted (nets the original exactly once)', async () => {
    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'unit test' });

    const reversals = h.state.ledger.filter((e) => e.reversesEntryId === MATINV_DUPLICATE_LEDGER_ID);
    expect(reversals).toHaveLength(1);
    expect(isPostedLedgerEntry(reversals[0])).toBe(true);
    expect(reversals[0].entryType).not.toBe('Reversal');
    expect(reversals[0].referenceType).not.toBe('reversal');
  });

  it('never edits, deletes or re-tags the original duplicate row', async () => {
    const before = JSON.parse(JSON.stringify(h.state.ledger.find((e) => e.id === MATINV_DUPLICATE_LEDGER_ID)));

    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'unit test' });

    const after = h.state.ledger.find((e) => e.id === MATINV_DUPLICATE_LEDGER_ID);
    expect(after).toEqual(before);
  });

  it('leaves every pre-existing ledger row byte-for-byte unchanged', async () => {
    const snapshot = JSON.parse(JSON.stringify(h.state.ledger));

    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'unit test' });

    for (const original of snapshot) {
      expect(h.state.ledger.find((e) => e.id === original.id)).toEqual(original);
    }
  });

  it('aborts with zero writes when a pre-check fails', async () => {
    h.state.ledger = [makeDuplicate({ amount: 1 })];
    const before = h.state.ledger.length;

    const result = await applyMaterialInventoryCorrection({ confirmed: true, reason: 'unit test' });

    expect(result.status).toBe('aborted');
    expect(result.failures.length).toBeGreaterThan(0);
    expect(h.state.ledger).toHaveLength(before);
  });

  it('is idempotent — a second apply writes nothing and reports already-applied', async () => {
    const first = await applyMaterialInventoryCorrection({ confirmed: true, reason: 'run 1' });
    expect(first.status).toBe('applied');
    const countAfterFirst = h.state.ledger.length;

    const second = await applyMaterialInventoryCorrection({ confirmed: true, reason: 'run 2' });

    expect(second.status).toBe('already-applied');
    expect(second.reversal.created).toBe(false);
    expect(second.capitalisation.every((c) => !c.created)).toBe(true);
    expect(h.state.ledger).toHaveLength(countAfterFirst);
    expect(computeOwnBalances(MOCK_ACCOUNTS, h.state.ledger)['ACC-11420']).toBe(MATINV_EXPECTED_11420);
  });

  it('creates at most one reversal across repeated runs', async () => {
    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'run 1' });
    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'run 2' });
    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'run 3' });

    expect(h.state.ledger.filter((e) => e.reversesEntryId === MATINV_DUPLICATE_LEDGER_ID)).toHaveLength(1);
    expect(h.state.ledger.filter((e) => e.referenceId === 'CORR-MATINV-OPENING-11420')).toHaveLength(1);
    expect(h.state.ledger.filter((e) => e.referenceId === 'CORR-MATINV-CAPITAL-11420')).toHaveLength(1);
  });

  it('keeps the trial balance balanced (adds only balanced pairs)', async () => {
    const before = computeTrialBalance(MOCK_ACCOUNTS, h.state.ledger);

    await applyMaterialInventoryCorrection({ confirmed: true, reason: 'unit test' });

    const after = computeTrialBalance(MOCK_ACCOUNTS, h.state.ledger);
    expect(after.difference).toBe(before.difference);
    expect(after.isBalanced).toBe(before.isBalanced);

    const correctionTotal = h.state.ledger
      .filter((e) => String(e.referenceId || '').startsWith('CORR-MATINV-'))
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    expect(correctionTotal).toBe(224375100);
  });

  it('honours an explicit reversalDate override', async () => {
    const result = await applyMaterialInventoryCorrection({
      confirmed: true,
      reason: 'unit test',
      reversalDate: '2026-09-30',
    });

    expect(result.status).toBe('applied');
    const reversal = h.state.ledger.find((e) => e.reversesEntryId === MATINV_DUPLICATE_LEDGER_ID)!;
    expect(String(reversal.date)).toBe('2026-09-30');
  });
});

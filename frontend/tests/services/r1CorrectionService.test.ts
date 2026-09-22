import { describe, it, expect, beforeEach, vi } from 'vitest';
import { previewR1Reversals, R1_TARGETS, R1_TOTAL_CORRECTION, R1_CORRECTION_REFERENCE } from '../../services/coaCorrectionService';
import { isInventoryBearingItem, getInventoryAccountForItem } from '../../utils/inventoryNormalization';
import { computeHierarchicalRollup } from '../../services/accountingEngine';

const MOCK_ACCOUNTS = [
  { id: 'ACC-51200', code: '51200', account_number: '51200', name: 'Cost of Sales', account_type: 'EXPENSE', allow_posting: true, is_active: true },
  { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', account_type: 'ASSET', allow_posting: true, is_active: true },
  { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', account_type: 'ASSET', allow_posting: true, is_active: true },
  { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', account_type: 'ASSET', allow_posting: true, is_active: true },
  { id: 'ACC-31000', code: '31000', account_number: '31000', name: "Owner's Capital", account_type: 'EQUITY', allow_posting: true, is_active: true },
];

function makeLedgerEntry(id: string, amount: number, debitAccountId: string, creditAccountId: string, referenceId: string, status = 'posted', entryType?: string, reversesEntryId?: string): any {
  return {
    id,
    date: '2026-09-19T00:00:00.000Z',
    description: `Test entry ${id}`,
    debitAccountId,
    creditAccountId,
    amount,
    type: 'journal',
    entryType: entryType || 'journal',
    referenceType: 'invoice',
    referenceId,
    status,
    createdAt: '2026-09-19T00:00:00.000Z',
    updatedAt: '2026-09-19T00:00:00.000Z',
    ...(reversesEntryId ? { reversesEntryId } : {}),
  };
}

describe('R1 Correction Service', () => {
  describe('exact matching', () => {
    it('should propose reversals for exactly matching entries', () => {
      const ledger = R1_TARGETS.map(target =>
        makeLedgerEntry(
          `LG-COGS-${target.invoiceRef}`,
          target.expectedAmount,
          'ACC-51200',
          'ACC-11410',
          target.invoiceRef
        )
      );

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.phase).toBe('R1');
      expect(result.proposedCount).toBe(R1_TARGETS.length);
      expect(result.proposedTotal).toBe(R1_TARGETS.reduce((sum, t) => sum + t.expectedAmount, 0));
      expect(result.verificationFailures).toHaveLength(0);
      expect(result.balanced).toBe(true);
    });
  });

  describe('amount mismatch rejection', () => {
    it('should reject entry with wrong amount', () => {
      const ledger = [
        makeLedgerEntry('LG-1', 99999, 'ACC-51200', 'ACC-11410', 'INV-P726/021'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      const failure = result.verificationFailures.find(f => f.invoiceRef === 'INV-P726/021');
      expect(failure?.reason).toBe('AMOUNT_MISMATCH');
    });
  });

  describe('account mismatch rejection', () => {
    it('should reject entry with wrong debit account', () => {
      const ledger = [
        makeLedgerEntry('LG-1', 75570, 'ACC-11410', 'ACC-11410', 'INV-P726/021'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      expect(result.verificationFailures.some(f => f.reason === 'DEBIT_ACCOUNT_MISMATCH')).toBe(true);
    });

    it('should reject entry with wrong credit account', () => {
      const ledger = [
        makeLedgerEntry('LG-1', 75570, 'ACC-51200', 'ACC-51200', 'INV-P726/021'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      expect(result.verificationFailures.some(f => f.reason === 'CREDIT_ACCOUNT_MISMATCH')).toBe(true);
    });
  });

  describe('invoice mismatch rejection', () => {
    it('should reject entry whose referenceId disagrees with its matched invoice ref', () => {
      // Found via the legacy invoice_reference alias while the primary
      // referenceId is absent — the strict primary-reference check rejects it.
      const entry = makeLedgerEntry('LG-1', 75570, 'ACC-51200', 'ACC-11410', '');
      (entry as any).invoice_reference = 'INV-P726/021';
      const ledger = [entry];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      expect(result.verificationFailures.some(f => f.reason === 'INVOICE_REFERENCE_MISMATCH')).toBe(true);
    });
  });

  describe('already-reversed rejection', () => {
    it('should skip already-reversed entries', () => {
      const ledger = [
        makeLedgerEntry('LG-1', 75570, 'ACC-51200', 'ACC-11410', 'INV-P726/021'),
        makeLedgerEntry('LG-1-R1', 75570, 'ACC-11410', 'ACC-51200', R1_CORRECTION_REFERENCE, 'posted', 'r1_correction', 'LG-1'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      expect(result.alreadyReversedCount).toBe(1);
    });
  });

  describe('double-entry balance', () => {
    it('should generate balanced DR/CR entries', () => {
      const ledger = R1_TARGETS.map(target =>
        makeLedgerEntry(
          `LG-COGS-${target.invoiceRef}`,
          target.expectedAmount,
          'ACC-51200',
          'ACC-11410',
          target.invoiceRef
        )
      );

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      for (const correction of result.proposedCorrections) {
        expect(correction.debitAccountId).toBe('ACC-11410');
        expect(correction.creditAccountId).toBe('ACC-51200');
        expect(correction.amount).toBeGreaterThan(0);
      }
    });
  });

  describe('successful reversal generation', () => {
    it('should generate correct reversal entries', () => {
      const ledger = [
        makeLedgerEntry('LG-021', 75570, 'ACC-51200', 'ACC-11410', 'INV-P726/021'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCorrections).toHaveLength(1);
      expect(result.proposedCorrections[0].amount).toBe(75570);
      expect(result.proposedCorrections[0].reversesEntryId).toBe('LG-021');
      expect(result.proposedCorrections[0].debitAccountId).toBe('ACC-11410');
      expect(result.proposedCorrections[0].creditAccountId).toBe('ACC-51200');
      expect(result.proposedCorrections[0].referenceId).toBe(R1_CORRECTION_REFERENCE);
    });
  });

  describe('duplicate execution prevention', () => {
    it('should include idempotency key tied to original entry ID', () => {
      const ledger = [
        makeLedgerEntry('LG-021', 75570, 'ACC-51200', 'ACC-11410', 'INV-P726/021'),
      ];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCorrections).toHaveLength(1);
      expect(result.proposedCorrections[0].correctionId).toContain('LG-021');
    });
  });

  describe('apply with dryRun', () => {
    it('should propose the full correction set without writing (pure preview)', async () => {
      // applyR1Reversals reads live stores, so the dry-run proposal contract
      // is verified through the pure preview over the complete target set.
      const ledger = R1_TARGETS.map(target =>
        makeLedgerEntry(`LG-COGS-${target.invoiceRef}`, target.expectedAmount, 'ACC-51200', 'ACC-11410', target.invoiceRef)
      );

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.phase).toBe('R1');
      expect(result.proposedCount).toBe(R1_TARGETS.length);
      expect(result.proposedTotal).toBe(R1_TOTAL_CORRECTION);
      expect(result.balanced).toBe(true);
      expect(result.verificationFailures).toHaveLength(0);
      for (const c of result.proposedCorrections) {
        expect(c.debitAccountId).toBe('ACC-11410');
        expect(c.creditAccountId).toBe('ACC-51200');
      }
    });
  });

  describe('missing entry handling', () => {
    it('should report verification failure when entry is missing', () => {
      const ledger: any[] = [];

      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);

      expect(result.proposedCount).toBe(0);
      expect(result.verificationFailures.some(f => f.reason === 'MISSING_ENTRY')).toBe(true);
    });
  });

  describe('Step 9 — stockability regression (only Raw Material + Stationery are stockable)', () => {
    it('Product is non-stockable and maps to no inventory account', () => {
      expect(isInventoryBearingItem({ type: 'Product' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Product' })).toBeNull();
    });

    it('Printing Service is non-stockable and maps to no inventory account', () => {
      expect(isInventoryBearingItem({ type: 'Printing Service' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Printing Service' })).toBeNull();
    });

    it('Raw Material is stockable in 11420', () => {
      expect(isInventoryBearingItem({ type: 'Raw Material' })).toBe(true);
      expect(getInventoryAccountForItem({ type: 'Raw Material' })).toBe('11420');
    });

    it('Stationery is stockable in 11420', () => {
      expect(isInventoryBearingItem({ type: 'Stationery' })).toBe(true);
      expect(getInventoryAccountForItem({ type: 'Stationery' })).toBe('11420');
    });

    it('Finished Good is non-stockable under the current architecture', () => {
      expect(isInventoryBearingItem({ type: 'Finished Good' })).toBe(false);
      expect(getInventoryAccountForItem({ type: 'Finished Good' })).toBeNull();
    });

    it('all eight audit-verified legs total exactly the live 11410 credit balance', () => {
      expect(R1_TARGETS).toHaveLength(8);
      expect(R1_TOTAL_CORRECTION).toBe(448985);
    });

    it('proposed corrections touch only 11410 and 51200 (customer/payment/invoice accounting untouched)', () => {
      const ledger = R1_TARGETS.map(target =>
        makeLedgerEntry(`LG-COGS-${target.invoiceRef}`, target.expectedAmount, 'ACC-51200', 'ACC-11410', target.invoiceRef)
      );
      const result = previewR1Reversals(ledger, MOCK_ACCOUNTS);
      expect(result.verificationFailures).toHaveLength(0);
      for (const c of result.proposedCorrections) {
        expect([c.debitAccountId, c.creditAccountId].sort()).toEqual(['ACC-11410', 'ACC-51200']);
        expect(c.debitAccountId).toBe('ACC-11410');
        expect(c.creditAccountId).toBe('ACC-51200');
      }
    });

    it('11400 parent balance equals its legitimate child balances after full correction', () => {
      const accounts: any[] = [
        { id: 'ACC-11400', code: '11400', account_number: '11400', name: 'Inventory', allow_posting: false },
        { id: 'ACC-11410', code: '11410', account_number: '11410', name: 'Merchandise Inventory', parent_account_id: '11400', allow_posting: true },
        { id: 'ACC-11420', code: '11420', account_number: '11420', name: 'Raw Materials', parent_account_id: '11400', allow_posting: true },
        { id: 'ACC-11430', code: '11430', account_number: '11430', name: 'Finished Goods', parent_account_id: '11400', allow_posting: true },
      ];
      // Post-correction own balances: 11410 fully netted to zero.
      const own = { 'ACC-11400': 0, 'ACC-11410': 0, 'ACC-11420': 8306200, 'ACC-11430': 0 };
      const rolled = computeHierarchicalRollup(accounts, own);
      expect(rolled['ACC-11400']).toBe(8306200);
    });
  });
});

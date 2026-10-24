import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import ContractReconciliationView from '../../../components/printing-contracts/ContractReconciliationView';

const financeState: Record<string, any> = {
  assessmentContracts: [
    {
      id: 'PC-1', company_id: 'CO-1', customer_id: 'CUST-1', school_id: 'SCH-1',
      contract_number: 'PC-2026-0001', title: 'Exam', status: 'active',
      prepaid_amount: 1000000, consumed_amount: 200000, reserved_amount: 100000,
      max_assessments: 3, assessment_price: 100000, assessment_type: 'examination',
      assessment_count: 3, created_at: new Date().toISOString(), updated_at: new Date().toISOString(), version: 1, data: {},
    },
  ],
  contractAssessments: [
    { id: 'A-1', contract_id: 'PC-1', status: 'consumed', item_price: 100000 },
    { id: 'A-2', contract_id: 'PC-1', status: 'consumed', item_price: 100000 },
    { id: 'A-3', contract_id: 'PC-1', status: 'reserved', item_price: 100000 },
  ],
  contractAmendments: [],
  walletTransactions: [],
  invoices: [],
  ledger: [],
};

const salesState: Record<string, any> = {
  customers: [{ id: 'CUST-1', name: 'Test School', walletBalance: 800000 }],
};

vi.mock('../../../stores/financeStore', () => ({
  useFinanceStore: Object.assign(
    (sel: (s: Record<string, any>) => unknown) => sel(financeState),
    { getState: () => financeState }
  ),
}));

vi.mock('../../../stores/salesStore', () => ({
  useSalesStore: (sel: (s: Record<string, any>) => unknown) => sel(salesState),
}));

vi.mock('../../../services/db', () => ({
  dbService: { getAll: vi.fn(async () => []) },
}));

vi.mock('../../../services/durableSyncQueue', () => ({
  durableSyncQueue: {
    getMetrics: vi.fn(async () => ({ pending: 1, failed: 0, deadLetter: 0 })),
    getAll: vi.fn(async () => []),
  },
}));

describe('ContractReconciliationView (Phase 4 §5)', () => {
  it('distinguishes reserved, consumed, released, unfunded and available with counts', async () => {
    render(<ContractReconciliationView currency="K" onSelectContract={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Available for unrelated spending/i)).toBeTruthy();
    });
    // Unambiguous financial labels (sentence case, no all-caps).
    expect(screen.getAllByText(/Confirmed discrepancies/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Commercial value/i)).toBeTruthy();
    expect(screen.getByText(/Remaining reserved/i)).toBeTruthy();
    expect(screen.getAllByText(/Unfunded/i).length).toBeGreaterThan(0);
    // Counts header present.
    expect(screen.getByText(/Counts \(total \/ done \/ left\)/i)).toBeTruthy();
    // Read-only notice, no repair buttons.
    expect(screen.getByText(/Read-only diagnostics/i)).toBeTruthy();
    expect(screen.queryByText(/Repair balances/i)).toBeNull();
    expect(screen.queryByText(/RECONCILIATION/i)).toBeNull();
  });
});

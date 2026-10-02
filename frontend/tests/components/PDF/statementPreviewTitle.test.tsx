/**
 * statementPreviewTitle.test.tsx - the customer statement download filename
 * comes from the preview title, which must name the statement (never
 * "Document Preview").
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewModal } from '../../../views/shared/components/PDF/PreviewModal';

vi.mock('../../../views/shared/components/PDF/Official/OfficialDocumentPreview', () => ({
  OfficialDocumentPreview: () => null,
}));

const statementData = (overrides: Record<string, unknown> = {}) =>
  ({
    statementNumber: 'STMT-P726-010',
    customerName: 'Chigwenembe Primary School',
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    openingBalance: 0,
    finalBalance: 160000,
    totalInvoiced: 160000,
    totalReceived: 0,
    currency: 'MWK',
    transactions: [
      { date: '2026-01-19', reference: 'INV-P726/025', memo: 'Invoice INV-P726/025', debit: 160000, credit: 0, runningBalance: 160000 },
    ],
    ...overrides,
  }) as any;

describe('statement preview title (download filename source)', () => {
  it('titles a statement preview with its statement number', async () => {
    render(<PreviewModal isOpen onClose={vi.fn()} type="ACCOUNT_STATEMENT" data={statementData()} />);
    expect(await screen.findByText('Statement STMT-P726-010')).toBeTruthy();
  });

  it('falls back to the customer name without a statement number', async () => {
    render(
      <PreviewModal
        isOpen
        onClose={vi.fn()}
        type="ACCOUNT_STATEMENT"
        data={statementData({ statementNumber: '' })}
      />
    );
    expect(await screen.findByText('Statement - Chigwenembe Primary School')).toBeTruthy();
  });

  it('falls back to a generic statement label without a number or customer', async () => {
    render(
      <PreviewModal
        isOpen
        onClose={vi.fn()}
        type="ACCOUNT_STATEMENT"
        data={statementData({ statementNumber: '', customerName: '' })}
      />
    );
    expect(await screen.findByText('Account Statement')).toBeTruthy();
  });
});

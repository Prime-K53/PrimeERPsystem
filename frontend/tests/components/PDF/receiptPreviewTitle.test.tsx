/**
 * receiptPreviewTitle.test.tsx — the receipt download filename comes from
 * the preview title, which must name the receipt (never "Document Preview").
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewModal } from '../../../views/shared/components/PDF/PreviewModal';
import { buildCustomerReceiptDoc } from '../../../services/receiptCalculationService';

vi.mock('../../../views/shared/components/PDF/Official/OfficialDocumentPreview', () => ({
  OfficialDocumentPreview: () => null,
}));

const receiptData = () =>
  buildCustomerReceiptDoc({
    payment: {
      id: 'PAY-P726/031',
      date: '2026-01-24',
      customerName: 'Chigwenembe Primary School',
      amount: 70000,
      paymentMethod: 'Cash',
      verificationToken: 'a'.repeat(64),
      allocations: [{ invoiceId: 'INV-P726/031', amount: 70000 }],
    } as any,
    customerName: 'Chigwenembe Primary School',
    currentBalance: 0,
    currencySymbol: 'K',
  }) as any;

describe('receipt preview title (download filename source)', () => {
  it('titles a receipt preview with its receipt number', async () => {
    render(<PreviewModal isOpen onClose={vi.fn()} type="RECEIPT" data={receiptData()} />);
    expect(await screen.findByText('Receipt PAY-P726/031')).toBeTruthy();
  });

  it('falls back to a receipt preview label without a number', () => {
    render(<PreviewModal isOpen onClose={vi.fn()} type="RECEIPT" data={{ ...receiptData(), receiptNumber: '' }} />);
    expect(screen.getByText('Receipt Preview')).toBeTruthy();
  });
});

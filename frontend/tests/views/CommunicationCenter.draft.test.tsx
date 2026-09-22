/**
 * CommunicationCenter.draft.test.tsx — Fix 2 regression test.
 *
 * Proves that switching the selected customer clears BOTH draft and
 * generatedDraft, so the previous communication's AI draft can never be
 * attached to the new communication's audit record. The safety-critical
 * finalMessage behavior (exact transmitted text) is asserted unchanged.
 */
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import CommunicationCenter from '../../views/tools/communication/CommunicationCenter';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(async () => ({ balance: 0 })),
    getAll: vi.fn(async () => []),
    put: vi.fn(async () => 'ok'),
    getSetting: vi.fn(async () => undefined),
    saveSetting: vi.fn(async () => undefined),
  },
}));

vi.mock('../../services/aiService', () => ({
  aiService: { generateAIResponse: vi.fn() },
}));

vi.mock('../../services/whatsappClientService', () => ({
  whatsappClient: {
    getAccountInfo: vi.fn(() => null),
    sendMessage: vi.fn(),
    logMessage: vi.fn(),
  },
}));

vi.mock('../../services/whatsAppMarketingService', () => ({
  whatsAppMarketingService: {
    getChats: vi.fn(async () => []),
    sendMessage: vi.fn(async () => undefined),
  },
}));

const CUSTOMERS = [
  { id: 'C-ABC', businessName: 'ABC School', contactName: 'Jane Doe', phone: '260971000001', email: 'abc@example.com' },
  { id: 'C-XYZ', businessName: 'XYZ Ltd', contactName: 'John Smith', phone: '260972000002', email: 'xyz@example.com' },
];
const INVOICES = [
  { id: 'INV-1', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-001', totalAmount: 100000, paidAmount: 20000, date: '2026-09-01', status: 'Pending', verificationToken: 'tok123' },
  { id: 'INV-9', customerId: 'C-XYZ', customerName: 'XYZ Ltd', invoiceNumber: 'INV-009', totalAmount: 70000, paidAmount: 0, date: '2026-09-10', status: 'Pending', verificationToken: 'tok999' },
];

vi.mock('../../context/SalesContext', () => ({
  useSales: () => ({ customers: CUSTOMERS }),
}));

vi.mock('../../context/FinanceContext', () => ({
  useFinance: () => ({ invoices: INVOICES }),
}));

vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ notify: vi.fn(), companyConfig: { currencySymbol: 'K' } }),
}));

import { dbService } from '../../services/db';
import { aiService } from '../../services/aiService';

function mockStores() {
  vi.mocked(dbService.getAll).mockImplementation(async (store: string) => {
    if (store === 'customers') return CUSTOMERS as unknown[];
    if (store === 'invoices') return INVOICES as unknown[];
    if (store === 'customerPayments') return [];
    if (store === 'customerNotificationLogs') return [];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStores();
  vi.mocked(dbService.put).mockResolvedValue('ok');
});

describe('CommunicationCenter generatedDraft lifecycle', () => {
  it('switching customer clears the previous AI draft from the audit record', async () => {
    // First Generate → DRAFT-A, second Generate (after switch) → DRAFT-B.
    let calls = 0;
    vi.mocked(aiService.generateAIResponse).mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? 'Hello ABC School, thank you.' : 'Hello XYZ Ltd, thank you.';
    });

    const { container } = render(<CommunicationCenter />);

    // Select customer A via the searchable dropdown and generate.
    fireEvent.focus(screen.getByPlaceholderText(/Search by business name/i));
    fireEvent.click(screen.getByText('ABC School'));
    await waitFor(() => {
      expect(screen.getByText('Generate message')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Generate message'));
    await waitFor(() => {
      const area = container.querySelector('textarea');
      expect(area?.value).toContain('ABC School');
    });

    // Switch to customer B via Change + dropdown: draft textarea must clear
    // (both draft and generatedDraft).
    fireEvent.click(screen.getByText('Change'));
    await waitFor(() => {
      expect(container.querySelector('textarea')).toBeNull();
    });
    fireEvent.focus(screen.getByPlaceholderText(/Search by business name/i));
    fireEvent.click(screen.getByText('XYZ Ltd'));

    // Wait for XYZ's ERP context to load (Generate is disabled until then).
    await waitFor(() => {
      expect(screen.getByText('Generate message')).toBeEnabled();
    });

    // Generate for B, then send via WhatsApp (no provider → queued, ok:true).
    fireEvent.click(screen.getByText('Generate message'));
    await waitFor(() => {
      const area = container.querySelector('textarea');
      expect(area?.value).toContain('XYZ Ltd');
    });
    fireEvent.click(screen.getByText('Send via WhatsApp'));
    const confirm = await screen.findByText(/Confirm send to XYZ Ltd/);
    fireEvent.click(confirm);
    await waitFor(() => {
      const puts = vi.mocked(dbService.put).mock.calls;
      const audit = puts.map((c) => c[1]).find((v: unknown) => (v as { aiDraft?: string }).aiDraft !== undefined);
      expect(audit).toBeDefined();
      // No stale generatedDraft from customer A may leak into B's record…
      expect((audit as { aiDraft: string }).aiDraft).toBe('Hello XYZ Ltd, thank you.');
      // …while the safety-critical final message stays exactly what was sent.
      expect((audit as { finalMessage: string }).finalMessage).toBe('Hello XYZ Ltd, thank you.');
      expect((audit as { customerId: string }).customerId).toBe('C-XYZ');
    });
  });
});

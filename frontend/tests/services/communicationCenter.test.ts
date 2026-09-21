import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn().mockResolvedValue('ok'),
    getSetting: vi.fn(),
    saveSetting: vi.fn(),
  },
}));

vi.mock('../../services/aiService', () => ({
  aiService: {
    generateAIResponse: vi.fn(),
  },
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
    getChats: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

import { dbService } from '../../services/db';
import { aiService } from '../../services/aiService';
import { buildCommunicationContext, diffFinancialFacts } from '../../services/communication/communicationContextBuilder';
import { validateDraftAgainstFacts, injectFactsPostGeneration } from '../../services/communication/communicationValidation';
import { generateCommunicationDraft } from '../../services/communication/communicationAIService';
import { recordCommunication, findRecentInvoiceSend } from '../../services/communication/communicationHistoryService';
import { sendCommunication } from '../../services/communication/communicationSendService';

const CUSTOMERS = [
  { id: 'C-ABC', businessName: 'ABC School', contactName: 'Jane Doe', phone: '260971000001', email: 'abc@example.com' },
];
const INVOICES = [
  { id: 'INV-1', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-001', totalAmount: 100000, paidAmount: 20000, date: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', verificationToken: 'tok123' },
  { id: 'INV-2', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-002', totalAmount: 45000, paidAmount: 0, date: '2026-09-15', dueDate: '2026-10-15', status: 'Pending', verificationToken: 'tok456' },
];
const PAYMENTS: Record<string, unknown>[] = [];

function mockStores(invoices = INVOICES, customers = CUSTOMERS, payments = PAYMENTS) {
  vi.mocked(dbService.getAll).mockImplementation(async (store: string) => {
    if (store === 'customers') return customers as unknown[];
    if (store === 'invoices') return invoices as unknown[];
    if (store === 'customerPayments') return payments as unknown[];
    if (store === 'quotations') return [];
    if (store === 'orders') return [];
    if (store === 'shipments') return [];
    if (store === 'customerNotificationLogs') return [];
    return [];
  });
  vi.mocked(dbService.get).mockImplementation(async (store: string) => {
    if (store === 'customers') return { balance: 0 } as never;
    return undefined;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(dbService.put).mockResolvedValue('ok');
  mockStores();
  const store: Record<string, string> = {
    nexus_company_config: JSON.stringify({
      companyName: 'Prime Printing',
      paymentDetails: {
        bankAccounts: [{ bankName: 'Zanaco', accountName: 'Prime', accountNumber: '123456' }],
        mobileMoneyAccounts: [{ network: 'Airtel Money', accountName: 'Prime', phoneNumber: '0977000000' }],
      },
    }),
  };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] || null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k in store) delete store[k]; },
  });
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem: () => undefined, removeItem: () => undefined });
  Object.defineProperty(globalThis, 'window', { value: { location: { origin: 'http://localhost' } }, configurable: true });
});

describe('communication context (ERP facts)', () => {
  it('loads customer, latest invoice, and authoritative outstanding balance', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never,
      paymentsOverride: [],
      openingBalanceOverride: 0,
    });
    expect(ctx.customer.businessName).toBe('ABC School');
    expect(ctx.latestInvoice?.invoiceNumber).toBe('INV-002');
    expect(ctx.latestInvoice?.total).toBe(45000);
    // Canonical ledger: 100000 + 45000 debits, no payments
    expect(ctx.outstandingBalance).toBe(145000);
    expect(ctx.latestInvoice?.verificationUrl).toContain('INV-002');
    expect(ctx.latestInvoice?.verificationUrl).toContain('tok456');
  });

  it('warns when no invoice exists for send_latest_invoice', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: [],
      paymentsOverride: [],
      openingBalanceOverride: 0,
    });
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.warnings.join(' ')).toMatch(/No invoice found/i);
  });

  it('throws on unknown customer (no silent fallback)', async () => {
    await expect(buildCommunicationContext('payment_reminder', 'NOPE')).rejects.toThrow(/Customer not found/);
  });
});

describe('AI draft generation (language only)', () => {
  it('passes verified ERP facts to the existing AI service', async () => {
    vi.mocked(aiService.generateAIResponse).mockResolvedValue('Dear ABC School, your balance is K145,000.00.');
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const res = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(res.aiGenerated).toBe(true);
    const prompt = vi.mocked(aiService.generateAIResponse).mock.calls[0][0] as string;
    expect(prompt).toContain('ABC School');
  });

  it('falls back to deterministic ERP template when AI is unavailable', async () => {
    vi.mocked(aiService.generateAIResponse).mockRejectedValue(new Error('AI not configured'));
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const res = await generateCommunicationDraft(ctx, { tone: 'professional', length: 'standard' });
    expect(res.aiGenerated).toBe(false);
    expect(res.text).toContain('ABC School');
    expect(res.warning).toMatch(/ERP template/i);
  });
});

describe('facts vs AI validation', () => {
  it('accepts a draft matching ERP facts', async () => {
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const v = validateDraftAgainstFacts('Dear ABC School, your outstanding balance is K145,000.00.', ctx);
    expect(v.ok).toBe(true);
  });

  it('blocks invented monetary values', async () => {
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const v = validateDraftAgainstFacts('Dear ABC School, your balance is K999,999.00.', ctx);
    expect(v.ok).toBe(false);
    expect(v.issues[0].code).toBe('amount_mismatch');
  });

  it('blocks unknown invoice numbers and invented verification URLs', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const v1 = validateDraftAgainstFacts(`Invoice INV-9999 total K45,000.00 verify ${ctx.latestInvoice?.verificationUrl}`, ctx);
    expect(v1.ok).toBe(false);
    expect(v1.issues.some((i) => i.code === 'invoice_mismatch')).toBe(true);

    const v2 = validateDraftAgainstFacts('Invoice INV-002 total K45,000.00 verify https://fake.example/#/verify/invoice/INV-002?t=evil', ctx);
    expect(v2.ok).toBe(false);
    expect(v2.issues.some((i) => i.code === 'url_mismatch')).toBe(true);
  });

  it('blocks unresolved placeholders', async () => {
    const ctx = await buildCommunicationContext('welcome', 'C-ABC');
    const v = validateDraftAgainstFacts('Hello {{name}}, welcome!', ctx);
    expect(v.ok).toBe(false);
  });

  it('post-injects authoritative values and verification link', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const out = injectFactsPostGeneration('Hello [BUSINESS_NAME], invoice [INVOICE_NUMBER] total [INVOICE_TOTAL].', ctx);
    expect(out).toContain('ABC School');
    expect(out).toContain('INV-002');
    expect(out).toContain(ctx.latestInvoice?.verificationUrl || 'tok456');
  });
});

describe('stale-data revalidation', () => {
  it('detects balance changes between generation and send', async () => {
    const before = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const after = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never,
      paymentsOverride: [{ customerId: 'C-ABC', amountApplied: 50000, status: 'Confirmed' }],
      openingBalanceOverride: 0,
    });
    const diff = diffFinancialFacts(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.messages.join(' ')).toMatch(/Outstanding balance changed/i);
  });
});

describe('history + duplicate warning', () => {
  it('records the final message with audit fields and never rewrites', async () => {
    const rec = await recordCommunication({
      customerId: 'C-ABC',
      businessName: 'ABC School',
      purpose: 'send_latest_invoice',
      channel: 'whatsapp',
      tone: 'professional',
      aiDraft: 'draft',
      finalMessage: 'final sent message',
      invoiceId: 'INV-2',
      invoiceNumber: 'INV-002',
      verificationUrl: 'http://localhost/#/verify/invoice/INV-002?t=tok456',
      hadAttachment: true,
      status: 'sent',
      failureReason: null,
      aiGenerated: true,
      snapshotId: 'ctx-1',
      factsSnapshot: '{}',
    });
    expect(dbService.put).toHaveBeenCalledWith('customerNotificationLogs', expect.objectContaining({
      finalMessage: 'final sent message',
      invoiceNumber: 'INV-002',
      status: 'sent',
    }));
    expect(rec.id).toBeTruthy();
  });

  it('warns when the same invoice was sent recently', async () => {
    vi.mocked(dbService.getAll).mockImplementation(async (store: string) => {
      if (store === 'customers') return CUSTOMERS as unknown[];
      if (store === 'customerNotificationLogs') return [{
        id: 'h1', customerId: 'C-ABC', businessName: 'ABC School', purpose: 'send_latest_invoice',
        channel: 'whatsapp', tone: 'professional', aiDraft: 'x', finalMessage: 'y',
        invoiceId: 'INV-2', invoiceNumber: 'INV-002', verificationUrl: null, hadAttachment: true,
        status: 'sent', failureReason: null, aiGenerated: true, snapshotId: 's', factsSnapshot: '{}',
        createdAt: new Date().toISOString(),
      }] as unknown[];
      return [];
    });
    const found = await findRecentInvoiceSend('C-ABC', 'INV-2');
    expect(found?.invoiceNumber).toBe('INV-002');
  });
});

describe('send layer honesty', () => {
  it('does not claim SMS sent when no provider exists', async () => {
    const ctx = await buildCommunicationContext('welcome', 'C-ABC');
    const res = await sendCommunication({ channel: 'sms', recipientPhone: '260971000001', recipientEmail: null, message: 'hi', ctx });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/not integrated/i);
  });

  it('rejects empty messages without sending', async () => {
    const ctx = await buildCommunicationContext('welcome', 'C-ABC');
    const res = await sendCommunication({ channel: 'whatsapp', recipientPhone: '260971000001', recipientEmail: null, message: '  ', ctx });
    expect(res.ok).toBe(false);
  });
});

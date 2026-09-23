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
import { whatsappClient } from '../../services/whatsappClientService';
import { buildCommunicationContext, diffFinancialFacts } from '../../services/communication/communicationContextBuilder';
import { validateDraftAgainstFacts, injectFactsPostGeneration } from '../../services/communication/communicationValidation';
import { generateCommunicationDraft, buildDraftPrompt } from '../../services/communication/communicationAIService';
import { createGenerationGuard } from '../../services/communication/communicationGeneration';
import { recordCommunication, findRecentInvoiceSend } from '../../services/communication/communicationHistoryService';
import { buildFinalPayload, sendCommunication } from '../../services/communication/communicationSendService';
import {
  getFocalInvoice,
  resolveInvoiceAttachmentDescriptor,
  verifyAttachmentIntegrity,
} from '../../services/communication/invoiceAttachmentService';
import { CHANNEL_CAPABILITIES } from '../../services/communication/communicationTypes';

const CUSTOMERS = [
  { id: 'C-ABC', businessName: 'ABC School', contactName: 'Jane Doe', phone: '260971000001', email: 'abc@example.com' },
  { id: 'C-XYZ', businessName: 'XYZ School', contactName: 'John Smith', phone: '260972000002', email: 'xyz@example.com' },
];
const INVOICES = [
  { id: 'INV-1', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-001', totalAmount: 100000, paidAmount: 20000, date: '2026-09-01', dueDate: '2026-09-30', status: 'Pending', verificationToken: 'tok123' },
  { id: 'INV-2', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-002', totalAmount: 45000, paidAmount: 0, date: '2026-09-15', dueDate: '2026-10-15', status: 'Pending', verificationToken: 'tok456' },
];
const PAYMENTS: Record<string, unknown>[] = [];
const QUOTATIONS = [
  { id: 'Q-1', customerId: 'C-ABC', customerName: 'ABC School', quotationNumber: 'QTN-001', totalAmount: 80000, date: '2026-08-01', createdAt: '2026-08-01', validUntil: '2026-09-30', status: 'Converted', items: [{ name: 'Flyers', quantity: 100, price: 500 }] },
  { id: 'Q-2', customerId: 'C-ABC', customerName: 'ABC School', quotationNumber: 'QTN-002', totalAmount: 60000, date: '2026-09-10', createdAt: '2026-09-10', validUntil: '2026-10-10', status: 'Pending', items: [{ name: 'Banners', quantity: 10, price: 6000 }] },
];
const ORDERS = [
  { id: 'SO-1', customerId: 'C-ABC', customerName: 'ABC School', orderNumber: 'SO-001', totalAmount: 120000, date: '2026-09-05', status: 'Processing' },
];
const SHIPMENTS = [
  { id: 'DN-1', orderId: 'SO-1', customerId: 'C-ABC', customerName: 'ABC School', status: 'In Transit', trackingNumber: 'TRK-1', estimatedDelivery: '2026-09-25' },
  { id: 'DN-X', orderId: 'SO-OTHER', customerId: 'C-OTHER', customerName: 'Other School', status: 'Delivered', trackingNumber: 'TRK-X', estimatedDelivery: '2026-09-01' },
];
const PAYMENTS_FULL: Record<string, unknown>[] = [
  { id: 'PAY-1', customerId: 'C-ABC', date: '2026-09-18', amount: 50000, amountApplied: 50000, paymentMethod: 'Bank Transfer', reference: 'RCP-001', allocations: [{ invoiceId: 'INV-1', amount: 50000 }] },
];

function mockStores(invoices = INVOICES, customers = CUSTOMERS, payments = PAYMENTS, extra: { quotations?: unknown[]; orders?: unknown[]; shipments?: unknown[] } = {}) {
  vi.mocked(dbService.getAll).mockImplementation(async (store: string) => {
    if (store === 'customers') return customers as unknown[];
    if (store === 'invoices') return invoices as unknown[];
    if (store === 'customerPayments') return payments as unknown[];
    if (store === 'quotations') return (extra.quotations || []) as unknown[];
    if (store === 'orders') return (extra.orders || []) as unknown[];
    if (store === 'shipments') return (extra.shipments || []) as unknown[];
    if (store === 'customerNotificationLogs') return [];
    return [];
  });
  vi.mocked(dbService.get).mockImplementation(async (store: string) => {
    if (store === 'customers') return { balance: 0 } as never;
    return undefined;
  });
}

function mockFullStores() {
  mockStores(INVOICES, CUSTOMERS, PAYMENTS_FULL, { quotations: QUOTATIONS, orders: ORDERS, shipments: SHIPMENTS });
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

describe('hardening boundaries (atomic invoice context)', () => {
  const baseOpts = {
    invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
  };

  it('1. Invoice-A message + Invoice-A attachment + Invoice-A verification URL passes', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const focal = getFocalInvoice(ctx);
    expect(focal?.invoiceNumber).toBe('INV-002');
    const descriptor = resolveInvoiceAttachmentDescriptor(ctx);
    expect(descriptor?.invoiceId).toBe(focal?.id);
    expect(descriptor?.verificationUrl).toBe(focal?.verificationUrl);
    const integrity = verifyAttachmentIntegrity(descriptor, ctx);
    expect(integrity.ok).toBe(true);
  });

  it('2. Invoice-A message + Invoice-B attachment descriptor is BLOCKED', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const descriptor = resolveInvoiceAttachmentDescriptor(ctx)!;
    const tampered = { ...descriptor, invoiceId: 'INV-1', invoiceNumber: 'INV-001' };
    const integrity = verifyAttachmentIntegrity(tampered, ctx);
    expect(integrity.ok).toBe(false);
  });

  it('3. Invoice-A attachment + Invoice-B verification URL is BLOCKED', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const descriptor = resolveInvoiceAttachmentDescriptor(ctx)!;
    const tampered = { ...descriptor, verificationUrl: 'http://localhost/#/verify/invoice/INV-001?t=tok123' };
    const integrity = verifyAttachmentIntegrity(tampered, ctx);
    expect(integrity.ok).toBe(false);
    // A draft carrying the wrong invoice URL is also blocked by fact validation.
    const v = validateDraftAgainstFacts(
      `Invoice INV-002 total K45,000.00 verify http://localhost/#/verify/invoice/INV-001?t=tok123`, ctx,
    );
    expect(v.ok).toBe(false);
  });

  it('4. AI changing K145,000.00 to K150,000.00 is BLOCKED at final validation', async () => {
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', baseOpts);
    const built = buildFinalPayload('whatsapp', 'Dear ABC School, your balance is K150,000.00.', ctx);
    expect(built.payload).toBeNull();
    expect(built.issues.join(' ')).toMatch(/K150,000/);
  });

  it('5. User editing K145,000.00 to K150,000.00 is BLOCKED at send', async () => {
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', baseOpts);
    const res = await sendCommunication({
      channel: 'whatsapp', recipientPhone: '260971000001', recipientEmail: null,
      message: 'Dear ABC School, your balance is K150,000.00.', ctx,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('blocked_validation');
    expect(res.attachmentIncluded).toBe(false);
  });

  it('6. Balance changing after preview BLOCKS and requires reconfirmation', async () => {
    const before = await buildCommunicationContext('payment_reminder', 'C-ABC', baseOpts);
    const after = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never,
      paymentsOverride: [{ customerId: 'C-ABC', amountApplied: 50000, status: 'Confirmed' }],
      openingBalanceOverride: 0,
    });
    const diff = diffFinancialFacts(before, after);
    expect(diff.changed).toBe(true);
    // The approved message (old balance) no longer validates against fresh facts.
    const built = buildFinalPayload('whatsapp', 'Dear ABC School, your balance is K145,000.00.', after);
    expect(built.payload).toBeNull();
  });

  it('7. Invoice changing after preview BLOCKS and requires reconfirmation', async () => {
    const before = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const afterInvoices = [
      ...INVOICES,
      { id: 'INV-3', customerId: 'C-ABC', customerName: 'ABC School', invoiceNumber: 'INV-003', totalAmount: 10000, paidAmount: 0, date: '2026-09-20', status: 'Pending', verificationToken: 'tok789' },
    ];
    const after = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: afterInvoices as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const diff = diffFinancialFacts(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.messages.join(' ')).toMatch(/INV-002.*INV-003|Focal invoice changed/);
  });

  it('8. Missing attachment BLOCKS an invoice send', async () => {
    mockStores(INVOICES, CUSTOMERS, PAYMENTS);
    const ctx = await buildCommunicationContext('send_specific_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    // No specific invoice selected → no attachment descriptor → blocked.
    const res = await sendCommunication({
      channel: 'email', recipientPhone: null, recipientEmail: 'abc@example.com',
      message: 'Dear ABC School, please see your invoice.', ctx,
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('blocked_validation');
    expect(res.attachmentIncluded).toBe(false);
  });

  it('9. Provider acceptance without delivery confirmation is NEVER "delivered"', async () => {
    mockStores(INVOICES, CUSTOMERS, PAYMENTS);
    vi.mocked(whatsappClient.getAccountInfo).mockReturnValue({
      id: 'wa-1', user_id: 'u1', phone_number_id: 'pnid', access_token: 'tok',
      display_name: 'x', connection_status: 'connected', last_connected_at: null,
      created_at: '', updated_at: '',
    });
    vi.mocked(whatsappClient.sendMessage).mockResolvedValue({ messageId: 'wamid-1' });
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', baseOpts);
    const res = await sendCommunication({
      channel: 'whatsapp', recipientPhone: '260971000001', recipientEmail: null,
      message: 'Dear ABC School, your balance is K145,000.00.', ctx,
    });
    expect(res.ok).toBe(true);
    expect(res.status).not.toBe('delivered');
    expect(res.status).toBe('submitted');
    expect(res.providerMessageId).toBe('wamid-1');
    expect(res.attachmentIncluded).toBe(false);
  });

  it('10. History records the EXACT final edited message, not just the AI draft', async () => {
    mockStores(INVOICES, CUSTOMERS, PAYMENTS);
    await recordCommunication({
      customerId: 'C-ABC', businessName: 'ABC School', purpose: 'payment_reminder',
      channel: 'whatsapp', tone: 'professional', aiDraft: 'AI wording K145,000.00',
      finalMessage: 'Edited final wording K145,000.00 — please pay today.',
      invoiceId: null, invoiceNumber: null, verificationUrl: null,
      hadAttachment: false, status: 'submitted', failureReason: null,
      aiGenerated: true, snapshotId: 's', factsSnapshot: '{}',
    });
    expect(dbService.put).toHaveBeenCalledWith('customerNotificationLogs', expect.objectContaining({
      aiDraft: 'AI wording K145,000.00',
      finalMessage: 'Edited final wording K145,000.00 — please pay today.',
    }));
  });

  it('11. WhatsApp capability honestly reflects the text-only Meta integration', () => {
    expect(CHANNEL_CAPABILITIES.whatsapp.supportsAttachment).toBe(false);
    expect(CHANNEL_CAPABILITIES.whatsapp.attachmentBehavior).toMatch(/NOT attached/i);
  });

  it('12. Email attachment is actually present in the SMTP payload path', async () => {
    mockStores(INVOICES, CUSTOMERS, PAYMENTS);
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const finalMessage = `Dear ABC School, invoice INV-002 total K45,000.00. Verify: ${ctx.latestInvoice?.verificationUrl}`;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, messageId: 'smtp-1', invoiceNumber: 'INV-002', attachmentFilename: 'INV-002.pdf', verificationUrl: ctx.latestInvoice?.verificationUrl }),
    });
    const res = await sendCommunication({
      channel: 'email', recipientPhone: null, recipientEmail: 'abc@example.com',
      message: finalMessage, ctx,
    });
    expect(res.ok).toBe(true);
    expect(res.attachmentIncluded).toBe(true);
    expect(res.attachmentFilename).toBe('INV-002.pdf');
    expect(res.status).toBe('submitted');
    const [, options] = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const sentBody = JSON.parse(String(options.body));
    expect(sentBody.invoiceId).toBe('INV-2');
    expect(sentBody.message).toBe(finalMessage);
  });

  it('13. SMS never claims a PDF attachment', async () => {
    mockStores(INVOICES, CUSTOMERS, PAYMENTS);
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', baseOpts);
    const res = await sendCommunication({
      channel: 'sms', recipientPhone: '260971000001', recipientEmail: null,
      message: 'Dear ABC School, your balance is K145,000.00.', ctx,
    });
    expect(res.attachmentIncluded).toBe(false);
    expect(res.detail).toMatch(/cannot carry a PDF|not integrated/i);
  });

  it('3b. Lowercase unknown-invoice reference (inv-999) is BLOCKED', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const v = validateDraftAgainstFacts('Invoice inv-999 total K145,000.00 from our company.', ctx);
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'invoice_mismatch')).toBe(true);
  });

  it('3c. Lowercase correct-invoice reference (inv-002) is accepted as INV-002', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const v = validateDraftAgainstFacts(`Invoice inv-002 total K45,000.00. Verify: ${ctx.latestInvoice?.verificationUrl}`, ctx);
    expect(v.ok).toBe(true);
  });

  it('14b. Verification-token fragments (tok456) are never read as monetary amounts', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    const v = validateDraftAgainstFacts(
      `Dear ABC School. Verify: ${ctx.latestInvoice?.verificationUrl}`, ctx,
    );
    expect(v.ok).toBe(true);
  });

  it('14. Verification URL is the canonical ERP URL (token + number, never guessed)', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', baseOpts);
    expect(ctx.latestInvoice?.verificationUrl).toContain('INV-002');
    expect(ctx.latestInvoice?.verificationUrl).toContain('tok456');
  });

  it('15. Duplicate warning is per customer/invoice/channel', async () => {    vi.mocked(dbService.getAll).mockImplementation(async (store: string) => {
      if (store === 'customers') return CUSTOMERS as unknown[];
      if (store === 'customerNotificationLogs') return [{
        id: 'h1', customerId: 'C-ABC', businessName: 'ABC School', purpose: 'send_latest_invoice',
        channel: 'whatsapp', tone: 'professional', aiDraft: 'x', finalMessage: 'y',
        invoiceId: 'INV-2', invoiceNumber: 'INV-002', verificationUrl: null, hadAttachment: true,
        status: 'submitted', failureReason: null, aiGenerated: true, snapshotId: 's', factsSnapshot: '{}',
        createdAt: new Date().toISOString(),
      }] as unknown[];
      return [];
    });
    const same = await findRecentInvoiceSend('C-ABC', 'INV-2');
    expect(same?.channel).toBe('whatsapp');
    expect(same?.status).toBe('submitted');
    const other = await findRecentInvoiceSend('C-ABC', 'INV-1');
    expect(other).toBeNull();
  });
});

describe('purpose-to-provider mapping (no invoice leakage)', () => {
  beforeEach(() => {
    mockFullStores();
  });

  it('1. Latest Invoice resolves the invoice provider', async () => {
    const ctx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(ctx.latestInvoice?.invoiceNumber).toBe('INV-002');
    expect(ctx.lastPayment).toBeNull();
    expect(ctx.quotation).toBeNull();
    expect(ctx.order).toBeNull();
    expect(ctx.delivery).toBeNull();
  });

  it('2. Latest Payment Receipt resolves the payment provider (never the invoice)', async () => {
    const ctx = await buildCommunicationContext('payment_confirmation', 'C-ABC', {
      paymentsOverride: PAYMENTS_FULL as unknown as never,
    });
    expect(ctx.lastPayment?.receiptNumber).toBe('RCP-001');
    expect(ctx.lastPayment?.amount).toBe(50000);
    expect(ctx.lastPayment?.allocatedInvoiceNumbers).toEqual(['INV-001']);
    expect(ctx.lastPayment?.remainingBalance).toBe(95000);
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.specificInvoice).toBeNull();
    expect(ctx.invoices).toEqual([]);
    // The AI input carries the resolved receipt — and no invoice block.
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    expect(prompt).toContain('RCP-001');
    expect(prompt).toContain('INV-001');
    expect(prompt).not.toContain('Invoice number:');
    expect(prompt).not.toContain('INV-002');
  });

  it('3. Latest Quotation resolves the open quotation with lines (never an invoice)', async () => {
    const ctx = await buildCommunicationContext('quotation_followup', 'C-ABC');
    // QTN-002 is open; converted QTN-001 must not win.
    expect(ctx.quotation?.number).toBe('QTN-002');
    expect(ctx.quotation?.total).toBe(60000);
    expect(ctx.quotation?.items).toEqual([{ name: 'Banners', quantity: 10, price: 6000, total: 60000 }]);
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.invoices).toEqual([]);
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    expect(prompt).toContain('QTN-002');
    expect(prompt).not.toContain('Invoice number:');
  });

  it('4. Latest Order resolves the sales-order provider (never an invoice)', async () => {
    const ctx = await buildCommunicationContext('order_update', 'C-ABC');
    expect(ctx.order?.number).toBe('SO-001');
    expect(ctx.order?.total).toBe(120000);
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.invoices).toEqual([]);
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    expect(prompt).toContain('SO-001');
    expect(prompt).not.toContain('Invoice number:');
    expect(prompt).not.toContain('INV-002');
  });

  it('5. Latest Delivery Note resolves the customer-linked shipment (never another customer, never an invoice)', async () => {
    const ctx = await buildCommunicationContext('delivery_notification', 'C-ABC');
    expect(ctx.delivery?.id).toBe('DN-1');
    expect(ctx.delivery?.orderId).toBe('SO-1');
    expect(ctx.delivery?.trackingNumber).toBe('TRK-1');
    expect(ctx.order?.number).toBe('SO-001');
    expect(ctx.latestInvoice).toBeNull();
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    expect(prompt).toContain('DN-1');
    expect(prompt).not.toContain('TRK-X');
    expect(prompt).not.toContain('Invoice number:');
  });

  it('6. Payment Reminder resolves outstanding/payment context without a focal invoice', async () => {
    const ctx = await buildCommunicationContext('payment_reminder', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(ctx.outstandingBalance).toBe(145000);
    expect(ctx.invoices.map((i) => i.invoiceNumber).sort()).toEqual(['INV-001', 'INV-002']);
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.specificInvoice).toBeNull();
    expect(ctx.lastPayment).toBeNull();
  });

  it('7. Account Statement resolves statement context without a focal invoice', async () => {
    const ctx = await buildCommunicationContext('outstanding_balance', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(ctx.outstandingBalance).toBe(145000);
    expect(ctx.invoices).toHaveLength(2);
    expect(ctx.latestInvoice).toBeNull();
    expect(ctx.specificInvoice).toBeNull();
    expect(ctx.quotation).toBeNull();
    expect(ctx.order).toBeNull();
  });

  it('8. Changing Invoice purpose to Receipt clears old invoice context', async () => {
    const invoiceCtx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(invoiceCtx.latestInvoice?.invoiceNumber).toBe('INV-002');
    const receiptCtx = await buildCommunicationContext('payment_confirmation', 'C-ABC', {
      paymentsOverride: PAYMENTS_FULL as unknown as never,
    });
    expect(receiptCtx.latestInvoice).toBeNull();
    expect(receiptCtx.specificInvoice).toBeNull();
    expect(receiptCtx.invoices).toEqual([]);
    expect(receiptCtx.lastPayment?.receiptNumber).toBe('RCP-001');
    expect(receiptCtx.snapshotId).not.toBe(invoiceCtx.snapshotId);
  });

  it('9. Changing Invoice purpose to Quotation clears old invoice context', async () => {
    const receiptCtx = await buildCommunicationContext('quotation_followup', 'C-ABC');
    expect(receiptCtx.quotation?.number).toBe('QTN-002');
    expect(receiptCtx.latestInvoice).toBeNull();
    expect(receiptCtx.invoices).toEqual([]);
    expect(receiptCtx.lastPayment).toBeNull();
    expect(receiptCtx.order).toBeNull();
    expect(receiptCtx.delivery).toBeNull();
  });

  it('10. Changing Receipt purpose back to Invoice rebuilds invoice context', async () => {
    await buildCommunicationContext('payment_confirmation', 'C-ABC', {
      paymentsOverride: PAYMENTS_FULL as unknown as never,
    });
    const invoiceCtx = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(invoiceCtx.latestInvoice?.invoiceNumber).toBe('INV-002');
    expect(invoiceCtx.latestInvoice?.verificationUrl).toContain('tok456');
    expect(invoiceCtx.lastPayment).toBeNull();
  });

  it('11. Customer change invalidates previous context (no cross-customer bleed)', async () => {
    const abc = await buildCommunicationContext('send_latest_invoice', 'C-ABC', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    const xyz = await buildCommunicationContext('send_latest_invoice', 'C-XYZ', {
      invoicesOverride: INVOICES as unknown as never, paymentsOverride: [], openingBalanceOverride: 0,
    });
    expect(xyz.customer.businessName).toBe('XYZ School');
    expect(xyz.latestInvoice).toBeNull();
    expect(xyz.invoices).toEqual([]);
    expect(xyz.snapshotId).not.toBe(abc.snapshotId);
    expect(xyz.warnings.join(' ')).toMatch(/No invoice found/i);
  });
});

describe('stale generation protection', () => {
  it('12. Stale async context responses cannot overwrite the current purpose', () => {
    const guard = createGenerationGuard();
    // User selects Purpose A and generation starts…
    const tokenA = guard.next('C-ABC', 'send_latest_invoice', 1);
    expect(guard.isCurrent(tokenA)).toBe(true);
    // …user switches to Purpose B and generation starts…
    const tokenB = guard.next('C-ABC', 'payment_confirmation', 2);
    expect(guard.isCurrent(tokenB)).toBe(true);
    // …Purpose A response returns late and must be discarded.
    expect(guard.isCurrent(tokenA)).toBe(false);
    // Regenerating the same customer+purpose also invalidates the old token.
    const tokenB2 = guard.next('C-ABC', 'payment_confirmation', 3);
    expect(guard.isCurrent(tokenB)).toBe(false);
    expect(guard.isCurrent(tokenB2)).toBe(true);
    // A token from another customer never validates.
    expect(guard.isCurrent({ ...tokenB2, customerId: 'C-XYZ' })).toBe(false);
  });
});

describe('attachment and verification isolation', () => {
  beforeEach(() => {
    mockFullStores();
  });

  it('13. Receipt purpose cannot inherit an invoice attachment', async () => {
    const ctx = await buildCommunicationContext('payment_confirmation', 'C-ABC', {
      paymentsOverride: PAYMENTS_FULL as unknown as never,
    });
    expect(ctx.latestInvoice).toBeNull();
    const descriptor = resolveInvoiceAttachmentDescriptor(ctx);
    expect(descriptor).toBeNull();
    expect(verifyAttachmentIntegrity(descriptor, ctx).ok).toBe(true);
  });

  it('14. Quotation purpose cannot inherit an invoice attachment', async () => {
    const ctx = await buildCommunicationContext('quotation_followup', 'C-ABC');
    expect(ctx.quotation?.number).toBe('QTN-002');
    expect(resolveInvoiceAttachmentDescriptor(ctx)).toBeNull();
  });

  it('15. Non-invoice purpose cannot inherit an invoice verification URL', async () => {
    const ctx = await buildCommunicationContext('order_update', 'C-ABC');
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    expect(prompt).not.toContain('Verification URL:');
    expect(prompt).not.toContain('tok456');
    // A draft smuggling the invoice verification link is blocked.
    const v = validateDraftAgainstFacts(
      `Order SO-001 total K120,000.00 is ready. Verify: http://localhost/#/verify/invoice/INV-002?t=tok456`,
      ctx,
    );
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i.code === 'url_mismatch')).toBe(true);
  });

  it('16. AI receives purpose-specific resolved facts (never selects the source)', async () => {
    const ctx = await buildCommunicationContext('payment_confirmation', 'C-ABC', {
      paymentsOverride: PAYMENTS_FULL as unknown as never,
    });
    const prompt = buildDraftPrompt(ctx, { tone: 'professional', length: 'standard' }).user;
    // Deterministically resolved receipt facts reach the AI input…
    expect(prompt).toContain('RCP-001');
    expect(prompt).toContain('K50,000.00');
    expect(prompt).toContain('INV-001');
    // …while the unselected latest invoice never does.
    expect(prompt).not.toContain('INV-002');
    expect(prompt).not.toContain('Invoice number:');
  });
});

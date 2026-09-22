/**
 * communicationInvoiceEmail.test.cjs — Communication Center hardening.
 *
 * Verifies the ERP-only invoice-email service (used by
 * POST /api/communication/invoice-email):
 *  - attachment belongs to the message invoice (atomicity enforced server-side)
 *  - verification URL is canonical (token + number, never guessed)
 *  - SMTP payload actually contains the PDF attachment
 *  - failures never claim success
 */

const { sendInvoiceEmail } = require('../services/communicationInvoiceEmailService.cjs');

const INVOICE = {
  id: 'INV-2',
  customerId: 'C-ABC',
  invoiceNumber: 'INV-002',
  totalAmount: 45000,
  paidAmount: 5000,
  verificationToken: 'tok456',
};

function makeDeps(overrides = {}) {
  return {
    getInvoiceById: jest.fn(async (invoiceId, customerId) => {
      if (invoiceId === 'INV-2' && customerId === 'C-ABC') return { ...INVOICE };
      return null;
    }),
    getCustomerById: jest.fn(async () => ({ id: 'C-ABC', business_name: 'ABC School' })),
    getCompanyConfig: jest.fn(async () => ({ companyName: 'Prime Printing' })),
    renderOfficialPdf: jest.fn(async () => ({ buffer: Buffer.from('%PDF-1.4 fake-bytes'), contentType: 'application/pdf' })),
    sendEmailWithAttachment: jest.fn(async () => ({ success: true, messageId: 'smtp-1' })),
    portalBaseUrl: 'https://portal.example.test',
    ...overrides,
  };
}

describe('communicationInvoiceEmailService', () => {
  test('sends message + REAL attachment + canonical verification URL', async () => {
    const deps = makeDeps();
    const result = await sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Dear ABC School, invoice INV-002 total K45,000.00.',
    });

    expect(result.success).toBe(true);
    expect(result.messageId).toBe('smtp-1');
    expect(result.invoiceNumber).toBe('INV-002');
    expect(result.attachmentFilename).toBe('INV-002.pdf');
    expect(result.verificationUrl).toBe('https://portal.example.test/#/verify/invoice/INV-002?t=tok456');

    // The SMTP payload ACTUALLY contains the PDF attachment.
    expect(deps.sendEmailWithAttachment).toHaveBeenCalledTimes(1);
    const payload = deps.sendEmailWithAttachment.mock.calls[0][0];
    expect(payload.to).toBe('abc@example.com');
    expect(payload.filename).toBe('INV-002.pdf');
    expect(payload.contentType).toBe('application/pdf');
    expect(Buffer.isBuffer(payload.content)).toBe(true);
    expect(payload.content.length).toBeGreaterThan(0);
    // Server facts footer comes from the SERVER record, not the client.
    expect(payload.body).toContain('INV-002');
    expect(payload.body).toContain('https://portal.example.test/#/verify/invoice/INV-002?t=tok456');

    // Canonical renderer used exactly once with the authoritative record.
    expect(deps.renderOfficialPdf).toHaveBeenCalledWith(expect.objectContaining({
      type: 'INVOICE',
      channel: 'erp',
    }));
  });

  test('Invoice-A message + Invoice-B attachment is BLOCKED', async () => {
    const deps = makeDeps();
    await expect(sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Please see invoice INV-001 attached.',
    })).rejects.toMatchObject({ code: 'INVOICE_MISMATCH', status: 400 });
    expect(deps.renderOfficialPdf).not.toHaveBeenCalled();
    expect(deps.sendEmailWithAttachment).not.toHaveBeenCalled();
  });

  test('lowercase wrong-invoice reference (inv-001) is BLOCKED', async () => {
    const deps = makeDeps();
    await expect(sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Please see invoice inv-001 attached.',
    })).rejects.toMatchObject({ code: 'INVOICE_MISMATCH', status: 400 });
    expect(deps.sendEmailWithAttachment).not.toHaveBeenCalled();
  });

  test('lowercase correct-invoice reference (inv-002) is accepted as INV-002', async () => {
    const deps = makeDeps();
    const result = await sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Dear ABC School, invoice inv-002 total K45,000.00.',
    });
    expect(result.success).toBe(true);
    expect(result.invoiceNumber).toBe('INV-002');
  });

  test('foreign invoice id resolves to NOT_FOUND (no cross-customer leak)', async () => {
    const deps = makeDeps();
    await expect(sendInvoiceEmail(deps, {
      customerId: 'C-OTHER',
      invoiceId: 'INV-2',
      customerEmail: 'other@example.com',
      message: 'Hello.',
    })).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(deps.sendEmailWithAttachment).not.toHaveBeenCalled();
  });

  test('missing verification token/base yields NO invented URL (still sends)', async () => {
    const deps = makeDeps({
      getInvoiceById: jest.fn(async () => ({ ...INVOICE, verificationToken: null })),
      portalBaseUrl: '',
    });
    const result = await sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Dear ABC School, invoice INV-002 attached.',
    });
    expect(result.success).toBe(true);
    expect(result.verificationUrl).toBeNull();
    const payload = deps.sendEmailWithAttachment.mock.calls[0][0];
    expect(payload.body).not.toContain('Verify authenticity');
  });

  test('empty rendered document BLOCKS the send (never an empty attachment)', async () => {
    const deps = makeDeps({ renderOfficialPdf: jest.fn(async () => ({ buffer: Buffer.alloc(0) })) });
    await expect(sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Dear ABC School, invoice INV-002 attached.',
    })).rejects.toMatchObject({ code: 'RENDER_FAILED' });
    expect(deps.sendEmailWithAttachment).not.toHaveBeenCalled();
  });

  test('SMTP failure never claims success', async () => {
    const deps = makeDeps({ sendEmailWithAttachment: jest.fn(async () => { throw new Error('SMTP configuration missing in production.'); }) });
    await expect(sendInvoiceEmail(deps, {
      customerId: 'C-ABC',
      invoiceId: 'INV-2',
      customerEmail: 'abc@example.com',
      message: 'Dear ABC School, invoice INV-002 attached.',
    })).rejects.toThrow('SMTP configuration missing');
  });
});

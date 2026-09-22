/**
 * communicationInvoiceEmailService.cjs — ERP staff invoice email (Communication Center).
 *
 * Reuses ONLY existing infrastructure: authoritative invoice fetch,
 * officialDocumentService.renderOfficialPdf (the ONE canonical renderer),
 * canonical verification-URL rule, emailService.sendEmailWithAttachment.
 *
 * Atomicity is enforced here (not just in the UI): the invoice must belong
 * to the customer, and the message must not reference a different invoice
 * number — otherwise the send is BLOCKED with a coded error. Never
 * Invoice-A message + Invoice-B attachment.
 *
 * Never claims delivery — returns SMTP acceptance (messageId) only.
 */

function codedError(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function extractInvoiceNumbers(text) {
  const found = new Set();
  // Case-insensitive: inv-002 / Inv-002 are the same reference as INV-002
  // (callers compare upper-cased; canonical formatting untouched).
  const re = /\b((?:INV|QTN|SO|ORD|PAY|RCP|DN|PO)-[A-Za-z0-9\-/]+)\b/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) found.add(m[1].toUpperCase());
  return [...found];
}

function money(n) {
  return `K${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function sendInvoiceEmail(deps, input) {
  const { getInvoiceById, getCustomerById, getCompanyConfig, renderOfficialPdf, sendEmailWithAttachment, portalBaseUrl } = deps;
  const { customerId, invoiceId, customerEmail, message } = input || {};
  if (!customerId || !invoiceId || !customerEmail || !String(message || '').trim()) {
    throw codedError('REQUIRED', 'customerId, invoiceId, customerEmail and message are required', 400);
  }

  const invoice = await getInvoiceById(invoiceId, customerId);
  if (!invoice) {
    throw codedError('NOT_FOUND', 'Invoice not found for this customer', 404);
  }
  const serverNumber = String(invoice.invoiceNumber || invoice.invoice_number || invoice.id || '').trim();
  if (!serverNumber) {
    throw codedError('NO_NUMBER', 'Invoice has no official number — cannot attach', 500);
  }

  for (const num of extractInvoiceNumbers(message)) {
    if (num !== serverNumber.toUpperCase()) {
      throw codedError('INVOICE_MISMATCH', `Message references ${num} but the attachment is ${serverNumber} — blocked`, 400);
    }
  }

  const customer = getCustomerById ? await getCustomerById(customerId).catch(() => null) : null;
  const companyConfig = getCompanyConfig ? await getCompanyConfig().catch(() => ({})) : {};
  const total = Number(invoice.totalAmount ?? invoice.total_amount ?? invoice.total ?? 0) || 0;
  const paid = Number(invoice.paidAmount ?? invoice.paid_amount ?? 0) || 0;
  const outstanding = Math.max(0, total - paid);

  const token = String(invoice.verificationToken || invoice.verification_token || '').trim();
  const base = String(portalBaseUrl || '').trim().replace(/\/+$/, '');
  const verificationUrl = token && base
    ? `${base}/#/verify/invoice/${encodeURIComponent(serverNumber)}?t=${encodeURIComponent(token)}`
    : null;

  const rendered = await renderOfficialPdf({
    type: 'INVOICE',
    rawData: invoice,
    customers: customer ? [customer] : [],
    channel: 'erp',
  });
  const buffer = rendered && rendered.buffer;
  if (!buffer || buffer.length === 0) {
    throw codedError('RENDER_FAILED', 'official_document_generation_failed', 500);
  }

  const companyName = (companyConfig && companyConfig.companyName) || 'Prime ERP';
  const bodyText = `${String(message).trim()}\n\n---\nInvoice ${serverNumber} — Total ${money(total)}, Paid ${money(paid)}, Outstanding ${money(outstanding)}.${verificationUrl ? `\nVerify authenticity: ${verificationUrl}` : ''}`;

  const result = await sendEmailWithAttachment({
    to: customerEmail,
    subject: `Invoice ${serverNumber} from ${companyName}`,
    body: bodyText,
    filename: `${serverNumber}.pdf`,
    content: buffer,
    contentType: 'application/pdf',
    senderName: companyName,
  });

  return {
    success: true,
    messageId: result.messageId,
    invoiceNumber: serverNumber,
    verificationUrl,
    attachmentFilename: `${serverNumber}.pdf`,
  };
}

module.exports = { sendInvoiceEmail };

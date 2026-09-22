/**
 * communicationTypes.ts — Customer Communication Center type contracts.
 *
 * Design rule: ERP FACTS are deterministic/authoritative; AI CONTENT is
 * wording/tone only. Every purpose declares the ERP context it may use so
 * the AI can never be given (or invent) unrelated financial data.
 *
 * Reuses canonical ERP models — no duplicate customer/invoice logic here.
 */

export type CommunicationPurposeId =
  | 'welcome'
  | 'payment_reminder'
  | 'send_latest_invoice'
  | 'send_specific_invoice'
  | 'payment_confirmation'
  | 'outstanding_balance'
  | 'quotation_followup'
  | 'order_update'
  | 'delivery_notification'
  | 'thank_you'
  | 'custom';

export type CommunicationTone = 'professional' | 'friendly' | 'formal' | 'warm' | 'concise';
export type CommunicationLength = 'short' | 'standard' | 'detailed';
export type CommunicationChannel = 'whatsapp' | 'sms' | 'email';

export interface CommunicationPurpose {
  id: CommunicationPurposeId;
  label: string;
  description: string;
  /** ERP fact keys this purpose is allowed to receive. */
  allowedFacts: Array<
    | 'customer'
    | 'company'
    | 'outstandingBalance'
    | 'invoices'
    | 'latestInvoice'
    | 'specificInvoice'
    | 'lastPayment'
    | 'quotation'
    | 'order'
    | 'delivery'
    | 'paymentMethods'
    | 'verificationUrl'
    | 'document'
  >;
  requiresInvoice: boolean;
  supportsAttachment: boolean;
  supportsVerificationUrl: boolean;
}

export const COMMUNICATION_PURPOSES: CommunicationPurpose[] = [
  { id: 'welcome', label: 'Welcome New Customer', description: 'Greet a new customer with company info.', allowedFacts: ['customer', 'company'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'payment_reminder', label: 'Payment Reminder', description: 'Remind about outstanding balance and relevant invoices.', allowedFacts: ['customer', 'company', 'outstandingBalance', 'invoices', 'paymentMethods'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'send_latest_invoice', label: 'Send Latest Invoice', description: 'Send the customer’s actual latest ERP invoice with document + verification link.', allowedFacts: ['customer', 'company', 'latestInvoice', 'paymentMethods', 'verificationUrl', 'document'], requiresInvoice: true, supportsAttachment: true, supportsVerificationUrl: true },
  { id: 'send_specific_invoice', label: 'Send Specific Invoice', description: 'Send a chosen invoice with document + verification link.', allowedFacts: ['customer', 'company', 'specificInvoice', 'paymentMethods', 'verificationUrl', 'document'], requiresInvoice: true, supportsAttachment: true, supportsVerificationUrl: true },
  { id: 'payment_confirmation', label: 'Invoice Payment Confirmation', description: 'Confirm a received payment against an invoice.', allowedFacts: ['customer', 'company', 'specificInvoice', 'lastPayment'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'outstanding_balance', label: 'Outstanding Balance Reminder', description: 'Statement-style balance reminder with invoice breakdown.', allowedFacts: ['customer', 'company', 'outstandingBalance', 'invoices', 'paymentMethods'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'quotation_followup', label: 'Quotation Follow-up', description: 'Follow up on the latest open quotation.', allowedFacts: ['customer', 'company', 'quotation'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'order_update', label: 'Order Update', description: 'Update on the latest sales order.', allowedFacts: ['customer', 'company', 'order'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'delivery_notification', label: 'Delivery Notification', description: 'Notify about delivery/shipment status.', allowedFacts: ['customer', 'company', 'delivery', 'order'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'thank_you', label: 'Thank You / Appreciation', description: 'Thank the customer for their business.', allowedFacts: ['customer', 'company', 'latestInvoice'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
  { id: 'custom', label: 'Custom Message', description: 'Free-form message with customer identity only.', allowedFacts: ['customer', 'company'], requiresInvoice: false, supportsAttachment: false, supportsVerificationUrl: false },
];

export function getPurpose(id: CommunicationPurposeId): CommunicationPurpose {
  const found = COMMUNICATION_PURPOSES.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown communication purpose: ${id}`);
  return found;
}

/** Authoritative invoice facts — straight from the ERP invoice record. */
export interface InvoiceFacts {
  id: string;
  invoiceNumber: string;
  date: string | null;
  dueDate: string | null;
  total: number;
  paid: number;
  outstanding: number;
  status: string;
  verificationToken: string | null;
  verificationUrl: string | null;
  hasDocument: boolean;
}

export interface CustomerFacts {
  id: string;
  businessName: string;
  contactName: string;
  phone: string | null;
  email: string | null;
}

export interface CompanyFacts {
  name: string;
  paymentMethodsSummary: string;
  bankAccounts: Array<{ bankName: string; accountName: string; accountNumber: string }>;
  mobileMoneyAccounts: Array<{ network: string; accountName: string; phoneNumber: string }>;
}

/** Single authoritative context object handed to AI + preview + send. */
export interface CommunicationContext {
  purpose: CommunicationPurposeId;
  customer: CustomerFacts;
  company: CompanyFacts;
  outstandingBalance: number | null;
  invoices: InvoiceFacts[];
  latestInvoice: InvoiceFacts | null;
  specificInvoice: InvoiceFacts | null;
  lastPayment: { id: string; date: string | null; amount: number; method: string | null } | null;
  quotation: { id: string; number: string; total: number; validUntil: string | null; status: string } | null;
  order: { id: string; total: number; status: string; deliveryDate: string | null } | null;
  delivery: { id: string; status: string; trackingNumber: string | null; estimatedDelivery: string | null } | null;
  warnings: string[];
  snapshotId: string;
  fetchedAt: string;
}

export interface FactValidationIssue {
  code: 'amount_mismatch' | 'invoice_mismatch' | 'customer_mismatch' | 'url_mismatch' | 'payment_mismatch' | 'date_mismatch';
  message: string;
  expected: string;
  foundInDraft: string;
}

export interface FactValidationResult {
  ok: boolean;
  issues: FactValidationIssue[];
}

/**
 * Honest outbound delivery states — only what the provider can truthfully
 * establish. "submitted" means the provider accepted the payload (messageId)
 * WITHOUT delivery confirmation. "delivered" is used ONLY when the provider
 * supplies delivery confirmation (none of the current providers do for these
 * paths, so it must not be claimed).
 */
export type OutboundStatus =
  | 'draft'
  | 'queued'
  | 'submitted'
  | 'sent_accepted'
  | 'delivered'
  | 'failed'
  | 'blocked_validation'
  | 'blocked_stale';

/**
 * Atomic invoice attachment descriptor. The actual PDF bytes are rendered
 * server-side by the canonical officialDocumentService at send time — this
 * descriptor binds message + document + verification URL to ONE invoice so
 * integrity can be verified before sending. Never report "attached" unless
 * the outbound payload actually contains the document.
 */
export interface InvoiceAttachmentDescriptor {
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  filename: string;
  mimeType: 'application/pdf';
  /** Declared size when known (server render); null until rendered. */
  sizeBytes: number | null;
  source: 'erp-official-document';
  verificationUrl: string | null;
}

export interface CommunicationHistoryRecord {
  id: string;
  customerId: string;
  businessName: string;
  purpose: CommunicationPurposeId;
  channel: CommunicationChannel;
  tone: CommunicationTone;
  aiDraft: string;
  /** EXACT final message transmitted (post-edit, post-injection) — never just the AI draft. */
  finalMessage: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  verificationUrl: string | null;
  hadAttachment: boolean;
  attachmentFilename: string | null;
  attachmentIncluded: boolean;
  status: OutboundStatus | 'sent';
  failureReason: string | null;
  operator: string | null;
  providerMessageId: string | null;
  aiGenerated: boolean;
  snapshotId: string;
  factsSnapshot: string;
  createdAt: string;
}

export interface ChannelCapability {
  label: string;
  supportsAttachment: boolean;
  supportsClickableUrl: boolean;
  note: string;
  /** Exact attachment behavior — shown in preview so limits are explicit. */
  attachmentBehavior: string;
}

export const CHANNEL_CAPABILITIES: Record<CommunicationChannel, ChannelCapability> = {
  whatsapp: {
    label: 'WhatsApp',
    supportsAttachment: false,
    supportsClickableUrl: true,
    note: 'Text + clickable verification link via Meta API (text-only integration).',
    attachmentBehavior: 'The current Meta integration sends TEXT ONLY — no document endpoint is wired. The invoice PDF is NOT attached; share it from the ERP document viewer/download.',
  },
  sms: {
    label: 'SMS',
    supportsAttachment: false,
    supportsClickableUrl: false,
    note: 'Plain text only (160-char segments). Verification URL included as plain text.',
    attachmentBehavior: 'SMS cannot carry a PDF attachment. Message + verification URL (plain text) only.',
  },
  email: {
    label: 'Email',
    supportsAttachment: true,
    supportsClickableUrl: true,
    note: 'Message + verification link + real invoice PDF via the ERP backend.',
    attachmentBehavior: 'The official invoice PDF is rendered server-side (canonical renderer) and attached to the SMTP payload. Status reflects SMTP acceptance, not inbox delivery.',
  },
};

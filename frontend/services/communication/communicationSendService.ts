/**
 * communicationSendService.ts — delivery layer (content vs channel split).
 *
 * Hardened sequence (enforced at this boundary, not just in the UI):
 *   fresh ERP ctx + EXACT final message
 *   → FINAL PAYLOAD VALIDATION (facts + attachment integrity, on what will send)
 *   → channel payload (message + REAL document + canonical URL where supported)
 *   → provider result → HONEST delivery status → audit
 *
 * Honesty rules:
 *  - "attached" is reported ONLY when the outbound payload actually contains
 *    the document (email via backend invoice-email route). WhatsApp (text-only
 *    Meta integration) and SMS NEVER claim an attachment.
 *  - "submitted"/"sent_accepted" mean the provider accepted the payload
 *    (messageId). "delivered" is NEVER claimed — no provider here supplies
 *    delivery confirmation.
 *  - Never reports success unless the underlying operation succeeded.
 */

import { whatsappClient } from '../whatsappClientService';
import { whatsAppMarketingService } from '../whatsAppMarketingService';
import { dbService } from '../db';
import type {
  CommunicationChannel,
  CommunicationContext,
  InvoiceAttachmentDescriptor,
  OutboundStatus,
} from './communicationTypes';
import { validateDraftAgainstFacts } from './communicationValidation';
import {
  getFocalInvoice,
  isInvoicePurpose,
  resolveInvoiceAttachmentDescriptor,
  verifyAttachmentIntegrity,
} from './invoiceAttachmentService';

export interface SendRequest {
  channel: CommunicationChannel;
  recipientPhone: string | null;
  recipientEmail: string | null;
  /** EXACT final message (post-edit, post-injection) — this is what is validated and sent. */
  message: string;
  /** Freshly revalidated ERP context (last-moment revalidation, not generation-time). */
  ctx: CommunicationContext;
}

export interface FinalPayload {
  channel: CommunicationChannel;
  message: string;
  ctx: CommunicationContext;
  attachment: InvoiceAttachmentDescriptor | null;
}

export interface SendResult {
  ok: boolean;
  status: OutboundStatus;
  providerMessageId: string | null;
  channel: CommunicationChannel;
  detail: string;
  queuedLocally: boolean;
  attachmentIncluded: boolean;
  attachmentFilename: string | null;
}

function digitsOnly(phone: string | null): string {
  return String(phone || '').replace(/[^0-9]/g, '');
}

/**
 * Build + FINAL-validate the exact payload that will be sent. Returns the
 * payload or the blocking issues (caller must block the send on issues).
 */
export function buildFinalPayload(
  channel: CommunicationChannel,
  finalMessage: string,
  freshCtx: CommunicationContext,
): { payload: FinalPayload | null; issues: string[] } {
  const message = String(finalMessage || '').trim();
  if (!message) return { payload: null, issues: ['Message is empty.'] };
  const factCheck = validateDraftAgainstFacts(message, freshCtx);
  if (!factCheck.ok) {
    return { payload: null, issues: factCheck.issues.map((i) => i.message) };
  }
  const attachment = resolveInvoiceAttachmentDescriptor(freshCtx);
  const integrity = verifyAttachmentIntegrity(attachment, freshCtx);
  if (!integrity.ok) {
    return { payload: null, issues: integrity.issues };
  }
  return { payload: { channel, message, ctx: freshCtx, attachment }, issues: [] };
}

export async function sendCommunication(req: SendRequest): Promise<SendResult> {
  const built = buildFinalPayload(req.channel, req.message, req.ctx);
  if (!built.payload) {
    return {
      ok: false, status: 'blocked_validation', providerMessageId: null,
      channel: req.channel, detail: `Final payload validation failed: ${built.issues.join(' ')}`,
      queuedLocally: false, attachmentIncluded: false, attachmentFilename: null,
    };
  }
  const payload = built.payload;

  if (req.channel === 'whatsapp') {
    return sendWhatsApp(payload, req.recipientPhone);
  }
  if (req.channel === 'sms') {
    return sendSms(payload, req.recipientPhone);
  }
  return sendEmail(payload, req.recipientEmail);
}

async function sendWhatsApp(payload: FinalPayload, recipientPhone: string | null): Promise<SendResult> {
  const to = digitsOnly(recipientPhone);
  if (!to) {
    return fail(payload, 'Customer has no phone number for WhatsApp.');
  }
  // TEXT-ONLY integration: the invoice PDF is NEVER in this payload.
  const account = whatsappClient.getAccountInfo();
  if (account?.phone_number_id && account?.access_token) {
    try {
      const res = await whatsappClient.sendMessage(account.phone_number_id, account.access_token, to, payload.message);
      try {
        const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('nexus_user') : null;
        const user = raw ? JSON.parse(raw) : null;
        if (user) await whatsappClient.logMessage(account.id, user.id, to, payload.message, 'sent', 'outbound', res.messageId);
      } catch { /* logging is best-effort */ }
      return {
        ok: true, status: 'submitted', providerMessageId: res.messageId, channel: payload.channel,
        detail: `Meta accepted the text message (${res.messageId}). Delivery to the handset is NOT confirmed. Invoice PDF NOT attached (text-only integration) — share it from the ERP document viewer.`,
        queuedLocally: false, attachmentIncluded: false, attachmentFilename: null,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Meta API send failed';
      await mirrorToLocalOutbox(payload, `WhatsApp provider failed: ${reason}`);
      return fail(payload, `WhatsApp provider failed: ${reason}. Mirrored to local outbox as failed.`, true);
    }
  }
  await mirrorToLocalOutbox(payload, null);
  return {
    ok: true, status: 'queued', providerMessageId: null, channel: payload.channel,
    detail: 'WhatsApp provider not configured — queued in ERP outbox (local). Configure Meta API under WhatsApp Hub → Connect to send externally. Invoice PDF NOT attached (text-only integration).',
    queuedLocally: true, attachmentIncluded: false, attachmentFilename: null,
  };
}

async function sendSms(payload: FinalPayload, recipientPhone: string | null): Promise<SendResult> {
  const to = digitsOnly(recipientPhone);
  if (!to) return fail(payload, 'Customer has no phone number for SMS.');
  // SMS can never carry a PDF — message + verification URL text only.
  await mirrorToLocalOutbox(payload, 'SMS provider not configured');
  return fail(payload, 'SMS provider is not integrated in this ERP. Message saved to ERP outbox as failed — configure an SMS gateway to enable. No attachment was sent (SMS cannot carry a PDF).', true);
}

async function sendEmail(payload: FinalPayload, recipientEmail: string | null): Promise<SendResult> {
  const to = String(recipientEmail || '').trim();
  if (!to) return fail(payload, 'Customer has no email address.');
  const focal = getFocalInvoice(payload.ctx);
  if (!isInvoicePurpose(payload.ctx.purpose) || !focal) {
    await mirrorToLocalOutbox(payload, 'No ERP email route for non-invoice messages');
    return fail(payload, 'Email is supported for invoice communication (message + real PDF + verification link). For non-invoice purposes use WhatsApp or copy the message manually.', true);
  }
  if (!payload.attachment) {
    return fail(payload, `Invoice ${focal.invoiceNumber} has no attachment descriptor — refusing to send without the document.`);
  }
  try {
    const response = await fetch('/api/communication/invoice-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerId: payload.ctx.customer.id,
        invoiceId: focal.id,
        customerEmail: to,
        message: payload.message,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.success) {
      const reason = String(body.error || `Backend rejected the send (${response.status})`);
      await mirrorToLocalOutbox(payload, `Invoice email failed: ${reason}`);
      return fail(payload, `Invoice email failed: ${reason}. No attachment was delivered.`, true);
    }
    // Post-send atomicity check: server-confirmed document must be OUR invoice.
    if (String(body.invoiceNumber || '') !== focal.invoiceNumber || String(body.attachmentFilename || '') !== payload.attachment.filename) {
      await mirrorToLocalOutbox(payload, 'Server attachment identity mismatch');
      return fail(payload, `Server attachment (${body.invoiceNumber}/${body.attachmentFilename}) does not match message invoice ${focal.invoiceNumber} — recorded as failed.`, true);
    }
    return {
      ok: true, status: 'submitted', providerMessageId: String(body.messageId || '') || null, channel: payload.channel,
      detail: `SMTP accepted the email with invoice ${focal.invoiceNumber} attached (${body.messageId || 'no id'}). Inbox delivery is NOT confirmed.${body.verificationUrl ? ' Canonical verification URL included.' : ' No canonical verification URL exists for this invoice — none was invented.'}`,
      queuedLocally: false, attachmentIncluded: true, attachmentFilename: payload.attachment.filename,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Email request failed';
    await mirrorToLocalOutbox(payload, `Invoice email transport failed: ${reason}`);
    return fail(payload, `Invoice email transport failed: ${reason}. No attachment was delivered.`, true);
  }
}

function fail(payload: FinalPayload, detail: string, queuedLocally = false): SendResult {
  return {
    ok: false, status: 'failed', providerMessageId: null, channel: payload.channel,
    detail, queuedLocally, attachmentIncluded: false, attachmentFilename: null,
  };
}

async function mirrorToLocalOutbox(payload: FinalPayload, failureNote: string | null): Promise<void> {
  try {
    const chats = await whatsAppMarketingService.getChats();
    const to = digitsOnly(payload.ctx.customer.phone);
    const existing = chats.find((c) => c.customerId === payload.ctx.customer.id || (to && c.customerPhone === to));
    if (existing) {
      await whatsAppMarketingService.sendMessage(existing.id, payload.message);
    } else if (to) {
      const chat = {
        id: `chat-${to}`,
        customerId: payload.ctx.customer.id,
        customerName: payload.ctx.customer.businessName,
        customerPhone: to,
        lastMessage: payload.message,
        lastMessageAt: new Date().toISOString(),
        status: 'read' as const,
        priority: 'normal' as const,
        tags: ['communication-center'],
        messages: [],
        unreadCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await dbService.put('whatsappChats', chat);
      await whatsAppMarketingService.sendMessage(chat.id, payload.message);
    }
  } catch { /* mirror is best-effort; history record is authoritative */ }
  if (failureNote) {
    try {
      await dbService.put('customerNotificationLogs', {
        id: `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'COMMUNICATION_OUTBOX',
        entityId: payload.ctx.customer.id,
        customerName: payload.ctx.customer.businessName,
        phoneNumber: payload.ctx.customer.phone || '',
        message: payload.message,
        timestamp: new Date().toISOString(),
        status: 'failed',
        deliveryMode: 'queued',
        error: failureNote,
      });
    } catch { /* ignore */ }
  }
}

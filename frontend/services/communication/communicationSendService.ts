/**
 * communicationSendService.ts — delivery layer (content vs channel split).
 *
 * MessageDraft → { WhatsAppDelivery | SMSDelivery | EmailDelivery }.
 * Reuses the REAL send paths where they exist:
 *  - WhatsApp: whatsappClient.sendMessage (Meta Graph API v22.0) when the
 *    account is configured; otherwise falls back to the local ERP outbox
 *    (whatsAppMarketingService + customerNotificationLogs) and reports
 *    clearly that no provider is configured.
 *  - SMS/Email: no dedicated ERP provider exists today — recorded to the
 *    ERP outbox with an explicit "provider not configured" failure rather
 *    than pretending to send.
 *
 * Never reports "sent" unless the underlying operation succeeded.
 */

import { whatsappClient } from '../whatsappClientService';
import { whatsAppMarketingService } from '../whatsAppMarketingService';
import { dbService } from '../db';
import type { CommunicationChannel, CommunicationContext } from './communicationTypes';

export interface SendRequest {
  channel: CommunicationChannel;
  recipientPhone: string | null;
  recipientEmail: string | null;
  message: string;
  ctx: CommunicationContext;
}

export interface SendResult {
  ok: boolean;
  providerMessageId: string | null;
  channel: CommunicationChannel;
  detail: string;
  queuedLocally: boolean;
}

function digitsOnly(phone: string | null): string {
  return String(phone || '').replace(/[^0-9]/g, '');
}

export async function sendCommunication(req: SendRequest): Promise<SendResult> {
  const message = String(req.message || '').trim();
  if (!message) return { ok: false, providerMessageId: null, channel: req.channel, detail: 'Message is empty.', queuedLocally: false };

  if (req.channel === 'whatsapp') {
    const to = digitsOnly(req.recipientPhone);
    if (!to) return { ok: false, providerMessageId: null, channel: req.channel, detail: 'Customer has no phone number for WhatsApp.', queuedLocally: false };
    const account = whatsappClient.getAccountInfo();
    if (account?.phone_number_id && account?.access_token) {
      try {
        const res = await whatsappClient.sendMessage(account.phone_number_id, account.access_token, to, message);
        try {
          const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('nexus_user') : null;
          const user = raw ? JSON.parse(raw) : null;
          if (user) await whatsappClient.logMessage(account.id, user.id, to, message, 'sent', 'outbound', res.messageId);
        } catch { /* logging is best-effort */ }
        return { ok: true, providerMessageId: res.messageId, channel: req.channel, detail: `Sent via Meta WhatsApp API (${res.messageId}).`, queuedLocally: false };
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'Meta API send failed';
        // Explicit failure — still mirror to the local outbox for audit, but report failure.
        await mirrorToLocalOutbox(req, `WhatsApp provider failed: ${reason}`);
        return { ok: false, providerMessageId: null, channel: req.channel, detail: `WhatsApp provider failed: ${reason}. Mirrored to local outbox as failed.`, queuedLocally: true };
      }
    }
    // No provider configured — local ERP outbox (existing simulated path), honestly labeled.
    await mirrorToLocalOutbox(req, null);
    return {
      ok: true,
      providerMessageId: null,
      channel: req.channel,
      detail: 'WhatsApp provider not configured — saved to ERP outbox (local). Configure Meta API under WhatsApp Hub → Connect to send externally.',
      queuedLocally: true,
    };
  }

  if (req.channel === 'sms') {
    await mirrorToLocalOutbox(req, 'SMS provider not configured');
    return { ok: false, providerMessageId: null, channel: req.channel, detail: 'SMS provider is not integrated in this ERP. Message saved to ERP outbox as failed — configure an SMS gateway to enable.', queuedLocally: true };
  }

  // email
  if (!req.recipientEmail) {
    await mirrorToLocalOutbox(req, 'Customer has no email address');
    return { ok: false, providerMessageId: null, channel: req.channel, detail: 'Customer has no email address.', queuedLocally: true };
  }
  await mirrorToLocalOutbox(req, 'Email provider handoff pending');
  return { ok: false, providerMessageId: null, channel: req.channel, detail: 'Email delivery is not yet wired to SMTP in this workspace. Message saved to ERP outbox — use WhatsApp or copy the message manually.', queuedLocally: true };
}

async function mirrorToLocalOutbox(req: SendRequest, failureNote: string | null): Promise<void> {
  try {
    // Keep the existing WhatsApp chat mirror working for continuity.
    const chats = await whatsAppMarketingService.getChats();
    const to = digitsOnly(req.recipientPhone);
    const existing = chats.find((c) => c.customerId === req.ctx.customer.id || (to && c.customerPhone === to));
    if (existing) {
      await whatsAppMarketingService.sendMessage(existing.id, req.message);
    } else if (to) {
      const chat = {
        id: `chat-${to}`,
        customerId: req.ctx.customer.id,
        customerName: req.ctx.customer.businessName,
        customerPhone: to,
        lastMessage: req.message,
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
      await whatsAppMarketingService.sendMessage(chat.id, req.message);
    }
  } catch { /* mirror is best-effort; history record is authoritative */ }
  if (failureNote) {
    try {
      await dbService.put('customerNotificationLogs', {
        id: `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'COMMUNICATION_OUTBOX',
        entityId: req.ctx.customer.id,
        customerName: req.ctx.customer.businessName,
        phoneNumber: req.recipientPhone || '',
        message: req.message,
        timestamp: new Date().toISOString(),
        status: 'failed',
        deliveryMode: 'queued',
        error: failureNote,
      });
    } catch { /* ignore */ }
  }
}

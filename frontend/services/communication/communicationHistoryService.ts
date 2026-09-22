/**
 * communicationHistoryService.ts — audit history for the Communication Center.
 *
 * Reuses the EXISTING `customerNotificationLogs` IndexedDB store (no new
 * migration, no destructive change). Records both AI draft and final sent
 * message plus the ERP facts snapshot so every send is auditable.
 * History is append-only: records are never rewritten.
 */

import { dbService } from '../db';
import type { CommunicationHistoryRecord, OutboundStatus } from './communicationTypes';

function currentOperator(): string | null {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('nexus_user') : null;
    if (raw) {
      const u = JSON.parse(raw);
      return String(u.name || u.username || u.email || u.id || '') || null;
    }
  } catch { /* ignore */ }
  return null;
}

export async function recordCommunication(entry: Omit<CommunicationHistoryRecord, 'id' | 'createdAt' | 'operator'> & { operator?: string | null }): Promise<CommunicationHistoryRecord> {
  const record: CommunicationHistoryRecord = {
    attachmentFilename: null,
    attachmentIncluded: false,
    providerMessageId: null,
    ...entry,
    id: `comm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    operator: entry.operator ?? currentOperator(),
    createdAt: new Date().toISOString(),
  };
  await dbService.put('customerNotificationLogs', {
    ...record,
    type: 'COMMUNICATION',
    entityId: record.invoiceId || record.customerId,
    customerName: record.businessName,
    phoneNumber: '',
    message: record.finalMessage,
    timestamp: record.createdAt,
    deliveryMode: 'external',
    error: record.failureReason || undefined,
  });
  return record;
}

export async function getCustomerHistory(customerId: string, limit = 50): Promise<CommunicationHistoryRecord[]> {
  try {
    const all = await dbService.getAll<Record<string, unknown>>('customerNotificationLogs');
    const mine = all.filter((l) => String((l as { customerId?: string }).customerId || '') === String(customerId));
    mine.sort((a, b) => new Date(String((b as { createdAt?: string }).createdAt || (b as { timestamp?: string }).timestamp || 0)).getTime()
      - new Date(String((a as { createdAt?: string }).createdAt || (a as { timestamp?: string }).timestamp || 0)).getTime());
    return mine.slice(0, limit).map((l) => normalizeRecord(l));
  } catch {
    return [];
  }
}

export async function getRecentHistory(limit = 100): Promise<CommunicationHistoryRecord[]> {
  try {
    const all = await dbService.getAll<Record<string, unknown>>('customerNotificationLogs');
    const comms = all.filter((l) => (l as { purpose?: string }).purpose || (l as { type?: string }).type === 'COMMUNICATION');
    comms.sort((a, b) => new Date(String((b as { createdAt?: string }).createdAt || (b as { timestamp?: string }).timestamp || 0)).getTime()
      - new Date(String((a as { createdAt?: string }).createdAt || (a as { timestamp?: string }).timestamp || 0)).getTime());
    return comms.slice(0, limit).map((l) => normalizeRecord(l));
  } catch {
    return [];
  }
}

/**
 * Warn (don't block) when the same invoice was communicated recently.
 * Any honestly-successful outbound state counts (legacy 'sent' plus the
 * hardened submitted/delivered/queued states) — per customer + invoice.
 */
const SUCCESSFUL_STATUSES: Array<CommunicationHistoryRecord['status']> = [
  'sent',
  'submitted',
  'delivered',
  'queued',
];

export async function findRecentInvoiceSend(customerId: string, invoiceId: string, withinHours = 72): Promise<CommunicationHistoryRecord | null> {
  const history = await getCustomerHistory(customerId, 50);
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  return history.find((h) => h.invoiceId === invoiceId && SUCCESSFUL_STATUSES.includes(h.status) && new Date(h.createdAt).getTime() >= cutoff) || null;
}

function normalizeRecord(l: Record<string, unknown>): CommunicationHistoryRecord {
  const r = l as unknown as CommunicationHistoryRecord & { timestamp?: string; message?: string; type?: string };
  return {
    id: String(r.id || `legacy-${Math.random().toString(36).slice(2)}`),
    customerId: String(r.customerId || ''),
    businessName: String(r.businessName || (l as { customerName?: string }).customerName || ''),
    purpose: (r.purpose || 'custom') as CommunicationHistoryRecord['purpose'],
    channel: (r.channel || 'whatsapp') as CommunicationHistoryRecord['channel'],
    tone: (r.tone || 'professional') as CommunicationHistoryRecord['tone'],
    aiDraft: String(r.aiDraft || ''),
    finalMessage: String(r.finalMessage || r.message || ''),
    invoiceId: (r.invoiceId as string | null) ?? null,
    invoiceNumber: (r.invoiceNumber as string | null) ?? null,
    verificationUrl: (r.verificationUrl as string | null) ?? null,
    hadAttachment: Boolean(r.hadAttachment),
    attachmentFilename: (r.attachmentFilename as string | null) ?? null,
    attachmentIncluded: Boolean(r.attachmentIncluded),
    status: (r.status as CommunicationHistoryRecord['status']) || 'sent',
    failureReason: (r.failureReason as string | null) ?? (l as { error?: string }).error ?? null,
    operator: (r.operator as string | null) ?? null,
    providerMessageId: (r.providerMessageId as string | null) ?? (l as { message_id?: string }).message_id ?? null,
    aiGenerated: Boolean(r.aiGenerated),
    snapshotId: String(r.snapshotId || ''),
    factsSnapshot: String(r.factsSnapshot || ''),
    createdAt: String(r.createdAt || r.timestamp || new Date().toISOString()),
  };
}

/**
 * communicationAIService.ts — AI LANGUAGE layer (wording/tone only).
 *
 * Reuses the EXISTING AI integration (frontend/services/aiService.ts
 * generateAIResponse). No new provider, no new keys, no duplicate service.
 * Falls back to deterministic ERP templates when AI is unavailable so the
 * operator can always continue with verified facts.
 */

import { aiService } from '../aiService';
import type {
  CommunicationContext,
  CommunicationLength,
  CommunicationTone,
} from './communicationTypes';
import { getPurpose } from './communicationTypes';
import { formatMoney } from './communicationContextBuilder';
import { injectFactsPostGeneration } from './communicationValidation';

/**
 * Purpose-gated facts block: the AI receives ONLY the ERP facts the selected
 * purpose is allowed (see allowedFacts). Invoice data can never leak into a
 * quotation/order/delivery/payment prompt — the builder already strips it,
 * and this gate holds even if a context is ever constructed another way.
 */
function factsBlock(ctx: CommunicationContext): string {
  const allowed = new Set(getPurpose(ctx.purpose).allowedFacts);
  const lines: string[] = [];
  lines.push(`Customer business name: ${ctx.customer.businessName}`);
  if (ctx.customer.contactName) lines.push(`Contact person: ${ctx.customer.contactName}`);
  if (ctx.customer.phone) lines.push(`Customer phone: ${ctx.customer.phone}`);
  lines.push(`Company: ${ctx.company.name}`);
  if (allowed.has('outstandingBalance') && ctx.outstandingBalance !== null) {
    lines.push(`Outstanding balance: ${formatMoney(ctx.outstandingBalance)}`);
  }
  const focal = ctx.specificInvoice || ctx.latestInvoice;
  const mayUseInvoice = allowed.has('latestInvoice') || allowed.has('specificInvoice');
  if (mayUseInvoice && focal) {
    lines.push(`Invoice number: ${focal.invoiceNumber}`);
    lines.push(`Invoice date: ${focal.date || 'unavailable'}`);
    lines.push(`Invoice total: ${formatMoney(focal.total)}`);
    lines.push(`Amount paid: ${formatMoney(focal.paid)}`);
    lines.push(`Invoice outstanding: ${formatMoney(focal.outstanding)}`);
    if (focal.dueDate) lines.push(`Due date: ${focal.dueDate}`);
    if (allowed.has('verificationUrl') && focal.verificationUrl) {
      lines.push(`Verification URL: ${focal.verificationUrl}`);
    }
  }
  if (allowed.has('invoices') && ctx.invoices.length > 1 && (ctx.purpose === 'payment_reminder' || ctx.purpose === 'outstanding_balance')) {
    lines.push(`Relevant invoices: ${ctx.invoices.slice(0, 5).map((i) => `${i.invoiceNumber} (${formatMoney(i.outstanding)})`).join('; ')}`);
  }
  if (ctx.company.paymentMethodsSummary) lines.push(`Payment methods: ${ctx.company.paymentMethodsSummary}`);
  if (allowed.has('lastPayment') && ctx.lastPayment) {
    const p = ctx.lastPayment;
    lines.push(`Payment receipt: ${p.receiptNumber} — ${formatMoney(p.amount)} on ${p.date || 'unavailable'}${p.method ? ` via ${p.method}` : ''}`);
    if (p.allocatedInvoiceNumbers.length > 0) {
      lines.push(`Allocated to invoices: ${p.allocatedInvoiceNumbers.join(', ')} (allocated total ${formatMoney(p.allocatedTotal)})`);
    }
    if (p.remainingBalance !== null) lines.push(`Remaining balance: ${formatMoney(p.remainingBalance)}`);
  }
  if (allowed.has('quotation') && ctx.quotation) {
    const q = ctx.quotation;
    lines.push(`Quotation: ${q.number} dated ${q.date || 'unavailable'} total ${formatMoney(q.total)} status ${q.status}${q.validUntil ? ` valid until ${q.validUntil}` : ''}`);
    if (q.items.length > 0) {
      lines.push(`Quoted lines: ${q.items.map((it) => `${it.name} × ${it.quantity} @ ${formatMoney(it.price)} = ${formatMoney(it.total)}`).join('; ')}`);
    }
  }
  if (allowed.has('order') && ctx.order) {
    lines.push(`Sales order: ${ctx.order.number} dated ${ctx.order.date || 'unavailable'} total ${formatMoney(ctx.order.total)} status ${ctx.order.status}`);
  }
  if (allowed.has('delivery') && ctx.delivery) {
    lines.push(`Delivery: ${ctx.delivery.id}${ctx.delivery.orderId ? ` for order ${ctx.delivery.orderId}` : ''} status ${ctx.delivery.status}${ctx.delivery.trackingNumber ? ` tracking ${ctx.delivery.trackingNumber}` : ''}`);
  }
  return lines.join('\n');
}

const ERP_GUARDRAIL = `You are writing customer communication for a production ERP (Prime ERP, print business).
STRICT RULES:
- Use ONLY the supplied verified ERP facts below. Never invent, calculate, alter, or override financial/business facts.
- Never invent invoice numbers, totals, balances, payments, due dates, discounts, penalties, account numbers, payment methods, delivery details, or verification URLs.
- If a fact is marked unavailable, say it is unavailable or omit it — never guess.
- Write polished, natural business communication. Avoid robotic wording.
- Return ONLY the message body (no JSON, no explanations, no placeholders like {{name}}).`;

function purposeInstruction(ctx: CommunicationContext, customNote?: string): string {
  switch (ctx.purpose) {
    case 'welcome':
      return 'Write a warm welcome message for the new customer. Introduce the company briefly.';
    case 'payment_reminder':
      return 'Write a courteous payment reminder stating the outstanding balance and asking the customer to settle at their earliest convenience using the listed payment methods.';
    case 'send_latest_invoice':
    case 'send_specific_invoice': {
      const focal = ctx.specificInvoice || ctx.latestInvoice;
      return `Write a professional message sending invoice ${focal?.invoiceNumber || ''} (total ${focal ? formatMoney(focal.total) : ''}). Mention the total, amount paid, and outstanding. Tell the customer the official invoice document is attached and the verification link below proves authenticity.`;
    }
    case 'payment_confirmation': {
      const p = ctx.lastPayment;
      return `Write a thank-you payment confirmation for receipt ${p?.receiptNumber || ''} (${p ? formatMoney(p.amount) : ''}). Name the allocated invoice(s) and the remaining balance exactly as listed — never substitute the latest invoice as the receipt.`;
    }
    case 'outstanding_balance':
      return 'Write a statement-style outstanding balance reminder listing the balance and relevant invoices.';
    case 'quotation_followup':
      return 'Write a follow-up on the open quotation, inviting questions and next steps.';
    case 'order_update':
      return 'Write an order status update with the order reference and next steps.';
    case 'delivery_notification':
      return 'Write a delivery notification with status and tracking where available.';
    case 'thank_you':
      return 'Write a sincere thank-you/appreciation message for the customer’s business.';
    case 'custom':
      return customNote ? `Write a professional customer message about: ${customNote}` : 'Write a professional customer message.';
    default:
      return 'Write a professional customer message.';
  }
}

const TONE_HINT: Record<CommunicationTone, string> = {
  professional: 'Tone: professional and courteous.',
  friendly: 'Tone: friendly and approachable, still businesslike.',
  formal: 'Tone: formal and respectful.',
  warm: 'Tone: warm and appreciative.',
  concise: 'Tone: concise and to the point. Keep it under 60 words.',
};

const LENGTH_HINT: Record<CommunicationLength, string> = {
  short: 'Length: short (2-3 sentences).',
  standard: 'Length: standard (1 short paragraph + 1 line with key facts).',
  detailed: 'Length: detailed (2 short paragraphs with all relevant facts).',
};

export interface DraftOptions {
  tone: CommunicationTone;
  length: CommunicationLength;
  customNote?: string;
}

export function buildDraftPrompt(ctx: CommunicationContext, opts: DraftOptions): { system: string; user: string } {
  const system = ERP_GUARDRAIL;
  const user = `VERIFIED ERP FACTS (authoritative — copy values exactly):\n${factsBlock(ctx)}\n\nTASK: ${purposeInstruction(ctx, opts.customNote)}\n${TONE_HINT[opts.tone]}\n${LENGTH_HINT[opts.length]}\nCustomer: ${ctx.customer.businessName}${ctx.customer.contactName ? ` (contact: ${ctx.customer.contactName})` : ''}`;
  return { system, user };
}

function deterministicFallback(ctx: CommunicationContext, opts: DraftOptions): string {
  const focal = ctx.specificInvoice || ctx.latestInvoice;
  const greeting = ctx.customer.contactName
    ? `Dear ${ctx.customer.contactName} (${ctx.customer.businessName})`
    : `Dear ${ctx.customer.businessName}`;
  const company = ctx.company.name;
  switch (ctx.purpose) {
    case 'welcome':
      return `${greeting}, welcome to ${company}! Thank you for choosing us — we look forward to serving your printing needs. Reply to this message if you need anything.`;
    case 'payment_reminder':
    case 'outstanding_balance':
      return `${greeting}, this is a friendly reminder from ${company} that your current outstanding balance is ${formatMoney(ctx.outstandingBalance)}.${ctx.company.paymentMethodsSummary ? ` You can pay via ${ctx.company.paymentMethodsSummary}.` : ''} Thank you for your prompt attention.`;
    case 'send_latest_invoice':
    case 'send_specific_invoice':
      return `${greeting}, please find ${focal ? `invoice ${focal.invoiceNumber} for ${formatMoney(focal?.total)} (paid ${formatMoney(focal?.paid)}, outstanding ${formatMoney(focal?.outstanding)})` : 'your invoice'} from ${company} attached.${focal?.verificationUrl ? ` Verify its authenticity here: ${focal.verificationUrl}` : ''}${ctx.company.paymentMethodsSummary ? ` Payment methods: ${ctx.company.paymentMethodsSummary}.` : ''}`;
    case 'payment_confirmation': {
      const p = ctx.lastPayment;
      const allocated = p && p.allocatedInvoiceNumbers.length > 0
        ? ` allocated to ${p.allocatedInvoiceNumbers.join(', ')}`
        : '';
      const remaining = p && p.remainingBalance !== null
        ? ` Your remaining balance is ${formatMoney(p.remainingBalance)}.`
        : '';
      return `${greeting}, thank you! We have received your payment of ${p ? formatMoney(p.amount) : '[AMOUNT]'}${p ? ` (receipt ${p.receiptNumber})` : ''}${allocated} at ${company}.${remaining} We appreciate your business.`;
    }
    case 'quotation_followup':
      return `${greeting}, following up on quotation ${ctx.quotation?.number || ''}${ctx.quotation ? ` for ${formatMoney(ctx.quotation.total)}` : ''} from ${company}. Let us know if you have questions or would like to proceed.`;
    case 'order_update':
      return `${greeting}, an update on your order ${ctx.order?.number || ctx.order?.id || ''} at ${company}: status ${ctx.order?.status || 'in progress'}. We will notify you of any further changes.`;
    case 'delivery_notification':
      return `${greeting}, your delivery ${ctx.delivery?.id || ctx.order?.number || ctx.order?.id || ''} from ${company} is ${ctx.delivery?.status || 'on its way'}${ctx.delivery?.trackingNumber ? ` (tracking ${ctx.delivery.trackingNumber})` : ''}. Thank you for your patience.`;
    case 'thank_you':
      return `${greeting}, thank you for your continued trust in ${company}. We truly appreciate your business and look forward to serving you again.`;
    case 'custom':
      return `${greeting}, ${opts.customNote || `thank you for choosing ${company}.`} Please let us know if you need anything further.`;
    default:
      return `${greeting}, thank you for choosing ${company}.`;
  }
}

export async function generateCommunicationDraft(
  ctx: CommunicationContext,
  opts: DraftOptions,
): Promise<{ text: string; aiGenerated: boolean; warning: string | null }> {
  const { system, user } = buildDraftPrompt(ctx, opts);
  try {
    const raw = await aiService.generateAIResponse(user, system);
    const cleaned = String(raw || '').trim();
    if (!cleaned) throw new Error('Empty AI response');
    // Post-inject authoritative values so numbers/URLs can never drift.
    const injected = injectFactsPostGeneration(cleaned, ctx);
    return { text: injected, aiGenerated: true, warning: null };
  } catch (err) {
    const fallback = injectFactsPostGeneration(deterministicFallback(ctx, opts), ctx);
    const message = err instanceof Error ? err.message : 'AI unavailable';
    const aiHint = /not configured|api key|connection|network|fetch|timeout/i.test(message)
      ? 'AI is not configured or unreachable — used verified ERP template instead. Configure AI under Marketing Messages → AI Settings for polished wording.'
      : `AI generation failed (${message}) — used verified ERP template instead.`;
    return { text: fallback, aiGenerated: false, warning: aiHint };
  }
}

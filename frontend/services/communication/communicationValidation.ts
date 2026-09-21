/**
 * communicationValidation.ts — FACTS vs AI CONTENT guardrail.
 *
 * ERP facts are authoritative. After AI generation (and after manual edits),
 * scan the draft for financial/entity values inconsistent with the context.
 * On mismatch: block sending, identify the mismatch, require regen/edit.
 *
 * Deterministic heuristics (no AI involved):
 *  - monetary amounts K1,234.00 / K125000 / ZMW
 *  - invoice numbers INV-xxx / ids present in context
 *  - verification URLs (must equal canonical URL when present)
 *  - customer business/contact names (must not swap to another customer)
 *  - payment method strings (must come from company paymentDetails)
 */

import type { CommunicationContext, FactValidationResult, FactValidationIssue } from './communicationTypes';
import { formatMoney } from './communicationContextBuilder';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAmountText(text: string): number[] {
  const found: number[] = [];
  const re = /(?:K|ZMW|Kwacha)\s?([\d,]+(?:\.\d{1,2})?)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n)) found.push(Math.round(n * 100) / 100);
  }
  return found;
}

function collectAuthoritativeAmounts(ctx: CommunicationContext): { label: string; value: number }[] {
  const out: { label: string; value: number }[] = [];
  if (ctx.outstandingBalance !== null) out.push({ label: 'outstanding balance', value: ctx.outstandingBalance });
  const focal = ctx.specificInvoice || ctx.latestInvoice;
  if (focal) {
    out.push({ label: `invoice ${focal.invoiceNumber} total`, value: focal.total });
    out.push({ label: `invoice ${focal.invoiceNumber} paid`, value: focal.paid });
    out.push({ label: `invoice ${focal.invoiceNumber} outstanding`, value: focal.outstanding });
  }
  if (ctx.lastPayment) out.push({ label: 'last payment', value: ctx.lastPayment.amount });
  if (ctx.quotation) out.push({ label: 'quotation total', value: ctx.quotation.total });
  if (ctx.order) out.push({ label: 'order total', value: ctx.order.total });
  return out;
}

function collectInvoiceNumbers(ctx: CommunicationContext): string[] {
  const nums = new Set<string>();
  for (const inv of ctx.invoices || []) if (inv.invoiceNumber) nums.add(inv.invoiceNumber);
  if (ctx.latestInvoice) nums.add(ctx.latestInvoice.invoiceNumber);
  if (ctx.specificInvoice) nums.add(ctx.specificInvoice.invoiceNumber);
  return [...nums].filter(Boolean);
}

export function validateDraftAgainstFacts(draft: string, ctx: CommunicationContext): FactValidationResult {
  const issues: FactValidationIssue[] = [];
  const text = String(draft || '');
  if (!text.trim()) {
    return { ok: false, issues: [{ code: 'amount_mismatch', message: 'Message is empty.', expected: 'non-empty message', foundInDraft: '' }] };
  }

  // 1. Monetary amounts: every K-amount in draft must match an authoritative amount (tolerance 0.01).
  const authoritative = collectAuthoritativeAmounts(ctx);
  const inDraft = normalizeAmountText(text);
  if (inDraft.length > 0 && authoritative.length === 0) {
    issues.push({
      code: 'amount_mismatch',
      message: `Draft contains monetary value(s) ${inDraft.map(formatMoney).join(', ')} but the ERP context provides no authoritative amounts for purpose "${ctx.purpose}". Remove invented amounts.`,
      expected: 'no monetary values without ERP facts',
      foundInDraft: inDraft.map(formatMoney).join(', '),
    });
  } else {
    for (const amt of inDraft) {
      const match = authoritative.some((a) => Math.abs(a.value - amt) < 0.015);
      if (!match) {
        issues.push({
          code: 'amount_mismatch',
          message: `Draft amount ${formatMoney(amt)} does not match any ERP fact (${authoritative.map((a) => `${a.label} = ${formatMoney(a.value)}`).join('; ') || 'no facts'}).`,
          expected: authoritative.map((a) => `${a.label} = ${formatMoney(a.value)}`).join('; ') || 'no amounts',
          foundInDraft: formatMoney(amt),
        });
      }
    }
  }

  // 2. Invoice numbers: INV-like tokens in draft must exist in context.
  const knownInvoices = collectInvoiceNumbers(ctx);
  const invRe = /\b((?:INV|QTN|SO|ORD|PAY|RCP|DN|PO)-[A-Za-z0-9\-/]+)\b/g;
  const draftInvoices = new Set<string>();
  let im: RegExpExecArray | null;
  while ((im = invRe.exec(text)) !== null) draftInvoices.add(im[1]);
  for (const num of draftInvoices) {
    const known = knownInvoices.some((k) => k.toLowerCase() === num.toLowerCase());
    if (!known) {
      issues.push({
        code: 'invoice_mismatch',
        message: `Draft references ${num} which is not in the ERP context (${knownInvoices.join(', ') || 'no invoices'}).`,
        expected: knownInvoices.join(', ') || 'no invoice numbers',
        foundInDraft: num,
      });
    }
  }

  // 3. Verification URL: if draft contains a URL, it must equal the canonical one.
  const focal = ctx.specificInvoice || ctx.latestInvoice;
  const urlRe = /https?:\/\/[^\s)]+/g;
  const draftUrls = text.match(urlRe) || [];
  if (draftUrls.length > 0 && focal) {
    if (focal.verificationUrl) {
      const hasCanonical = draftUrls.some((u) => u === focal.verificationUrl || text.includes(focal.verificationUrl!));
      const hasAnyVerify = draftUrls.some((u) => /verify/i.test(u));
      if (hasAnyVerify && !hasCanonical) {
        issues.push({
          code: 'url_mismatch',
          message: `Draft contains a verification-like URL that does not match the canonical ERP verification URL. Use exactly: ${focal.verificationUrl}`,
          expected: focal.verificationUrl,
          foundInDraft: draftUrls.filter((u) => /verify/i.test(u)).join(', '),
        });
      }
    } else if (draftUrls.some((u) => /verify/i.test(u))) {
      issues.push({
        code: 'url_mismatch',
        message: 'Draft contains a verification-like URL but the ERP has no verification URL for this invoice. Remove the invented link.',
        expected: 'no verification URL',
        foundInDraft: draftUrls.filter((u) => /verify/i.test(u)).join(', '),
      });
    }
  }

  // 4. Customer identity: draft must reference the business name (or contact) — warn on mismatch is soft,
  //    but block if it names a DIFFERENT known pattern like "Dear <SomeoneElse>" with a capitalized name
  //    that equals neither business nor contact name. Keep pragmatic: only check greeting line.
  const greeting = text.split('\n')[0] || text.slice(0, 120);
  if (ctx.customer.businessName && greeting.length > 0) {
    // No hard block here — personalization varies. Only block obvious placeholder leaks.
    if (/\{\{\s*(name|company|amount|invoice|link)[^}]*\}\}/i.test(text)) {
      issues.push({
        code: 'customer_mismatch',
        message: 'Draft contains unresolved placeholders like {{name}}. Resolve ERP facts before sending.',
        expected: ctx.customer.businessName,
        foundInDraft: 'unresolved {{...}} placeholder',
      });
    }
  } else if (/\{\{[^}]+\}\}/.test(text)) {
    issues.push({
      code: 'customer_mismatch',
      message: 'Draft contains unresolved placeholders. Resolve ERP facts before sending.',
      expected: 'resolved text',
      foundInDraft: 'unresolved {{...}} placeholder',
    });
  }

  // 5. Payment methods: if draft names a bank/mobile-money account number, it must come from company facts.
  const acctRe = /(?:account(?:\s+number|\s+no)?|Airtel|MTN|Zamtel|Stanbic|FNB|Absa|Zanaco)[^\n]{0,60}([\d\- ]{6,})/gi;
  const knownAccounts: string[] = [
    ...ctx.company.bankAccounts.map((b) => b.accountNumber).filter(Boolean),
    ...ctx.company.mobileMoneyAccounts.map((m) => m.phoneNumber).filter(Boolean),
  ].map((s) => s.replace(/[\s-]/g, ''));
  let am: RegExpExecArray | null;
  while ((am = acctRe.exec(text)) !== null) {
    const digits = String(am[1] || '').replace(/[\s-]/g, '');
    if (digits.length >= 6 && knownAccounts.length > 0 && !knownAccounts.some((k) => k.replace(/[\s-]/g, '') === digits || (digits && k.includes(digits)) || (digits && digits.includes(k)))) {
      issues.push({
        code: 'payment_mismatch',
        message: `Draft mentions account/phone "${String(am[1]).trim()}" which is not in the ERP payment configuration. Use only configured payment details.`,
        expected: knownAccounts.join(', ') || 'configured payment details',
        foundInDraft: String(am[1]).trim(),
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Inject authoritative values AFTER AI generation so numbers/URLs can never
 * drift: replaces [OUTSTANDING], [INVOICE_NUMBER], [VERIFICATION_URL],
 * [BUSINESS_NAME], [CONTACT_NAME], [COMPANY_NAME], [PAYMENT_METHODS],
 * [INVOICE_TOTAL], [AMOUNT_PAID], [DUE_DATE] tokens when present, and
 * appends the verification URL for invoice purposes if the AI omitted it.
 */
export function injectFactsPostGeneration(template: string, ctx: CommunicationContext): string {
  let out = String(template || '');
  const focal = ctx.specificInvoice || ctx.latestInvoice;
  const replacements: Record<string, string> = {
    BUSINESS_NAME: ctx.customer.businessName,
    CONTACT_NAME: ctx.customer.contactName || ctx.customer.businessName,
    COMPANY_NAME: ctx.company.name,
    OUTSTANDING: ctx.outstandingBalance !== null ? formatMoney(ctx.outstandingBalance) : 'unavailable',
    INVOICE_NUMBER: focal ? focal.invoiceNumber : '',
    INVOICE_TOTAL: focal ? formatMoney(focal.total) : '',
    AMOUNT_PAID: focal ? formatMoney(focal.paid) : '',
    INVOICE_OUTSTANDING: focal ? formatMoney(focal.outstanding) : '',
    DUE_DATE: focal?.dueDate ? new Date(focal.dueDate).toLocaleDateString() : '',
    INVOICE_DATE: focal?.date ? new Date(focal.date).toLocaleDateString() : '',
    VERIFICATION_URL: focal?.verificationUrl || '',
    PAYMENT_METHODS: ctx.company.paymentMethodsSummary || '',
  };
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`[${key}]`).join(value);
    out = out.split(`{{${key.toLowerCase()}}}`).join(value);
  }
  // Legacy template placeholders from the old module → ERP facts.
  out = out.split('{{name}}').join(ctx.customer.contactName || ctx.customer.businessName);
  out = out.split('{{company}}').join(ctx.company.name);
  if (focal) {
    out = out.split('{{invoice}}').join(focal.invoiceNumber);
    out = out.split('{{amount}}').join(formatMoney(focal.total));
    out = out.split('{{orderId}}').join(focal.invoiceNumber);
  } else if (ctx.outstandingBalance !== null) {
    out = out.split('{{amount}}').join(formatMoney(ctx.outstandingBalance));
  }
  // Ensure verification link is present for invoice sends (channels with links).
  if ((ctx.purpose === 'send_latest_invoice' || ctx.purpose === 'send_specific_invoice') && focal?.verificationUrl) {
    if (!out.includes(focal.verificationUrl)) {
      out = `${out.trim()}\n\nVerify this invoice here: ${focal.verificationUrl}`;
    }
  }
  return out.trim();
}

export function describeIssues(result: { ok: boolean; issues: FactValidationIssue[] }): string {
  if (result.ok) return 'All ERP facts validated.';
  return result.issues.map((i) => `• ${i.message}`).join('\n');
}

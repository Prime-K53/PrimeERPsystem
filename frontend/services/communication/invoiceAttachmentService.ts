/**
 * invoiceAttachmentService.ts — ATOMIC invoice communication context.
 *
 * One authoritative context: message generator, preview, validator and sender
 * all derive from the SAME focal invoice record via getFocalInvoice() — no
 * part may independently re-query "latest invoice" and risk selecting a
 * different record (never Invoice-A message + Invoice-B attachment +
 * Invoice-C verification URL).
 *
 * The actual PDF bytes are rendered server-side by the canonical
 * officialDocumentService at send time; this module builds and verifies the
 * attachment DESCRIPTOR that binds the outbound payload to one invoice.
 */

import type {
  CommunicationContext,
  InvoiceAttachmentDescriptor,
  InvoiceFacts,
} from './communicationTypes';

/** Single accessor — every stage uses this, never its own query. */
export function getFocalInvoice(ctx: CommunicationContext): InvoiceFacts | null {
  return ctx.specificInvoice || ctx.latestInvoice || null;
}

export function isInvoicePurpose(purpose: CommunicationContext['purpose']): boolean {
  return purpose === 'send_latest_invoice' || purpose === 'send_specific_invoice';
}

/**
 * Build the attachment descriptor from the SAME focal invoice in ctx.
 * Returns null when the purpose needs no attachment.
 */
export function resolveInvoiceAttachmentDescriptor(
  ctx: CommunicationContext,
): InvoiceAttachmentDescriptor | null {
  if (!isInvoicePurpose(ctx.purpose)) return null;
  // Strict atomicity: a specific-invoice purpose must name its invoice —
  // never silently fall back to "latest" for the attachment.
  if (ctx.purpose === 'send_specific_invoice' && !ctx.specificInvoice) return null;
  const focal = getFocalInvoice(ctx);
  if (!focal) return null;
  return {
    invoiceId: focal.id,
    invoiceNumber: focal.invoiceNumber,
    customerId: ctx.customer.id,
    filename: `${focal.invoiceNumber}.pdf`,
    mimeType: 'application/pdf',
    // Bytes are rendered server-side at send; size confirmed from the send result.
    sizeBytes: null,
    source: 'erp-official-document',
    verificationUrl: focal.verificationUrl,
  };
}

export interface AttachmentIntegrityResult {
  ok: boolean;
  issues: string[];
}

/**
 * Verify BEFORE sending:
 *  - descriptor invoice/number/customer match the focal context record
 *  - descriptor verification URL is the focal record's canonical URL
 *  - MIME is the official PDF type
 *  - for email sends with a rendered result: payload non-empty + filename match
 */
export function verifyAttachmentIntegrity(
  descriptor: InvoiceAttachmentDescriptor | null,
  ctx: CommunicationContext,
  rendered?: { filename: string; sizeBytes: number; invoiceNumber: string } | null,
): AttachmentIntegrityResult {
  const issues: string[] = [];
  if (!isInvoicePurpose(ctx.purpose)) return { ok: true, issues };
  const focal = getFocalInvoice(ctx);
  if (!focal) {
    issues.push('Attachment required but no invoice is in context — send is blocked until an invoice is resolved.');
    return { ok: false, issues };
  }
  if (!descriptor) {
    issues.push(`Invoice ${focal.invoiceNumber} has no attachment descriptor — the document would be missing from the payload. Send blocked.`);
    return { ok: false, issues };
  }
  if (descriptor.invoiceId !== focal.id) {
    issues.push(`Attachment invoice ${descriptor.invoiceId} does not match message invoice ${focal.id} — blocked.`);
  }
  if (descriptor.invoiceNumber !== focal.invoiceNumber) {
    issues.push(`Attachment number ${descriptor.invoiceNumber} does not match message number ${focal.invoiceNumber} — blocked.`);
  }
  if (descriptor.customerId !== ctx.customer.id) {
    issues.push('Attachment customer does not match message customer — blocked.');
  }
  if (descriptor.mimeType !== 'application/pdf') {
    issues.push(`Unexpected attachment type ${descriptor.mimeType} — expected application/pdf. Blocked.`);
  }
  if ((descriptor.verificationUrl || null) !== (focal.verificationUrl || null)) {
    issues.push('Attachment verification URL does not match the message invoice verification URL — blocked.');
  }
  if (rendered) {
    if (rendered.invoiceNumber !== focal.invoiceNumber) {
      issues.push(`Rendered document ${rendered.invoiceNumber} does not match message invoice ${focal.invoiceNumber} — blocked.`);
    }
    if (!rendered.sizeBytes || rendered.sizeBytes <= 0) {
      issues.push('Rendered invoice document is empty — attachment missing from payload. Blocked.');
    }
    if (rendered.filename !== descriptor.filename) {
      issues.push(`Rendered filename ${rendered.filename} does not match expected ${descriptor.filename} — blocked.`);
    }
  }
  return { ok: issues.length === 0, issues };
}

/**
 * Invoice verification — compatibility facade over the generic document
 * verification foundation (`documentVerification.ts`).
 *
 * The invoice was the first verifiable document type; every export here
 * delegates so existing invoice imports, URLs, QR bytes and behavior stay
 * byte-identical while there is only ONE token/URL implementation.
 */
import {
  VERIFICATION_TOKEN_BYTES,
  VERIFICATION_TOKEN_HEX_LENGTH,
  buildDocumentVerificationUrl,
  ensureDocumentVerificationToken,
  generateVerificationToken,
  resolveVerificationBaseUrl,
} from './documentVerification';

export {
  VERIFICATION_TOKEN_BYTES,
  VERIFICATION_TOKEN_HEX_LENGTH,
  generateVerificationToken,
  resolveVerificationBaseUrl,
  ensureDocumentVerificationToken as ensureInvoiceVerificationToken,
};

export interface VerifiableInvoiceRef {
  invoiceNumber?: unknown;
  number?: unknown;
  verificationToken?: unknown;
}

/** Invoice verification URL — delegates to the generic builder (type invoice). */
export function buildInvoiceVerificationUrl(
  doc: VerifiableInvoiceRef | null | undefined,
  baseUrl?: string
): string | null {
  if (!doc) return null;
  return buildDocumentVerificationUrl(
    {
      documentType: 'invoice',
      documentNumber: (doc as any).documentNumber,
      invoiceNumber: doc.invoiceNumber,
      number: doc.number,
      verificationToken: doc.verificationToken,
    },
    baseUrl
  );
}

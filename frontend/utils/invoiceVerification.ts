/**
 * Invoice QR verification — token + URL utilities (pure, offline-safe).
 *
 * Single home for verification-URL logic (§15): the PDF/print/email/portal
 * flows all reach it through `attachDocumentSecurity`, so one invoice has
 * one QR everywhere. No network access here — generation works fully
 * offline; only the customer's later scan needs connectivity.
 *
 * URL shape (HashRouter SPA):
 *   {base}/#/verify/invoice/{invoiceNumber}?t={token}
 *
 * Base URL resolution (never hard-codes localhost):
 *   1. VITE_PUBLIC_PORTAL_URL (e.g. https://portal.primeerp.com)
 *   2. window.location.origin (correct automatically when the ERP itself is
 *      served from the public domain; localhost only in local development)
 */

export const VERIFICATION_TOKEN_BYTES = 32;
export const VERIFICATION_TOKEN_HEX_LENGTH = VERIFICATION_TOKEN_BYTES * 2;

/** Cryptographically secure random token (hex). Throws without WebCrypto. */
export function generateVerificationToken(randomSource?: (bytes: Uint8Array) => void): string {
  const fill = randomSource
    ?? ((bytes: Uint8Array) => {
      const g = (globalThis as any)?.crypto;
      if (!g?.getRandomValues) {
        throw new Error('Secure random source unavailable — cannot issue invoice verification token.');
      }
      g.getRandomValues(bytes);
    });
  const bytes = new Uint8Array(VERIFICATION_TOKEN_BYTES);
  fill(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Public web origin used inside customer-facing QR codes. */
export function resolveVerificationBaseUrl(): string {
  try {
    const fromEnv = String((import.meta as any)?.env?.VITE_PUBLIC_PORTAL_URL || '').trim();
    if (fromEnv) return fromEnv.replace(/\/+$/, '');
  } catch { /* import.meta unavailable */ }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return String(window.location.origin).replace(/\/+$/, '');
  }
  return '';
}

export interface VerifiableInvoiceRef {
  invoiceNumber?: unknown;
  number?: unknown;
  verificationToken?: unknown;
}

/**
 * Deterministic verification URL for an invoice, or null when it cannot be
 * verified yet (missing number or token). Contains NOTHING sensitive — only
 * the public invoice number and the random token.
 */
export function buildInvoiceVerificationUrl(
  doc: VerifiableInvoiceRef | null | undefined,
  baseUrl?: string
): string | null {
  const number = String(doc?.invoiceNumber ?? doc?.number ?? '').trim();
  const token = String(doc?.verificationToken ?? '').trim();
  if (!number || !token) return null;
  const base = String(baseUrl ?? resolveVerificationBaseUrl()).replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/#/verify/invoice/${encodeURIComponent(number)}?t=${encodeURIComponent(token)}`;
}

/** Idempotent attach: keeps an existing token, issues one only when missing. */
export function ensureInvoiceVerificationToken<T extends { verificationToken?: string }>(invoice: T): T {
  if (!invoice || invoice.verificationToken) return invoice;
  return { ...invoice, verificationToken: generateVerificationToken() };
}

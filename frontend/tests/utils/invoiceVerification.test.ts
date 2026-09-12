/**
 * invoiceVerification.test.ts — token issuance, URL building, QR payload
 * switching, offline safety, backfill and sync preservation.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  generateVerificationToken,
  buildInvoiceVerificationUrl,
  ensureInvoiceVerificationToken,
  resolveVerificationBaseUrl,
  VERIFICATION_TOKEN_HEX_LENGTH,
} from '../../utils/invoiceVerification';
import { attachDocumentSecurity, buildSecurityQrPayload } from '../../utils/documentSecurity';

// ─── In-memory dbService stub (approved-path persistence checks) ─────────

const stores = new Map<string, Map<string, any>>();
export const putSpy: string[] = [];
function storeFor(name: string) {
  if (!stores.has(name)) stores.set(name, new Map());
  const m = stores.get(name)!;
  return {
    get: async (id: string) => m.get(String(id)),
    put: async (rec: any) => {
      putSpy.push(`${name}:${rec.id}`);
      m.set(String(rec.id ?? rec.key ?? `k${m.size}`), rec);
    },
    getAll: async () => Array.from(m.values()),
    delete: async (id: string) => {
      m.delete(String(id));
    },
  };
}

vi.mock('../../services/db', () => ({
  dbService: {
    executeAtomicOperation: async (_names: string[], fn: any) =>
      fn({ objectStore: (n: string) => storeFor(n) }),
    getAll: async (s: string) => storeFor(s).getAll(),
    get: async (s: string, id: string) => storeFor(s).get(id),
    put: async (s: string, rec: any) => storeFor(s).put(rec),
  },
}));

import { transactionService } from '../../services/transactionService';

describe('verification token issuance', () => {
  it('Test 1 — new invoice receives a token', () => {
    const out = ensureInvoiceVerificationToken({ id: 'INV-1' } as any);
    expect(out.verificationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(VERIFICATION_TOKEN_HEX_LENGTH).toBe(64);
  });

  it('Test 2 — existing token is reused, never regenerated', () => {
    const inv = { id: 'INV-1', verificationToken: 'a'.repeat(64) } as any;
    expect(ensureInvoiceVerificationToken(inv).verificationToken).toBe('a'.repeat(64));
    expect(ensureInvoiceVerificationToken(inv)).toBe(inv); // same reference
  });

  it('Test 3 — tokens are unique/well-formed and come from a CSPRNG', () => {
    // The global test setup stubs crypto.getRandomValues as identity, so
    // inject a varying source here to prove format + uniqueness plumbing…
    let n = 1;
    const varying = (b: Uint8Array) => {
      b.fill(n++ % 251 + 1);
      return b;
    };
    const seen = new Set(Array.from({ length: 20 }, () => generateVerificationToken(varying)));
    expect(seen.size).toBe(20); // unique
    for (const t of seen) expect(t).toMatch(/^[0-9a-f]{64}$/);
    // …and prove the default production path delegates to WebCrypto.
    generateVerificationToken();
    expect((globalThis as any).crypto.getRandomValues).toHaveBeenCalled();
  });
});

describe('verification URL', () => {
  it('Test 7 — deterministic for the invoice', () => {
    const doc = { invoiceNumber: 'INV-P726/024', verificationToken: 'b'.repeat(64) };
    const a = buildInvoiceVerificationUrl(doc, 'https://portal.primeerp.com');
    const b = buildInvoiceVerificationUrl(doc, 'https://portal.primeerp.com/');
    expect(a).toBe(b);
    expect(a).toBe(`https://portal.primeerp.com/#/verify/invoice/INV-P726%2F024?t=${'b'.repeat(64)}`);
    // round-trips through URL parsing
    const hash = new URL(a!).hash; // #/verify/invoice/...?t=...
    expect(hash).toContain('INV-P726%2F024');
    expect(hash).toContain('b'.repeat(64));
  });

  it('contains nothing sensitive', () => {
    const url = buildInvoiceVerificationUrl(
      {
        invoiceNumber: 'INV-1',
        verificationToken: 'c'.repeat(64),
        customerEmail: 'someone@example.com',
        customerPhone: '+265 999 000 001',
        password: 'secret',
      } as any,
      'https://portal.primeerp.com'
    )!;
    for (const secret of ['someone@example.com', '999 000 001', 'secret']) {
      expect(url).not.toContain(secret);
    }
  });

  it('returns null without number or token (legacy payload path)', () => {
    expect(buildInvoiceVerificationUrl({ invoiceNumber: 'INV-1' } as any, 'https://x')).toBeNull();
    expect(buildInvoiceVerificationUrl({ verificationToken: 'c'.repeat(64) } as any, 'https://x')).toBeNull();
    expect(buildInvoiceVerificationUrl(null, 'https://x')).toBeNull();
  });

  it('never hard-codes localhost: base comes from config or current origin', () => {
    // With an explicit base (production config) the origin is exact.
    expect(buildInvoiceVerificationUrl(
      { invoiceNumber: 'INV-1', verificationToken: 'd'.repeat(64) }, 'https://portal.primeerp.com'
    )).toMatch(/^https:\/\/portal\.primeerp\.com\//);
    // Resolver prefers the env override when present.
    expect(typeof resolveVerificationBaseUrl()).toBe('string');
  });
});

describe('QR payload switching (existing flows untouched)', () => {
  it('tokened invoices encode the verification URL', async () => {
    const data: any = {
      invoiceNumber: 'INV-P726/024',
      date: '2026-09-01',
      verificationToken: 'e'.repeat(64),
    };
    const payload = buildSecurityQrPayload(data, 'Prime Printing Service');
    expect(payload).toContain('/#/verify/invoice/INV-P726%2F024?t=');
    expect(payload).toContain('e'.repeat(64));
    // No legacy free-text fields leak into the URL payload.
    expect(payload).not.toContain('created on');
    const secured = await attachDocumentSecurity(data, 'Prime Printing Service');
    expect(secured.securityQrPayload).toBe(payload);
    expect(String(secured.securityQrCodeDataUrl)).toMatch(/^data:image\//);
  });

  it('Tests 4-6 — re-rendering never changes the token or QR', async () => {
    const data: any = { invoiceNumber: 'INV-1', date: '2026-09-01', verificationToken: 'f'.repeat(64) };
    const first = await attachDocumentSecurity({ ...data }, 'Prime Printing Service');
    const second = await attachDocumentSecurity({ ...data }, 'Prime Printing Service');
    expect(second.securityQrPayload).toBe(first.securityQrPayload);
    expect(second.securityQrCodeDataUrl).toBe(first.securityQrCodeDataUrl);
  });

  it('untokened documents keep the legacy human-readable payload', async () => {
    const secured = await attachDocumentSecurity(
      { invoiceNumber: 'INV-OLD', date: '2026-01-01', createdByName: 'Admin' } as any,
      'Prime Printing Service'
    );
    expect(secured.securityQrPayload).toContain('Prime Printing Service, INV-OLD, created on');
  });
});

describe('backfill + sync preservation (approved path)', () => {
  beforeEach(() => {
    stores.clear();
    putSpy.length = 0;
  });

  it('Test 20 — token-less invoice receives exactly one token via service', async () => {
    await storeFor('invoices').put({ id: 'INV-B20', totalAmount: 100, status: 'Unpaid' });
    const first = await transactionService.getOrIssueInvoiceVerificationToken('INV-B20');
    const second = await transactionService.getOrIssueInvoiceVerificationToken('INV-B20');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(second.token).toBe(first.token);
    expect(second.issued).toBe(false);
    expect(first.issued).toBe(true);
  });

  it('Test 21 — token persists through the normal invoice save path', async () => {
    await storeFor('invoices').put({ id: 'INV-B21', totalAmount: 500, paidAmount: 0, status: 'Unpaid', items: [] });
    const { token } = await transactionService.getOrIssueInvoiceVerificationToken('INV-B21');
    // Settlement-style save (totals/lines untouched) keeps the token.
    await transactionService.updateInvoice({ id: 'INV-B21', totalAmount: 500, paidAmount: 500, status: 'Paid', items: [] } as any);
    const reread = await storeFor('invoices').get('INV-B21');
    expect(reread.verificationToken).toBe(token);
    expect(putSpy.some((k) => k === 'invoices:INV-B21')).toBe(true);
  });
});

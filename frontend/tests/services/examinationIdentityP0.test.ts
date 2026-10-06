/**
 * examinationIdentityP0.test.ts — P0 regression: a NEW examination invoice
 * identity can never be finalized from a device-local scan.
 *
 * Incident: batches BTC-P726/023 (K550,000) and BTC-P726/021 (K200,250) —
 * different batches, different schools — BOTH became EXM-P726/022 and both
 * posted AR onto that single `referenceId`, so the 200,250 invoice reported
 * "net posted AR 750,250 — reduction of 550,000 pending".
 *
 * Cause: the EXM namespace was minted device-locally from
 * `dbService.getAll('invoices')`. Because an Examination Invoice's `id` IS its
 * ledger `referenceId`, that identity can never be minted locally and renamed
 * afterwards — the AR row already references it by then.
 *
 * Invariant under test:
 *   different batch -> different invoice identity -> different ledger
 *   referenceId -> independent AR posting
 *   same batch + EDIT -> same identity -> ledger correction (unchanged)
 *
 * The backend minter is covered by backend/tests/examinationInvoiceNumbering.test.cjs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../config/api.js', () => ({ API_BASE_URL: '/api' }));
vi.mock('../../services/requestHeaders', () => ({ getJsonRequestHeaders: () => ({ 'Content-Type': 'application/json' }) }));
vi.mock('../../services/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../../services/authSession', () => ({ isSessionExpired: () => false, getStoredUserSession: () => null }));

const loadClient = async () => await import('../../services/examinationInvoiceNumbering');
const okResponse = (body: unknown) => ({
  status: 200,
  ok: true,
  json: async () => body,
  headers: new Headers(),
});

describe('P0 — claim client accepts only an authoritative EXM identity', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns the server-issued identity and asks the gateway for it', async () => {
    const fetchMock = vi.fn(async () => okResponse({ ok: true, invoiceNumber: 'EXM-P726/023', series: 'P726' }));
    vi.stubGlobal('fetch', fetchMock);
    const { claimExaminationInvoiceIdentity } = await loadClient();
    const out = await claimExaminationInvoiceIdentity();
    expect(out.invoiceNumber).toBe('EXM-P726/023');
    expect(out.series).toBe('P726');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sync/numbers/examination-invoice');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('refuses a non-EXM identity returned by the server', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ ok: true, invoiceNumber: 'INV-P726/023' })));
    const { claimExaminationInvoiceIdentity, ExaminationIdentityClaimError } = await loadClient();
    // A sales identity must never become an examination accounting identity.
    await expect(claimExaminationInvoiceIdentity()).rejects.toBeInstanceOf(ExaminationIdentityClaimError);
  });
});

describe('P0 — claim client FAILS CLOSED (never falls back to a local mint)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws on transport failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const { claimExaminationInvoiceIdentity, ExaminationIdentityClaimError } = await loadClient();
    await expect(claimExaminationInvoiceIdentity()).rejects.toBeInstanceOf(ExaminationIdentityClaimError);
  });

  it('throws on 401 / 403 / 503 — never fabricates', async () => {
    const { claimExaminationInvoiceIdentity, ExaminationIdentityClaimError } = await loadClient();
    for (const status of [401, 403, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        status,
        ok: false,
        json: async () => ({ error: 'nope', reason: 'SEQUENCE_UNAVAILABLE' }),
        headers: new Headers(),
      })));
      await expect(claimExaminationInvoiceIdentity()).rejects.toBeInstanceOf(ExaminationIdentityClaimError);
    }
  });

  it('refuses offline without even attempting a claim', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { claimExaminationInvoiceIdentity, ExaminationIdentityClaimError } = await loadClient();
    await expect(claimExaminationInvoiceIdentity()).rejects.toBeInstanceOf(ExaminationIdentityClaimError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('P0 — no examination producer fabricates a local EXM identity', () => {
  it('examinationBatchService no longer contains an EXM fabrication fallback', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../services/examinationBatchService.ts'),
      'utf8'
    );
    // The identity is the ledger referenceId, so a timestamp/random local EXM
    // string is exactly the defect. (Other `EXM-${…}` uses — item ids, SKUs —
    // are not identities and stay untouched.)
    expect(source).not.toMatch(/EXM-\$\{Date\.now\(\)/);
    expect(source).not.toMatch(/invoiceNumber\s*=\s*payload\?\.invoiceNumber\s*\|\|/);
    // ...and the producer must fail closed when no claimed identity is supplied.
    expect(source).toMatch(/authoritative invoice identity/i);
  });
});

describe('P0 — the identity source is no longer a device-local scan', () => {
  it('ExaminationContext claims from the server and never scans the invoices store for an identity', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../../context/ExaminationContext.tsx'),
      'utf8'
    );
    // The claim module is imported and used...
    expect(source).toContain("from '../services/examinationInvoiceNumbering'");
    expect(source).toMatch(/\bclaimExaminationInvoiceIdentity\s*\(/);
    // ...and the local minter is neither imported nor called. (A prose mention
    // inside an explanatory comment is fine; a call is not.)
    expect(source).not.toMatch(/import\s*\{[^}]*generateNextExaminationInvoiceNumber/);
    expect(source).not.toMatch(/\bgenerateNextExaminationInvoiceNumber\s*\(/);
    // No local `invoices` scan may finalize an identity any more.
    expect(source).not.toMatch(/dbService\.getAll<[^>]*>\('invoices'\)/);
  });
});
/**
 * examinationPostingCapability.test.ts
 *
 * The authoritative posting boundary is a SERVER capability. These tests pin
 * the probe semantics that decide whether the browser uses the server path or
 * the legacy local path:
 *
 *   enabled                -> authoritative
 *   disabled / 404 / 405   -> legacy (server says off, or older build)
 *   network error / 5xx    -> authoritative (fail closed; a blocked probe must
 *                             not re-open the independent client-side path)
 *   malformed 200          -> legacy (nothing asserted enablement)
 *
 * Probing happens once per session and is cleared by the reset helper.
 */
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    put: vi.fn(),
  },
}));
vi.mock('../../config/api.js', () => ({ API_BASE_URL: 'http://localhost:5000/api' }));
vi.mock('../../services/requestHeaders', () => ({
  getJsonRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
}));
vi.mock('../../services/syncApiClient', () => ({ getSyncAccessToken: vi.fn(async () => 'token') }));
vi.mock('../../services/authSession', () => ({
  isSessionExpired: () => false,
  getStoredUserSession: () => null,
}));
vi.mock('../../utils/examinationInvoiceDiag', () => ({
  traceExamInvoice: vi.fn(async () => undefined),
}));
vi.mock('../../services/transactions/_internal', () => ({
  getGLConfig: () => ({ accountsReceivable: '11310', defaultSalesAccount: '41200' }),
  getCompanyConfig: () => ({ companyId: 'CO-1' }),
  loadAccountsFromStore: async () => [],
  resolveAccountForPosting: (ref: string) => ref,
}));
vi.mock('../../utils/revenueRecognition', () => ({
  resolveInvoiceRevenueAccount: () => '41200',
}));

type ProbeResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

const jsonResponse = (status: number, body: unknown): ProbeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

let fetchMock: ReturnType<typeof vi.fn>;

const loadModule = async () => import('../../services/examinationPostingClient');

beforeEach(async () => {
  fetchMock = vi.fn();
  (globalThis as any).fetch = fetchMock;
  const { resetPostingCapabilityCache } = await loadModule();
  resetPostingCapabilityCache();
});

afterEach(() => {
  delete (globalThis as any).fetch;
});

describe('server capability probe', () => {
  it('enables the authoritative path when the server says enabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true, boundary: 'examination' }));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/examination/posting/capability');
    expect(init.method).toBe('GET');
  });

  it('stays on the legacy path when the server says disabled', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: false }));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(false);
  });

  it('stays on the legacy path for an older server without the endpoint', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(404, {}));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce(jsonResponse(405, {}));
    const { resetPostingCapabilityCache, isAuthoritativePostingAvailable: probeAgain } = await loadModule();
    resetPostingCapabilityCache();
    await expect(probeAgain()).resolves.toBe(false);
  });

  it('stays on the legacy path for a malformed success response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(false);
  });

  it('fails CLOSED when the probe cannot reach the server', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);
  });

  it('fails CLOSED on a 5xx probe response', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'unavailable' }));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);
  });

  it('probes once per session and reuses the cached decision', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true }));
    const { isAuthoritativePostingAvailable } = await loadModule();

    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);
    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);
    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the explicit cache reset', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: false }));
    const { isAuthoritativePostingAvailable, resetPostingCapabilityCache } = await loadModule();
    await expect(isAuthoritativePostingAvailable()).resolves.toBe(false);

    resetPostingCapabilityCache();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true }));
    await expect(isAuthoritativePostingAvailable()).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent probes into one request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { enabled: true }));
    const { isAuthoritativePostingAvailable } = await loadModule();

    const results = await Promise.all([
      isAuthoritativePostingAvailable(),
      isAuthoritativePostingAvailable(),
      isAuthoritativePostingAvailable(),
    ]);

    expect(results).toEqual([true, true, true]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

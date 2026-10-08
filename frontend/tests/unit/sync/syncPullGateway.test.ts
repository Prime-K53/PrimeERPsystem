/**
 * P1 pull-gateway client tests (frontend/services/syncApiClient.fetchPullPage).
 *
 * Verifies that the pull client:
 *   1. Requests the backend gateway (never Supabase REST directly)
 *   2. Sends the stored sync token + JSON identity headers
 *   3. Encodes table/cursor/pagination as query params
 *   4. Returns rows + page metadata on success
 *   5. Maps 401/403 to SyncAuthError, 503 to a config error, and other
 *      failures to structured Errors (never an empty success)
 *   6. Rejects invalid table names without touching the network
 *
 * NOTE: the global test setup stubs window.sessionStorage with no-op mocks,
 * so the stored-session layer is mocked here instead of driven via storage.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const { mockGetStoredUserSession, mockIsSessionExpired } = vi.hoisted(() => ({
  mockGetStoredUserSession: vi.fn(() => null),
  mockIsSessionExpired: vi.fn(() => false),
}));

vi.mock('../../../services/authSession', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/authSession')>();
  return {
    ...actual,
    getStoredUserSession: mockGetStoredUserSession,
    isSessionExpired: mockIsSessionExpired,
  };
});

// The global setup stubs localStorage/sessionStorage, so drive the token
// fallback path (supabase-js session) with a stubbed client.
vi.mock('../../../services/supabaseClient', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: 'tok-123', expires_at: Math.floor(Date.now() / 1000) + 3600 } },
      })),
    },
  },
}));

import { fetchPullPage, SyncAuthError, SyncPullRateLimitedError } from '../../../services/syncApiClient';

const realFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const liveSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'u1',
  accessToken: 'tok-123',
  tokenExpiry: new Date(Date.now() + 3600_000).toISOString(),
  ...overrides,
});

describe('fetchPullPage (backend pull gateway client)', () => {
  afterEach(() => {
    (globalThis as any).fetch = realFetch;
    mockGetStoredUserSession.mockReset().mockReturnValue(null);
    mockIsSessionExpired.mockReset().mockReturnValue(false);
  });

  it('requests the backend gateway with table/cursor/pagination params', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, table: 'settings', rows: [], page: { offset: 2000, limit: 500, count: 0, hasMore: false } }));
    (globalThis as any).fetch = fetchMock;

    await fetchPullPage('settings', { since: '2026-02-01T00:00:00.000Z', offset: 2000, limit: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/sync/pull');
    expect(url).not.toContain('supabase.co');
    expect(url).toContain('table=settings');
    expect(url).toContain('offset=2000');
    expect(url).toContain('limit=500');
    expect(url).toContain('since=');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tok-123');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('returns rows and page metadata on success', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    const rows = [{ id: 'companyConfig', updated_at: '2026-03-01T00:00:00.000Z' }];
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(200, { ok: true, table: 'settings', rows, page: { offset: 0, limit: 2000, count: 1, hasMore: false } })
    );

    const page = await fetchPullPage('settings', { offset: 0, limit: 2000 });
    expect(page.table).toBe('settings');
    expect(page.rows).toHaveLength(1);
    expect(page.page).toMatchObject({ count: 1, hasMore: false });
  });

  it('maps 401/403 to SyncAuthError', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    (globalThis as any).fetch = vi.fn(async () => jsonResponse(401, { error: 'Unauthenticated' }));
    await expect(fetchPullPage('products', {})).rejects.toBeInstanceOf(SyncAuthError);

    (globalThis as any).fetch = vi.fn(async () => jsonResponse(403, { error: 'Forbidden' }));
    await expect(fetchPullPage('products', {})).rejects.toBeInstanceOf(SyncAuthError);
  });

  it('maps 429 to a structured SyncPullRateLimitedError with Retry-After', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(429, { error: 'Rate limit exceeded' }, { 'Retry-After': '45' })
    );
    const err = await fetchPullPage('products', {}).catch((e) => e);
    expect(err).toBeInstanceOf(SyncPullRateLimitedError);
    expect(err.status).toBe(429);
    expect(err.table).toBe('products');
    expect(err.retryAfterSecs).toBe(45);
  });

  it('maps 429 without Retry-After to retryAfterSecs 0 (engine default applies)', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    (globalThis as any).fetch = vi.fn(async () => jsonResponse(429, { error: 'Rate limit exceeded' }));
    const err = await fetchPullPage('products', {}).catch((e) => e);
    expect(err).toBeInstanceOf(SyncPullRateLimitedError);
    expect(err.retryAfterSecs).toBe(0);
  });

  it('propagates a pass-level circuit abort untouched (never as a timeout)', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    // A fetch that honors the abort signal like a real one.
    (globalThis as any).fetch = vi.fn(
      (_url: unknown, init: RequestInit = {}) =>
        new Promise((_resolve, reject) => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          if (init.signal?.aborted) { reject(err); return; }
          init.signal?.addEventListener('abort', () => reject(err), { once: true });
        })
    );
    const controller = new AbortController();
    const pending = fetchPullPage('products', { signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
  });

  it('surfaces 400 table rejections as errors (never empty success)', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    (globalThis as any).fetch = vi.fn(async () => jsonResponse(400, { error: 'table not allowed: pg_shadow' }));
    await expect(fetchPullPage('pg_shadow', {})).rejects.toThrow(/not allowed/);
  });

  it('surfaces 502 cloud failures as errors (never empty success)', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession());
    (globalThis as any).fetch = vi.fn(async () => jsonResponse(502, { error: 'Cloud pull failed', detail: 'connection closed' }));
    await expect(fetchPullPage('products', {})).rejects.toThrow(/Cloud pull failed/);
  });

  it('rejects invalid table names without a network request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, rows: [], page: {} }));
    (globalThis as any).fetch = fetchMock;
    await expect(fetchPullPage('products;DROP TABLE x', {})).rejects.toThrow(/invalid pull table/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws SyncAuthError locally when the stored session is expired', async () => {
    mockGetStoredUserSession.mockReturnValue(liveSession({ tokenExpiry: new Date(Date.now() - 1000).toISOString() }));
    mockIsSessionExpired.mockReturnValue(true);
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, rows: [], page: {} }));
    (globalThis as any).fetch = fetchMock;
    await expect(fetchPullPage('products', {})).rejects.toBeInstanceOf(SyncAuthError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

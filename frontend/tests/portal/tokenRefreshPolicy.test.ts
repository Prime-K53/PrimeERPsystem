/**
 * Portal token expiry + refresh-failure policy tests (narrow, no React).
 *
 * Covers: expires_in parsing (never NaN), failure classification (transient
 * vs invalid), one-retry-then-give-up refresh semantics, same-tab mutex
 * deduplication, and session preservation on transient failures.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseExpiresInToMs,
  getAccessTokenAgeMs,
  computeRefreshDelayMs,
  classifyRefreshFailure,
  refreshPortalSessionDetailed,
  portalApi,
  getPortalSession,
} from '../../services/portalApiClient';

const SESSION_KEY = 'portal_session';

function mockStorage() {
  const map = new Map<string, string>();
  const ls = window.localStorage as any;
  if (typeof ls.getItem?.mockImplementation === 'function') {
    ls.getItem.mockImplementation((k: string) => map.get(k) ?? null);
    ls.setItem.mockImplementation((k: string, v: string) => { map.set(k, String(v)); });
    ls.removeItem.mockImplementation((k: string) => { map.delete(k); });
  }
  const ss = window.sessionStorage as any;
  if (typeof ss.getItem?.mockImplementation === 'function') {
    ss.getItem.mockImplementation((k: string) => map.get(k) ?? null);
    ss.setItem.mockImplementation((k: string, v: string) => { map.set(k, String(v)); });
    ss.removeItem.mockImplementation((k: string) => { map.delete(k); });
  }
  return map;
}

function seedSession(overrides: Record<string, unknown> = {}) {
  const session = {
    access_token: 'access-1',
    refresh_token: 'refresh-1',
    expires_in: '30m',
    refreshed_at: Date.now(),
    user: { id: 'u-1', customer_id: 'C-1', email: 'c@example.com' },
    ...overrides,
  };
  window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

describe('parseExpiresInToMs (Test 1: never NaN, robust formats)', () => {
  it("parses the backend '30m' duration string", () => {
    expect(parseExpiresInToMs('30m', 999)).toBe(30 * 60 * 1000);
  });

  it('parses seconds/minutes/hours/days suffixes and bare numerics', () => {
    expect(parseExpiresInToMs('90s', 999)).toBe(90_000);
    expect(parseExpiresInToMs('2h', 999)).toBe(7_200_000);
    expect(parseExpiresInToMs(1800, 999)).toBe(1_800_000);
  });

  it('falls back (never NaN) on missing/invalid values', () => {
    for (const bad of [undefined, null, '', 'soon', -5, NaN, {}, []]) {
      const out = parseExpiresInToMs(bad, 1234);
      expect(Number.isFinite(out)).toBe(true);
      expect(out).toBe(1234);
    }
  });

  it('derives proactive refresh delay clamped to [60s, 25m]', () => {
    expect(computeRefreshDelayMs('30m')).toBe(25 * 60 * 1000);
    expect(computeRefreshDelayMs('90s')).toBe(60_000);
    expect(computeRefreshDelayMs('garbage')).toBe(25 * 60 * 1000);
  });

  it('computes token age from the recorded timestamp, null when unknown', () => {
    expect(getAccessTokenAgeMs({ refreshed_at: Date.now() - 60_000 } as any)).toBeGreaterThanOrEqual(60_000 - 5000);
    expect(getAccessTokenAgeMs({} as any)).toBeNull();
    expect(getAccessTokenAgeMs(null)).toBeNull();
  });
});

describe('classifyRefreshFailure (Tests 4/5: transient vs invalid)', () => {
  it('treats timeouts, aborts, network errors and 5xx/429 as transient', () => {
    const abort = new DOMException('aborted', 'AbortError');
    expect(classifyRefreshFailure(abort)).toBe('transient');
    expect(classifyRefreshFailure(new TypeError('network'))).toBe('transient');
    expect(classifyRefreshFailure(undefined)).toBe('transient');
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyRefreshFailure(undefined, status)).toBe('transient');
    }
  });

  it('treats explicit auth rejections as invalid', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyRefreshFailure(undefined, status)).toBe('invalid');
    }
  });
});

describe('refresh retry + mutex (Tests 4/7)', () => {
  beforeEach(() => {
    mockStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('retries once after a timeout then succeeds without wiping the session', async () => {
    seedSession();
    const ok = { ok: true, status: 200, json: async () => ({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: '30m' }) };
    let calls = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      if (calls === 1) {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve(ok);
    });
    const pending = refreshPortalSessionDetailed();
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(getPortalSession()?.access_token).toBe('access-2');
  });

  it('gives up after one retry on persistent transient failure and keeps the session', async () => {
    seedSession();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      Promise.resolve({ ok: false, status: 503, json: async () => ({}) })
    );
    const pending = refreshPortalSessionDetailed();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result).toEqual({ ok: false, reason: 'transient' });
    // Session preserved (not wiped): access token still present.
    expect(getPortalSession()?.access_token).toBe('access-1');
  });

  it('treats 401 as invalid immediately with a single refresh call', async () => {
    seedSession();
    let calls = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      calls += 1;
      return Promise.resolve({ ok: false, status: 401, json: async () => ({ error: 'Invalid or expired refresh token' }) });
    });
    const result = await refreshPortalSessionDetailed();
    expect(result).toEqual({ ok: false, reason: 'invalid' });
    expect(calls).toBe(1);
  });

  it('deduplicates concurrent refreshes in the same tab (one refresh POST)', async () => {
    seedSession();
    let refreshCalls = 0;
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      refreshCalls += 1;
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ access_token: 'access-9', refresh_token: 'refresh-9', expires_in: '30m' }) });
    });
    const [a, b, c] = await Promise.all([
      refreshPortalSessionDetailed(),
      refreshPortalSessionDetailed(),
      refreshPortalSessionDetailed(),
    ]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(refreshCalls).toBe(1);
  });
});

describe('transient dashboard failure preserves the session (Test 9)', () => {
  beforeEach(() => {
    mockStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a timed-out uncached GET throws but leaves the session intact', async () => {
    seedSession();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const err: any = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    });
    await expect(portalApi.get('/dashboard')).rejects.toThrow('timed out');
    expect(getPortalSession()?.access_token).toBe('access-1');
  });

  it('a 401 followed by transient refresh failure keeps the session (no wipe)', async () => {
    seedSession();
    (global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string) => {
      if (String(url).includes('/auth/refresh')) {
        const err: any = new Error('aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      }
      return Promise.resolve({ ok: false, status: 401, json: async () => ({}) });
    });
    await expect(portalApi.get('/dashboard')).rejects.toThrow('temporarily unavailable');
    expect(getPortalSession()?.access_token).toBe('access-1');
  });
});

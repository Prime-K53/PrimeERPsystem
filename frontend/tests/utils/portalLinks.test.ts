/**
 * portalLinks.test.ts — the ERP login page's "Customer portal →" link must
 * open the REAL customer portal (a separate hash-routed deployment), not the
 * ERP's own `/portal/login` route.
 *
 *   development → http://localhost:3001/#/login
 *   production  → https://primeportalmw.vercel.app/#/login
 *
 * The production/localhost guard is covered through `pickPortalOrigin` (pure):
 * Vitest inlines `import.meta.env` at transform time, so the env value itself
 * cannot be stubbed from a test.
 */
import { describe, it, expect } from 'vitest';
import {
  LOCAL_PORTAL_ORIGIN,
  PORTAL_LOGIN_PATH,
  PRODUCTION_PORTAL_ORIGIN,
  buildPortalUrl,
  isLocalOrigin,
  pickPortalOrigin,
  resolveCustomerPortalLoginUrl,
  resolvePortalOrigin,
} from '../../utils/portalLinks';

describe('isLocalOrigin', () => {
  it('flags loopback and LAN hosts', () => {
    expect(isLocalOrigin('http://localhost:3001')).toBe(true);
    expect(isLocalOrigin('https://127.0.0.1:5173')).toBe(true);
    expect(isLocalOrigin('http://192.168.1.20:3001')).toBe(true);
    expect(isLocalOrigin('localhost:3001')).toBe(true);
  });

  it('accepts public hosts', () => {
    expect(isLocalOrigin('https://primeportalmw.vercel.app')).toBe(false);
    expect(isLocalOrigin('')).toBe(false);
    expect(isLocalOrigin(null)).toBe(false);
  });
});

describe('pickPortalOrigin', () => {
  it('uses the configured origin as-is', () => {
    expect(pickPortalOrigin('https://portal.example.test', false)).toBe('https://portal.example.test');
    expect(pickPortalOrigin('https://portal.example.test', true)).toBe('https://portal.example.test');
  });

  it('strips trailing slashes', () => {
    expect(pickPortalOrigin('https://portal.example.test///', true)).toBe('https://portal.example.test');
  });

  it('keeps localhost in development', () => {
    expect(pickPortalOrigin('http://localhost:3001', false)).toBe(LOCAL_PORTAL_ORIGIN);
    expect(pickPortalOrigin('', false)).toBe(LOCAL_PORTAL_ORIGIN);
    expect(pickPortalOrigin(undefined, false)).toBe(LOCAL_PORTAL_ORIGIN);
  });

  it('never ships a loopback origin to production', () => {
    expect(pickPortalOrigin('http://localhost:3001', true)).toBe(PRODUCTION_PORTAL_ORIGIN);
    expect(pickPortalOrigin('https://127.0.0.1:5173', true)).toBe(PRODUCTION_PORTAL_ORIGIN);
  });

  it('falls back to the deployed portal when unconfigured in production', () => {
    expect(pickPortalOrigin('', true)).toBe(PRODUCTION_PORTAL_ORIGIN);
  });
});

describe('buildPortalUrl', () => {
  it('builds a hash-route login URL', () => {
    expect(buildPortalUrl(PRODUCTION_PORTAL_ORIGIN)).toBe('https://primeportalmw.vercel.app/#/login');
    expect(buildPortalUrl(PRODUCTION_PORTAL_ORIGIN, PORTAL_LOGIN_PATH)).toBe('https://primeportalmw.vercel.app/#/login');
  });

  it('normalises sloppy origins and paths', () => {
    expect(buildPortalUrl('https://primeportalmw.vercel.app/', '/login')).toBe('https://primeportalmw.vercel.app/#/login');
    expect(buildPortalUrl('https://primeportalmw.vercel.app//', 'login')).toBe('https://primeportalmw.vercel.app/#/login');
    expect(buildPortalUrl('http://localhost:3001', '#/login')).toBe('http://localhost:3001/#/login');
    expect(buildPortalUrl('http://localhost:3001', '/dashboard')).toBe('http://localhost:3001/#/dashboard');
  });
});

describe('resolveCustomerPortalLoginUrl', () => {
  it('resolves to the real portal host from this build env', () => {
    const url = resolveCustomerPortalLoginUrl();
    expect(url.endsWith('/#/login')).toBe(true);
    expect(url).not.toContain('undefined');
    // Never points back at the ERP's own in-app portal route.
    expect(url).not.toBe('/portal/login');
    expect(new URL(url).protocol).toMatch(/^https?:$/);
  });

  it('uses the same origin the QR/verification links use', () => {
    expect(resolveCustomerPortalLoginUrl()).toBe(buildPortalUrl(resolvePortalOrigin()));
  });
});

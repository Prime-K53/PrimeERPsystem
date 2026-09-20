/**
 * portalLinks.ts — canonical way for the ERP to link OUT to the customer
 * Prime PORTAL.
 *
 * The Portal is a SEPARATE deployment (its own Vite app) that uses **hash
 * routing** (`window.location.hash`, routes `/login`, `/dashboard`, …), so a
 * customer login link is `<origin>/#/login`:
 *
 *   development → http://localhost:3001
 *   production  → https://primeportalmw.vercel.app
 *
 * Origin resolution order:
 *   1. `VITE_PUBLIC_PORTAL_URL` — the same variable the public document QR /
 *      verification links already use. A production build REFUSES a
 *      localhost/127.0.0.1 value so a stray development `.env` can never ship
 *      a broken customer link.
 *   2. Fallback constant for the build type (console log host in dev, the
 *      deployed Portal in production).
 *
 * Keep the `import.meta.env` member chain statically analyzable (no `?.`
 * between `import.meta` and `env`) — Vite substitutes it at serve/build time
 * and an optional chain defeats the substitution.
 */

/** Deployed customer portal (hash-routed SPA). */
export const PRODUCTION_PORTAL_ORIGIN = 'https://primeportalmw.vercel.app';

/** Local customer portal used during development (`npm run dev` on the portal repo). */
export const LOCAL_PORTAL_ORIGIN = 'http://localhost:3001';

/** Portal route for the customer sign-in page (hash routes are unprefixed). */
export const PORTAL_LOGIN_PATH = '/login';

/**
 * True when the origin points at a loopback or LAN host — never valid for a
 * shipped production build.
 *
 * Deliberately does NOT use `new URL`: `new URL('localhost:3001')` succeeds by
 * parsing `localhost` as the *scheme* (hostname `''`), which would let a
 * scheme-less local value slip through as "public".
 */
export function isLocalOrigin(url: string | null | undefined): boolean {
  const value = String(url || '').trim();
  if (!value) return false;
  const hostPart = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  return /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|::1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?::\d+)?(?:\/|$)/i.test(hostPart);
}

/**
 * Pure decision table for the portal origin. Split out of
 * `resolvePortalOrigin` so the production/localhost guard is testable without
 * stubbing `import.meta.env` (Vitest inlines it at transform time).
 */
export function pickPortalOrigin(envOrigin: string | null | undefined, isProduction: boolean): string {
  const fromEnv = String(envOrigin || '').trim().replace(/\/+$/, '');
  if (fromEnv && !(isProduction && isLocalOrigin(fromEnv))) {
    return fromEnv;
  }
  return isProduction ? PRODUCTION_PORTAL_ORIGIN : LOCAL_PORTAL_ORIGIN;
}

/**
 * Portal origin for the current build (no trailing slash).
 * Always returns an absolute origin — callers can render it directly.
 */
export function resolvePortalOrigin(): string {
  let fromEnv = '';
  try {
    fromEnv = String(import.meta.env.VITE_PUBLIC_PORTAL_URL || '');
  } catch { /* import.meta unavailable */ }
  return pickPortalOrigin(fromEnv, isProductionBuild());
}

function isProductionBuild(): boolean {
  try {
    if (import.meta.env.PROD) return true;
    if (import.meta.env.MODE === 'production') return true;
  } catch { /* import.meta unavailable */ }
  try {
    if (String((globalThis as any)?.process?.env?.NODE_ENV || '').toLowerCase() === 'production') return true;
  } catch { /* no process */ }
  return false;
}

/**
 * Hash-route URL builder. The Portal is hash-routed, so the path is appended
 * after `/#` and normalised to a single leading slash.
 */
export function buildPortalUrl(origin: string, path: string = PORTAL_LOGIN_PATH): string {
  const base = String(origin || '').trim().replace(/\/+$/, '');
  const route = `/${String(path || '').trim().replace(/^[/#]+/, '')}`;
  return `${base}/#${route}`;
}

/** Absolute URL of the customer portal sign-in page for this build. */
export function resolveCustomerPortalLoginUrl(): string {
  return buildPortalUrl(resolvePortalOrigin(), PORTAL_LOGIN_PATH);
}

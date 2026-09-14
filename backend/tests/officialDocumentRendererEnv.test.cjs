/**
 * officialDocumentRendererEnv.test.cjs — server-side Portal origin propagation.
 *
 * The renderer bundle (officialDocument/primeRenderer.cjs) is built with
 * `import.meta.env` mapped to `globalThis.__PRIME_DOC_VITE_ENV__`, so the
 * canonical verification URL builder inside the bundle reads
 * VITE_PUBLIC_PORTAL_URL from that global. These tests prove:
 *
 *   1. officialDocumentService.ensureRendererEnv() populates the global from
 *      the server runtime environment (process.env.VITE_PUBLIC_PORTAL_URL).
 *   2. The real bundle banner propagates process.env into the global when no
 *      loader preset it, and preserves a preset global otherwise.
 *   3. A missing Portal origin stays fail-closed (key absent — the bundled
 *      builder then keeps its legacy-QR fallback, never an ERP origin).
 *
 * Token generation/validation, the verification endpoint, RLS and auth are
 * NOT touched by the code under test.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const BUNDLE_PATH = path.resolve(__dirname, '..', 'services', 'officialDocument', 'primeRenderer.cjs');
const DEV_PORTAL = 'http://localhost:3001';
const PROD_PORTAL = 'https://portal.example.test';

let service;
let savedProcessValue;
let savedGlobal;
let hadGlobal;

beforeEach(() => {
  jest.resetModules();
  savedProcessValue = process.env.VITE_PUBLIC_PORTAL_URL;
  hadGlobal = Object.prototype.hasOwnProperty.call(globalThis, '__PRIME_DOC_VITE_ENV__');
  savedGlobal = globalThis.__PRIME_DOC_VITE_ENV__;
  delete globalThis.__PRIME_DOC_VITE_ENV__;
  delete process.env.VITE_PUBLIC_PORTAL_URL;
  service = require('../services/officialDocumentService.cjs');
});

afterEach(() => {
  if (savedProcessValue === undefined) delete process.env.VITE_PUBLIC_PORTAL_URL;
  else process.env.VITE_PUBLIC_PORTAL_URL = savedProcessValue;
  if (hadGlobal) globalThis.__PRIME_DOC_VITE_ENV__ = savedGlobal;
  else delete globalThis.__PRIME_DOC_VITE_ENV__;
});

describe('ensureRendererEnv (service-side propagation)', () => {
  test('development Portal origin reaches the renderer global', () => {
    process.env.VITE_PUBLIC_PORTAL_URL = DEV_PORTAL;
    const env = service.ensureRendererEnv();
    expect(env.VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
    expect(globalThis.__PRIME_DOC_VITE_ENV__.VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
  });

  test('production Portal origin passes through byte-identical (placeholder, not a real domain)', () => {
    process.env.VITE_PUBLIC_PORTAL_URL = `${PROD_PORTAL}/`;
    const env = service.ensureRendererEnv();
    // No normalization here — the canonical builder trims trailing slashes.
    expect(env.VITE_PUBLIC_PORTAL_URL).toBe(`${PROD_PORTAL}/`);
  });

  test('missing Portal origin stays fail-closed (key absent, never ERP origin)', () => {
    const env = service.ensureRendererEnv();
    expect('VITE_PUBLIC_PORTAL_URL' in env).toBe(false);
    expect(JSON.stringify(env)).not.toContain('5173');
    expect(JSON.stringify(env)).not.toContain('location');
  });

  test('preserves a preset global and fills the Portal origin without clobbering', () => {
    globalThis.__PRIME_DOC_VITE_ENV__ = { DEV: true, PROD: false, MODE: 'test', CUSTOM: 1 };
    process.env.VITE_PUBLIC_PORTAL_URL = DEV_PORTAL;
    const env = service.ensureRendererEnv();
    expect(env.DEV).toBe(true);
    expect(env.CUSTOM).toBe(1);
    expect(env.VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
  });

  test('explicit process.env wins over a stale preset value', () => {
    globalThis.__PRIME_DOC_VITE_ENV__ = { DEV: false, PROD: true, MODE: 'production', VITE_PUBLIC_PORTAL_URL: 'http://stale:9999' };
    process.env.VITE_PUBLIC_PORTAL_URL = DEV_PORTAL;
    expect(service.ensureRendererEnv().VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
  });

  test('missing env preserves a preset Portal origin', () => {
    globalThis.__PRIME_DOC_VITE_ENV__ = { DEV: false, PROD: true, MODE: 'production', VITE_PUBLIC_PORTAL_URL: DEV_PORTAL };
    expect(service.ensureRendererEnv().VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
  });
});

describe('bundle banner (real primeRenderer.cjs, fresh node process)', () => {
  function readBundleGlobal(extraEnv, preset) {
    const setup = preset
      ? `globalThis.__PRIME_DOC_VITE_ENV__=${JSON.stringify(preset)};`
      : '';
    const script = `${setup}require(${JSON.stringify(BUNDLE_PATH)});console.log(JSON.stringify(globalThis.__PRIME_DOC_VITE_ENV__));`;
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      timeout: 120000,
    });
    return JSON.parse(out.trim().split('\n').pop());
  }

  test('development origin from process.env reaches the bundle global', () => {
    const env = readBundleGlobal({ VITE_PUBLIC_PORTAL_URL: DEV_PORTAL });
    expect(env.VITE_PUBLIC_PORTAL_URL).toBe(DEV_PORTAL);
  }, 180000);

  test('production placeholder origin reaches the bundle global', () => {
    const env = readBundleGlobal({ VITE_PUBLIC_PORTAL_URL: PROD_PORTAL });
    expect(env.VITE_PUBLIC_PORTAL_URL).toBe(PROD_PORTAL);
  }, 180000);

  test('missing origin leaves the key absent (fail-closed)', () => {
    const env = readBundleGlobal({ VITE_PUBLIC_PORTAL_URL: '' });
    expect('VITE_PUBLIC_PORTAL_URL' in env).toBe(false);
    expect(env.PROD).toBe(true);
  }, 180000);

  test('a preset global is preserved by the banner', () => {
    const preset = { DEV: true, PROD: false, MODE: 'test', VITE_PUBLIC_PORTAL_URL: DEV_PORTAL };
    const env = readBundleGlobal({ VITE_PUBLIC_PORTAL_URL: PROD_PORTAL }, preset);
    expect(env).toEqual(preset);
  }, 180000);
});

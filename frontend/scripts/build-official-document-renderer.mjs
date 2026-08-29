/**
 * Builds the server-side official-document renderer bundle consumed by the
 * ERP backend (backend/services/officialDocument/primeRenderer.cjs).
 *
 * All runtime dependencies (react, @react-pdf/renderer, qrcode, pdfkit) are
 * BUNDLED into the output CJS file so the backend has no external runtime deps.
 *
 * Fixes addressed:
 *   1. Workspace node_modules hoisting barrier — everything bundled, nothing external
 *   2. import.meta.url used by pdfkit/pdfmake at module top-level — patched via plugin
 *
 * Run: npm run build:doc-renderer  (workspace:frontend)
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.resolve(frontendRoot, '../backend/services/officialDocument/primeRenderer.cjs');

// Browser-only storage modules (IndexedDB/localStorage/Supabase web client)
const NODE_SAFE_STORAGE_STUB = [
  '// Node-safe shim: replaces the browser storage layer inside the official',
  '// document renderer bundle. Never used at render time.',
  'export const initDB = async () => undefined;',
  'const passthrough = { get: (_t, prop) => (prop === "then" ? undefined : async () => null) };',
  'export const dbService = new Proxy({}, passthrough);',
  'export const productionDb = new Proxy({}, { get: (_t, prop) => (prop === "then" ? undefined : { toArray: async () => [] }) });',
  'export const supabase = null;',
  'export const OFFLINE_DB = null;',
].join('\n');

const nodeSafeStoragePlugin = {
  name: 'node-safe-storage',
  setup(build) {
    // Stub out browser storage/Supabase initialisation
    build.onLoad({ filter: /[\\\/]services[\\\/](db|productionDb|supabaseClient|cloudMode)\.ts$/ }, async (args) => ({
      contents: NODE_SAFE_STORAGE_STUB,
      loader: 'ts',
      resolveDir: path.dirname(args.path),
    }));

    // Stub canvas — referenced by some @react-pdf/renderer code paths
    // but never executed server-side.
    build.onResolve({ filter: /^canvas$/ }, () => ({
      path: 'canvas',
      namespace: 'canvas-stub',
    }));
    build.onLoad({ filter: /^canvas$/, namespace: 'canvas-stub' }, () => ({
      contents: '// canvas stub for Node bundle\nmodule.exports = {};',
      loader: 'js',
    }));

    // Intercept createRequire(import.meta.url) and #standard-fonts subpath imports across pdfkit
    // and convert to static requires so esbuild bundles standard fonts at build time.
    build.onLoad({ filter: /.*/ }, async (args) => {
      if (!args.path.includes('node_modules')) return null;
      let code = await fs.promises.readFile(args.path, 'utf8');
      let modified = false;
      if (code.includes('createRequire(')) {
        code = code.replace(/createRequire\([^)]+\)/g, 'require');
        modified = true;
      }
      if (code.includes('#standard-fonts/')) {
        code = code.replace(/#standard-fonts\//g, 'pdfkit/standard-fonts/');
        modified = true;
      }
      if (modified) {
        return { contents: code, loader: args.path.endsWith('.mjs') ? 'js' : undefined };
      }
      return null;
    });

    // Resolve pdfkit package subpath imports so standard fonts are cleanly bundled into the single CJS output file.
    build.onResolve({ filter: /^pdfkit\/standard-fonts\/(.*)$/ }, (args) => {
      let fontName = args.path.replace('pdfkit/standard-fonts/', '');
      if (fontName.endsWith('.cjs')) fontName = fontName.replace(/\.cjs$/, '');
      const fontPath = path.resolve(frontendRoot, '../node_modules/pdfkit/js/standard-fonts', `${fontName}.cjs`);
      return { path: fontPath };
    });

    // Stub the pdfkit PDFA module that uses import.meta.url to load an ICC
    // color profile. PDF/A compliance is not needed for standard invoice/
    // quotation/receipt PDFs. We replace with a safe no-op object.
    build.onResolve({ filter: /\/pdfkit\/js\/mixins\/pdfa\.js$/ }, (args) => ({
      path: args.path,
      namespace: 'pdfa-stub',
    }));
    build.onLoad({ filter: /.*/, namespace: 'pdfa-stub' }, () => ({
      contents: [
        '// PDF/A stub: ICC color profile loading (import.meta.url) not available in CJS bundle.',
        '// Standard invoice/receipt PDFs do not require PDF/A compliance.',
        'module.exports = {',
        '  ICC_PROFILE_PATH: null,',
        '  iccProfile: null,',
        '  PDFA: {',
        '    initPDFA() {},',
        '    endSubset() {},',
        '    _addPdfaMetadata() {},',
        '    _addColorOutputIntent() {},',
        '  },',
        '};',
      ].join('\n'),
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: [path.join(frontendRoot, 'server', 'renderOfficialDocument.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  // All application-level deps are BUNDLED into the CJS file — no external
  // runtime deps required. This makes the bundle self-contained regardless
  // of the node_modules resolution path, fixing workspace-hoisting issues.
  external: [
    'node:*',
    'fsevents',
    'sharp',   // Native image addon — not used by the renderer
  ],
  alias: { '@': frontendRoot },
  plugins: [nodeSafeStoragePlugin],
  define: {
    'import.meta.env': '__PRIME_DOC_VITE_ENV__',
    'import.meta.url': '__PRIME_DOC_IMPORT_META_URL__',
    'process.env.NODE_ENV': '"production"',
  },
  banner: {
    js: [
      '// Vite-env shim for the server-side official document renderer.',
      '// All deps (react, @react-pdf/renderer, qrcode) are bundled — no external runtime deps.',
      'if (typeof globalThis.__PRIME_DOC_VITE_ENV__ === "undefined") {',
      '  globalThis.__PRIME_DOC_VITE_ENV__ = { DEV: false, PROD: true, MODE: "production" };',
      '}',
      'if (typeof globalThis.__PRIME_DOC_IMPORT_META_URL__ === "undefined") {',
      '  globalThis.__PRIME_DOC_IMPORT_META_URL__ = require("url").pathToFileURL(__filename).href;',
      '}',
      '// Minimal DOM stubs required by React/react-pdf internals (never actually used server-side)',
      'if (typeof globalThis.window === "undefined") {',
      '  globalThis.window = globalThis;',
      '}',
      'if (typeof globalThis.document === "undefined") {',
      '  globalThis.document = { createElement: () => ({}), createElementNS: () => ({}) };',
      '}',
    ].join('\n'),
  },
  logLevel: 'info',
});

console.log(`[build-official-document-renderer] wrote ${outFile}`);

/**
 * verifyRendererPortalQr.cjs — end-to-end proof that the REAL server-side
 * renderer bundle (officialDocument/primeRenderer.cjs) embeds Portal
 * verification URLs in official-PDF QR codes once VITE_PUBLIC_PORTAL_URL
 * reaches it through the existing __PRIME_DOC_VITE_ENV__ mechanism.
 *
 * NOTE ON PROVENANCE: the development database contains no usable document
 * rows (verified: anon REST on invoices returns 200 []), so this script
 * renders a SYNTHETIC IN-MEMORY invoice (nothing is persisted anywhere; the
 * PDF is written to the OS temp dir). It proves the renderer mechanism
 * byte-for-byte through the real bundle — it is NOT a real-document test.
 *
 * Modes (each runs in a FRESH child process — the renderer global is set once
 * per process, exactly like production):
 *   RUN_MODE=dev      VITE_PUBLIC_PORTAL_URL=http://localhost:3001
 *   RUN_MODE=prod     VITE_PUBLIC_PORTAL_URL=https://portal.example.test (placeholder)
 *   RUN_MODE=missing  no Portal origin (fail-closed: legacy QR payload expected)
 *
 * Run: node backend/tests/verifyRendererPortalQr.cjs
 * (self-drives all three modes as child processes)
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const TOKEN = '7'.repeat(64);
const NUMBER = 'INV-P726/029';
const ENCODED = 'INV-P726%2F029';
const DEV_PORTAL = 'http://localhost:3001';
const PROD_PORTAL = 'https://portal.example.test';

const EXPECTED = {
  dev: `${DEV_PORTAL}/#/verify/invoice/${ENCODED}?t=${TOKEN}`,
  prod: `${PROD_PORTAL}/#/verify/invoice/${ENCODED}?t=${TOKEN}`,
  missing: null, // legacy payload expected (fail-closed)
};

if (process.argv.includes('--child')) {
  runChild().catch((err) => {
    console.error(`CHILD_FAIL: ${err && err.stack || err}`);
    process.exit(1);
  });
} else {
  const modes = ['dev', 'prod', 'missing'];
  let failed = 0;
  for (const mode of modes) {
    const env = { ...process.env };
    delete env.VITE_PUBLIC_PORTAL_URL;
    if (mode === 'dev') env.VITE_PUBLIC_PORTAL_URL = DEV_PORTAL;
    if (mode === 'prod') env.VITE_PUBLIC_PORTAL_URL = PROD_PORTAL;
    console.log(`\n=== mode=${mode} ===`);
    try {
      const out = execFileSync(process.execPath, [__filename, '--child', mode], { env, encoding: 'utf8', timeout: 300000 });
      console.log(out.trim());
    } catch (err) {
      failed++;
      console.error(`MODE ${mode} FAILED:\n${(err.stdout || '')}\n${(err.stderr || '')}\n${err.message}`);
    }
  }
  if (failed) {
    console.error(`\nRESULT: ${modes.length - failed}/${modes.length} modes passed`);
    process.exit(1);
  }
  console.log(`\nRESULT: ${modes.length}/${modes.length} modes passed`);
}

async function runChild() {
  const mode = process.argv[process.argv.indexOf('--child') + 1];
  if (!['dev', 'prod', 'missing'].includes(mode)) throw new Error(`unknown mode ${mode}`);

  // 1. Real propagation path: service helper first (as loadRenderer does),
  //    then the real bundle (its banner only fills what is still undefined).
  const service = require('../services/officialDocumentService.cjs');
  service.ensureRendererEnv();
  const bundle = require('../services/officialDocument/primeRenderer.cjs');
  const render = bundle.renderOfficialDocumentPdf || bundle.default;
  if (typeof render !== 'function') throw new Error('renderer entrypoint missing');

  const seenGlobal = globalThis.__PRIME_DOC_VITE_ENV__ || {};
  console.log(`renderer env: ${JSON.stringify({ MODE: seenGlobal.MODE, PROD: seenGlobal.PROD, VITE_PUBLIC_PORTAL_URL: seenGlobal.VITE_PUBLIC_PORTAL_URL || null })}`);

  // 2. Synthetic IN-MEMORY invoice (never persisted) through the REAL bundle.
  const rawData = {
    invoiceNumber: NUMBER,
    date: '2026-09-01',
    dueDate: '2026-09-30',
    customerName: 'QR Proof Customer',
    status: 'posted',
    items: [{ description: 'A4 Paper Ream', quantity: 10, price: 5000, total: 50000 }],
    subtotal: 50000,
    total: 50000,
    verificationToken: TOKEN,
  };
  const buffer = await render({
    type: 'INVOICE',
    rawData,
    companyConfig: { companyName: 'Prime Printing Service' },
    customers: [],
    channel: 'erp',
  });
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('empty render output');
  if (buffer.slice(0, 5).toString('ascii') !== '%PDF-') throw new Error('not a PDF');
  const pdfPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `portal-qr-${mode}-`)), `invoice-${mode}.pdf`);
  fs.writeFileSync(pdfPath, buffer);
  console.log(`pdf bytes: ${buffer.length} -> ${pdfPath}`);

  // 3. Extract embedded /Image XObjects and decode each with jsQR.
  const decoded = decodeQrImagesFromPdf(buffer);
  console.log(`decoded QR payloads: ${decoded.length}`);
  for (const d of decoded) console.log(`  QR: ${d}`);

  const expected = EXPECTED[mode];
  if (expected) {
    if (!decoded.includes(expected)) {
      throw new Error(`expected Portal QR payload not found.\n  expected: ${expected}\n  got: ${JSON.stringify(decoded)}`);
    }
    if (decoded.some((d) => d.includes('127.0.0.1:5173') || d.includes('localhost:5173'))) {
      throw new Error('ERP-origin fallback leaked into a server-rendered QR');
    }
    // Token identity + single encoding, byte-exact.
    const payload = decoded.find((d) => d === expected);
    if (payload.split('?t=')[1] !== TOKEN) throw new Error('token bytes changed in QR payload');
    if (!payload.includes(ENCODED) || payload.includes('%252F')) throw new Error('document-number encoding wrong');
    console.log(`CHILD_PASS mode=${mode} (Portal QR, token identical, encoding exact)`);
  } else {
    // Fail-closed: no verification URL anywhere, legacy human-readable payload.
    if (decoded.some((d) => d.includes('/#/verify/'))) {
      throw new Error(`fail-closed violated: verification URL present without Portal origin: ${JSON.stringify(decoded)}`);
    }
    if (!decoded.some((d) => d.includes('Prime Printing Service') && d.includes('created on'))) {
      throw new Error(`legacy fallback payload missing: ${JSON.stringify(decoded)}`);
    }
    console.log(`CHILD_PASS mode=${mode} (fail-closed: legacy payload, no verify URL)`);
  }
}

/** Find every embedded image XObject, inflate it, and jsQR-decode it. */
function decodeQrImagesFromPdf(buffer) {
  const jsqr = require(path.join(__dirname, '..', '..', 'frontend', 'node_modules', 'jsqr'));
  const decode = jsqr.default || jsqr;
  const latin = buffer.toString('latin1');
  const results = [];
  const objRe = /(\d+) 0 obj\r?\n<<([\s\S]*?)>>\r?\nstream\r?\n/g;
  let m;
  while ((m = objRe.exec(latin)) !== null) {
    // Re-scan the dict with depth counting (DecodeParms may nest <<>>).
    const dictStart = m.index + m[0].indexOf('<<');
    const dict = readDict(latin, dictStart);
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const width = numProp(dict, 'Width');
    const height = numProp(dict, 'Height');
    const bpc = numProp(dict, 'BitsPerComponent') || 8;
    const cs = csProp(dict);
    const filter = strProp(dict, 'Filter');
    if (!width || !height || !/FlateDecode/.test(filter || '')) continue;
    if (/\/SMask\b/.test(dict) && !/\/Image\b/.test(dict)) continue;
    const streamStart = latin.indexOf('stream', m.index) + 'stream'.length;
    const dataStart = latin[streamStart] === '\r' ? streamStart + 2 : streamStart + 1;
    const dataEnd = latin.indexOf('endstream', dataStart);
    const raw = buffer.subarray(dataStart, dataEnd);
    let samples;
    try {
      samples = zlib.inflateSync(raw);
    } catch {
      continue;
    }
    const rgba = toRgba(samples, width, height, bpc, cs);
    if (!rgba) continue;
    try {
      const hit = decode(rgba, width, height);
      if (hit && hit.data) results.push(String(hit.data));
    } catch {
      /* not a QR-bearing image (e.g. logo art) */
    }
  }
  return results;
}

function readDict(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s.startsWith('<<', i)) { depth++; i++; }
    else if (s.startsWith('>>', i)) { depth--; if (depth === 0) return s.slice(start, i + 2); i++; }
  }
  return '';
}

function numProp(dict, name) {
  const m = dict.match(new RegExp(`/${name}\\s+(\\d+)`));
  return m ? parseInt(m[1], 10) : 0;
}

function strProp(dict, name) {
  const m = dict.match(new RegExp(`/${name}\\s*(/\\S+|\\[[^\\]]*\\])`));
  return m ? m[1] : '';
}

function csProp(dict) {
  const direct = dict.match(/\/ColorSpace\s*\/(\S+)/);
  if (direct) return direct[1];
  const arr = dict.match(/\/ColorSpace\s*\[\s*\/(\S+)/);
  return arr ? arr[1] : '';
}

function toRgba(samples, w, h, bpc, cs) {
  if (bpc !== 8) return null;
  const comps = cs === 'DeviceRGB' ? 3 : cs === 'DeviceGray' ? 1 : 0;
  if (!comps) return null;
  if (samples.length < w * h * comps) return null;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let r, g, b;
    if (comps === 3) { r = samples[i * 3]; g = samples[i * 3 + 1]; b = samples[i * 3 + 2]; }
    else { r = g = b = samples[i]; }
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}

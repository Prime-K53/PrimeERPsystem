/**
 * Prime ERP app-icon generator (dependency-free: only Node builtins).
 *
 * Regenerates the full installable icon set from the CURRENT brand identity
 * (green rounded square + white "p") so the desktop/PWA icon always matches
 * the in-app icon:
 *   - public/pwa-icon-192x192.png / pwa-icon-512x512.png (transparent corners)
 *   - public/pwa-icon-*-maskable.png (full-bleed, glyph in the safe zone)
 *   - public/favicon.ico (16/32/48 PNG-compressed entries)
 *   - repo-root pwa-icon copies (legacy duplicates, kept in sync)
 *
 * The brand green is sampled from the previous committed 192px icon, and the
 * "p" glyph is redrawn as vector geometry (stem + ring bowl) with analytic
 * anti-aliasing, so every size is crisp.
 *
 * Usage: node scripts/generate-icons.cjs
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* ---------------- PNG decode (for brand sampling) ---------------- */
function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i];
    for (let j = 0; j < 8; j++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePNG(filePath) {
  const buf = fs.readFileSync(filePath);
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatParts = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG format in ${filePath} (depth=${bitDepth}, type=${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let x = 0; x < stride; x++) {
      const cur = raw[p++];
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + left;
      else if (filter === 2) v = cur + up;
      else if (filter === 3) v = cur + ((left + up) >> 1);
      else if (filter === 4) v = cur + paeth(left, up, upLeft);
      else throw new Error(`Unknown filter ${filter}`);
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function encodePNG_RGBA(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- SDF helpers (unit space, y down) ---------------- */
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
// Anti-aliased coverage: 1 deep inside, 0 outside. aaHalfWidth in px.
const coverage = (d, pxPerUnit) => clamp01(0.5 - d * pxPerUnit);

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/**
 * White "p": vertical stem + ring bowl, matching the brand mark proportions.
 * transform maps glyph box [0..1]^2 onto the canvas; scale shrinks it for
 * the maskable safe zone.
 */
function sdGlyphP(px, py, opts) {
  const { cx, cy, size } = opts; // center + bounding-box size in canvas units
  const gx = (px - (cx - size / 2)) / size;
  const gy = (py - (cy - size / 2)) / size;
  // Proportions sampled from the brand icon (glyph-unit space):
  // stem x .246-.394 / y .192-.859; bowl center (.526,.481) R .254; counter r .128
  const stem = sdRoundRect(gx, gy, 0.32, 0.5255, 0.074, 0.3335, 0.02);
  const dx = gx - 0.526;
  const dy = gy - 0.481;
  const dist = Math.hypot(dx, dy);
  const bowl = 0.254 - dist; // <0 inside outer circle
  const hole = dist - 0.128; // <0 inside counter
  const union = Math.min(stem, -bowl); // stem merged with bowl disc
  return Math.max(union, -hole); // punch out the counter
}

function renderIcon(size, opts) {
  const { bg, glyph, fullBleed, glyphScale, cornerRadius } = opts;
  const SS = 2; // supersample factor
  const W = size * SS;
  const buf = Buffer.alloc(W * W * 4);
  for (let y = 0; y < W; y++) {
    const py = (y + 0.5) / W;
    for (let x = 0; x < W; x++) {
      const px = (x + 0.5) / W;
      const pxPerUnit = W;
      let r = bg[0];
      let g = bg[1];
      let b = bg[2];
      let a = 255;
      if (!fullBleed) {
        const dBg = sdRoundRect(px, py, 0.5, 0.5, 0.5, 0.5, cornerRadius);
        a = Math.round(coverage(dBg, pxPerUnit) * 255);
      }
      const dGlyph = sdGlyphP(px, py, { cx: 0.5, cy: 0.5, size: glyphScale });
      const ga = coverage(dGlyph, pxPerUnit);
      r = Math.round(glyph[0] * ga + r * (1 - ga));
      g = Math.round(glyph[1] * ga + g * (1 - ga));
      b = Math.round(glyph[2] * ga + b * (1 - ga));
      const o = (y * W + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = fullBleed ? 255 : a;
    }
  }
  // Box downsample to target size
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * W + (x * SS + sx)) * 4;
          r += buf[o];
          g += buf[o + 1];
          b += buf[o + 2];
          a += buf[o + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return { width: size, height: size, data: out };
}

function encodeICO(entries) {
  // entries: [{size, png: Buffer}]
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 16 * entries.length;
  let offset = 6 + dirSize;
  const dirs = [];
  for (const e of entries) {
    const d = Buffer.alloc(16);
    d[0] = e.size >= 256 ? 0 : e.size;
    d[1] = e.size >= 256 ? 0 : e.size;
    d[2] = 0;
    d[3] = 0;
    d.writeUInt16LE(1, 4);
    d.writeUInt16LE(32, 6);
    d.writeUInt32LE(e.png.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += e.png.length;
    dirs.push(d);
  }
  return Buffer.concat([header, ...dirs, ...entries.map((e) => e.png)]);
}

/* ---------------- main ---------------- */
function main() {
  const publicDir = path.join(__dirname, '..', 'public');
  const rootDir = path.join(__dirname, '..', '..');

  // Sample the brand green from the committed 192px icon (modal opaque color).
  const samplePath = path.join(publicDir, 'pwa-icon-192x192.png');
  let brand = [76, 140, 43]; // fallback leaf green
  try {
    const src = decodePNG(samplePath);
    const counts = new Map();
    for (let i = 0; i < src.width * src.height; i++) {
      const o = i * src.channels;
      const a = src.channels === 4 ? src.data[o + 3] : 255;
      if (a < 128) continue;
      const key = `${src.data[o]},${src.data[o + 1]},${src.data[o + 2]}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = null;
    let bestN = -1;
    for (const [k, n] of counts) {
      const [r, g, b] = k.split(',').map(Number);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum > 200) continue; // skip the white glyph
      if (n > bestN) {
        bestN = n;
        best = [r, g, b];
      }
    }
    if (best) brand = best;
  } catch (err) {
    console.log(`Brand sampling skipped (${err.message}); using fallback green.`);
  }
  console.log(`Brand green: rgb(${brand.join(', ')})`);

  const white = [255, 255, 255];
  const base = { bg: brand, glyph: white, cornerRadius: 0.225, glyphScale: 0.78 };
  const outputs = [];
  const icon192 = renderIcon(192, { ...base, fullBleed: false });
  const icon512 = renderIcon(512, { ...base, fullBleed: false });
  const mask192 = renderIcon(192, { ...base, fullBleed: true, glyphScale: 0.6 });
  const mask512 = renderIcon(512, { ...base, fullBleed: true, glyphScale: 0.6 });
  outputs.push(['pwa-icon-192x192.png', encodePNG_RGBA(192, 192, icon192.data)]);
  outputs.push(['pwa-icon-512x512.png', encodePNG_RGBA(512, 512, icon512.data)]);
  outputs.push(['pwa-icon-192x192-maskable.png', encodePNG_RGBA(192, 192, mask192.data)]);
  outputs.push(['pwa-icon-512x512-maskable.png', encodePNG_RGBA(512, 512, mask512.data)]);

  for (const [name, png] of outputs) {
    const outPath = path.join(publicDir, name);
    fs.writeFileSync(outPath, png);
    console.log(`Generated ${outPath} (${png.length} bytes)`);
  }

  // favicon.ico: 16/32/48 PNG-compressed entries (rounded, transparent corners)
  const icoEntries = [16, 32, 48].map((s) => {
    const img = renderIcon(s, { ...base, fullBleed: false });
    return { size: s, png: encodePNG_RGBA(s, s, img.data) };
  });
  const icoPath = path.join(publicDir, 'favicon.ico');
  fs.writeFileSync(icoPath, encodeICO(icoEntries));
  console.log(`Generated ${icoPath}`);

  // Keep the repo-root legacy copies in sync.
  for (const name of ['pwa-icon-192x192.png', 'pwa-icon-512x512.png']) {
    fs.copyFileSync(path.join(publicDir, name), path.join(rootDir, name));
    console.log(`Synced ${path.join(rootDir, name)}`);
  }

  console.log('All icons generated successfully.');
}

main();

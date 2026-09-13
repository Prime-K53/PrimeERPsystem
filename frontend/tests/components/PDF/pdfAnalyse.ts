/**
 * pdfAnalyse.ts — shared PDF-structure analysis for document pagination
 * tests (extracted verbatim from invoiceTemplatePagination.test.ts).
 *
 * Method: page objects are counted with a /Pages-safe pattern
 * (/Type /Page not followed by 's'). Per-page text comes from inflated
 * content streams (compared whitespace/case-insensitively because the
 * renderer positions glyphs individually and uppercases some labels).
 * QR placement is proven by rendering each fixture twice — with and
 * without the security payload — so the QR image object is identified by
 * set-difference (exact byte match), never by size heuristics; a page
 * "has the QR" iff its content stream draws that object.
 */
import { expect } from 'vitest';
import { inflateSync } from 'zlib';

// Whitespace-insensitive AND case-insensitive: the renderer positions
// glyphs individually (splitting words) and uppercases some labels.
export const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export function dictObjects(s: string): Array<{ num: number; dict: string }> {
  const out: Array<{ num: number; dict: string }> = [];
  const re = /(\d+)\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*(?:stream|endobj)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push({ num: Number(m[1]), dict: m[2] });
  return out;
}

export function inflateStream(buf: Buffer, objNum: number): Buffer | null {
  const s = buf.toString('latin1');
  const re = new RegExp(`${objNum}\\s+\\d+\\s+obj\\s*<<([\\s\\S]*?)>>\\s*stream\\r?\\n`);
  const m = re.exec(s);
  if (!m) return null;
  const start = m.index + m[0].length;
  const end = s.indexOf('endstream', start);
  if (end < 0) return null;
  const raw = buf.subarray(start, end);
  try {
    if (/FlateDecode/.test(m[1])) return inflateSync(raw);
  } catch { /* fall through raw */ }
  return raw;
}

export function decodeTextRuns(content: Buffer): string {
  const s = content.toString('latin1');
  const parts: string[] = [];
  const lit = /\((?:\\.|[^()\\])*\)/g;
  let m: RegExpExecArray | null;
  while ((m = lit.exec(s)) !== null) {
    parts.push(m[0].slice(1, -1).replace(/\\([()\\])/g, '$1').replace(/\\n/g, ' '));
  }
  const hex = /<([0-9A-Fa-f]+)>/g;
  while ((m = hex.exec(s)) !== null) {
    const h = m[1];
    if (/^FEFF/i.test(h)) {
      let out = '';
      for (let i = 4; i + 4 <= h.length; i += 4) out += String.fromCharCode(parseInt(h.slice(i, i + 4), 16));
      parts.push(out);
    } else {
      let out = '';
      for (let i = 0; i + 2 <= h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16));
      parts.push(out);
    }
  }
  return parts.join(' ');
}

export function imageObjectBytes(buf: Buffer): Map<number, string> {
  const s = buf.toString('latin1');
  const out = new Map<number, string>();
  for (const o of dictObjects(s)) {
    if (!/\/Subtype\s*\/Image/.test(o.dict)) continue;
    const content = inflateStream(buf, o.num);
    if (content) out.set(o.num, content.toString('latin1'));
  }
  return out;
}

export interface PageInfo {
  text: string;
  drawnImages: number[];
}

export function analysePages(buf: Buffer): PageInfo[] {
  const s = buf.toString('latin1');
  const objs = dictObjects(s);
  const nameToObj = new Map<string, number>();
  const xoRe = /\/XObject\s*<<([\s\S]*?)>>/g;
  let xm: RegExpExecArray | null;
  while ((xm = xoRe.exec(s)) !== null) {
    const refRe = /\/(\w+)\s+(\d+)\s+\d+\s+R/g;
    let rm: RegExpExecArray | null;
    while ((rm = refRe.exec(xm[1])) !== null) nameToObj.set(rm[1], Number(rm[2]));
  }
  return objs
    .filter((o) => /\/Type\s*\/Page(?!s)/.test(o.dict))
    .map((o) => {
      const refs: number[] = [];
      const arr = /\/Contents\s*\[([\s\S]*?)\]/.exec(o.dict);
      if (arr) {
        const rr = /(\d+)\s+\d+\s+R/g;
        let q: RegExpExecArray | null;
        while ((q = rr.exec(arr[1])) !== null) refs.push(Number(q[1]));
      } else {
        const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(o.dict);
        if (single) refs.push(Number(single[1]));
      }
      let text = '';
      const drawn = new Set<number>();
      for (const r of refs) {
        const content = inflateStream(buf, r);
        if (!content) continue;
        text += ' ' + decodeTextRuns(content);
        const cs = content.toString('latin1');
        const doRe = /\/(\w+)\s+Do\b/g;
        let dm: RegExpExecArray | null;
        while ((dm = doRe.exec(cs)) !== null) {
          const target = nameToObj.get(dm[1]);
          if (target !== undefined) drawn.add(target);
        }
      }
      return { text: norm(text), drawnImages: Array.from(drawn) };
    });
}

export function analyseWithQr(withQr: Buffer, withoutQr: Buffer) {
  const pages = analysePages(withQr);
  const qrCandidates = imageObjectBytes(withQr);
  const plainBytes = new Set(imageObjectBytes(withoutQr).values());
  let qrObj: number | null = null;
  for (const [num, bytes] of qrCandidates) {
    if (!plainBytes.has(bytes)) qrObj = num;
  }
  expect(qrObj, 'QR image object must exist exactly once').not.toBeNull();
  return { pages, pageCount: pages.length, qrObj: qrObj as number };
}

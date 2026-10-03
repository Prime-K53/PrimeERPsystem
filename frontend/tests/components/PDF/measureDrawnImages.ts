import { inflateSync } from 'zlib';

export interface DrawnImage {
  ref: string;
  w: number;
  h: number;
  page: number;
}

const dictObjects = (s: string) => {
  const out: Array<{ num: number; dict: string }> = [];
  const re = /(\d+) 0 obj([\s\S]*?)endobj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ num: Number(m[1]), dict: m[2] });
  return out;
};

/**
 * Walks every page content stream of a react-pdf PDF, tracking the CTM, and
 * reports the drawn size of each image XObject.
 *
 * Source-level inspection is not enough to prove a logo/QR is sized correctly:
 * the style value is transformed through nested `q`/`Q` matrices before being
 * written to the page. This returns what is physically on the page, in PDF
 * points, so tests can assert on real output.
 */
export function measureDrawnImages(buf: Buffer): DrawnImage[][] {
  const s = buf.toString('latin1');
  const objs = dictObjects(s);
  const pages: DrawnImage[][] = [];

  const pageRe = /\/Type\s*\/Page[^s]/g;
  let pm: RegExpExecArray | null;
  while ((pm = pageRe.exec(s))) {
    const cm = /\/Contents\s+(\d+)\s+0\s+R/.exec(s.slice(pm.index, pm.index + 400));
    if (!cm) continue;
    const contentNum = Number(cm[1]);
    const objStart = s.indexOf(`\n${contentNum} 0 obj`);
    if (objStart === -1) continue;
    const objEnd = s.indexOf('endobj', objStart);
    const dict = s.slice(objStart, objEnd);
    const lenM = /\/Length\s+(\d+)/.exec(dict);
    if (!lenM) continue;
    const len = Number(lenM[1]);
    let p = objStart + dict.indexOf('stream') + 6;
    if (s[p] === '\r') p++;
    if (s[p] === '\n') p++;

    let raw = Buffer.from(buf.subarray(p, p + len));
    if (/\/FlateDecode/.test(dict)) {
      try { raw = inflateSync(raw); } catch { /* stream is not compressed */ }
    }
    const t = raw.toString('latin1');

    const found: DrawnImage[] = [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack: number[][] = [];
    const re = /q\b|Q\b|([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) ([-\d.eE]+) cm|\/(I\d+|Im\d+)\s+Do/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      if (m[0] === 'q') { stack.push(ctm.slice()); continue; }
      if (m[0] === 'Q') { if (stack.length) ctm = stack.pop()!; continue; }
      if (m[1] !== undefined) {
        const n = m.slice(1, 7).map(Number);
        const cur = ctm;
        ctm = [
          n[0] * cur[0] + n[1] * cur[2], n[0] * cur[1] + n[1] * cur[3],
          n[2] * cur[0] + n[3] * cur[2], n[2] * cur[1] + n[3] * cur[3],
          n[4] * cur[0] + n[5] * cur[2] + cur[4], n[4] * cur[1] + n[5] * cur[3] + cur[5],
        ];
        continue;
      }
      found.push({ ref: m[7], w: Math.abs(ctm[0]), h: Math.abs(ctm[3]), page: pages.length + 1 });
    }
    pages.push(found);
  }
  return pages;
}

/** Flatten per-page results into the list of every image drawn in the document. */
export const allDrawnImages = (buf: Buffer): DrawnImage[] =>
  measureDrawnImages(buf).reduce<Array<DrawnImage>>((acc, pg) => acc.concat(pg), []);
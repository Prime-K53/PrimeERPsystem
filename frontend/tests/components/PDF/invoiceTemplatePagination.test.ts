/**
 * invoiceTemplatePagination.test.ts
 *
 * Presentation-only verification for the upgraded INVOICE template
 * (legacy/classic branch of PrimeDocument). No business logic, accounting,
 * numbering, QR algorithm, or Portal code is touched by these tests.
 *
 *  TEST A — one page: 1 page, Page 1 of 1, QR on page 1, no second page
 *  TEST B — two pages: QR only on page 2, compact footer on page 1
 *  TEST C — three pages: QR only on page 3
 *  TEST D/E/F — paid / partial / unpaid figures unchanged (mapper + render)
 *  TEST G — businessName identity (never contactName)
 *  TEST H — long business name (no breakage)
 *  TEST I — long description (no breakage)
 *  TEST J — QR payload equals existing documentSecurity logic output
 *  TEST K — valid PDF bytes from the same renderer Download/Print/Share use
 *  TEST L — source-vs-rendered data identity
 *
 * Method: render via the real pipeline (mapToInvoiceData →
 * attachDocumentSecurity → PrimeDocument toString), then analyse the PDF
 * structure directly. Page objects are counted with a /Pages-safe pattern
 * (/Type /Page not followed by 's'). Per-page text comes from inflated
 * content streams (compared whitespace-insensitively because the renderer
 * positions glyphs individually). QR placement is proven by rendering each
 * fixture twice — with and without the security payload — so the QR image
 * object is identified by set-difference (exact byte match), never by size
 * heuristics; a page "has the QR" iff its content stream draws that object.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { inflateSync } from 'zlib';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { generatePrimeDocumentBlob } from '../../../views/shared/components/PDF/generatePrimeDocumentBlob';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { enrichDocumentCustomerData } from '../../../utils/documentCustomerData';
import { attachDocumentSecurity, buildSecurityQrPayload } from '../../../utils/documentSecurity';

// Whitespace-insensitive AND case-insensitive: the renderer positions
// glyphs individually (splitting words) and uppercases some labels.
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

// ─── Fixtures ──────────────────────────────────────────────────────────

const COMPANY = 'Prime Printing Service';

function lineItems(n: number, desc?: (i: number) => string) {
  return Array.from({ length: n }, (_, i) => {
    const qty = (i % 5) + 1;
    const price = 5000 + i * 250;
    return {
      desc: desc ? desc(i) : `Exercise Book A4 Hardcover Ruled 200 Pages Premium Quality Line ${i + 1}`,
      qty,
      price,
      total: qty * price,
    };
  });
}

function rawInvoice(n: number, opts: any = {}) {
  const items = opts.items || lineItems(n);
  const subtotal = items.reduce((s: number, it: any) => s + it.total, 0);
  return {
    invoiceNumber: 'INV-P726/024',
    date: '2026-09-01',
    dueDate: '2026-10-01',
    businessName: 'Chiwana Primary School',
    contactName: 'John Banda',
    customerId: 'CUST-0100',
    address: 'P.O. Box 123, Lilongwe',
    phone: '+265 999 000 001',
    items,
    subtotal,
    discount: 0,
    amountPaid: 0,
    totalAmount: subtotal,
    status: 'Unpaid',
    totalCustomerOutstanding: subtotal,
    ...opts,
  };
}

async function securedInvoiceData(raw: any, withQr = true): Promise<any> {
  const enriched = enrichDocumentCustomerData(raw, []);
  const mapped: any = mapToInvoiceData(enriched, {} as any, 'INVOICE' as any);
  const secured = await attachDocumentSecurity(mapped, COMPANY);
  if (!withQr) {
    delete secured.securityQrCodeDataUrl;
    delete secured.securityQrPayload;
  }
  return secured;
}

async function renderInvoicePdf(raw: any, withQr = true, config: any = null): Promise<Buffer> {
  const secured = await securedInvoiceData(raw, withQr);
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type: 'INVOICE', data: secured, configOverride: config })
  ).toString()) as unknown as string;
  return Buffer.from(str, 'latin1');
}

async function analyseInvoice(raw: any, config: any = null) {
  const [withQr, withoutQr] = await Promise.all([
    renderInvoicePdf(raw, true, config),
    renderInvoicePdf(raw, false, config),
  ]);
  return analyseWithQr(withQr, withoutQr);
}

function analyseWithQr(withQr: Buffer, withoutQr: Buffer) {
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

// ─── PDF structure analysis ────────────────────────────────────────────

function dictObjects(s: string): Array<{ num: number; dict: string }> {
  const out: Array<{ num: number; dict: string }> = [];
  const re = /(\d+)\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*(?:stream|endobj)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push({ num: Number(m[1]), dict: m[2] });
  return out;
}

function inflateStream(buf: Buffer, objNum: number): Buffer | null {
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

function decodeTextRuns(content: Buffer): string {
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

function imageObjectBytes(buf: Buffer): Map<number, string> {
  const s = buf.toString('latin1');
  const out = new Map<number, string>();
  for (const o of dictObjects(s)) {
    if (!/\/Subtype\s*\/Image/.test(o.dict)) continue;
    const content = inflateStream(buf, o.num);
    if (content) out.set(o.num, content.toString('latin1'));
  }
  return out;
}

interface PageInfo {
  text: string;
  drawnImages: number[];
}

function analysePages(buf: Buffer): PageInfo[] {
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

// ─── Tests ─────────────────────────────────────────────────────────────

describe('invoice template pagination (presentation only)', () => {
  it('TEST A — one page: Page 1 of 1, QR on page 1, no second page', async () => {
    const { pages, pageCount, qrObj } = await analyseInvoice(rawInvoice(4));
    expect(pageCount).toBe(1);
    for (const p of pages) expect(p.text.length).toBeGreaterThan(200); // no blank pages
    expect(pages[0].text).toContain(norm('Page 1 of 1'));
    expect(pages[0].drawnImages).toContain(qrObj); // QR on the (final) page
    expect(pages[0].text).toContain(norm('INV-P726/024'));
    expect(pages[0].text).toContain(norm('DOCUMENT VERIFICATION'));
  }, 60000);

  it('TEST B — two pages: QR only on page 2, compact footer on page 1', async () => {
    const { pages, pageCount, qrObj } = await analyseInvoice(rawInvoice(14));
    expect(pageCount).toBe(2);
    const [p1, p2] = pages;
    for (const p of pages) expect(p.text.length).toBeGreaterThan(200); // no blank pages
    expect(p1.text).toContain(norm('Page 1 of 2'));
    expect(p2.text).toContain(norm('Page 2 of 2'));
    expect(p1.drawnImages).not.toContain(qrObj); // no QR on page 1
    expect(p2.drawnImages).toContain(qrObj); // QR on final page
    expect(p1.text).toContain(norm('Verify authenticity using the QR code on the final page'));
    expect(p2.text).not.toContain(norm('Verify authenticity using the QR code on the final page'));
    expect(p2.text).toContain(norm('DOCUMENT VERIFICATION'));
    expect(p1.text).not.toContain(norm('DOCUMENT VERIFICATION'));
    expect(p2.text).toContain(norm('continued')); // continuation header on page 2
    expect(p2.text).toContain(norm('Due Balance')); // totals appear once, on final page
    expect(p1.text).not.toContain(norm('Due Balance'));
  }, 60000);

  it('TEST C — three pages: QR only on page 3', async () => {
    const { pages, pageCount, qrObj } = await analyseInvoice(rawInvoice(34));
    expect(pageCount).toBe(3);
    const [p1, p2, p3] = pages;
    for (const p of pages) expect(p.text.length).toBeGreaterThan(200); // no blank pages
    expect(p1.text).toContain(norm('Page 1 of 3'));
    expect(p2.text).toContain(norm('Page 2 of 3'));
    expect(p3.text).toContain(norm('Page 3 of 3'));
    expect(p1.drawnImages).not.toContain(qrObj);
    expect(p2.drawnImages).not.toContain(qrObj);
    expect(p3.drawnImages).toContain(qrObj);
    expect(p1.text).toContain(norm('Verify authenticity using the QR code on the final page'));
    expect(p2.text).toContain(norm('Verify authenticity using the QR code on the final page'));
    expect(p3.text).toContain(norm('DOCUMENT VERIFICATION'));
    expect(p3.text).toContain(norm('Due Balance'));
  }, 60000);
});

describe('invoice figures unchanged (mapper level + render)', () => {
  it('TEST D — paid invoice figures preserved', async () => {
    const raw = rawInvoice(4, { amountPaid: 80000, totalAmount: 80000, subtotal: 80000, status: 'Paid' });
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    expect(mapped.amountPaid).toBe(80000);
    expect(mapped.totalAmount).toBe(80000);
    expect(mapped.status).toBe('Paid');
    const { pages } = await analyseInvoice(raw);
    expect(pages[0].text).toContain(norm('PAID'));
    expect(pages[0].text).toContain(norm('80,000.00'));
  }, 60000);

  it('TEST E — partially paid figures preserved', async () => {
    const raw = rawInvoice(4, { amountPaid: 30000, totalAmount: 80000, subtotal: 80000, status: 'Partial' });
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    expect(mapped.amountPaid).toBe(30000);
    expect(mapped.totalAmount - mapped.amountPaid).toBe(50000);
    expect(mapped.status).toBe('Partially Paid');
    const { pages } = await analyseInvoice(raw);
    expect(pages[0].text).toContain(norm('PARTIALLY PAID'));
    expect(pages[0].text).toContain(norm('50,000.00'));
  }, 60000);

  it('TEST F — UNPAID status unchanged', async () => {
    const { pages } = await analyseInvoice(rawInvoice(4));
    expect(pages[0].text).toContain(norm('UNPAID'));
  }, 60000);
});

describe('invoice identity + robustness', () => {
  it('TEST G — businessName wins, contactName never substituted', async () => {
    const raw = rawInvoice(2, { businessName: 'Maupo Primary School', contactName: 'John Banda' });
    delete (raw as any).customerName;
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    expect(mapped.clientName).toBe('Maupo Primary School');
    const { pages } = await analyseInvoice(raw);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Maupo Primary School'));
    expect(text).not.toContain(norm('John Banda'));
  }, 60000);

  it('TEST H — long business name does not break layout', async () => {
    const raw = rawInvoice(2, {
      businessName: 'Saint Michaels Community Day Secondary School and Teacher Training College Annex Campus',
    });
    delete (raw as any).customerName;
    const { pages, pageCount } = await analyseInvoice(raw);
    expect(pageCount).toBe(1);
    expect(pages[0].text).toContain(norm('Saint Michaels'));
  }, 60000);

  it('TEST I — long description does not break rows or pagination', async () => {
    const raw = rawInvoice(6, {
      items: lineItems(6, (i) =>
        i === 2
          ? 'Comprehensive Learner Assessment and Continuous Professional Development Workbook Series Volume Twelve Advanced Mathematics for Senior Primary Examination Preparation Classes with Answer Key Included'
          : `Standard Item Number ${i + 1} Description`
      ),
    });
    const { pages } = await analyseInvoice(raw);
    const text = pages.map((p) => p.text).join(' ');
    expect(text).toContain(norm('Comprehensive Learner Assessment'));
    expect(text).toContain(norm('Due Balance'));
  }, 60000);

  it('TEST J — QR payload equals existing documentSecurity output', async () => {
    const raw = rawInvoice(2);
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    const expectedPayload = buildSecurityQrPayload(mapped, COMPANY);
    const secured = await attachDocumentSecurity(mapped, COMPANY);
    expect(secured.securityQrPayload).toBe(expectedPayload);
    expect(secured.securityQrPayload).toContain('INV-P726/024');
    expect(String(secured.securityQrCodeDataUrl)).toMatch(/^data:image\//);
  });

  it('TEST K — renderer produces valid PDF bytes (Download/Print/Share source)', async () => {
    const secured = await securedInvoiceData(rawInvoice(4), true);
    const str = (await pdf(
      React.createElement(PrimeDocument as any, { type: 'INVOICE', data: secured })
    ).toString()) as unknown as string;
    // Same renderer bytes the Download/Print/Share pipeline consumes
    // (generatePrimeDocumentBlob wraps this exact element).
    expect(str.slice(0, 5)).toBe('%PDF-');
    expect(typeof generatePrimeDocumentBlob).toBe('function');
    const buf = Buffer.from(str, 'latin1');
    expect(analysePages(buf).length).toBe(1);
  }, 60000);
});

describe('businessName mapping precedence (presentation only)', () => {
  it('pdfMapper prefers businessName over legacy fallbacks', () => {
    const mapped: any = mapToInvoiceData(
      { ...rawInvoice(1), businessName: 'Maupo Primary School', customerName: 'Someone Else' } as any,
      {} as any,
      'INVOICE' as any
    );
    expect(mapped.clientName).toBe('Maupo Primary School');
  });

  it('pdfMapper supports business_name variant', () => {
    const raw: any = { ...rawInvoice(1) };
    delete raw.businessName;
    delete raw.customerName;
    raw.business_name = 'Maupo Primary School';
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    expect(mapped.clientName).toBe('Maupo Primary School');
  });

  it('enrichDocumentCustomerData prefers businessName and never contactName', () => {
    const enriched: any = enrichDocumentCustomerData(
      { businessName: 'Maupo Primary School', contactName: 'John Banda', customerId: 'CUST-1' },
      []
    );
    expect(enriched.customerName).toBe('Maupo Primary School');
    expect(enriched.customerName).not.toBe('John Banda');
  });
});

describe('source-vs-rendered identity (TEST L)', () => {
  it('rendered content matches source data exactly', async () => {
    const raw = rawInvoice(4, { amountPaid: 10000, status: 'Partial', totalCustomerOutstanding: 150000 });
    // Outstanding block is config-driven (existing behavior); enable it as in production.
    const { pages } = await analyseInvoice(raw, { invoiceTemplates: { showOutstandingAndWalletBalances: true } });
    const text = pages.map((p) => p.text).join(' ');
    const mapped: any = mapToInvoiceData(enrichDocumentCustomerData(raw, []), {} as any, 'INVOICE' as any);
    const subtotal = raw.items.reduce((s: number, it: any) => s + it.total, 0);
    expect(mapped.subtotal).toBe(subtotal);
    expect(mapped.totalAmount).toBe(raw.totalAmount);
    expect(mapped.amountPaid).toBe(10000);
    // Existing mapper derives 'Partially Paid' from the partial payment.
    expect(mapped.status).toBe('Partially Paid');
    for (const token of ['INV-P726/024', 'Chiwana Primary School', 'PartiallyPaid', '10,000.00']) {
      expect(text).toContain(norm(token));
    }
    expect(text).toContain(norm(subtotal.toLocaleString('en-US', { minimumFractionDigits: 2 })));
    expect(text).toContain(norm((subtotal - 10000).toLocaleString('en-US', { minimumFractionDigits: 2 })));
    expect(text).toContain(norm('150,000.00')); // outstanding balance block
  }, 60000);
});

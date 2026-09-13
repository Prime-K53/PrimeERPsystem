/**
 * deliveryNoteSignature.test.ts — recipient signature appears on the
 * Delivery Note PDF when present, blank area preserved when absent.
 *
 * Root cause fixed: the DELIVERY_NOTE signature block detected the
 * signature (`Boolean(signatureDataUrl)`) but rendered an EMPTY spacer
 * View instead of the signature image.
 *
 * Data-URL images embed synchronously in react-pdf, so preview, PDF
 * download, and browser print (all via generatePrimeDocumentBlob →
 * pdf(<PrimeDocument/>)) share this single render path.
 */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PNG } from 'pngjs';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import { analysePages, analyseWithQr, imageObjectBytes } from './pdfAnalyse';

const COMPANY = 'Prime Printing Service';

/** Minimal valid PNG data URL (white 60x24 with a dark scribble). */
function signaturePngDataUrl(): string {
  const png = new PNG({ width: 60, height: 24 });
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 60; x++) {
      const i = (60 * y + x) << 2;
      const ink = (x + y * 2) % 9 < 2 ? 30 : 255;
      png.data[i] = ink;
      png.data[i + 1] = ink;
      png.data[i + 2] = ink;
      png.data[i + 3] = 255;
    }
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString('base64')}`;
}

const dnRaw = (proofOfDelivery?: any) => ({
  id: 'DN-P726/020',
  invoiceId: 'INV-P726/024',
  date: '2026-09-01',
  customerName: 'Chigwenembe Primary School',
  shippingAddress: 'Area 3',
  status: 'Delivered',
  driverName: 'Moffat',
  vehicleNo: 'ZA 1234',
  items: [{ name: 'A4 Paper', quantity: 5 }],
  ...(proofOfDelivery ? { proofOfDelivery } : {}),
});

async function renderDn(proofOfDelivery?: any) {
  const mapped: any = mapToInvoiceData(dnRaw(proofOfDelivery), { currencySymbol: 'K' } as any, 'DELIVERY_NOTE' as any);
  const secured = await attachDocumentSecurity(mapped, COMPANY);
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type: 'DELIVERY_NOTE', data: secured })
  ).toString()) as unknown as string;
  return { secured, buf: Buffer.from(str, 'latin1') };
}

/**
 * Image objects present only when the signature is supplied (exact bytes).
 * Note: an RGBA PNG embeds as image + SMask twin, so the delta may hold
 * more than one object — callers assert on DRAWN delta for placement.
 */
function embeddedDelta(withSig: Buffer, withoutSig: Buffer): number[] {
  const base = new Set(imageObjectBytes(withoutSig).values());
  const out: number[] = [];
  for (const [num, bytes] of imageObjectBytes(withSig)) {
    if (!base.has(bytes)) out.push(num);
  }
  return out;
}

/** Images drawn on the final page only when the signature is supplied. */
function drawnDelta(withSig: Buffer, withoutSig: Buffer): number[] {
  const withPages = analysePages(withSig);
  const withoutPages = analysePages(withoutSig);
  const base = new Set(withoutPages.flatMap((p) => p.drawnImages));
  const finalPage = withPages[withPages.length - 1];
  return finalPage.drawnImages.filter((n) => !base.has(n));
}

describe('delivery note recipient signature', () => {
  it('embeds + draws the signature image when present (reload-safe via mapper)', async () => {
    const sig = signaturePngDataUrl();
    const proof = {
      receivedBy: 'Chigwenembe Primary School',
      timestamp: '2026-09-01T10:00:00.000Z',
      signatureDataUrl: sig,
      signatureInputMode: 'Upload',
    };
    const { buf } = await renderDn(proof);
    const { buf: plainBuf } = await renderDn(undefined);
    // Extra embedded bytes: the recipient signature (image [+ SMask twin]).
    expect(embeddedDelta(buf, plainBuf).length).toBeGreaterThanOrEqual(1);
    const pages = analysePages(buf);
    expect(pages.length).toBe(1);
    // Drawn on the (final) page inside the signature block.
    expect(drawnDelta(buf, plainBuf).length).toBeGreaterThanOrEqual(1);
    expect(pages[0].text).toContain('RECEIVEDBY');
  }, 120000);

  it('keeps the blank signature area (no broken image) when absent', async () => {
    const { buf } = await renderDn(undefined);
    const pages = analysePages(buf);
    expect(pages.length).toBe(1);
    // Signature line still printed; no signature image embedded.
    expect(pages[0].text).toContain('RECEIVEDBY');
    expect(pages[0].text).toContain('STAMP');
    const { buf: sigBuf } = await renderDn({
      receivedBy: 'Chigwenembe Primary School',
      timestamp: '2026-09-01T10:00:00.000Z',
      signatureDataUrl: signaturePngDataUrl(),
      signatureInputMode: 'Upload',
    });
    expect(drawnDelta(sigBuf, buf).length).toBeGreaterThanOrEqual(1);
  }, 120000);

  it('never embeds non-PDF-safe payloads (no crash, blank area kept)', async () => {
    const { buf } = await renderDn({
      receivedBy: 'Chigwenembe Primary School',
      timestamp: '2026-09-01T10:00:00.000Z',
      // webp cannot be embedded by react-pdf: must fall back to blank.
      signatureDataUrl: 'data:image/webp;base64,AAA',
      signatureInputMode: 'Upload',
    });
    const { buf: plainBuf } = await renderDn(undefined);
    expect(embeddedDelta(buf, plainBuf).length).toBe(0);
    expect(drawnDelta(buf, plainBuf).length).toBe(0);
    expect(analysePages(buf).length).toBe(1);
  }, 120000);

  it('accepts the legacy `signature` key end-to-end (capture mirror field)', async () => {
    const sig = signaturePngDataUrl();
    const { buf } = await renderDn({
      receivedBy: 'Chigwenembe Primary School',
      timestamp: '2026-09-01T10:00:00.000Z',
      signature: sig,
      signatureInputMode: 'Draw',
    });
    const { buf: plainBuf } = await renderDn(undefined);
    // Mapper normalizes `signature` -> signatureDataUrl (resolveSignatureDataUrl).
    expect(drawnDelta(buf, plainBuf).length).toBeGreaterThanOrEqual(1);
  }, 120000);
});

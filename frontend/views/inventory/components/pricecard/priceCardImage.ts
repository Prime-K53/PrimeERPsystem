import html2canvas from 'html2canvas';
import { logger } from '../../../../services/logger';

/**
 * priceCardImage — DOM → PNG capture for Price Cards (ERP only).
 *
 * Reuses the established html2canvas pipeline (SmartPricing, BarcodePrinter,
 * JobTickets): same options shape, same anchor-download and native-share
 * fallbacks. No new dependencies, fully client-side (offline-capable).
 */

export async function renderPriceCardPng(element: HTMLElement): Promise<Blob> {
  const canvas = await html2canvas(element, {
    backgroundColor: '#ffffff',
    scale: 2,
    useCORS: true,
    logging: false,
  });
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('Image generation produced an empty file.');
  return blob;
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.download = fileName;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
}

export type ShareOutcome = 'shared' | 'downloaded';

/**
 * Native share sheet (Android → WhatsApp) where supported, otherwise
 * download fallback. Never throws for a user-cancelled share.
 */
export async function shareImageFile(blob: Blob, fileName: string, title: string, text?: string): Promise<ShareOutcome> {
  const canShareFiles =
    typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function';
  if (canShareFiles) {
    const file = new File([blob], fileName, { type: 'image/png' });
    const shareData: ShareData = { title, files: [file] };
    if (text) shareData.text = text;
    try {
      if (navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return 'shared';
      }
    } catch (error) {
      // User dismissed the sheet — treat as a no-op, not a failure.
      if (error instanceof DOMException && error.name === 'AbortError') return 'shared';
      logger.error('[PriceCard] Native share failed, falling back to download:', error);
    }
  }
  downloadBlob(blob, fileName);
  return 'downloaded';
}

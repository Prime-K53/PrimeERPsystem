// ─── Customer Portal Banner Image Service (ERP side) ─────────────────────────
// Mirrors the backend bannerImageService spec so the ERP UI can validate,
// interactively crop to 3:1 or 5:2, and prepare a banner before it is uploaded.
// The canonical ratios are enforced on the actual asset — never by CSS
// stretching — and the server re-validates everything on upload.

import type { PortalAdImageMeta } from '../types/ads';

export const BANNER_SPEC = {
  bannerType: 'customer_portal_banner',
  targetRatio: 3,
  /** Accepted aspect ratios (width / height): 3:1 and 5:2. */
  acceptedRatios: [3, 2.5],
  recommendedWidth: 1500,
  recommendedHeight: 500,
  minWidth: 1200,
  minHeight: 400,
  maxBytes: 2 * 1024 * 1024, // ~2 MB for web delivery
  outputFormat: 'webp',
  outputQuality: 0.92,
  allowedMime: /^image\/(png|jpe?g|webp)$/i,
  aspectTolerance: 0.02, // UI crop rounding drift treated as conformant
} as const;

/** Per-ratio output canvas + minimum size. 3:1 stays the default/primary class. */
export const BANNER_RATIOS = [
  { ratio: 3, label: '3:1', width: 1500, height: 500, minWidth: 1200, minHeight: 400 },
  { ratio: 2.5, label: '5:2', width: 1500, height: 600, minWidth: 1200, minHeight: 480 },
] as const;

export type BannerAcceptedRatio = (typeof BANNER_RATIOS)[number]['ratio'];

export type BannerValidationErrorCode = 'TYPE' | 'SIZE' | 'SMALL' | 'LOAD';

export interface BannerValidationResult {
  ok: boolean;
  error?: string;
  code?: BannerValidationErrorCode;
  /** Source width in px (orientation-normalized). */
  width?: number;
  /** Source height in px (orientation-normalized). */
  height?: number;
  /** width / height of the source. */
  ratio?: number;
  /** True when the source is already 3:1 or 5:2 (within tolerance) — no crop needed. */
  conformant?: boolean;
  /** True when the source must be cropped to the target ratio class before upload. */
  needsCrop?: boolean;
  /** Ratio class the asset will be prepared as (matched class, else nearest). */
  ratioClass?: BannerAcceptedRatio;
  /** Final prepared asset size for the ratio class. */
  output?: { width: number; height: number };
}

export const BANNER_ERROR_MESSAGES: Record<BannerValidationErrorCode, string> = {
  TYPE: 'Unsupported file type. Accepted formats: WebP, JPG, PNG.',
  SIZE: 'Image is too large — the maximum size is 2 MB.',
  SMALL: `Image is too small. Minimum acceptable: ${BANNER_SPEC.minWidth} × ${BANNER_SPEC.minHeight} px (3:1) or 1200 × 480 px (5:2).`,
  LOAD: 'The file could not be read as an image.',
};

/** Client-side file gate (type + size) before the image is even decoded. */
export function validateBannerFile(file: File | null | undefined): BannerValidationResult {
  if (!file) return { ok: false, code: 'LOAD', error: BANNER_ERROR_MESSAGES.LOAD };
  if (!BANNER_SPEC.allowedMime.test(file.type || '')) {
    return { ok: false, code: 'TYPE', error: BANNER_ERROR_MESSAGES.TYPE };
  }
  if (file.size > BANNER_SPEC.maxBytes) {
    return { ok: false, code: 'SIZE', error: BANNER_ERROR_MESSAGES.SIZE };
  }
  return { ok: true };
}

/** True when width/height match 3:1 or 5:2 within the given tolerance (default spec). */
export function aspectConformance(width: number, height: number, tolerance = BANNER_SPEC.aspectTolerance): boolean {
  if (!width || !height) return false;
  const ratio = width / height;
  return BANNER_SPEC.acceptedRatios.some((t) => Math.abs(ratio - t) <= tolerance);
}

/** Display label for an accepted ratio ('3:1' / '5:2'). */
export function ratioLabel(ratio: number): string {
  const found = BANNER_RATIOS.find((r) => r.ratio === ratio);
  if (found) return found.label;
  return `${ratio}:1`;
}

/** Nearest accepted ratio class for arbitrary dimensions (used for crop default + output). */
export function nearestRatio(width: number, height: number): BannerAcceptedRatio {
  if (!width || !height) return BANNER_SPEC.targetRatio as BannerAcceptedRatio;
  const ratio = width / height;
  let best: BannerAcceptedRatio = BANNER_SPEC.targetRatio as BannerAcceptedRatio;
  let bestDist = Infinity;
  for (const r of BANNER_RATIOS) {
    const dist = Math.abs(ratio - r.ratio);
    if (dist < bestDist) {
      bestDist = dist;
      best = r.ratio;
    }
  }
  return best;
}

/** Accepted ratio class the dimensions conform to, or null when neither matches. */
export function matchedRatio(width: number, height: number, tolerance = BANNER_SPEC.aspectTolerance): BannerAcceptedRatio | null {
  if (!width || !height) return null;
  const ratio = width / height;
  let best: BannerAcceptedRatio | null = null;
  let bestDist = Infinity;
  for (const r of BANNER_RATIOS) {
    const dist = Math.abs(ratio - r.ratio);
    if (dist <= tolerance && dist < bestDist) {
      bestDist = dist;
      best = r.ratio;
    }
  }
  return best;
}

/** Recommended output canvas for a ratio class. */
export function outputForRatio(ratio: number): { width: number; height: number } {
  const found = BANNER_RATIOS.find((r) => r.ratio === ratio);
  if (found) return { width: found.width, height: found.height };
  return { width: BANNER_SPEC.recommendedWidth, height: BANNER_SPEC.recommendedHeight };
}

/**
 * Largest region of the given ratio class that fits inside a source without
 * upscaling, or null when the source has no usable dimensions.
 */
export function largestRatioRegion(width: number, height: number, ratio: number = BANNER_SPEC.targetRatio): { width: number; height: number } | null {
  if (!width || !height || width <= 0 || height <= 0) return null;
  if (width / height >= ratio) {
    const cropW = Math.min(Math.round(height * ratio), width);
    return { width: cropW, height: Math.round(cropW / ratio) };
  }
  const cropH = Math.min(Math.round(width / ratio), height);
  return { width: Math.round(cropH * ratio), height: cropH };
}

/**
 * Largest 3:1 region that fits inside a source without upscaling, or null
 * when the source is too small to ever produce a valid banner.
 * (Kept for backwards compatibility — prefers largestRatioRegion.)
 */
export function largestFourToOneRegion(width: number, height: number): { width: number; height: number } | null {
  return largestRatioRegion(width, height, BANNER_SPEC.targetRatio);
}

/**
 * Structural validation of decoded image dimensions:
 * minimum size gate (the largest possible crop in at least one accepted ratio
 * class must meet that class minimum), conformance (already 3:1/5:2 or needs
 * cropping), and the final output size for the ratio class.
 */
export function buildBannerValidation(width: number, height: number): BannerValidationResult {
  if (!width || !height) {
    return { ok: false, code: 'LOAD', error: BANNER_ERROR_MESSAGES.LOAD };
  }
  const fits = BANNER_RATIOS.some((r) => {
    const region = largestRatioRegion(width, height, r.ratio);
    return !!region && region.width >= r.minWidth && region.height >= r.minHeight;
  });
  if (!fits) {
    const smallest = BANNER_RATIOS[0];
    return {
      ok: false,
      code: 'SMALL',
      error: `Image is too small (${width} × ${height} px). Minimum acceptable: ${smallest.minWidth} × ${smallest.minHeight} px (3:1) or ${BANNER_RATIOS[1].minWidth} × ${BANNER_RATIOS[1].minHeight} px (5:2).`,
    };
  }
  const ratioClass = matchedRatio(width, height) ?? nearestRatio(width, height);
  return {
    ok: true,
    width,
    height,
    ratio: width / height,
    conformant: aspectConformance(width, height),
    needsCrop: !aspectConformance(width, height),
    ratioClass,
    output: outputForRatio(ratioClass),
  };
}

/** Decode an image blob into an orientation-normalized HTMLImageElement.
 *  Returns both the element and the still-live blob URL so the caller can
 *  display the image and revoke the URL when it is no longer needed.
 */
export function loadImageFile(file: Blob): Promise<{ img: HTMLImageElement; blobUrl: string }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, blobUrl: url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(BANNER_ERROR_MESSAGES.LOAD)); };
    img.src = url;
  });
}

/** Load an image from a URL (CORS-clean so it can be drawn to a canvas). */
export function loadImageUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not load the image (${url})`));
    img.src = url;
  });
}

/** Read natural dimensions from a URL (used to flag legacy non-3:1 banners). */
export function getImageDimensions(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error(`Could not load the image (${url})`));
    img.src = url;
  });
}

// ── Interactive crop math (pure — unit tested) ───────────────────────────────

export interface CropTransform {
  /** Display scale of the image inside the stage. */
  scale: number;
  /** Pan offset from the centered position (display px). */
  panX: number;
  /** Pan offset from the centered position (display px). */
  panY: number;
}

/** Minimum scale so the image fully covers the fixed 3:1 crop window. */
export function coverTransform(srcW: number, srcH: number, winW: number, winH: number): CropTransform {
  const scale = Math.max(winW / srcW, winH / srcH);
  return { scale, panX: 0, panY: 0 };
}

/** Clamp pan so the image always covers the crop window. */
export function clampPan(panX: number, panY: number, scale: number, srcW: number, srcH: number, winW: number, winH: number): { panX: number; panY: number } {
  const maxX = Math.max(0, (srcW * scale - winW) / 2);
  const maxY = Math.max(0, (srcH * scale - winH) / 2);
  return {
    panX: Math.max(-maxX, Math.min(maxX, panX)),
    panY: Math.max(-maxY, Math.min(maxY, panY)),
  };
}

/**
 * Source-pixel crop rectangle implied by the current transform and the
 * fixed crop window. Window is centered in the stage, image origin is
 * stage center − image size/2 + pan.
 */
export function cropRectFromTransform(
  t: CropTransform,
  srcW: number,
  srcH: number,
  winW: number,
  winH: number,
): { x: number; y: number; width: number; height: number } {
  const imgW = srcW * t.scale;
  const imgH = srcH * t.scale;
  const originX = winW / 2 - imgW / 2 + t.panX;
  const originY = winH / 2 - imgH / 2 + t.panY;
  const x = (0 - originX) / t.scale;
  const y = (0 - originY) / t.scale;
  const width = winW / t.scale;
  const height = winH / t.scale;
  const maxX = Math.max(0, srcW - width);
  const maxY = Math.max(0, srcH - height);
  return {
    x: Math.max(0, Math.min(x, maxX)),
    y: Math.max(0, Math.min(y, maxY)),
    width: Math.min(width, srcW),
    height: Math.min(height, srcH),
  };
}

// ── Canvas processing ────────────────────────────────────────────────────────

/** Renders a source crop region onto the final banner canvas (default 1500 × 500). */
export function renderBannerCanvas(
  image: HTMLImageElement,
  src: { x: number; y: number; width: number; height: number },
  output: { width: number; height: number } = { width: BANNER_SPEC.recommendedWidth, height: BANNER_SPEC.recommendedHeight },
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = output.width;
  canvas.height = output.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is not available in this browser');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, src.x, src.y, src.width, src.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** toBlob('image/webp') wrapper with PNG fallback for mobile browsers where
 *  canvas.toBlob('image/webp') silently returns null. */
export function canvasToWebPBlob(canvas: HTMLCanvasElement, quality = BANNER_SPEC.outputQuality): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) return resolve(blob);
      // WebP encoding failed (common on some mobile browsers) — fall back to PNG.
      canvas.toBlob((pngBlob) => {
        if (pngBlob) return resolve(pngBlob);
        reject(new Error('Could not encode the banner as WebP or PNG. Try a different image.'));
      }, 'image/png', 0.92);
    }, `image/${BANNER_SPEC.outputFormat}`, quality);
  });
}

/**
 * Prepares a conformant (already 3:1 or 5:2) source: crops to the largest
 * region of its ratio class (a no-op for exact-ratio sources, covers tiny
 * rounding drift), scales to that class's recommended canvas and encodes as
 * WebP. Never stretches.
 */
export async function prepareBannerBlob(image: HTMLImageElement, ratio?: number): Promise<Blob> {
  const ratioClass = ratio ?? matchedRatio(image.naturalWidth, image.naturalHeight) ?? nearestRatio(image.naturalWidth, image.naturalHeight);
  const region = largestRatioRegion(image.naturalWidth, image.naturalHeight, ratioClass) || {
    width: image.naturalWidth,
    height: image.naturalHeight,
  };
  const offsetX = Math.max(0, Math.round((image.naturalWidth - region.width) / 2));
  const offsetY = Math.max(0, Math.round((image.naturalHeight - region.height) / 2));
  const canvas = renderBannerCanvas(image, { x: offsetX, y: offsetY, width: region.width, height: region.height }, outputForRatio(ratioClass));
  return canvasToWebPBlob(canvas);
}

/** Builds the final `File` uploaded to POST /ads/upload.
 *  Uses the blob's actual MIME type (webp or png) so the backend
 *  sharp library receives a file it can actually decode. */
export function preparedBannerFile(blob: Blob): File {
  const actualType = blob.type || `image/${BANNER_SPEC.outputFormat}`;
  const extension = actualType === 'image/png' ? 'png' : 'webp';
  return new File([blob], `banner.${extension}`, { type: actualType });
}

/** Formats bytes for the preview UI (e.g. "412 KB"). */
export function formatBannerBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** True when stored metadata describes a conformant (3:1 or 5:2) banner. */
export function isConformantMeta(meta: PortalAdImageMeta | undefined | null): boolean {
  if (!meta || !meta.width || !meta.height) return false;
  return aspectConformance(meta.width, meta.height);
}

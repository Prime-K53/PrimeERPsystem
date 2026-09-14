import { describe, it, expect } from 'vitest';
import {
  BANNER_RATIOS,
  BANNER_SPEC,
  aspectConformance,
  buildBannerValidation,
  clampPan,
  coverTransform,
  cropRectFromTransform,
  formatBannerBytes,
  isConformantMeta,
  largestFourToOneRegion,
  largestRatioRegion,
  matchedRatio,
  nearestRatio,
  outputForRatio,
  preparedBannerFile,
  ratioLabel,
  validateBannerFile,
} from '../../services/bannerImage';

const makeFile = (name: string, type: string, size: number): File =>
  new File([new Uint8Array(size)], name, { type });

describe('bannerImage (customer_portal_banner spec)', () => {
  it('declares the canonical 3:1 spec', () => {
    expect(BANNER_SPEC.bannerType).toBe('customer_portal_banner');
    expect(BANNER_SPEC.targetRatio).toBe(3);
    expect(BANNER_SPEC.recommendedWidth).toBe(1500);
    expect(BANNER_SPEC.recommendedHeight).toBe(500);
    expect(BANNER_SPEC.minWidth).toBe(1200);
    expect(BANNER_SPEC.minHeight).toBe(400);
    expect(BANNER_SPEC.maxBytes).toBe(2 * 1024 * 1024);
    expect(BANNER_SPEC.outputFormat).toBe('webp');
  });

  it('accepts 3:1 and 5:2 ratio classes', () => {
    expect(BANNER_SPEC.acceptedRatios).toContain(3);
    expect(BANNER_SPEC.acceptedRatios).toContain(2.5);
    expect(BANNER_RATIOS).toEqual([
      { ratio: 3, label: '3:1', width: 1500, height: 500, minWidth: 1200, minHeight: 400 },
      { ratio: 2.5, label: '5:2', width: 1500, height: 600, minWidth: 1200, minHeight: 480 },
    ]);
  });

  describe('validateBannerFile', () => {
    it('accepts WebP, JPG and PNG', () => {
      expect(validateBannerFile(makeFile('a.webp', 'image/webp', 100)).ok).toBe(true);
      expect(validateBannerFile(makeFile('a.jpg', 'image/jpeg', 100)).ok).toBe(true);
      expect(validateBannerFile(makeFile('a.png', 'image/png', 100)).ok).toBe(true);
    });

    it('rejects unsupported file types with a clear error', () => {
      const gif = validateBannerFile(makeFile('a.gif', 'image/gif', 100));
      expect(gif.ok).toBe(false);
      expect(gif.code).toBe('TYPE');
      const avif = validateBannerFile(makeFile('a.avif', 'image/avif', 100));
      expect(avif.code).toBe('TYPE');
      const txt = validateBannerFile(makeFile('a.txt', 'text/plain', 100));
      expect(txt.code).toBe('TYPE');
      const pdf = validateBannerFile(makeFile('a.pdf', 'application/pdf', 100));
      expect(pdf.code).toBe('TYPE');
    });

    it('rejects oversized files (> 2 MB)', () => {
      const big = validateBannerFile(makeFile('big.jpg', 'image/jpeg', 2 * 1024 * 1024 + 1));
      expect(big.ok).toBe(false);
      expect(big.code).toBe('SIZE');
    });

    it('accepts a file of exactly 2 MB', () => {
      expect(validateBannerFile(makeFile('ok.jpg', 'image/jpeg', 2 * 1024 * 1024)).ok).toBe(true);
    });

    it('rejects no-file', () => {
      expect(validateBannerFile(null).ok).toBe(false);
    });
  });

  describe('aspectConformance', () => {
    it('recognizes 3:1 sources', () => {
      expect(aspectConformance(1500, 500)).toBe(true);   // exact recommended
      expect(aspectConformance(1200, 400)).toBe(true);   // exact minimum
      expect(aspectConformance(1800, 600)).toBe(true);   // larger 3:1
      expect(aspectConformance(2000, 667)).toBe(true);   // within 2% tolerance
    });

    it('recognizes 5:2 sources', () => {
      expect(aspectConformance(1500, 600)).toBe(true);   // exact recommended
      expect(aspectConformance(1200, 480)).toBe(true);   // exact minimum
      expect(aspectConformance(1250, 500)).toBe(true);   // exact 5:2
      expect(aspectConformance(2000, 800)).toBe(true);   // larger 5:2
    });

    it('rejects sources matching neither ratio', () => {
      expect(aspectConformance(1600, 400)).toBe(false);  // 4:1
      expect(aspectConformance(1500, 750)).toBe(false);  // 2:1
      expect(aspectConformance(1200, 1200)).toBe(false); // 1:1
      expect(aspectConformance(800, 150)).toBe(false);   // ~5.3:1
    });
  });

  describe('ratio helpers', () => {
    it('nearestRatio picks the closest accepted class', () => {
      expect(nearestRatio(1500, 500)).toBe(3);
      expect(nearestRatio(1500, 600)).toBe(2.5);
      expect(nearestRatio(1500, 750)).toBe(2.5);   // 2:1 → nearer 5:2
      expect(nearestRatio(1600, 400)).toBe(3);     // 4:1 → nearer 3:1
      expect(nearestRatio(1200, 1200)).toBe(2.5);  // 1:1 → nearer 5:2
    });

    it('matchedRatio returns the conformant class or null', () => {
      expect(matchedRatio(1500, 500)).toBe(3);
      expect(matchedRatio(1500, 600)).toBe(2.5);
      expect(matchedRatio(1200, 1200)).toBeNull();
    });

    it('ratioLabel renders 3:1 / 5:2', () => {
      expect(ratioLabel(3)).toBe('3:1');
      expect(ratioLabel(2.5)).toBe('5:2');
    });

    it('outputForRatio returns the class canvas', () => {
      expect(outputForRatio(3)).toEqual({ width: 1500, height: 500 });
      expect(outputForRatio(2.5)).toEqual({ width: 1500, height: 600 });
    });

    it('largestRatioRegion crops to the requested class', () => {
      expect(largestRatioRegion(1500, 600, 2.5)).toEqual({ width: 1500, height: 600 });
      expect(largestRatioRegion(1500, 500, 2.5)).toEqual({ width: 1250, height: 500 });
      expect(largestRatioRegion(1200, 1200, 2.5)).toEqual({ width: 1200, height: 480 });
    });
  });

  describe('largestFourToOneRegion', () => {
    it('finds the largest 3:1 region without upscaling', () => {
      // Exact 3:1 — unchanged.
      expect(largestFourToOneRegion(1500, 500)).toEqual({ width: 1500, height: 500 });
      expect(largestFourToOneRegion(1800, 600)).toEqual({ width: 1800, height: 600 });
      // Too tall — crop height.
      expect(largestFourToOneRegion(1500, 750)).toEqual({ width: 1500, height: 500 });
      // Square 1200×1200 — crop height: floor(1200/3)=400 → {1200, 400}.
      expect(largestFourToOneRegion(1200, 1200)).toEqual({ width: 1200, height: 400 });
      // Small square.
      expect(largestFourToOneRegion(400, 400)).toEqual({ width: 399, height: 133 });
      // Wider than 3:1 (3000×500) — crop width: 500*3=1500 → {1500, 500}.
      expect(largestFourToOneRegion(3000, 500)).toEqual({ width: 1500, height: 500 });
      // Zero dimensions.
      expect(largestFourToOneRegion(0, 0)).toBeNull();
    });
  });

  describe('buildBannerValidation', () => {
    it('accepts exact-recommended 1500 × 500 without cropping', () => {
      const r = buildBannerValidation(1500, 500);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(true);
      expect(r.needsCrop).toBe(false);
      expect(r.output).toEqual({ width: 1500, height: 500 });
    });

    it('accepts minimum 1200 × 400 without cropping', () => {
      const r = buildBannerValidation(1200, 400);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(true);
    });

    it('accepts larger 3:1 1800 × 600 without cropping', () => {
      const r = buildBannerValidation(1800, 600);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(true);
    });

    it('accepts exact 5:2 1500 × 600 without cropping', () => {
      const r = buildBannerValidation(1500, 600);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(true);
      expect(r.needsCrop).toBe(false);
      expect(r.ratioClass).toBe(2.5);
      expect(r.output).toEqual({ width: 1500, height: 600 });
    });

    it('accepts minimum 5:2 1200 × 480 without cropping', () => {
      const r = buildBannerValidation(1200, 480);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(true);
      expect(r.ratioClass).toBe(2.5);
    });

    it('requires a crop for 1500 × 750 (2:1) targeting the nearest 5:2 class', () => {
      const r = buildBannerValidation(1500, 750);
      expect(r.ok).toBe(true);
      expect(r.conformant).toBe(false);
      expect(r.needsCrop).toBe(true);
      expect(r.ratioClass).toBe(2.5);
      expect(r.output).toEqual({ width: 1500, height: 600 });
    });

    it('requires a crop for 1600 × 400 (4:1) targeting the nearest 3:1 class', () => {
      const r = buildBannerValidation(1600, 400);
      expect(r.ok).toBe(true);   // large enough: largestRegion(1600,400,3)={1200,400} ≥ min
      expect(r.conformant).toBe(false);
      expect(r.needsCrop).toBe(true);
      expect(r.ratioClass).toBe(3);
      expect(r.output).toEqual({ width: 1500, height: 500 });
    });

    it('requires a crop for 1200 × 1200 targeting the nearest 5:2 class', () => {
      const r = buildBannerValidation(1200, 1200);
      expect(r.ok).toBe(true);
      expect(r.needsCrop).toBe(true);
      expect(r.ratioClass).toBe(2.5);
      expect(r.output).toEqual({ width: 1500, height: 600 });
    });

    it('rejects a very small image (400 × 400) with a clear error', () => {
      const r = buildBannerValidation(400, 400);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('SMALL');
      expect(r.error).toMatch(/too small/i);
    });

    it('rejects a very small 3:1 image (1000 × 334) — region height 333 < 400', () => {
      const r = buildBannerValidation(1000, 334);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('SMALL');
    });

    it('rejects 1200 × 399 (below minimum height after crop normalization)', () => {
      const r = buildBannerValidation(1200, 399);
      expect(r.ok).toBe(false);
      expect(r.code).toBe('SMALL');
    });
  });

  describe('crop math', () => {
    it('coverTransform fits the window without distortion', () => {
      // 3:1 crop window: 300 × 100. Source: 1200 × 400 (3:1).
      const t = coverTransform(1200, 400, 300, 100);
      expect(t.scale).toBeCloseTo(300 / 1200);
      expect(t.panX).toBe(0);
      expect(t.panY).toBe(0);
    });

    it('clampPan keeps the image covering the window', () => {
      // 900 × 300 at scale 1/3 = 300 × 100 — exactly the window, no pan allowed.
      expect(clampPan(250, 250, 1 / 3, 900, 300, 300, 100)).toEqual({ panX: 0, panY: 0 });
      // Zoomed 2× (600 × 200 display) → 150 px of play on X, 50 on Y.
      expect(clampPan(500, -500, 2 / 3, 900, 300, 300, 100)).toEqual({ panX: 150, panY: -50 });
    });

    it('cropRectFromTransform maps the window back to source pixels', () => {
      // 3:1 window: 300 × 100. Source: 1200 × 400 (3:1). Scale 0.25.
      // imgW=300, imgH=100. originX=0, originY=0. x=0, y=0, w=1200, h=400.
      const src = cropRectFromTransform({ scale: 0.25, panX: 0, panY: 0 }, 1200, 400, 300, 100);
      expect(src.width).toBe(1200);
      expect(src.height).toBe(400);
      expect(src.x).toBe(0);
      expect(src.y).toBe(0);
    });

    it('cropRectFromTransform clamps pan to the source bounds', () => {
      // 900 × 300 at scale 1/3 = 300 × 100 — exactly window, no pan allowed.
      const src = cropRectFromTransform({ scale: 1 / 3, panX: 9999, panY: -9999 }, 900, 300, 300, 100);
      expect(src.x).toBe(0);
      expect(src.y).toBe(0);
      expect(src.width).toBe(900);
      expect(src.height).toBe(300);
    });
  });

  describe('metadata helpers', () => {
    it('isConformantMeta accepts 3:1 or 5:2 metadata only', () => {
      expect(isConformantMeta({ bannerType: 'customer_portal_banner', width: 1500, height: 500, aspectRatio: 3, format: 'webp', fileSize: 100 })).toBe(true);
      expect(isConformantMeta({ bannerType: 'customer_portal_banner', width: 1500, height: 600, aspectRatio: 2.5, format: 'webp', fileSize: 100 })).toBe(true);
      expect(isConformantMeta({ bannerType: 'customer_portal_banner', width: 1600, height: 400, aspectRatio: 4, format: 'webp', fileSize: 100 })).toBe(false);
      expect(isConformantMeta(null)).toBe(false);
      expect(isConformantMeta(undefined)).toBe(false);
    });

    it('formatBannerBytes renders friendly sizes', () => {
      expect(formatBannerBytes(512)).toBe('512 B');
      expect(formatBannerBytes(2048)).toBe('2 KB');
      expect(formatBannerBytes(2.5 * 1024 * 1024)).toBe('2.50 MB');
    });

    it('preparedBannerFile is a WebP upload', () => {
      const f = preparedBannerFile(new Blob([new Uint8Array(8)], { type: 'image/webp' }));
      expect(f.type).toBe('image/webp');
      expect(f.name).toBe('banner.webp');
    });
  });
});
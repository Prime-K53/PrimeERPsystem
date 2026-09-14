// ─── bannerImageService unit tests ───────────────────────────────────────────
// Verifies the customer_portal_banner preparation pipeline: every accepted
// banner becomes an exact-ratio WebP (3:1 at 1500 × 500, or 5:2 at
// 1500 × 600 — never stretched), while unsuitable files are rejected with
// clear errors.

const sharp = require('sharp');
const crypto = require('crypto');
const {
  BANNER_SPEC,
  BANNER_RATIOS,
  BannerImageError,
  processBannerImage,
  largestFourToOneRegion,
  largestRatioRegion,
  nearestRatio,
} = require('../../services/bannerImageService.cjs');

/** Solid-color test image. */
async function makeSolid(width, height, format = 'jpeg', color = { r: 40, g: 120, b: 90 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .toFormat(format)
    .toBuffer();
}

/** Random-noise test image (incompressible → predictable file sizes). */
async function makeNoise(width, height, format = 'png') {
  const data = crypto.randomBytes(width * height * 3);
  return sharp(data, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer();
}

/** Image with a flat dark top and a noisy bright band at the bottom. */
async function makeBottomContent(width, height, bandHeight) {
  const data = Buffer.alloc(width * height * 3);
  const flatStart = height - bandHeight;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      if (y >= flatStart) {
        const v = 200 + Math.floor(Math.random() * 56);
        data[i] = v; data[i + 1] = v; data[i + 2] = v;
      } else {
        data[i] = 10; data[i + 1] = 10; data[i + 2] = 10;
      }
    }
  }
  return sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

async function decodeMean(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  return sum / data.length;
}

describe('bannerImageService (customer_portal_banner)', () => {
  describe('spec', () => {
    it('declares the canonical 3:1 customer portal banner spec', () => {
      expect(BANNER_SPEC.bannerType).toBe('customer_portal_banner');
      expect(BANNER_SPEC.targetRatio).toBe(3);
      expect(BANNER_SPEC.recommendedWidth).toBe(1500);
      expect(BANNER_SPEC.recommendedHeight).toBe(500);
      expect(BANNER_SPEC.minWidth).toBe(1200);
      expect(BANNER_SPEC.minHeight).toBe(400);
      expect(BANNER_SPEC.outputFormat).toBe('webp');
    });

    it('accepts 3:1 and 5:2 ratio classes', () => {
      expect(BANNER_SPEC.acceptedRatios).toContain(3);
      expect(BANNER_SPEC.acceptedRatios).toContain(2.5);
      expect(BANNER_RATIOS).toEqual([
        { ratio: 3, label: '3:1', width: 1500, height: 500, minWidth: 1200, minHeight: 400 },
        { ratio: 2.5, label: '5:2', width: 1500, height: 600, minWidth: 1200, minHeight: 480 },
      ]);
      expect(nearestRatio(1500, 600)).toBe(2.5);
      expect(nearestRatio(1500, 750)).toBe(2.5);
      expect(nearestRatio(1600, 400)).toBe(3);
      expect(largestRatioRegion(1200, 1200, 2.5)).toEqual({ width: 1200, height: 480 });
    });

    it('largestFourToOneRegion finds the biggest 3:1 region without upscaling', () => {
      // Exact 3:1 sources — returned unchanged.
      expect(largestFourToOneRegion(1500, 500)).toEqual({ width: 1500, height: 500 });
      expect(largestFourToOneRegion(1800, 600)).toEqual({ width: 1800, height: 600 });
      // Wider than 3:1 — height drives the crop.
      expect(largestFourToOneRegion(1500, 400)).toEqual({ width: 1200, height: 400 });
      // Taller than 3:1 — width drives the crop.
      expect(largestFourToOneRegion(1500, 750)).toEqual({ width: 1500, height: 500 });
      // Square — height drives crop: 1200 × 400.
      expect(largestFourToOneRegion(1200, 1200)).toEqual({ width: 1200, height: 400 });
      // Very small square.
      expect(largestFourToOneRegion(400, 400)).toEqual({ width: 399, height: 133 });
    });
  });

  describe('conforming uploads (already an accepted ratio)', () => {
    it.each([
      [1500, 500, '1500 × 500 — exact recommended'],
      [1200, 400, '1200 × 400 — exact minimum'],
      [1800, 600, '1800 × 600 — larger 3:1 downscaled'],
    ])('%s → prepared as exact 3:1 1500 × 500 WebP', async (w, h) => {
      const { buffer, meta } = await processBannerImage(await makeSolid(w, h, 'jpeg'));
      expect(meta.bannerType).toBe('customer_portal_banner');
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(1500);
      expect(meta.height).toBe(500);
      expect(meta.aspectRatio).toBe(3);
      expect(meta.fileSize).toBe(buffer.length);
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.length).toBeLessThanOrEqual(BANNER_SPEC.maxBytes);

      const outMeta = await sharp(buffer).metadata();
      expect(outMeta.format).toBe('webp');
      expect(outMeta.width).toBe(1500);
      expect(outMeta.height).toBe(500);
      // Never stretched: stored asset is exactly 3:1.
      expect(outMeta.width / outMeta.height).toBe(3);
    });

    it.each([
      [1500, 600, '1500 × 600 — exact recommended 5:2'],
      [1200, 480, '1200 × 480 — exact minimum 5:2'],
      [1250, 500, '1250 × 500 — exact 5:2 upscaled'],
    ])('%s → prepared as exact 5:2 1500 × 600 WebP', async (w, h) => {
      const { buffer, meta } = await processBannerImage(await makeSolid(w, h, 'jpeg'));
      expect(meta.bannerType).toBe('customer_portal_banner');
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(1500);
      expect(meta.height).toBe(600);
      expect(meta.aspectRatio).toBe(2.5);
      expect(meta.fileSize).toBe(buffer.length);
      expect(buffer.length).toBeGreaterThan(0);
      expect(buffer.length).toBeLessThanOrEqual(BANNER_SPEC.maxBytes);

      const outMeta = await sharp(buffer).metadata();
      expect(outMeta.format).toBe('webp');
      expect(outMeta.width).toBe(1500);
      expect(outMeta.height).toBe(600);
      // Never stretched: stored asset is exactly 5:2.
      expect(outMeta.width / outMeta.height).toBe(2.5);
    });
  });

  describe('non-conforming uploads (cropped to the nearest ratio class)', () => {
    it('1500 × 750 (2:1, nearest 5:2) → cropped to 1500 × 600, never stretched', async () => {
      const { buffer, meta } = await processBannerImage(await makeSolid(1500, 750, 'jpeg'));
      expect(meta.width).toBe(1500);
      expect(meta.height).toBe(600);
      expect(meta.aspectRatio).toBe(2.5);
    });

    it('1200 × 1200 (square, nearest 5:2) → cropped to 1500 × 600, never stretched', async () => {
      const { buffer, meta } = await processBannerImage(await makeSolid(1200, 1200, 'jpeg'));
      expect(meta.width).toBe(1500);
      expect(meta.height).toBe(600);
      expect(meta.aspectRatio).toBe(2.5);
    });

    it('preserves content: crop window lands on the content band', async () => {
      // Content (bright noisy band) occupies the bottom 400 rows of 1200 × 1200.
      const src = await makeBottomContent(1200, 1200, 400);
      const { buffer } = await processBannerImage(src);
      const mean = await decodeMean(buffer);
      // If the crop window missed the content band we'd get ~10 (flat dark).
      expect(mean).toBeGreaterThan(150);
    });

    it('PNG upload is accepted and converted to WebP', async () => {
      const { buffer, meta } = await processBannerImage(await makeSolid(1500, 500, 'png'));
      expect(meta.format).toBe('webp');
      const outMeta = await sharp(buffer).metadata();
      expect(outMeta.format).toBe('webp');
    });
  });

  describe('rejections with clear feedback', () => {
    it('very small image (400 × 400) → IMAGE_TOO_SMALL', async () => {
      const src = await makeSolid(400, 400, 'jpeg');
      await expect(processBannerImage(src)).rejects.toThrowError(BannerImageError);
      await expect(processBannerImage(src)).rejects.toMatchObject({ code: 'IMAGE_TOO_SMALL' });
    });

    it('very small 3:1 image (1000 × 334) → IMAGE_TOO_SMALL (region height < 400)', async () => {
      // largestFourToOneRegion(1000, 334) → { width: 1000, height: 333 } — 333 < minHeight 400
      const src = await makeSolid(1000, 334, 'jpeg');
      await expect(processBannerImage(src)).rejects.toMatchObject({ code: 'IMAGE_TOO_SMALL' });
    });

    it('unsupported file type (GIF) → UNSUPPORTED_TYPE even if renamed', async () => {
      const src = await makeSolid(800, 267, 'gif');
      await expect(processBannerImage(src)).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    });

    it('unsupported file type (AVIF) → UNSUPPORTED_TYPE', async () => {
      const src = await makeSolid(800, 267, 'avif');
      await expect(processBannerImage(src)).rejects.toMatchObject({ code: 'UNSUPPORTED_TYPE' });
    });

    it('not an image (text bytes) → INVALID_IMAGE', async () => {
      await expect(processBannerImage(Buffer.from('definitely not an image')))
        .rejects.toMatchObject({ code: 'INVALID_IMAGE' });
    });

    it('oversized file (> 2 MB) → FILE_TOO_LARGE', async () => {
      const src = await makeNoise(1000, 1000, 'png'); // random data ≈ 3 MB
      expect(src.length).toBeGreaterThan(BANNER_SPEC.maxBytes);
      await expect(processBannerImage(src)).rejects.toMatchObject({ code: 'FILE_TOO_LARGE' });
    });

    it('empty buffer → NO_IMAGE', async () => {
      await expect(processBannerImage(Buffer.alloc(0))).rejects.toMatchObject({ code: 'NO_IMAGE' });
    });
  });

  describe('orientation handling', () => {
    it('EXIF-rotated source (orientation 6) is normalized to landscape 3:1', async () => {
      // Raw portrait bytes 500 × 1500 tagged orientation 6 → displays as 1500 × 500 (exact 3:1).
      const data = Buffer.alloc(500 * 1500 * 3);
      for (let y = 0; y < 1500; y++) {
        for (let x = 0; x < 500; x++) {
          const i = (y * 500 + x) * 3;
          data[i] = x < 250 ? 200 : 30; data[i + 1] = 30; data[i + 2] = 30;
        }
      }
      const base = await sharp(data, { raw: { width: 500, height: 1500, channels: 3 } })
        .withMetadata({ orientation: 6 })
        .jpeg()
        .toBuffer();

      const rawMeta = await sharp(base).metadata();
      expect(rawMeta.width).toBe(500);
      expect(rawMeta.height).toBe(1500);
      expect(rawMeta.orientation).toBe(6);

      const { meta } = await processBannerImage(base);
      expect(meta.width).toBe(1500);
      expect(meta.height).toBe(500);
      expect(meta.aspectRatio).toBe(3);
    });
  });

  describe('never stretches', () => {
    it.each([
      [1500, 500, 1500, 500],   // exact recommended 3:1
      [1200, 400, 1500, 500],   // exact minimum 3:1
      [1800, 600, 1500, 500],   // larger 3:1
      [1500, 600, 1500, 600],   // exact recommended 5:2 — conformant
      [1250, 500, 1500, 600],   // exact 5:2 — conformant
      [1500, 750, 1500, 600],   // too tall — cropped to nearest 5:2
      [1200, 1200, 1500, 600],  // square — cropped to nearest 5:2
      [1600, 400, 1500, 500],   // 4:1 — cropped to nearest 3:1
      [2000, 667, 1500, 500],   // approx 3:1 (within tolerance) — conformant
    ])(
      '%s × %s → output is exactly the ratio class canvas',
      async (w, h, outW, outH) => {
        const { buffer } = await processBannerImage(await makeSolid(w, h, 'jpeg'));
        const outMeta = await sharp(buffer).metadata();
        expect(outMeta.width).toBe(outW);
        expect(outMeta.height).toBe(outH);
        expect(outMeta.width / outMeta.height).toBe(outW / outH);
      }
    );
  });
});

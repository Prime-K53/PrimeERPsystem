/**
 * companyAssetGrayscale.test.ts — B/W print logo proof.
 *
 * The mono print pipeline embeds a canvas-grayscaled copy of the company
 * logo so the logo prints in black & white instead of color. This drives
 * convertImageDataUrlToGrayscale with a mocked Image/canvas pair and
 * asserts the luminance math on real pixels (pure red -> 76, pure blue
 * -> 29) plus the withGrayscaleLogoForPrint wiring (both logo fields
 * stamped, QR/signatures untouched, SSR-safe fallback).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  convertImageDataUrlToGrayscale,
  withGrayscaleLogoForPrint,
  normalizeImageDataUrl,
} from '../../utils/companyAssetUtils';

const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const installCanvasMocks = (captured: { data?: Uint8ClampedArray }) => {
  // Mock HTMLImageElement: resolves onload asynchronously with dimensions.
  class MockImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 2;
    naturalHeight = 1;
    width = 2;
    height = 1;
    set src(_value: string) {
      queueMicrotask(() => this.onload?.());
    }
  }
  vi.stubGlobal('Image', MockImage as unknown as typeof Image);

  const ctx = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    getImageData: vi.fn(() => ({
      // Pixel 1: pure red, Pixel 2: pure blue (opaque).
      data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]),
      width: 2,
      height: 1,
    })),
    putImageData: vi.fn((imageData: { data: Uint8ClampedArray }) => {
      captured.data = imageData.data;
    }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => 'data:image/png;base64,R1JBWQ=='),
  };
  const realCreateElement = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
    if (tag === 'canvas') return canvas as unknown as HTMLElement;
    return (realCreateElement as (...args: unknown[]) => HTMLElement)(tag, ...rest);
  }) as typeof document.createElement);
  return { ctx, canvas };
};

describe('convertImageDataUrlToGrayscale', () => {
  it('maps pixels to luminance gray (red->76, blue->29), alpha preserved', async () => {
    const captured: { data?: Uint8ClampedArray } = {};
    installCanvasMocks(captured);

    const result = await convertImageDataUrlToGrayscale(TINY_PNG);

    expect(result).toBe('data:image/png;base64,R1JBWQ==');
    expect(captured.data).toBeDefined();
    const px = Array.from(captured.data!);
    // Red (255,0,0) -> round(0.299*255) = 76; alpha untouched.
    expect(px.slice(0, 4)).toEqual([76, 76, 76, 255]);
    // Blue (0,0,255) -> round(0.114*255) = 29; alpha untouched.
    expect(px.slice(4, 8)).toEqual([29, 29, 29, 255]);
  });

  it('returns null for non-data-URL sources', async () => {
    await expect(convertImageDataUrlToGrayscale(null)).resolves.toBeNull();
    await expect(convertImageDataUrlToGrayscale('FILE-123')).resolves.toBeNull();
    await expect(convertImageDataUrlToGrayscale('https://example.com/logo.png')).resolves.toBeNull();
  });
});

describe('withGrayscaleLogoForPrint', () => {
  it('stamps the grayscale logo onto logo + logoBase64, leaves the rest alone', async () => {
    const captured: { data?: Uint8ClampedArray } = {};
    installCanvasMocks(captured);

    const config = {
      companyName: 'Acme',
      logo: TINY_PNG,
      logoBase64: TINY_PNG,
      currencySymbol: 'K',
    } as unknown as Parameters<typeof withGrayscaleLogoForPrint>[0];

    const next = await withGrayscaleLogoForPrint(config);

    expect(next?.logo).toBe('data:image/png;base64,R1JBWQ==');
    expect((next as { logoBase64?: string })?.logoBase64).toBe('data:image/png;base64,R1JBWQ==');
    expect(next?.companyName).toBe('Acme');
    expect(next?.currencySymbol).toBe('K');
  });

  it('falls back to the original config when there is no logo', async () => {
    const config = { companyName: 'Acme' } as unknown as Parameters<typeof withGrayscaleLogoForPrint>[0];
    await expect(withGrayscaleLogoForPrint(config)).resolves.toBe(config);
    await expect(withGrayscaleLogoForPrint(null)).resolves.toBeNull();
    await expect(withGrayscaleLogoForPrint(undefined)).resolves.toBeUndefined();
  });

  it('normalizeImageDataUrl still gates non-image sources', () => {
    expect(normalizeImageDataUrl(TINY_PNG)).toBe(TINY_PNG);
    expect(normalizeImageDataUrl('FILE-123')).toBeNull();
  });
});

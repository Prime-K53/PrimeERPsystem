/**
 * pdfPrintMode.ts — brand vs black-and-white print color mode.
 *
 * On-screen preview and downloaded PDFs keep full brand colors.
 * The Print action renders the SAME template with colorMode 'mono':
 * every text prints black (#000, white preserved on dark fills), panel
 * fills print as true grayscale (luminance) so backgrounds stay visible
 * on paper, and dividers print black. Company logos are converted to
 * grayscale upstream (see companyAssetUtils.convertImageDataUrlToGrayscale);
 * QR codes and signatures are never recolored and keep their original
 * appearance.
 */

/** Brand colors on preview/download, grayscale black & white on print. */
export type PrimeColorMode = 'brand' | 'mono';

export const PRINT_BLACK = '#000';
export const PRINT_WHITE = '#fff';

export const isPrintMono = (mode?: PrimeColorMode): boolean => mode === 'mono';

const toGrayByte = (r: number, g: number, b: number): number =>
  Math.round(0.299 * r + 0.587 * g + 0.114 * b);

const toHex2 = (n: number): string =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

const isTransparentValue = (value: string): boolean => {
  const v = String(value ?? '').trim().toLowerCase();
  return v === '' || v === 'transparent' || v === 'none';
};

const isWhiteValue = (value: string): boolean => {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === '#fff' || v === '#ffffff' || v === 'white') return true;
  if (v === '#ffffffff' || v === '#ffff') return true;
  const rgbWhite = v.replace(/\s+/g, '');
  if (rgbWhite === 'rgb(255,255,255)' || rgbWhite === 'rgba(255,255,255,1)') return true;
  return false;
};

/**
 * Minimum visible print gray. Near-white tints (e.g. #f8fafc, #f0f9ff,
 * accent + '15') would otherwise print as good as invisible on paper, so
 * mono fills at/above NEAR_WHITE_THRESHOLD clamp to this solid gray while
 * pure white stays paper-white (zebra rows keep their alternation).
 */
export const PRINT_VISIBLE_FILL = '#e0e0e0';
const NEAR_WHITE_THRESHOLD = 232;

/** Composite a gray byte over paper white at the given alpha (0..1). */
const compositeOverWhite = (grayByte: number, alpha: number): number =>
  Math.round(alpha * grayByte + (1 - alpha) * 255);

/** Solid #gggggg for a final gray byte. */
const solidGray = (grayByte: number): string => {
  const hex = toHex2(grayByte);
  return `#${hex}${hex}${hex}`;
};

/**
 * Convert any CSS color to its print-safe grayscale equivalent.
 * Supports #rgb, #rgba, #rrggbb, #rrggbbaa, rgb(), rgba(). Translucent
 * fills are composited over paper white and returned SOLID (printers and
 * PDF render solid fills predictably); near-white results clamp to
 * PRINT_VISIBLE_FILL so every tinted background stays clearly visible on
 * paper. Pure white stays white; transparent passes through; anything
 * unparseable returns the provided fallback so print never crashes.
 */
export const toGrayscale = (brand: string, fallback = PRINT_WHITE): string => {
  const raw = String(brand ?? '').trim();
  if (!raw) return fallback;
  if (isTransparentValue(raw)) return 'transparent';
  if (isWhiteValue(raw)) return '#ffffff';
  const lower = raw.toLowerCase();

  // Returns solid print gray for a luminance byte, clamping near-white so
  // tinted fills never print invisibly.
  const finalize = (grayByte: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(grayByte)));
    if (clamped >= NEAR_WHITE_THRESHOLD) return PRINT_VISIBLE_FILL;
    return solidGray(clamped);
  };

  // 8-digit hex with alpha, e.g. accentColor + '15' (e.g. '#5a9e9615')
  let m = lower.match(/^#([0-9a-f]{8})$/);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const alpha = parseInt(m[1].slice(6, 8), 16) / 255;
    return finalize(compositeOverWhite(toGrayByte(r, g, b), alpha));
  }
  m = lower.match(/^#([0-9a-f]{6})$/);
  if (m) {
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    return finalize(toGrayByte(r, g, b));
  }
  m = lower.match(/^#([0-9a-f]{3})$/);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    return finalize(toGrayByte(r, g, b));
  }
  m = lower.match(/^#([0-9a-f]{4})$/);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    const alpha = parseInt(m[1][3] + m[1][3], 16) / 255;
    return finalize(compositeOverWhite(toGrayByte(r, g, b), alpha));
  }
  // 5-digit shorthand produced by '#000' + '15' (short black + alpha) in
  // mono status badges: treat as #rgb + 2-digit alpha.
  m = lower.match(/^#([0-9a-f]{5})$/);
  if (m) {
    const r = parseInt(m[1][0] + m[1][0], 16);
    const g = parseInt(m[1][1] + m[1][1], 16);
    const b = parseInt(m[1][2] + m[1][2], 16);
    const alpha = parseInt(m[1].slice(3, 5), 16) / 255;
    return finalize(compositeOverWhite(toGrayByte(r, g, b), alpha));
  }
  m = lower.replace(/\s+/g, '').match(/^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,([0-9.]+))?\)$/);
  if (m) {
    const r = Math.max(0, Math.min(255, Number(m[1])));
    const g = Math.max(0, Math.min(255, Number(m[2])));
    const b = Math.max(0, Math.min(255, Number(m[3])));
    const gray = toGrayByte(r, g, b);
    if (m[4] !== undefined) {
      const alpha = Math.max(0, Math.min(1, Number(m[4])));
      return finalize(compositeOverWhite(gray, alpha));
    }
    return finalize(gray);
  }
  if (lower === 'black') return '#000000';
  return fallback;
};

/**
 * True for pure black/white/transparent/grayscale values — i.e. colors
 * that are safe on a black-and-white printout.
 */
export const isMonoSafeColor = (value: unknown): boolean => {
  if (typeof value !== 'string') return true;
  const v = value.trim().toLowerCase();
  if (v === 'transparent' || v === 'none') return true;
  if (v === '#000' || v === '#000000' || v === 'black') return true;
  if (v === '#fff' || v === '#ffffff' || v === 'white') return true;
  let m = v.match(/^#([0-9a-f]{6})$/);
  if (m) return m[1][0] === m[1][2] && m[1][2] === m[1][4] && m[1][1] === m[1][3] && m[1][3] === m[1][5];
  m = v.match(/^#([0-9a-f]{3})$/);
  if (m) return m[1][0] === m[1][1] && m[1][1] === m[1][2];
  m = v.match(/^#([0-9a-f]{8})$/);
  if (m) {
    const hex = m[1];
    return hex[0] === hex[2] && hex[2] === hex[4] && hex[1] === hex[3] && hex[3] === hex[5];
  }
  m = v.match(/^#([0-9a-f]{5})$/);
  if (m) {
    const hex = m[1];
    return hex[0] === hex[1] && hex[1] === hex[2];
  }
  m = v.match(/^#([0-9a-f]{4})$/);
  if (m) {
    const hex = m[1];
    return hex[0] === hex[1] && hex[1] === hex[2];
  }
  m = v.replace(/\s+/g, '').match(/^rgba?\((\d{1,3}),(\d{1,3}),(\d{1,3})(?:,([0-9.]+))?\)$/);
  if (m) return m[1] === m[2] && m[2] === m[3];
  return false;
};

/**
 * Text color: black on print, except white text stays white so it remains
 * readable on the (now grayscale-dark) header fills. Brand color otherwise.
 */
export const monoText = (mode: PrimeColorMode | undefined, brand: string): string => {
  if (mode !== 'mono') return brand;
  if (isWhiteValue(brand)) return PRINT_WHITE;
  return PRINT_BLACK;
};

/**
 * Panel/background fill: true grayscale (luminance) on print so every
 * background stays visible on paper. Transparent stays transparent.
 */
export const monoFill = (mode: PrimeColorMode | undefined, brand: string): string => {
  if (mode !== 'mono') return brand;
  if (isTransparentValue(brand)) return 'transparent';
  return toGrayscale(brand, PRINT_WHITE);
};

/** Borders, rules and dividers: black on print. */
export const monoLine = (mode: PrimeColorMode | undefined, brand: string): string =>
  mode === 'mono' ? PRINT_BLACK : brand;

/**
 * Solid icon fills (e.g. the green verification tick badge): black on
 * print so the light glyph drawn on top stays visible. Unlike monoFill,
 * this keeps a dark fill in mono mode.
 */
export const monoInk = (mode: PrimeColorMode | undefined, brand: string): string =>
  mode === 'mono' ? PRINT_BLACK : brand;

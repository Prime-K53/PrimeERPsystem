/**
 * pdfPrintMode.ts — brand vs black-and-white print color mode.
 *
 * On-screen preview and downloaded PDFs keep full brand colors.
 * The Print action renders the SAME template with colorMode 'mono':
 * every text prints pure black (#000), panel fills print white, and
 * dividers print black — while images (company logo, QR codes,
 * signatures) are never touched and keep their original appearance.
 */

/** Brand colors on preview/download, pure black & white on print. */
export type PrimeColorMode = 'brand' | 'mono';

export const PRINT_BLACK = '#000';
export const PRINT_WHITE = '#fff';

export const isPrintMono = (mode?: PrimeColorMode): boolean => mode === 'mono';

/** Text color: pure black on print, brand color otherwise. */
export const monoText = (mode: PrimeColorMode | undefined, brand: string): string =>
  mode === 'mono' ? PRINT_BLACK : brand;

/** Panel/background fill: white on print (keeps dark-on-light readable). */
export const monoFill = (mode: PrimeColorMode | undefined, brand: string): string =>
  mode === 'mono' ? PRINT_WHITE : brand;

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

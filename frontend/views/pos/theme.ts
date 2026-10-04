/**
 * POS design tokens.
 *
 * Every POS modal previously re-declared its own copy of this palette. This
 * module is the single source of truth.
 *
 * CONTRAST CONTRACT (all values measured against `paper` #FEFDFB):
 *   ink       #1F2427  16.1:1  AAA — primary text
 *   inkSoft   #5C6567   5.9:1  AA  — secondary text (the minimum allowed)
 *   danger    #A8382F   6.2:1  AA  — destructive text
 *   success   #0F6E43   5.5:1  AA  — positive text
 *
 * `hairline` is a BORDER colour only. It measured 1.33:1 as text and must
 * never be used for type — use `inkSoft` for secondary text instead.
 */

export const teal = {
  50: '#eef7f6',
  100: '#d3ece9',
  200: '#a6d9d3',
  300: '#72c0b7',
  400: '#3fa294',
  500: '#1f8577',
  600: '#146b60',
  700: '#0f544c',
  800: '#0b3e39',
  900: '#082e2a',
} as const;

export const amber = {
  100: '#fbead0',
  300: '#eec27a',
  500: '#d99a3f',
  600: '#b97e2b',
} as const;

export const paper = '#FEFDFB';
export const surface = '#FFFFFF';

/** Primary body text. 16.1:1 on paper. */
export const ink = '#1F2427';
/** Secondary text. 5.9:1 on paper — the lowest permitted text contrast. */
export const inkSoft = '#5C6567';
/** Hairline / dividers ONLY. Never use as a text colour (1.33:1). */
export const hairline = '#e4ddd1';
/** Hairline for strong separation between logical groups. */
export const hairlineStrong = '#d4cdc2';
/** Destructive text and borders. 6.2:1 on paper. */
export const danger = '#A8382F';
/** Positive text. 5.5:1 on paper. */
export const success = '#0F6E43';

/** Semantic backgrounds for banners and states. */
export const surfaceDanger = '#fef2f2';
export const borderDanger = '#fecaca';
/** Border for positive/settled chips. Pairs with `surfaceSuccess`. */
export const borderSuccess = '#a7e3c8';
export const surfaceSuccess = '#ecfdf5';
export const surfaceWarning = '#fffbeb';
export const borderWarning = '#fde68a';
export const textWarning = '#b45309';

/* ------------------------------------------------------------------ */
/* Register stock states                                               */
/* ------------------------------------------------------------------ */
/**
 * Stock is never communicated by colour alone — every state ships a dot AND
 * a number, and `out` additionally disables the tile and shows a text label.
 * A red/green pair alone fails for ~8% of male cashier users.
 *
 * Contrast measured against `surface` (#FFFFFF):
 *   stockOk    6.4:1  AA
 *   stockLow   5.0:1  AA
 *   stockOut   6.4:1  AA
 */
export const stock = {
  ok: '#0F6E43',
  low: '#B45309',
  out: '#A8382F',
  /** Dot fills. Always paired with the matching text token above. */
  dotOk: '#158F55',
  dotLow: '#D97706',
  dotOut: '#B3402F',
} as const;

/**
 * A single stock level is the boundary between "healthy" and "low". Kept here
 * rather than inlined so the product tile and the cart cannot disagree.
 */
export const LOW_STOCK_AT = 5;

/**
 * Classify an item's on-hand quantity.
 *
 * Services are never stock-bounded, so they always report `ok` and render
 * without a dot — showing "0 in stock" on a photocopy service is a lie.
 */
export function stockState(
  stockQty: number | null | undefined,
  minLevel: number | null | undefined,
): 'ok' | 'low' | 'out' {
  if (stockQty == null) return 'ok';
  const lowAt = minLevel == null ? LOW_STOCK_AT : minLevel;
  if (stockQty <= 0) return 'out';
  return stockQty <= lowAt ? 'low' : 'ok';
}

/* ------------------------------------------------------------------ */
/* Register type scale                                                 */
/* ------------------------------------------------------------------ */
/**
 * One scale for the whole register (see the register redesign spec):
 *   12  meta      — stock, SKU, secondary labels
 *   14  body      — item names, cart lines
 *   16  price     — tile price, line total
 *   28  total     — the single largest number on screen
 */
export const registerType = {
  meta: { fontSize: 12, lineHeight: 1.35 },
  body: { fontSize: 14, lineHeight: 1.4 },
  price: { fontSize: 16, fontWeight: 700, lineHeight: 1.2 },
  total: { fontSize: 28, fontWeight: 700, lineHeight: 1.1, letterSpacing: -0.4 },
} as const;

/** The one accent. Primary action and selection only — never decoration. */
export const ACCENT = teal[600];
export const ACCENT_HOVER = teal[700];
export const ACCENT_SOFT = teal[50];
export const ACCENT_BORDER = teal[200];

/** Minimum interactive target. Cashiers use this on a touchscreen all day. */
export const TAP_MIN = 44;

/** One shared focus indicator. WCAG 2.4.7 — never remove without replacing. */
export const FOCUS_RING = `0 0 0 2px ${paper}, 0 0 0 4px ${teal[500]}`;

/** Tabular figures for every monetary / quantity column. */
export const NUMERIC_FONT = "'JetBrains Mono', ui-monospace, monospace";
export const UI_FONT = "'Inter','DM Sans',system-ui,sans-serif";

/** Type scale. `fontWeight: 400` on headings is intentional (display face). */
export const type = {
  title: { fontFamily: UI_FONT, fontWeight: 400, fontSize: 22, letterSpacing: 0.2 },
  sectionLabel: { fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.08 },
  fieldLabel: { fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.06 },
  body: { fontSize: 13 },
  numeric: { fontFamily: NUMERIC_FONT, fontVariantNumeric: 'tabular-nums' as const },
  money: { fontFamily: NUMERIC_FONT, fontWeight: 700, fontVariantNumeric: 'tabular-nums' as const },
  moneyLarge: { fontFamily: NUMERIC_FONT, fontWeight: 700, fontSize: 22, fontVariantNumeric: 'tabular-nums' as const },
} as const;

/** Vertical rhythm. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 8, lg: 10, xl: 14, pill: 999 } as const;

/** Modal widths. One scale — no more arbitrary 520/560/620/640/680. */
export const modalWidth = {
  sm: 480,
  md: 560,
  lg: 680,
  xl: 860,
} as const;

export const ACCENT_BAR =
  `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`;

export const CARD_SHADOW =
  '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)';

export const OVERLAY_BG = 'rgba(15, 23, 42, 0.6)';

/* ------------------------------------------------------------------ */
/* Shared control surfaces                                              */
/* ------------------------------------------------------------------ */

export const controlBase: React.CSSProperties = {
  fontFamily: UI_FONT,
  fontSize: 13,
  borderRadius: radius.md,
  border: `1.4px solid ${hairline}`,
  background: paper,
  color: ink,
  outline: 'none',
};

/** Applied on every focusable control so keyboard focus is always visible. */
export const focusVisible = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.boxShadow = FOCUS_RING;
};
export const blurVisible = (e: React.FocusEvent<HTMLElement>) => {
  e.currentTarget.style.boxShadow = 'none';
};
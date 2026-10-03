/**
 * Central stacking scale. Anything rendered ABOVE the POS terminal layer
 * (toasts, fatal alerts) must exceed POS_MODAL — otherwise it renders
 * silently behind the POS overlay and the cashier never sees it.
 *
 * Rule of thumb: never hardcode a z-index. Import from here so the whole
 * application stays reorderable from one file.
 */
export const Z_INDEX = {
  /** Page content / scrolling regions. */
  BASE: 0,
  /** Sticky page furniture (top bars, sidebars, in-page drawers). */
  STICKY: 50,
  /** Dropdowns, popovers, hover cards anchored to page content. */
  OVERLAY: 300,
  /** Notification centres and toasts scoped to a page region. */
  REGIONAL: 1200,
  /** Global POS terminal wrapper (App.tsx) and its child modals. */
  POS_MODAL: 9999,
  /** Dialogs stacked on top of an already-open POS modal. */
  POS_MODAL_STACKED: 10000,
  /** System banners that must sit above modals (offline, update prompts). */
  BANNER: 99999,
  /** Toasts / fatal alerts — always on top of everything. */
  TOAST: 100000,
} as const;

export type ZIndexKey = keyof typeof Z_INDEX;
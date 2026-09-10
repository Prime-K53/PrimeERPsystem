import type { ReactNode } from 'react';

/**
 * Information priority for Rank → Stack → Slot → Label → Reveal → Breakpoint.
 * - primary: must remain visible (title / amount slot).
 * - secondary: stacked underneath primary on mobile; hidden from table only
 *   on narrow containers when `hideBelow` matches.
 * - detail: never a table column; revealed through expansion / detail sheet.
 */
export type TablePriority = 'primary' | 'secondary' | 'detail';

export type TableAlign = 'left' | 'right' | 'center';

export interface ResponsiveColumn<T> {
  key: string;
  label: string;
  priority: TablePriority;
  /** Optional container breakpoint below which this column leaves the desktop table
   *  (it remains visible in the mobile card + expansion). Default: never hide. */
  hideBelow?: 'md' | 'lg';
  align?: TableAlign;
  sortable?: boolean;
  /** Fixed width hint for desktop table layout. */
  width?: string | number;
  /** Extract a raw value (used for sorting / default rendering / detail fallback). */
  value?: (row: T) => unknown;
  /** Custom cell rendering. Falls back to value + kind formatting. */
  render?: (row: T) => ReactNode;
  /** Semantic kind drives default formatting + alignment. */
  kind?: 'text' | 'money' | 'number' | 'date' | 'status' | 'mono';
}

export interface RowAction<T> {
  key: string;
  label: string;
  icon?: ReactNode;
  /** Rendered as the always-visible primary CTA on mobile cards. */
  primary?: boolean;
  danger?: boolean;
  onSelect: (row: T) => void;
}

export interface DetailField {
  label: string;
  value: ReactNode;
}

export interface PaginationState {
  page: number;
  pageSize: number;
  total: number;
}

export type Density = 'compact' | 'comfortable';

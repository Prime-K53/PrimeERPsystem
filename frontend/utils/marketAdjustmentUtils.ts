import { MarketAdjustment } from '../types';
import { isMarketAdjustmentActive as isActiveCanonical } from './marketAdjustmentSemantics';

export const MARKET_ADJUSTMENTS_CHANGED_EVENT = 'market-adjustments:changed';

export type MarketAdjustmentChangeType = 'created' | 'updated' | 'deleted' | 'toggled' | 'synced';

export const isMarketAdjustmentActive = (
  adjustment: Partial<MarketAdjustment> | null | undefined
): boolean => {
  // Canonical semantics (Phase 3): active ?? is_active ?? isActive,
  // tolerant of boolean/0/1/strings, missing flag => active.
  return isActiveCanonical(adjustment as Record<string, unknown> | null | undefined);
};

/**
 * Single broadcast helper for market-adjustment writes (Phase 5).
 *
 * dbService.put/delete already emit `primeerp:data-changed` (see services/db
 * emitDataChange), which the management view listens to — but
 * ExaminationContext and pricing contexts listen to the SPECIFIC event below.
 * Every writer must call this (not a local inline dispatch) so no listener
 * goes stale, including writers that bypass the management view.
 */
export const broadcastMarketAdjustmentsChanged = (
  changeType: MarketAdjustmentChangeType,
  adjustmentId?: string | null
): void => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(MARKET_ADJUSTMENTS_CHANGED_EVENT, {
      detail: {
        changeType,
        adjustmentId: adjustmentId || null,
        timestamp: new Date().toISOString(),
      },
    })
  );
};

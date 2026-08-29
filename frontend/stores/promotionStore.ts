// Removed feature: promotion store.
// Stub retained so legacy imports do not break the build.
import { create } from 'zustand';
export interface PromotionState {
  promotions: unknown[];
  upsertPromotion: (_p: unknown) => void;
  removePromotion: (_id: string) => void;
  reset: () => void;
}
export const usePromotionStore = create<PromotionState>(() => ({
  promotions: [],
  upsertPromotion: () => {},
  removePromotion: () => {},
  reset: () => {},
}));

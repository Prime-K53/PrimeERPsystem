// Removed feature: product attribute store.
// Stub retained so legacy imports do not break the build.
import { create } from 'zustand';
export interface AttributeState {
  attributes: unknown[];
  addAttribute: (_attr: unknown) => void;
  removeAttribute: (_id: string) => void;
  reset: () => void;
}
export const useAttributeStore = create<AttributeState>(() => ({
  attributes: [],
  addAttribute: () => {},
  removeAttribute: () => {},
  reset: () => {},
}));

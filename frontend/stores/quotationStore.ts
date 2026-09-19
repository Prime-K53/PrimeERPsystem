import { create } from 'zustand';
import { logger } from '@/services/logger';
import { Quotation } from '../types';
import { api } from '../services/api';
import { generateNextId } from '../utils/helpers';
import { customerNotificationService } from '../services/customerNotificationService';

interface QuotationState {
  quotations: Quotation[];
  isLoading: boolean;
  fetchQuotations: (opts?: { limit?: number; cursor?: string }) => Promise<void>;
  addQuotation: (q: Quotation) => Promise<Quotation>;
  updateQuotation: (q: Quotation) => Promise<void>;
  deleteQuotation: (id: string) => Promise<void>;
}

export const useQuotationStore = create<QuotationState>((set, get) => ({
  quotations: [],
  isLoading: false,
  fetchQuotations: async (opts) => {
    set({ isLoading: true });
    try {
      const list = await api.sales.getQuotations();
      const slice = Array.isArray(list) ? (opts?.limit ? list.slice(0, opts.limit) : list) : [];
      set({ quotations: slice as Quotation[] });
      if ((list as any[]).length >= 1000) logger.warn('Quotations truncated — paginate (Phase 2)');
    } catch (e) {
      logger.error('Failed to fetch quotations', e);
    } finally {
      set({ isLoading: false });
    }
  },
  addQuotation: async (quotation) => {
    const newQuotation = { ...quotation, id: quotation.id || generateNextId('QTN', get().quotations) };
    const prev = get().quotations;
    set(state => ({ quotations: [...state.quotations, newQuotation] }));
    try {
      await api.sales.saveQuotation(newQuotation);
    } catch (e) {
      set({ quotations: prev });
      throw e;
    }
    if (newQuotation.customerPhone) {
      await customerNotificationService.triggerNotification('QUOTATION', {
        id: newQuotation.id,
        customerName: newQuotation.customerName,
        phoneNumber: newQuotation.customerPhone,
        amount: newQuotation.total ? `${newQuotation.currency || 'KES'} ${Number(newQuotation.total).toLocaleString()}` : '',
      }).catch(()=>{});
    }
    return newQuotation;
  },
  updateQuotation: async (quotation) => {
    const prev = get().quotations;
    set(state => ({ quotations: state.quotations.map(q => q.id === quotation.id ? quotation : q) }));
    try {
      await api.sales.saveQuotation(quotation);
    } catch (e) {
      set({ quotations: prev });
      throw e;
    }
  },
  deleteQuotation: async (id) => {
    const prev = get().quotations;
    set(state => ({ quotations: state.quotations.filter(q => q.id !== id) }));
    try {
      await api.sales.deleteQuotation(id);
    } catch (e) {
      set({ quotations: prev });
      throw e;
    }
  },
}));

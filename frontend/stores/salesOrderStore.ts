import { create } from 'zustand';
import { logger } from '@/services/logger';
import { SalesOrder, SalesOrderPayment } from '../types/salesOrder';
import { api } from '../services/api';
import { transactionService } from '../services/transactionService';
import { adminLifecycle } from '../services/adminPortalClient';
import {
  salesOrderService,
  getSalesOrderOfficialNumber,
  MigrationReport,
  AdoptionResult,
} from '../services/salesOrderService';

interface SalesOrderState {
  salesOrders: SalesOrder[];
  isLoading: boolean;
  error: string | null;
  migrationReport: MigrationReport | null;

  fetchSalesOrders: (silent?: boolean) => Promise<void>;
  createSalesOrder: (order: SalesOrder) => Promise<SalesOrder>;
  createFinancialOrder: (order: SalesOrder) => Promise<void>;
  updateSalesOrder: (order: SalesOrder) => Promise<void>;
  deleteSalesOrder: (id: string) => Promise<void>;
  recordPayment: (orderId: string, payment: SalesOrderPayment) => Promise<void>;
  updateOrderStatus: (id: string, status: string) => Promise<void>;
  cancelOrder: (id: string, reason: string) => Promise<void>;
  adoptQuotationRequest: (
    prefill: { id: string; requestNumber?: string },
    order: SalesOrder,
  ) => Promise<AdoptionResult>;
  migrateLegacyOrders: () => Promise<MigrationReport>;
  runMigrationIfNeeded: () => Promise<void>;
}

const inFlightCreates = new Set<string>();

export const useSalesOrderStore = create<SalesOrderState>((set, get) => ({
  salesOrders: [],
  isLoading: false,
  error: null,
  migrationReport: null,

  fetchSalesOrders: async (silent = false) => {
    if (!silent) set({ isLoading: true });
    try {
      const salesOrders = ((await api.sales.getSalesOrders()) || []) as unknown as SalesOrder[];
      set({ salesOrders, error: null });
    } catch (err: any) {
      set({ error: err?.message || String(err) });
      logger.error('Failed to load sales orders', err);
    } finally {
      if (!silent) set({ isLoading: false });
    }
  },

  createSalesOrder: async (order) => {
    // Manual ERP creation: stamp an explicit DIRECT_ERP source unless the
    // caller already carries a portal/invoice origin or request linkage
    // (adoption path sets PORTAL_CONVERSION itself).
    const withSource = (() => {
      const o: any = order || {};
      const hasSource = o.creation_source != null || o.creationSource != null;
      const hasLinkage = o.source_request_id || o.sourceRequestId
        || o.source_request_number || o.sourceRequestNumber
        || o.sourceRequestNumber || o.quotation_id || o.quotationId;
      if (hasSource || hasLinkage) return order;
      return { ...o, creation_source: 'DIRECT_ERP', creationSource: 'DIRECT_ERP' };
    })();
    const canonical = salesOrderService.canonicalizeOrder(withSource);
    const dedupeKey = canonical.idempotencyKey || canonical.id;
    if (inFlightCreates.has(dedupeKey)) throw new Error('Duplicate submit blocked — order already creating');
    inFlightCreates.add(dedupeKey);
    try {
      const existing = get().salesOrders.find((o) => o.id === canonical.id);
      if (existing) {
        if (canonical.idempotencyKey && existing.idempotencyKey === canonical.idempotencyKey) return existing;
        throw new Error(`Sales order ${canonical.id} already exists`);
      }
      const errors = salesOrderService.validateOrder(canonical);
      if (errors.length > 0) throw new Error(errors.join('; '));
      const saved = (await api.sales.saveSalesOrder(canonical)) as {
        success: boolean;
        order_number?: string | null;
        version?: number;
        updatedAt?: string | null;
      };
      // api.sales.saveSalesOrder already persisted the adopted authoritative
      // record when the online fast-path succeeded; mirror it into state
      // (no extra write here) so creation resolves numbered, invoice-style.
      // Offline/failure keeps the pending canonical for background convergence.
      const official = String(saved?.order_number ?? '').trim()
        || getSalesOrderOfficialNumber(canonical)
        || null;
      const finalized = official
        ? (salesOrderService.adoptServerNumber({
            ...canonical,
            order_number: official,
            ...(typeof saved?.version === 'number'
              ? { version: saved.version, _version: saved.version }
              : {}),
            ...(typeof saved?.updatedAt === 'string' && saved.updatedAt
              ? { serverUpdatedAt: saved.updatedAt }
              : {}),
          }) as SalesOrder)
        : canonical;
      set((state) => ({ salesOrders: [...state.salesOrders, finalized] }));
      return finalized;
    } finally {
      inFlightCreates.delete(dedupeKey);
    }
  },

  createFinancialOrder: async (order) => {
    await transactionService.createOrder(order as unknown as import('../types').Order);
    // ONLINE FAST-PATH (mirrors api.sales.saveSalesOrder): the atomic kernel
    // above only persisted locally + queued. Claim the authoritative ORD
    // number now so creation completes numbered instead of waiting for the
    // periodic pull. Offline/failure stays pending for background convergence.
    try {
      const canonical = salesOrderService.canonicalizeOrder(order);
      if (!getSalesOrderOfficialNumber(canonical)) {
        const { backgroundSyncService } = await import('../services/backgroundSyncService');
        await backgroundSyncService.claimOnlineSalesOrderNumber(
          canonical as unknown as Record<string, unknown>,
        );
      }
    } catch {
      // Background sync still converges — never fail creation on numbering.
    }
    await get().fetchSalesOrders(true);
  },

  updateSalesOrder: async (order) => {
    const canonical = salesOrderService.canonicalizeOrder(order);
    // Terminal status protection at store level
    const existingOrder = get().salesOrders.find((o) => o.id === canonical.id);
    if (existingOrder) {
      const existingCanonical = salesOrderService.canonicalizeStatus(existingOrder.status);
      if (salesOrderService.isTerminalStatus(existingCanonical) && canonical.status === existingCanonical) {
        // Status unchanged — this is a field update on a terminal order (e.g. marking invoiced).
        // Allow it only for specific non-destructive fields.
        const allowedTerminalFields = ['invoiceId', 'invoiceNumber', 'invoiceStatus', 'conversionDetails', 'convertedJobTicketId', 'linkedWorkOrderId'];
        const patchKeys = Object.keys(order).filter(k => k !== 'id' && k !== 'status');
        const disallowedKeys = patchKeys.filter(k => !allowedTerminalFields.includes(k));
        if (disallowedKeys.length > 0) {
          throw new Error(`Cannot modify fields [${disallowedKeys.join(', ')}] on a sales order in terminal status: ${existingCanonical}`);
        }
      }
    }
    await api.sales.saveSalesOrder(canonical);
    set((state) => ({
      salesOrders: state.salesOrders.map((o) => (o.id === canonical.id ? canonical : o)),
    }));
  },

  deleteSalesOrder: async (id) => {
    const existingOrder = get().salesOrders.find((o) => o.id === id);
    if (existingOrder) {
      const canonical = salesOrderService.canonicalizeStatus(existingOrder.status);
      if (salesOrderService.isTerminalStatus(canonical) && canonical !== 'Cancelled') {
        throw new Error(`Cannot delete a sales order in terminal status: ${canonical}`);
      }
    }
    await api.sales.deleteSalesOrder(id);
    set((state) => ({ salesOrders: state.salesOrders.filter((o) => o.id !== id) }));
  },

  recordPayment: async (orderId, payment) => {
    await transactionService.recordOrderPayment(orderId, payment);
    await get().fetchSalesOrders(true);
  },

  updateOrderStatus: async (id, status) => {
    await transactionService.updateOrderStatus(id, status);
    await get().fetchSalesOrders(true);
  },

  cancelOrder: async (id, reason) => {
    await transactionService.cancelOrder(id, reason);
    await get().fetchSalesOrders(true);
  },

  adoptQuotationRequest: async (prefill, order) => {
    const result = await salesOrderService.adoptQuotationRequestAsSalesOrder(prefill, order, {
      persistLocal: async (local) => {
        await api.sales.saveSalesOrder(local);
        return local;
      },
      completeOrder: (requestId, payload) =>
        adminLifecycle.requests.completeOrder(requestId, payload),
      updateLocal: async (adopted) => {
        await api.sales.saveSalesOrder(adopted);
      },
    });
    await get().fetchSalesOrders(true);
    return result;
  },

  migrateLegacyOrders: async () => {
    const report = await salesOrderService.migrateLegacyOrders();
    set({ migrationReport: report });
    await get().fetchSalesOrders(true);
    return report;
  },

  runMigrationIfNeeded: async () => {
    if (get().migrationReport) return;
    const legacy = (await api.sales.getAllOrders()) || [];
    if (legacy.length === 0) return;
    await get().migrateLegacyOrders();
  },
}));
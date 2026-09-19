import { create } from 'zustand';
import { logger } from '@/services/logger';
import { Sale, Quotation, JobOrder, HeldOrder, ZReport, CustomerPayment, Shipment, Customer, SalesExchange, ReprintJob, DeliveryNote, SalesOrder } from '../types';
import { api } from '../services/api';
import { transactionService } from '../services/transactionService';
import { useSalesOrderStore } from './salesOrderStore';
import { generateCustomerId, generateNextId } from '../utils/helpers';
import { customerNotificationService } from '../services/customerNotificationService';
import { adminLifecycle, type PortalCredentials } from '../services/adminPortalClient';

const buildDeliveryNotePatchFromShipment = (shipment: Shipment): Partial<DeliveryNote> | undefined => {
  if (!shipment.orderId) return undefined;

  const mappedStatus: DeliveryNote['status'] | undefined =
    shipment.status === 'Delivered'
      ? 'Delivered'
      : shipment.status === 'In Transit'
        ? 'In Transit'
        : undefined;

  return {
    id: shipment.orderId,
    status: mappedStatus,
    carrier: shipment.carrier,
    driverName: shipment.driverName,
    vehicleNo: shipment.vehicleNo,
    trackingNumber: shipment.trackingNumber,
    estimatedDelivery: shipment.estimatedDelivery,
    actualArrival: shipment.actualArrival,
    currentLocation: shipment.currentLocation,
    proofOfDelivery: shipment.proofOfDelivery
  };
};

interface SalesState {
  sales: Sale[];
  quotations: Quotation[];
  jobOrders: JobOrder[];
  heldOrders: HeldOrder[];
  zReports: ZReport[];
  customerPayments: CustomerPayment[];
  shipments: Shipment[];
  customers: Customer[];
  salesExchanges: SalesExchange[];
  salesOrders: SalesOrder[];
  reprintJobs: ReprintJob[];
  isLoading: boolean;
  loadingMap: Record<string, boolean>;

  addSalesOrder: (order: SalesOrder) => Promise<void>;
  updateSalesOrder: (order: SalesOrder) => Promise<void>;
  deleteSalesOrder: (id: string) => Promise<void>;

  fetchSalesData: (silent?: boolean) => Promise<void>;
  fetchExchanges: () => Promise<void>;
  
  addSale: (sale: Sale) => Promise<void>;
  updateSale: (sale: Sale) => Promise<void>;
  
  addQuotation: (quotation: Quotation) => Promise<Quotation>;
  updateQuotation: (quotation: Quotation) => Promise<void>;
  deleteQuotation: (id: string) => Promise<void>;
  
  addJobOrder: (jobOrder: JobOrder) => Promise<void>;
  updateJobOrder: (jobOrder: JobOrder) => Promise<void>;
  deleteJobOrder: (id: string) => Promise<void>;
  
  addHeldOrder: (order: HeldOrder) => Promise<void>;
  deleteHeldOrder: (id: string) => Promise<void>;
  
  addCustomerPayment: (payment: CustomerPayment) => Promise<void>;
  updateCustomerPayment: (payment: CustomerPayment) => Promise<void>;
  deleteCustomerPayment: (id: string) => Promise<void>;
  permanentlyDeleteCustomerPayment: (id: string) => Promise<void>;

  addShipment: (shipment: Shipment, deliveryNotePatch?: Partial<DeliveryNote>) => Promise<void>;
  updateShipment: (shipment: Shipment, deliveryNotePatch?: Partial<DeliveryNote>) => Promise<void>;
  deleteShipment: (id: string) => Promise<void>;

  addCustomer: (customer: Customer, options?: { invite?: boolean }) => Promise<PortalCredentials | null>;
  updateCustomer: (customer: Customer) => Promise<void>;
  deleteCustomer: (id: string) => Promise<void>;

  createSalesExchange: (exchange: any) => Promise<void>;
  approveSalesExchange: (id: string, comments: string) => Promise<void>;
  deleteSalesExchange: (id: string) => Promise<void>;
  cancelSalesExchange: (id: string) => Promise<void>;
  bulkCancelSalesExchanges: (ids: string[]) => Promise<void>;
  updateReprintJob: (id: string, data: any) => Promise<void>;
  processPortalRetryQueue: () => Promise<number>;
}

export const useSalesStore = create<SalesState>((set, get) => ({
  sales: [],
  quotations: [],
  jobOrders: [],
  heldOrders: [],
  zReports: [],
  customerPayments: [],
  shipments: [],
  customers: [],
  salesExchanges: [],
  salesOrders: [],
  reprintJobs: [],
  isLoading: false,
  loadingMap: {},

  fetchSalesData: async (silent = false) => {
    if (!silent) set({ isLoading: true, loadingMap: { sales: true, quotations: true, jobOrders: true, customers: true } });
    try {
      await useSalesOrderStore.getState().fetchSalesOrders(true);
      const [sales, quotations, jobOrders, customerPayments, shipments, customers, salesExchanges, reprintJobs] = await Promise.all([
        api.sales.getAllSales().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.sales.getQuotations().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.sales.getJobOrders().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.sales.getCustomerPayments().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.sales.getShipments().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.customers.getAll().then(list => (list as Array<Record<string, unknown>>).filter(c => !c.deletedAt).slice(0,2000)),
        api.sales.getSalesExchanges().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
        api.sales.getReprintJobs().then((r:any) => Array.isArray(r) ? r.slice(0,1000) : r),
      ]);
      if ((sales as any[]).length >= 1000) logger.warn('Sales truncated at 1000 — pagination required (Phase 2)');
      set({ sales, quotations, jobOrders, customerPayments, shipments, customers, salesExchanges, reprintJobs, salesOrders: useSalesOrderStore.getState().salesOrders, loadingMap: {} });
    } catch (error) {
      logger.error("Failed to load sales data", error);
      if (!silent) set({ loadingMap: {} });
    } finally {
      if (!silent) set({ isLoading: false, loadingMap: {} });
    }
  },

  fetchExchanges: async () => {
    try {
      const [salesExchanges, reprintJobs] = await Promise.all([
        api.sales.getSalesExchanges(),
        api.sales.getReprintJobs()
      ]);
      set({ salesExchanges, reprintJobs });
    } catch (error) {
      logger.error("Failed to fetch exchanges", error);
    }
  },

  addSale: async (sale) => {
    const newSale = { ...sale, id: sale.id || generateNextId('SALE', get().sales) };
    const prev = get().sales;
    set(state => ({ sales: [...state.sales, newSale] }));
    try {
      await api.sales.createSale(newSale);
    } catch (error) {
      set({ sales: prev });
      throw error;
    }
    if (newSale.customerPhone) {
      await customerNotificationService.triggerNotification('SALES_ORDER', {
        id: newSale.id,
        customerName: newSale.customerName,
        phoneNumber: newSale.customerPhone,
        amount: newSale.total ? `${newSale.currency || 'KES'} ${Number(newSale.total).toLocaleString()}` : '',
      });
    }
  },
  updateSale: async (sale) => {
    const prev = get().sales;
    set(state => ({ sales: state.sales.map(s => s.id === sale.id ? sale : s) }));
    try {
      await transactionService.updateSale(sale);
    } catch (error) {
      set({ sales: prev });
      throw error;
    }
  },

  addQuotation: async (quotation) => {
    const { useQuotationStore } = await import('./quotationStore');
    const result = await useQuotationStore.getState().addQuotation(quotation);
    set({ quotations: useQuotationStore.getState().quotations });
    return result;
  },
  updateQuotation: async (quotation) => {
    const { useQuotationStore } = await import('./quotationStore');
    await useQuotationStore.getState().updateQuotation(quotation);
    set({ quotations: useQuotationStore.getState().quotations });
  },
  deleteQuotation: async (id) => {
    const { useQuotationStore } = await import('./quotationStore');
    await useQuotationStore.getState().deleteQuotation(id);
    set({ quotations: useQuotationStore.getState().quotations });
  },

  addJobOrder: async (jobOrder) => {
    const newJob = { ...jobOrder, id: jobOrder.id || generateNextId('JO', get().jobOrders) };
    const prev = get().jobOrders;
    set(state => ({ jobOrders: [...state.jobOrders, newJob] }));
    try {
      await api.sales.saveJobOrder(newJob);
    } catch (error) {
      set({ jobOrders: prev });
      throw error;
    }
  },
  updateJobOrder: async (jobOrder) => {
    const prev = get().jobOrders;
    set(state => ({ jobOrders: state.jobOrders.map(j => j.id === jobOrder.id ? jobOrder : j) }));
    try {
      await api.sales.saveJobOrder(jobOrder);
    } catch (error) {
      set({ jobOrders: prev });
      throw error;
    }
  },
  deleteJobOrder: async (id) => {
    const prev = get().jobOrders;
    set(state => ({ jobOrders: state.jobOrders.filter(j => j.id !== id) }));
    try {
      await api.sales.deleteJobOrder(id);
    } catch (error) {
      set({ jobOrders: prev });
      throw error;
    }
  },

  addHeldOrder: async (order) => {
    const prev = get().heldOrders;
    const newOrder = { ...order };
    set(state => ({ heldOrders: [...state.heldOrders, newOrder] }));
    try {
      await api.sales.saveHeldOrder(newOrder);
    } catch (error) {
      set({ heldOrders: prev });
      throw error;
    }
  },
  deleteHeldOrder: async (id) => {
      const prev = get().heldOrders;
      set(state => ({ heldOrders: state.heldOrders.filter(h => h.id !== id) }));
      try {
        await api.sales.deleteHeldOrder?.(id) ?? api.sales.saveHeldOrder?.({ id, _deleted: true } as any);
      } catch (e) {
        set({ heldOrders: prev });
        throw e;
      }
  },

addCustomerPayment: async (payment) => {
      const newPayment = { ...payment, id: payment.id || generateNextId('RCPT', get().customerPayments) };
      const prev = get().customerPayments;
      set(state => ({ customerPayments: [...state.customerPayments, newPayment] }));
      try {
        await api.sales.saveCustomerPayment(newPayment);
      } catch (error) {
        set({ customerPayments: prev });
        throw error;
      }
      if (newPayment.customerPhone) {
        await customerNotificationService.triggerNotification('PAYMENT', {
          id: newPayment.id,
          customerName: newPayment.customerName,
          phoneNumber: newPayment.customerPhone,
          amount: newPayment.amount ? `${newPayment.currency || 'KES'} ${Number(newPayment.amount).toLocaleString()}` : '',
        });
      }
    },
  updateCustomerPayment: async (payment) => {
      const prev = get().customerPayments;
      set(state => ({ customerPayments: state.customerPayments.map(p => p.id === payment.id ? payment : p) }));
      try {
        await api.sales.saveCustomerPayment(payment);
      } catch (error) {
        set({ customerPayments: prev });
        throw error;
      }
  },
  deleteCustomerPayment: async (id) => {
      const prev = get().customerPayments;
      set(state => ({ customerPayments: state.customerPayments.filter(p => p.id !== id) }));
      try {
        await api.sales.deleteCustomerPayment(id);
      } catch (error) {
        set({ customerPayments: prev });
        throw error;
      }
  },
  permanentlyDeleteCustomerPayment: async (id) => {
      const prev = get().customerPayments;
      set(state => ({ customerPayments: state.customerPayments.filter(p => p.id !== id) }));
      try {
        await api.sales.permanentlyDeleteCustomerPayment(id);
      } catch (error) {
        set({ customerPayments: prev });
        throw error;
      }
  },

  addShipment: async (shipment, deliveryNotePatch) => {
    const newShipment = { ...shipment, id: shipment.id || generateNextId('SHP', get().shipments) };
    const prev = get().shipments;
    set(state => ({ shipments: [...state.shipments, newShipment] }));
    try {
      await transactionService.updateShipmentStatus(newShipment, deliveryNotePatch || buildDeliveryNotePatchFromShipment(newShipment));
    } catch (error) {
      set({ shipments: prev });
      throw error;
    }
  },

  updateShipment: async (shipment, deliveryNotePatch) => {
    const prev = get().shipments;
    set(state => ({ shipments: state.shipments.map(s => s.id === shipment.id ? shipment : s) }));
    try {
      await transactionService.updateShipmentStatus(shipment, deliveryNotePatch || buildDeliveryNotePatchFromShipment(shipment));
    } catch (error) {
      set({ shipments: prev });
      throw error;
    }
  },

  deleteShipment: async (id) => {
    const prev = get().shipments;
    set(state => ({ shipments: state.shipments.filter(s => s.id !== id) }));
    try {
      await api.sales.deleteShipment(id);
    } catch (error) {
      set({ shipments: prev });
      throw error;
    }
  },

  addCustomer: async (customer, options = {}): Promise<PortalCredentials | null> => {
    // Id collision guard: regenerate if exists
    let newId = customer.id || generateCustomerId(get().customers);
    while (get().customers.some(c => c.id === newId)) newId = generateCustomerId(get().customers);
    const newCustomer = { ...customer, id: newId };
    const prev = get().customers;
    set(state => ({ customers: [...state.customers, newCustomer] }));
    try {
      await api.customers.save(newCustomer);
      let credentials: PortalCredentials | null = null;
      const attemptPortal = async (retries = 2): Promise<void> => {
        for (let i = 0; i <= retries; i++) {
          try {
            const portalAccount = await adminLifecycle.users.autoCreate({
              customer_id: newCustomer.id,
              name: newCustomer.name,
              email: newCustomer.email,
              phone: newCustomer.phone,
              invite: options.invite,
            });
            if (portalAccount?.user) {
              const isInvite = options.invite && !!portalAccount.invite_code;
              credentials = {
                email: portalAccount.user.email,
                password: isInvite ? null : portalAccount.generated_password,
                inviteCode: portalAccount.invite_code ?? null,
                userId: portalAccount.user.id,
              };
              const enriched = {
                ...newCustomer,
                portalUserId: portalAccount.user.id,
                portalEmail: portalAccount.user.email,
                portalStatus: portalAccount.user.status || (isInvite ? 'invited' : 'active'),
              };
              set(state => ({ customers: state.customers.map(c => c.id === enriched.id ? enriched : c) }));
              await api.customers.save(enriched).catch(() => {});
            }
            return;
          } catch (portalErr: any) {
            const isLast = i === retries;
            logger.warn(`Portal provisioning attempt ${i+1} failed for ${newCustomer.id}:`, portalErr?.message || portalErr);
            if (isLast) {
              // Offline queue: persist for background retry, do not block customer creation
              try {
                const q = JSON.parse(localStorage.getItem('portal:retryQueue') || '[]');
                q.push({ customerId: newCustomer.id, ts: Date.now(), invite: !!options.invite });
                localStorage.setItem('portal:retryQueue', JSON.stringify(q.slice(-50)));
              } catch {}
              // Mark pending_retry so UI can show retry CTA
              const pending = { ...newCustomer, portalStatus: 'pending_retry' as const };
              set(state => ({ customers: state.customers.map(c => c.id === pending.id ? pending : c) }));
              await api.customers.save(pending).catch(()=>{});
            } else {
              await new Promise(r => setTimeout(r, 300 * Math.pow(2, i)));
            }
          }
        }
      };
      await attemptPortal();
      return credentials;
    } catch (error) {
      set({ customers: prev });
      throw error;
    }
  },
  updateCustomer: async (customer) => {
    const prev = get().customers;
    set(state => ({ customers: state.customers.map(c => c.id === customer.id ? customer : c) }));
    try {
      await api.customers.save(customer);
    } catch (error) {
      set({ customers: prev });
      throw error;
    }
  },
  deleteCustomer: async (id) => {
    const prev = get().customers;
    set(state => ({ customers: state.customers.filter(c => c.id !== id) }));
    try {
      await api.customers.delete(id);
    } catch (error) {
      set({ customers: prev });
      throw error;
    }
  },

  // Pure facade — delegates entirely to the canonical salesOrderStore.
  // No local ID generation: server-authoritative numbering (SO-YYYY-######).
  addSalesOrder: async (order) => {
    await useSalesOrderStore.getState().createSalesOrder(order);
  },
  updateSalesOrder: async (order) => {
    await useSalesOrderStore.getState().updateSalesOrder(order);
  },
  deleteSalesOrder: async (id) => {
    await useSalesOrderStore.getState().deleteSalesOrder(id);
  },

  createSalesExchange: async (exchange) => {
    try {
      await api.sales.createSalesExchange(exchange);
      await get().fetchExchanges();
    } catch (error) {
      logger.error('createSalesExchange error:', error);
      throw error; // Re-throw to let the caller handle it
    }
  },
  approveSalesExchange: async (id, comments) => {
    await api.sales.approveSalesExchange(id, comments);
    await get().fetchExchanges();
  },
  deleteSalesExchange: async (id) => {
    await api.sales.deleteSalesExchange(id);
    await get().fetchExchanges();
  },
  cancelSalesExchange: async (id) => {
    await api.sales.cancelSalesExchange(id);
    await get().fetchExchanges();
  },
  bulkCancelSalesExchanges: async (ids) => {
    await transactionService.bulkCancelSalesExchanges(ids);
    await get().fetchExchanges();
  },
  updateReprintJob: async (id, data) => {
    await api.sales.updateReprintJob(id, data);
    await get().fetchExchanges();
  },
  processPortalRetryQueue: async () => {
    let q: Array<{customerId:string, invite?:boolean, ts:number}> = [];
    try { q = JSON.parse(localStorage.getItem('portal:retryQueue') || '[]'); } catch {}
    if (!q.length) return 0;
    let success = 0;
    const remaining: typeof q = [];
    for (const entry of q) {
      try {
        const c = get().customers.find(x => x.id === entry.customerId);
        if (!c) { success++; continue; }
        const res = await adminLifecycle.users.autoCreate({
          customer_id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          invite: entry.invite,
        });
        if (res?.user) {
          const enriched = { ...c, portalUserId: res.user.id, portalEmail: res.user.email, portalStatus: res.user.status || (entry.invite ? 'invited' : 'active') };
          set(state => ({ customers: state.customers.map(x => x.id === enriched.id ? enriched : x) }));
          await api.customers.save(enriched).catch(()=>{});
          success++;
        } else {
          remaining.push(entry);
        }
      } catch {
        remaining.push(entry);
      }
    }
    try { localStorage.setItem('portal:retryQueue', JSON.stringify(remaining.slice(-50))); } catch {}
    if (success) logger.info(`Portal retry: ${success} recovered, ${remaining.length} still pending`);
    return success;
  }
}));

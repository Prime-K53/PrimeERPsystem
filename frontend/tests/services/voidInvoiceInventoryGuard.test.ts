/**
 * voidInvoiceInventoryGuard.test.ts
 *
 * Regression proof for a defect in transactionService.voidInvoice: its
 * inventory-reversal loop had no `type !== 'Service'` guard, unlike voidSale.
 * Every Examination invoice line is `type: 'Service'` and is keyed by a CLASS
 * id, and no stock is ever deducted for Service lines on the way in
 * (_executeDeductInventory skips non-inventory-bearing items). Crediting them
 * on void therefore returns stock that was never taken — which today happens
 * to be harmless only because a class id does not collide with an inventory id.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest';

const inventoryStore = new Map<string, any>();
const invoicesStore = new Map<string, any>();
const ledgerStore = new Map<string, any>();
const customersStore = new Map<string, any>();
const paymentsStore = new Map<string, any>();
const walletStore = new Map<string, any>();

vi.mock('../../services/db', () => ({
  dbService: {
    executeAtomicOperation: vi.fn(async (_stores: string[], operation: (tx: any) => Promise<any>) => {
      const tx = {
        objectStore: (name: string) => ({
          get: async (id: string) => ({
            invoices: invoicesStore,
            inventory: inventoryStore,
            ledger: ledgerStore,
            customers: customersStore,
            customerPayments: paymentsStore,
            walletTransactions: walletStore,
          }[name] as Map<string, any>)?.get(String(id)),
          getAll: async () => Array.from(({
            invoices: invoicesStore,
            inventory: inventoryStore,
            ledger: ledgerStore,
            customers: customersStore,
            customerPayments: paymentsStore,
            walletTransactions: walletStore,
          }[name] as Map<string, any>)?.values() ?? []),
          put: async (item: any) => {
            ({
              invoices: invoicesStore,
              inventory: inventoryStore,
              ledger: ledgerStore,
              customers: customersStore,
              customerPayments: paymentsStore,
              walletTransactions: walletStore,
            }[name] as Map<string, any>).set(String(item.id), item);
            return String(item.id);
          },
        }),
        done: Promise.resolve(),
      };
      return operation(tx);
    }),
  },
}));

vi.mock('../../services/companyConfig', () => ({
  getCompanyConfig: () => ({ companyId: 'CO-1', companyName: 'Prime' }),
}));

vi.mock('../../services/glConfig', () => ({
  getGLConfig: () => ({
    cashDrawerAccount: '11100',
    customerDepositAccount: '11200',
    accountsReceivable: '11310',
    defaultSalesAccount: '41200',
  }),
}));

vi.mock('../../services/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const buildExamInvoice = () => ({
  id: 'EXM-VOID/001',
  invoiceNumber: 'EXM-VOID/001',
  status: 'Unpaid',
  customerId: 'CUST-1',
  originModule: 'examination',
  batchId: 'BTC-VOID/001',
  totalAmount: 8000,
  paidAmount: 0,
  verificationToken: 'a'.repeat(64),
  items: [
    {
      id: 'CLASS-1',
      itemId: 'CLASS-1',
      name: 'Form 1',
      type: 'Service',
      quantity: 80,
      price: 100,
      total: 8000,
    },
  ],
});

describe('voidInvoice does not credit stock for Service lines', () => {
  beforeEach(() => {
    inventoryStore.clear();
    invoicesStore.clear();
    ledgerStore.clear();
    customersStore.clear();
    paymentsStore.clear();
    walletStore.clear();
  });

  it('leaves inventory untouched when the invoice carries only Service lines', async () => {
    // The collision case the missing guard made possible: an inventory item
    // whose id happens to equal an exam class id.
    inventoryStore.set('CLASS-1', { id: 'CLASS-1', name: 'A4 Paper', stock: 500 });
    const invoice = buildExamInvoice();
    invoicesStore.set(invoice.id, invoice);

    const { transactionService } = await import('../../services/transactionService');
    await transactionService.voidInvoice(invoice.id, 'test void');

    // Stock must be exactly what it was: nothing was deducted for a Service
    // line, so nothing may be returned on void.
    expect(inventoryStore.get('CLASS-1').stock).toBe(500);
  });

  it('still returns stock for a genuine inventory-bearing line', async () => {
    inventoryStore.set('ITEM-PAPER', { id: 'ITEM-PAPER', name: 'A4 Paper', stock: 500 });
    const invoice: any = {
      ...buildExamInvoice(),
      items: [
        { id: 'ITEM-PAPER', itemId: 'ITEM-PAPER', name: 'A4 Paper', type: 'Material', quantity: 40, price: 10, total: 400 },
      ],
    };
    invoicesStore.set(invoice.id, invoice);

    const { transactionService } = await import('../../services/transactionService');
    await transactionService.voidInvoice(invoice.id, 'test void');

    expect(inventoryStore.get('ITEM-PAPER').stock).toBe(540);
  });

  it('marks the invoice voided rather than deleting it', async () => {
    const invoice = buildExamInvoice();
    invoicesStore.set(invoice.id, invoice);

    const { transactionService } = await import('../../services/transactionService');
    await transactionService.voidInvoice(invoice.id, 'test void');

    const stored = invoicesStore.get(invoice.id);
    expect(stored).toBeDefined();
    expect(String(stored.status).toLowerCase()).toBe('cancelled');
  });
});
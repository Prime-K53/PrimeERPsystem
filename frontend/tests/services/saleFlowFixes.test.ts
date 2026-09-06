import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAccountForPosting, getGLConfig, loadAccountsFromStore } from '../../services/transactions/_internal';
import { generateNextId } from '../../utils/helpers';
import { ACCOUNT_IDS, DEFAULT_ACCOUNTS } from '../../constants';
import { transactionService } from '../../services/transactionService';
import { dbService } from '../../services/db';
import { Sale, Order } from '../../types';

describe('Sale & Order Flow Fixes', () => {
  const mockAccounts = [
    { id: 'coa-11110', code: '11110', account_number: '11110', name: 'Cash Drawer', is_active: true, allow_posting: true },
    { id: 'coa-11210', code: '11210', account_number: '11210', name: 'Bank Account', is_active: true, allow_posting: true },
    { id: 'coa-11240', code: '11240', account_number: '11240', name: 'Mobile Money', is_active: true, allow_posting: true },
    { id: 'coa-11310', code: '11310', account_number: '11310', name: 'Trade Debtors', is_active: true, allow_posting: true },
    { id: 'coa-21300', code: '21300', account_number: '21300', name: 'Customer Deposits', is_active: true, allow_posting: true },
    { id: 'coa-41100', code: '41100', account_number: '41100', name: 'Sales Revenue', is_active: true, allow_posting: true },
    { id: 'coa-51200', code: '51200', account_number: '51200', name: 'Cost of Goods Sold', is_active: true, allow_posting: true },
    { id: 'coa-11400', code: '11400', account_number: '11400', name: 'Inventory', is_active: true, allow_posting: true },
    { id: 'coa-42000', code: '42000', account_number: '42000', name: 'Other Income', is_active: true, allow_posting: false },
    { id: 'coa-42100', code: '42100', account_number: '42100', name: 'Interest Income', parent_account_id: '42000', is_active: true, allow_posting: true },
  ];

  describe('Account Resolution & Backward Compatibility', () => {
    it('resolves canonical 5-digit accounts directly', () => {
      expect(resolveAccountForPosting(ACCOUNT_IDS.CASH_DRAWER, mockAccounts, { strict: true })).toBe('coa-11110');
      expect(resolveAccountForPosting(ACCOUNT_IDS.BANK, mockAccounts, { strict: true })).toBe('coa-11210');
      expect(resolveAccountForPosting(ACCOUNT_IDS.MOBILE_MONEY, mockAccounts, { strict: true })).toBe('coa-11240');
    });

    it('resolves legacy 4-digit codes via fallback mapping without throwing in strict mode', () => {
      // Legacy cash account '1000' -> '11110'
      expect(resolveAccountForPosting('1000', mockAccounts, { strict: true })).toBe('coa-11110');
      // Legacy bank account '1050' -> '11210'
      expect(resolveAccountForPosting('1050', mockAccounts, { strict: true })).toBe('coa-11210');
      // Legacy mobile money account '1060' -> '11240'
      expect(resolveAccountForPosting('1060', mockAccounts, { strict: true })).toBe('coa-11240');
      // Legacy AR account '1100' -> '11310'
      expect(resolveAccountForPosting('1100', mockAccounts, { strict: true })).toBe('coa-11310');
      // Legacy sales revenue '4000' -> '41100'
      expect(resolveAccountForPosting('4000', mockAccounts, { strict: true })).toBe('coa-41100');
    });

    it('resolves non-posting summary account to active posting child under it', () => {
      // 42000 has allow_posting: false, but has child 42100 with allow_posting: true
      const resolved = resolveAccountForPosting('42000', mockAccounts, { allowNonPosting: false, strict: true });
      expect(resolved).toBe('coa-42100');
    });
  });

  describe('loadAccountsFromStore Async Promise & IDB Compatibility', () => {
    it('resolves successfully when accountsStore.getAll() returns a Promise (cloudTx / async DB)', async () => {
      const mockPromiseStore = {
        objectStore: (name: string) => ({
          getAll: async () => mockAccounts,
        }),
      };
      const accounts = await loadAccountsFromStore(mockPromiseStore);
      expect(accounts).toEqual(mockAccounts);
      expect(accounts.length).toBe(mockAccounts.length);
    });

    it('resolves successfully when accountsStore.getAll() returns an IDBRequest with onsuccess', async () => {
      const mockIDBStore = {
        objectStore: (name: string) => ({
          getAll: () => {
            const req: any = {};
            setTimeout(() => {
              req.result = mockAccounts;
              if (req.onsuccess) req.onsuccess();
            }, 5);
            return req;
          },
        }),
      };
      const accounts = await loadAccountsFromStore(mockIDBStore);
      expect(accounts).toEqual(mockAccounts);
    });

    it('falls back to DEFAULT_ACCOUNTS when accountsStore returns empty array', async () => {
      const mockEmptyStore = {
        objectStore: (name: string) => ({
          getAll: async () => [],
        }),
      };
      const accounts = await loadAccountsFromStore(mockEmptyStore);
      expect(accounts).toBeDefined();
      expect(accounts.length).toBeGreaterThan(0);
      expect(accounts[0].code).toBeDefined();
    });

    it('falls back to DEFAULT_ACCOUNTS when tx or objectStore throws', async () => {
      const mockFailingTx = {
        objectStore: () => {
          throw new Error('Database transaction inactive');
        },
      };
      const accounts = await loadAccountsFromStore(mockFailingTx);
      expect(accounts).toEqual(DEFAULT_ACCOUNTS);
    });
  });

  describe('GL Config Defaults & Aliases', () => {
    it('includes all necessary aliases and accounts in getGLConfig()', () => {
      const gl = getGLConfig();
      expect(gl.cashDrawerAccount).toBe('11110');
      expect(gl.bankAccount).toBe('11210');
      expect(gl.mobileMoneyAccount).toBe('11240');
      expect(gl.customerDepositAccount).toBe('21300');
      expect(gl.customerDeposits).toBe('21300');
      expect(gl.defaultSalesAccount).toBe('41100');
      expect(gl.salesRevenueAccount).toBe('41100');
      expect(gl.walletAccount).toBe('21300');
    });
  });

  describe('Order ID Generation', () => {
    it('increments order ID when existing orders are passed', () => {
      const existingOrders = [
        { id: 'ORDER-0001' },
        { id: 'ORDER-0002' }
      ];
      const nextId = generateNextId('order', existingOrders as any);
      expect(nextId).toBe('ORDER-0003');
    });

    it('would repeatedly produce ORDER-0001 if an empty collection was passed', () => {
      const emptyCollection: any[] = [];
      const firstId = generateNextId('order', emptyCollection);
      const secondId = generateNextId('order', emptyCollection);
      expect(firstId).toBe('ORDER-0001');
      expect(secondId).toBe('ORDER-0001'); // Highlights the bug that was fixed
    });
  });

  describe('End-to-End Sale and Order Processing (Root Cause Fix)', () => {
    const inMemoryDb: Record<string, any[]> = {};

    beforeEach(() => {
      for (const k of Object.keys(inMemoryDb)) {
        delete inMemoryDb[k];
      }
      vi.spyOn(dbService, 'put').mockImplementation(async (store: any, item: any) => {
        if (!inMemoryDb[store]) inMemoryDb[store] = [];
        const idx = inMemoryDb[store].findIndex((x: any) => x.id === item.id);
        if (idx >= 0) inMemoryDb[store][idx] = item;
        else inMemoryDb[store].push(item);
        return item;
      });
      vi.spyOn(dbService, 'get').mockImplementation(async (store: any, id: string) => {
        return (inMemoryDb[store] || []).find((x: any) => x.id === id);
      });
      vi.spyOn(dbService, 'getAll').mockImplementation(async (store: any) => {
        if (store === 'accounts') return mockAccounts;
        return inMemoryDb[store] || [];
      });
    });

    it('successfully processes a POS cash sale and writes balanced ledger entries', async () => {
      const saleId = `POS-${Date.now()}`;
      const mockSale: Sale = {
        id: saleId,
        date: new Date().toISOString(),
        source: 'POS',
        totalAmount: 100,
        discount: 0,
        status: 'Paid',
        items: [
          {
            id: 'item-1',
            name: 'Notebook A5',
            price: 50,
            quantity: 2,
            subtotal: 100,
          } as any
        ],
        payments: [
          { method: 'Cash', amount: 100, accountId: ACCOUNT_IDS.CASH_DRAWER }
        ],
        cashierId: 'cashier-1',
        customerName: 'Walk-in',
        cash_tendered: 100,
        change_due: 0,
      };

      const result = await transactionService.processSale(mockSale);
      expect(result).toBeDefined();
      expect(result.success).toBe(true);

      // Verify sale was saved
      const savedSale = await dbService.get<Sale>('sales', saleId);
      expect(savedSale).toBeDefined();
      expect(savedSale?.totalAmount).toBe(100);

      // Verify ledger entries were written and are balanced
      const allLedger = await dbService.getAll<any>('ledger');
      const saleEntries = allLedger.filter((e: any) => e.referenceId === saleId);
      expect(saleEntries.length).toBeGreaterThan(0);

      // Verify each ledger entry has valid resolved debit and credit account IDs
      for (const entry of saleEntries) {
        expect(entry.debitAccountId).toBeTruthy();
        expect(entry.creditAccountId).toBeTruthy();
        expect(entry.amount).toBeGreaterThan(0);
      }
    });

    it('successfully creates a sales order and writes balanced ledger entries', async () => {
      const orderId = `ORD-TEST-${Date.now()}`;
      const mockOrder: Order = {
        id: orderId,
        orderNumber: orderId,
        orderDate: new Date().toISOString(),
        date: new Date().toISOString(),
        customerId: 'cust-1',
        customerName: 'Acme Corp',
        status: 'Pending',
        subtotal: 200,
        totalAmount: 200,
        discount: 0,
        paidAmount: 200,
        remainingBalance: 0,
        items: [
          {
            id: 'item-line-1',
            orderId,
            productId: 'prod-1',
            productName: 'Custom Print Job',
            quantity: 4,
            unitPrice: 50,
            subtotal: 200,
            total: 200,
          } as any
        ],
        payments: [
          {
            id: `PAY-${Date.now()}`,
            orderId,
            amountPaid: 200,
            paymentDate: new Date().toISOString(),
            paymentMethod: 'Cash',
            recordedBy: 'Admin',
            reference: 'Initial payment'
          }
        ]
      };

      await transactionService.createOrder(mockOrder);

      // Verify order was saved
      const savedOrder = await dbService.get<Order>('salesOrders', orderId);
      expect(savedOrder).toBeDefined();
      expect(savedOrder?.totalAmount).toBe(200);

      // Verify ledger entries for order
      const allLedger = await dbService.getAll<any>('ledger');
      const orderEntries = allLedger.filter((e: any) => e.referenceId === orderId);
      expect(orderEntries.length).toBeGreaterThan(0);

      for (const entry of orderEntries) {
        expect(entry.debitAccountId).toBeTruthy();
        expect(entry.creditAccountId).toBeTruthy();
        expect(entry.amount).toBeGreaterThan(0);
      }
    });
  });
});

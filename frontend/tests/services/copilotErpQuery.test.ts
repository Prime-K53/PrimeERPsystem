/**
 * copilotErpQuery.test.ts — Comprehensive suite for the general constrained
 * ERP query layer (AI Copilot data capability).
 *
 * Covers: generic operations (count/list/sum/avg/min-max/group-by/
 * distinct/date/status/customer/product), orders, invoices, payments,
 * customers, inventory, relationships, conversational follow-up, context
 * isolation, security (entity/field/SQL/mutation/auth), and failure handling.
 */
import { describe, expect, it } from 'vitest';
import {
  answerCopilotQuestion,
  buildAuthContext,
  buildErpDataset,
  buildIsolatedLlmContext,
  emptyConversation,
  executeErpQuery,
  interpretErpQuery,
  formatCopilotAnswer,
  type ErpQuery,
} from '../../services/erpQuery';
import { ErpQueryError } from '../../services/erpQuery/erpQueryTypes';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const THIS_MONTH = '2026-09-05T10:00:00.000Z';
const LAST_MONTH = '2026-08-10T10:00:00.000Z';

const customers = [
  { id: 'C-1', businessName: 'Acme Printers', contactName: 'Alice', status: 'active' },
  { id: 'C-2', businessName: 'Beta Schools', contactName: 'Bob', status: 'active' },
  { id: 'C-3', businessName: 'Gamma Ltd', contactName: 'Gina', status: 'inactive' },
];

const orders = [
  {
    id: 'SO-001', orderNumber: 'SO-001', customerId: 'C-1', customerName: 'Acme Printers',
    date: THIS_MONTH, orderDate: THIS_MONTH, status: 'Confirmed', paymentStatus: 'Paid',
    totalAmount: 1000, paidAmount: 1000, remainingBalance: 0,
    items: [
      { id: 'OI-1', productId: 'P-EB', name: 'Exercise Book', quantity: 100, price: 5 },
      { id: 'OI-2', productId: 'P-A4', name: 'A4 Paper', quantity: 30, price: 10 },
    ],
  },
  {
    id: 'SO-002', orderNumber: 'SO-002', customerId: 'C-2', customerName: 'Beta Schools',
    date: THIS_MONTH, orderDate: THIS_MONTH, status: 'Pending', paymentStatus: 'Unpaid',
    totalAmount: 500, paidAmount: 0, remainingBalance: 500,
    items: [{ id: 'OI-3', productId: 'P-EB', name: 'Exercise Book', quantity: 50, price: 5 }],
  },
  {
    id: 'SO-003', orderNumber: 'SO-003', customerId: 'C-1', customerName: 'Acme Printers',
    date: LAST_MONTH, orderDate: LAST_MONTH, status: 'Fulfilled', paymentStatus: 'Paid',
    totalAmount: 200, paidAmount: 200, remainingBalance: 0,
    items: [{ id: 'OI-4', productId: 'P-PEN', name: 'Pens', quantity: 80, price: 2 }],
  },
];

const invoices = [
  { id: 'INV-001', invoiceNumber: 'INV-001', customerId: 'C-1', customerName: 'Acme Printers', date: THIS_MONTH, dueDate: THIS_MONTH, status: 'Unpaid', totalAmount: 1000, paidAmount: 200, items: [{ id: 'II-1', productId: 'P-EB', name: 'Exercise Book', quantity: 100, price: 5 }] },
  { id: 'INV-002', invoiceNumber: 'INV-002', customerId: 'C-2', customerName: 'Beta Schools', date: THIS_MONTH, dueDate: THIS_MONTH, status: 'Paid', totalAmount: 400, paidAmount: 400, items: [] },
  { id: 'INV-003', invoiceNumber: 'INV-003', customerId: 'C-1', customerName: 'Acme Printers', date: LAST_MONTH, dueDate: LAST_MONTH, status: 'Overdue', totalAmount: 600, paidAmount: 0, items: [] },
  { id: 'INV-004', invoiceNumber: 'INV-004', customerId: 'C-1', customerName: 'Acme Printers', date: THIS_MONTH, dueDate: THIS_MONTH, status: 'Draft', totalAmount: 9999, paidAmount: 0, items: [] },
];

const customerPayments = [
  { id: 'PAY-001', customerId: 'C-1', customerName: 'Acme Printers', date: THIS_MONTH, amount: 200, paymentMethod: 'Cash', status: 'Cleared', allocations: [{ invoiceId: 'INV-001', amount: 200 }] },
  { id: 'PAY-002', customerId: 'C-2', customerName: 'Beta Schools', date: THIS_MONTH, amount: 400, paymentMethod: 'Bank', status: 'Cleared', allocations: [{ invoiceId: 'INV-002', amount: 400 }] },
  { id: 'PAY-003', customerId: 'C-1', customerName: 'Acme Printers', date: LAST_MONTH, amount: 150, paymentMethod: 'Cash', status: 'Cleared', allocations: [] },
];

const products = [
  { id: 'P-EB', name: 'Exercise Book', sku: 'EB-001', type: 'Stationery', category: 'Books', stock: 1250, cost: 2, price: 5, reorderPoint: 100 },
  { id: 'P-A4', name: 'A4 Paper', sku: 'A4-001', type: 'Raw Material', category: 'Paper', stock: 430, cost: 3, price: 6, reorderPoint: 50 },
  { id: 'P-PEN', name: 'Pens', sku: 'PEN-001', type: 'Stationery', category: 'Writing', stock: 5, cost: 1, price: 2, reorderPoint: 20 },
  { id: 'P-SVC', name: 'Consulting', sku: 'SVC-001', type: 'Service', category: 'Services', stock: 999, cost: 0, price: 100, reorderPoint: 0 },
];

const inventoryTransactions = [
  { id: 'TX-1', itemId: 'P-EB', itemName: 'Exercise Book', type: 'IN', quantity: 500, date: THIS_MONTH, warehouseId: 'WH-MAIN' },
  { id: 'TX-2', itemId: 'P-EB', itemName: 'Exercise Book', type: 'OUT', quantity: 100, date: THIS_MONTH, warehouseId: 'WH-MAIN' },
  { id: 'TX-3', itemId: 'P-A4', itemName: 'A4 Paper', type: 'IN', quantity: 200, date: LAST_MONTH, warehouseId: 'WH-MAIN' },
];

const suppliers = [
  { id: 'S-1', name: 'Paper Mill Ltd', status: 'active' },
  { id: 'S-2', name: 'Ink Corp', status: 'active' },
];

const purchases = [
  { id: 'PO-001', supplierId: 'S-1', supplierName: 'Paper Mill Ltd', date: THIS_MONTH, status: 'Approved', totalAmount: 800, items: [] },
  { id: 'PO-002', supplierId: 'S-2', supplierName: 'Ink Corp', date: LAST_MONTH, status: 'Received', totalAmount: 300, items: [] },
];

const expenses = [
  { id: 'EXP-001', date: THIS_MONTH, description: 'Rent', category: 'Rent', amount: 1000, status: 'Approved' },
  { id: 'EXP-002', date: THIS_MONTH, description: 'Fuel', category: 'Transport', amount: 200, status: 'Approved' },
  { id: 'EXP-003', date: LAST_MONTH, description: 'Rent', category: 'Rent', amount: 1000, status: 'Approved' },
];

const sales = [
  { id: 'SALE-001', customerId: 'C-1', customerName: 'Acme Printers', date: THIS_MONTH, totalAmount: 700, status: 'Completed', items: [] },
  { id: 'SALE-002', customerId: 'C-2', customerName: 'Beta Schools', date: LAST_MONTH, totalAmount: 300, status: 'Completed', items: [] },
];

const baseDatasets = {
  orders, quotations: [], invoices, customerPayments, customers, suppliers, products,
  inventoryTransactions, purchases, expenses, sales,
  deliveryNotes: [], supplierPayments: [], income: [], goodsReceipts: [], shipments: [],
  walletTransactions: [], referrals: [], examinationBatches: [], workOrders: [], boms: [], subscriptions: [],
};

const adminAuth = buildAuthContext({ userId: 'U-1', role: 'Admin', isAdmin: true, checkPermission: () => true });

function ask(question: string, datasets: Record<string, readonly unknown[]> = baseDatasets as never, conversation = emptyConversation()) {
  return answerCopilotQuestion({ question, datasets: datasets as never, auth: adminAuth, conversation, currencySymbol: 'K', now: NOW });
}

function exec(query: ErpQuery, datasets: Record<string, readonly unknown[]> = baseDatasets as never) {
  const ds = buildErpDataset(datasets as never);
  return executeErpQuery(query, ds, adminAuth);
}

// ── 1-11: Generic operations ────────────────────────────────────────────────

describe('generic query operations', () => {
  it('1. count', () => {
    const r = exec({ entity: 'orders', operation: 'count', filters: [], groupBy: [], aggregates: [], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.scalar).toBe(3);
    expect(r.totalCount).toBe(3);
  });

  it('2. list', () => {
    const r = exec({ entity: 'customers', operation: 'list', filters: [], groupBy: [], aggregates: [], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.rows).toHaveLength(3);
    expect(r.truncated).toBe(false);
  });

  it('3. sum', () => {
    const r = exec({ entity: 'invoices', operation: 'sum', filters: [{ field: 'status', operator: 'eq', value: 'paid' }], groupBy: [], aggregates: [{ field: 'totalAmount', operation: 'sum' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.scalar).toBe(400);
  });

  it('4. average', () => {
    const r = exec({ entity: 'expenses', operation: 'average', filters: [], groupBy: [], aggregates: [{ field: 'amount', operation: 'avg' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.scalar).toBeCloseTo(733.33, 1);
  });

  it('5. min/max', () => {
    const ds = buildErpDataset(baseDatasets as never);
    const min = executeErpQuery({ entity: 'expenses', operation: 'minimum', filters: [], groupBy: [], aggregates: [{ field: 'amount', operation: 'min' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null }, ds, adminAuth);
    const max = executeErpQuery({ entity: 'expenses', operation: 'maximum', filters: [], groupBy: [], aggregates: [{ field: 'amount', operation: 'max' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null }, ds, adminAuth);
    expect(min.scalar).toBe(200);
    expect(max.scalar).toBe(1000);
  });

  it('6. group-by aggregation', () => {
    const r = exec({ entity: 'order_items', operation: 'group_by', filters: [], groupBy: ['productName'], aggregates: [{ field: 'quantity', operation: 'sum', as: 'sum_quantity' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    const eb = r.groups.find((g) => g.key.productName === 'Exercise Book');
    expect(eb?.aggregates.sum_quantity).toBe(150);
    expect(r.groups.length).toBeGreaterThanOrEqual(3);
  });

  it('7. distinct count', () => {
    const r = exec({ entity: 'orders', operation: 'distinct_count', filters: [], groupBy: [], aggregates: [{ field: 'customerName', operation: 'distinct_count' }], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.scalar).toBe(2);
  });

  it('8. date filtering (this month)', () => {
    const a = ask('How many orders were there this month?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
    expect(a.text).toContain('this month');
  });

  it('9. status filtering (unpaid invoices)', () => {
    const a = ask('Show unpaid invoices.');
    expect(a.answered).toBe(true);
    // INV-001 (unpaid) + INV-003 (overdue counts as unpaid); draft excluded
    expect(a.result?.totalCount).toBe(2);
  });

  it('10. customer filtering', () => {
    const a = ask('Show orders from customer Acme Printers.');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
  });

  it('11. product filtering', () => {
    const r = exec({ entity: 'order_items', operation: 'list', filters: [{ field: 'productName', operator: 'contains', value: 'Exercise Book' }], groupBy: [], aggregates: [], sort: [], limit: 50, dateScope: null, comparison: null, relationship: null });
    expect(r.totalCount).toBe(2);
  });
});

// ── 12-14: Orders ───────────────────────────────────────────────────────────

describe('orders', () => {
  it('12. order count', () => {
    const a = ask('How many orders do I have?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(3);
    expect(a.text).toMatch(/3 orders/);
  });

  it('13. order item quantity aggregation', () => {
    const a = ask('List all items in the orders and total their quantities.');
    expect(a.answered).toBe(true);
    expect(a.query?.entity).toBe('order_items');
    expect(a.query?.operation).toBe('group_by');
    const eb = a.result?.groups.find((g) => g.key.productName === 'Exercise Book');
    expect(eb?.aggregates.sum_quantity).toBe(150);
    expect(a.text).toContain('Exercise Book');
    expect(a.text).toContain('150');
  });

  it('14. order value aggregation', () => {
    const a = ask('What is the total value of all orders?');
    expect(a.answered).toBe(true);
    expect(a.result?.scalar).toBe(1700);
  });
});

// ── 15-17: Invoices ─────────────────────────────────────────────────────────

describe('invoices', () => {
  it('15. invoice count', () => {
    const a = ask('How many invoices do I have?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(4);
  });

  it('16. unpaid invoice count (draft excluded)', () => {
    const a = ask('How many unpaid invoices are there?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
  });

  it('17. invoice total uses authoritative totals, not order totals', () => {
    const a = ask('What is the total value of all invoices?');
    // All four invoices incl. draft: deterministic sum of stored totals
    expect(a.result?.scalar).toBe(1000 + 400 + 600 + 9999);
    // Unpaid total excludes paid + draft
    const unpaid = ask('What is the total value of unpaid invoices?');
    expect(unpaid.result?.scalar).toBe(1000 + 600);
  });
});

// ── 18-20: Payments ─────────────────────────────────────────────────────────

describe('payments', () => {
  it('18. payment count', () => {
    const a = ask('How many payments did we receive this month?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
  });

  it('19. payment total is deterministic', () => {
    const a = ask('How much money did we receive this month?');
    expect(a.answered).toBe(true);
    expect(a.result?.scalar).toBe(600);
  });

  it('20. payment/customer filtering', () => {
    const a = ask('List payments from customer Acme Printers.');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
    const b = ask('How much has Acme Printers paid?');
    expect(b.answered).toBe(true);
    expect(b.result?.scalar).toBe(350);
  });
});

// ── 21-23: Customers ────────────────────────────────────────────────────────

describe('customers', () => {
  it('21. customer count', () => {
    const a = ask('How many customers do we have?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(3);
  });

  it('22. customer lookup uses canonical businessName, not contact', () => {
    const a = ask('Show customer Acme Printers.');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(1);
    expect(String(a.result?.rows[0]?.businessName)).toBe('Acme Printers');
  });

  it('23. customer-related transaction query', () => {
    const a = ask('What orders does Acme Printers have?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
  });
});

// ── 24-25: Inventory ────────────────────────────────────────────────────────

describe('inventory', () => {
  it('24. stock quantity query respects stock-bearing rules', () => {
    const a = ask('How much stock do we have?');
    expect(a.answered).toBe(true);
    // Exercise Book 1250 + A4 430 + Pens 5 (service excluded from low-stock but counted in raw sum here)
    expect(a.result?.scalar).toBe(1250 + 430 + 5 + 999);
  });

  it('24b. low stock uses reorder points, services never low', () => {
    const a = ask('Which items are low in stock?');
    expect(a.answered).toBe(true);
    const names = (a.result?.rows || []).map((r) => String(r.name));
    expect(names).toContain('Pens');
    expect(names).not.toContain('Consulting');
  });

  it('25. stock movement query', () => {
    const a = ask('What stock movements happened this month?');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(2);
  });
});

// ── 26-30: Relationships ────────────────────────────────────────────────────

describe('relationships', () => {
  it('26. customer → orders', () => {
    const a = ask('What orders does Beta Schools have?');
    expect(a.result?.totalCount).toBe(1);
    expect(String(a.result?.rows[0]?.customerName)).toContain('Beta');
  });

  it('27. customer → invoices', () => {
    const r = exec({
      entity: 'invoices', operation: 'list', filters: [], groupBy: [], aggregates: [], sort: [], limit: 50,
      dateScope: null, comparison: null,
      relationship: { parentEntity: 'customers', parentName: 'Acme Printers', via: 'customer_invoices' },
    });
    expect(r.totalCount).toBe(3); // incl. draft
  });

  it('28. invoice → payments via allocations (authoritative)', () => {
    const a = ask('What payments were allocated to invoice INV-001?');
    expect(a.answered).toBe(true);
    expect(a.query?.entity).toBe('customer_payments');
    expect(a.result?.totalCount).toBe(1);
    expect(String(a.result?.rows[0]?.id)).toBe('PAY-001');
  });

  it('29. order → items', () => {
    const r = exec({
      entity: 'order_items', operation: 'list', filters: [], groupBy: [], aggregates: [], sort: [], limit: 50,
      dateScope: null, comparison: null,
      relationship: { parentEntity: 'orders', parentId: 'SO-001', via: 'item_order' },
    });
    expect(r.totalCount).toBe(2);
  });

  it('30. order → related invoice linkage does not guess', () => {
    const r = exec({
      entity: 'invoices', operation: 'list', filters: [], groupBy: [], aggregates: [], sort: [], limit: 50,
      dateScope: null, comparison: null,
      relationship: { parentEntity: 'orders', parentId: 'SO-999', via: 'order_invoice' },
    });
    expect(r.totalCount).toBe(0);
  });
});

// ── 31: Conversational follow-up ────────────────────────────────────────────

describe('conversational context', () => {
  it('31. filtered question followed by contextual follow-up', () => {
    const first = ask('How many orders did we have this month?');
    expect(first.answered).toBe(true);
    expect(first.result?.totalCount).toBe(2);
    const second = answerCopilotQuestion({
      question: 'What items were in them?',
      datasets: baseDatasets as never,
      auth: adminAuth,
      conversation: first.conversation,
      currencySymbol: 'K',
      now: NOW,
    });
    expect(second.answered).toBe(true);
    expect(second.query?.entity).toBe('order_items');
    // Inherits this-month scope: SO-001 (2 lines) + SO-002 (1 line)
    expect(second.result?.totalCount).toBe(3);
  });
});

// ── 32-33: Context isolation ────────────────────────────────────────────────

describe('context isolation', () => {
  it('32. order query does not inject invoice facts', () => {
    const a = ask('How many orders do I have?');
    expect(a.answered).toBe(true);
    expect(a.result?.factsUsed).toEqual(['orders']);
    expect(a.llmContext || '').not.toMatch(/INV-001|PAY-001/);
    expect(a.llmContext || '').toMatch(/order/i);
  });

  it('33. unrelated Copilot purposes remain isolated', () => {
    // The isolated LLM context for an orders question carries no customer
    // contact/PII, no payment methods, no verification URLs.
    const a = ask('List all orders.');
    const ctx = buildIsolatedLlmContext(a.query!, a.result!, 'K');
    expect(ctx).not.toMatch(/verification|paymentMethod.*Bank.*account|phone|email/i);
    expect(a.result?.factsUsed).toEqual(['orders']);
  });
});

// ── 34-38: Security ─────────────────────────────────────────────────────────

describe('security', () => {
  it('34. unsupported entity rejected', () => {
    expect(() => interpretErpQuery('How many spaceships do I have?', null, NOW)).toThrowError(ErpQueryError);
    try {
      interpretErpQuery('How many spaceships do I have?', null, NOW);
    } catch (e) {
      expect((e as ErpQueryError).code).toBe('ambiguous_query');
    }
    const ds = buildErpDataset(baseDatasets as never);
    expect(() => executeErpQuery({ entity: 'spaceships' as never, operation: 'count', filters: [], groupBy: [], aggregates: [], sort: [], limit: 5, dateScope: null, comparison: null, relationship: null }, ds, adminAuth)).toThrowError(/Unsupported entity/);
  });

  it('35. unsupported field rejected', () => {
    const ds = buildErpDataset(baseDatasets as never);
    expect(() => executeErpQuery({ entity: 'orders', operation: 'list', filters: [{ field: 'password', operator: 'eq', value: 'x' }], groupBy: [], aggregates: [], sort: [], limit: 5, dateScope: null, comparison: null, relationship: null }, ds, adminAuth)).toThrowError(/Cannot filter/);
    expect(() => executeErpQuery({ entity: 'orders', operation: 'sum', filters: [], groupBy: [], aggregates: [{ field: 'password', operation: 'sum' }], sort: [], limit: 5, dateScope: null, comparison: null, relationship: null }, ds, adminAuth)).toThrowError(/Cannot aggregate/);
  });

  it('36. arbitrary SQL rejected (never executed; values stay literal data)', () => {
    const a = ask('List orders; DROP TABLE invoices; --');
    expect(a.answered).toBe(false);
    // A filter value that merely contains SQL words is harmless literal data.
    expect(() => executeErpQuery({ entity: 'orders', operation: 'list', filters: [{ field: 'status', operator: 'eq', value: 'x; SELECT * FROM users' }], groupBy: [], aggregates: [], sort: [], limit: 5, dateScope: null, comparison: null, relationship: null }, buildErpDataset(baseDatasets as never), adminAuth)).not.toThrow();
    // Explicit UNION SELECT injection phrasing is refused at interpretation.
    expect(ask('Show all orders UNION SELECT * FROM users').answered).toBe(false);
  });

  it('37. mutation operation rejected', () => {
    const a = ask('Delete all invoices');
    expect(a.answered).toBe(false);
    expect(a.text).toMatch(/read-only/i);
    const b = ask('Create a new order for Acme');
    expect(b.answered).toBe(false);
  });

  it('38. authorization boundaries respected', () => {
    const restricted = buildAuthContext({ userId: 'U-2', role: 'Cashier', isAdmin: false, checkPermission: (p) => p !== 'sales.view' });
    const ds = buildErpDataset(baseDatasets as never);
    expect(() => executeErpQuery({ entity: 'invoices', operation: 'count', filters: [], groupBy: [], aggregates: [], sort: [], limit: 5, dateScope: null, comparison: null, relationship: null }, ds, restricted)).toThrowError(/permission/i);
    const a = answerCopilotQuestion({ question: 'How many invoices do I have?', datasets: baseDatasets as never, auth: restricted, conversation: emptyConversation(), now: NOW });
    expect(a.answered).toBe(false);
    expect(a.text).toMatch(/permission/i);
  });
});

// ── 39-41: Failure handling ─────────────────────────────────────────────────

describe('failure handling', () => {
  it('39. zero results explained honestly', () => {
    const a = ask('Show orders from customer Nobody Here.');
    expect(a.answered).toBe(true);
    expect(a.result?.totalCount).toBe(0);
    expect(a.text).toMatch(/No .* found/);
  });

  it('40. query failure (missing dataset) reports unavailable, never fabricates', () => {
    const a = answerCopilotQuestion({ question: 'How many work orders do we have?', datasets: {}, auth: adminAuth, conversation: emptyConversation(), now: NOW });
    expect(a.answered).toBe(false);
    expect(a.text).toMatch(/could not be retrieved|unavailable|available/i);
    expect(a.text).not.toMatch(/You have \d+ work orders/);
  });

  it('41. ambiguous query asks for clarification', () => {
    const a = ask('How many do I have?');
    expect(a.answered).toBe(false);
    expect(a.clarification || a.text).toMatch(/which ERP records|orders.*invoices|could not tell/i);
  });
});

// ── Presentation honesty ────────────────────────────────────────────────────

describe('presentation', () => {
  it('large datasets are truncated honestly, never claimed complete', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `INV-X${i}`, customerId: 'C-1', customerName: 'Acme Printers', date: THIS_MONTH, status: 'Unpaid', totalAmount: 10, paidAmount: 0 }));
    const a = ask('List all invoices.', { ...baseDatasets, invoices: many } as never);
    expect(a.result?.truncated).toBe(true);
    expect(a.result?.totalCount).toBe(120);
    expect(a.text).toMatch(/120/);
    expect(a.text).toMatch(/Showing \d+ of 120/);
  });

  it('date-scoped answers state their scope', () => {
    const a = ask('What is the total value of all invoices this month?');
    expect(a.text).toMatch(/this month/);
  });

  it('formatCopilotAnswer renders grouped totals deterministically', () => {
    const q = interpretErpQuery('List all items in the orders and total their quantities.', null, NOW).query;
    const r = exec(q);
    const text = formatCopilotAnswer(q, r, 'K');
    expect(text).toContain('Exercise Book');
    expect(text).toContain('Total quantity');
  });
});

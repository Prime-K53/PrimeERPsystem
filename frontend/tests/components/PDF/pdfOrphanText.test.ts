/**
 * pdfOrphanText.test.ts — structural sweep for orphan text in PDF trees.
 *
 * @react-pdf/renderer drops (with a console warning like
 * "Invalid '0' string child outside <Text> component") any string/number
 * child of a non-text host (View/Page/Document). The usual cause is a
 * numeric short-circuit such as `{count && <View/>}` rendering 0.
 *
 * This walks the PrimeDocument element tree for every common document type
 * (no PDF render needed) and fails on any string/number found directly
 * under a non-text host. Numbers and strings inside Text/Link/TSpan are
 * legitimate and ignored.
 */
import { describe, expect, it } from 'vitest';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import {
  buildCustomerReceiptDoc,
  buildPosReceiptDoc,
  buildSupplierPaymentDoc,
  calculateCustomerPaymentSnapshot,
} from '../../../services/receiptCalculationService';

const TOK = 'c'.repeat(64);

const TEXT_PARENTS = new Set(['TEXT', 'LINK', 'TSPAN', 'NOTE']);

interface Orphan {
  path: string;
  value: string;
}

function childName(node: unknown): string {
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const t = el?.type;
  if (typeof t === 'string') return t;
  if (t && typeof t === 'object') {
    const name = (t as { displayName?: string; name?: string }).displayName
      || (t as { name?: string }).name
      || 'object-component';
    return `<${name}>`;
  }
  if (typeof t === 'function') return `<${(t as { name?: string }).name || 'fn'}>`;
  return typeof node;
}

function walk(node: unknown, parentType: string, path: string, out: Orphan[]): void {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, parentType, `${path}[${i}]`, out));
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') {
    if (!TEXT_PARENTS.has(parentType)) {
      if (typeof node === 'number' || node.trim() !== '') {
        out.push({ path, value: JSON.stringify(node).slice(0, 80) });
      }
    }
    return;
  }
  if (typeof node !== 'object') return;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  const name = childName(node);
  const kids = el.props?.children;
  if (typeof el.type === 'function') {
    try {
      const rendered = (el.type as (p: Record<string, unknown>) => unknown)({ ...(el.props || {}) });
      walk(rendered, name, `${path}>${name}`, out);
    } catch {
      // Host primitive or hookful component: inspect props, keep children.
      walk(kids, name, `${path}>${name}/c`, out);
    }
    return;
  }
  if (el.type && typeof el.type === 'object') {
    // memo/forwardRef-style objects: do not invoke, keep children.
    walk(kids, name, `${path}>${name}/c`, out);
    return;
  }
  walk(kids, typeof el.type === 'string' ? el.type : name, `${path}>${name}`, out);
}

function orphansFor(type: string, data: unknown): Orphan[] {
  const root = (PrimeDocument as (p: Record<string, unknown>) => unknown)({
    type,
    data,
    configOverride: null,
    colorMode: 'brand',
  });
  const out: Orphan[] = [];
  walk(root, 'ROOT', type, out);
  return out;
}

const invoiceRecord: any = {
  id: 'INV-ORPH-001',
  invoiceNumber: 'INV-ORPH-001',
  date: '2026-09-01',
  customerName: 'Orphan Sweep School',
  items: [{ desc: 'A4 Paper Ream', qty: 2, price: 5000, total: 10000 }],
  subtotal: 10000,
  totalAmount: 10000,
  paidAmount: 0,
  status: 'Unpaid',
  verificationToken: TOK,
};

const statementData: any = {
  statementNumber: 'STMT-ORPH-010',
  date: '2026-01-31',
  customerName: 'Demo School',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  currency: 'MWK',
  openingBalance: 0,
  transactions: [
    { date: '2026-01-19', reference: 'INV-P726/025', memo: 'Invoice', debit: 160000, credit: 0, runningBalance: 160000 },
  ],
  totalInvoiced: 160000,
  totalReceived: 0,
  finalBalance: 160000,
  status: 'VALID',
  verificationToken: TOK,
};

const fiscalData: any = {
  reportName: 'Orphan Fiscal Report',
  period: 'Jan 2026',
  date: '2026-01-31',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  currency: 'MWK',
  sections: [
    { title: 'Revenue', rows: [{ label: 'Sales', amount: 500000, isTotal: false, indent: false }] },
  ],
  netPerformance: { label: 'Net Surplus', amount: 120000, prevAmount: 90000 },
  verificationToken: TOK,
};

const receiptDoc: any = buildCustomerReceiptDoc({
  payment: {
    id: 'PAY-ORPH-001', date: '2026-02-10', customerName: 'Orphan Sweep School',
    amount: 25000, paymentMethod: 'Cash', verificationToken: TOK,
    allocations: [{ invoiceId: 'INV-ORPH-900', amount: 25000 }],
  } as any,
  snapshot: calculateCustomerPaymentSnapshot({
    amountTendered: 25000,
    appliedInvoices: [{ invoiceId: 'INV-ORPH-900', allocationAmount: 25000, outstandingAmount: 25000 }],
    paymentDate: '2026-02-10',
    customerName: 'Orphan Sweep School',
  }),
  customerName: 'Orphan Sweep School',
  currencySymbol: 'K',
});

const posDoc: any = buildPosReceiptDoc({
  sale: {
    id: 'POS-ORPH-001',
    items: [{ desc: 'Photocopy A4', qty: 0, price: 150, total: 0 }],
    subtotal: 0,
    totalAmount: 0,
    discount: 0,
  } as any,
  cashierName: 'Test Cashier',
});

const supplierDoc: any = buildSupplierPaymentDoc(
  {
    id: 'SPAY-ORPH-001', date: '2026-02-10', amount: 0, paymentMethod: 'Cash',
    allocations: [],
  } as any,
  'Orphan Supplier',
);

describe('pdf orphan text sweep', () => {
  const cases: Array<[string, unknown]> = [
    ['INVOICE', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'INVOICE' as any)],
    ['QUOTATION', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'QUOTATION' as any)],
    ['ORDER', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'ORDER' as any)],
    ['SALES_ORDER', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'SALES_ORDER' as any)],
    ['PO', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'PO' as any)],
    ['DELIVERY_NOTE', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'DELIVERY_NOTE' as any)],
    ['WORK_ORDER', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'WORK_ORDER' as any)],
    ['SUBSCRIPTION', mapToInvoiceData({ ...invoiceRecord }, {} as any, 'SUBSCRIPTION' as any)],
    ['RECEIPT', receiptDoc],
    ['POS_RECEIPT', posDoc],
    ['SUPPLIER_PAYMENT', supplierDoc],
    ['ACCOUNT_STATEMENT', statementData],
    ['ACCOUNT_STATEMENT_SUMMARY', statementData],
    ['FISCAL_REPORT', fiscalData],
  ];

  for (const [type, data] of cases) {
    it(`${type} has no orphan string/number children`, () => {
      expect(orphansFor(type, data)).toEqual([]);
    });
  }
});

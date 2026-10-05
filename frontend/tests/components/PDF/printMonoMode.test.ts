/**
 * printMonoMode.test.ts — black-and-white print mode proof.
 *
 * Preview/download keep brand colors; the Print action re-renders with
 * colorMode 'mono' (every text pure black, fills white, rules black,
 * logo/QR images untouched).
 *
 * PDF content streams are Flate-compressed, so this asserts one level up:
 * it resolves the template element tree (all template components are
 * hook-free pure functions) and collects every style color. In mono mode
 * zero non-black-white colors may remain; in brand mode colors must be
 * present (proves the walker actually sees colors — the test is not
 * vacuous).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { mapToInvoiceData } from '../../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../../utils/documentSecurity';
import {
  buildPosReceiptDoc,
  buildCustomerReceiptDoc,
  calculateCustomerPaymentSnapshot,
} from '../../../services/receiptCalculationService';
import {
  monoText,
  monoFill,
  monoLine,
  monoInk,
} from '../../../views/shared/components/PDF/pdfPrintMode';

const TOK = 'd'.repeat(64);
const COMPANY = 'Prime Printing Service';

const COLOR_KEYS = [
  'color',
  'backgroundColor',
  'borderColor',
  'borderTopColor',
  'borderBottomColor',
  'borderLeftColor',
  'borderRightColor',
] as const;

function flattenStyle(style: unknown, out: Record<string, unknown>[]): void {
  if (!style) return;
  if (Array.isArray(style)) {
    style.forEach((s) => flattenStyle(s, out));
    return;
  }
  if (typeof style === 'object') out.push(style as Record<string, unknown>);
}

function checkValue(kind: string, value: unknown, path: string, offenders: string[]): void {
  if (typeof value !== 'string') return;
  const v = value.toLowerCase();
  if (kind === 'color') {
    if (v !== '#000') offenders.push(`${path} text ${value}`);
  } else if (kind === 'backgroundColor') {
    // #000 fills are the solid icon badges (tick) which keep a dark fill
    // with a light glyph in mono mode; everything else must be white.
    if (v !== '#fff' && v !== '#ffffff' && v !== '#000' && v !== 'transparent') offenders.push(`${path} fill ${value}`);
  } else if (v !== '#000' && v !== '#fff' && v !== '#ffffff') {
    offenders.push(`${path} border ${value}`);
  }
}

/** Recursively resolve hook-free function components and collect style colors. */
function walk(node: unknown, path: string, offenders: string[]): void {
  if (node == null || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => walk(child, `${path}[${i}]`, offenders));
    return;
  }
  if (typeof node === 'string' || typeof node === 'number') return;
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (typeof el.type === 'function') {
    const name = (el.type as { name?: string }).name || 'fn';
    try {
      walk((el.type as (p: unknown) => unknown)(el.props), `${path}>${name}`, offenders);
    } catch {
      // Host primitive (e.g. react-pdf internals): inspect props, keep children.
      inspectProps(el.props, `${path}>${name}`, offenders);
      walk((el.props as Record<string, unknown> | undefined)?.children, `${path}>${name}/c`, offenders);
    }
    return;
  }
  inspectProps(el.props, path, offenders);
  walk((el.props as Record<string, unknown> | undefined)?.children, path, offenders);
}

function inspectProps(props: Record<string, unknown> | undefined, path: string, offenders: string[]): void {
  if (!props) return;
  const flat: Record<string, unknown>[] = [];
  flattenStyle(props.style, flat);
  flat.forEach((st) => {
    COLOR_KEYS.forEach((k) => {
      if (k in st) checkValue(k, st[k], path, offenders);
    });
  });
}

function collectMonoColors(type: string, data: unknown, configOverride?: unknown): string[] {
  const root = (PrimeDocument as (p: Record<string, unknown>) => unknown)({
    type,
    data,
    configOverride: (configOverride as never) ?? null,
    colorMode: 'mono',
  });
  const offenders: string[] = [];
  walk(root, type, offenders);
  return offenders;
}

const invoiceRecord: any = {
  id: 'INV-MONO-001',
  invoiceNumber: 'INV-MONO-001',
  date: '2026-09-01',
  customerName: 'Mono Print School',
  items: [{ desc: 'A4 Paper Ream', qty: 2, price: 5000, total: 10000 }],
  subtotal: 10000,
  totalAmount: 10000,
  paidAmount: 0,
  status: 'Unpaid',
  verificationToken: TOK,
};

async function securedInvoice(overrides: Record<string, unknown> = {}): Promise<any> {
  const mapped: any = mapToInvoiceData({ ...invoiceRecord, ...overrides }, {} as any, 'INVOICE' as any);
  return attachDocumentSecurity(mapped, COMPANY);
}

const statementData: any = {
  statementNumber: 'STMT-MONO-010',
  date: '2026-01-31',
  customerName: 'Demo School',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  currency: 'MWK',
  openingBalance: 0,
  transactions: [
    {
      date: '2026-01-19',
      reference: 'INV-P726/025',
      memo: 'Invoice INV-P726/025',
      debit: 160000,
      credit: 0,
      runningBalance: 160000,
    },
  ],
  totalInvoiced: 160000,
  totalReceived: 0,
  finalBalance: 160000,
  status: 'VALID',
  verificationToken: TOK,
};

const fiscalData: any = {
  reportName: 'Mono Fiscal Report',
  period: 'Jan 2026',
  date: '2026-01-31',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  currency: 'MWK',
  sections: [
    {
      title: 'Revenue',
      rows: [
        { label: 'Sales', amount: 500000, isTotal: false, indent: false },
        { label: 'Total Revenue', amount: 500000, isTotal: true, prevAmount: 450000 },
      ],
    },
  ],
  netPerformance: { label: 'Net Surplus', amount: 120000, prevAmount: 90000 },
  verificationToken: TOK,
};

describe('print mono mode helpers', () => {
  it('maps to black/white only in mono, identity in brand', () => {
    expect(monoText('mono', '#1e3a8a')).toBe('#000');
    expect(monoFill('mono', '#f8fafc')).toBe('#fff');
    expect(monoLine('mono', '#e2e8f0')).toBe('#000');
    expect(monoInk('mono', '#10b981')).toBe('#000');
    expect(monoText('brand', '#1e3a8a')).toBe('#1e3a8a');
    expect(monoFill('brand', '#f8fafc')).toBe('#f8fafc');
    expect(monoLine('brand', '#e2e8f0')).toBe('#e2e8f0');
    expect(monoInk('brand', '#10b981')).toBe('#10b981');
    expect(monoText(undefined, '#1e3a8a')).toBe('#1e3a8a');
  });
});

describe('print mono mode element tree', () => {
  it('brand invoice tree contains colors (walker sanity)', async () => {
    const secured = await securedInvoice();
    const root = (PrimeDocument as (p: Record<string, unknown>) => unknown)({
      type: 'INVOICE',
      data: secured,
      colorMode: 'brand',
    });
    const offenders: string[] = [];
    walk(root, 'INVOICE', offenders);
    expect(offenders.length).toBeGreaterThan(0);
  }, 120000);

  it('mono invoice tree (all engines) has zero chromatic colors', async () => {
    const secured = await securedInvoice();
    for (const engine of [undefined, 'Clean', 'Modern', 'Professional'] as const) {
      const config = engine ? ({ invoiceTemplates: { engine } } as any) : null;
      expect(collectMonoColors('INVOICE', secured, config)).toEqual([]);
    }
  }, 180000);

  it('mono cancelled + portal invoice has zero chromatic colors', async () => {
    const secured = await securedInvoice({ status: 'Cancelled' });
    const root = (PrimeDocument as (p: Record<string, unknown>) => unknown)({
      type: 'INVOICE',
      data: secured,
      colorMode: 'mono',
      channel: 'portal',
    });
    const offenders: string[] = [];
    walk(root, 'INVOICE-cancelled-portal', offenders);
    expect(offenders).toEqual([]);
  }, 120000);

  it('mono quotation / delivery note / order have zero chromatic colors', async () => {
    for (const type of ['QUOTATION', 'DELIVERY_NOTE', 'ORDER'] as const) {
      const mapped: any = mapToInvoiceData({ ...invoiceRecord }, {} as any, type as any);
      const secured: any = await attachDocumentSecurity(mapped, COMPANY);
      expect(collectMonoColors(type, secured)).toEqual([]);
    }
  }, 180000);

  it('mono receipt has zero chromatic colors', async () => {
    const snapshot = calculateCustomerPaymentSnapshot({
      amountTendered: 70000,
      appliedInvoices: [{ invoiceId: 'INV-P726/031', allocationAmount: 70000, outstandingAmount: 403000 }],
      paymentDate: '2026-01-24',
      customerName: 'Mono Print School',
    });
    const doc: any = buildCustomerReceiptDoc({
      payment: {
        id: 'PAY-MONO-031',
        date: '2026-01-24',
        customerName: 'Mono Print School',
        amount: 70000,
        paymentMethod: 'Cash',
        verificationToken: TOK,
        allocations: [{ invoiceId: 'INV-P726/031', amount: 70000 }],
      },
      snapshot,
      customerName: 'Mono Print School',
      currencySymbol: 'K',
    });
    const secured: any = await attachDocumentSecurity(doc, COMPANY);
    expect(collectMonoColors('RECEIPT', secured)).toEqual([]);
  }, 120000);

  it('mono POS receipt has zero chromatic colors', async () => {
    const payload: any = buildPosReceiptDoc({
      sale: {
        id: 'POS-MONO-001',
        items: [{ desc: 'Photocopy A4', qty: 10, price: 150, total: 1500 }],
        subtotal: 1500,
        totalAmount: 1500,
      },
      cashierName: 'Test Cashier',
    });
    expect(collectMonoColors('POS_RECEIPT', payload)).toEqual([]);
  }, 120000);

  it('mono statements have zero chromatic colors', async () => {
    expect(collectMonoColors('ACCOUNT_STATEMENT', statementData)).toEqual([]);
    expect(collectMonoColors('ACCOUNT_STATEMENT_SUMMARY', statementData)).toEqual([]);
  }, 120000);

  it('mono fiscal report has zero chromatic colors', async () => {
    expect(collectMonoColors('FISCAL_REPORT', fiscalData)).toEqual([]);
  }, 120000);

  it('mono invoice still renders a valid PDF', async () => {
    const secured = await securedInvoice();
    const element = createElement(PrimeDocument as any, { type: 'INVOICE', data: secured, colorMode: 'mono' });
    const blob = await (pdf(element as any) as any).toBlob();
    expect(blob.size).toBeGreaterThan(0);
    // jsdom Blobs lack arrayBuffer/slice-buffer support, so verify the
    // header through the string renderer (same engine, same element).
    const str = String(await (pdf(element as any) as any).toString());
    expect(str.slice(0, 5)).toBe('%PDF-');
  }, 120000);
});

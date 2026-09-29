/**
 * statementBillDetails.test.ts — Customer Statement PDF Bill Details parity.
 *
 * Regression: snapshot transactions froze bill-details `items[]`, but
 * `safeOpenPreview('ACCOUNT_STATEMENT', …)` validated with a StatementSchema
 * whose transaction elements stripped unknown keys — so the PDF renderer
 * never received the lines even with Bill Details ON.
 */
import { describe, it, expect } from 'vitest';
import React from 'react';
import { pdf } from '@react-pdf/renderer';
import { PrimeDocument } from '../../../views/shared/components/PDF/PrimeDocument';
import { StatementSchema } from '../../../views/shared/components/PDF/schemas';
import { useDocumentStore } from '../../../stores/documentStore';
import { norm, analysePages } from './pdfAnalyse';

const TOK = 'b'.repeat(64);

const baseTxn = {
  date: '2026-01-19',
  reference: 'INV-P726/025',
  memo: 'Invoice INV-P726/025',
  debit: 160000,
  credit: 0,
  runningBalance: 160000,
};

const billDetails = {
  originalDate: '2026-01-19',
  status: 'Unpaid',
  items: [
    { description: 'Scheme Pad', qty: null, price: null, total: 120000 },
    { description: 'Chalk (box)', qty: 10, price: 4000, total: 40000 },
  ],
};

const snapshotOff: any = {
  statementNumber: 'STMT-P726-010',
  date: '2026-01-31',
  customerName: 'Demo School',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
  currency: 'MWK',
  openingBalance: 0,
  transactions: [{ ...baseTxn }],
  totalInvoiced: 160000,
  totalReceived: 0,
  finalBalance: 160000,
  status: 'VALID',
  verificationToken: TOK,
};

const snapshotOn: any = {
  ...snapshotOff,
  transactions: [{ ...baseTxn, ...billDetails }],
};

async function renderStatementText(data: any): Promise<string> {
  const str = (await pdf(
    React.createElement(PrimeDocument as any, { type: 'ACCOUNT_STATEMENT', data })
  ).toString()) as unknown as string;
  const pages = analysePages(Buffer.from(str, 'latin1'));
  return norm(pages.map((p) => p.text).join(' '));
}

describe('statement PDF bill details parity', () => {
  it('A. Bill Details OFF: no items/originalDate, summary unchanged', () => {
    const parsed = StatementSchema.safeParse(snapshotOff);
    expect(parsed.success).toBe(true);
    const txn: any = (parsed as any).data.transactions[0];
    expect('items' in txn).toBe(false);
    expect('originalDate' in txn).toBe(false);
    expect(txn.debit).toBe(160000);
    expect(txn.runningBalance).toBe(160000);
    expect((parsed as any).data.finalBalance).toBe(160000);
  });

  it('B/F. Bill Details ON: items/originalDate/status survive safeParse (fails pre-fix)', () => {
    expect(snapshotOn.transactions[0].items).toHaveLength(2);
    const parsed = StatementSchema.safeParse(snapshotOn);
    expect(parsed.success).toBe(true);
    const txn: any = (parsed as any).data.transactions[0];
    expect(txn.items).toEqual(billDetails.items);
    expect(txn.originalDate).toBe('2026-01-19');
    expect(txn.status).toBe('Unpaid');
  });

  it('F. the exact preview-opening path preserves items', () => {
    const store = useDocumentStore.getState();
    const result = store.safeOpenPreview('ACCOUNT_STATEMENT', snapshotOn);
    expect(result.success).toBe(true);
    const data: any = useDocumentStore.getState().data;
    expect(data.transactions[0].items).toEqual(billDetails.items);
    expect(data.transactions[0].originalDate).toBe('2026-01-19');
    expect(data.transactions[0].status).toBe('Unpaid');
    useDocumentStore.getState().closePreview();
  });

  it('C. PDF renders Original date, Status and line items when ON', async () => {
    const parsed: any = StatementSchema.safeParse(snapshotOn).data;
    const text = await renderStatementText(parsed);
    expect(text).toContain(norm('Original date'));
    expect(text).toContain(norm('19/01/2026'));
    expect(text).toContain(norm('Unpaid'));
    expect(text).toContain(norm('Scheme Pad'));
    expect(text).toContain(norm('Chalk (box)'));
    expect(text).toContain(norm('MWK 120,000.00'));
    expect(text).toContain(norm('MWK 40,000.00'));
  }, 120000);

  it('C. PDF omits the bill-details block when OFF', async () => {
    const parsed: any = StatementSchema.safeParse(snapshotOff).data;
    const text = await renderStatementText(parsed);
    expect(text).not.toContain(norm('Original date'));
    expect(text).not.toContain(norm('Scheme Pad'));
    expect(text).toContain(norm('INV-P726/025'));
  }, 120000);

  it('D. enabling Bill Details changes no financial values', () => {
    const off: any = StatementSchema.safeParse(snapshotOff).data;
    const on: any = StatementSchema.safeParse(snapshotOn).data;
    for (const key of ['debit', 'credit', 'runningBalance'] as const) {
      expect(on.transactions[0][key]).toBe(off.transactions[0][key]);
    }
    for (const key of ['totalInvoiced', 'totalReceived', 'finalBalance', 'openingBalance'] as const) {
      expect(on[key]).toBe(off[key]);
    }
  });
});

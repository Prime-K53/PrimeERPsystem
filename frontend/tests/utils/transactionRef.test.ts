import { describe, it, expect } from 'vitest';
import {
  TX_ID_PARAM,
  TX_NUMBER_PARAM,
  TX_REF_PARAM,
  TRANSACTION_REF_TYPES,
  isResolvableTransactionRef,
  lookupRecordByRef,
  normalizeRefKey,
  normalizeTransactionRefType,
  readTransactionRefFromSearch,
  resolveOriginatingTransactionRef,
  resolveTransactionDestination,
  transactionRefLabel,
} from '../../utils/transactionRef';

describe('normalizeTransactionRefType', () => {
  it('accepts canonical types', () => {
    expect(normalizeTransactionRefType('invoice')).toBe('invoice');
    expect(normalizeTransactionRefType('  QUOTATION ')).toBe('quotation');
    expect(normalizeTransactionRefType('delivery-note')).toBe('delivery-note');
  });

  it('accepts common aliases used across the ERP', () => {
    expect(normalizeTransactionRefType('Invoice')).toBe('invoice');
    expect(normalizeTransactionRefType('INV')).toBe('invoice');
    expect(normalizeTransactionRefType('purchase_order')).toBe('purchase-order');
    expect(normalizeTransactionRefType('PO')).toBe('purchase-order');
    expect(normalizeTransactionRefType('DN')).toBe('delivery-note');
    expect(normalizeTransactionRefType('CustomerPayment')).toBe('payment');
    expect(normalizeTransactionRefType('SupplierPayment')).toBe('supplier-payment');
    expect(normalizeTransactionRefType('JobOrder')).toBe('job-order');
    expect(normalizeTransactionRefType('GoodsReceipt')).toBe('grn');
    expect(normalizeTransactionRefType('batch_number')).toBe('examination-batch');
  });

  it('rejects unknown and empty types rather than guessing', () => {
    expect(normalizeTransactionRefType('')).toBeNull();
    expect(normalizeTransactionRefType('   ')).toBeNull();
    expect(normalizeTransactionRefType('ledger')).toBeNull();
    expect(normalizeTransactionRefType('42')).toBeNull();
  });
});

describe('resolveTransactionDestination', () => {
  it('maps each supported type to its existing ERP route', () => {
    const cases: Array<[string, string]> = [
      ['invoice', '/sales-flow/invoices'],
      ['examination-invoice', '/sales-flow/invoices'],
      ['quotation', '/sales-flow/quotations'],
      ['order', '/sales-flow/orders'],
      ['job-order', '/sales-flow/sales-orders'],
      ['payment', '/sales-flow/payments'],
      ['receipt', '/sales-flow/payments'],
      ['supplier-payment', '/procurement/payments'],
      ['purchase', '/procurement/bills'],
      ['purchase-order', '/procurement/bills'],
      ['grn', '/supply-chain/grn'],
      ['delivery-note', '/supply-chain/shipping'],
    ];
    for (const [type, route] of cases) {
      const dest = resolveTransactionDestination({ type, id: 'X1' });
      expect(dest, type).not.toBeNull();
      expect(dest!.pathname.startsWith(route), type).toBe(true);
    }
  });

  it('refuses to resolve without any identity', () => {
    expect(resolveTransactionDestination({ type: 'invoice' })).toBeNull();
    expect(resolveTransactionDestination({ type: 'invoice', id: '  ', number: '' })).toBeNull();
  });

  it('refuses unknown types even when a number is present', () => {
    expect(resolveTransactionDestination({ type: 'widget', number: 'ABC-1' })).toBeNull();
  });

  it('percent-encodes references containing slashes and specials', () => {
    const dest = resolveTransactionDestination({
      type: 'invoice',
      id: 'INV-P726/021',
      number: 'INV-P726/021',
    })!;
    expect(dest.search).toContain(`${TX_REF_PARAM}=invoice`);
    // The raw slash must never appear unencoded in the query string.
    expect(dest.search.split(`${TX_ID_PARAM}=`)[1].split('&')[0]).toBe('INV-P726%2F021');
    expect(dest.to).not.toContain('INV-P726/021?');
  });

  it('builds a round-trippable contract', () => {
    const dest = resolveTransactionDestination({
      type: 'quotation',
      id: 'q-1',
      number: 'QT-P726/0007',
    })!;
    const parsed = readTransactionRefFromSearch(dest.search);
    expect(parsed).toEqual({ type: 'quotation', id: 'q-1', number: 'QT-P726/0007' });
  });

  it('addresses examination batches directly by path when the id is known', () => {
    const dest = resolveTransactionDestination({ type: 'examination-batch', id: 'batch-9' })!;
    expect(dest.pathname).toBe('/examination/batches/batch-9');
    expect(dest.search).toBe('');
  });

  it('falls back to the module list when only a batch number is known', () => {
    const dest = resolveTransactionDestination({ type: 'examination-batch', number: 'EXM-P726/0001' })!;
    expect(dest.pathname).toBe('/examination/batches');
    expect(dest.search).toContain('txNo=EXM-P726%2F0001');
  });

  it('preserves destination filters already present in the query string', () => {
    const dest = resolveTransactionDestination({
      type: 'invoice',
      id: 'INV-1',
      preserveSearch: '?accountId=1000&tab=history',
    })!;
    const sp = new URLSearchParams(dest.search.slice(1));
    expect(sp.get('accountId')).toBe('1000');
    expect(sp.get('tab')).toBe('history');
    expect(sp.get(TX_REF_PARAM)).toBe('invoice');
  });

  it('isResolvableTransactionRef mirrors the resolver', () => {
    expect(isResolvableTransactionRef({ type: 'invoice', id: 'INV-1' })).toBe(true);
    expect(isResolvableTransactionRef({ type: 'invoice' })).toBe(false);
  });
});

describe('readTransactionRefFromSearch', () => {
  it('returns null for query strings without a supported reference', () => {
    expect(readTransactionRefFromSearch('')).toBeNull();
    expect(readTransactionRefFromSearch('?tab=history')).toBeNull();
    expect(readTransactionRefFromSearch(`?${TX_REF_PARAM}=mystery&${TX_ID_PARAM}=x`)).toBeNull();
    expect(readTransactionRefFromSearch(`?${TX_REF_PARAM}=invoice`)).toBeNull();
  });

  it('accepts a leading "?" or not', () => {
    expect(readTransactionRefFromSearch(`${TX_REF_PARAM}=invoice&${TX_ID_PARAM}=i1`)).toEqual({
      type: 'invoice',
      id: 'i1',
      number: '',
    });
  });
});

describe('lookupRecordByRef', () => {
  const invoices = [
    { id: 'i-1', invoiceNumber: 'INV-P726/021' },
    { id: 'i-2', invoiceNumber: 'INV-P726/022' },
  ];

  it('prefers the authoritative id', () => {
    const res = lookupRecordByRef(invoices, { id: 'i-2', number: 'INV-P726/021' });
    expect(res.status).toBe('ok');
    expect(res.record).toBe(invoices[1]);
  });

  it('falls back to an exact number match', () => {
    const res = lookupRecordByRef(invoices, { number: 'INV-P726/021' });
    expect(res.status).toBe('ok');
    expect(res.record).toBe(invoices[0]);
  });

  it('resolves URL-encoded legacy numbers', () => {
    const res = lookupRecordByRef(invoices, { number: 'INV-P726%2F021' });
    expect(res.status).toBe('ok');
    expect(res.record).toBe(invoices[0]);
  });

  it('does not open a record when the number is ambiguous', () => {
    const duplicated = [
      { id: 'a', invoiceNumber: 'INV-DUP/1' },
      { id: 'b', invoiceNumber: 'INV-DUP/1' },
    ];
    const res = lookupRecordByRef(duplicated, { number: 'INV-DUP/1' });
    expect(res.status).toBe('ambiguous');
    expect(res.record).toBeUndefined();
  });

  it('reports missing records instead of guessing', () => {
    expect(lookupRecordByRef(invoices, { id: 'gone' }).status).toBe('missing');
    expect(lookupRecordByRef(invoices, { number: 'INV-NOPE' }).status).toBe('missing');
    expect(lookupRecordByRef([], { number: 'INV-P726/021' }).status).toBe('missing');
    expect(lookupRecordByRef(undefined, { number: 'INV-P726/021' }).status).toBe('missing');
  });

  it('returns nothing for an empty reference', () => {
    expect(lookupRecordByRef(invoices, {}).status).toBe('missing');
  });

  it('does not match on partial numbers', () => {
    expect(lookupRecordByRef(invoices, { number: 'INV-P726' }).status).toBe('missing');
  });
});

describe('resolveOriginatingTransactionRef', () => {
  it('uses the row metadata, never the displayed text', () => {
    const res = resolveOriginatingTransactionRef({
      referenceType: 'Invoice',
      referenceId: 'i-1',
      reference: 'INV-P726/021',
    });
    expect(res).toEqual({ type: 'invoice', id: 'i-1', number: 'INV-P726/021' });
  });

  it('returns null when the row names no supported transaction', () => {
    expect(resolveOriginatingTransactionRef({ referenceType: 'Ledger', referenceId: 'x' })).toBeNull();
    expect(resolveOriginatingTransactionRef({ reference: 'INV-P726/021' })).toBeNull();
    expect(resolveOriginatingTransactionRef(null)).toBeNull();
  });
});

describe('helpers', () => {
  it('normalizeRefKey trims and stringifies', () => {
    expect(normalizeRefKey('  INV-1 ')).toBe('INV-1');
    expect(normalizeRefKey(undefined)).toBe('');
    expect(normalizeRefKey(12)).toBe('12');
  });

  it('transactionRefLabel is human readable', () => {
    expect(transactionRefLabel('delivery-note')).toBe('Delivery note');
    expect(transactionRefLabel('nope')).toBe('Transaction');
  });

  it('every registered type has a route', () => {
    for (const [type, spec] of Object.entries(TRANSACTION_REF_TYPES)) {
      expect(spec.route.startsWith('/'), type).toBe(true);
      expect(spec.label.length, type).toBeGreaterThan(0);
    }
  });
});
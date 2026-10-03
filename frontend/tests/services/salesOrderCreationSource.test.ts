import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import {
  normalizeCreationSource,
  readCreationSource,
} from '../../types/salesOrder';
import {
  canonicalizeOrder,
  generateLocalSalesOrderId,
  getSalesOrderOfficialNumber,
  getSalesOrderDisplayNumber,
  PENDING_SALES_ORDER_NUMBER,
} from '../../services/salesOrderService';

const baseOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'so-local-1',
  customerName: 'Acme',
  orderDate: '2026-08-18T09:00:00.000Z',
  items: [
    { id: 'i1', productId: 'p1', description: 'Flyers', quantity: 2, unitPrice: 100, lineTotal: 200 },
  ],
  total: 200,
  ...overrides,
});

describe('creation_source normalization (frontend mirror, provenance only)', () => {
  it('accepts the three canonical sources', () => {
    expect(normalizeCreationSource('DIRECT_ERP')).toBe('DIRECT_ERP');
    expect(normalizeCreationSource('PORTAL_CONVERSION')).toBe('PORTAL_CONVERSION');
    expect(normalizeCreationSource('INVOICE_DERIVED')).toBe('INVOICE_DERIVED');
  });

  it('normalizes the legacy QUOTATION_REQUEST alias to PORTAL_CONVERSION', () => {
    expect(normalizeCreationSource('QUOTATION_REQUEST')).toBe('PORTAL_CONVERSION');
  });

  it('returns null for missing/invalid sources (never a silent portal default)', () => {
    expect(normalizeCreationSource(null)).toBeNull();
    expect(normalizeCreationSource('')).toBeNull();
    expect(normalizeCreationSource('SO')).toBeNull();
    expect(normalizeCreationSource('invoice')).toBeNull();
  });

  it('reads both spellings', () => {
    expect(readCreationSource({ creation_source: 'DIRECT_ERP' })).toBe('DIRECT_ERP');
    expect(readCreationSource({ creationSource: 'INVOICE_DERIVED' })).toBe('INVOICE_DERIVED');
    expect(readCreationSource({})).toBeNull();
  });
});

describe('canonicalizeOrder preserves explicit creation_source', () => {
  it('keeps DIRECT_ERP on ERP manual orders with null number', () => {
    const canonical = canonicalizeOrder(
      baseOrder({ status: 'Draft', creation_source: 'DIRECT_ERP', orderNumber: null }),
    );
    expect(canonical.creation_source).toBe('DIRECT_ERP');
    expect(canonical.creationSource).toBe('DIRECT_ERP');
    expect(canonical.status).toBe('Draft');
    expect(canonical.orderNumber).toBeNull();
  });

  it('keeps INVOICE_DERIVED with invoice linkage and Confirmed status', () => {
    const canonical = canonicalizeOrder(
      baseOrder({
        status: 'Confirmed',
        creation_source: 'INVOICE_DERIVED',
        invoiceId: 'inv-1',
        invoiceNumber: 'INV-001',
      }),
    );
    expect(canonical.creation_source).toBe('INVOICE_DERIVED');
    expect(canonical.invoiceId).toBe('inv-1');
    expect(canonical.invoiceNumber).toBe('INV-001');
    expect(canonical.status).toBe('Confirmed');
  });

  it('keeps PORTAL_CONVERSION with request linkage and Confirmed status', () => {
    const canonical = canonicalizeOrder(
      baseOrder({
        status: 'Confirmed',
        creationSource: 'PORTAL_CONVERSION',
        sourceRequestId: 'req-1',
      }),
    );
    expect(canonical.creation_source).toBe('PORTAL_CONVERSION');
    expect(canonical.status).toBe('Confirmed');
  });
});

describe('local ids and pending numbers (no SO/TMP numbering)', () => {
  it('mints opaque local ids (never a Sales Order number)', () => {
    const id = generateLocalSalesOrderId();
    expect(id.startsWith('local-')).toBe(true);
    expect(id).not.toMatch(/^ORD-/i);
    expect(id).not.toMatch(/^SO-/i);
    expect(id).not.toMatch(/^TMP-/i);
    expect(id).not.toContain('/');
  });

  it('drops SO-/TMP-shaped compat values instead of surfacing them', () => {
    expect(canonicalizeOrder(baseOrder({ orderNumber: 'SO-P726/0001' })).orderNumber).toBeNull();
    expect(canonicalizeOrder(baseOrder({ orderNumber: 'TMP-0001' })).orderNumber).toBeNull();
    expect(canonicalizeOrder(baseOrder({ orderNumber: 'SO-2026-000001' })).orderNumber).toBeNull();
  });

  it('official reader ignores SO/TMP values', () => {
    expect(getSalesOrderOfficialNumber({ orderNumber: 'SO-P726/0001' })).toBeUndefined();
    expect(getSalesOrderOfficialNumber({ orderNumber: 'TMP-0001' })).toBeUndefined();
    expect(getSalesOrderOfficialNumber({ orderNumber: 'ORD-P726/0001' })).toBe('ORD-P726/0001');
  });

  it('display shows a pending state until the server assigns ORD', () => {
    expect(getSalesOrderDisplayNumber(baseOrder({ orderNumber: null }))).toBe(
      PENDING_SALES_ORDER_NUMBER
    );
    expect(getSalesOrderDisplayNumber(baseOrder({ orderNumber: 'TMP-0001' }))).toBe(
      PENDING_SALES_ORDER_NUMBER
    );
    expect(getSalesOrderDisplayNumber(baseOrder({ orderNumber: 'SO-P726/0001' }))).toBe(
      PENDING_SALES_ORDER_NUMBER
    );
    expect(getSalesOrderDisplayNumber(baseOrder({ order_number: 'ORD-P726/0021' }))).toBe(
      'ORD-P726/0021'
    );
  });
});

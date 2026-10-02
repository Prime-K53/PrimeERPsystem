import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../../utils/helpers', () => ({
  generateNextId: vi.fn((prefix: string) => `${prefix}-NEXT`),
}));

import {
  normalizeCreationSource,
  readCreationSource,
  isProvisionalNumber,
} from '../../types/salesOrder';
import {
  canonicalizeOrder,
  generateProvisionalOrderId,
  getSalesOrderOfficialNumber,
} from '../../services/salesOrderService';

const baseOrder = (overrides: Record<string, unknown> = {}) => ({
  id: 'so_1',
  customerName: 'Acme',
  orderDate: '2026-08-18T09:00:00.000Z',
  items: [
    { id: 'i1', productId: 'p1', description: 'Flyers', quantity: 2, unitPrice: 100, lineTotal: 200 },
  ],
  total: 200,
  ...overrides,
});

describe('creation_source normalization (frontend mirror)', () => {
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
  it('keeps DIRECT_ERP on ERP manual orders', () => {
    const canonical = canonicalizeOrder(
      baseOrder({ status: 'Draft', creation_source: 'DIRECT_ERP' }),
    );
    expect(canonical.creation_source).toBe('DIRECT_ERP');
    expect(canonical.creationSource).toBe('DIRECT_ERP');
    expect(canonical.status).toBe('Draft');
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

describe('provisional numbers (TMP neutral, never SO)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mints TMP- provisionals by default', () => {
    expect(generateProvisionalOrderId([])).toBe('TMP-NEXT');
  });

  it('recognizes neutral and short provisionals as provisional', () => {
    expect(isProvisionalNumber({ orderNumber: 'TMP-0001' })).toBe(true);
    expect(isProvisionalNumber({ orderNumber: 'SO-0001' })).toBe(true);
    expect(isProvisionalNumber({ orderNumber: 'ORD-0001' })).toBe(true);
    expect(isProvisionalNumber({ orderNumber: '' })).toBe(true);
    expect(isProvisionalNumber({} as any)).toBe(true);
  });

  it('recognizes official unified and legacy numbers as non-provisional', () => {
    expect(isProvisionalNumber({ orderNumber: 'SO-P726/0001' })).toBe(false);
    expect(isProvisionalNumber({ orderNumber: 'ORD-P726/0001' })).toBe(false);
    expect(isProvisionalNumber({ orderNumber: 'ORD-2026-000001' })).toBe(false);
  });

  it('explicit flag always wins', () => {
    expect(
      isProvisionalNumber({ orderNumber: 'ORD-P726/0001', orderNumberProvisional: true }),
    ).toBe(true);
  });

  it('official reader never returns a provisional as official', () => {
    expect(getSalesOrderOfficialNumber({ orderNumber: 'TMP-0001' })).toBeUndefined();
    expect(getSalesOrderOfficialNumber({ orderNumber: 'SO-0001' })).toBeUndefined();
    expect(
      getSalesOrderOfficialNumber({ orderNumber: 'SO-P726/0001', orderNumberProvisional: true }),
    ).toBeUndefined();
    expect(getSalesOrderOfficialNumber({ orderNumber: 'ORD-P726/0001' })).toBe('ORD-P726/0001');
  });
});

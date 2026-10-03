import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/db', () => ({
  dbService: {
    get: vi.fn(),
    getAll: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

import { fieldLevelMerge } from '../../services/syncConflictResolver';
import {
  adoptServerNumber,
  getSalesOrderDisplayNumber,
  getSalesOrderOfficialNumber,
  PENDING_SALES_ORDER_NUMBER,
} from '../../services/salesOrderService';

/**
 * Regression: an ERP-created order carries no number locally
 * (orderNumber null, pending state) until the backend stamps the official
 * ORD- order_number on sync. The pull merge adopts `order_number`, and
 * adoptServerNumber reconciles the display fields — so ORD- replaces the
 * pending state and no SO-/TMP- value can ever survive as the displayed
 * Sales Order number.
 */

// 1. ERP-created order starts unnumbered locally (pending state, no fake number).
const localErpRow = () => ({
  id: 'so-abc123',
  orderNumber: null,
  orderNumberProvisional: false,
  creation_source: 'DIRECT_ERP',
  creationSource: 'DIRECT_ERP',
  status: 'Draft',
  customerId: 'CUST-1',
  _updatedAt: '2026-09-01T10:00:00.000Z',
});

// Server row after the gateway stamped ORD-P726/021 (DIRECT_ERP), as
// toCloudRecord() shapes it for the pull/realtime merge.
const serverStampedRow = () => ({
  id: 'so-abc123',
  order_number: 'ORD-P726/021',
  orderNumber: null,
  orderNumberProvisional: false,
  creation_source: 'DIRECT_ERP',
  status: 'Draft',
  updated_at: '2026-09-01T10:01:00.000Z',
  serverUpdatedAt: '2026-09-01T10:01:00.000Z',
  version: 1,
});

/** Exactly what the pull/realtime merge paths now do for sales_orders. */
const mergeAsPullPathDoes = (local: any, remote: any) =>
  adoptServerNumber(fieldLevelMerge(local, remote));

describe('ERP sync numbering write-back (pending → ORD-)', () => {
  it('pre-sync local row shows the pending state (never SO/TMP)', () => {
    const local = localErpRow();
    expect(getSalesOrderOfficialNumber(local)).toBeUndefined();
    expect(getSalesOrderDisplayNumber(local)).toBe(PENDING_SALES_ORDER_NUMBER);
  });

  it('2. after sync the local record contains the official ORD-P726/xxx', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(stored.id).toBe('so-abc123');
    expect(stored.order_number).toBe('ORD-P726/021');
    expect(stored.orderNumber).toBe('ORD-P726/021');
  });

  it('3. orderNumberProvisional is false after sync', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(stored.orderNumberProvisional).toBe(false);
  });

  it('4./6. UI displays ORD-P726/xxx, never SO/TMP after sync', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(getSalesOrderDisplayNumber(stored)).toBe('ORD-P726/021');
    expect(getSalesOrderDisplayNumber(stored)).not.toContain('TMP-');
    expect(getSalesOrderDisplayNumber(stored)).not.toContain('SO-');
  });

  it('5./7. no new Sales Order number is ever SO- or TMP-shaped', () => {
    for (const value of ['SO-P726/021', 'SO-2026-000001', 'TMP-0001', 'ORDER-P726/034', '']) {
      expect(getSalesOrderOfficialNumber({ orderNumber: value })).toBeUndefined();
    }
    expect(getSalesOrderOfficialNumber({ orderNumber: 'ORD-P726/021' })).toBe('ORD-P726/021');
  });

  it('legacy SO/TMP compat values are obsolete once ORD arrives', () => {
    const stored = adoptServerNumber({
      id: 'so-old',
      order_number: 'ORD-P726/021',
      orderNumber: 'SO-P726/021',
      orderNumberProvisional: false,
    });
    expect(stored.orderNumber).toBe('ORD-P726/021');
    expect(getSalesOrderDisplayNumber(stored)).toBe('ORD-P726/021');
  });

  it('rows without an official number pass through untouched', () => {
    const local = localErpRow();
    expect(adoptServerNumber(local)).toBe(local);
    expect(getSalesOrderDisplayNumber(local)).toBe(PENDING_SALES_ORDER_NUMBER);
  });

  it('portal and invoice rows adopt ORD identically (single family)', () => {
    for (const source of ['PORTAL_CONVERSION', 'INVOICE_DERIVED']) {
      const stored = adoptServerNumber({
        id: 'so-x',
        order_number: 'ORD-P726/022',
        orderNumber: null,
        orderNumberProvisional: false,
        creation_source: source,
      });
      expect(stored.orderNumber).toBe('ORD-P726/022');
      expect(stored.orderNumberProvisional).toBe(false);
      expect(getSalesOrderDisplayNumber(stored)).toBe('ORD-P726/022');
    }
  });

  it('10. historical official ORD numbers are adopted unchanged', () => {
    const stored = adoptServerNumber({
      id: 'so-hist',
      order_number: 'ORD-2026-000005',
      orderNumber: null,
      orderNumberProvisional: false,
    });
    expect(stored.orderNumber).toBe('ORD-2026-000005');
    expect(getSalesOrderDisplayNumber(stored)).toBe('ORD-2026-000005');
  });
});

import { describe, expect, it, vi } from 'vitest';

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

import { fieldLevelMerge } from '../../services/syncConflictResolver';
import {
  adoptServerNumber,
  getSalesOrderDisplayNumber,
  getSalesOrderOfficialNumber,
} from '../../services/salesOrderService';

/**
 * Regression: an ERP-created order keeps its neutral TMP- provisional until
 * the backend stamps the official ORD- order_number on sync. The pull merge
 * adopts `order_number` but never reconciled the legacy `orderNumber` /
 * `orderNumberProvisional` fields that the list/details render — so TMP-
 * was displayed forever. adoptServerNumber (wired into the pull + realtime
 * merge paths) closes that gap.
 */

// 1. ERP-created order may initially have TMP- locally.
const localErpRow = () => ({
  id: 'TMP-0001',
  orderNumber: 'TMP-0001',
  orderNumberProvisional: true,
  creation_source: 'DIRECT_ERP',
  creationSource: 'DIRECT_ERP',
  status: 'Draft',
  customerId: 'CUST-1',
  _updatedAt: '2026-09-01T10:00:00.000Z',
});

// Server row after the gateway stamped ORD-P726/021 (DIRECT_ERP), as
// toCloudRecord() shapes it for the pull/realtime merge.
const serverStampedRow = () => ({
  id: 'TMP-0001',
  order_number: 'ORD-P726/021',
  orderNumber: 'TMP-0001',
  orderNumberProvisional: true,
  creation_source: 'DIRECT_ERP',
  status: 'Draft',
  updated_at: '2026-09-01T10:01:00.000Z',
  serverUpdatedAt: '2026-09-01T10:01:00.000Z',
  version: 1,
});

/** Exactly what the pull/realtime merge paths now do for sales_orders. */
const mergeAsPullPathDoes = (local: any, remote: any) =>
  adoptServerNumber(fieldLevelMerge(local, remote));

describe('ERP sync numbering write-back (TMP- → ORD-)', () => {
  it('pre-sync local row shows its TMP- provisional (correct pre-sync state)', () => {
    const local = localErpRow();
    expect(getSalesOrderOfficialNumber(local)).toBeUndefined();
    expect(getSalesOrderDisplayNumber(local)).toBe('TMP-0001');
  });

  it('pull merge adopts the server order_number but leaves TMP- compat fields (the bug)', () => {
    const merged = fieldLevelMerge(localErpRow(), serverStampedRow());
    expect(merged.order_number).toBe('ORD-P726/021');
    // Without adoptServerNumber the rendered fields stay provisional…
    expect(merged.orderNumber).toBe('TMP-0001');
    expect(merged.orderNumberProvisional).toBe(true);
  });

  it('2. after sync the local record contains the official ORD-P726/xxx', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(stored.id).toBe('TMP-0001');
    expect(stored.order_number).toBe('ORD-P726/021');
    expect(stored.orderNumber).toBe('ORD-P726/021');
  });

  it('3. orderNumberProvisional is false after sync', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(stored.orderNumberProvisional).toBe(false);
  });

  it('4. UI displays ORD-P726/xxx, never TMP- after sync', () => {
    const stored = mergeAsPullPathDoes(localErpRow(), serverStampedRow());
    expect(getSalesOrderDisplayNumber(stored)).toBe('ORD-P726/021');
    expect(getSalesOrderDisplayNumber(stored)).not.toContain('TMP-');
  });

  it('leaves rows without an official number untouched (pre-sync / offline)', () => {
    const local = localErpRow();
    expect(adoptServerNumber(local)).toBe(local);
  });

  it('preserves portal SO- adoption behavior (unchanged)', () => {
    const stored = adoptServerNumber({
      id: 'tmp-9',
      order_number: 'SO-P726/007',
      orderNumber: 'TMP-0009',
      orderNumberProvisional: true,
      creation_source: 'PORTAL_CONVERSION',
    });
    expect(stored.orderNumber).toBe('SO-P726/007');
    expect(stored.orderNumberProvisional).toBe(false);
  });

  it('preserves invoice-derived ORD- adoption behavior (unchanged)', () => {
    const stored = adoptServerNumber({
      id: 'tmp-8',
      order_number: 'ORD-P726/022',
      orderNumber: 'TMP-0008',
      orderNumberProvisional: true,
      creation_source: 'INVOICE_DERIVED',
    });
    expect(stored.orderNumber).toBe('ORD-P726/022');
    expect(stored.orderNumberProvisional).toBe(false);
  });
});

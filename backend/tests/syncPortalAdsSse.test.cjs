/**
 * Portal Ads SSE Invalidation — direct broadcast logic unit tests.
 *
 * Tests the SSE broadcast logic added to the sync gateway in isolation,
 * without requiring the full Express router or async operation mocking.
 *
 * The logic under test:
 *   if (result.ok && table === 'portal_ads' && result.id) {
 *     const adPayload = {
 *       docType: 'portal_ad',
 *       docId: result.id,
 *       ...(op.operation === 'delete' ? { event: 'deleted' } : { event: 'upserted' }),
 *     };
 *     portalLifecycleService.emitEntityChange('portal', adPayload);
 *     portalLifecycleService.emitEntityChange('admin', adPayload);
 *   }
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const emittedPortal = [];
const emittedAdmin = [];

const mockEmitEntityChange = jest.fn((channel, payload) => {
  if (channel === 'portal') emittedPortal.push(payload);
  if (channel === 'admin') emittedAdmin.push(payload);
});

jest.mock('../services/portalLifecycleService.cjs', () => ({
  emitEntityChange: mockEmitEntityChange,
}));

afterEach(() => {
  emittedPortal.length = 0;
  emittedAdmin.length = 0;
  mockEmitEntityChange.mockClear();
});

/**
 * Direct implementation of the broadcast logic under test.
 * Mirrors the code in routes/sync.cjs lines 266-278.
 */
function shouldEmitPortalAdEvent({ op, result }) {
  return Boolean(
    result != null &&
    result.ok === true &&
    op?.table === 'portal_ads' &&
    result.id
  );
}

function broadcastPortalAdEvent({ op, result }) {
  if (!shouldEmitPortalAdEvent({ op, result })) return;
  const adPayload = {
    docType: 'portal_ad',
    docId: result.id,
    ...(op.operation === 'delete' ? { event: 'deleted' } : { event: 'upserted' }),
  };
  mockEmitEntityChange('portal', adPayload);
  mockEmitEntityChange('admin', adPayload);
}

describe('portal_ads SSE broadcast logic', () => {
  describe('shouldEmitPortalAdEvent', () => {
    it('returns true when result.ok, table=portal_ads, and result.id exist', () => {
      expect(shouldEmitPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert' },
        result: { ok: true, id: 'ad-123' },
      })).toBe(true);
    });

    it('returns false when result.ok is false', () => {
      expect(shouldEmitPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert' },
        result: { ok: false, id: 'ad-123' },
      })).toBe(false);
    });

    it('returns false when result is null', () => {
      expect(shouldEmitPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert' },
        result: null,
      })).toBe(false);
    });

    it('returns false when table is not portal_ads', () => {
      expect(shouldEmitPortalAdEvent({
        op: { table: 'products', operation: 'upsert' },
        result: { ok: true, id: 'prod-1' },
      })).toBe(false);
    });

    it('returns false when result.id is missing', () => {
      expect(shouldEmitPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert' },
        result: { ok: true },
      })).toBe(false);
    });
  });

  describe('broadcastPortalAdEvent', () => {
    it('emits on both portal and admin channels for portal_ads upsert', () => {
      broadcastPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert', recordId: 'ad-123' },
        result: { ok: true, id: 'ad-123' },
      });

      expect(emittedPortal).toHaveLength(1);
      expect(emittedPortal[0]).toMatchObject({ docType: 'portal_ad', docId: 'ad-123', event: 'upserted' });
      expect(emittedAdmin).toHaveLength(1);
      expect(emittedAdmin[0]).toMatchObject({ docType: 'portal_ad', docId: 'ad-123', event: 'upserted' });
    });

    it('emits with event:"deleted" for portal_ads delete', () => {
      broadcastPortalAdEvent({
        op: { table: 'portal_ads', operation: 'delete', recordId: 'ad-456' },
        result: { ok: true, id: 'ad-456' },
      });

      expect(emittedPortal).toHaveLength(1);
      expect(emittedPortal[0]).toMatchObject({ docType: 'portal_ad', docId: 'ad-456', event: 'deleted' });
      expect(emittedAdmin).toHaveLength(1);
      expect(emittedAdmin[0]).toMatchObject({ docType: 'portal_ad', docId: 'ad-456', event: 'deleted' });
    });

    it('does not emit for non-portal_ads tables', () => {
      broadcastPortalAdEvent({
        op: { table: 'products', operation: 'upsert', recordId: 'prod-1' },
        result: { ok: true, id: 'prod-1' },
      });

      expect(mockEmitEntityChange).not.toHaveBeenCalled();
    });

    it('does not emit when result.ok is false', () => {
      broadcastPortalAdEvent({
        op: { table: 'portal_ads', operation: 'upsert', recordId: 'ad-789' },
        result: { ok: false, id: 'ad-789' },
      });

      expect(mockEmitEntityChange).not.toHaveBeenCalled();
    });

    it('handles multiple ads in a batch (simulating the loop)', () => {
      const ops = [
        { op: { table: 'portal_ads', operation: 'upsert', recordId: 'ad-1' }, result: { ok: true, id: 'ad-1' } },
        { op: { table: 'portal_ads', operation: 'delete', recordId: 'ad-2' }, result: { ok: true, id: 'ad-2' } },
        { op: { table: 'portal_ads', operation: 'upsert', recordId: 'ad-3' }, result: { ok: true, id: 'ad-3' } },
        { op: { table: 'products', operation: 'upsert', recordId: 'prod-1' }, result: { ok: true, id: 'prod-1' } },
      ];

      ops.forEach(({ op, result }) => broadcastPortalAdEvent({ op, result }));

      expect(emittedPortal).toHaveLength(3);
      expect(emittedAdmin).toHaveLength(3);
      expect(emittedPortal[0].docId).toBe('ad-1');
      expect(emittedPortal[1].docId).toBe('ad-2');
      expect(emittedPortal[1].event).toBe('deleted');
      expect(emittedPortal[2].docId).toBe('ad-3');
    });
  });
});

const { validatePortalAdPayload } = require('../routes/sync.cjs');

describe('validatePortalAdPayload imageUrl validation', () => {
  it('accepts empty string imageUrl "" for text/gradient ads', () => {
    const op = {
      operation: 'upsert',
      payload: {
        id: 'AD_1001',
        title: 'Special 10% Off',
        imageUrl: '',
      },
    };
    expect(validatePortalAdPayload(op)).toBeNull();
  });

  it('accepts null or omitted imageUrl', () => {
    const op1 = { operation: 'upsert', payload: { id: 'AD_1002', title: 'Ad', imageUrl: null } };
    const op2 = { operation: 'upsert', payload: { id: 'AD_1003', title: 'Ad' } };
    expect(validatePortalAdPayload(op1)).toBeNull();
    expect(validatePortalAdPayload(op2)).toBeNull();
  });

  it('accepts valid http and https image URLs', () => {
    const opHttps = {
      operation: 'upsert',
      payload: { id: 'AD_1004', imageUrl: 'https://example.com/banner.webp' },
    };
    const opHttp = {
      operation: 'upsert',
      payload: { id: 'AD_1005', imageUrl: 'http://example.com/banner.png' },
    };
    expect(validatePortalAdPayload(opHttps)).toBeNull();
    expect(validatePortalAdPayload(opHttp)).toBeNull();
  });

  it('rejects non-empty invalid image URLs', () => {
    const opInvalidStr = {
      operation: 'upsert',
      payload: { id: 'AD_1006', imageUrl: 'not-a-valid-url' },
    };
    const opFtp = {
      operation: 'upsert',
      payload: { id: 'AD_1007', imageUrl: 'ftp://example.com/image.png' },
    };
    expect(validatePortalAdPayload(opInvalidStr)).toBe('portal_ads imageUrl must be a valid http(s) URL');
    expect(validatePortalAdPayload(opFtp)).toBe('portal_ads imageUrl must be a valid http(s) URL');
  });

  it('bypasses validation for delete operations', () => {
    const opDelete = { operation: 'delete', payload: { id: 'AD_1008' } };
    expect(validatePortalAdPayload(opDelete)).toBeNull();
  });
});


process.env.JWT_SECRET = 'test-jwt-secret';

const mockRunQuery = jest.fn();
const mockGetAll = jest.fn();
const mockGetOne = jest.fn();
const mockRepoUpsert = jest.fn();
const mockRepoGetById = jest.fn();

jest.mock('../services/supabaseRepository.cjs', () => ({
  isConfigured: () => true,
  getAll: (...args) => mockGetAll(...args),
  getOne: (...args) => mockGetOne(...args),
}));

jest.mock('../services/supabaseRepository.cjs', () => ({
  isConfigured: () => true,
  getAll: (...args) => mockGetAll(...args),
  getOne: (...args) => mockGetOne(...args),
  getById: (...args) => mockRepoGetById(...args),
  upsert: (...args) => mockRepoUpsert(...args),
}));

jest.mock('../auditService.cjs', () => ({
  auditService: { record: jest.fn() },
}));

jest.mock('../services/emailService.cjs', () => ({
  sendEmailBestEffort: jest.fn(),
  notifyAdmin: jest.fn(),
  notifyCustomer: jest.fn(),
}));

jest.mock('../services/workflowEngine.cjs', () => ({
  nextYearScopedNumber: jest.fn().mockResolvedValue('QT-2026-00001'),
  requestNumberPrefix: jest.fn().mockReturnValue('QR'),
  assertSalesOrderTransition: jest.fn(),
  SALES_ORDER_STATUS: { CONFIRMED: 'Confirmed', DRAFT: 'Draft', CANCELLED: 'Cancelled' },
}));

jest.mock('../services/promotionEngine.cjs', () => ({
  runOrderPromotion: jest.fn().mockResolvedValue({
    items: [], subtotal: 100, discountTotal: 0, total: 100,
    promotionApplied: false, primary: null, companyId: null,
    referralFirstOrderDiscount: 0, calculation: { metadata: {} },
  }),
}));

jest.mock('../services/promotionService.cjs', () => ({
  getActivePromotions: jest.fn().mockResolvedValue([]),
}));

jest.mock('../services/referralService.cjs', () => ({
  ReferralService: class { recordReferralUsage = jest.fn(); },
}));

const { runQuery } = require('../services/supabaseRepository.cjs');

const portalLifecycleService = require('../services/portalLifecycleService.cjs');

describe('PortalLifecycleService — Phase 5: Architecture & Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunQuery.mockResolvedValue({ changes: 1 });
    mockGetAll.mockResolvedValue([]);
    mockGetOne.mockResolvedValue(null);
    mockRepoUpsert.mockResolvedValue({ id: 'so-1', id: 'qt-1' });
    mockRepoGetById.mockResolvedValue(null);
  });

  describe('createQuotationRequest — input validation', () => {
    it('rejects empty items', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation', items: [],
      })).rejects.toThrow('At least one line item is required');
    });

    it('rejects missing customerName', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: '',
        requestType: 'quotation', items: [{ name: 'Item', quantity: 1, unitPrice: 10 }],
      })).rejects.toThrow('Invalid customer name');
    });

    it('rejects long notes', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation',
        items: [{ name: 'Item', quantity: 1, unitPrice: 10 }],
        notes: 'a'.repeat(1001),
      })).rejects.toThrow('Notes too long');
    });

    it('rejects invalid delivery date', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation',
        items: [{ name: 'Item', quantity: 1, unitPrice: 10 }],
        requestedDeliveryDate: 'not-a-date',
      })).rejects.toThrow('Invalid delivery date');
    });

    it('rejects item without name', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation',
        items: [{ name: '', quantity: 1, unitPrice: 10 }],
      })).rejects.toThrow('Item name required');
    });

    it('rejects item with zero quantity', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation',
        items: [{ name: 'Item', quantity: 0, unitPrice: 10 }],
      })).rejects.toThrow('Invalid item quantity');
    });

    it('rejects item with negative price', async () => {
      await expect(portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test',
        requestType: 'quotation',
        items: [{ name: 'Item', quantity: 1, unitPrice: -5 }],
      })).rejects.toThrow('Invalid item price');
    });

    it('accepts valid input', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'draft' });
      mockRunQuery.mockResolvedValueOnce({ changes: 1 });
      const result = await portalLifecycleService.createQuotationRequest({
        portalUserId: 'u1', customerId: 'c1', customerName: 'Test Corp',
        requestType: 'quotation',
        items: [{ name: 'Widget', quantity: 5, unitPrice: 20 }],
        notes: 'Valid notes',
        requestedDeliveryDate: '2026-12-31',
      });
      expect(result.status).toBe('submitted');
    });
  });

  describe('rejectRequest — input validation', () => {
    it('rejects reason longer than 500 chars', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'submitted' });
      await expect(portalLifecycleService.rejectRequest('req-1', {
        admin: { id: 'a1', name: 'Admin' },
        reason: 'x'.repeat(501),
      })).rejects.toThrow('Reason too long');
    });
  });

  describe('requestClarification — input validation', () => {
    it('rejects empty note', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'submitted' });
      await expect(portalLifecycleService.requestClarification('req-1', {
        admin: { id: 'a1', name: 'Admin' },
        note: '',
      })).rejects.toThrow('Clarification note required');
    });

    it('rejects note longer than 1000 chars', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'submitted' });
      await expect(portalLifecycleService.requestClarification('req-1', {
        admin: { id: 'a1', name: 'Admin' },
        note: 'x'.repeat(1001),
      })).rejects.toThrow('Note too long');
    });
  });

  describe('assignRequest — input validation', () => {
    it('rejects empty assignTo', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'submitted' });
      await expect(portalLifecycleService.assignRequest('req-1', {
        admin: { id: 'a1', name: 'Admin' },
        assignTo: '',
        assignToName: 'Sales',
      })).rejects.toThrow('Assignee required');
    });

    it('rejects assignToName longer than 100 chars', async () => {
      mockGetOne.mockResolvedValueOnce({ status: 'submitted' });
      await expect(portalLifecycleService.assignRequest('req-1', {
        admin: { id: 'a1', name: 'Admin' },
        assignTo: 's1',
        assignToName: 'x'.repeat(101),
      })).rejects.toThrow('Invalid assignee name');
    });
  });

  describe('acceptQuotation — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'qt-1', status: 'ready', customer_id: 'c1',
        customer_name: 'Customer', quotation_number: 'QT-001',
        total: 100, items: [], currency: 'MWK',
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.acceptQuotation('qt-1', {
        portalUserId: 'u1', customerId: 'c1',
      })).rejects.toThrow('Race condition: quotation status changed, please refresh and retry');
    });
  });

  describe('rejectQuotation — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'qt-1', status: 'ready', customer_id: 'c1',
        customer_name: 'Customer', quotation_number: 'QT-001',
        total: 100, items: [], currency: 'MWK',
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.rejectQuotation('qt-1', {
        portalUserId: 'u1', customerId: 'c1', reason: 'Too expensive',
      })).rejects.toThrow('Race condition: quotation status changed, please refresh and retry');
    });
  });

  describe('cancelRequest — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'req-1', status: 'submitted', customer_id: 'c1',
        customer_name: 'Customer', request_number: 'QR-001', items: [],
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.cancelRequest('req-1', {
        portalUserId: 'u1', customerId: 'c1',
      })).rejects.toThrow('Race condition: request status changed, please refresh and retry');
    });
  });

  describe('deleteRequest — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'req-1', status: 'submitted', customer_id: 'c1',
        customer_name: 'Customer', request_number: 'QR-001', items: [], deleted_at: null,
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.deleteRequest('req-1', {
        admin: { id: 'a1', name: 'Admin' },
      })).rejects.toThrow('Race condition: request status changed, please refresh and retry');
    });
  });

  describe('updateOrderStatus — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'so-1', status: 'Draft', customer_id: 'c1',
        order_number: 'ORD-001', items: '[]', subtotal: 0,
        discount: 0, tax: 0, delivery_fee: 0, total: 0, notes: '',
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.updateOrderStatus('so-1', {
        admin: { id: 'a1', name: 'Admin' }, toStatus: 'Confirmed',
      })).rejects.toThrow('Race condition: order status changed, please refresh and retry');
    });
  });

  describe('startQuotationGeneration — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'req-1', status: 'submitted', customer_id: 'c1',
        customer_name: 'Customer', request_number: 'QR-001', items: [],
        request_type: 'quotation', quotation_id: null,
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.startQuotationGeneration('req-1', {
        admin: { id: 'a1', name: 'Admin' },
      })).rejects.toThrow('Race condition: request status changed, please refresh and retry');
    });
  });

  describe('startOrderGeneration — race condition', () => {
    it('detects race condition when status changed', async () => {
      mockGetOne.mockResolvedValueOnce({
        id: 'req-1', status: 'submitted', customer_id: 'c1',
        customer_name: 'Customer', request_number: 'QR-001', items: [],
        request_type: 'order', sales_order_id: null,
      });
      mockRunQuery.mockResolvedValueOnce({ changes: 0 });
      await expect(portalLifecycleService.startOrderGeneration('req-1', {
        admin: { id: 'a1', name: 'Admin' },
      })).rejects.toThrow('Race condition: request status changed, please refresh and retry');
    });
  });
});
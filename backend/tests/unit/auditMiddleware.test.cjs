process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('../../services/supabaseCanonicalRepository.cjs', () => ({
  getAll: jest.fn(),
  getById: jest.fn(),
  upsert: jest.fn(),
  count: jest.fn(),
  softDelete: jest.fn(),
  isConfigured: jest.fn(() => true),
}));

jest.mock('../../services/cloudSyncStore.cjs', () => ({
  upsertRow: jest.fn(),
  softDeleteRow: jest.fn(),
}));

jest.mock('../../auditService.cjs', () => ({
  auditService: {
    logEvent: jest.fn(() => Promise.resolve()),
  },
}));

const repo = require('../../services/supabaseCanonicalRepository.cjs');
const { auditService } = require('../../auditService.cjs');
const { auditCrudMiddleware } = require('../../auditMiddleware.cjs');

describe('auditMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('auditCrudMiddleware - pre-image fetch', () => {
    it('should call repo.getAll with correct table and OR filter for pre-image', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: 'doc-1', name: 'Invoice 1' }]);

      const middleware = auditCrudMiddleware('invoice');
      const req = { params: { id: 'doc-1' }, method: 'PUT', body: {}, path: '/api/invoices/doc-1' };
      const res = { setHeader: jest.fn() };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).toHaveBeenCalledWith('documents', {
        'or': '(id.eq.doc-1,logical_number.eq.doc-1)',
        limit: 1,
      });
    });

    it('should pass pre-image data to auditService.logEvent', async () => {
      repo.getAll.mockResolvedValueOnce([{ id: 'doc-1', name: 'Invoice 1' }]);

      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: { id: 'doc-1' },
        method: 'PUT',
        body: { name: 'Invoice Updated' },
        user: { id: 'user-1', role: 'admin' },
        path: '/api/invoices/doc-1',
        originalUrl: '/api/invoices/doc-1',
        auditContext: { userId: 'user-1', userRole: 'admin' },
      };
      const res = {
        setHeader: jest.fn(),
        send: function(body) { return body; },
      };
      const next = jest.fn();

      await middleware(req, res, next);
      res.send('test-body');

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'UPDATE',
          entityType: 'invoice',
          entityId: 'doc-1',
          oldValue: { id: 'doc-1', name: 'Invoice 1' },
          newValue: { name: 'Invoice Updated' },
        })
      );
    });

    it('should handle pre-image not found (oldValue is null)', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: { id: 'nonexistent' },
        method: 'DELETE',
        body: {},
        user: { id: 'user-1', role: 'admin' },
        path: '/api/invoices/nonexistent',
        auditContext: { userId: 'user-1', userRole: 'admin' },
      };
      const res = {
        setHeader: jest.fn(),
        send: function(body) { return body; },
      };
      const next = jest.fn();

      await middleware(req, res, next);
      res.send('test-body');

      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          oldValue: null,
          action: 'DELETE',
        })
      );
    });

    it('should use correct table for customer entity type', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const middleware = auditCrudMiddleware('customer');
      const req = {
        params: { id: 'cust-1' },
        method: 'PUT',
        body: {},
        user: { id: 'user-1' },
        path: '/api/customers/cust-1',
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).toHaveBeenCalledWith('customers', expect.any(Object));
    });

    it('should use correct table for examination_batch entity type', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const middleware = auditCrudMiddleware('examination_batch');
      const req = {
        params: { id: 'batch-1' },
        method: 'PUT',
        body: {},
        user: { id: 'user-1' },
        path: '/api/examination_batches/batch-1',
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).toHaveBeenCalledWith('examination_batches', expect.any(Object));
    });

    it('should call next immediately if entityId is missing for write method', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: {},
        method: 'PUT',
        body: {},
        user: { id: 'user-1' },
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should call next immediately if entityType is not in TABLE_WHITELIST', async () => {
      const middleware = auditCrudMiddleware('unknown_type');
      const req = {
        params: { id: 'x' },
        method: 'DELETE',
        body: {},
        user: { id: 'user-1' },
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('should not fetch pre-image for POST method', async () => {
      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: { id: 'doc-1' },
        method: 'POST',
        body: {},
        user: { id: 'user-1' },
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(repo.getAll).not.toHaveBeenCalled();
    });

    it('should handle repository failure gracefully', async () => {
      repo.getAll.mockRejectedValueOnce(new Error('Connection failed'));

      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: { id: 'doc-1' },
        method: 'PUT',
        body: {},
        user: { id: 'user-1' },
        path: '/api/invoices/doc-1',
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(repo.getAll).toHaveBeenCalled();
    });

    it('should pass oldValue to auditService.logEvent for CREATE action', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const middleware = auditCrudMiddleware('invoice');
      const req = {
        params: {},
        method: 'POST',
        body: { id: 'new-invoice', name: 'New Invoice' },
        user: { id: 'user-1' },
        path: '/api/invoices',
        originalUrl: '/api/invoices',
        auditContext: { userId: 'user-1' },
      };
      const res = { setHeader: jest.fn(), send: function(b) { return b; } };
      const next = jest.fn();

      await middleware(req, res, next);
      res.send('test-body');

      expect(repo.getAll).not.toHaveBeenCalled();
      expect(auditService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CREATE',
          oldValue: null,
        })
      );
    });
  });
});

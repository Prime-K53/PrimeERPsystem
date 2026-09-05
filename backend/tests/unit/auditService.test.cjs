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

const repo = require('../../services/supabaseCanonicalRepository.cjs');
const { auditService } = require('../../auditService.cjs');

describe('auditService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('logEvent', () => {
    it('should create an audit event and call repo.upsert with audit_logs', async () => {
      const eventData = {
        userId: 'user-1',
        userRole: 'admin',
        action: 'CREATE',
        entityType: 'schools',
        entityId: 'school-1',
        newValue: { name: 'New School' },
        details: 'Created new school',
      };

      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logEvent(eventData);

      expect(repo.upsert).toHaveBeenCalledWith('audit_logs', expect.any(Object));
      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.action).toBe('CREATE');
      expect(dbObj.entity_type).toBe('schools');
      expect(dbObj.user_id).toBe('user-1');
      expect(dbObj.details).toBe('Created new school');
    });

    it('should throw when repo.upsert fails', async () => {
      repo.upsert.mockRejectedValueOnce(new Error('Write failed'));

      await expect(auditService.logEvent({
        userId: 'user-1',
        action: 'CREATE',
        entityType: 'schools',
        entityId: 'school-1',
      })).rejects.toThrow('Write failed');
    });

    it('should include integrity_hash in the db object', async () => {
      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logEvent({
        userId: 'user-1',
        action: 'UPDATE',
        entityType: 'classes',
        entityId: 'class-1',
      });

      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.integrity_hash).toBeDefined();
      expect(typeof dbObj.integrity_hash).toBe('string');
      expect(dbObj.integrity_hash.length).toBe(64);
    });
  });

  describe('logCreate', () => {
    it('should call logEvent with CREATE action', async () => {
      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logCreate('user-1', 'admin', 'schools', 'school-1', { name: 'New' });

      expect(repo.upsert).toHaveBeenCalledWith('audit_logs', expect.any(Object));
      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.action).toBe('CREATE');
      expect(dbObj.old_value).toBeNull();
    });
  });

  describe('logUpdate', () => {
    it('should call logEvent with UPDATE action and delta', async () => {
      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logUpdate('user-1', 'admin', 'schools', 'school-1', { name: 'Old' }, { name: 'New' });

      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.action).toBe('UPDATE');
      expect(dbObj.old_value).toBeDefined();
      expect(dbObj.new_value).toBeDefined();
    });
  });

  describe('logDelete', () => {
    it('should call logEvent with DELETE action', async () => {
      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logDelete('user-1', 'admin', 'schools', 'school-1', { name: 'Old' });

      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.action).toBe('DELETE');
    });
  });

  describe('logAuthEvent', () => {
    it('should call logEvent with entityType AUTH', async () => {
      repo.upsert.mockResolvedValueOnce(undefined);

      await auditService.logAuthEvent('user-1', 'admin', 'login');

      const dbObj = repo.upsert.mock.calls[0][1];
      expect(dbObj.entity_type).toBe('AUTH');
      expect(dbObj.entity_id).toBe('user-1');
    });
  });

  describe('getEvents', () => {
    it('should return filtered events from repo.getAll', async () => {
      const mockRows = [
        { id: '1', entity_type: 'schools', entity_id: 'school-1', user_id: 'user-1', action: 'CREATE', timestamp: '2026-01-01T00:00:00.000Z', correlation_id: 'corr-1' },
        { id: '2', entity_type: 'classes', entity_id: 'class-1', user_id: 'user-2', action: 'UPDATE', timestamp: '2026-01-02T00:00:00.000Z', correlation_id: 'corr-2' },
      ];
      repo.getAll.mockResolvedValueOnce(mockRows);

      const result = await auditService.getEvents({ entityType: 'schools', limit: 10 });

      expect(repo.getAll).toHaveBeenCalledWith('audit_logs');
      expect(result).toHaveLength(1);
      expect(result[0].entity_type).toBe('schools');
    });

    it('should filter by correlationId', async () => {
      const mockRows = [
        { id: '1', correlation_id: 'corr-1', timestamp: '2026-01-01T00:00:00.000Z' },
        { id: '2', correlation_id: 'corr-2', timestamp: '2026-01-02T00:00:00.000Z' },
      ];
      repo.getAll.mockResolvedValueOnce(mockRows);

      const result = await auditService.getEvents({ correlationId: 'corr-1', limit: 10 });

      expect(result).toHaveLength(1);
      expect(result[0].correlation_id).toBe('corr-1');
    });

    it('should return empty array when no rows match', async () => {
      repo.getAll.mockResolvedValueOnce([]);

      const result = await auditService.getEvents({ entityType: 'nonexistent', limit: 10 });

      expect(result).toEqual([]);
    });

    it('should apply limit and offset', async () => {
      const mockRows = Array.from({ length: 5 }, (_, i) => ({
        id: String(i), entity_type: 'schools', user_id: 'user-1', action: 'CREATE', timestamp: '2026-01-01T00:00:00.000Z',
      }));
      repo.getAll.mockResolvedValueOnce(mockRows);

      const result = await auditService.getEvents({ limit: 2, offset: 1 });

      expect(result).toHaveLength(2);
    });
  });

  describe('verifyIntegrity', () => {
    it('should return result object with stored and computed fields when row exists', async () => {
      const mockRow = {
        id: 'event-1', timestamp: '2026-01-01T00:00:00.000Z',
        correlation_id: 'corr-1', user_id: 'user-1', action: 'CREATE',
        entity_type: 'schools', entity_id: 'school-1',
        integrity_hash: 'test-hash',
      };
      repo.getById.mockResolvedValueOnce(mockRow);

      const result = await auditService.verifyIntegrity('event-1');

      expect(result).toMatchObject({ stored: 'test-hash', computed: expect.any(String) });
      expect(typeof result.valid).toBe('boolean');
    });

    it('should return valid false when row not found', async () => {
      repo.getById.mockResolvedValueOnce(null);

      const result = await auditService.verifyIntegrity('nonexistent');

      expect(result.valid).toBe(false);
      expect(result.error).toBe('Event not found');
    });
  });

  describe('getStats', () => {
    it('should return aggregate stats', async () => {
      const now = new Date().toISOString();
      const mockRows = [
        { user_id: 'user-1', entity_type: 'schools', timestamp: now },
        { user_id: 'user-2', entity_type: 'classes', timestamp: now },
        { user_id: 'user-1', entity_type: 'schools', timestamp: now },
      ];
      repo.getAll.mockResolvedValueOnce(mockRows);

      const result = await auditService.getStats();

      expect(result.total_events).toBe(3);
      expect(result.unique_users).toBe(2);
      expect(result.entity_types).toBe(2);
    });

    it('should filter by date range', async () => {
      const now = new Date().toISOString();
      const mockRows = [
        { user_id: 'user-1', entity_type: 'schools', timestamp: now },
      ];
      repo.getAll.mockResolvedValueOnce(mockRows);

      const result = await auditService.getStats(now, now);
      expect(result.total_events).toBe(1);
    });
  });
});

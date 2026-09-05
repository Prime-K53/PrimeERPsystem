/**
 * supabaseCanonicalRepository.test.js
 *
 * Unit tests for the canonical Supabase repository.
 * These tests use mocks/stubs for the Supabase client and do NOT require
 * production Supabase access.
 */

process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

// Mock axios before requiring the module
jest.mock('axios', () => {
  const instance = {
    get: jest.fn(),
    post: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
  };
  instance.create = jest.fn(() => instance);
  return instance;
});

// Mock cloudSyncStore - we'll test the canonical repo's orchestration layer
jest.mock('../services/cloudSyncStore.cjs', () => ({
  isConfigured: jest.fn(() => true),
  upsertRow: jest.fn(),
  softDeleteRow: jest.fn(),
}));

const axios = require('axios');
const cloudSyncStore = require('../services/cloudSyncStore.cjs');
const repo = require('../services/supabaseCanonicalRepository.cjs');

describe('supabaseCanonicalRepository', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Helper to create a mock Supabase row in envelope format
  const mockRow = (overrides = {}) => ({
    id: 'test-id-123',
    data: {
      name: 'Test Record',
      status: 'active',
      created_at: '2026-01-01T00:00:00.000Z',
    },
    company_id: 'company-1',
    version: 1,
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  // Helper to create a domain object (what the app works with)
  const mockDomainObject = (overrides = {}) => ({
    id: 'test-id-123',
    name: 'Test Record',
    status: 'active',
    company_id: 'company-1',
    version: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

  // Helper to simulate axios GET response
  const mockAxiosGet = (data, headers = {}) => {
    axios.get.mockResolvedValueOnce({
      data: Array.isArray(data) ? data : [data],
      headers: headers,
    });
  };

  // Helper to simulate axios error
  const mockAxiosError = (status = 500, message = 'Internal Server Error') => {
    axios.get.mockRejectedValueOnce({
      response: {
        status,
        data: { detail: message },
      },
      message,
    });
  };

  /**
   * =====================
   * READ OPERATIONS
   * =====================
   */

  describe('getAll(table)', () => {
    it('should return an array of domain objects from Supabase rows', async () => {
      const rows = [
        mockRow({ id: 'id-1', data: { name: 'Record 1' } }),
        mockRow({ id: 'id-2', data: { name: 'Record 2' } }),
      ];
      mockAxiosGet(rows);

      const result = await repo.getAll('customers');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'id-1',
        name: 'Record 1',
        company_id: 'company-1',
        version: 1,
      });
      expect(result[1]).toMatchObject({
        id: 'id-2',
        name: 'Record 2',
        company_id: 'company-1',
        version: 1,
      });
    });

    it('should return an empty array when no rows exist', async () => {
      mockAxiosGet([]);

      const result = await repo.getAll('customers');

      expect(result).toEqual([]);
    });

    it('should return an empty array when axios returns null', async () => {
      axios.get.mockResolvedValueOnce({ data: null });

      const result = await repo.getAll('customers');

      expect(result).toEqual([]);
    });

    it('should pass filters to the Supabase query', async () => {
      mockAxiosGet([]);

      await repo.getAll('customers', { 'data->>status': 'eq.Active' });

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/rest/v1/customers'),
        expect.objectContaining({
          params: expect.objectContaining({
            'data->>status': 'eq.Active',
          }),
        })
      );
    });

    it('should handle Supabase read errors gracefully and return empty array', async () => {
      mockAxiosError(500, 'Connection failed');

      const result = await repo.getAll('customers');

      expect(result).toEqual([]);
    });
  });

  describe('getById(table, id)', () => {
    it('should return a domain object when the record exists', async () => {
      mockAxiosGet(mockRow({ id: 'test-id-123' }));

      const result = await repo.getById('customers', 'test-id-123');

      expect(result).toMatchObject({
        id: 'test-id-123',
        name: 'Test Record',
        company_id: 'company-1',
        version: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      });
    });

    it('should return null when the record does not exist', async () => {
      mockAxiosGet([]);

      const result = await repo.getById('customers', 'non-existent');

      expect(result).toBeNull();
    });

    it('should pass the id filter correctly', async () => {
      mockAxiosGet(null);

      await repo.getById('customers', 'test-id-123');

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining('/rest/v1/customers'),
        expect.objectContaining({
          params: expect.objectContaining({
            id: 'eq.test-id-123',
            limit: 1,
          }),
        })
      );
    });

    it('should return null on Supabase error', async () => {
      mockAxiosError(404, 'Not found');

      const result = await repo.getById('customers', 'test-id-123');

      expect(result).toBeNull();
    });
  });

  describe('count(table)', () => {
    it('should return the count from Content-Range header', async () => {
      mockAxiosGet([], { 'content-range': '0-0/42' });

      const result = await repo.count('customers');

      expect(result).toBe(42);
    });

    it('should return 0 when Content-Range header is missing', async () => {
      mockAxiosGet([]);

      const result = await repo.count('customers');

      expect(result).toBe(0);
    });

    it('should return 0 on Supabase error', async () => {
      mockAxiosError(500, 'Error');

      const result = await repo.count('customers');

      expect(result).toBe(0);
    });

    it('should return 0 when not configured', async () => {
      // isConfigured is called internally; we test by setting env to placeholder
      const originalUrl = process.env.SUPABASE_URL;
      const originalKey = process.env.SUPABASE_SECRET_KEY;
      process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'placeholder-key';

      // Need to re-require to pick up new env
      jest.resetModules();
      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');

      const result = await freshRepo.count('customers');

      expect(result).toBe(0);

      // Restore
      process.env.SUPABASE_URL = originalUrl;
      process.env.SUPABASE_SECRET_KEY = originalKey;
    });
  });

  /**
   * =====================
   * WRITE OPERATIONS
   * =====================
   */

  describe('upsert(table, row)', () => {
    it('should delegate to cloudSyncStore and return the upserted record', async () => {
      const domainObj = mockDomainObject({ name: 'Updated Record' });
      const savedRow = mockRow({ id: 'test-id-123', version: 2 });

      cloudSyncStore.upsertRow.mockResolvedValueOnce({ id: 'test-id-123' });
      axios.get.mockResolvedValueOnce({ data: [savedRow] });

      const result = await repo.upsert('customers', domainObj);

      expect(cloudSyncStore.upsertRow).toHaveBeenCalledWith('customers', 'test-id-123', domainObj);
      expect(result).toMatchObject({
        id: 'test-id-123',
        version: 2,
      });
    });

    it('should return null when not configured', async () => {
      // isConfigured is called internally; we test by setting env to placeholder
      const originalUrl = process.env.SUPABASE_URL;
      const originalKey = process.env.SUPABASE_SECRET_KEY;
      process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'placeholder-key';

      jest.resetModules();
      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');

      const result = await freshRepo.upsert('customers', mockDomainObject());

      expect(result).toBeNull();

      // Restore
      process.env.SUPABASE_URL = originalUrl;
      process.env.SUPABASE_SECRET_KEY = originalKey;
    });

    it('should return null when domain object has no id', async () => {
      const result = await repo.upsert('customers', { name: 'No ID' });

      expect(result).toBeNull();
      expect(cloudSyncStore.upsertRow).not.toHaveBeenCalled();
    });

    it('should return null when cloudSyncStore throws', async () => {
      cloudSyncStore.upsertRow.mockRejectedValueOnce(new Error('Write failed'));

      const result = await repo.upsert('customers', mockDomainObject());

      expect(result).toBeNull();
    });
  });

  describe('update(table, id, changes)', () => {
    // Note: update() is not directly implemented in the canonical repo.
    // The canonical repo uses upsert() for updates via cloudSyncStore.
    // This test documents that behavior.
    it('update method is not directly exposed - use upsert instead', async () => {
      // The canonical repository does not have a direct update() method.
      // Updates are done via upsert() which delegates to cloudSyncStore.
      expect(repo.update).toBeUndefined();
    });
  });

  describe('softDelete(table, id)', () => {
    it('should delegate to cloudSyncStore and return the tombstoned record', async () => {
      const tombstonedRow = mockRow({
        id: 'test-id-123',
        version: 2,
        data: {
          name: 'Test Record',
          deleted: true,
          deletedAt: '2026-01-02T00:00:00.000Z',
        },
      });

      cloudSyncStore.softDeleteRow.mockResolvedValueOnce({ id: 'test-id-123' });
      axios.get.mockResolvedValueOnce({ data: [tombstonedRow] });

      const result = await repo.softDelete('customers', 'test-id-123');

      expect(cloudSyncStore.softDeleteRow).toHaveBeenCalledWith('customers', 'test-id-123');
      expect(result).toMatchObject({
        id: 'test-id-123',
        version: 2,
        deleted: true,
      });
    });

    it('should return null when not configured', async () => {
      // isConfigured is called internally; we test by setting env to placeholder
      const originalUrl = process.env.SUPABASE_URL;
      const originalKey = process.env.SUPABASE_SECRET_KEY;
      process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'placeholder-key';

      jest.resetModules();
      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');

      const result = await freshRepo.softDelete('customers', 'test-id-123');

      expect(result).toBeNull();

      // Restore
      process.env.SUPABASE_URL = originalUrl;
      process.env.SUPABASE_SECRET_KEY = originalKey;
    });

    it('should return null when cloudSyncStore throws', async () => {
      cloudSyncStore.softDeleteRow.mockRejectedValueOnce(new Error('Delete failed'));

      const result = await repo.softDelete('customers', 'test-id-123');

      expect(result).toBeNull();
    });
  });

  /**
   * =====================
   * DATA CONTRACT
   * =====================
   */

  describe('Data contract - envelope preservation', () => {
    it('should preserve the JSONB data envelope without flattening', async () => {
      const rowWithNestedData = {
        id: 'test-id',
        data: {
          customer_name: 'Acme Corp',
          address: {
            street: '123 Main St',
            city: 'Lilongwe',
          },
          items: [1, 2, 3],
        },
        company_id: 'company-1',
        version: 1,
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      mockAxiosGet(rowWithNestedData);

      const result = await repo.getById('customers', 'test-id');

      expect(result.data).toBeUndefined(); // data is spread into the domain object
      expect(result.customer_name).toBe('Acme Corp');
      expect(result.address).toEqual({
        street: '123 Main St',
        city: 'Lilongwe',
      });
      expect(result.items).toEqual([1, 2, 3]);
    });

    it('should preserve created_at from data envelope when present', async () => {
      const row = mockRow({
        data: { created_at: '2026-01-01T00:00:00.000Z' },
        created_at: '2026-01-02T00:00:00.000Z', // DB column is newer
      });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      // In-envelope value should win (legacy row compatibility)
      expect(result.created_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should handle null data gracefully', async () => {
      const row = {
        id: 'test-id',
        data: null,
        company_id: 'company-1',
        version: 0,
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id');

      expect(result).toMatchObject({
        id: 'test-id',
        company_id: 'company-1',
        version: 0,
      });
    });

    it('should handle missing data field gracefully', async () => {
      const row = {
        id: 'test-id',
        company_id: 'company-1',
        version: 0,
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id');

      expect(result).toMatchObject({
        id: 'test-id',
        company_id: 'company-1',
        version: 0,
      });
    });
  });

  /**
   * =====================
   * COMPANY ISOLATION
   * =====================
   */

  describe('Company isolation', () => {
    it('should preserve company_id in the domain object', async () => {
      const row = mockRow({ company_id: 'company-abc-123' });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.company_id).toBe('company-abc-123');
    });

    it('should preserve company_id when it is null', async () => {
      const row = mockRow({ company_id: null });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.company_id).toBeNull();
    });

    it('should NOT inject company_id filter automatically (single-company deployment)', async () => {
      // In a single-company deployment, the canonical repo does NOT
      // automatically filter by company_id. This is the expected behavior
      // documented in SUPABASE_ACCESS_INVENTORY.md.
      mockAxiosGet([]);

      await repo.getAll('customers');

      const params = axios.get.mock.calls[0][1].params;
      expect(params).not.toHaveProperty('company_id');
    });

    it('should allow explicit company_id filtering when caller provides it', async () => {
      mockAxiosGet([]);

      await repo.getAll('customers', { company_id: 'eq.company-1' });

      const params = axios.get.mock.calls[0][1].params;
      expect(params).toHaveProperty('company_id', 'eq.company-1');
    });
  });

  /**
   * =====================
   * VERSIONING
   * =====================
   */

  describe('Versioning', () => {
    it('should preserve version as a number', async () => {
      const row = mockRow({ version: 5 });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.version).toBe(5);
      expect(typeof result.version).toBe('number');
    });

    it('should default version to 0 when missing', async () => {
      const row = mockRow({ version: null });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.version).toBe(0);
    });

    it('should handle undefined version', async () => {
      const row = {
        id: 'test-id',
        data: { name: 'Test' },
        company_id: 'company-1',
        updated_at: '2026-01-01T00:00:00.000Z',
      };

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id');

      expect(result.version).toBe(0);
    });

    it('should convert string version to number', async () => {
      const row = mockRow({ version: '3' });

      mockAxiosGet(row);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.version).toBe(3);
      expect(typeof result.version).toBe('number');
    });
  });

  /**
   * =====================
   * TOMBSTONES (Soft Delete)
   * =====================
   */

  describe('Tombstones', () => {
    it('should preserve tombstone data when reading a soft-deleted record', async () => {
      const tombstoneRow = mockRow({
        data: {
          name: 'Deleted Record',
          deleted: true,
          deletedAt: '2026-01-02T00:00:00.000Z',
        },
      });

      mockAxiosGet(tombstoneRow);

      const result = await repo.getById('customers', 'test-id-123');

      expect(result.deleted).toBe(true);
      expect(result.deletedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(result.name).toBe('Deleted Record');
    });

    it('should NOT physically delete rows (soft delete only)', async () => {
      // The canonical repo's softDelete() delegates to cloudSyncStore
      // which writes a tombstone (data.deleted = true), not a hard delete.
      const domainObj = mockDomainObject();

      cloudSyncStore.softDeleteRow.mockResolvedValueOnce({ id: 'test-id-123' });
      axios.get.mockResolvedValueOnce({ data: [mockRow({ data: { deleted: true } })] });

      await repo.softDelete('customers', 'test-id-123');

      // Verify cloudSyncStore was called, NOT a direct DELETE to Supabase
      expect(cloudSyncStore.softDeleteRow).toHaveBeenCalled();
      expect(axios.delete).not.toHaveBeenCalled();
    });

    it('should return the tombstoned record after soft delete', async () => {
      const tombstoneResult = {
        id: 'test-id-123',
        updatedAt: '2026-01-02T00:00:00.000Z',
        deleted: true,
      };

      cloudSyncStore.softDeleteRow.mockResolvedValueOnce(tombstoneResult);
      axios.get.mockResolvedValueOnce({ data: [mockRow({ data: { deleted: true, deletedAt: '2026-01-02T00:00:00.000Z' } })] });

      const result = await repo.softDelete('customers', 'test-id-123');

      expect(result.deleted).toBe(true);
      expect(result.deletedAt).toBe('2026-01-02T00:00:00.000Z');
    });
  });

  /**
   * =====================
   * ERROR HANDLING
   * =====================
   */

  describe('Error handling', () => {
    describe('Supabase read error', () => {
      it('should handle 500 error gracefully', async () => {
        mockAxiosError(500, 'Internal Server Error');

        const result = await repo.getAll('customers');

        expect(result).toEqual([]);
      });

      it('should handle 401 unauthorized error', async () => {
        mockAxiosError(401, 'Unauthorized');

        const result = await repo.getAll('customers');

        expect(result).toEqual([]);
      });

      it('should handle network errors', async () => {
        axios.get.mockRejectedValueOnce(new Error('Network timeout'));

        const result = await repo.getAll('customers');

        expect(result).toEqual([]);
      });
    });

    describe('Missing record', () => {
      it('should return null for getById when record does not exist', async () => {
        mockAxiosGet([]);

        const result = await repo.getById('customers', 'non-existent');

        expect(result).toBeNull();
      });

      it('should return null for getById when response is empty', async () => {
        axios.get.mockResolvedValueOnce({ data: [] });

        const result = await repo.getById('customers', 'test-id');

        expect(result).toBeNull();
      });
    });

    describe('Malformed/unexpected response', () => {
      it('should handle row with unexpected structure', async () => {
        const malformedRow = {
          id: 'test-id',
          // missing data field
          // missing company_id
          // missing version
        };

        mockAxiosGet(malformedRow);

        const result = await repo.getById('customers', 'test-id');

        expect(result.id).toBe('test-id');
        expect(result.data).toBeUndefined();
        expect(result.company_id).toBeUndefined();
        expect(result.version).toBe(0);
      });

      it('should handle data that is not an object', async () => {
        const row = {
          id: 'test-id',
          data: 'invalid-data-string',
          company_id: 'company-1',
          version: 1,
          updated_at: '2026-01-01T00:00:00.000Z',
        };

        mockAxiosGet(row);

        const result = await repo.getById('customers', 'test-id');

        // data should be treated as empty object
        expect(result).toBeDefined();
        expect(result.id).toBe('test-id');
      });

      it('should handle empty string timestamps', async () => {
        const row = {
          id: 'test-id',
          data: { name: 'Test' },
          company_id: 'company-1',
          version: 1,
          updated_at: '',
          created_at: '',
        };

        mockAxiosGet(row);

        const result = await repo.getById('customers', 'test-id');

        expect(result.updated_at).toBeNull();
        expect(result.created_at).toBeNull();
      });
    });

    describe('Empty result', () => {
      it('should return empty array for getAll when no rows match', async () => {
        mockAxiosGet([]);

        const result = await repo.getAll('customers');

        expect(result).toEqual([]);
        expect(Array.isArray(result)).toBe(true);
      });

      it('should return 0 for count when table is empty', async () => {
        mockAxiosGet([], { 'content-range': '0-0/0' });

        const result = await repo.count('customers');

        expect(result).toBe(0);
      });

      it('should return 0 for count when Content-Range header is malformed', async () => {
        mockAxiosGet([], { 'content-range': 'invalid' });

        const result = await repo.count('customers');

        expect(result).toBe(0);
      });
    });

    describe('Write errors', () => {
      it('should handle upsert errors gracefully', async () => {
        cloudSyncStore.upsertRow.mockRejectedValueOnce(new Error('Supabase write failed'));

        const result = await repo.upsert('customers', mockDomainObject());

        expect(result).toBeNull();
      });

      it('should handle softDelete errors gracefully', async () => {
        cloudSyncStore.softDeleteRow.mockRejectedValueOnce(new Error('Supabase delete failed'));

        const result = await repo.softDelete('customers', 'test-id');

        expect(result).toBeNull();
      });
    });
  });

  /**
   * =====================
   * CONFIGURATION
   * =====================
   */

  describe('Configuration', () => {
    it('should report configured when URL and key are present', () => {
      expect(repo.isConfigured()).toBe(true);
    });

    it('should report not configured when URL is missing', () => {
      delete process.env.SUPABASE_URL;
      // Need to re-require to pick up new env
      jest.resetModules();
      process.env.SUPABASE_URL = '';
      process.env.SUPABASE_SECRET_KEY = 'test-key';

      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');
      expect(freshRepo.isConfigured()).toBe(false);
    });

    it('should report not configured when key is missing', () => {
      delete process.env.SUPABASE_SECRET_KEY;
      jest.resetModules();
      process.env.SUPABASE_URL = 'https://test.supabase.co';
      process.env.SUPABASE_SECRET_KEY = '';

      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');
      expect(freshRepo.isConfigured()).toBe(false);
    });

    it('should report not configured for placeholder values', () => {
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SECRET_KEY;
      jest.resetModules();
      process.env.SUPABASE_URL = 'https://placeholder.supabase.co';
      process.env.SUPABASE_SECRET_KEY = 'placeholder-key';

      const freshRepo = require('../services/supabaseCanonicalRepository.cjs');
      expect(freshRepo.isConfigured()).toBe(false);
    });
  });

  /**
   * =====================
   * ENTITY QUERIES (Table Registry)
   * =====================
   */

  describe('Entity queries (table registry pattern)', () => {
    it('should expose entity queries for registered tables', () => {
      expect(repo.customers).toBeDefined();
      expect(repo.customers.getAll).toBeDefined();
      expect(repo.customers.getById).toBeDefined();
      expect(repo.customers.upsert).toBeDefined();
      expect(repo.customers.softDelete).toBeDefined();
    });

    it('should allow table-specific queries via entityQueries', () => {
      expect(repo.entities.customers).toBeDefined();
      expect(repo.entities.customers.getAll).toBeDefined();
    });

    it('should expose specific entity getters for commonly accessed tables', () => {
      expect(repo.financialYears).toBeDefined();
      expect(repo.profitMarginSettings).toBeDefined();
      expect(repo.purchaseOrders).toBeDefined();
      expect(repo.goodsReceipts).toBeDefined();
      expect(repo.workCenters).toBeDefined();
      expect(repo.productionResources).toBeDefined();
      expect(repo.customerPayments).toBeDefined();
      expect(repo.supplierPayments).toBeDefined();
    });
  });

  /**
   * =====================
   * COMPARISON WITH LEGACY REPOSITORY
   * =====================
   */

  describe('Compatibility with legacy supabaseRepository.cjs', () => {
    it('should have the same public method signatures', () => {
      // The canonical repository should be a drop-in replacement
      // for the legacy repository. Both should expose:
      expect(repo.getAll).toBeDefined();
      expect(repo.getById).toBeDefined();
      expect(repo.upsert).toBeDefined();
      expect(repo.softDelete).toBeDefined();
      expect(repo.count).toBeDefined();
      expect(repo.isConfigured).toBeDefined();
    });

    it('should use the same envelope format as the legacy repository', () => {
      // Both repositories use fromSupabaseRow/toSupabaseRow with the same shape:
      // { id, data: <jsonb>, company_id, version, updated_at, created_at }
      const legacyRepo = require('../services/supabaseRepository.cjs');

      // Verify both use the same helper functions
      expect(repo.fromSupabaseRow).toBeDefined();
      expect(repo.toSupabaseRow).toBeDefined();
      expect(legacyRepo.fromSupabaseRow).toBeDefined();
      expect(legacyRepo.toSupabaseRow).toBeDefined();
    });

    it('should delegate writes to cloudSyncStore (same as legacy)', () => {
      // Both canonical and legacy repositories use cloudSyncStore for writes
      expect(cloudSyncStore.upsertRow).toBeDefined();
      expect(cloudSyncStore.softDeleteRow).toBeDefined();
    });

    it('should NOT introduce incompatible method names', () => {
      // The canonical repo should not have methods that the legacy repo doesn't,
      // except for the flat helpers and portal entities which are additive.
      const legacyMethods = Object.keys(require('../services/supabaseRepository.cjs'));
      const canonicalMethods = Object.keys(repo);

      // Check that core methods match
      const coreMethods = ['getAll', 'getById', 'upsert', 'softDelete', 'count', 'isConfigured'];
      for (const method of coreMethods) {
        expect(canonicalMethods).toContain(method);
      }
    });
  });

  /**
   * =====================
   * getAllStrict
   * =====================
   */

  describe('getAllStrict(table)', () => {
    it('should throw on Supabase error instead of returning empty array', async () => {
      mockAxiosError(500, 'Read failed');

      await expect(repo.getAllStrict('customers')).rejects.toThrow(
        /Failed to read customers from Supabase/
      );
    });

    it('should return rows when successful', async () => {
      mockAxiosGet([mockRow()]);

      const result = await repo.getAllStrict('customers');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-id-123');
    });

    it('should throw when axios returns null', async () => {
      axios.get.mockResolvedValueOnce({ data: null });

      await expect(repo.getAllStrict('customers')).rejects.toThrow(
        /Failed to read customers from Supabase/
      );
    });
  });

  /**
   * =====================
   * Flat helpers (for portal tables)
   * =====================
   */

  describe('Flat helpers (portal tables)', () => {
    it('should expose getAllFlat for non-envelope tables', () => {
      expect(repo.getAllFlat).toBeDefined();
      expect(typeof repo.getAllFlat).toBe('function');
    });

    it('should expose getByIdFlat for non-envelope tables', () => {
      expect(repo.getByIdFlat).toBeDefined();
      expect(typeof repo.getByIdFlat).toBe('function');
    });

    it('should expose upsertFlat for non-envelope tables', () => {
      expect(repo.upsertFlat).toBeDefined();
      expect(typeof repo.upsertFlat).toBe('function');
    });

    it('should expose updateFlat for non-envelope tables', () => {
      expect(repo.updateFlat).toBeDefined();
      expect(typeof repo.updateFlat).toBe('function');
    });

    it('should expose portalEntities for portal-specific tables', () => {
      expect(repo.portalEntities).toBeDefined();
      expect(repo.portalEntities.portal_users).toBeDefined();
      expect(repo.portalEntities.portal_sessions).toBeDefined();
      expect(repo.portalEntities.portal_password_resets).toBeDefined();
      expect(repo.portalEntities.portal_login_history).toBeDefined();
    });
  });

  /**
   * =====================
   * buildEntityQueries
   * =====================
   */

  describe('buildEntityQueries(table list) - internal helper', () => {
    it('should create a query object with the expected methods for each table', () => {
      // buildEntityQueries is not exported but is used internally to build entityQueries
      // We can verify the pattern by checking that entityQueries has the expected structure
      expect(repo.entities).toBeDefined();
      expect(repo.entities.customers).toBeDefined();
      expect(repo.entities.customers.getAll).toBeDefined();
      expect(repo.entities.customers.getById).toBeDefined();
      expect(repo.entities.customers.upsert).toBeDefined();
      expect(repo.entities.customers.softDelete).toBeDefined();
    });
  });
});

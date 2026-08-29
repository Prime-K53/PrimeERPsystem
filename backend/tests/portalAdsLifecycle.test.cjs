/**
 * Portal Ads Lifecycle — active-ad query contract tests.
 *
 * Tests that `getActivePortalAds` in portalLifecycleService correctly filters
 * ads based on:
 *   1. Tombstone state (data.deleted = true) — soft-deleted ads must NOT appear
 *   2. status field — paused/draft/expired ads must NOT appear
 *   3. isActive field — explicitly inactive ads must NOT appear
 *   4. Date window — future ads (startsAt > now) and expired ads (endsAt < now)
 *      must NOT appear
 *   5. Company scoping — ads from other companies must NOT appear
 *
 * The browser is NOT trusted to filter ads. The backend is authoritative.
 * Deleted ads must disappear from the Portal without any manual DB operation.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const mockGetAll = jest.fn();
const mockGetById = jest.fn();

jest.mock('../services/supabaseRepository.cjs', () => ({
  isConfigured: () => true,
  getAll: (...args) => mockGetAll(...args),
  getById: (...args) => mockGetById(...args),
}));

const { getActivePortalAds } = require('../services/portalLifecycleService.cjs');

// repo.getAll('portal_ads') returns rows already passed through fromSupabaseRow,
// which spreads row.data + stamps id/created_at/updated_at/version.
function makeAd(overrides) {
  return {
    id: 'ad-test-1',
    title: 'Test Ad',
    subtitle: null,
    badge: null,
    ctaLabel: null,
    ctaTarget: null,
    imageUrl: null,
    gradient: null,
    emoji: null,
    priority: 0,
    startsAt: null,
    endsAt: null,
    isActive: true,
    status: 'active',
    companyId: 'company_a',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  mockGetAll.mockReset();
  mockGetById.mockReset();
});

describe('getActivePortalAds', () => {

  describe('tombstone / soft-delete exclusion', () => {
    it('excludes ads with data.deleted = true', async () => {
      const rows = [
        makeAd({ id: 'ad-deleted', title: 'Deleted Ad', deleted: true }),
        makeAd({ id: 'ad-live', title: 'Live Ad' }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      expect(mockGetAll).toHaveBeenCalledWith('portal_ads', expect.objectContaining({ 'data->>deleted': 'neq.true' }));
      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Deleted Ad');
      expect(activeTitles).toContain('Live Ad');
    });

    it('excludes ads with deletedAt set', async () => {
      const rows = [
        makeAd({ id: 'ad-deleted-at', title: 'Deleted At Ad', deletedAt: '2026-01-01T00:00:00Z' }),
        makeAd({ id: 'ad-live', title: 'Live Ad' }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Deleted At Ad');
      expect(activeTitles).toContain('Live Ad');
    });
  });

  describe('status exclusions', () => {
    const statuses = ['paused', 'draft', 'expired'];
    test.each(statuses)('excludes ads with status="%s"', async (badStatus) => {
      const rows = [
        makeAd({ id: `ad-${badStatus}`, title: `${badStatus} ad`, status: badStatus }),
        makeAd({ id: 'ad-active', title: 'Active Ad', status: 'active' }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain(`${badStatus} ad`);
      expect(activeTitles).toContain('Active Ad');
    });
  });

  describe('isActive exclusions', () => {
    it('excludes ads where isActive === false', async () => {
      const rows = [
        makeAd({ id: 'ad-inactive', title: 'Inactive Ad', isActive: false }),
        makeAd({ id: 'ad-active', title: 'Active Ad', isActive: true }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Inactive Ad');
      expect(activeTitles).toContain('Active Ad');
    });
  });

  describe('date-window exclusions', () => {
    it('excludes ads where startsAt is in the future', async () => {
      const future = new Date(Date.now() + 86400000 * 7).toISOString();
      const rows = [
        makeAd({ id: 'ad-future', title: 'Future Ad', startsAt: future }),
        makeAd({ id: 'ad-now', title: 'Current Ad', startsAt: null }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Future Ad');
      expect(activeTitles).toContain('Current Ad');
    });

    it('excludes ads where endsAt is in the past', async () => {
      const past = new Date(Date.now() - 86400000).toISOString();
      const rows = [
        makeAd({ id: 'ad-expired', title: 'Expired Ad', endsAt: past }),
        makeAd({ id: 'ad-valid', title: 'Valid Ad', endsAt: null }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Expired Ad');
      expect(activeTitles).toContain('Valid Ad');
    });
  });

  describe('all-ads-deleted returns empty', () => {
    it('returns an empty array when all ads are tombstones', async () => {
      const rows = [
        makeAd({ id: 'ad-del-1', title: 'Deleted 1', deleted: true }),
        makeAd({ id: 'ad-del-2', title: 'Deleted 2', deleted: true }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      expect(result).toEqual([]);
    });

    it('returns an empty array when no ads exist', async () => {
      mockGetAll.mockResolvedValueOnce([]);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      expect(result).toEqual([]);
    });

    it('returns an empty array when all ads are paused or inactive', async () => {
      const rows = [
        makeAd({ id: 'ad-paused', title: 'Paused Ad', status: 'paused' }),
        makeAd({ id: 'ad-inactive', title: 'Inactive Ad', isActive: false }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      expect(result).toEqual([]);
    });
  });

  describe('company scoping', () => {
    it('excludes ads belonging to a different company', async () => {
      const rows = [
        makeAd({ id: 'ad-other-company', title: 'Other Company Ad', companyId: 'company_b' }),
        makeAd({ id: 'ad-my-company', title: 'My Company Ad', companyId: 'company_a' }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).not.toContain('Other Company Ad');
      expect(activeTitles).toContain('My Company Ad');
    });

    it('includes ads with no companyId (global ads)', async () => {
      const rows = [
        makeAd({ id: 'ad-global', title: 'Global Ad', companyId: null }),
        makeAd({ id: 'ad-my-company', title: 'My Company Ad', companyId: 'company_a' }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const activeTitles = result.map((ad) => ad.title);
      expect(activeTitles).toContain('Global Ad');
      expect(activeTitles).toContain('My Company Ad');
    });
  });

  describe('priority ordering', () => {
    it('sorts ads by priority descending (highest first)', async () => {
      const rows = [
        makeAd({ id: 'ad-low', title: 'Low Priority', priority: 1 }),
        makeAd({ id: 'ad-high', title: 'High Priority', priority: 100 }),
        makeAd({ id: 'ad-med', title: 'Med Priority', priority: 50 }),
      ];
      mockGetAll.mockResolvedValueOnce(rows);
      mockGetById.mockResolvedValueOnce({ id: 'cust-1', companyId: 'company_a' });

      const result = await getActivePortalAds('cust-1');

      const titles = result.map((ad) => ad.title);
      expect(titles).toEqual(['High Priority', 'Med Priority', 'Low Priority']);
    });
  });

  describe('repository failure is non-fatal', () => {
    it('returns [] when repo.getAll throws', async () => {
      mockGetAll.mockRejectedValueOnce(new Error('network error'));

      const result = await getActivePortalAds('cust-1');

      expect(result).toEqual([]);
    });
  });
});

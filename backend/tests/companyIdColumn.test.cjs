/**
 * company_id column regression test (hermetic).
 *
 * Root cause guarded here: fromSupabaseRow dropped the top-level company_id
 * column because it was not included in the returned object. The portal_ads
 * table uses a top-level company_id column (not inside JSONB data).
 * Other tables (portal_tickets, etc.) may also depend on this column.
 *
 * The fix adds company_id: row.company_id to the returned object.
 */

process.env.JWT_SECRET = 'test-jwt-secret';

const repoActual = jest.requireActual('../services/supabaseRepository.cjs');

describe('fromSupabaseRow - company_id column preservation', () => {
  const { fromSupabaseRow } = repoActual;

  it('preserves top-level company_id from the row', () => {
    const row = {
      id: 'ad_test_1',
      company_id: 'COMPANY-123',
      data: {
        title: 'Test Ad',
        priority: 100,
      },
      updated_at: '2026-08-23T10:00:00.000Z',
      version: 1,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBe('COMPANY-123');
    expect(mapped.id).toBe('ad_test_1');
    expect(mapped.title).toBe('Test Ad');
    expect(mapped.priority).toBe(100);
  });

  it('company_id is null when row has no company_id', () => {
    const row = {
      id: 'ad_test_2',
      data: {
        title: 'Another Ad',
      },
      updated_at: '2026-08-23T10:00:00.000Z',
      version: 1,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBeUndefined();
    expect(mapped.id).toBe('ad_test_2');
    expect(mapped.title).toBe('Another Ad');
  });

  it('JSONB data fields are still flattened correctly', () => {
    const row = {
      id: 'ad_test_3',
      company_id: 'COMPANY-456',
      data: {
        title: 'Summer Sale',
        subtitle: 'Get 20% off',
        badge: 'Limited',
        ctaLabel: 'Shop Now',
        imageUrl: 'https://example.com/banner.webp',
        priority: 200,
        startsAt: '2026-01-01T00:00:00Z',
        endsAt: '2026-12-31T23:59:59Z',
        isActive: true,
        status: 'active',
        deleted: false,
      },
      updated_at: '2026-08-23T10:00:00.000Z',
      version: 2,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBe('COMPANY-456');
    expect(mapped.title).toBe('Summer Sale');
    expect(mapped.subtitle).toBe('Get 20% off');
    expect(mapped.badge).toBe('Limited');
    expect(mapped.ctaLabel).toBe('Shop Now');
    expect(mapped.imageUrl).toBe('https://example.com/banner.webp');
    expect(mapped.priority).toBe(200);
    expect(mapped.startsAt).toBe('2026-01-01T00:00:00Z');
    expect(mapped.endsAt).toBe('2026-12-31T23:59:59Z');
    expect(mapped.isActive).toBe(true);
    expect(mapped.status).toBe('active');
    expect(mapped.deleted).toBe(false);
    expect(mapped.id).toBe('ad_test_3');
    expect(mapped.version).toBe(2);
    expect(mapped.updated_at).toBe('2026-08-23T10:00:00.000Z');
  });

  it('top-level created_at and updated_at are preserved', () => {
    const row = {
      id: 'ad_test_4',
      company_id: 'COMPANY-789',
      data: {},
      created_at: '2026-08-20T08:00:00.000Z',
      updated_at: '2026-08-23T12:30:00.000Z',
      version: 5,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBe('COMPANY-789');
    expect(mapped.created_at).toBe('2026-08-20T08:00:00.000Z');
    expect(mapped.updated_at).toBe('2026-08-23T12:30:00.000Z');
    expect(mapped.version).toBe(5);
  });

  it('data.created_at takes precedence over row.created_at', () => {
    const row = {
      id: 'ad_test_5',
      company_id: 'COMPANY-ABC',
      data: {
        created_at: '2020-01-01T00:00:00.000Z',
      },
      created_at: '2026-08-20T08:00:00.000Z',
      updated_at: '2026-08-23T12:30:00.000Z',
      version: 1,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBe('COMPANY-ABC');
    expect(mapped.created_at).toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns null for null row', () => {
    expect(fromSupabaseRow(null)).toBeNull();
  });

  it('returns null for row with missing data field', () => {
    const row = {
      id: 'ad_test_6',
      company_id: 'COMPANY-XYZ',
      updated_at: '2026-08-23T10:00:00.000Z',
      version: 1,
    };

    const mapped = fromSupabaseRow(row);

    expect(mapped.company_id).toBe('COMPANY-XYZ');
    expect(mapped.id).toBe('ad_test_6');
    expect(mapped.title).toBeUndefined();
  });
});

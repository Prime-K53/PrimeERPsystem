/**
 * Unit Tests: getEffectiveMargin precedence logic
 * Tests the three-level override hierarchy: line_item > category > global
 * 
 * Migrated to mock supabaseCanonicalRepository.cjs (Phase 1A.2)
 */

const { describe, it, beforeEach, expect } = require('@jest/globals');

// Module-level state for the mock
const mockState = {
  rows: [],
};

// Mock the canonical repository (inline function required by Jest)
// Set up test environment before requiring the service
process.env.SUPABASE_URL = 'https://test.supabase.co';
process.env.SUPABASE_SECRET_KEY = 'test-secret-key';

jest.mock('../services/supabaseCanonicalRepository.cjs', () => {
  // Helper to apply PostgREST-style filters
  function applyFilters(rows, filters) {
    if (!filters) return rows;
    
    let result = [...rows];
    for (const [key, value] of Object.entries(filters)) {
      if (value == null) continue;
      
      if (key.startsWith('data->>')) {
        // JSONB filter: data->>field = eq.value
        const fieldName = key.replace('data->>', '');
        const filterParts = String(value).split('.');
        const op = filterParts[0];
        const target = filterParts[1] || '';
        
        result = result.filter(row => {
          const actual = row[fieldName];
          switch (op) {
            // PostgREST compares JSONB fields as text: true -> 'true', 1 -> '1', null matches nothing on eq
            case 'eq': return actual != null && String(actual) === target;
            case 'neq': return actual == null ? false : String(actual) !== target;
            case 'gt': return actual != null && Number(actual) > Number(target);
            case 'gte': return actual != null && Number(actual) >= Number(target);
            case 'lt': return actual != null && Number(actual) < Number(target);
            case 'lte': return actual != null && Number(actual) <= Number(target);
            case 'is': return target === 'null' ? actual == null : true;
            default: return true;
          }
        });
      } else if (key === 'id') {
        const filterParts = String(value).split('.');
        if (filterParts[0] === 'eq') {
          result = result.filter(row => row.id === filterParts[1]);
        }
      }
    }
    return result;
  }

  // Convert row to the domain shape the real repository returns:
  // envelope data fields are spread to the top level (not nested under `data`)
  function toEnvelope(row) {
    return {
      ...row,
      id: row.id,
      company_id: row.company_id || null,
      version: row.version || 0,
      updated_at: row.updated_at || new Date().toISOString(),
      created_at: row.created_at || new Date().toISOString(),
    };
  }

  return {
    isConfigured: () => true,
    
    getAll: async (table, filters) => {
      const filtered = applyFilters(mockState.rows, filters);
      return filtered.map(toEnvelope);
    },
    
    getById: async (table, id) => {
      const filtered = applyFilters(mockState.rows, { id: `eq.${id}` });
      return filtered.length > 0 ? toEnvelope(filtered[0]) : null;
    },
    
    upsert: async (table, record) => {
      const domain = record.data ? { ...record.data } : { ...record };
      const existingIdx = mockState.rows.findIndex(r => r.id === record.id);
      
      if (existingIdx >= 0) {
        mockState.rows[existingIdx] = {
          ...mockState.rows[existingIdx],
          ...domain,
          updated_at: new Date().toISOString(),
        };
      } else {
        mockState.rows.push({
          ...domain,
          id: record.id,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          version: 1,
          company_id: domain.company_id || null,
        });
      }
      
      const updated = mockState.rows.find(r => r.id === record.id);
      return updated ? toEnvelope(updated) : null;
    },
    
    softDelete: async (table, id) => {
      const row = mockState.rows.find(r => r.id === id);
      if (row) {
        row.deleted_at = new Date().toISOString();
        row.is_active = false;
      }
      return row ? { id, deleted: true } : null;
    },
    
    count: async () => mockState.rows.length,
    
    // These are exported but not used by profitMarginService
    fromSupabaseRow: (r) => r && r.data ? { ...r.data, id: r.id } : (r || null),
    toSupabaseRow: (d) => ({ id: d && d.id, data: d && d.data ? d.data : d }),
  };
});

// Now we can require the service (it will use our mock)
const profitMarginService = require('../services/profitMarginService.cjs');

// Helper to seed mock rows (is_active is a JSONB boolean in the envelope tables)
function seedRows(rows) {
  mockState.rows = rows.map(row => ({
    ...row,
    is_active: row.is_active !== undefined ? row.is_active : true,
    deleted_at: row.deleted_at || null,
    company_id: row.company_id || null,
    version: row.version || 0,
    created_at: row.created_at || new Date().toISOString(),
    updated_at: row.updated_at || new Date().toISOString(),
  }));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('getEffectiveMargin — precedence hierarchy', () => {
  beforeEach(() => {
    mockState.rows = [];
  });

  // 1. Falls through all levels → returns system default
  it('returns system default when no overrides exist', async () => {
    const result = await profitMarginService.getEffectiveMargin(null, null);
    expect(result.source).toBe('system');
    expect(result.margin_value).toBe(0);
    expect(result.margin_type).toBe('percentage');
  });

  // 2. Global is found when no line-item or category is provided
  it('returns global margin when only global is set', async () => {
    seedRows([{ scope: 'global', scope_ref_id: null, margin_value: 20, margin_type: 'percentage' }]);
    const result = await profitMarginService.getEffectiveMargin(null, null);
    expect(result.source).toBe('global');
    expect(result.margin_value).toBe(20);
  });

  // 3. Category overrides global
  it('uses category override over global when category matches', async () => {
    seedRows([
      { scope: 'global',   scope_ref_id: null,     margin_value: 20, margin_type: 'percentage' },
      { scope: 'category', scope_ref_id: 'CAT-1',  margin_value: 35, margin_type: 'percentage' }
    ]);
    const result = await profitMarginService.getEffectiveMargin(null, 'CAT-1');
    expect(result.source).toBe('category');
    expect(result.margin_value).toBe(35);
  });

  // 4. Line-item overrides category and global
  it('uses line-item override as highest priority', async () => {
    seedRows([
      { scope: 'global',    scope_ref_id: null,       margin_value: 20,  margin_type: 'percentage' },
      { scope: 'category',  scope_ref_id: 'CAT-1',    margin_value: 35,  margin_type: 'percentage' },
      { scope: 'line_item', scope_ref_id: 'PROD-001',  margin_value: 50,  margin_type: 'percentage' }
    ]);
    const result = await profitMarginService.getEffectiveMargin('PROD-001', 'CAT-1');
    expect(result.source).toBe('line_item');
    expect(result.margin_value).toBe(50);
  });

  // 5. Line-item present, wrong category → returns line-item
  it('returns line-item even when category does not match a different product', async () => {
    seedRows([
      { scope: 'global',    scope_ref_id: null,       margin_value: 20, margin_type: 'percentage' },
      { scope: 'line_item', scope_ref_id: 'PROD-002',  margin_value: 45, margin_type: 'percentage' }
    ]);
    const result = await profitMarginService.getEffectiveMargin('PROD-002', 'CAT-UNKNOWN');
    expect(result.source).toBe('line_item');
    expect(result.margin_value).toBe(45);
  });

  // 6. Category miss → falls through to global
  it('falls back to global when no category override exists for given category', async () => {
    seedRows([
      { scope: 'global',   scope_ref_id: null,    margin_value: 15, margin_type: 'percentage' },
      { scope: 'category', scope_ref_id: 'CAT-2', margin_value: 30, margin_type: 'percentage' }
    ]);
    const result = await profitMarginService.getEffectiveMargin(null, 'CAT-999');
    expect(result.source).toBe('global');
    expect(result.margin_value).toBe(15);
  });

  // 7. Line-item miss → tries category → hits category
  it('falls from line_item miss to category hit', async () => {
    seedRows([
      { scope: 'global',   scope_ref_id: null,       margin_value: 10, margin_type: 'percentage' },
      { scope: 'category', scope_ref_id: 'CAT-3',    margin_value: 28, margin_type: 'percentage' }
    ]);
    const result = await profitMarginService.getEffectiveMargin('PROD-UNKNOWN', 'CAT-3');
    expect(result.source).toBe('category');
    expect(result.margin_value).toBe(28);
  });

  // 8. Fixed amount type is preserved as a line-item override
  it('handles fixed_amount margin type correctly', async () => {
    seedRows([
      { scope: 'line_item', scope_ref_id: 'PROD-FIX', margin_value: 500, margin_type: 'fixed_amount' }
    ]);
    const result = await profitMarginService.getEffectiveMargin('PROD-FIX', null);
    expect(result.source).toBe('line_item');
    expect(result.margin_type).toBe('fixed_amount');
    expect(result.margin_value).toBe(500);
  });

  // 9. All three levels present — line_item wins
  it('correctly resolves: line_item beats category beats global', async () => {
    seedRows([
      { scope: 'global',    scope_ref_id: null,      margin_value: 10, margin_type: 'percentage' },
      { scope: 'category',  scope_ref_id: 'CAT-A',   margin_value: 20, margin_type: 'percentage' },
      { scope: 'line_item', scope_ref_id: 'SKU-A',   margin_value: 30, margin_type: 'percentage' }
    ]);
    const li = await profitMarginService.getEffectiveMargin('SKU-A', 'CAT-A');
    expect(li.source).toBe('line_item');
    expect(li.margin_value).toBe(30);

    // Remove line-item → category wins
    mockState.rows = mockState.rows.filter(r => r.scope !== 'line_item');
    const cat = await profitMarginService.getEffectiveMargin('SKU-A', 'CAT-A');
    expect(cat.source).toBe('category');
    expect(cat.margin_value).toBe(20);

    // Remove category → global wins
    mockState.rows = mockState.rows.filter(r => r.scope !== 'category');
    const global = await profitMarginService.getEffectiveMargin('SKU-A', 'CAT-A');
    expect(global.source).toBe('global');
    expect(global.margin_value).toBe(10);
  });
});

describe('createSetting — validation', () => {
  beforeEach(() => {
    mockState.rows = [];
  });

  it('rejects percentage > 100', async () => {
    await expect(
      profitMarginService.createSetting({ scope: 'global', scope_ref_id: null, margin_type: 'percentage', margin_value: 110 }, 'user1')
    ).rejects.toThrow('between 0 and 100');
  });

  it('rejects negative percentage', async () => {
    await expect(
      profitMarginService.createSetting({ scope: 'global', scope_ref_id: null, margin_type: 'percentage', margin_value: -5 }, 'user1')
    ).rejects.toThrow('between 0 and 100');
  });

  it('rejects negative fixed_amount', async () => {
    await expect(
      profitMarginService.createSetting({ scope: 'category', scope_ref_id: 'CAT-1', margin_type: 'fixed_amount', margin_value: -50 }, 'user1')
    ).rejects.toThrow('>= 0');
  });

  it('accepts boundary value 0%', async () => {
    // Should not throw validation — will succeed in mock
    const result = await profitMarginService.createSetting({
      scope: 'global', scope_ref_id: null, margin_type: 'percentage', margin_value: 0
    }, 'user1');
    expect(result).toBeDefined();
    expect(result.margin_value).toBe(0);
  });

  it('accepts boundary value 100%', async () => {
    const result = await profitMarginService.createSetting({
      scope: 'global', scope_ref_id: null, margin_type: 'percentage', margin_value: 100
    }, 'user1');
    expect(result).toBeDefined();
    expect(result.margin_value).toBe(100);
  });
});

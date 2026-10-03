import { describe, it, expect } from 'vitest';
import {
  normalizeSkuKey,
  slugifyVariantToken,
  buildVariantSkuBase,
  buildVariantId,
  resolveUniqueVariantSku,
  buildSkuRegistry,
  describeSkuConflict,
  ensureItemVariantIdentities,
  assertItemVariantIdentities,
  planVariantSkuBackfill,
  isVariantLine,
} from '../../services/variantSkuService';
import { normalizeInventoryItemPricing } from '../../utils/pricing';

const item = (over: Record<string, any> = {}) => ({
  id: 'PRD-0001',
  name: 'Exercise Book',
  sku: 'INV-PRD-0001',
  type: 'Product',
  costPrice: 10,
  sellingPrice: 20,
  stock: 0,
  ...over,
}) as any;

describe('variant SKU generation', () => {
  it('slugifies variant names into readable tokens', () => {
    expect(slugifyVariantToken('48 Pages')).toBe('48-PAGES');
    expect(slugifyVariantToken('A4 Blue')).toBe('A4-BLUE');
  });

  it('strips the parent name prefix the editor adds', () => {
    expect(slugifyVariantToken('Exercise Book - A4 Blue', 'Exercise Book')).toBe('A4-BLUE');
  });

  it('builds the documented PAPER-001-A4-BLUE shape', () => {
    expect(buildVariantSkuBase('PAPER-001', 'PRD-1', { name: 'A4 Blue' }, 'Paper')).toBe('PAPER-001-A4-BLUE');
  });

  it('falls back to the parent id when the parent has no SKU', () => {
    expect(buildVariantSkuBase('', 'PRD-9', { name: 'Red' })).toBe('PRD-9-RED');
  });

  it('suffixes deterministically on collision', () => {
    const taken = new Set(['EXB-48', 'EXB-48-2']);
    expect(resolveUniqueVariantSku('EXB-48', k => taken.has(k))).toBe('EXB-48-3');
  });

  it('normalises SKU comparison keys', () => {
    expect(normalizeSkuKey('  exb-48 ')).toBe('EXB-48');
  });

  it('builds deterministic variant ids', () => {
    expect(buildVariantId('PRD-0001', 0)).toBe('VAR-PRD-0001-1');
    expect(buildVariantId('PRD-0001', 2)).toBe('VAR-PRD-0001-3');
  });
});

describe('creation — every variant receives an id and a SKU', () => {
  it('gives a variant a stable id and unique SKU on create', () => {
    const parent = item({ variants: [{ name: '48 Pages', costPrice: 8, sellingPrice: 15 }] });
    const { item: saved } = ensureItemVariantIdentities(parent, { allItems: [] });
    const variant = saved.variants![0] as any;

    expect(variant.id).toBe('VAR-PRD-0001-1');
    expect(variant.sku).toBe('INV-PRD-0001-48-PAGES');
  });

  it('gives multiple variants distinct ids and SKUs', () => {
    const parent = item({
      variants: [
        { name: '48 Pages', costPrice: 8, sellingPrice: 15 },
        { name: '96 Pages', costPrice: 12, sellingPrice: 22 },
        { name: 'A4 Blue', costPrice: 14, sellingPrice: 25 },
      ],
    });
    const { item: saved } = ensureItemVariantIdentities(parent, { allItems: [] });

    expect(saved.variants!.map(v => v.id)).toEqual([
      'VAR-PRD-0001-1', 'VAR-PRD-0001-2', 'VAR-PRD-0001-3',
    ]);
    expect(saved.variants!.map(v => v.sku)).toEqual([
      'INV-PRD-0001-48-PAGES', 'INV-PRD-0001-96-PAGES', 'INV-PRD-0001-A4-BLUE',
    ]);
  });

  it('leaves a parent without variants untouched', () => {
    const parent = item();
    const result = ensureItemVariantIdentities(parent, { allItems: [] });
    expect(result.changed).toBe(false);
    expect(result.item).toBe(parent);
  });

  it('persists the SKU across a normalise/reload cycle', () => {
    const parent = item({ variants: [{ name: '96 Pages', costPrice: 12, sellingPrice: 22 }] });
    const { item: saved } = ensureItemVariantIdentities(parent, { allItems: [] });

    // Simulate a reload from storage through the read normaliser.
    const reloaded = normalizeInventoryItemPricing(JSON.parse(JSON.stringify(saved)));
    expect((reloaded.variants![0] as any).sku).toBe('INV-PRD-0001-96-PAGES');
    expect((reloaded.variants![0] as any).id).toBe('VAR-PRD-0001-1');
  });

  it('exposes the variant SKU through read normalisation for legacy records', () => {
    const legacy = item({ variants: [{ name: 'A4 Blue', costPrice: 1, sellingPrice: 2 }] });
    const normalised = normalizeInventoryItemPricing(legacy);
    expect((normalised.variants![0] as any).sku).toBe('INV-PRD-0001-A4-BLUE');
    expect((normalised.variants![0] as any).id).toBe('VAR-PRD-0001-1');
  });
});

describe('uniqueness — one global namespace', () => {
  it('rejects a variant SKU equal to its own parent SKU', () => {
    const parent = item({ variants: [{ id: 'v1', sku: 'INV-PRD-0001' }] });
    const result = ensureItemVariantIdentities(parent, { allItems: [] });
    expect(result.error).toMatch(/already used by the parent item "Exercise Book"/i);
  });

  it('rejects a variant SKU equal to ANOTHER parent item SKU', () => {
    const other = item({ id: 'PRD-0002', name: 'Ledger', sku: 'EXB-001' });
    const parent = item({ id: 'PRD-0001', variants: [{ id: 'v1', sku: 'EXB-001' }] });
    const result = ensureItemVariantIdentities(parent, { allItems: [other] });
    expect(result.error).toMatch(/already used by item "Ledger"/i);
  });

  it('rejects a duplicate variant SKU on the same parent', () => {
    const parent = item({
      variants: [
        { id: 'v1', sku: 'INV-PRD-0001-A' },
        { id: 'v2', sku: 'INV-PRD-0001-A' },
      ],
    });
    const result = ensureItemVariantIdentities(parent, { allItems: [] });
    expect(result.error).toMatch(/already used by variant/i);
  });

  it('rejects a variant SKU colliding with another parent’s variant SKU', () => {
    const other = item({ id: 'PRD-0002', name: 'Notebook', variants: [{ id: 'o1', sku: 'SHARED-1' }] });
    const parent = item({ id: 'PRD-0001', variants: [{ id: 'v1', sku: 'SHARED-1' }] });
    const result = ensureItemVariantIdentities(parent, { allItems: [other] });
    expect(result.error).toMatch(/already used by variant/i);
  });

  it('is case-insensitive', () => {
    const other = item({ id: 'PRD-0002', sku: 'EXB-001' });
    const parent = item({ id: 'PRD-0001', variants: [{ id: 'v1', sku: 'exb-001' }] });
    expect(ensureItemVariantIdentities(parent, { allItems: [other] }).error).toBeTruthy();
  });

  it('generates a free SKU when the base candidate collides', () => {
    const other = item({ id: 'PRD-0002', variants: [{ id: 'o1', sku: 'INV-PRD-0001-A4' }] });
    const parent = item({ variants: [{ name: 'A4', costPrice: 1, sellingPrice: 2 }] });
    const { item: saved } = ensureItemVariantIdentities(parent, { allItems: [other] });
    expect((saved.variants![0] as any).sku).toBe('INV-PRD-0001-A4-2');
  });

  it('builds a registry spanning parent items AND variants', () => {
    const registry = buildSkuRegistry([
      item({ id: 'A', sku: 'EXB-001' }),
      item({ id: 'B', variants: [{ id: 'bv', sku: 'EXB-002' }] }),
    ]);
    expect(registry.has('EXB-001')).toBe(true);
    expect(registry.has('exb-002')).toBe(true);
    expect(registry.has('EXB-003')).toBe(false);
  });

  it('allows a record to keep its own current SKU', () => {
    const registry = buildSkuRegistry([item({ variants: [{ id: 'v1', sku: 'MINE' }] })]);
    expect(describeSkuConflict('MINE', registry, { itemId: 'PRD-0001', variantId: 'v1' })).toBeNull();
    expect(describeSkuConflict('MINE', registry, { itemId: 'PRD-0001', variantId: 'v2' })).toBeTruthy();
  });

  it('throws from the assert wrapper used by the write path', () => {
    const other = item({ id: 'PRD-0002', sku: 'TAKEN' });
    const parent = item({ id: 'PRD-0001', variants: [{ id: 'v1', sku: 'TAKEN' }] });
    expect(() => assertItemVariantIdentities(parent, { allItems: [other] })).toThrow(/already used/i);
  });
});

describe('editing', () => {
  it('accepts editing a variant to its own current SKU', () => {
    const existing = item({ variants: [{ id: 'v1', name: '48 Pages', sku: 'KEEP-ME', costPrice: 8, sellingPrice: 15 }] });
    const { item: saved, error } = ensureItemVariantIdentities(existing, { allItems: [] });
    expect(error).toBeUndefined();
    expect((saved.variants![0] as any).sku).toBe('KEEP-ME');
  });

  it('accepts editing to a brand new free SKU', () => {
    const existing = item({ variants: [{ id: 'v1', name: '48 Pages', sku: 'OLD', costPrice: 8, sellingPrice: 15 }] });
    const { item: saved } = ensureItemVariantIdentities(
      { ...existing, variants: [{ ...existing.variants![0], sku: 'NEW-FREE-SKU' }] },
      { allItems: [] },
    );
    expect((saved.variants![0] as any).sku).toBe('NEW-FREE-SKU');
    expect((saved.variants![0] as any).id).toBe('v1');
  });

  it('rejects editing to a SKU already in use', () => {
    const other = item({ id: 'PRD-0002', sku: 'IN-USE' });
    const existing = item({
      variants: [{ id: 'v1', name: '48 Pages', sku: 'IN-USE', costPrice: 8, sellingPrice: 15 }],
    });
    expect(ensureItemVariantIdentities(existing, { allItems: [other] }).error).toMatch(/already used/i);
  });

  it('preserves existing variant ids and SKUs verbatim', () => {
    const existing = item({
      variants: [
        { id: 'keep-1', name: '48 Pages', sku: 'LEGACY-A', costPrice: 8, sellingPrice: 15 },
        { id: 'keep-2', name: '96 Pages', sku: 'LEGACY-B', costPrice: 12, sellingPrice: 22 },
      ],
    });
    const { item: saved } = ensureItemVariantIdentities(existing, { allItems: [] });
    expect(saved.variants!.map(v => v.id)).toEqual(['keep-1', 'keep-2']);
    expect(saved.variants!.map(v => v.sku)).toEqual(['LEGACY-A', 'LEGACY-B']);
  });
});

describe('migration — plan and idempotency', () => {
  const catalog = [
    item({ id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [
      { name: '48 Pages', costPrice: 8, sellingPrice: 15 },
      { id: 'v2', name: '96 Pages', sku: 'EXB-96', costPrice: 12, sellingPrice: 22 },
      { id: 'v3', name: 'A4 Blue', costPrice: 14, sellingPrice: 25 },
    ] }),
    item({ id: 'PRD-0002', name: 'Ledger', sku: 'LEDG-001', variants: [
      { name: '48 Pages', costPrice: 9, sellingPrice: 18 },
    ] }),
    item({ id: 'RAW-0001', name: 'A4 Paper', sku: 'A4P-001' }),
  ];

  it('counts variants, missing SKUs and preserved SKUs', () => {
    const plan = planVariantSkuBackfill(catalog);
    expect(plan.totalVariants).toBe(4);
    expect(plan.missingSku).toBe(3);
    expect(plan.alreadyHasSku).toBe(1);
    // 4 variants, 2 of which already carry a stable id.
    expect(plan.missingId).toBe(2);
    expect(plan.itemsToChange).toBe(2);
  });

  it('proposes a readable SKU per missing variant', () => {
    const plan = planVariantSkuBackfill(catalog);
    const byVariant = (itemSku: string, name: string) =>
      plan.proposals.find(p => p.itemSku === itemSku && p.variantName === name)?.proposedSku;

    expect(byVariant('EXB-001', '48 Pages')).toBe('EXB-001-48-PAGES');
    expect(byVariant('EXB-001', 'A4 Blue')).toBe('EXB-001-A4-BLUE');
    expect(byVariant('LEDG-001', '48 Pages')).toBe('LEDG-001-48-PAGES');
    // The variant that already carried a SKU is never proposed a new one.
    expect(plan.proposals.some(p => p.variantName === '96 Pages')).toBe(false);
  });

  it('never proposes a SKU that collides after the plan runs', () => {
    expect(planVariantSkuBackfill(catalog).collisions).toEqual([]);
  });

  it('assigns a stable id to every variant lacking one', () => {
    const plan = planVariantSkuBackfill(catalog);
    const ids = plan.proposals.map(p => p.variantId);
    expect(ids).toContain('VAR-PRD-0001-1');
    expect(ids).toContain('VAR-PRD-0002-1');
  });

  it('is idempotent — a second run finds nothing to do', () => {
    // Simulate applying the plan, then planning again.
    const applied = catalog.map(it2 => {
      const proposals = planVariantSkuBackfill(catalog).proposals.filter(p => p.itemId === it2.id);
      if (proposals.length === 0) return it2;
      const { item: saved } = ensureItemVariantIdentities(it2, { allItems: catalog.filter(i => i.id !== it2.id) });
      return saved;
    });
    const second = planVariantSkuBackfill(applied);
    expect(second.missingSku).toBe(0);
    expect(second.proposals).toEqual([]);
    expect(second.collisions).toEqual([]);
  });

  it('preserves stock, prices, attributes and history on apply', () => {
    const legacy = item({ variants: [{ name: '48 Pages', costPrice: 8, cost: 8, sellingPrice: 15, price: 15, stock: 42, attributes: { pages: 48 } }] });
    const { item: saved } = ensureItemVariantIdentities(legacy, { allItems: [] });
    const v = saved.variants![0] as any;

    expect(v.id).toBe('VAR-PRD-0001-1');
    expect(v.stock).toBe(42);
    expect(v.costPrice).toBe(8);
    expect(v.sellingPrice).toBe(15);
    expect(v.attributes).toEqual({ pages: 48 });
    expect(saved.id).toBe('PRD-0001');
    expect(saved.sku).toBe('INV-PRD-0001');
  });

  it('records the collision it had to avoid', () => {
    const clashing = [
      item({ id: 'PRD-0001', sku: 'EXB-001', variants: [{ name: '48 Pages' }] }),
      item({ id: 'PRD-0002', sku: 'EXB-001-48-PAGES', variants: [] }),
    ];
    const plan = planVariantSkuBackfill(clashing);
    expect(plan.proposals[0].proposedSku).toBe('EXB-001-48-PAGES-2');
    expect(plan.collisions).toEqual([]);
  });

  it('treats an item with no variants as nothing to migrate', () => {
    const plan = planVariantSkuBackfill([item({ id: 'RAW-0001', sku: 'A4P-001' })]);
    expect(plan.totalVariants).toBe(0);
    expect(plan.itemsToChange).toBe(0);
  });
});

describe('transaction identity', () => {
  it('recognises a variant line by its stable id', () => {
    expect(isVariantLine({ variantId: 'VAR-1' })).toBe(true);
    expect(isVariantLine({ variant_id: 'VAR-1' })).toBe(true);
    expect(isVariantLine({ variantId: '' })).toBe(false);
    expect(isVariantLine({ productId: 'PRD-1' })).toBe(false);
    expect(isVariantLine(null)).toBe(false);
  });
});

describe('search', () => {
  const catalog = [
    item({ id: 'PRD-0001', name: 'Exercise Book', sku: 'EXB-001', variants: [
      { id: 'v1', name: '48 Pages', sku: 'EXB-001-48-PAGES' },
    ] }),
  ];

  const matches = (query: string) => {
    const q = query.toLowerCase();
    return catalog.filter(i =>
      (i.name || '').toLowerCase().includes(q) ||
      (i.sku || '').toLowerCase().includes(q) ||
      (i.variants || []).some(v =>
        String(v?.name || '').toLowerCase().includes(q) ||
        String(v?.sku || '').toLowerCase().includes(q)),
    );
  };

  it('finds a variant by its own SKU', () => {
    expect(matches('EXB-001-48-PAGES')).toHaveLength(1);
  });

  it('finds a variant by its own name', () => {
    expect(matches('48 Pages')).toHaveLength(1);
  });

  it('finds a variant by the parent item name', () => {
    expect(matches('Exercise Book')).toHaveLength(1);
  });

  it('finds a variant by the parent SKU', () => {
    expect(matches('EXB-001')).toHaveLength(1);
  });

  it('matches a partial variant SKU', () => {
    expect(matches('48-pages')).toHaveLength(1);
  });
});
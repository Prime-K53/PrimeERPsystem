import { describe, expect, it } from 'vitest';
import {
  resolveLineItemIdentity,
  resolveLineVariant,
} from '../../views/sales/components/lineItemIdentity';
import { ensureItemVariantIdentities } from '../../services/variantSkuService';

const parent = {
  id: 'PRD-0001',
  name: 'Exercise Book',
  sku: 'EXB-001',
  variants: [
    { id: 'VAR-PRD-0001-1', name: '48 Pages', sku: 'EXB-001-48-PAGES', stock: 10 },
    { id: 'VAR-PRD-0001-2', name: '96 Pages', sku: 'EXB-001-96-PAGES', stock: 4 },
  ],
};

const inventory = [parent];

describe('variant line identity — the stable id is the relational identity', () => {
  it('resolves the variant from its stable variantId, never from the SKU', () => {
    const line = { id: 'VAR-PRD-0001-1', productId: 'PRD-0001', variantId: 'VAR-PRD-0001-1' };
    expect(resolveLineVariant(line, parent)).toEqual({
      id: 'VAR-PRD-0001-1',
      sku: 'EXB-001-48-PAGES',
      name: '48 Pages',
    });
  });

  it('supports the snake_case variant_id used by persisted rows', () => {
    const line = { productId: 'PRD-0001', variant_id: 'VAR-PRD-0001-2' };
    expect(resolveLineVariant(line, parent)?.sku).toBe('EXB-001-96-PAGES');
  });

  it('returns null for a non-variant line', () => {
    expect(resolveLineVariant({ productId: 'PRD-0001' }, parent)).toBeNull();
    expect(resolveLineVariant({ productId: 'PRD-0001', variantId: '' }, parent)).toBeNull();
  });

  it('returns null when the variantId matches no variant', () => {
    expect(resolveLineVariant({ productId: 'PRD-0001', variantId: 'GONE' }, parent)).toBeNull();
  });

  it('does not resolve a variant by SKU lookup', () => {
    // A line that carries a SKU but no variantId is NOT treated as a variant —
    // SKU is never used as database identity.
    const line = { productId: 'PRD-0001', sku: 'EXB-001-48-PAGES' };
    expect(resolveLineVariant(line, parent)).toBeNull();
  });
});

describe('document display uses the VARIANT sku', () => {
  it('shows the variant SKU, not the parent SKU, on a variant line', () => {
    const r = resolveLineItemIdentity(
      { id: 'VAR-PRD-0001-1', productId: 'PRD-0001', variantId: 'VAR-PRD-0001-1' },
      inventory,
    );
    expect(r.itemNumberText).toBe('EXB-001-48-PAGES');
    expect(r.itemNumberText).not.toBe('EXB-001');
    // The detail link still points at the PARENT record.
    expect(r.itemDetailId).toBe('PRD-0001');
  });

  it('still uses the item SKU for a non-variant line', () => {
    const r = resolveLineItemIdentity({ productId: 'PRD-0001' }, inventory);
    expect(r.itemNumberText).toBe('EXB-001');
  });

  it('prefers the variant SKU over a stale parent SKU stamped on the line', () => {
    const r = resolveLineItemIdentity(
      { id: 'VAR-PRD-0001-2', productId: 'PRD-0001', variantId: 'VAR-PRD-0001-2', sku: 'EXB-001' },
      inventory,
    );
    expect(r.itemNumberText).toBe('EXB-001-96-PAGES');
  });

  it('falls back to the line reference when the variant cannot be resolved', () => {
    const r = resolveLineItemIdentity({ productId: 'PRD-0001', variantId: 'GONE' }, inventory);
    expect(r.itemNumberText).toBe('EXB-001');
  });
});

describe('transactions keep variant identity end to end', () => {
  it('a variant can still be resolved, priced, stocked and reported by its id', () => {
    // Save through the canonical write path.
    const { item: saved } = ensureItemVariantIdentities(
      { ...parent, variants: parent.variants.map(v => ({ ...v })) } as any,
      { allItems: [] },
    );

    // Sell the first variant: POS/order builders key on variant.id.
    const line = { id: 'VAR-PRD-0001-1', productId: 'PRD-0001', variantId: 'VAR-PRD-0001-1', quantity: 2 };
    const resolved = resolveLineVariant(line, saved);

    expect(resolved?.id).toBe('VAR-PRD-0001-1');
    expect(resolved?.sku).toBe('EXB-001-48-PAGES');

    // Stock lives on the variant, not the parent.
    const variant = (saved.variants as any[]).find(v => v.id === line.variantId);
    expect(variant?.stock).toBe(10);
    expect(line.variantId).toBe('VAR-PRD-0001-1');
  });

  it('a legacy variant with no id gains one, and remains referenceable', () => {
    const legacy = { ...parent, variants: [{ name: '48 Pages', stock: 3 }] } as any;
    const { item: saved } = ensureItemVariantIdentities(legacy, { allItems: [] });

    expect((saved.variants as any[])[0].id).toBe('VAR-PRD-0001-1');
    expect((saved.variants as any[])[0].sku).toBe('EXB-001-48-PAGES');
    // Stock, parent relationship and history are preserved.
    expect((saved.variants as any[])[0].stock).toBe(3);
    expect(saved.id).toBe('PRD-0001');
    expect(saved.sku).toBe('EXB-001');
  });
});
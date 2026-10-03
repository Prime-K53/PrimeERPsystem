import { describe, expect, it } from 'vitest';
import { resolveLineItemIdentity, itemDetailPath } from '../../views/sales/components/lineItemIdentity';

const inventory = [
  { id: 'ITEM-1', sku: 'FG-FL-A5-4C' },
  { id: 'ITEM-2', sku: '' },
];

describe('resolveLineItemIdentity', () => {
  it('prefers the line sku over the inventory sku', () => {
    const r = resolveLineItemIdentity({ id: 'l1', productId: 'ITEM-1', sku: 'LINE-SKU' }, inventory);
    expect(r.itemNumberText).toBe('LINE-SKU');
    expect(r.itemDetailId).toBe('ITEM-1');
  });

  it('falls back to the matched inventory sku when the line has none', () => {
    const r = resolveLineItemIdentity({ id: 'l1', productId: 'ITEM-1' }, inventory);
    expect(r.itemNumberText).toBe('FG-FL-A5-4C');
    expect(r.itemDetailId).toBe('ITEM-1');
  });

  it('matches on the line id when productId does not resolve', () => {
    const stock = [{ id: 'ITEM-2', sku: 'FG-BN-A4' }];
    const r = resolveLineItemIdentity({ id: 'ITEM-2', productId: 'GONE' }, stock);
    expect(r.itemNumberText).toBe('FG-BN-A4');
    expect(r.itemDetailId).toBe('ITEM-2');
  });

  it('falls back to productId then line id as the display number', () => {
    expect(resolveLineItemIdentity({ productId: 'NOPE-9' }, inventory).itemNumberText).toBe('NOPE-9');
    expect(resolveLineItemIdentity({ id: 'lone' }, inventory).itemNumberText).toBe('lone');
  });

  it('never links a line with no inventory match', () => {
    const r = resolveLineItemIdentity({ id: 'l1', productId: 'NOPE-9' }, inventory);
    expect(r.itemNumberText).toBe('NOPE-9');
    expect(r.itemDetailId).toBeNull();
  });

  it('treats an empty-string inventory sku as absent and falls back to the reference', () => {
    const r = resolveLineItemIdentity({ id: 'l1', productId: 'ITEM-2' }, inventory);
    expect(r.itemNumberText).toBe('ITEM-2');
    expect(r.itemDetailId).toBe('ITEM-2');
  });

  it('tolerates a missing line or inventory', () => {
    expect(resolveLineItemIdentity(null, inventory).itemNumberText).toBeNull();
    // No inventory loaded: the reference is still shown, but nothing is linkable.
    const r = resolveLineItemIdentity({ productId: 'ITEM-1' }, undefined);
    expect(r.itemNumberText).toBe('ITEM-1');
    expect(r.itemDetailId).toBeNull();
  });

  it('encodes the item id into the detail route', () => {
    expect(itemDetailPath('A B/C')).toBe('/supply-chain/inventory/A%20B%2FC');
  });
});

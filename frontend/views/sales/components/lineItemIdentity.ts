/**
 * lineItemIdentity — resolve the display identity of a sales line item.
 *
 * Every "view detail" modal in the sales flow (invoice, quotation, order) shows
 * the same two facts in its Description column: the item name, and a stable
 * item number that links through to the inventory item detail page.
 *
 * The resolution order is deliberately forgiving because line items are written
 * by several flows (order form, quotation builder, invoice conversion) that do
 * not all persist the same subset of fields:
 *
 *   matched item  → the inventory record, matched on `productId` first and on
 *                   the line `id` as a fallback (conversion flows sometimes
 *                   write the product id into the line id).
 *   number text   → for a VARIANT line, the variant's own persisted `sku`
 *                   (resolved from the parent record via `variantId`), then the
 *                   line's own `sku`, then the matched item's `sku`, then
 *                   `productId`, then the line `id`. The parent SKU is never
 *                   presented as though it were the variant's SKU.
 *   detail id     → only the matched inventory record. A line with no
 *                   inventory match renders as plain text: there is no item
 *                   detail page to open, so it must not look clickable.
 */

export interface LineItemLike {
  id?: string | null;
  productId?: string | null;
  sku?: string | null;
  /** Stable variant id — the relational identity of the ordered variant. */
  variantId?: string | null;
  variant_id?: string | null;
  parentId?: string | null;
  [key: string]: any;
}

export interface InventoryItemLike {
  id?: string | null;
  sku?: string | null;
  variants?: Array<{ id?: string | null; sku?: string | null; name?: string | null }> | null;
  [key: string]: any;
}

export interface LineItemIdentity {
  /** The matched inventory item, when one exists. */
  item: InventoryItemLike | null;
  /** Always-visible reference rendered as `#<text>`; null when nothing to show. */
  itemNumberText: string | null;
  /** Target id for the item detail page; null when the line is not in inventory. */
  itemDetailId: string | null;
}

/**
 * The variant a line refers to, resolved from the PARENT inventory record.
 * Identity is the stable `variantId` — the SKU is display only and is never
 * used to resolve the record.
 */
export function resolveLineVariant(
  line: LineItemLike | null | undefined,
  parent: InventoryItemLike | null,
): { id: string | null; sku: string | null; name: string | null } | null {
  const variantId = line?.variantId ?? line?.variant_id ?? null;
  if (!variantId) return null;
  const variants = Array.isArray(parent?.variants) ? parent.variants : [];
  const match = variants.find(v => String(v?.id ?? '') === String(variantId));
  if (!match) return null;
  return {
    id: String(match.id),
    sku: match.sku ? String(match.sku) : null,
    name: match.name ? String(match.name) : null,
  };
}

export function resolveLineItemIdentity(
  line: LineItemLike | null | undefined,
  inventory: InventoryItemLike[] | null | undefined,
): LineItemIdentity {
  const stock = Array.isArray(inventory) ? inventory : [];

  const item =
    (line?.productId ? stock.find(i => i.id === line.productId) : undefined) ??
    (line?.parentId ? stock.find(i => i.id === line.parentId) : undefined) ??
    (line?.id ? stock.find(i => i.id === line.id) : undefined) ??
    null;

  const variant = resolveLineVariant(line, item);

  // Variant first: a variant line must display the VARIANT's SKU. For a
  // non-variant line this is null and the existing item-SKU order applies.
  const itemNumberText =
    variant?.sku ||
    line?.sku ||
    item?.sku ||
    line?.productId ||
    line?.id ||
    null;

  return {
    item,
    itemNumberText: itemNumberText ? String(itemNumberText) : null,
    itemDetailId: item?.id ? String(item.id) : null,
  };
}

/** Route for the inventory item detail page. */
export const itemDetailPath = (itemDetailId: string): string =>
  `/supply-chain/inventory/${encodeURIComponent(itemDetailId)}`;

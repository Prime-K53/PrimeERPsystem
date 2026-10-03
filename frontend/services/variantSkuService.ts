/**
 * variantSkuService.ts — CANONICAL variant identity for Prime ERP.
 *
 * Hierarchy (the only shape the ERP supports):
 *
 *   Inventory Item            -> item.id, item.sku
 *     └── Variant             -> variant.id (STABLE relational identity)
 *           ├── variant.sku  (unique across the WHOLE inventory namespace)
 *           ├── attributes / pricing / stock
 *
 * Rules encoded here (single source of truth — never re-implement in a screen):
 *
 *  1. `variant.id` is the stable relational identity used by POS / orders /
 *     invoices / stock movements. SKU is NEVER used as database identity.
 *  2. `variant.sku` is a persisted, human readable, globally unique value.
 *     Uniqueness spans parent item SKUs AND every variant SKU in the ERP.
 *  3. Generation is deterministic and readable:
 *         PAPER-001      (parent)
 *         PAPER-001-A4   (variant)
 *         PAPER-001-A4-BLUE
 *     It reuses the existing ERP SKU convention (hyphenated, uppercase,
 *     category-prefixed `INV-XXX-NNNN` parents + hyphenated attribute
 *     suffixes). No random opaque identifiers.
 *  4. Existing values are never regenerated: an already-populated
 *     `variant.id` / `variant.sku` is preserved verbatim, so the write path is
 *     safe to run on every save and the migration is idempotent.
 */

import type { Item } from '../types';

/** Anything that can act as a variant while migrating legacy records. */
export interface VariantLike {
  id?: string | null;
  sku?: string | null;
  name?: string | null;
  attributes?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface SkuOwner {
  kind: 'item' | 'variant';
  itemId: string;
  itemName: string;
  variantId?: string;
  variantName?: string;
}

export interface VariantSkuRegistry {
  /** normalised (upper-case, trimmed) SKU -> current owner */
  readonly owners: Map<string, SkuOwner>;
  /** normalised SKUs only (cheap membership test) */
  has(sku: string): boolean;
  /** claim a SKU for an owner (last writer wins — callers validate first) */
  claim(sku: string, owner: SkuOwner): void;
  release(sku: string, owner?: SkuOwner): void;
  /** first owner registered for a SKU */
  find(sku: string): SkuOwner | undefined;
}

/** Upper-case / trim comparison key used for every uniqueness decision. */
export const normalizeSkuKey = (sku: unknown): string =>
  String(sku ?? '').trim().toUpperCase();

/**
 * Deterministic token for a variant, derived from its attributes first and
 * then from its name. Mirrored by the SQL migration
 * (`supabase/migrations/0036_inventory_variant_sku.sql`) so both runtimes
 * produce the same candidate SKU.
 *
 * `A4 Blue`          -> `A4-BLUE`
 * `48 Pages`         -> `48-PAGES`
 * `Exercise Book - A4 Blue` -> `A4-BLUE` (parent prefix stripped)
 */
export const slugifyVariantToken = (
  variantName: unknown,
  parentName?: unknown,
  attributes?: Record<string, unknown> | null,
): string => {
  let source = String(variantName ?? '').trim();
  const parent = String(parentName ?? '').trim();
  if (parent && source.toUpperCase().startsWith(parent.toUpperCase())) {
    source = source.slice(parent.length);
  }

  const clean = (value: string): string =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)
      .replace(/-$/, '');

  // The variant NAME is the readable description of the configuration
  // ("48 Pages", "A4 Blue"), so it leads. Attributes are only consulted when
  // the name yields no usable token — prefixing `pages=48` onto `48 Pages`
  // would produce the unreadable `PAGES-48-48-PAGES`.
  const nameToken = clean(source);
  if (nameToken) return nameToken;

  const attributeToken = Object.entries(attributes || {})
    .filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '')
    .map(([key, value]) => clean(`${key} ${value}`))
    .filter(Boolean)
    .join('-');

  return attributeToken || 'V';
};

/**
 * The *base* (pre-uniquification) SKU for a variant. Deterministic and
 * collision-free within a single parent as long as the variant token differs.
 */
export const buildVariantSkuBase = (
  parentSku: unknown,
  parentId: unknown,
  variant: VariantLike,
  parentName?: unknown,
): string => {
  const parentKey =
    normalizeSkuKey(parentSku) || normalizeSkuKey(parentId) || 'ITEM';
  const token = slugifyVariantToken(variant?.name, parentName, variant?.attributes);
  return `${parentKey}-${token}`;
};

/**
 * Stable variant id for variants that predate variant ids. Deterministic
 * (parent id + 1-based position) so a re-run of the migration produces the
 * exact same id — the migration is therefore idempotent.
 */
export const buildVariantId = (parentId: unknown, index: number): string => {
  const parentKey = String(parentId ?? '').trim() || 'ITEM';
  return `VAR-${parentKey}-${index + 1}`;
};

/**
 * First free SKU starting at `base`, appending `-2`, `-3`, … deterministically.
 */
export const resolveUniqueVariantSku = (
  base: string,
  isTaken: (candidateKey: string) => boolean,
): string => {
  if (!isTaken(normalizeSkuKey(base))) return base;
  let suffix = 2;
  // Bounded so a pathological dataset can never spin forever.
  while (suffix < 10000) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(normalizeSkuKey(candidate))) return candidate;
    suffix += 1;
  }
  return `${base}-${suffix}`;
};

const isBlank = (value: unknown) => String(value ?? '').trim() === '';

/**
 * Build the global SKU registry from every parent item SKU and every variant
 * SKU currently in the ERP. One registry == one namespace, which is what makes
 * "a variant SKU may never collide with any parent item SKU" enforceable.
 */
export const buildSkuRegistry = (items: readonly (Item | Record<string, unknown>)[]): VariantSkuRegistry => {
  const owners = new Map<string, SkuOwner>();

  const registry: VariantSkuRegistry = {
    owners,
    has: (sku) => owners.has(normalizeSkuKey(sku)),
    claim: (sku, owner) => {
      const key = normalizeSkuKey(sku);
      if (!key) return;
      owners.set(key, owner);
    },
    release: (sku, owner) => {
      const key = normalizeSkuKey(sku);
      const current = owners.get(key);
      if (!current) return;
      if (!owner) {
        owners.delete(key);
        return;
      }
      // Only release when the caller actually owns the entry.
      if (
        current.itemId === owner.itemId &&
        (owner.variantId === undefined || current.variantId === owner.variantId)
      ) {
        owners.delete(key);
      }
    },
    find: (sku) => owners.get(normalizeSkuKey(sku)),
  };

  for (const item of items || []) {
    const anyItem = item as Record<string, unknown>;
    const itemId = String(anyItem.id ?? '');
    const itemName = String(anyItem.name ?? '');
    const itemSku = anyItem.sku;
    if (!isBlank(itemSku)) {
      registry.claim(String(itemSku), { kind: 'item', itemId, itemName });
    }
    const variants = Array.isArray(anyItem.variants) ? (anyItem.variants as VariantLike[]) : [];
    variants.forEach((variant, index) => {
      if (!variant || isBlank(variant.sku)) return;
      registry.claim(String(variant.sku), {
        kind: 'variant',
        itemId,
        itemName,
        variantId: variant.id ? String(variant.id) : buildVariantId(itemId, index),
        variantName: variant.name ? String(variant.name) : undefined,
      });
    });
  }

  return registry;
};

/** Human readable conflict description, or null when the SKU is free. */
export const describeSkuConflict = (
  sku: string,
  registry: VariantSkuRegistry,
  context?: { itemId?: string; variantId?: string },
): string | null => {
  const owner = registry.find(sku);
  if (!owner) return null;
  // Saving the same record with its own current SKU is a no-op, not a conflict.
  if (
    context?.itemId &&
    owner.itemId === context.itemId &&
    (context.variantId === undefined || owner.variantId === context.variantId)
  ) {
    return null;
  }
  const label = normalizeSkuKey(sku);
  if (owner.kind === 'item') {
    return `SKU "${label}" is already used by item "${owner.itemName || owner.itemId}"`;
  }
  return `SKU "${label}" is already used by variant "${owner.variantName || owner.variantId}" of item "${owner.itemName || owner.itemId}"`;
};

export interface VariantNormalizeOptions {
  /** Full inventory (used to build the global namespace). */
  allItems: readonly (Item | Record<string, unknown>)[];
  /**
   * When true (default) a free SKU is generated for variants that have none.
   * Set to false to validate only — the caller then gets an error.
   */
  generateMissingSku?: boolean;
  /**
   * What to do when a variant SKU collides with another record.
   * - 'error' (default, write path): surface the failure, persist nothing.
   * - 'keep'  (read path): leave the stored SKU untouched and keep reading.
   */
  onConflict?: 'error' | 'keep';
}

export interface VariantNormalizeResult {
  item: Item;
  /** true when at least one variant gained an id or a SKU */
  changed: boolean;
  /** deterministic ids/SKUs proposed for variants that had none */
  assigned: Array<{ variantId: string; variantSku: string; variantName: string }>;
  /** hard validation failure — the caller must NOT persist */
  error?: string;
}

/**
 * Give every variant of an item a stable id and a unique persisted SKU.
 *
 * - existing ids and SKUs are preserved verbatim (idempotent, backward safe)
 * - the item's OWN variants are released from the registry before claiming so
 *   an unrelated save never collides with itself
 * - never touches prices, stock, attributes or transaction references
 */
export const ensureItemVariantIdentities = (
  item: Item,
  options: VariantNormalizeOptions,
): VariantNormalizeResult => {
  const generateMissingSku = options.generateMissingSku !== false;
  const onConflict = options.onConflict === 'keep' ? 'keep' : 'error';
  const variants = Array.isArray(item?.variants) ? (item.variants as VariantLike[]) : [];

  if (variants.length === 0) {
    return { item, changed: false, assigned: [] };
  }

  const itemId = String((item as unknown as Record<string, unknown>).id ?? '');
  const itemName = String(item?.name ?? '');

  // Start from the global namespace minus this item's current variants so an
  // in-flight edit is compared against the rest of the ERP only.
  // Read-time normalisation may not have the full catalog handy — in that case
  // this item (its parent SKU + sibling variants) IS the namespace.
  const namespace =
    Array.isArray(options.allItems) && options.allItems.length > 0 ? options.allItems : [item];
  const registry = buildSkuRegistry(namespace);
  variants.forEach((variant, index) => {
    if (variant && !isBlank(variant.sku)) {
      registry.release(String(variant.sku), {
        kind: 'variant',
        itemId,
        itemName,
        variantId: variant.id ? String(variant.id) : buildVariantId(itemId, index),
      });
    }
  });

  const usedVariantIds = new Set<string>();
  const claimedParentSku = normalizeSkuKey(item?.sku);
  const assigned: VariantNormalizeResult['assigned'] = [];
  let changed = false;

  const nextVariants: VariantLike[] = [];
  for (let index = 0; index < variants.length; index += 1) {
    const source: VariantLike = { ...(variants[index] || {}) };
    const originalId = source.id ? String(source.id).trim() : '';
    const variantId = originalId || buildVariantId(itemId, index);
    if (!originalId) {
      source.id = variantId;
      changed = true;
    }
    // Duplicate ids inside one item would break every variant lookup.
    if (usedVariantIds.has(variantId)) {
      const deduped = `${variantId}-${index + 1}`;
      usedVariantIds.add(deduped);
      source.id = deduped;
      changed = true;
    } else {
      usedVariantIds.add(variantId);
    }

    const originalSku = source.sku ? String(source.sku).trim() : '';
    let sku = originalSku;

    if (sku) {
      // A parent SKU may never double as one of its own variants' SKUs.
      const conflict = normalizeSkuKey(sku) === claimedParentSku
        ? `Variant SKU "${sku}" is already used by the parent item "${itemName || itemId}"`
        : describeSkuConflict(sku, registry, { itemId, variantId });
      if (conflict) {
        if (onConflict === 'keep') {
          // Read path: never rewrite a stored SKU, just carry it through.
          nextVariants.push(source);
          continue;
        }
        return { item, changed, assigned, error: conflict };
      }
    } else if (generateMissingSku) {
      const base = buildVariantSkuBase(item?.sku, itemId, source, itemName);
      sku = resolveUniqueVariantSku(base, (key) =>
        key === claimedParentSku || registry.has(key),
      );
      assigned.push({ variantId: String(source.id), variantSku: sku, variantName: String(source.name ?? '') });
    }

    if (sku) {
      if (normalizeSkuKey(sku) !== normalizeSkuKey(originalSku)) changed = true;
      source.sku = sku;
      registry.claim(sku, {
        kind: 'variant',
        itemId,
        itemName,
        variantId: String(source.id),
        variantName: String(source.name ?? ''),
      });
    }

    // productId keeps the embedded variant aligned with the ProductVariant type.
    if (itemId && !source.productId) {
      source.productId = itemId;
      changed = true;
    }

    nextVariants.push(source);
  }

  const nextItem = { ...item, variants: nextVariants as Item['variants'] } as Item;
  return { item: nextItem, changed, assigned };
};

/** Convenience: throws on a uniqueness violation (used by the write path). */
export const assertItemVariantIdentities = (
  item: Item,
  options: VariantNormalizeOptions,
): VariantNormalizeResult => {
  const result = ensureItemVariantIdentities(item, options);
  if (result.error) throw new Error(result.error);
  return result;
};

export interface VariantBackfillProposal {
  itemId: string;
  itemName: string;
  itemSku: string;
  variantId: string;
  variantName: string;
  proposedSku: string;
  /** true when the variant had neither id nor sku */
  isNewIdentity: boolean;
  /** true when the variant already carried a SKU (never rewritten) */
  alreadyHadSku: boolean;
  /** why the base candidate had to be suffixed */
  collisionWith: SkuOwner | null;
}

export interface VariantBackfillPlan {
  /** total variants inspected */
  totalVariants: number;
  /** variants that will receive a SKU */
  missingSku: number;
  /** variants that already have a SKU (left untouched) */
  alreadyHasSku: number;
  /** variants that will receive a stable id */
  missingId: number;
  /** items whose `variants` array will be written */
  itemsToChange: number;
  proposals: VariantBackfillProposal[];
  /** SKU keys claimed by more than one record after the plan runs */
  collisions: Array<{ sku: string; owners: SkuOwner[] }>;
  /** true when re-running the plan produces no further changes */
  idempotent: boolean;
}

/**
 * READ-ONLY analysis of the migration: what would change, which SKUs are
 * proposed, and which collisions were detected. Executes no writes.
 */
export const planVariantSkuBackfill = (
  items: readonly (Item | Record<string, unknown>)[],
): VariantBackfillPlan => {
  const registry = buildSkuRegistry(items || []);
  const proposals: VariantBackfillProposal[] = [];
  const touchedItems = new Set<string>();

  let totalVariants = 0;
  let missingSku = 0;
  let alreadyHasSku = 0;
  let missingId = 0;

  for (const rawItem of items || []) {
    const item = rawItem as Record<string, unknown>;
    const variants = Array.isArray(item.variants) ? (item.variants as VariantLike[]) : [];
    if (variants.length === 0) continue;

    const itemId = String(item.id ?? '');
    const itemName = String(item.name ?? '');

    // Release this item's own variants: they are the records being repaired.
    variants.forEach((variant, index) => {
      if (variant && !isBlank(variant.sku)) {
        registry.release(String(variant.sku), {
          kind: 'variant',
          itemId,
          itemName,
          variantId: variant.id ? String(variant.id) : buildVariantId(itemId, index),
        });
      }
    });

    variants.forEach((variant, index) => {
      totalVariants += 1;
      const variantId = variant?.id ? String(variant.id).trim() : buildVariantId(itemId, index);
      const variantName = String(variant?.name ?? '');
      const existingSku = variant?.sku ? String(variant.sku).trim() : '';

      if (!variant?.id) missingId += 1;

      if (existingSku) {
        alreadyHasSku += 1;
        registry.claim(existingSku, { kind: 'variant', itemId, itemName, variantId, variantName });
        return;
      }

      missingSku += 1;
      const base = buildVariantSkuBase(item.sku, itemId, variant || {}, itemName);
      const beforeClaim = normalizeSkuKey(base);
      const claimedBy = registry.find(base) || null;
      const sku = resolveUniqueVariantSku(base, (key) =>
        normalizeSkuKey(item.sku) === key || registry.has(key),
      );
      proposals.push({
        itemId,
        itemName,
        itemSku: String(item.sku ?? ''),
        variantId,
        variantName,
        proposedSku: sku,
        isNewIdentity: !variant?.id,
        alreadyHadSku: false,
        collisionWith: claimedBy || (normalizeSkuKey(item.sku) === beforeClaim ? { kind: 'item' as const, itemId, itemName } : null),
      });
      touchedItems.add(itemId);
      registry.claim(sku, { kind: 'variant', itemId, itemName, variantId, variantName });
    });
  }

  // Post-plan collision detection. Re-walk the dataset substituting each
  // proposed SKU onto the variant that would receive it, then report any SKU
  // claimed by more than one record (parent item or variant).
  const proposalsByVariant = new Map<string, string>();
  for (const proposal of proposals) {
    proposalsByVariant.set(`${proposal.itemId}::${proposal.variantId}`, proposal.proposedSku);
  }

  const claims = new Map<string, SkuOwner[]>();
  const claim = (sku: unknown, owner: SkuOwner) => {
    const key = normalizeSkuKey(sku);
    if (!key) return;
    const bucket = claims.get(key) || [];
    bucket.push(owner);
    claims.set(key, bucket);
  };

  for (const rawItem of items || []) {
    const anyItem = rawItem as Record<string, unknown>;
    const itemId = String(anyItem.id ?? '');
    const itemName = String(anyItem.name ?? '');
    claim(anyItem.sku, { kind: 'item', itemId, itemName });
    const variants = Array.isArray(anyItem.variants) ? (anyItem.variants as VariantLike[]) : [];
    variants.forEach((variant, index) => {
      const variantId = variant?.id ? String(variant.id) : buildVariantId(itemId, index);
      const effectiveSku =
        proposalsByVariant.get(`${itemId}::${variantId}`) ?? variant?.sku;
      claim(effectiveSku, {
        kind: 'variant',
        itemId,
        itemName,
        variantId,
        variantName: String(variant?.name ?? ''),
      });
    });
  }

  const collisions = Array.from(claims.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([sku, owners]) => ({ sku, owners }));

  return {
    totalVariants,
    missingSku,
    alreadyHasSku,
    missingId,
    itemsToChange: touchedItems.size,
    proposals,
    collisions,
    // Idempotent by construction: proposals are only produced for variants
    // that have no SKU at all, so a second run finds nothing to do.
    idempotent: true,
  };
};

/**
 * Apply a backfill plan to an item WITHOUT touching anything except
 * `variant.id` / `variant.sku`. Prices, stock, attributes, parent linkage and
 * every other field are passed through untouched.
 */
export const applyVariantIdentityBackfill = (
  item: Item,
  proposals: readonly VariantBackfillProposal[],
  allItems: readonly (Item | Record<string, unknown>)[],
): { item: Item; changed: boolean } => {
  const byVariant = new Map<string, string>();
  for (const proposal of proposals) {
    byVariant.set(`${proposal.itemId}::${proposal.variantId}`, proposal.proposedSku);
  }
  const result = ensureItemVariantIdentities(item, { allItems });
  return { item: result.item, changed: result.changed };
};

/** Human readable label for a variant line, used by UI + search. */
export const describeVariant = (variant: VariantLike, parent?: { name?: string; sku?: string }): string => {
  const name = String(variant?.name ?? '').trim();
  const sku = String(variant?.sku ?? '').trim();
  return [name || sku || 'Variant', sku].filter(Boolean).join(' · ');
};

/** True when a transaction line refers to a variant rather than the parent. */
export const isVariantLine = (line: Record<string, unknown> | null | undefined): boolean => {
  if (!line) return false;
  const variantId = line.variantId ?? line.variant_id;
  return variantId !== undefined && variantId !== null && String(variantId).trim() !== '';
};
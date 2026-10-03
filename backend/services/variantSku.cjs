/**
 * variantSku.cjs — server-side variant identity rules.
 *
 * The sync gateway (`POST /api/sync/ops`) is the single authoritative write
 * path for ERP business data, so SKU/variant-SKU uniqueness MUST be enforced
 * here — frontend validation is only an immediate-feedback convenience.
 *
 * The rule set is deliberately kept identical to the browser implementation in
 * `frontend/services/variantSkuService.ts`:
 *
 *   parent item  : id + sku
 *   variant      : id (stable relational identity) + sku (globally unique)
 *
 * A variant SKU may not collide with:
 *   - another parent inventory item's SKU
 *   - any other variant's SKU (same or different parent)
 *
 * A parent item's own SKU changing onto one of its own variants is also a
 * collision. Editing a record to the SKU it already holds is always allowed.
 */

const ALLOWED_SKU = /^[A-Za-z0-9][A-Za-z0-9._\-\/]*$/;
const MAX_SKU_LENGTH = 64;

const normalizeSkuKey = (sku) => String(sku == null ? '' : sku).trim().toUpperCase();

const isBlank = (value) => String(value == null ? '' : value).trim() === '';

function slugifyVariantToken(variantName, parentName, attributes) {
  let source = String(variantName == null ? '' : variantName).trim();
  const parent = String(parentName == null ? '' : parentName).trim();
  if (parent && source.toUpperCase().startsWith(parent.toUpperCase())) {
    source = source.slice(parent.length);
  }

  const clean = (value) =>
    String(value)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)
      .replace(/-$/, '');

  // The variant NAME is the readable description of the configuration
  // ("48 Pages", "A4 Blue"), so it leads. Attributes are only used when the
  // name yields no usable token — otherwise `pages=48 48 Pages` would double up
  // and produce the unreadable `PAGES-48-48-PAGES`.
  const nameToken = clean(source);
  if (nameToken) return nameToken;

  const attrToken = Object.entries(attributes && typeof attributes === 'object' ? attributes : {})
    .filter(([, value]) => value != null && String(value).trim() !== '')
    .map(([key, value]) => clean(`${key} ${value}`))
    .filter(Boolean)
    .join('-');

  return attrToken || 'V';
}

/** Deterministic, human-readable base SKU for a variant. */
function buildVariantSkuBase(parentSku, parentId, variant, parentName) {
  const parentKey = normalizeSkuKey(parentSku) || normalizeSkuKey(parentId) || 'ITEM';
  const token = slugifyVariantToken(variant && variant.name, parentName, variant && variant.attributes);
  return `${parentKey}-${token}`;
}

/** Stable, deterministic id for variants that predate variant ids. */
function buildVariantId(parentId, index) {
  const parentKey = String(parentId == null ? '' : parentId).trim() || 'ITEM';
  return `VAR-${parentKey}-${index + 1}`;
}

function firstFreeVariantSku(base, isTaken) {
  if (!isTaken(normalizeSkuKey(base))) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!isTaken(normalizeSkuKey(candidate))) return candidate;
  }
  return `${base}-${suffix}`;
}

/**
 * Collect every SKU already taken in the ERP inventory namespace.
 *
 * @param {Array<{id: string, data: object}>} productRows `products` rows
 * @param {object} options
 * @param {string} options.excludeId skip this product row (it is the one being saved)
 * @returns {{ owners: Map<string, object> }}
 */
function buildSkuIndex(productRows, options = {}) {
  const owners = new Map();
  const excludeId = options.excludeId ? String(options.excludeId) : null;

  for (const row of productRows || []) {
    const data = (row && row.data && typeof row.data === 'object') ? row.data : (row || {});
    const rowId = String((row && row.id) || data.id || '');
    if (excludeId && rowId === excludeId) continue;

    const itemId = String(data.id || rowId);
    const itemName = String(data.name || '');

    if (!isBlank(data.sku)) {
      owners.set(normalizeSkuKey(data.sku), { kind: 'item', itemId, itemName });
    }

    const variants = Array.isArray(data.variants) ? data.variants : [];
    variants.forEach((variant, index) => {
      if (!variant || isBlank(variant.sku)) return;
      owners.set(normalizeSkuKey(variant.sku), {
        kind: 'variant',
        itemId,
        itemName,
        variantId: String(variant.id || buildVariantId(itemId, index)),
        variantName: variant.name == null ? '' : String(variant.name),
      });
    });
  }

  return { owners };
}

function describeConflict(key, owner, context) {
  if (
    context &&
    owner.itemId === context.itemId &&
    (context.variantId === undefined || owner.variantId === context.variantId)
  ) {
    return null; // the record keeping its own SKU
  }
  if (owner.kind === 'item') {
    return `SKU "${key}" is already used by item "${owner.itemName || owner.itemId}"`;
  }
  return `SKU "${key}" is already used by variant "${owner.variantName || owner.variantId}" of item "${owner.itemName || owner.itemId}"`;
}

/**
 * Validate an incoming `products` payload and stamp any missing variant
 * identity onto it (in place). Returns an error string, or null on success.
 *
 * @param {object} payload the products document being written
 * @param {Array} productRows all products rows (for the global namespace)
 * @returns {string|null} validation error message
 */
function validateProductsPayload(payload, productRows) {
  if (!payload || typeof payload !== 'object') return null;

  const itemId = String(payload.id || '');
  const itemName = String(payload.name || '');

  if (!isBlank(payload.sku) && !ALLOWED_SKU.test(String(payload.sku).trim())) {
    return `Invalid SKU "${payload.sku}": only letters, digits, dot, dash, underscore and slash are allowed (max ${MAX_SKU_LENGTH} characters).`;
  }
  if (String(payload.sku || '').trim().length > MAX_SKU_LENGTH) {
    return `SKU exceeds the maximum length of ${MAX_SKU_LENGTH} characters.`;
  }

  const variants = Array.isArray(payload.variants) ? payload.variants : [];
  if (variants.length === 0) return null;

  // Namespace = the rest of the ERP, plus (for a parent-SKU collision check)
  // this record's own parent SKU and its own variants.
  const { owners } = buildSkuIndex(productRows, { excludeId: itemId });

  const itemKey = normalizeSkuKey(payload.sku);
  const usedVariantIds = new Set();

  // A candidate is unavailable when it equals this parent's own SKU, or when
  // another record already owns it. (An owner that IS this record's own
  // variant is fine — that is the "keep my current SKU" case.)
  const isTakenForVariant = (key, variantId) => {
    if (key === itemKey) return true;
    const owner = owners.get(key);
    if (!owner) return false;
    return describeConflict(key, owner, { itemId, variantId }) !== null;
  };

  for (let index = 0; index < variants.length; index += 1) {
    const variant = variants[index];
    if (!variant || typeof variant !== 'object') continue;

    if (!variant.id || isBlank(variant.id)) {
      variant.id = buildVariantId(itemId, index);
    }
    const variantId = String(variant.id);
    if (usedVariantIds.has(variantId)) {
      variant.id = `${variantId}-${index + 1}`;
    }
    usedVariantIds.add(String(variant.id));

    if (variant.sku != null && !isBlank(variant.sku)) {
      const sku = String(variant.sku).trim();
      if (!ALLOWED_SKU.test(sku)) {
        return `Invalid variant SKU "${sku}" for "${variant.name || variant.id}": only letters, digits, dot, dash, underscore and slash are allowed.`;
      }
      if (sku.length > MAX_SKU_LENGTH) {
        return `Variant SKU exceeds the maximum length of ${MAX_SKU_LENGTH} characters.`;
      }
      const key = normalizeSkuKey(sku);
      const owner = owners.get(key);
      const conflict = owner
        ? describeConflict(key, owner, { itemId, variantId })
        : (key === itemKey
            ? `Variant SKU "${sku}" is already used by the parent item "${itemName || itemId}"`
            : null);
      if (conflict) return conflict;
      owners.set(key, { kind: 'variant', itemId, itemName, variantId: String(variant.id), variantName: String(variant.name || '') });
      continue;
    }

    // No SKU yet: mint the deterministic readable one.
    const base = buildVariantSkuBase(payload.sku, itemId, variant, itemName);
    const sku = firstFreeVariantSku(base, (key) => isTakenForVariant(key, String(variant.id)));
    variant.sku = sku;
    owners.set(normalizeSkuKey(sku), {
      kind: 'variant',
      itemId,
      itemName,
      variantId: String(variant.id),
      variantName: String(variant.name || ''),
    });
  }

  return null;
}

module.exports = {
  normalizeSkuKey,
  slugifyVariantToken,
  buildVariantSkuBase,
  buildVariantId,
  firstFreeVariantSku,
  buildSkuIndex,
  validateProductsPayload,
  MAX_SKU_LENGTH,
};
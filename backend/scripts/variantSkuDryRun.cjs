/**
 * variantSkuDryRun.cjs — READ-ONLY audit of inventory variant identity.
 *
 * Reports, without writing anything:
 *   - total number of variants
 *   - variants missing a SKU / missing a stable id
 *   - the SKU each variant would receive (same rule as the ERP write path)
 *   - SKU collisions detected in the current data
 *   - the records the backfill would change
 *
 * Running it NEVER modifies data. Applying the backfill is a separate,
 * explicit step (see supabase/migrations/0036_inventory_variant_sku.sql).
 *
 *   node scripts/variantSkuDryRun.cjs            # human readable
 *   node scripts/variantSkuDryRun.cjs --json     # machine readable
 */
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const {
  buildVariantSkuBase,
  buildVariantId,
  normalizeSkuKey,
} = require('../services/variantSku.cjs');

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch { /* noop */ }
})();

const BASE = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = process.env.SUPABASE_SECRET_KEY || '';
const AS_JSON = process.argv.includes('--json');

if (!BASE || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SECRET_KEY. Nothing was read or written.');
  process.exit(1);
}

const HEADERS = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function fetchAllProductRows() {
  const out = [];
  const LIMIT = 200;
  for (let from = 0; ; from += LIMIT) {
    const res = await axios.get(`${BASE}/rest/v1/products`, {
      headers: HEADERS,
      params: { select: 'id,data', offset: from, limit: LIMIT },
      timeout: 30000,
    });
    const page = Array.isArray(res.data) ? res.data : [];
    out.push(...page);
    if (page.length < LIMIT) break;
  }
  return out;
}

/**
 * Mirrors erp_variant_sku_dry_run() / planVariantSkuBackfill(): walk every
 * product, and for each variant lacking a SKU pick the first free deterministic
 * candidate. Proposals are added to the taken set as we go, exactly like the
 * apply step does.
 */
function analyse(rows) {
  const taken = new Map();
  const rowsById = new Map();

  const items = rows.map((row) => {
    const data = row && row.data && typeof row.data === 'object' ? row.data : {};
    const id = String(row.id || data.id || '');
    rowsById.set(id, row);
    return { id, data };
  });

  for (const item of items) {
    if (item.data.sku) taken.set(normalizeSkuKey(item.data.sku), `item:${item.id}`);
    const variants = Array.isArray(item.data.variants) ? item.data.variants : [];
    variants.forEach((variant, index) => {
      if (!variant || !variant.sku) return;
      const variantId = String(variant.id || buildVariantId(item.id, index));
      taken.set(normalizeSkuKey(variant.sku), `variant:${item.id}:${variantId}`);
    });
  }

  const existingCollisions = new Map();
  for (const [key, owner] of taken) {
    const bucket = existingCollisions.get(key) || [];
    bucket.push(owner);
    existingCollisions.set(key, bucket);
  }

  let totalVariants = 0;
  let missingSku = 0;
  let missingId = 0;
  let alreadyHasSku = 0;
  const proposals = [];
  const recordsToChange = new Map();

  for (const item of items) {
    const variants = Array.isArray(item.data.variants) ? item.data.variants : [];
    if (variants.length === 0) continue;

    const parentKey = normalizeSkuKey(item.data.sku) || item.id;
    const seenIds = new Set();

    variants.forEach((variant, index) => {
      totalVariants += 1;
      const existingId = variant && variant.id ? String(variant.id).trim() : '';
      if (!existingId) missingId += 1;

      let variantId = existingId || buildVariantId(item.id, index);
      if (seenIds.has(variantId)) variantId = `${variantId}-${index + 1}`;
      seenIds.add(variantId);

      const existingSku = variant && variant.sku ? String(variant.sku).trim() : '';
      if (existingSku) {
        alreadyHasSku += 1;
        return;
      }

      missingSku += 1;
      const base = buildVariantSkuBase(item.data.sku, item.id, variant || {}, item.data.name);
      let candidate = base;
      let suffix = 2;
      const collidedWith = [];
      while (taken.has(normalizeSkuKey(candidate))) {
        collidedWith.push(taken.get(normalizeSkuKey(candidate)));
        candidate = `${base}-${suffix}`;
        suffix += 1;
        if (suffix > 10000) break;
      }

      taken.set(normalizeSkuKey(candidate), `variant:${item.id}:${variantId}`);
      proposals.push({
        itemId: item.id,
        itemName: item.data.name || '',
        itemSku: item.data.sku || '',
        variantId,
        variantName: (variant && variant.name) || '',
        proposedSku: candidate,
        isNewIdentity: !existingId,
        collidedWith,
      });

      const entry = recordsToChange.get(item.id) || { itemId: item.id, itemName: item.data.name || '', variants: 0 };
      entry.variants += 1;
      recordsToChange.set(item.id, entry);
    });
  }

  const collisions = Array.from(existingCollisions.entries())
    .filter(([, owners]) => owners.length > 1)
    .map(([sku, owners]) => ({ sku, owners }));

  return {
    products: items.length,
    productsWithVariants: Array.from(recordsToChange.values()).length + 0,
    totalVariants,
    missingSku,
    missingId,
    alreadyHasSku,
    proposals,
    recordsToChange: Array.from(recordsToChange.values()),
    collisions,
  };
}

(async () => {
  const rows = await fetchAllProductRows();
  const report = analyse(rows);

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log('── Inventory variant SKU dry run (READ-ONLY, no data changed) ──\n');
  console.log(`products scanned            : ${report.products}`);
  console.log(`variants found              : ${report.totalVariants}`);
  console.log(`variants missing a SKU      : ${report.missingSku}`);
  console.log(`variants missing a stable id: ${report.missingId}`);
  console.log(`variants already with a SKU : ${report.alreadyHasSku}`);
  console.log(`records that would change   : ${report.recordsToChange.length}`);

  console.log(`\npre-existing SKU collisions : ${report.collisions.length}`);
  for (const collision of report.collisions.slice(0, 50)) {
    console.log(`  ${collision.sku} <- ${collision.owners.join(', ')}`);
  }

  console.log(`\nproposed SKUs (${report.proposals.length}):`);
  for (const proposal of report.proposals.slice(0, 200)) {
    const flag = proposal.isNewIdentity ? ' (id + sku)' : ' (sku only)';
    const collision = proposal.collidedWith.length
      ? `  [collision avoided: ${proposal.collidedWith.join(', ')}]`
      : '';
    console.log(
      `  ${proposal.itemSku || proposal.itemId} :: "${proposal.variantName || '(unnamed)'}" -> ${proposal.proposedSku}${flag}${collision}`,
    );
  }
  if (report.proposals.length > 200) {
    console.log(`  … and ${report.proposals.length - 200} more`);
  }

  console.log('\nTo apply (explicit, operator-controlled):');
  console.log('  SELECT * FROM public.erp_backfill_variant_identity();');
  console.log('Nothing was modified by this script.');
})().catch((err) => {
  console.error('dry run failed:', err?.message || err);
  process.exit(1);
});
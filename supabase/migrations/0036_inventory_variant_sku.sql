-- 0036_inventory_variant_sku.sql
--
-- OBJECTIVE
--   Every inventory variant in Prime ERP must carry:
--       stable variant id  +  unique persisted SKU
--   A variant is a distinct inventory configuration and must be independently
--   identifiable, while the parent item keeps its own SKU and its own id.
--
-- DATA MODEL (shape unchanged — no table is restructured)
--   public.products.data -> 'variants' -> JSONB array, one object per variant:
--       { "id": "<stable id>", "sku": "<globally unique SKU>",
--         "name": ..., "attributes": ..., "costPrice"/"sellingPrice": ...,
--         "stock": ... }
--   `id` remains the RELATIONAL identity referenced by transactions
--   (variantId / variant_id on sales, invoices, sales orders, quotations,
--   purchase orders, goods receipts, stock movements and reservations).
--   This migration never rewrites any transaction row.
--
-- SAFETY GUARANTEES
--   * Parent item SKUs are NEVER changed, regenerated or renumbered.
--   * Variants are NEVER deleted, recreated or reordered.
--   * Variant prices, stock quantities, attributes and history are untouched.
--   * A variant that ALREADY has a sku keeps it verbatim — even if it looks
--     odd — because existing SKUs are never regenerated.
--   * A variant that ALREADY has an id keeps it verbatim, so every existing
--     transaction reference stays valid.
--   * The whole script is idempotent: it only ever writes variants that have no
--     id and/or no sku, so a second run reports zero changes.
--
-- SKU RULE (mirrors frontend/services/variantSkuService.ts and
-- backend/services/variantSku.cjs — one rule, three runtimes)
--   <PARENT_SKU_OR_ID>-<VARIANT_TOKEN>[-<n>]
--   VARIANT_TOKEN = the variant NAME, upper-cased, every run of non [A-Z0-9]
--                   collapsed to a single '-', max 24 chars. Variant attributes
--                   are only used when the name yields no usable token (they are
--                   not prefixed onto the name — that would double up, e.g.
--                   `pages=48` + `48 Pages` -> `PAGES-48-48-PAGES`).
--   '-<n>' is appended only when the base candidate is already taken.
--
-- HOW TO RUN
--   1) DRY RUN (read-only analysis — run this first):
--        SELECT * FROM public.erp_variant_sku_dry_run() ORDER BY item_id, variant_index;
--      Reports: total variants, variants missing a SKU, variants missing an id,
--      the proposed SKU for each, and any rows that would change.
--
--   2) APPLY (explicit, operator-controlled; NEVER run automatically):
--        SELECT * FROM public.erp_backfill_variant_identity();
--
--      A no-op when there is nothing to fix, so it is safe to re-run.

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Deterministic variant token (single definition, shared by dry-run + apply)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_variant_token(
  p_variant_name TEXT,
  p_parent_name  TEXT,
  p_attributes   JSONB
) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_source TEXT;
  v_token  TEXT;
  v_attrs  TEXT;
BEGIN
  v_source := COALESCE(p_variant_name, '');

  -- ItemModal stores variant names as "<parent name> - <variant>"; strip the
  -- parent prefix so the token describes the variant, not the parent.
  IF p_parent_name IS NOT NULL AND btrim(p_parent_name) <> ''
     AND upper(v_source) LIKE upper(btrim(p_parent_name)) || '%' THEN
    v_source := substr(v_source, length(btrim(p_parent_name)) + 1);
  END IF;

  -- The variant NAME is the readable description of the configuration
  -- ("48 Pages", "A4 Blue"), so it leads. Attributes are only used when the
  -- name yields no usable token (mirrors the browser/backend rule).
  v_token := upper(v_source);
  v_token := regexp_replace(v_token, '[^A-Z0-9]+', '-', 'g');
  v_token := regexp_replace(v_token, '-+', '-', 'g');
  v_token := regexp_replace(v_token, '^-+|-+$', '', 'g');
  IF length(v_token) > 24 THEN
    v_token := regexp_replace(substr(v_token, 1, 24), '-+$', '', 'g');
  END IF;

  IF v_token IS NOT NULL AND btrim(v_token) <> '' THEN
    RETURN v_token;
  END IF;

  -- Fall back to the variant's attributes.
  IF p_attributes IS NOT NULL AND jsonb_typeof(p_attributes) = 'object' THEN
    SELECT string_agg(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(upper(t.k || ' ' || COALESCE(t.v #>> '{}', '')), '[^A-Z0-9]+', '-', 'g'),
                   '-+', '-', 'g'),
                 '^-+|-+$', '', 'g'),
               '^(.{24}).*$', '\1', 'g'),
             '-' ORDER BY t.k)
      INTO v_attrs
      FROM jsonb_each(p_attributes) AS t(k, v)
     WHERE t.v IS NOT NULL
       AND btrim(t.v #>> '{}') <> '';
    IF v_attrs IS NOT NULL AND btrim(v_attrs) <> '' THEN
      RETURN v_attrs;
    END IF;
  END IF;

  RETURN 'V';
END;
$$;

COMMENT ON FUNCTION public.erp_variant_token(TEXT, TEXT, JSONB) IS
  'Deterministic variant SKU token: attributes then name, upper-cased, non [A-Z0-9] collapsed to a single dash, max 24 chars.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 0b. Stable id for variants that predate variant ids
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_variant_id(p_parent_id TEXT, p_index INT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT 'VAR-' || COALESCE(NULLIF(btrim(p_parent_id), ''), 'ITEM') || '-' || (p_index + 1);
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0c. Every SKU already taken in the inventory namespace, as one array.
--     Parent item SKUs AND every variant SKU, upper-cased for comparison.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_taken_inventory_skus()
RETURNS TEXT[]
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(array_agg(DISTINCT k), ARRAY[]::TEXT[])
    FROM (
      SELECT upper(btrim(p.data ->> 'sku')) AS k
        FROM public.products p
       WHERE btrim(COALESCE(p.data ->> 'sku', '')) <> ''
      UNION ALL
      SELECT upper(btrim(bv.variant ->> 'sku'))
        FROM public.products p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p.data -> 'variants') = 'array'
               THEN p.data -> 'variants' ELSE '[]'::jsonb END
        ) AS bv(variant)
       WHERE btrim(COALESCE(bv.variant ->> 'sku', '')) <> ''
    ) taken;
$$;

COMMENT ON FUNCTION public.erp_taken_inventory_skus() IS
  'Upper-cased list of every SKU already used by a parent item or a variant anywhere in the catalog.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. DRY RUN — read-only analysis. Performs NO writes whatsoever.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_variant_sku_dry_run()
RETURNS TABLE (
  item_id            TEXT,
  item_name          TEXT,
  item_sku           TEXT,
  variant_index      INT,
  existing_variant_id TEXT,
  existing_sku       TEXT,   -- NULL when the variant has no SKU yet
  proposed_variant_id TEXT,  -- the id that WOULD be minted
  proposed_sku       TEXT,   -- NULL when nothing would change
  would_change       BOOLEAN
)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  rec        RECORD;
  v_idx      INT;
  v_variant  JSONB;
  v_existing_id TEXT;
  v_existing_sku TEXT;
  v_vid      TEXT;
  v_parent_key TEXT;
  v_base     TEXT;
  v_candidate TEXT;
  v_suffix   INT;
  v_taken    TEXT[];
  v_seen_ids TEXT[] := ARRAY[]::TEXT[];
BEGIN
  -- Snapshot the namespace once. Newly proposed SKUs are appended as we walk,
  -- so a proposal never collides with an earlier proposal in this same run.
  v_taken := public.erp_taken_inventory_skus();

  FOR rec IN
    SELECT p.id AS pid, p.data AS pdata
      FROM public.products p
     WHERE jsonb_typeof(p.data -> 'variants') = 'array'
     ORDER BY p.id
  LOOP
    v_parent_key := COALESCE(NULLIF(btrim(rec.pdata ->> 'sku'), ''), btrim(rec.pid));

    FOR v_idx, v_variant IN
      SELECT (e).ord::INT - 1, (e).val
        FROM jsonb_array_elements(rec.pdata -> 'variants') WITH ORDINALITY AS e(val, ord)
    LOOP
      v_existing_id  := NULLIF(btrim(COALESCE(v_variant ->> 'id', '')), '');
      v_existing_sku := NULLIF(btrim(COALESCE(v_variant ->> 'sku', '')), '');

      -- Same id rule as the apply step.
      v_vid := COALESCE(v_existing_id, public.erp_variant_id(rec.pid, v_idx));
      IF v_vid = ANY(v_seen_ids) THEN
        v_vid := v_vid || '-' || (v_idx + 1);
      END IF;
      v_seen_ids := array_append(v_seen_ids, v_vid);

      item_id             := rec.pid;
      item_name           := COALESCE(rec.pdata ->> 'name', '');
      item_sku            := COALESCE(rec.pdata ->> 'sku', '');
      variant_index       := v_idx;
      existing_variant_id := v_existing_id;
      existing_sku        := v_existing_sku;
      proposed_variant_id := v_vid;

      IF v_existing_sku IS NOT NULL THEN
        -- Existing SKUs are never regenerated.
        proposed_sku := NULL;
      ELSE
        v_base := v_parent_key || '-' || public.erp_variant_token(
          v_variant ->> 'name', rec.pdata ->> 'name', v_variant -> 'attributes'
        );
        v_candidate := v_base;
        v_suffix := 2;
        LOOP
          EXIT WHEN NOT (upper(v_candidate) = ANY(v_taken));
          v_candidate := v_base || '-' || v_suffix;
          v_suffix := v_suffix + 1;
          EXIT WHEN v_suffix > 10000;
        END LOOP;
        proposed_sku := v_candidate;
        v_taken := array_append(v_taken, upper(v_candidate));
      END IF;

      would_change := (v_existing_id IS NULL) OR (v_existing_sku IS NULL)
                      OR (v_vid <> v_existing_id);
      RETURN NEXT;
    END LOOP;

    v_seen_ids := ARRAY[]::TEXT[];
  END LOOP;
END;
$$;

COMMENT ON FUNCTION public.erp_variant_sku_dry_run() IS
  'READ-ONLY. Reports every inventory variant, its current id/SKU and the SKU erp_backfill_variant_identity() WOULD assign. Performs no writes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. APPLY — explicit, idempotent backfill of variant id + sku
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_backfill_variant_identity()
RETURNS TABLE (
  item_id        TEXT,
  item_name      TEXT,
  variants_total INT,
  ids_filled     INT,
  skus_filled    INT,
  skus_preserved INT
)
LANGUAGE plpgsql AS $$
DECLARE
  rec       RECORD;
  v_variants JSONB;
  v_next    JSONB := '[]'::jsonb;
  v_elem    JSONB;
  v_idx     INT;
  v_vid     TEXT;
  v_parent_key TEXT;
  v_base     TEXT;
  v_candidate TEXT;
  v_suffix   INT;
  v_taken    TEXT[];
  v_seen_ids TEXT[] := ARRAY[]::TEXT[];
  v_ids      INT := 0;
  v_skus     INT := 0;
  v_kept     INT := 0;
  v_total    INT := 0;
BEGIN
  v_taken := public.erp_taken_inventory_skus();

  FOR rec IN
    SELECT p.id AS pid, p.data AS pdata
      FROM public.products p
     WHERE jsonb_typeof(p.data -> 'variants') = 'array'
     ORDER BY p.id
  LOOP
    v_next := '[]'::jsonb;
    v_parent_key := COALESCE(NULLIF(btrim(rec.pdata ->> 'sku'), ''), btrim(rec.pid));
    v_ids := 0; v_skus := 0; v_kept := 0; v_total := 0;

    FOR v_idx, v_elem IN
      SELECT (e).ord::INT - 1, (e).val
        FROM jsonb_array_elements(rec.pdata -> 'variants') WITH ORDINALITY AS e(val, ord)
    LOOP
      v_total := v_total + 1;

      -- 2a. stable id — an existing id is preserved verbatim
      IF btrim(COALESCE(v_elem ->> 'id', '')) = '' THEN
        v_vid := public.erp_variant_id(rec.pid, v_idx);
        v_elem := jsonb_set(v_elem, '{id}', to_jsonb(v_vid), true);
        v_ids := v_ids + 1;
      ELSE
        v_vid := btrim(v_elem ->> 'id');
      END IF;
      IF v_vid = ANY(v_seen_ids) THEN
        v_vid := v_vid || '-' || (v_idx + 1);
        v_elem := jsonb_set(v_elem, '{id}', to_jsonb(v_vid), true);
        v_ids := v_ids + 1;
      END IF;
      v_seen_ids := array_append(v_seen_ids, v_vid);

      -- 2b. unique SKU — an existing SKU is preserved verbatim
      IF btrim(COALESCE(v_elem ->> 'sku', '')) <> '' THEN
        v_kept := v_kept + 1;
        v_taken := array_append(v_taken, upper(btrim(v_elem ->> 'sku')));
      ELSE
        v_base := v_parent_key || '-' || public.erp_variant_token(
          v_elem ->> 'name', rec.pdata ->> 'name', v_elem -> 'attributes'
        );
        v_candidate := v_base;
        v_suffix := 2;
        LOOP
          EXIT WHEN NOT (upper(v_candidate) = ANY(v_taken));
          v_candidate := v_base || '-' || v_suffix;
          v_suffix := v_suffix + 1;
          EXIT WHEN v_suffix > 10000;
        END LOOP;

        v_elem := jsonb_set(v_elem, '{sku}', to_jsonb(v_candidate), true);
        v_skus := v_skus + 1;
        v_taken := array_append(v_taken, upper(v_candidate));
      END IF;

      v_next := v_next || jsonb_build_array(v_elem);
    END LOOP;

    -- Write ONLY when something actually changed. On a re-run every id and sku
    -- is already populated, so the row is left completely untouched.
    IF v_ids > 0 OR v_skus > 0 THEN
      UPDATE public.products p
         SET data = jsonb_set(p.data, '{variants}', v_next, true),
             updated_at = NOW()
       WHERE p.id = rec.pid;

      item_id        := rec.pid;
      item_name      := COALESCE(rec.pdata ->> 'name', '');
      variants_total := v_total;
      ids_filled     := v_ids;
      skus_filled    := v_skus;
      skus_preserved := v_kept;
      RETURN NEXT;
    END IF;

    v_seen_ids := ARRAY[]::TEXT[];
  END LOOP;

  RETURN;
END;
$$;

COMMENT ON FUNCTION public.erp_backfill_variant_identity() IS
  'Idempotent backfill: assigns a stable id and a globally unique SKU to every embedded inventory variant that lacks one. Never changes an existing id or sku, never changes parent SKUs, prices, stock, attributes or any transaction row. Re-running is a no-op.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. Post-apply verification (read-only)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.erp_variant_sku_status AS
SELECT
  bp.id                                        AS item_id,
  COALESCE(bp.data ->> 'name', '')            AS item_name,
  COALESCE(bp.data ->> 'sku', '')             AS item_sku,
  (bv.variant ->> 'id')                       AS variant_id,
  (bv.variant ->> 'name')                     AS variant_name,
  (bv.variant ->> 'sku')                      AS variant_sku,
  (bv.variant ->> 'stock')                    AS variant_stock,
  (bv.variant ->> 'costPrice')                AS variant_cost_price,
  (bv.variant ->> 'sellingPrice')             AS variant_selling_price
FROM public.products bp
CROSS JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(bp.data -> 'variants') = 'array'
       THEN bp.data -> 'variants' ELSE '[]'::jsonb END
) AS bv(variant);

COMMENT ON VIEW public.erp_variant_sku_status IS
  'One row per inventory variant with its stable id, SKU, stock and prices. Use to verify the backfill and to spot any duplicate SKU.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. Guard rails (structure only — no data change)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_products_variant_skus
  ON public.products USING GIN ((data -> 'variants'));
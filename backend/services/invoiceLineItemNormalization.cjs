/**
 * invoiceLineItemNormalization.cjs
 *
 * Single authoritative normalization layer for invoice line items.
 * Handles all historical field names and ensures unpaid/paid/partial all return
 * a consistent line-item structure regardless of payment status.
 *
 * Preserves:
 * - product/item name
 * - description
 * - quantity
 * - unit price
 * - line total
 * - SKU/product ID
 * - discounts
 * - tax fields
 * - any existing financial fields
 *
 * Non-destructive: never mutates historical data, only maps at API boundary.
 */

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function resolveItemName(x) {
  if (!x) return '';
  const candidates = [
    x.description,
    x.desc,
    x.item_description,
    x.itemDescription,
    x.item_name,
    x.itemName,
    x.name,
    x.productName,
    x.product_name,
    x.title,
    x.label,
    x.sku, // fallback if only SKU present
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim();
  }
  return '';
}

/**
 * Normalize a single raw line item into canonical portal shape.
 * Preserves all original fields plus canonical aliases.
 */
function normalizeSingleItem(it) {
  const x = it && typeof it === 'object' ? it : {};
  const resolvedName = resolveItemName(x);
  const qty = num(x.quantity ?? x.qty ?? x.quantityOrdered ?? x.qty_ordered);
  const unitPrice = num(
    x.unitPrice ??
      x.unit_price ??
      x.price ??
      x.selling_price ??
      x.sellingPrice ??
      x.unitCost ??
      x.unit_cost ??
      x.cost ??
      x.rate
  );
  const lineTotal = num(
    x.subtotal ??
      x.lineTotalNet ??
      x.line_total ??
      x.subTotal ??
      x.total ??
      x.lineTotal ??
      x.amount ??
      x.extendedPrice ??
      x.extended_price ??
      (qty * unitPrice)
  );
  const sku = x.sku ?? x.SKU ?? x.productSku ?? x.product_sku ?? null;
  const productId = x.productId ?? x.product_id ?? x.itemId ?? x.item_id ?? x.id ?? null;
  const description = x.description ?? x.desc ?? x.item_description ?? x.itemDescription ?? resolvedName ?? '';
  // Discount and tax preservation - keep whatever was present under multiple keys
  const discount = x.discount ?? x.discountAmount ?? x.discount_amount ?? x.discountPercent ?? x.discount_percent ?? null;
  const discountPercent = x.discountPercent ?? x.discount_percent ?? null;
  const discountAmount = x.discountAmount ?? x.discount_amount ?? null;
  const tax = x.tax ?? x.taxAmount ?? x.tax_amount ?? x.taxRate ?? x.tax_rate ?? null;
  const taxRate = x.taxRate ?? x.tax_rate ?? null;
  const taxAmount = x.taxAmount ?? x.tax_amount ?? null;

  return {
    // Preserve original raw for backward compat
    ...x,
    // Canonical fields for Portal UI (CustomerInvoiceDetail expects these)
    item_name: resolvedName || x.item_name || x.name || x.productName || 'Item',
    name: resolvedName || x.name || x.productName || 'Item',
    productName: resolvedName || x.productName || x.name || 'Item',
    description: String(description || ''),
    quantity: qty,
    qty: qty,
    unit_price: unitPrice,
    unitPrice: unitPrice,
    price: unitPrice,
    line_total: lineTotal,
    lineTotal: lineTotal,
    total: lineTotal,
    subtotal: lineTotal,
    // Identifiers
    sku: sku,
    productId: productId,
    product_id: productId,
    id: productId || x.id || undefined,
    itemId: productId || x.itemId || x.item_id || undefined,
    // Financial extras if present
    ...(discount != null ? { discount } : {}),
    ...(discountPercent != null ? { discountPercent, discount_percent: discountPercent } : {}),
    ...(discountAmount != null ? { discountAmount, discount_amount: discountAmount } : {}),
    ...(tax != null ? { tax } : {}),
    ...(taxRate != null ? { taxRate, tax_rate: taxRate } : {}),
    ...(taxAmount != null ? { taxAmount, tax_amount: taxAmount } : {}),
  };
}

/**
 * Map an array of raw items through normalization.
 * Returns [] for non-array.
 */
function mapInvoiceLineItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map(normalizeSingleItem);
}

/**
 * Extract raw items array from invoice data object `d` using all known
 * historical field names. Handles both array and JSON-string storage.
 * Critically, an empty array is treated as "no items" so fallback continues
 * rather than shadowing the real data in line_items_json.
 *
 * Candidate keys in priority order:
 * - items
 * - line_items
 * - lineItems
 * - invoiceItems
 * - invoice_items
 * - lines
 * - invoiceLines
 * - lines_items
 * - items_json / itemsJson
 * - line_items_json / lineItems_json / lineItemsJson
 * - invoice_items_json
 *
 * Returns [] if none found or all are empty.
 */
function extractRawItems(d) {
  if (!d || typeof d !== 'object') return null;

  const candidateKeys = [
    'items',
    'line_items',
    'lineItems',
    'invoiceItems',
    'invoice_items',
    'lines',
    'invoiceLines',
    'lines_items',
    'invoice_lines',
    'line_items_json',
    'lineItemsJson',
    'line_itemsJson',
    'items_json',
    'itemsJson',
    'invoice_items_json',
    'invoiceItemsJson',
    // Also check snake with json suffix inside d directly as string
  ];

  for (const key of candidateKeys) {
    const val = d[key];
    if (val == null) continue;
    if (Array.isArray(val)) {
      if (val.length > 0) return val; // non-empty wins immediately
      // empty array: continue to next candidate rather than returning empty
      continue;
    }
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        if (Array.isArray(parsed) && parsed.length === 0) continue; // treat empty as missing
        // If parsed is not array but object with items inside? ignore
      } catch {
        continue; // not JSON, skip
      }
    }
    // If val is object that itself contains array? Not expected
  }

  // Finally, check if any of the json string keys were not in candidate list but follow pattern
  // Also handle nested invoice data structures like d.data.items (but d is already data)
  return null;
}

/**
 * Public: given an invoice data object (the envelope's `data` field or a
 * flattened row), return normalized line items array (never null).
 * Handles all legacy structures, string JSON, empty-array shadowing, and
 * preserves quantity/unit price/line total etc.
 */
function normalizeInvoiceLineItems(d) {
  if (!d || typeof d !== 'object') return [];
  const raw = extractRawItems(d);
  if (raw == null) return [];
  return mapInvoiceLineItems(raw);
}

/**
 * Normalize full invoice row (Supabase envelope) to portal-facing shape.
 * Used by supabaseStore.mapInvoice and portalService fallbacks.
 * Does NOT filter based on paidAmount — ensures unpaid still has items.
 */
function normalizeInvoiceRow(row) {
  const d = (row && typeof row.data === 'object' && row.data) ? row.data : {};
  const lineItems = normalizeInvoiceLineItems(d);
  const totalAmount = num(d.totalAmount ?? d.total ?? d.total_amount ?? d.amount ?? 0);
  const paidAmount = num(d.paidAmount ?? d.paid_amount ?? d.paidAmount ?? 0);
  // Status: keep original if present, else infer but not used to filter items
  const status = d.status || (paidAmount > 0 ? (paidAmount >= totalAmount && totalAmount > 0 ? 'Paid' : 'Partial') : 'Unpaid');
  // Customer id handling: support both camel and snake
  const customerId = d.customerId ?? d.customer_id ?? d.customer_id ?? null;
  return {
    id: row.id,
    invoice_number: d.invoice_number || d.invoiceNumber || d.invoice_number_str || row.id,
    customer_name: d.customerName || d.customer_name || d.customer_name_legacy || '',
    customer_business_name: d.customerName || d.customer_name || '',
    total_amount: totalAmount,
    paid_amount: paidAmount,
    status: String(status),
    due_date: d.dueDate || d.due_date || d.dueDateIso || d.due_date_iso || null,
    created_at: d.date || d.created_at || d.createdAt || row.created_at || null,
    currency: d.currency || 'MWK',
    subtotal: num(d.subtotal ?? d.materialTotal ?? d.total ?? d.total_amount ?? totalAmount),
    other_charges: num(d.otherCharges ?? d.other_charges ?? 0),
    notes: d.notes || null,
    document_title: d.documentTitle || d.document_title || null,
    line_items: lineItems,
    items: lineItems,
    // Preserve original envelope fields that portal may rely on
    paymentTerms: d.paymentTerms || d.payment_terms || null,
    payment_terms: d.paymentTerms || d.payment_terms || null,
    // Internal for auth
    _customerId: customerId,
    _raw: d, // for debugging, not exposed normally
  };
}

module.exports = {
  num,
  resolveItemName,
  normalizeSingleItem,
  mapInvoiceLineItems,
  extractRawItems,
  normalizeInvoiceLineItems,
  normalizeInvoiceRow,
};

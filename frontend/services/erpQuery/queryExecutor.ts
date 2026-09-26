/**
 * queryExecutor.ts — Deterministic, read-only ERP query execution.
 *
 * HARD RULES:
 *   - No SQL. Filters/aggregates are validated allowlists; values are data, never code.
 *   - No mutations. Input datasets are treated as readonly; only copies are returned.
 *   - No LLM arithmetic. Counts, sums, averages, balances and grouped totals are
 *     computed here with plain deterministic math.
 *   - Authorization is enforced before any row is read.
 */

import {
  ERP_QUERY_HARD_CAP,
  ERP_QUERY_MAX_LIMIT,
  ErpQueryError,
  type DateScope,
  type ErpAuthContext,
  type ErpDataset,
  type ErpFilter,
  type ErpGroupRow,
  type ErpQuery,
  type ErpQueryResult,
} from './erpQueryTypes';
import { ENTITY_REGISTRY, assertFieldFilterable, assertOperationSupported, getEntityDef } from './entityRegistry';
import { isInScope } from './dateScope';
import {
  computeOutstandingByCustomer,
  customerDisplayOf,
  dateMonthOf,
  flattenLines,
  getInvoiceOutstanding,
  getInvoicePaid,
  getInvoiceTotal,
  getPaymentAmount,
  inventoryCostOf,
  inventoryQtyOf,
  inventoryValueOf,
  isLowStock,
  isStockBearing,
  isUnpaidInvoice,
  matchesCustomer,
  matchesProduct,
  matchesSupplier,
  normalizeRecord,
  normLower,
  productNameOf,
  reorderPointOf,
  round2,
  supplierNameOf,
  toNum,
} from './fieldResolvers';

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return ERP_QUERY_MAX_LIMIT;
  return Math.min(Math.floor(limit), ERP_QUERY_HARD_CAP);
}

function assertNoMutation(query: ErpQuery): void {
  // The query model has no mutation operations and no SQL surface at all:
  // entity/operation/field/operator are allowlisted enums, and filter values
  // are always treated as literal data (never executed). A customer literally
  // named "Select Hardware" must keep working, so values are never scanned.
  // This guard only rejects a smuggled mutation operation identifier.
  const op = String((query as { operation?: unknown }).operation || '').toLowerCase();
  if (['create', 'update', 'delete', 'insert', 'drop', 'alter', 'post', 'void', 'approve'].includes(op)) {
    throw new ErpQueryError('mutation_rejected', 'Mutation operations are rejected. This query capability is read-only.');
  }
}

function checkAuth(entity: keyof ErpDataset, auth: ErpAuthContext | null | undefined): void {
  if (!auth) return; // tests / offline tooling may omit auth; production always passes it
  let allowed = false;
  try {
    allowed = auth.isAdmin ? true : auth.canRead(entity as never);
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new ErpQueryError('authorization_denied', `You do not have permission to view ${ENTITY_REGISTRY[entity as keyof typeof ENTITY_REGISTRY]?.label || entity}.`);
  }
}

/** Resolve the raw rows for an entity, building virtual line-item entities on demand. */
function rawRowsFor(entity: ErpQuery['entity'], dataset: ErpDataset): readonly unknown[] {
  if (entity === 'order_items') {
    const parents = (dataset.orders || []) as readonly unknown[];
    return flattenLines(parents, { parentIdField: 'orderId', dateLabel: 'orderDate' }).map((l) => ({
      id: l.id,
      orderId: l.parentId,
      productId: l.productId,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      subtotal: l.subtotal,
      orderDate: l.parentDate,
      customerId: l.customerId,
      customerName: l.customerName,
      orderStatus: l.parentStatus,
      dateMonth: l.parentDate ? dateMonthOf(l.parentDate) : 'Unknown',
    }));
  }
  if (entity === 'invoice_items') {
    const parents = (dataset.invoices || []) as readonly unknown[];
    return flattenLines(parents, { parentIdField: 'invoiceId', dateLabel: 'invoiceDate' }).map((l) => ({
      id: l.id,
      invoiceId: l.parentId,
      productId: l.productId,
      productName: l.productName,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      subtotal: l.subtotal,
      invoiceDate: l.parentDate,
      customerId: l.customerId,
      customerName: l.customerName,
      dateMonth: l.parentDate ? dateMonthOf(l.parentDate) : 'Unknown',
    }));
  }
  const rows = dataset[entity];
  if (!rows) {
    throw new ErpQueryError('data_unavailable', `No ${ENTITY_REGISTRY[entity]?.label || entity} data is currently available.`);
  }
  return rows;
}

function applyRelationship(
  entity: ErpQuery['entity'],
  rows: Array<Record<string, unknown>>,
  query: ErpQuery,
  dataset: ErpDataset,
): Array<Record<string, unknown>> {
  const rel = query.relationship;
  if (!rel) return rows;
  const def = getEntityDef(entity);
  let relDef = def.relationships.find((r) => r.key === rel.via);
  if (!relDef) {
    const parentDef = ENTITY_REGISTRY[rel.parentEntity];
    const parentRel = parentDef?.relationships.find((r) => r.key === rel.via);
    if (parentRel) relDef = { ...parentRel, targetEntity: entity };
  }
  if (!relDef) {
    throw new ErpQueryError('unsupported_relationship', `Relationship "${rel.via}" is not supported on ${def.label}. Supported: ${def.relationships.map((r) => r.key).join(', ') || 'none'}.`);
  }
  // Parent resolution is by stable ID first; name fallback never merges distinct IDs.
  switch (rel.via) {
    case 'customer_orders':
    case 'customer_quotations':
    case 'customer_invoices':
    case 'customer_payments': {
      return rows.filter((r) => matchesCustomer(r._raw as Record<string, unknown> ?? r, { id: rel.parentId, name: rel.parentName }));
    }
    case 'invoice_payments':
    case 'payment_invoices': {
      // Authoritative allocation linkage.
      const payments = ((dataset.customer_payments || []) as Array<Record<string, unknown>>);
      const invoices = ((dataset.invoices || []) as Array<Record<string, unknown>>);
      if (entity === 'customer_payments' && (rel.parentId || rel.parentName)) {
        const targetId = (rel.parentId || '').trim().toLowerCase();
        return rows.filter((row) => {
          const raw = (row._raw || row) as Record<string, unknown>;
          const allocs = Array.isArray(raw.allocations) ? raw.allocations : [];
          if (targetId) {
            return allocs.some((a) => String((a as Record<string, unknown>).invoiceId ?? (a as Record<string, unknown>).invoice_id ?? '').trim().toLowerCase() === targetId);
          }
          if (rel.parentName) {
            const inv = invoices.find((i) => String(i.id ?? '').trim().toLowerCase() === targetId || normLower(i.invoiceNumber ?? i.id) === normLower(rel.parentName));
            void inv;
          }
          return false;
        });
      }
      if (entity === 'invoices' && (rel.parentId || rel.parentName)) {
        const payId = (rel.parentId || '').trim().toLowerCase();
        const pay = payments.find((p) => String(p.id ?? '').trim().toLowerCase() === payId);
        if (!pay) return [];
        const allocs = Array.isArray((pay as Record<string, unknown>).allocations) ? ((pay as Record<string, unknown>).allocations as Array<Record<string, unknown>>) : [];
        const ids = new Set(allocs.map((a) => String(a.invoiceId ?? a.invoice_id ?? '').trim().toLowerCase()).filter(Boolean));
        return rows.filter((row) => ids.has(String(row.id ?? '').trim().toLowerCase()));
      }
      return rows;
    }
    case 'order_invoice': {
      // Best-effort: match by explicit linkage fields when present, else customer+total proximity is NOT used (no guessing).
      if (rel.parentId) {
        const pid = rel.parentId.trim().toLowerCase();
        return rows.filter((r) => {
          const raw = (r._raw || r) as Record<string, unknown>;
          const linked = [raw.orderId, raw.order_id, raw.sourceOrderId, raw.quotationId].map((v) => String(v ?? '').trim().toLowerCase());
          return linked.includes(pid);
        });
      }
      return rows;
    }
    case 'order_items':
    case 'invoice_items':
    case 'item_order':
    case 'line_invoice': {
      const pid = (rel.parentId || '').trim().toLowerCase();
      if (!pid) return rows;
      const key = entity === 'order_items' ? 'orderId' : entity === 'invoice_items' ? 'invoiceId' : 'id';
      void key;
      return rows.filter((r) => String((r as Record<string, unknown>).orderId ?? (r as Record<string, unknown>).invoiceId ?? (r as Record<string, unknown>).parentId ?? '').trim().toLowerCase() === pid);
    }
    default: {
      // Generic fallback: filter by parent id/name on conventional fields.
      return rows.filter((r) => {
        const raw = (r._raw || r) as Record<string, unknown>;
        if (rel.parentId) {
          const pid = rel.parentId.trim().toLowerCase();
          const candidates = [raw.customerId, raw.customer_id, raw.supplierId, raw.supplier_id, raw.schoolId, raw.school_id, raw.id, raw.orderId, raw.invoiceId]
            .map((v) => String(v ?? '').trim().toLowerCase());
          if (candidates.includes(pid)) return true;
        }
        if (rel.parentName) {
          if (matchesCustomer(raw, { name: rel.parentName })) return true;
          if (matchesProduct(raw, { name: rel.parentName })) return true;
          if (matchesSupplier(raw, { name: rel.parentName })) return true;
        }
        return false;
      });
    }
  }
}

function compareValues(actual: unknown, operator: ErpFilter['operator'], expected: ErpFilter['value']): boolean {
  switch (operator) {
    case 'eq': {
      if (typeof actual === 'number' && typeof expected === 'number') return actual === expected;
      return normLower(actual) === normLower(expected);
    }
    case 'neq':
      return normLower(actual) !== normLower(expected);
    case 'gt':
      return toNum(actual, NaN) > Number(expected);
    case 'gte':
      return toNum(actual, NaN) >= Number(expected);
    case 'lt':
      return toNum(actual, NaN) < Number(expected);
    case 'lte':
      return toNum(actual, NaN) <= Number(expected);
    case 'contains':
      return normLower(actual).includes(normLower(expected as string));
    case 'in': {
      const list = (Array.isArray(expected) ? expected : [expected]).map((v) => normLower(v));
      if (typeof actual === 'number') return list.includes(String(actual));
      return list.includes(normLower(actual));
    }
    case 'between': {
      const arr = Array.isArray(expected) ? expected : [];
      if (arr.length !== 2) return false;
      const v = toNum(actual, NaN);
      if (Number.isNaN(v)) {
        // Date between
        const t = new Date(String(actual)).getTime();
        if (Number.isNaN(t)) return false;
        return t >= new Date(String(arr[0])).getTime() && t <= new Date(String(arr[1])).getTime();
      }
      return v >= Number(arr[0]) && v <= Number(arr[1]);
    }
    default:
      return false;
  }
}

function applyFilters(
  entity: ErpQuery['entity'],
  rows: Array<Record<string, unknown>>,
  filters: ErpFilter[],
): Array<Record<string, unknown>> {
  let out = rows;
  for (const f of filters) {
    assertFieldFilterable(entity, f.field);
    // Semantic shortcuts resolved against canonical readers (status synonyms, identity, stock flags).
    if (f.field === 'status' && typeof f.value === 'string') {
      const want = normLower(f.value);
      out = out.filter((r) => {
        const status = normLower(r.status);
        if (f.operator === 'eq') {
          if (want === 'unpaid') {
            if (entity === 'invoices') return isUnpaidInvoice((r._raw || r) as Record<string, unknown>);
            return status === 'unpaid' || status === 'partial' || status === 'overdue';
          }
          if (want === 'low_stock' && entity === 'products') return isLowStock((r._raw || r) as Record<string, unknown>);
          return status === want;
        }
        return compareValues(r.status, f.operator, f.value);
      });
      continue;
    }
    if ((f.field === 'customerName' || f.field === 'customerId') && entity !== 'customers' && entity !== 'suppliers') {
      out = out.filter((r) => {
        const raw = (r._raw || r) as Record<string, unknown>;
        if (f.field === 'customerId') {
          const id = String(raw.customerId ?? raw.customer_id ?? '').trim();
          return compareValues(id, f.operator, f.value);
        }
        if (f.operator === 'contains' || f.operator === 'eq') {
          return matchesCustomer(raw, { name: String(f.value ?? '') });
        }
        return compareValues(r.customerName, f.operator, f.value);
      });
      continue;
    }
    if ((f.field === 'productName' || f.field === 'productId' || f.field === 'itemName' || f.field === 'itemId') && typeof f.value === 'string') {
      out = out.filter((r) => {
        const raw = (r._raw || r) as Record<string, unknown>;
        const probe = f.field.toLowerCase().includes('id') ? { id: String(f.value) } : { name: String(f.value) };
        if (matchesProduct(raw, probe)) return true;
        if (matchesProduct(r, probe)) return true;
        return compareValues(r[f.field] ?? productNameOf(raw), f.operator, f.value);
      });
      continue;
    }
    if ((f.field === 'supplierName' || f.field === 'supplierId') && typeof f.value === 'string') {
      out = out.filter((r) => {
        const raw = (r._raw || r) as Record<string, unknown>;
        const probe = f.field.toLowerCase().includes('id') ? { id: String(f.value) } : { name: String(f.value) };
        if (matchesSupplier(raw, probe)) return true;
        return compareValues(r[f.field], f.operator, f.value);
      });
      continue;
    }
    out = out.filter((r) => compareValues(r[f.field], f.operator, f.value));
  }
  return out;
}

function applyDateScope(
  entity: ErpQuery['entity'],
  rows: Array<Record<string, unknown>>,
  dateScope: DateScope | null,
): Array<Record<string, unknown>> {
  if (!dateScope) return rows;
  const def = getEntityDef(entity);
  const field = dateScope.dateField && def.dateFields.includes(dateScope.dateField) ? dateScope.dateField : def.dateField;
  if (entity === 'order_items') return rows.filter((r) => isInScope(r.orderDate, { ...dateScope, dateField: field }));
  if (entity === 'invoice_items') return rows.filter((r) => isInScope(r.invoiceDate, { ...dateScope, dateField: field }));
  return rows.filter((r) => isInScope(r[field] ?? (r._raw as Record<string, unknown> | undefined)?.[field], { ...dateScope, dateField: field }));
}

function aggregateValues(values: number[], operation: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'distinct_count', distinctSource?: unknown[]): number | null {
  const finite = values.filter((v) => Number.isFinite(v));
  switch (operation) {
    case 'sum':
      return round2(finite.reduce((s, v) => s + v, 0));
    case 'avg':
      return finite.length === 0 ? null : round2(finite.reduce((s, v) => s + v, 0) / finite.length);
    case 'min':
      return finite.length === 0 ? null : Math.min(...finite);
    case 'max':
      return finite.length === 0 ? null : Math.max(...finite);
    case 'count':
      return values.length;
    case 'distinct_count': {
      const src = distinctSource ?? values;
      return new Set(src.map((v) => normLower(v))).size;
    }
    default:
      return null;
  }
}

function fieldNumericValue(row: Record<string, unknown>, field: string): number {
  const v = row[field];
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function sortRows(rows: Array<Record<string, unknown>>, sort: ErpQuery['sort']): Array<Record<string, unknown>> {
  if (sort.length === 0) return rows;
  const copy = [...rows];
  copy.sort((a, b) => {
    for (const s of sort) {
      const av = a[s.field];
      const bv = b[s.field];
      const an = Number(av);
      const bn = Number(bv);
      let cmp: number;
      if (Number.isFinite(an) && Number.isFinite(bn)) cmp = an - bn;
      else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
      if (cmp !== 0) return s.direction === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
  return copy;
}

function groupKeyOf(row: Record<string, unknown>, groupBy: string[]): Record<string, string> {
  const key: Record<string, string> = {};
  for (const g of groupBy) key[g] = String(row[g] ?? 'Unknown');
  return key;
}

/**
 * Execute a validated ErpQuery deterministically. Pure + read-only.
 */
export function executeErpQuery(query: ErpQuery, dataset: ErpDataset, auth?: ErpAuthContext | null): ErpQueryResult {
  assertNoMutation(query);
  const def = getEntityDef(query.entity);
  assertOperationSupported(query.entity, query.operation);
  checkAuth(query.entity, auth ?? null);
  if (query.relationship) {
    // Traversal touches a second entity — both sides must be readable.
    checkAuth(query.relationship.parentEntity, auth ?? null);
    let relDef = def.relationships.find((r) => r.key === query.relationship!.via);
    if (!relDef) {
      // Accept symmetric keys declared on the parent side (e.g. querying
      // invoices with via 'customer_invoices' declared on customers).
      const parentDef = ENTITY_REGISTRY[query.relationship.parentEntity];
      const parentRel = parentDef?.relationships.find((r) => r.key === query.relationship!.via);
      if (parentRel) {
        relDef = { ...parentRel, targetEntity: query.entity };
      } else {
        throw new ErpQueryError('unsupported_relationship', `Relationship "${query.relationship.via}" is not supported on ${def.label}.`);
      }
    }
    checkAuth(relDef.targetEntity, auth ?? null);
  }
  for (const g of query.groupBy) {
    if (!def.groupableFields.includes(g)) {
      throw new ErpQueryError('unsupported_field', `Cannot group ${def.label} by "${g}". Groupable: ${def.groupableFields.join(', ') || 'none'}.`);
    }
  }
  for (const a of query.aggregates) {
    if (!def.aggregatableFields.includes(a.field) && !(query.operation === 'distinct_count' && def.readableFields.includes(a.field))) {
      throw new ErpQueryError('unsupported_field', `Cannot aggregate "${a.field}" on ${def.label}. Aggregatable: ${def.aggregatableFields.join(', ') || 'none'}.`);
    }
  }
  for (const s of query.sort) {
    if (!def.readableFields.includes(s.field)) {
      throw new ErpQueryError('unsupported_field', `Cannot sort ${def.label} by "${s.field}".`);
    }
  }

  const rawRows = rawRowsFor(query.entity, dataset);
  // Normalize once (copies — inputs never mutated).
  let rows = (rawRows as Array<unknown>).map((r) => normalizeRecord(query.entity, r));
  // Strip the _raw carrier before presentation, but keep it for identity matching above.
  rows = applyRelationship(query.entity, rows, query, dataset);
  rows = applyFilters(query.entity, rows, query.filters);

  const scopeLabel = query.dateScope ? `${query.dateScope.label} (${query.dateScope.dateField})` : null;

  const scalarFor = (scoped: Array<Record<string, unknown>>): number | null => {
    if (query.operation === 'count') return scoped.length;
    if (query.operation === 'distinct_count') {
      const field = query.aggregates[0]?.field || query.groupBy[0] || 'id';
      return new Set(scoped.map((r) => normLower(r[field]))).size;
    }
    const agg = query.aggregates[0];
    if (!agg && (query.operation === 'sum' || query.operation === 'average' || query.operation === 'minimum' || query.operation === 'maximum')) {
      throw new ErpQueryError('unsupported_field', `Operation "${query.operation}" needs an aggregatable field on ${def.label}.`);
    }
    if (query.operation === 'sum' && agg) return aggregateValues(scoped.map((r) => fieldNumericValue(r, agg.field)), 'sum');
    if (query.operation === 'average' && agg) return aggregateValues(scoped.map((r) => fieldNumericValue(r, agg.field)), 'avg');
    if (query.operation === 'minimum' && agg) return aggregateValues(scoped.map((r) => fieldNumericValue(r, agg.field)), 'min');
    if (query.operation === 'maximum' && agg) return aggregateValues(scoped.map((r) => fieldNumericValue(r, agg.field)), 'max');
    return null;
  };

  if (query.operation === 'compare') {
    if (!query.comparison) throw new ErpQueryError('invalid_date_range', 'Comparison needs two bounded periods (e.g. "compare sales this month with last month").');
    const currentRows = applyDateScope(query.entity, rows, query.comparison.current);
    const previousRows = applyDateScope(query.entity, rows, query.comparison.previous);
    const current = query.aggregates[0]
      ? aggregateValues(currentRows.map((r) => fieldNumericValue(r, query.aggregates[0].field)), query.aggregates[0].operation === 'avg' ? 'avg' : 'sum')
      : currentRows.length;
    const previous = query.aggregates[0]
      ? aggregateValues(previousRows.map((r) => fieldNumericValue(r, query.aggregates[0].field)), query.aggregates[0].operation === 'avg' ? 'avg' : 'sum')
      : previousRows.length;
    const c = current ?? 0;
    const p = previous ?? 0;
    return {
      entity: query.entity,
      operation: query.operation,
      totalCount: currentRows.length,
      rows: stripRaw(sortRows(currentRows, query.sort).slice(0, clampLimit(query.limit))),
      scalar: null,
      groups: [],
      comparisonResult: {
        current: current,
        previous: previous,
        delta: round2(c - p),
        deltaPercent: p !== 0 ? round2(((c - p) / Math.abs(p)) * 100) : null,
      },
      truncated: currentRows.length > clampLimit(query.limit),
      scopeLabel: `${query.comparison.current.label} vs ${query.comparison.previous.label}`,
      factsUsed: [query.entity],
      warnings: [],
    };
  }

  const scoped = applyDateScope(query.entity, rows, query.dateScope);
  const totalCount = scoped.length;

  if (query.operation === 'group_by') {
    const map = new Map<string, Array<Record<string, unknown>>>();
    for (const r of scoped) {
      const k = JSON.stringify(groupKeyOf(r, query.groupBy));
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    const groups: ErpGroupRow[] = [...map.entries()].map(([k, members]) => {
      const key = JSON.parse(k) as Record<string, string>;
      const aggregates: Record<string, number | null> = {};
      for (const a of query.aggregates) {
        const vals = members.map((m) => fieldNumericValue(m, a.field));
        aggregates[a.as || `${a.operation}_${a.field}`] = aggregateValues(vals, a.operation, members.map((m) => m[a.field]));
      }
      return { key, count: members.length, aggregates };
    });
    // Sort groups by first aggregate desc (deterministic ranking for "sold the most" etc.)
    const firstAgg = query.aggregates[0];
    if (firstAgg) {
      const k = firstAgg.as || `${firstAgg.operation}_${firstAgg.field}`;
      groups.sort((a, b) => (Number(b.aggregates[k]) || 0) - (Number(a.aggregates[k]) || 0));
    } else {
      groups.sort((a, b) => b.count - a.count);
    }
    const limit = clampLimit(query.limit);
    return {
      entity: query.entity,
      operation: query.operation,
      totalCount: groups.length,
      rows: groups.slice(0, limit).map((g) => ({ ...g.key, count: g.count, ...g.aggregates })),
      scalar: null,
      groups: groups.slice(0, limit),
      comparisonResult: null,
      truncated: groups.length > limit,
      scopeLabel,
      factsUsed: [query.entity],
      warnings: [],
    };
  }

  const scalar = query.operation === 'list' || query.operation === 'retrieve' ? null : scalarFor(scoped);
  const sorted = sortRows(scoped, query.sort);
  const limit = clampLimit(query.limit);
  const materialised = (query.operation === 'count' ? [] : sorted.slice(0, limit)).map(stripForPresentation);

  return {
    entity: query.entity,
    operation: query.operation,
    totalCount,
    rows: materialised,
    scalar,
    groups: [],
    comparisonResult: null,
    truncated: scoped.length > limit && query.operation !== 'count',
    scopeLabel,
    factsUsed: [query.entity],
    warnings: [],
  };
}

function stripRaw(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map(stripForPresentation);
}

function stripForPresentation(row: Record<string, unknown>): Record<string, unknown> {
  const { _raw, ...rest } = row as Record<string, unknown> & { _raw?: unknown };
  void _raw;
  return rest;
}

// ── Re-exported authoritative helpers for presenter/tests ────────────────────

export { getInvoiceTotal, getInvoicePaid, getInvoiceOutstanding, isUnpaidInvoice, getPaymentAmount };
export { inventoryQtyOf, inventoryCostOf, inventoryValueOf, isStockBearing, isLowStock, reorderPointOf, productNameOf, supplierNameOf, customerDisplayOf, dateMonthOf, computeOutstandingByCustomer, toNum, round2 };
export type { DateScope };

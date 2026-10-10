/**
 * Customer rename propagation (cloud side).
 *
 * `customers` is the single source of truth for a customer's display name,
 * but every transaction row denormalizes that name into its own `data` JSONB
 * (`customerName` / `customer_name`) so lists, receipts and statements render
 * without a second lookup.
 *
 * When a client is renamed, the denormalized copies on the historical
 * transaction rows must be rewritten as well — otherwise the same customer
 * shows up twice in the books: once under the old name (all previous
 * transactions) and once under the new one.
 *
 * The browser already does this locally when the rename happens on a device
 * that runs the frontend cascade (services/customerRenamePropagation.ts).
 * This module is the server-side enforcement of the same rule, so the
 * invariant also holds for:
 *   - clients that push only the `customers` row (older builds, tooling),
 *   - direct cloud writes,
 *   - rows that no device held locally when the rename was made.
 *
 * Patch semantics: a conditional PATCH on `id + version` that rewrites `data`
 * and `updated_at` WITHOUT bumping `version`. The compare-and-swap keeps the
 * write safe against concurrent edits, while leaving `version` untouched means
 * no client's optimistic-concurrency base is invalidated by the cascade.
 */

const CLOUD_CASCADE_TABLES = [
  { table: 'sales', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
  { table: 'invoices', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
  { table: 'quotations', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'orders', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'customer_payments', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
  { table: 'sales_orders', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'job_orders', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'job_tickets', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'delivery_notes', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'shipments', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'recurring_invoices', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'sales_exchanges', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'work_orders', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'production_batches', idFields: ['customerId'], nameFields: ['customerName'] },
  { table: 'assessment_contracts', idFields: ['customerId', 'customer_id'], nameFields: ['customerName', 'customer_name'] },
];

const normalizeName = (value) => String(value ?? '').trim();
const isSameName = (a, b) => normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();

/**
 * Authoritative customer/business display name for a cloud `data` envelope.
 * Mirrors the frontend resolver (businessName → companyName → legacy name).
 */
function resolveCloudDisplayName(data) {
  const row = data && typeof data === 'object' ? data : {};
  for (const field of ['businessName', 'business_name', 'companyName', 'company_name', 'name']) {
    const value = normalizeName(row[field]);
    if (value) return value;
  }
  return '';
}

const isTombstone = (row) => {
  const data = row && row.data && typeof row.data === 'object' ? row.data : {};
  return data.deleted === true || Boolean(data.deletedAt);
};

/**
 * PostgREST operand escaping for an `ilike` comparison. `"` delimits the
 * operand, and `%` / `_` are LIKE wildcards that must be escaped so a name
 * containing them cannot match a wider set of rows.
 */
function escapeIlikeOperand(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/"/g, '\\"');
}

/**
 * Pure planner: which cloud rows change, and to what.
 * Row shape: { id, data, version }.
 */
function planCloudCustomerRename({ customerId, previousName, nextName, rowsByTable, otherCustomerNames }) {
  const id = normalizeName(customerId);
  const previous = normalizeName(previousName);
  const next = normalizeName(nextName);

  if (!id || !previous || !next || isSameName(previous, next)) {
    return { patches: [], ambiguousPreviousName: false };
  }

  const ambiguousPreviousName = (otherCustomerNames || []).some((name) => isSameName(name, previous));
  const patches = [];

  for (const config of CLOUD_CASCADE_TABLES) {
    const rows = Array.isArray(rowsByTable?.[config.table]) ? rowsByTable[config.table] : [];
    const canonicalField = config.nameFields[0];

    for (const row of rows) {
      if (!row || row.id == null || isTombstone(row)) continue;
      const data = row.data && typeof row.data === 'object' ? row.data : {};

      const linked = config.idFields.some((field) => {
        const value = data[field];
        return value != null && String(value).trim() !== '' && String(value) === id;
      });

      // A row that carries a link to a DIFFERENT customer is somebody else's
      // transaction, however similar its label looks.
      const linkedElsewhere = config.idFields.some((field) => {
        const value = data[field];
        return value != null && String(value).trim() !== '' && String(value) !== id;
      });
      if (linkedElsewhere) continue;

      const carriesPreviousName = config.nameFields.some((field) => {
        const value = data[field];
        return typeof value === 'string' && isSameName(value, previous);
      });

      // Linked rows: the customerId is authoritative — rewrite the stale label.
      // Unlinked legacy rows: only when they still carry the previous name and
      // no other customer answers to it (otherwise this rename would silently
      // re-parent another customer's history).
      if (!linked && !(carriesPreviousName && !ambiguousPreviousName)) continue;

      const hasAnyName = config.nameFields.some((field) => {
        const value = data[field];
        return typeof value === 'string' && normalizeName(value).length > 0;
      });

      const patch = {};
      for (const field of config.nameFields) {
        const current = data[field];
        if (typeof current === 'string') {
          if (isSameName(current, previous)) patch[field] = next;
          continue;
        }
        // Linked row that never denormalized the name at all: fill it in so
        // this customer's documents no longer need a lookup. Rows that already
        // carry a name in another field are left alone — they are either
        // already correct or deliberately custom.
        if (linked && field === canonicalField && !hasAnyName) patch[field] = next;
      }

      if (Object.keys(patch).length > 0) {
        patches.push({
          table: config.table,
          id: String(row.id),
          patch,
          version: row.version != null ? Number(row.version) : null,
        });
      }
    }
  }

  return { patches, ambiguousPreviousName };
}

const ROW_SELECT = 'id,data,version';
const CASCADE_PAGE_LIMIT = 1000;
const CASCADE_MAX_PAGES = 10;

/**
 * Production deps over PostgREST. `patchRow` is a compare-and-swap on
 * `id + version` that rewrites `data` and `updated_at` but deliberately keeps
 * `version` unchanged so no client's OCC base is invalidated.
 */
function createCloudDeps({ cloudHttp, supabaseUrl, adminHeaders, serverNow }) {
  const headers = () => adminHeaders();

  // Pages a filtered result set so a customer with more rows than one page
  // (a distributor with thousands of POS sales, say) is still fully cascaded.
  const getPaged = async (table, params) => {
    const rows = [];
    for (let page = 0; page < CASCADE_MAX_PAGES; page += 1) {
      const res = await cloudHttp.get(`${supabaseUrl}/rest/v1/${table}`, {
        headers: headers(),
        params: {
          select: ROW_SELECT,
          order: 'id.asc.nullslast',
          limit: CASCADE_PAGE_LIMIT,
          offset: page * CASCADE_PAGE_LIMIT,
          ...params,
        },
        timeout: 20000,
      });
      const pageRows = Array.isArray(res.data) ? res.data : [];
      rows.push(...pageRows);
      if (pageRows.length < CASCADE_PAGE_LIMIT) break;
    }
    return rows;
  };

  return {
    /** Rows linked to the customer by an id field. */
    async fetchRows(table, config, customerId) {
      const byId = new Map();
      for (const field of config.idFields) {
        const rows = await getPaged(table, { [`data->>${field}`]: `eq.${normalizeName(customerId)}` });
        for (const row of rows) byId.set(String(row.id), row);
      }
      return Array.from(byId.values());
    },

    /** Legacy rows with no customer link whose denormalized name matches. */
    async fetchLegacyRows(table, config, previousName) {
      const operand = escapeIlikeOperand(previousName);
      const nullFilters = {};
      for (const field of config.idFields) nullFilters[`data->>${field}`] = 'is.null';
      const byId = new Map();
      for (const field of config.nameFields) {
        const rows = await getPaged(table, {
          ...nullFilters,
          [`data->>${field}`]: `ilike."${operand}"`,
        });
        for (const row of rows) byId.set(String(row.id), row);
      }
      return Array.from(byId.values());
    },

    /** Conditional patch — returns false when the row moved underneath us. */
    async patchRow(entry, row) {
      const data = row && row.data && typeof row.data === 'object' ? { ...row.data } : {};
      const body = { data: { ...data, ...entry.patch }, updated_at: serverNow };
      const params = { id: `eq.${entry.id}` };
      if (entry.version != null) params.version = `eq.${entry.version}`;
      try {
        const res = await cloudHttp.patch(`${supabaseUrl}/rest/v1/${entry.table}`, body, {
          headers: headers(),
          params,
          timeout: 20000,
        });
        const updated = Array.isArray(res.data) ? res.data : [];
        return updated.length > 0;
      } catch (err) {
        // A concurrent writer moved the row (or the cloud is briefly unhappy):
        // the row keeps the previous name and the next pull/repush converges.
        return false;
      }
    },
  };
}

/**
 * Propagate a customer rename to every cloud transaction row that still
 * denormalizes the previous name. `deps` is injectable for tests; production
 * uses `createCloudDeps`.
 */
async function cascadeCustomerRename({
  customerId,
  previousName,
  nextName,
  otherCustomerNames = [],
  deps,
  rowLookup,
}) {
  const id = normalizeName(customerId);
  const previous = normalizeName(previousName);
  const next = normalizeName(nextName);

  if (!id || !previous || !next || isSameName(previous, next)) {
    return { updated: 0, tables: [], ambiguousPreviousName: false };
  }

  const rowsByTable = {};
  const ambiguousPreviousName = (otherCustomerNames || []).some((name) => isSameName(name, previous));

  for (const config of CLOUD_CASCADE_TABLES) {
    const linked = await deps.fetchRows(config.table, config, id);
    const merged = new Map(linked.map((row) => [String(row.id), row]));

    // Unlinked legacy rows are only safe to fold into this customer when no
    // OTHER customer answers to the previous name.
    if (!ambiguousPreviousName) {
      const legacy = await deps.fetchLegacyRows(config.table, config, previous);
      for (const row of legacy) {
        const key = String(row.id);
        if (!merged.has(key)) merged.set(key, row);
      }
    }

    rowsByTable[config.table] = Array.from(merged.values());
  }

  const plan = planCloudCustomerRename({
    customerId: id,
    previousName: previous,
    nextName: next,
    rowsByTable,
    otherCustomerNames,
  });

  let updated = 0;
  const tables = new Set();
  for (const entry of plan.patches) {
    const row = typeof rowLookup === 'function'
      ? rowLookup(entry.table, entry.id)
      : (rowsByTable[entry.table] || []).find((candidate) => String(candidate.id) === entry.id);
    const ok = await deps.patchRow(entry, row);
    if (ok) {
      updated += 1;
      tables.add(entry.table);
    }
  }

  return { updated, tables: Array.from(tables), ambiguousPreviousName: plan.ambiguousPreviousName };
}

module.exports = {
  CLOUD_CASCADE_TABLES,
  resolveCloudDisplayName,
  planCloudCustomerRename,
  cascadeCustomerRename,
  createCloudDeps,
  escapeIlikeOperand,
};

/**
 * cloudSyncStore.cjs — server-side Supabase write client for the ERP sync
 * gateway (`POST /api/sync/ops`).
 *
 * The ERP is offline-first: the sync queue runs on the browser and the
 * backend is the single gateway that validates operations and writes them
 * to the cloud database. This module does those cloud writes with the
 * service-role key (bypassing RLS) so business data lands in Postgres
 * regardless of the calling user's row-level visibility.
 *
 * It deliberately mirrors the write shape used by the legacy direct client
 * (`frontend/services/cloudDb.ts`): rows are stored as `{ id, data, updated_at }`
 * with an optional numeric `version`, and deletes are soft-deletes via a
 * tombstone (`data.deleted = true` + `data.deletedAt`).
 */
const axios = require('axios');
const accountScope = require('./customerAccountScope.cjs');

const EXAMINATION_BATCH_TABLE = 'examination_batches';
const INVOICE_TABLE = 'invoices';

// axios does NOT reject on 4xx/5xx by default; it only throws on network-level
// failures. Without this, a rejected cloud write (bad column, RLS, 401 from an
// expired key, 409/500) would surface as `res.data` being an error object that
// we silently treat as a successful row — corrupting the client's sync state.
// Force rejection on any non-2xx so every failure path funnels through the
// try/catch in applyOp() and is reported as a per-op, retryable failure.
const cloudHttp = typeof axios.create === 'function'
  ? axios.create({ validateStatus: (status) => status >= 200 && status < 300 })
  : axios;

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';

const isConfigured = () => Boolean(
  SUPABASE_URL
  && SECRET_KEY
  && !SUPABASE_URL.includes('placeholder')
  && !SECRET_KEY.includes('placeholder')
);

// Log configuration status at module load time for Render diagnostics
(function checkCloudConfig() {
  const urlOk = Boolean(SUPABASE_URL && !SUPABASE_URL.includes('placeholder'));
  const keyOk = Boolean(SECRET_KEY && !SECRET_KEY.includes('placeholder'));
  if (!urlOk || !keyOk) {
    console.error('[cloudSyncStore] STARTUP: Cloud sync NOT configured.', {
      SUPABASE_URL_set: urlOk,
      SUPABASE_SECRET_KEY_set: keyOk,
      supabase_env_vars: Object.keys(process.env).filter(k => k.toLowerCase().includes('supabase')),
    });
  } else {
    console.log('[cloudSyncStore] STARTUP: Cloud sync configured OK. URL=' + SUPABASE_URL);
  }
})();

function adminHeaders() {
  return {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

// ─── uuid5 (deterministic id for idempotency keys) ─────────────────────────
const NAMESPACE = Buffer.from('d6a7e280-8c0e-4a7e-9b1a-1e5f2c3d4a5b', 'utf8');

function stringToUuid5(input) {
  const { createHash } = require('crypto');
  const hash = createHash('sha1').update(NAMESPACE).update(String(input || ''), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── idempotency ────────────────────────────────────────────────────────────
let idempotencyTableReady = null;

async function ensureIdempotencyTable() {
  if (idempotencyTableReady !== null) return idempotencyTableReady;
  try {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/idempotency_keys`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: { select: 'id', limit: 0 },
      timeout: 8000,
    });
    idempotencyTableReady = Array.isArray(res.data);
  } catch {
    idempotencyTableReady = false;
  }
  return idempotencyTableReady;
}

async function checkIdempotency(operationId) {
  if (!operationId || !(await ensureIdempotencyTable())) {
    return { alreadyProcessed: false };
  }
  try {
    const uuid = stringToUuid5(operationId);
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/idempotency_keys`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: { select: 'id,result', id: `eq.${uuid}`, limit: 1 },
      timeout: 8000,
    });
    const row = Array.isArray(res.data) ? res.data[0] : null;
    return row
      ? { alreadyProcessed: true, result: row.result || null }
      : { alreadyProcessed: false };
  } catch {
    return { alreadyProcessed: false };
  }
}

async function recordIdempotency(operationId, result) {
  if (!operationId || !(await ensureIdempotencyTable())) return;
  try {
    const uuid = stringToUuid5(operationId);
    await cloudHttp.post(`${SUPABASE_URL}/rest/v1/idempotency_keys`, {
      id: uuid,
      result: result || null,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, {
      headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates' },
      timeout: 8000,
    });
  } catch {
    // best-effort
  }
}

// ─── row helpers ────────────────────────────────────────────────────────────
async function getRow(table, id) {
  const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    params: { select: '*', id: `eq.${id}`, limit: 1 },
    timeout: 15000,
  });
  return Array.isArray(res.data) ? (res.data[0] || null) : null;
}

function sanitizeRecord(payload) {
  const raw = { ...(payload && typeof payload === 'object' ? payload : {}) };
  delete raw._updatedAt;
  delete raw._cloudSource;
  delete raw._operationId;
  delete raw._version;
  delete raw.dependsOn;
  delete raw.deletedAt; // computed server-side for tombstones only
  // Strip top-level sync metadata that lives in its own Supabase column.
  // `version` and `updated_at` are top-level columns; storing them inside
  // the `data` JSONB causes toCloudRecord() to read a stale value (from
  // the JSONB) that overrides the fresh top-level column on the next pull.
  delete raw.version;
  delete raw.updated_at;
  delete raw.created_at;
  return raw;
}

/**
 * Fetch every row of a cloud table (id + data envelope) with pagination.
 * Used by the portal backfill to propagate pre-existing committed rows.
 */
async function listRows(table) {
  const LIMIT = 200;
  const out = [];
  let from = 0;
  for (;;) {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: { select: '*', offset: from, limit: LIMIT },
      timeout: 20000,
    });
    const page = Array.isArray(res.data) ? res.data : [];
    out.push(...page);
    if (page.length < LIMIT) break;
    from += page.length;
    if (from > 5000) break; // safety valve for pathological tables
  }
  return out;
}

/**
 * Fetch ONE page of cloud rows for the pull gateway (`GET /api/sync/pull`).
 * Mirrors the browser pull semantics the sync engine has always used —
 * incremental `updated_at >= since` cursor, deterministic
 * `updated_at ASC, id ASC` ordering, offset/limit pagination — but executes
 * the Supabase read server-side with the service-role key so the browser
 * never talks to PostgREST directly. Throws on transport/cloud failures so
 * the route can return a real 5xx instead of an empty dataset.
 */
async function listPullPage(table, { since = null, offset = 0, limit = 2000, ids = null } = {}) {
  const params = { select: '*', order: 'updated_at.asc,id.asc', offset, limit };
  // Targeted re-fetch: when the caller supplies an explicit id set the pull is
  // a point lookup, not a cursor walk. `since` and the deterministic ordering
  // are deliberately dropped — a deferred row must be returned regardless of
  // where it sits on the incremental cursor, otherwise the very staleness this
  // path exists to repair would be reproduced.
  if (Array.isArray(ids) && ids.length > 0) {
    delete params.order;
    delete params.offset;
    params.limit = ids.length;
    params.id = `in.(${ids.map((id) => `"${String(id).replace(/"/g, '\\"')}"`).join(',')})`;
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params,
      timeout: 20000,
    });
    return Array.isArray(res.data) ? res.data : [];
  }
  if (since) params.updated_at = `gte.${since}`;
  const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    params,
    timeout: 20000,
  });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Find rows whose `data` JSONB carries a given value for `field`.
 * Used by the gateway for business-key uniqueness checks (e.g. printing
 * contract numbers) before the write, so a collision is reported as a
 * clean, non-retryable failure instead of a 409 unique-violation retry
 * loop. Tombstone rows are returned as-is; the caller decides whether
 * they still hold the key.
 */
async function findRowsByDataField(table, field, value) {
  const quoted = String(value).replace(/"/g, '\\"');
  const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
    params: { select: 'id,data', [`data->>${field}`]: `eq."${quoted}"`, limit: 10 },
    timeout: 15000,
  });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Fetch one row by its primary key. Used by the contract-document guard to
 * resolve a `supersededBy` reference before the write.
 */
async function findRowById(table, id) {
  const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
    headers: adminHeaders(),
    params: { select: 'id,data,version', id: `eq.${id}`, limit: 1 },
    timeout: 15000,
  });
  const rows = Array.isArray(res.data) ? res.data : [];
  return rows[0] || null;
}

// ─── Unified P726 official Sales Order numbering ────────────────────────────
// ONE official numbering family: every Sales Order mints ORD-P726/NNN from
// one global numeric sequence per series, regardless of creation source
// (DIRECT_ERP / PORTAL_CONVERSION / INVOICE_DERIVED is provenance only).
// Historical SO shapes are recognized for reading only — never minted.
// Numbers are claimed atomically (counter row lock — see salesOrderNumbering
// + migration 0027). Never SELECT MAX()+1, never an in-memory counter.
//
// History rule: rows that already exist server-side keep their numbers
// untouched. Only genuine creates can receive a fresh official number.
// There is no provisional concept: only ORD unified numbers are adopted;
// SO-/TMP-/ORDER- shapes are minted fresh, never adopted.
const salesOrderNumbering = require('./salesOrderNumbering.cjs');

// ─── customer rename propagation ─────────────────────────────────────────────
// A client rename must not split one customer's history into "old name"
// (previous transactions) and "new name" (future ones). The browser rewrites
// the denormalized name on every linked transaction when the rename happens
// locally (frontend/services/customerRenamePropagation.ts); this is the
// server-side enforcement of the same rule, so the invariant also holds for
// clients that push only the `customers` row and for direct cloud writes.
let customerRenamePropagation = null;
try {
  customerRenamePropagation = require('./customerRenamePropagation.cjs');
} catch (err) {
  // Degrade safely: the rename still persists, the cascade simply does not
  // run server-side (the client-side cascade and the next pull converge).
  console.error('[cloudSyncStore] customerRenamePropagation unavailable — rename cascade disabled:', err?.message || err);
}

/**
 * Rewrite the denormalized customer name on every cloud transaction row that
 * still carries the previous name.
 *
 * `overrides` exposes the cloud readers/writers for hermetic tests; production
 * never passes them.
 *
 * Never throws: a cascade failure must not turn a successful client rename
 * into a reported sync failure.
 */
async function propagateCustomerRenameToCloud(customerId, payload, previousRow, overrides = {}) {
  if (!customerRenamePropagation || !isConfigured()) return { updated: 0, tables: [] };

  const previousName = customerRenamePropagation.resolveCloudDisplayName(previousRow?.data);
  const nextName = customerRenamePropagation.resolveCloudDisplayName(payload);
  const id = String(customerId || '');
  if (!id || !previousName || !nextName) return { updated: 0, tables: [] };
  if (previousName.trim().toLowerCase() === nextName.trim().toLowerCase()) {
    return { updated: 0, tables: [] };
  }

  // Ambiguity guard: an unlinked legacy row named like the OLD name may belong
  // to another customer that still answers to that name.
  let otherCustomerNames = [];
  try {
    const listCustomers = typeof overrides.listCustomers === 'function'
      ? overrides.listCustomers
      : () => listRows('customers');
    const rows = await listCustomers();
    otherCustomerNames = rows
      .filter((row) => String(row?.id) !== id)
      .map((row) => customerRenamePropagation.resolveCloudDisplayName(row?.data))
      .filter((name) => name.length > 0);
  } catch { otherCustomerNames = []; /* guard degrades to "no collision" */ }

  const deps = overrides.deps || customerRenamePropagation.createCloudDeps({
    cloudHttp,
    supabaseUrl: SUPABASE_URL,
    adminHeaders,
    serverNow: new Date().toISOString(),
  });

  const result = await customerRenamePropagation.cascadeCustomerRename({
    customerId: id,
    previousName,
    nextName,
    otherCustomerNames,
    deps,
  });

  if (result.updated > 0) {
    console.log(`[cloudSyncStore] renamed ${result.updated} transaction row(s) for customer ${id}: "${previousName}" -> "${nextName}"`);
  }
  return result;
}

/**
 * Resolve the official sales order number for an incoming upsert. Returns the
 * number to stamp onto payload.order_number (canonical field), or null when
 * nothing should be stamped.
 *
 * Never throws — the gateway must not block a business write on numbering
 * (callers treat throw as mint-skipped and save unnumbered for a later retry).
 */
async function ensureSalesOrderNumber(payload) {
  const data = payload && typeof payload === 'object' ? payload : {};
  const id = data.id;
  let existing = null;
  try {
    existing = id ? await getRow('sales_orders', id) : null;
  } catch { existing = null; /* row missing or cloud unreachable — treat as create */ }
  const serverData =
    existing && existing.data && typeof existing.data === 'object' ? existing.data : null;

  // Existing row: preserve history. Stamp back ONLY the server's own
  // canonical number so a stale push cannot clobber it; never invent one.
  // (A missing official number on an old row stays missing — history is
  // immutable, and a later edit must not rewrite what the business saw.)
  if (serverData) {
    const serverOfficial = String(serverData.order_number || '').trim();
    if (serverOfficial) return serverOfficial;
    const serverCamel = String(serverData.orderNumber || '').trim();
    if (
      serverCamel &&
      (salesOrderNumbering.isOfficialSalesOrderNumber(serverCamel) ||
        salesOrderNumbering.isLegacyOfficialNumber(serverCamel))
    ) {
      return serverCamel;
    }
    return null;
  }

  // Genuine create: adopt a client-supplied official number only when it is
  // a well-formed ORD unified number and currently unused (legitimate
  // replays take this path with zero counter waste). There is no
  // provisional concept: SO-/TMP-shaped candidates are never adopted — a
  // fresh ORD is minted instead.
  const candidate = String(data.order_number || '').trim();
  if (
    candidate &&
    salesOrderNumbering.isOfficialSalesOrderNumber(candidate) &&
    salesOrderNumbering.prefixMatchesOrigin(candidate, data) &&
    !(await salesOrderNumbering.isOfficialNumberTaken(candidate, { excludeId: id }))
  ) {
    return candidate;
  }

  // Otherwise mint fresh ORD from the shared atomic counter.
  // Throws when the sequence store/config is unavailable (caller fails open).
  return salesOrderNumbering.mintOfficialSalesOrderNumber(data);
}

/**
 * Read the current server row and compare it against the version the client
 * based its edit on. Returns either the matched row (the write can proceed)
 * or a structured conflict payload so the client can field-merge immediately.
 *
 * NOTE: This function is retained for backward compatibility with any code
 * that still calls it directly. The primary upsert path now uses atomic
 * conditional PATCH (see upsertRow / softDeleteRow) which eliminates the
 * race window between this read and the subsequent write.
 */
async function checkVersion(table, id, incomingVersion) {
  if (!Number.isFinite(incomingVersion)) return { ok: true, serverVersion: 0 };
  const existing = await getRow(table, id);
  const serverVersion = existing?.version != null ? Number(existing.version) : 0;
  if (serverVersion !== incomingVersion) {
    return {
      ok: false,
      conflict: true,
      conflictType: 'version_conflict',
      serverVersion,
      server: conflictServerPayload(id, existing, serverVersion),
    };
  }
  return { ok: true, serverVersion };
}

/**
 * Operator-facing wording for a rejected examination write. The submitting
 * device sees this verbatim, so it names the blocking state rather than the
 * internal comparison that failed.
 */
function businessRuleMessage(table, conflictType) {
  if (table === EXAMINATION_BATCH_TABLE) {
    if (conflictType === 'BATCH_TOMBSTONE_FORBIDDEN') {
      return 'Cannot delete an approved or invoiced examination batch — financial history is immutable';
    }
    return 'Examination batch state changed on another device — approved pricing is immutable and the update was rejected';
  }
  if (table === INVOICE_TABLE) {
    return 'Examination invoice rejected by the authoritative posting rules';
  }
  return 'Write rejected by authoritative business rules';
}

/**
 * Work out WHY a guarded conditional PATCH matched zero rows. Returns null when
 * the stored status actually satisfies the filter, meaning the zero-row result
 * was an ordinary version conflict after all.
 */
function resolveGuardRejectionReason(guardParams, existing) {
  const statusFilter = guardParams && guardParams['data->>status'];
  if (!statusFilter) return null;
  const existingStatus = String(
    existing && existing.data && typeof existing.data === 'object'
      ? (existing.data.status ?? '')
      : ''
  ).trim().toLowerCase();

  const negated = String(statusFilter).trim().toLowerCase().startsWith('not.in.');
  const list = String(statusFilter)
    .replace(/^not\.in\./i, '')
    .replace(/^in\./i, '')
    .replace(/^\(|\)$/g, '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (list.length === 0) return null;
  const listed = list.includes(existingStatus);
  const violated = negated ? listed : !listed;
  if (!violated) return null;

  return 'BATCH_STATUS_PRECONDITION_FAILED';
}

/** Shape of the server snapshot handed to the client for field-merging. */
function conflictServerPayload(id, existing, serverVersion) {
  return {
    id,
    version: serverVersion,
    updatedAt: existing?.updated_at || null,
    data: (existing && existing.data && typeof existing.data === 'object') ? existing.data : {},
  };
}

/**
 * Business preconditions are merged into the SAME conditional PATCH that
 * performs the write, so PostgreSQL evaluates them inside the write's own
 * transaction. A prior read is never the enforcement point.
 */
function normalizePrecondition(precondition) {
  if (!precondition || typeof precondition !== 'object') return {};
  const filters = precondition.filters;
  if (!filters || typeof filters !== 'object') return {};
  const out = {};
  for (const [key, value] of Object.entries(filters)) {
    if (typeof key === 'string' && key.trim() !== '' && value != null) {
      out[key] = String(value);
    }
  }
  return out;
}

/**
 * Distinguish "the business precondition rejected this write" from "the row
 * moved underneath us". Only the version guard produces a mergeable conflict;
 * a rejected precondition is a business rejection the client must surface.
 */
function classifyGuardRejection(result, existing) {
  const serverVersion = existing?.version != null ? Number(existing.version) : 0;
  if (!existing) {
    return { id: result.id, conflicted: true, conflictType: 'version_conflict', serverVersion, server: null };
  }
  // Only an ACTUAL precondition violation is a business rejection. A guard was
  // supplied for every examination batch write, so keying off "a guard exists"
  // misclassified an ordinary version race as non-retryable and the client
  // stopped retrying a write that had simply moved underneath it.
  if (result.guardReason) {
    return {
      id: result.id,
      conflicted: true,
      conflictType: result.guardReason,
      serverVersion,
      server: conflictServerPayload(result.id, existing, serverVersion),
      businessRule: true,
    };
  }
  return {
    id: result.id,
    conflicted: true,
    conflictType: 'version_conflict',
    serverVersion,
    server: conflictServerPayload(result.id, existing, serverVersion),
  };
}

/**
 * Upsert a row: `{ id, data: <domain fields>, updated_at }`.
 * Numeric `version` is the optimistic-lock precondition.
 *
 * B6: The version check and write are now a SINGLE atomic database operation.
 * When the payload carries a base version, we issue:
 *   PATCH /rest/v1/<table>?id=eq.<id>&version=eq.<expected>
 *   Body: { data, version: expected+1, updated_at }
 * If zero rows are updated, the version moved → conflict. No separate read.
 *
 * Writes WITHOUT a version are only allowed as genuine creates (no existing
 * row): the server stamps `version: 1` so later edits have a base. If the row
 * already exists — including a soft-deleted tombstone — the write is rejected
 * as a `version_required` conflict.
 */
async function upsertRow(table, id, payload, serverNow = new Date().toISOString(), precondition = null) {
  const domain = sanitizeRecord(payload);
  const incomingVersion = Number(payload._version ?? payload.version);
  const guardParams = normalizePrecondition(precondition);

  /* SYNC-FORENSIC suppressed: STAGE-13 cloudSyncStore.upsertRow() */

  // B6: Atomic versioned write — single PATCH with WHERE version = expected.
  if (Number.isFinite(incomingVersion)) {
    const row = {
      data: domain,
      updated_at: serverNow,
      version: incomingVersion + 1,
    };
    try {
      const res = await cloudHttp.patch(`${SUPABASE_URL}/rest/v1/${table}`, row, {
        headers: adminHeaders(),
        params: { id: `eq.${id}`, version: `eq.${incomingVersion}`, ...guardParams },
        timeout: 20000,
      });
      // PostgREST returns the updated rows as an array. Empty = conflict.
      const updated = Array.isArray(res.data) ? res.data : [];
      if (updated.length === 0) {
        // Version mismatch — another client changed the row. Fetch current
        // snapshot so the client can field-merge without an extra round-trip.
        const existing = await getRow(table, id);

        // The row does not exist at all — this is a CREATE, not an update.
        // An atomic PATCH cannot match a non-existent row (WHERE version = N
        // matches nothing), so without this a brand-new row stamped with an
        // initial version would be misreported as a version conflict and never
        // inserted. Insert it with the initial version, mirroring the
        // tombstone-resurrection / unversioned-create POST below.
        if (!existing) {
          const createdRow = { id, data: domain, updated_at: serverNow, version: 1 };
          /* SYNC-FORENSIC suppressed: STAGE-13 atomic PATCH 0 rows + row absent → INSERT (create) */
          const created = await cloudHttp.post(`${SUPABASE_URL}/rest/v1/${table}`, createdRow, {
            headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
            params: { on_conflict: 'id' },
            timeout: 20000,
          });
          const saved = Array.isArray(created.data) ? (created.data[0] || null) : created.data;
          return {
            id: saved?.id || id,
            updatedAt: saved?.updated_at || serverNow,
            createdAt: saved?.created_at || null,
            version: saved?.version != null ? Number(saved.version) : 1,
          };
        }

        /* SYNC-FORENSIC suppressed: STAGE-13 cloudSyncStore.upsertRow() */
        const guardReason = resolveGuardRejectionReason(guardParams, existing);
        return classifyGuardRejection(
          {
            id,
            guardFailed: Boolean(guardReason),
            guardReason,
          },
          existing
        );
      }
      const saved = updated[0];
      /* SYNC-FORENSIC suppressed: STAGE-13 atomic PATCH OK */
      return {
        id: saved?.id || id,
        updatedAt: saved?.updated_at || serverNow,
        createdAt: saved?.created_at || null,
        version: saved?.version != null ? Number(saved.version) : (incomingVersion + 1),
      };
    } catch (err) {
      // axios throws on non-2xx; a 0-row PATCH returns 200 (not thrown).
      // Any thrown error here is a real transport/cloud failure.
      throw err;
    }
  }

  // No version supplied. An existing row — live or tombstoned — must not be
  // overwritten unconditionally; return it as a `version_required` conflict
  // so the client merges against the current snapshot and retries with a base.
  // Exception: tombstoned rows with a version are treated as resurrection intent.
  const existing = await getRow(table, id);
  if (existing) {
    const isTombstone = existing.data && typeof existing.data === 'object'
      && (existing.data.deleted === true || existing.data.deletedAt);
    const serverVersion = existing.version != null ? Number(existing.version) : 0;

    if (isTombstone && Number.isFinite(incomingVersion)) {
      // Tombstone resurrection with version: overwrite the tombstone.
      const row = { id, data: domain, updated_at: serverNow, version: serverVersion + 1 };
      /* SYNC-FORENSIC suppressed: STAGE-13 cloudSyncStore.upsertRow() TOMBSTONE RESURRECT */
      const res = await cloudHttp.post(`${SUPABASE_URL}/rest/v1/${table}`, row, {
        headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
        params: { on_conflict: 'id' },
        timeout: 20000,
      });
      const saved = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
      return {
        id: saved?.id || id,
        updatedAt: saved?.updated_at || serverNow,
        createdAt: saved?.created_at || null,
        version: saved?.version != null ? Number(saved.version) : (serverVersion + 1),
      };
    }

    // Unversioned write on existing row (live or tombstone) → version_required.
    return {
      id,
      conflicted: true,
      conflictType: 'version_required',
      serverVersion,
      server: conflictServerPayload(id, existing, serverVersion),
    };
  }

  // Genuine create: no row exists, so stamp the initial version.
  const row = { id, data: domain, updated_at: serverNow, version: 1 };
  /* SYNC-FORENSIC suppressed: STAGE-13 Supabase upsert NEW RECORD (no version) */
  const res = await cloudHttp.post(`${SUPABASE_URL}/rest/v1/${table}`, row, {
    headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    params: { on_conflict: 'id' },
    timeout: 20000,
  });
  const saved = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
  /* SYNC-FORENSIC suppressed: STAGE-13 Supabase upsert OK (new record v1) */
  return {
    id: saved?.id || id,
    updatedAt: saved?.updated_at || serverNow,
    createdAt: saved?.created_at || null,
    version: saved?.version != null ? Number(saved.version) : 1,
  };
}

/**
 * Soft-delete a row by writing a tombstone into `data`. The physical row is
 * kept so realtime subscribers on other devices observe the deletion as an
 * UPDATE and can reconcile their local caches.
 *
 * B6: The read-then-write is now a single atomic PATCH with a version
 * precondition. The base data is preserved in the `data` JSONB column while
 * tombstone flags are merged in and the version is bumped.
 */
async function softDeleteRow(table, id, serverNow = new Date().toISOString(), precondition = null) {
  // Read the current row to preserve its data payload under the tombstone.
  // This read is for data preservation only; the version check and any business
  // precondition are enforced atomically by the subsequent conditional PATCH.
  const existing = await getRow(table, id);
  const base = existing && existing.data && typeof existing.data === 'object' ? { ...existing.data } : {};
  const baseVersion = existing?.version != null ? Number(existing.version) : 0;
  const guardParams = normalizePrecondition(precondition);

  const tombstoneData = { ...base, deleted: true, deletedAt: serverNow };

  // B6: Atomic conditional PATCH — version must still match.
  const row = {
    id,
    data: tombstoneData,
    updated_at: serverNow,
    version: baseVersion + 1,
  };
  try {
    const res = await cloudHttp.patch(`${SUPABASE_URL}/rest/v1/${table}`, row, {
      headers: adminHeaders(),
      params: { id: `eq.${id}`, version: `eq.${baseVersion}`, ...guardParams },
      timeout: 20000,
    });
    const updated = Array.isArray(res.data) ? res.data : [];
    if (updated.length === 0) {
      // Rejected by either the version guard or a business precondition. Re-read
      // so the response carries a mergeable snapshot — the client's conflict path
      // requires BOTH `conflict` and `server`, otherwise this op is retried until
      // it dead-letters instead of surfacing.
      const current = await getRow(table, id);
      const currentVersion = current?.version != null ? Number(current.version) : 0;
      const guardFailed = Object.keys(guardParams).length > 0
        && Boolean(resolveGuardRejectionReason(guardParams, current));
      return {
        id,
        conflicted: true,
        conflictType: guardFailed ? 'BATCH_TOMBSTONE_FORBIDDEN' : 'version_conflict',
        serverVersion: currentVersion,
        server: conflictServerPayload(id, current, currentVersion),
        ...(guardFailed ? { businessRule: true } : {}),
      };
    }
    const saved = updated[0];
    return {
      id: saved?.id || id,
      updatedAt: saved?.updated_at || serverNow,
      deleted: true,
    };
  } catch (err) {
    // Fallback: if the atomic PATCH fails for a reason other than version
    // mismatch (e.g. row was hard-deleted), fall through to the legacy
    // upsert path so tombstones can still be written. A guarded delete must NOT
    // take this path — an unconditional POST would bypass the business rule.
    if (Object.keys(guardParams).length > 0) {
      const current = await getRow(table, id);
      const currentVersion = current?.version != null ? Number(current.version) : 0;
      if (resolveGuardRejectionReason(guardParams, current)) {
        return {
          id,
          conflicted: true,
          conflictType: 'BATCH_TOMBSTONE_FORBIDDEN',
          serverVersion: currentVersion,
          server: conflictServerPayload(id, current, currentVersion),
          businessRule: true,
        };
      }
    }
    const res = await cloudHttp.post(`${SUPABASE_URL}/rest/v1/${table}`, row, {
      headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
      params: { on_conflict: 'id' },
      timeout: 20000,
    });
    const saved = Array.isArray(res.data) ? (res.data[0] || null) : res.data;
    return {
      id: saved?.id || id,
      updatedAt: saved?.updated_at || serverNow,
      deleted: true,
    };
  }
}

// ─── tombstone lifecycle ────────────────────────────────────────────────────
// Soft deletes keep the physical row (`data.deleted = true` + `data.deletedAt`)
// so realtime subscribers on other devices can reconcile. That makes a good
// experience but means deleted rows live forever. These helpers implement the
// retention policy side of the lifecycle: count tombstones, and GC them once
// they pass the retention window, best-effort archiving each row to a JSONL
// file before it is physically removed from the cloud.

const TOMBSTONE_FLAG = { 'data->>deleted': 'eq.true' };
const PURGE_PAGE_SIZE = 100;

/**
 * Count soft-deleted (tombstoned) rows across a table, all ages.
 */
async function countTombstones(table) {
  if (!isConfigured()) return 0;
  try {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      headers: { ...adminHeaders(), Prefer: 'count=exact' },
      params: { ...TOMBSTONE_FLAG, select: 'id', limit: 1 },
      timeout: 15000,
    });
    const contentRange = String(res.headers?.['content-range'] || '0-0/0');
    // PostgREST returns a `Content-Range: start-end/total` header with count=exact.
    const totalMatch = contentRange.split('/')[1];
    const total = Number(totalMatch);
    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}

/**
 * Purge tombstones older than `retentionDays` for one table. Each purged row is
 * first handed to `archiveFn(row, table)` so the operator keeps an audit trail
 * (archival) before the row is hard-deleted from the cloud.
 *
 * The scan is done in two passes on purpose: first collect the matching ids
 * (bounded offset pages — result set is static while we read), then delete each
 * id. Deleting while paginating can skip rows, so we never read and write in
 * the same loop.
 */
async function purgeTombstones(table, retentionDays, archiveFn = null) {
  if (!isConfigured()) return { purged: 0, archived: 0, skipped: 0 };
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();

  // Phase 1 — collect candidate ids (older than retention).
  const ids = [];
  for (let offset = 0; offset < 10000; offset += PURGE_PAGE_SIZE) {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/${table}`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: {
        ...TOMBSTONE_FLAG,
        select: 'id,updated_at',
        updated_at: `lt.${cutoff}`,
        order: 'updated_at.asc',
        limit: PURGE_PAGE_SIZE,
        offset,
      },
      timeout: 20000,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) break;
    for (const row of rows) {
      if (row?.id != null) ids.push(row);
    }

    // With the retention filter applied, any page shorter than the page size
    // means we've walked the whole set — stop early.
    if (rows.length < PURGE_PAGE_SIZE) break;
  }

  // Phase 2 — archive then hard-delete each tombstone.
  let purged = 0;
  let archived = 0;
  let skipped = 0;
  for (const { id } of ids) {
    if (archiveFn) {
      try { await archiveFn(id, table); archived++; } catch { /* archival is best-effort */ }
    }
    try {
      await cloudHttp.delete(`${SUPABASE_URL}/rest/v1/${table}`, {
        headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
        params: { id: `eq.${id}` },
        timeout: 20000,
      });
      purged++;
    } catch {
      skipped++;
    }
  }

  return { purged, archived, skipped };
}

// ─── sync generation ──────────────────────────────────────────────────────────

const SYNC_GENERATION_SETTING_ID = 'sync_generation';

async function getSyncGeneration() {
  try {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/settings`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: { id: `eq.${SYNC_GENERATION_SETTING_ID}`, select: 'data', limit: 1 },
      timeout: 8000,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    if (rows.length === 0) return 1;
    const val = rows[0]?.data?.value;
    return Number.isFinite(val) && val > 0 ? val : 1;
  } catch {
    return 1;
  }
}

// ─── required client capability (rollout gate) ──────────────────────────────
//
// The document write protocol changed (migration 0052/0053): the new client
// publishes a version BEFORE superseding its predecessor, and the database
// validates that order. A client that still supersedes first is refused by the
// database (permanently, as a trigger rejection), which is safe but opaque.
//
// This gate makes the refusal EXPLICIT and early: the client declares the
// document protocol it implements, and the server refuses document writes from
// a client below the required capability with a readable "upgrade required"
// error instead of letting it reach the database.
//
// The requirement lives in the EXISTING `settings` table (the same mechanism
// the sync generation uses), so no new table, no tenant/company dimension and
// no new infrastructure is introduced. It is OFF (not_configured) until the
// rollout raises it.
//
// The requirement is read as a STRUCTURED STATE, never as a bare number:
//   not_configured - the setting is absent, or it holds the number 0.
//   required       - the setting holds a valid capability (a positive integer).
//   invalid        - the setting exists but its value is not a valid capability.
//   unavailable    - the setting could not be read (database error, timeout, ...).
// A read failure NEVER becomes `not_configured`: a fault must not be mistaken
// for "the rollout did not activate", and the caller must defer rather than let
// an outdated client through.

const REQUIRED_CLIENT_CAPABILITY_SETTING_ID = 'required_client_capability';
const REQUIRED_CAPABILITY_CACHE_MS = 15000;
// A capability is a small protocol version. A value outside this range is a
// configuration error, not a requirement.
const MAX_CLIENT_CAPABILITY = 1000;

// The state that is served while the cache is warm. It is either a state
// derived from a SUCCESSFUL read, or an `unavailable` state describing a
// failed read. A failed read is never cached as `not_configured`.
let requiredCapabilityCache = null;
// The last requirement that was successfully read, preserved across failures so
// a fault still reports what the rollout asked for.
let requiredCapabilityLastRequired = 0;

/**
 * Interpret the settings row.
 *
 * Only a real JSON NUMBER that is a finite integer inside the documented range
 * is a capability. A numeric string, null, a boolean, a negative or a
 * fractional value is a CONFIGURATION ERROR: it must never silently mean
 * "not enforced".
 */
function parseRequiredClientCapability(rows) {
  // The row is ABSENT: the rollout has not activated the requirement.
  if (!Array.isArray(rows) || rows.length === 0) {
    return { state: 'not_configured', value: 0, enforce: false };
  }
  const row = rows[0] || {};
  const data = (row && typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)) ? row.data : null;
  // The row EXISTS but its payload is not a JSON object: a malformed
  // configuration, not an inactive gate.
  if (!data) {
    return {
      state: 'invalid',
      value: 0,
      enforce: false,
      reason: 'the required_client_capability row does not hold a settings object',
      raw: row.data,
    };
  }
  if (!Object.prototype.hasOwnProperty.call(data, 'value')) {
    return {
      state: 'invalid',
      value: 0,
      enforce: false,
      reason: 'the required_client_capability setting has no value',
      raw: data,
    };
  }
  const raw = data.value;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0 || raw > MAX_CLIENT_CAPABILITY) {
    return {
      state: 'invalid',
      value: 0,
      enforce: false,
      reason: 'the required_client_capability setting is not a capability number between 0 and ' + MAX_CLIENT_CAPABILITY,
      raw,
    };
  }
  if (raw === 0) return { state: 'not_configured', value: 0, enforce: false };
  return { state: 'required', value: raw, enforce: true };
}

/**
 * The current capability requirement, as a structured state.
 *
 * @returns {Promise<{state:'not_configured'|'required'|'invalid'|'unavailable',
 *                    value:number, enforce:boolean, reason?:string, raw?:unknown,
 *                    lastKnownState?:string, detail?:string}>}
 */
async function getRequiredClientCapabilityState() {
  const now = Date.now();
  if (requiredCapabilityCache && (now - requiredCapabilityCache.at) < REQUIRED_CAPABILITY_CACHE_MS) {
    return requiredCapabilityCache;
  }
  try {
    const res = await cloudHttp.get(`${SUPABASE_URL}/rest/v1/settings`, {
      headers: { apikey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
      params: { id: `eq.${REQUIRED_CLIENT_CAPABILITY_SETTING_ID}`, select: 'data', limit: 1 },
      timeout: 8000,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const parsed = parseRequiredClientCapability(rows);
    if (parsed.state === 'required') requiredCapabilityLastRequired = parsed.value;
    requiredCapabilityCache = { ...parsed, at: now };
    return requiredCapabilityCache;
  } catch (err) {
    // The read failed. Preserve the last known requirement, report the fault,
    // and let the caller defer: a server fault must never be read as "the
    // rollout did not activate".
    const state = {
      state: 'unavailable',
      value: requiredCapabilityLastRequired,
      enforce: false,
      reason: 'the required client capability could not be read from the server settings',
      lastKnownState: requiredCapabilityCache ? requiredCapabilityCache.state : null,
      detail: String((err && err.message) || err || '').slice(0, 200),
      at: now,
    };
    requiredCapabilityCache = state;
    return state;
  }
}

/**
 * The capability a client declares for the document write protocol.
 * A missing value means the LEGACY protocol (version 1).
 */
function clientCapabilityVersion(op) {
  const raw = op && op.clientCapabilityVersion;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

async function setSyncGeneration(value) {
  const serverNow = new Date().toISOString();
  const payload = {
    id: SYNC_GENERATION_SETTING_ID,
    data: { value: Number(value) },
    updated_at: serverNow,
    version: 1,
  };
  await cloudHttp.post(`${SUPABASE_URL}/rest/v1/settings`, payload, {
    headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
    params: { on_conflict: 'id' },
    timeout: 10000,
  });
}

async function incrementSyncGeneration() {
  const current = await getSyncGeneration();
  const next = current + 1;
  await setSyncGeneration(next);
  return next;
}

// ─── stale-operation guard ───────────────────────────────────────────────────

/**
 * Reject operations whose syncGeneration is behind the server's current value.
 * This is the server-side enforcement of the company-reset contract: an old
 * browser whose local queue contains operations from generation N cannot
 * resurrect deleted records after a reset to generation N+1.
 *
 * Returns null if the operation is valid (current or future generation).
 * Returns a rejection result object if the operation is stale.
 */
async function checkStaleOperation(op) {
  const opGeneration = Number(op?.syncGeneration);
  if (!Number.isFinite(opGeneration) || opGeneration < 1) {
    return {
      operationId: op?.operationId,
      ok: false,
      stale: true,
      reason: 'SYNC_GENERATION_MISSING',
      error: 'Operation has no sync generation; cannot be safely replayed after a company reset',
      retryable: false,
    };
  }
  const currentGeneration = await getSyncGeneration();
  if (opGeneration < currentGeneration) {
    return {
      operationId: op?.operationId,
      ok: false,
      stale: true,
      reason: 'SYNC_GENERATION_STALE',
      error: `Operation belongs to sync generation ${opGeneration} which is older than the current generation ${currentGeneration}. The company has been reset.`,
      retryable: false,
    };
  }
  return null;
}

// ─── applyOp ─────────────────────────────────────────────────────────────────

/**
 * Authoritative account-scope gate for synced `customer_payments`.
 *
 * The offline-first client validates BEFORE it commits locally
 * (transactionService.addCustomerPayment). This re-validates at the cloud
 * commit boundary so a queued / synchronized / replayed allocation — or one
 * pushed by a stale device — can never write a cross-account financial record.
 *
 * Three outcomes (never "assume it is fine"):
 *
 *   null                            → the op may proceed
 *   { code, error }                 → TERMINAL rejection: ownership is PROVEN
 *                                     broken (different account, sibling
 *                                     branch, ambiguous name, foreign branch).
 *   { code, error, pending: true }  → ownership CANNOT BE PROVEN YET: the
 *                                     referenced invoice or the parent customer
 *                                     has not synchronized (or the read failed).
 *                                     The op is DEFERRED, never committed
 *                                     unverified. This is what preserves
 *                                     legitimate offline operation: the client's
 *                                     outbox retries the op, and the bounded
 *                                     retry budget (MAX_RETRIES in
 *                                     durableSyncQueue) escalates a payment
 *                                     whose dependency never arrives to the
 *                                     dead-letter queue instead of silently
 *                                     committing it against the wrong account.
 *
 * A branch-scoped allocation additionally requires the parent customer row so
 * branch OWNERSHIP can be proven; a Main↔Main allocation needs no customer row
 * (and must keep working while the customer itself is still offline).
 *
 * @param {object} payload  the synced `customer_payments` row
 * @param {object} [deps]   test seam: `{ getRow }` defaults to the module reader
 */
async function validateCustomerPaymentScope(payload, deps = {}) {
  const readRow = typeof deps.getRow === 'function' ? deps.getRow : getRow;
  if (!payload || typeof payload !== 'object') return null;
  const allocations = Array.isArray(payload.allocations) ? payload.allocations : [];
  const applied = allocations.filter((a) => a && Number(a.amount ?? a.allocated ?? 0) > 0);
  if (applied.length === 0) return null;

  const proj = accountScope.scopeRecord(payload);
  if (!String(proj.customerId || '').trim()) {
    return {
      code: 'EAMBIGUOUS_SCOPE',
      error: 'Cross-account allocation blocked: the synced payment has no resolvable customer account scope.',
    };
  }

  const paymentIdLabel = String(payload.id || '').trim() || '(unsaved)';
  const hasBranchTag = (row) => {
    const p = accountScope.scopeRecord(row);
    const id = String(p.subAccountId ?? '').trim();
    if (id) return true;
    return !accountScope.isMainBranchValue(p.subAccountName);
  };

  let customer = null;
  try {
    customer = await readRow('customers', proj.customerId);
    if (customer && customer.data && typeof customer.data === 'object') customer = { ...customer, ...customer.data };
  } catch { customer = null; }

  // Resolve EVERY referenced invoice before deciding anything. A payment is
  // never committed while any of its allocation targets is unreadable.
  const invoices = [];
  for (const a of applied) {
    const invoiceId = a.invoiceId || a.invoice_id;
    if (!invoiceId) {
      return {
        code: 'EAMBIGUOUS_SCOPE',
        error: 'Cross-account allocation blocked: a synced payment allocation carries no invoice reference.',
      };
    }
    let invoice = null;
    let readFailed = false;
    try {
      invoice = await readRow('invoices', invoiceId);
      if (invoice && invoice.data && typeof invoice.data === 'object') invoice = { ...invoice, ...invoice.data };
    } catch { invoice = null; readFailed = true; }
    if (!invoice) {
      return {
        code: 'EINVOICE_NOT_SYNCED',
        pending: true,
        error:
          `Account scope for payment ${paymentIdLabel} cannot be verified yet: invoice ${invoiceId} is ` +
          `${readFailed ? 'not readable (read failed)' : 'not yet synchronized'}. The allocation is deferred and ` +
          'will be re-validated once the invoice is available; it is never committed unverified.',
      };
    }
    invoices.push(invoice);
  }

  // Branch OWNERSHIP can only be proven against the parent customer's branch
  // list. Without it a branch allocation is deferred, not assumed valid.
  const anyBranch = hasBranchTag(payload) || invoices.some(hasBranchTag);
  if (anyBranch && !customer) {
    return {
      code: 'ECUSTOMER_NOT_SYNCED',
      pending: true,
      error:
        `Account scope for payment ${paymentIdLabel} cannot be verified yet: the parent customer ${proj.customerId} ` +
        'is not available in the cloud, so branch ownership is unproven. The allocation is deferred.',
    };
  }

  for (const invoice of invoices) {
    try {
      accountScope.assertSameAccountOwnership(payload, invoice, customer);
    } catch (err) {
      return { code: err.code || 'ECROSS_ACCOUNT', error: err.message };
    }
  }
  return null;
}

/**
 * Deterministic database rejections.
 *
 * PostgREST answers HTTP 409 for BOTH a lost optimistic-concurrency race
 * (retryable — re-reading the row resolves it) and a deterministic rejection
 * (retrying can NEVER succeed). The two are told apart by the SQLSTATE:
 *
 *   23505 unique_violation      — a unique index refused the write (e.g. the
 *                                  contract-document identity index, or the
 *                                  0049 number index).
 *   23P01 exclusion_violation    — an exclusion constraint refused the write.
 *   P0001 raise_exception        — a trigger refused the write (e.g. the
 *                                  contract-document immutability trigger).
 *
 * These are surfaced (dead-lettered with the reason) instead of being retried
 * in a loop that can never converge.
 */
function deterministicConflict(pgCode) {
  switch (String(pgCode || '')) {
    case '23505': return 'unique_violation';
    case '23P01': return 'exclusion_violation';
    case 'P0001': return 'trigger_rejected';
    default: return null;
  }
}

/**
 * Apply an operation. Returns a normalized result object used by the route:
 *   { operationId, ok, id, updatedAt, error, retryable }
 * Errors produced by the cloud (validation, schema, RLS, uniqueness) are
 * marked `retryable:false` so the client moves the op to its dead-letter
 * queue instead of retrying forever. Network/5xx are retryable.
 */
async function applyOp(op) {
  const { operationId, table, recordId, operation, payload } = op || {};
  /* SYNC-FORENSIC suppressed: STAGE-12 cloudSyncStore.applyOp() */
  if (!table || typeof table !== 'string') {
    return { operationId, ok: false, error: 'table is required', retryable: false };
  }
  if (!['upsert', 'delete'].includes(operation)) {
    return { operationId, ok: false, error: `unsupported operation: ${operation}`, retryable: false };
  }

  const staleResult = await checkStaleOperation(op);
  if (staleResult) {
    return staleResult;
  }

  // Idempotency guard — if the same operation id already succeeded, replay is a no-op.
  // Wrapped defensively: a failure probing the idempotency table must never bubble
  // up as a 500 — it degrades to "not seen yet" and the write proceeds (or fails
  // safely downstream). This is the most likely source of previously-unhandled 500s.
  // For sales_orders replays the persisted authoritative number is attached so a
  // retry after response-loss adopts the SAME number instead of minting another.
  if (operationId) {
    try {
      const seen = await checkIdempotency(operationId);
      if (seen.alreadyProcessed) {
        const replayedId = seen.result || recordId;
        if (table === 'sales_orders' && replayedId) {
          try {
            const replayedRow = await getRow(table, replayedId);
            const replayedData =
              replayedRow && replayedRow.data && typeof replayedRow.data === 'object'
                ? replayedRow.data
                : null;
            const replayedNumber = replayedData
              ? (replayedData.order_number != null && String(replayedData.order_number).trim() !== ''
                ? String(replayedData.order_number)
                : null)
              : null;
            return {
              operationId,
              ok: true,
              id: replayedId,
              replayed: true,
              order_number: replayedNumber,
              version: replayedRow?.version != null ? Number(replayedRow.version) : undefined,
              updatedAt: replayedRow?.updated_at || undefined,
            };
          } catch {
            // Best-effort enrichment only — fall through to the plain replay.
          }
        }
        return { operationId, ok: true, id: seen.result || recordId, replayed: true };
      }
    } catch (idErr) {
      console.warn(`[cloudSyncStore] idempotency probe failed for ${operationId}, continuing:`, idErr?.message || idErr);
    }
  }

  // Pre-image of a client rename. The cascade needs the PREVIOUS display name,
  // which only exists in the cloud copy read before the write lands. Read
  // best-effort: a failure degrades to "no rename detected".
  let preCustomerRenameRow = null;
  if (table === 'customers' && operation === 'upsert' && isConfigured()) {
    const targetId = recordId || payload?.id;
    if (targetId) {
      try {
        preCustomerRenameRow = await getRow('customers', targetId);
      } catch { preCustomerRenameRow = null; }
    }
  }

  // Account-scope gate for synced payment allocations. Runs BEFORE any write so
  // a queued/offline allocation can never commit a cross-account financial
  // record.
  //
  //   * PROVEN violation → terminal (non-retryable): the client must surface it.
  //   * UNPROVABLE (dependency not synchronized yet) → retryable deferral: the op
  //     stays in the client outbox and is re-validated on the next cycle, so a
  //     legitimate offline payment is never lost AND never committed unverified.
  //   * Gate itself threw → fail CLOSED and retry; never treat an unexpected
  //     error in the guard as permission to write.
  if (table === 'customer_payments' && operation === 'upsert' && isConfigured()) {
    let rejection = null;
    let gateError = null;
    try {
      rejection = await validateCustomerPaymentScope(payload);
    } catch (gateErr) {
      gateError = gateErr;
      console.warn(`[cloudSyncStore] scope gate error for customer_payments/${recordId || payload?.id}:`, gateErr?.message || gateErr);
    }
    if (gateError) {
      return {
        operationId,
        ok: false,
        id: recordId || payload?.id,
        retryable: true,
        code: 'ESCOPE_GATE_UNAVAILABLE',
        error:
          'Account-scope validation could not complete, so the payment was NOT committed. ' +
          `It will be re-validated on the next sync (${gateError.message || gateError}).`,
      };
    }
    if (rejection && rejection.pending) {
      console.warn(`[cloudSyncStore] customer_payments/${recordId || payload?.id} deferred: ${rejection.error}`);
      return {
        operationId,
        ok: false,
        id: recordId || payload?.id,
        retryable: true,
        deferred: true,
        code: rejection.code,
        error: rejection.error,
      };
    }
    if (rejection) {
      console.warn(`[cloudSyncStore] customer_payments/${recordId || payload?.id} rejected: ${rejection.error}`);
      return {
        operationId,
        ok: false,
        id: recordId || payload?.id,
        retryable: false,
        conflict: true,
        conflictType: 'account_scope_violation',
        businessRule: true,
        code: rejection.code,
        error: rejection.error,
      };
    }
  }

  try {
    let result;
    // The authoritative sales-order number stamped onto this payload (adopted
    // or freshly minted). Returned to the caller so the creating device can
    // adopt it immediately instead of waiting for the next pull cycle. Null
    // when nothing was stamped (mint skipped / history-immutable unnumbered
    // row) — never a fabricated frontend value.
    let stampedSalesOrderNumber = null;
    if (operation === 'delete') {
      // recordId required; tombstone the row (no hard delete).
      if (!recordId) {
        return { operationId, ok: false, error: 'recordId is required for delete', retryable: false };
      }
      result = await softDeleteRow(table, recordId, new Date().toISOString(), op.precondition);
    } else {
      const id = recordId || payload?.id;
      if (!id) {
        return { operationId, ok: false, error: 'recordId or payload.id is required for upsert', retryable: false };
      }
      if (table === 'sales_orders' && payload && typeof payload === 'object') {
        try {
          const officialNumber = await ensureSalesOrderNumber(payload);
          if (officialNumber) {
            payload.order_number = officialNumber;
            stampedSalesOrderNumber = officialNumber;
            console.log(`[cloudSyncStore] sales_orders ${id} official number: ${officialNumber}`);
          }
        } catch (mintErr) {
          // Numbering must never block the business write — the row is saved
          // without an official number and the next push re-runs the mint.
          console.warn(`[cloudSyncStore] sales_orders ${id} number mint skipped:`, mintErr?.message || mintErr);
        }
        try {
          result = await upsertRow(table, id, payload, new Date().toISOString(), op.precondition);
        } catch (upsertErr) {
          // A kept client-supplied number can lose an interleave race it
          // should never have entered (unique index backstop). Consume ONE
          // fresh value and retry once instead of failing forever; every
          // other failure propagates to the normal retryable path below.
          if (
            salesOrderNumbering.isUniqueViolation(upsertErr) &&
            salesOrderNumbering.isOfficialSalesOrderNumber(payload.order_number)
          ) {
            const fresh = await salesOrderNumbering.mintOfficialSalesOrderNumber(payload);
            payload.order_number = fresh;
            stampedSalesOrderNumber = fresh;
            console.log(`[cloudSyncStore] sales_orders ${id} re-minted after conflict: ${fresh}`);
            result = await upsertRow(table, id, payload);
          } else {
            throw upsertErr;
          }
        }
      } else {
        result = await upsertRow(table, id, payload, new Date().toISOString(), op.precondition);
      }
    }

    // Optimistic-concurrency gate rejected the write: another device changed
    // the row since this client read it. Return the current server row so the
    // client can field-merge without an extra round-trip and retry immediately.
    if (result?.conflicted) {
      // A business-rule rejection is terminal: the client must surface it, never
      // retry it. Retryable is reserved for true optimistic-concurrency races,
      // which re-reading the server row can actually resolve.
      if (result.businessRule) {
        return {
          operationId,
          ok: false,
          id: result.id,
          conflict: true,
          conflictType: result.conflictType || 'business_rule_conflict',
          retryable: false,
          businessRule: true,
          error: businessRuleMessage(table, result.conflictType),
          server: result.server,
        };
      }
      return {
        operationId,
        ok: false,
        id: result.id,
        conflict: true,
        conflictType: result.conflictType || 'version_conflict',
        retryable: true,
        error: 'Version conflict — record was updated by another device',
        server: result.server,
      };
    }

    if (operationId && result?.id) {
      // Best-effort only: a failure recording the idempotency key must never
      // turn a successful write into a 500. The write already succeeded.
      try { await recordIdempotency(operationId, result.id); }
      catch (recErr) { console.warn(`[cloudSyncStore] idempotency record failed for ${operationId}:`, recErr?.message || recErr); }
    }
    if (table === 'customers' && operation === 'upsert' && result?.id) {
      // Rename propagation runs after the write and the idempotency record so
      // a replay short-circuits it, and it never fails the business write.
      try {
        await propagateCustomerRenameToCloud(result.id, payload, preCustomerRenameRow);
      } catch (renameErr) {
        console.warn(`[cloudSyncStore] customer rename cascade failed for ${result.id}:`, renameErr?.message || renameErr);
      }
    }
    if (table === 'sales_orders' && operation === 'upsert') {
      return {
        operationId,
        ok: true,
        id: result.id,
        updatedAt: result.updatedAt,
        version: result.version,
        order_number: stampedSalesOrderNumber,
      };
    }
    return { operationId, ok: true, id: result.id, updatedAt: result.updatedAt, version: result.version };
  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response && typeof err.response.data === 'object' ? err.response.data : null;
    const pgCode = body ? String(body.code || '') : '';
    const pgMessage = body ? String(body.message || '') : '';
    const detail = err?.response?.data ? (typeof err.response.data === 'string' ? err.response.data : JSON.stringify(err.response.data)) : '';
    const message = err?.message || String(err);
    const normalized = detail && detail.length < 300 ? detail : message;

    // B8: Granular error classification. Only genuinely transient failures are
    // retryable; schema/authorization/constraint errors are dead-lettered.
    let isRetryable;
    if (!status) {
      // No HTTP status → network-level failure (DNS, timeout, connection reset)
      isRetryable = true;
    } else if (status === 429) {
      // Rate limiting — caller should back off and retry
      isRetryable = true;
    } else if (status >= 500) {
      // Server-side error — may be transient (overload, restart, etc.)
      isRetryable = true;
    } else if (status === 409) {
      // Conflict. PostgREST answers 409 for BOTH a lost optimistic-concurrency
      // race (retryable: re-reading the row can resolve it) and a DETERMINISTIC
      // database rejection — a unique-violation (23505) or a trigger raising
      // (P0001, e.g. the contract-document immutability trigger). Retrying a
      // deterministic rejection can never succeed, so it must be surfaced
      // (dead-lettered) instead of looping forever.
      const deterministic = deterministicConflict(pgCode);
      isRetryable = !deterministic;
    } else if (status === 400 && pgCode === 'P0001') {
      // PostgREST answers 400 — NOT 409 — for a raised exception
      // (SQLSTATE P0001, `RAISE EXCEPTION`). That is exactly what the
      // contract-document immutability trigger does, so a refused write must be
      // recognised here and surfaced as a permanent, labelled failure instead
      // of an opaque 400. A 400 with any OTHER SQLSTATE (a validation error, a
      // malformed request, a bad PostgREST path) keeps the ordinary 4xx
      // handling below: permanent, but NOT labelled as a trigger rejection.
      isRetryable = false;
    } else {
      // 4xx (except 409/429): schema errors (PGRST204/PGRST205), authorization
      // failures, constraint violations, bad requests → non-retryable.
      isRetryable = false;
    }

    console.warn(`[cloudSyncStore] ${operation} ${table}/${recordId} failed (${status || 'network'}): ${normalized}`);
    // A missing table (schema not deployed in this environment, e.g. 0049
    // contract_documents) is permanent for this op, so it stays non-retryable —
    // but it is flagged distinctly with a documented recovery path so a VALID
    // record is never silently dead-lettered with no way back.
    const schemaMissing = /PGRST205|42P01|could not find the table|schema cache/i.test(`${detail} ${message}`);
    // A deterministic database rejection (unique violation / trigger refusal)
    // is surfaced with its own conflict type so the client dead-letters it and
    // shows the reason, instead of retrying a write that can never succeed.
    // A raised exception arrives as HTTP 400 (PostgREST maps P0001 to 400),
    // a unique violation as HTTP 409.
    const deterministic = (status === 409 || status === 400) ? deterministicConflict(pgCode) : null;
    return {
      operationId,
      ok: false,
      id: recordId,
      error: normalized,
      retryable: isRetryable,
      ...(deterministic
        ? { conflict: true, conflictType: deterministic, conflictReason: pgMessage || normalized }
        : {}),
      ...(schemaMissing
        ? {
          schemaMissing: true,
          recovery: `Apply the missing migration for '${table}' and re-push this operation from the dead-letter queue; the record remains locally intact.`,
        }
        : {}),
    };
  }
}

module.exports = {
  isConfigured,
  stringToUuid5,
  applyOp,
  validateCustomerPaymentScope,
  getRow,
  listRows,
  listPullPage,
  findRowsByDataField,
  findRowById,
  upsertRow,
  softDeleteRow,
  checkIdempotency,
  recordIdempotency,
  countTombstones,
  purgeTombstones,
  ensureSalesOrderNumber,
  getSyncGeneration,
  getRequiredClientCapabilityState,
  clientCapabilityVersion,
  incrementSyncGeneration,
  propagateCustomerRenameToCloud,
};
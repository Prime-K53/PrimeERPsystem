/**
 * POST /api/sync/ops — single gateway for ALL business-data writes in the
 * offline-first ERP.
 *
 * Responsibilities:
 *   1. Authenticate (via the global verifyToken mounted in index.cjs, which
 *      accepts backend JWTs AND Supabase JWTs).
 *   2. Accept a batch of upsert/delete operations produced by the durable
 *      sync queue running on the browser.
 *   3. Validate: operation shape + table allow-list (no arbitrary table
 *      writes against the cloud).
 *   4. Write each op to the cloud database with the service-role key, with
 *      per-op idempotency so a retried batch never double-applies.
 *   5. Return per-op results so the client can mark success / dead-letter.
 *
 * Tombstones: deletes are soft. The physical row remains (with
 * `data.deleted` + `data.deletedAt`) so realtime subscribers reconcile.
 */
const express = require('express');
const cloudSyncStore = require('../services/cloudSyncStore.cjs');
const portalLifecycleService = require('../services/portalLifecycleService.cjs');
const { isAdmin: roleIsAdmin, isPortalCustomer: roleIsPortalCustomer, resolveRole: resolveAuthRole, normalize: normalizeRole } = require('../middleware/roles.cjs');

const router = express.Router();

const safeJsonStringify = (value) => {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) return undefined;
      seen.add(val);
    }
    if (typeof val === 'bigint') return val.toString();
    return val;
  });
};

// Allow-list of cloud tables the sync gateway may write. Union of the two
// frontend maps (services/cloudDb STORE_TO_TABLE + services/db CLOUD_TABLE_MAP)
// plus the realtime/extra tables. Kept server-side so the browser cannot
// nominate arbitrary tables.
const ALLOWED_TABLES = new Set([
  // catalog / finance
  'products', 'warehouses', 'accounts', 'settings',
  'ledger_entries', 'expenses', 'income', 'budgets', 'transfers', 'cheques',
  'purchase_orders', 'inventory_movements', 'financial_years', 'user_preferences',

  // customers / sales
  'customers', 'suppliers', 'sales', 'purchases', 'invoices', 'quotations', 'orders',
  'customer_payments', 'supplier_payments', 'payment_allocations', 'payment_allocation_lines',
  'sales_orders', 'delivery_notes',
  'shipments', 'recurring_invoices', 'scheduled_payments', 'wallet_transactions',
  'sales_exchanges', 'sales_exchange_items', 'reprint_jobs', 'sales_exchange_approvals',
  'subscribers', 'reminders', 'tasks', 'schools', 'classes', 'subjects',

  // production / inventory
  'production_batches', 'production_resources', 'work_centers', 'work_orders',
  'boms', 'bom_templates', 'goods_receipts', 'job_tickets',
  'job_ticket_settings', 'resource_allocations', 'warehouse_inventory',
  'material_batches', 'material_categories', 'inventory_transactions',
  'material_reservations', 'profit_margin_settings', 'market_adjustments',
  'market_adjustment_transactions', 'tax_rates',

  // payroll / HR
  'employees', 'payroll_runs', 'payslips', 'user_groups',

  // banking
  'bank_accounts', 'bank_transactions', 'bank_statements',
  'bank_scheduled_payments', 'bank_exchange_rates', 'bank_fees',
  'bank_reconciliations', 'bank_adjustments', 'bank_cash_flow_forecasts',
  'bank_alerts', 'bank_categories',

  // VAT / rounding
  'vat_transactions', 'vat_returns', 'rounding_logs',

  // examination module
  'examination_batches', 'examination_jobs', 'examination_job_subjects',
  'examination_invoice_groups', 'examination_recurring_profiles',
  'examination_inventory_deductions', 'examination_batch_notifications',
  'examination_papers', 'examination_printing_batches',
  'notification_audit_logs', 'job_orders',

  // marketing / communications
  'sms_campaigns', 'sms_templates', 'customer_notification_logs',
  'whatsapp_chats', 'whatsapp_templates', 'whatsapp_campaigns',
  'whatsapp_automations', 'portal_ads',

  // procurement / maintenance
  'subcontract_orders', 'maintenance_logs',

  // referral program — pending migration (0003/0004), not yet applied to live.
  // Not in allow-list until the migration is applied to avoid dead-letter debt.

  // engagement / loyalty
  'engagement_timeline', 'engagement_audit', 'engagement_points',
  'engagement_point_balances', 'engagement_cashback', 'engagement_membership_tiers',
  'engagement_customer_tiers', 'engagement_gift_cards',
  'engagement_gift_card_transactions', 'engagement_affiliates',
  'engagement_affiliate_commissions', 'engagement_promotions',
  'engagement_customer_rewards', 'engagement_analytics',

  // audit / sync infrastructure
  'audit_logs', 'profiles', 'idempotency_keys',
]);

// Tables that simply do not exist in the cloud shape yet. Their writes are
// acknowledged (no-op) so the client drains the queue instead of dead-lettering.
const NOOP_TABLES = new Set(['_files']);

const MAX_BATCH_SIZE = 100;

const VALID_TABLE_PATTERN = /^[a-z_][a-z0-9_]*$/;

// ─── portal_ads payload validation (Customer Portal banner pipeline) ────────
// The portal renders banners at a fixed 3:1 area, so a record carrying an
// arbitrary/non-image URL or inconsistent dimension metadata could break the
// dashboard layout. This focused guard runs only for the portal_ads table —
// every other table keeps its existing generic gateway behavior.

const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/i;

function validatePortalAdPayload(op) {
  if (op.operation === 'delete') {
    return null; // deletes only carry { id, deleted } — nothing to validate
  }
  const p = op.payload;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return 'portal_ads payload must be an object';
  }
  if (typeof p.id !== 'string' || p.id.length === 0) {
    return 'portal_ads payload requires a non-empty string id';
  }
  if (p.title != null && typeof p.title !== 'string') {
    return 'portal_ads title must be a string';
  }
  if (p.imageUrl != null && p.imageUrl !== '') {
    if (typeof p.imageUrl !== 'string' || !HTTP_URL_PATTERN.test(p.imageUrl)) {
      return 'portal_ads imageUrl must be a valid http(s) URL';
    }
  }
  if (p.imageMeta != null) {
    const m = p.imageMeta;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      return 'portal_ads imageMeta must be an object';
    }
    const w = Number(m.width);
    const h = Number(m.height);
    if (!(Number.isFinite(w) && w > 0) || !(Number.isFinite(h) && h > 0)) {
      return 'portal_ads imageMeta requires positive numeric width and height';
    }
    if (m.aspectRatio != null) {
      const ar = Number(m.aspectRatio);
      if (!(Number.isFinite(ar) && ar > 0)) {
        return 'portal_ads imageMeta aspectRatio must be a positive number';
      }
      const fromDims = w / h;
      if (Math.abs(ar - fromDims) / fromDims > 0.01) {
        return `portal_ads imageMeta aspectRatio ${ar} does not match width/height (${fromDims})`;
      }
    }
    if (m.format != null && typeof m.format !== 'string') {
      return 'portal_ads imageMeta format must be a string';
    }
    if (m.fileSize != null && !(Number.isFinite(Number(m.fileSize)) && Number(m.fileSize) >= 0)) {
      return 'portal_ads imageMeta fileSize must be a non-negative number';
    }
  }
  return null;
}

router.post('/ops', async (req, res) => {
  try {
    // B5 + Admin-only ERP: the sync gateway is the single write path for ALL
    // business data. Prime ERP is Admin-only, so the gateway requires an
    // authenticated Admin. The role is resolved from the verified
    // authentication context set by the global verifyToken middleware — never
    // from request headers or body. Portal customers are explicitly rejected.
    const hasUser = Boolean(req.user);
    const authMode = req.authMode || 'none';
    const callerRole = resolveAuthRole(req.user);
    if (!hasUser || callerRole === 'anonymous' || callerRole === '') {
      console.warn('[sync] SYNC_AUTH_FAILED reason=unauthenticated authMode=%s path=%s', authMode, req.path);
      return res.status(401).json({
        error: 'Unauthenticated',
        message: 'Authentication required to write to the sync gateway.',
      });
    }
    if (roleIsPortalCustomer(callerRole)) {
      console.warn('[sync] SYNC_AUTH_FAILED reason=portal_customer authMode=%s role=%s userId=%s path=%s', authMode, callerRole, req.user?.id, req.path);
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Sync gateway is Admin-only. Portal customers cannot write business data.',
      });
    }
    if (!roleIsAdmin(callerRole)) {
      console.warn('[sync] SYNC_AUTH_FAILED reason=non_admin authMode=%s role=%s userId=%s path=%s', authMode, callerRole, req.user?.id, req.path);
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Sync gateway requires an Admin. This account is not an Admin.',
      });
    }
    console.log('[sync] SYNC_AUTH_OK: authMode=%s role=%s userId=%s', authMode, callerRole, req.user?.id);

    const { ops } = req.body || {};
    /* SYNC-FORENSIC suppressed: STAGE-9 backend POST /api/sync/ops received */
    if (!Array.isArray(ops) || ops.length === 0) {
      return res.status(400).json({ error: 'ops array is required' });
    }
    if (ops.length > MAX_BATCH_SIZE) {
      return res.status(400).json({ error: `batch too large (max ${MAX_BATCH_SIZE})` });
    }
    if (!cloudSyncStore.isConfigured()) {
      const missingVars = [
        !process.env.SUPABASE_URL && !process.env.VITE_SUPABASE_URL ? 'SUPABASE_URL' : null,
        !process.env.SUPABASE_SECRET_KEY ? 'SUPABASE_SECRET_KEY' : null,
      ].filter(Boolean);
      console.error('[sync] 503: cloud not configured. Missing env vars:', missingVars);
      return res.status(503).json({ 
        error: 'Cloud database is not configured on this server',
        missing: missingVars,
        hint: 'Set SUPABASE_URL and SUPABASE_SECRET_KEY on the Render server environment'
      });
    }

    const results = [];
    for (const op of ops) {
      // Guard against malformed queue entries (null/undefined/non-object) so a
      // single bad op can never throw past this loop and surface as a 500.
      if (!op || typeof op !== 'object') {
        results.push({ operationId: undefined, ok: false, error: 'invalid operation envelope', retryable: false });
        continue;
      }

      const table = String(op?.table || '');

      if (!VALID_TABLE_PATTERN.test(table)) {
        results.push({ operationId: op?.operationId, ok: false, error: `invalid table: ${table}`, retryable: false });
        continue;
      }
      if (NOOP_TABLES.has(table)) {
        results.push({ operationId: op?.operationId, ok: true, id: op?.recordId || null, noop: true });
        continue;
      }
      if (!ALLOWED_TABLES.has(table)) {
        results.push({ operationId: op?.operationId, ok: false, error: `table not allowed: ${table}`, retryable: false });
        continue;
      }

      if (table === 'portal_ads') {
        const adError = validatePortalAdPayload(op);
        if (adError) {
          console.warn(`[sync] portal_ads validation rejected ${op?.operationId}`, { error: adError });
          results.push({ operationId: op?.operationId, ok: false, id: op?.recordId || null, error: adError, retryable: false });
          continue;
        }
      }

      let result;
      try {
        /* SYNC-FORENSIC suppressed: STAGE-10 backend applyOp() */
        result = await cloudSyncStore.applyOp({
          operationId: op.operationId,
          table,
          recordId: op.recordId || null,
          operation: op.operation,
          payload: op.payload,
        });
        /* SYNC-FORENSIC suppressed: STAGE-10 backend applyOp() RESULT */
      } catch (opErr) {
        // applyOp is designed to return per-op failures, but a defensive catch
        // here guarantees a bad op never escapes as a 500 — it becomes a
        // retryable per-op failure so the client dead-letters it cleanly.
        console.error('[sync] applyOp threw:', opErr?.stack || opErr?.message || opErr);
        result = {
          operationId: op?.operationId,
          ok: false,
          id: op?.recordId || null,
          error: opErr?.message ? String(opErr.message).slice(0, 300) : 'sync gateway internal error',
          retryable: true,
        };
      }

      results.push(result);

      // ─── SSE invalidation for portal_ads ────────────────────────────────────
      // Tombstoned/deleted ads must disappear from the Portal banner immediately.
      // Broadcasting on both 'portal' (customers) and 'admin' channels so the
      // ERP Smart Operations Hub also refreshes its ad list on every write.
      if (result.ok && table === 'portal_ads' && result.id) {
        const adPayload = {
          docType: 'portal_ad',
          docId: result.id,
          ...(op.operation === 'delete' ? { event: 'deleted' } : { event: 'upserted' }),
        };
        portalLifecycleService.emitEntityChange('portal', adPayload);
        portalLifecycleService.emitEntityChange('admin', adPayload);
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    /* SYNC-FORENSIC suppressed: STAGE-11 backend response sent */
    res.set('Content-Type', 'application/json').send(safeJsonStringify({
      ok: true,
      processed: results.length,
      succeeded: okCount,
      results,
    }));
  } catch (err) {
    console.error('[sync] POST /ops error:', err);
    console.error('[sync] POST /ops error stack:', err?.stack);
    res.status(500).json({ error: 'Sync gateway failed', detail: err?.message || String(err) });
  }
});

// Health probe for the sync gateway (used to detect route availability).
router.get('/health', (req, res) => {
  res.json({ ok: true, cloud: cloudSyncStore.isConfigured() });
});

// ─── tombstone lifecycle (admin) ────────────────────────────────────────────
// Soft deletes keep physical rows so other devices reconcile; the retention
// policy below gives admins the tools to purge old tombstones from the cloud
// with a JSONL audit trail written into the workspace Sync folder first.

const fs = require('fs');
const path = require('path');
const workspaceService = require('../services/workspaceService.cjs');

const isAdmin = (req) => {
  const role = String(req.user?.role || '').toLowerCase();
  return role === 'admin' || role === 'company admin' || role === 'owner';
};

const syncArchiveDir = () => {
  const config = workspaceService.getWorkspaceConfig();
  return config?.workspacePath ? path.join(config.workspacePath, 'Sync', 'tombstone-archive') : null;
};

/** Append one tombstone row as a JSON line; never throws (best-effort archival). */
async function archiveTombstone(id, table) {
  const dir = syncArchiveDir();
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const file = path.join(dir, `${table}-${day}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ archivedAt: new Date().toISOString(), table, id }) + '\n');
}

// Count soft-deleted rows in a table (all ages).
router.get('/tombstones/count', async (req, res) => {
  try {
    const table = String(req.query.table || '');
    if (!ALLOWED_TABLES.has(table)) {
      return res.status(400).json({ error: `table not allowed: ${table}` });
    }
    const count = await cloudSyncStore.countTombstones(table);
    res.json({ ok: true, table, count });
  } catch (err) {
    console.error('[sync] GET /tombstones/count error:', err?.message || err);
    res.status(500).json({ error: 'Tombstone count failed' });
  }
});

// Purge tombstones older than `retentionDays` for one table, archiving each row
// to the workspace before it is hard-deleted from the cloud.
router.post('/tombstones/purge', async (req, res) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({ error: 'Admin role required to purge tombstones' });
    }
    const { table, retentionDays } = req.body || {};
    if (!ALLOWED_TABLES.has(String(table || ''))) {
      return res.status(400).json({ error: `table not allowed: ${table}` });
    }
    const days = Math.max(1, Math.min(Number(retentionDays) || 30, 365));
    const result = await cloudSyncStore.purgeTombstones(String(table), days, archiveTombstone);
    res.json({ ok: true, table, retentionDays: days, ...result });
  } catch (err) {
    console.error('[sync] POST /tombstones/purge error:', err?.message || err);
    res.status(500).json({ error: 'Tombstone purge failed' });
  }
});

router.validatePortalAdPayload = validatePortalAdPayload;

module.exports = router;
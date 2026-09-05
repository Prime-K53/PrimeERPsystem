const cloudSyncStore = require('./cloudSyncStore.cjs');

const SUPABASE_URL = String(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY || '';
const axios = require('axios');

function isConfigured() {
  return Boolean(SUPABASE_URL && SECRET_KEY && !SUPABASE_URL.includes('placeholder'));
}

function adminHeaders() {
  return {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
  };
}

function toStrictIso(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function fromSupabaseRow(row) {
  if (!row) return null;
  const data = (row.data && typeof row.data === 'object') ? row.data : {};
  return {
    ...data,
    id: row.id,
    company_id: row.company_id,
    created_at: toStrictIso(data.created_at || row.created_at || null),
    updated_at: toStrictIso(row.updated_at || null),
    version: row.version != null ? Number(row.version) : 0,
  };
}

function toSupabaseRow(domain) {
  if (!domain || !domain.id) return null;
  const { id, ...data } = domain;
  return {
    id,
    data,
    updated_at: new Date().toISOString(),
    version: domain.version != null ? Number(domain.version) + 1 : 1,
  };
}

async function request(table, params = {}, options = {}) {
  if (!isConfigured()) return null;
  const url = `${SUPABASE_URL}/rest/v1/${table}`;
  const headers = {
    apikey: SECRET_KEY,
    Authorization: `Bearer ${SECRET_KEY}`,
    'User-Agent': options.userAgent || 'supabase-canonical-repo/1',
  };
  try {
    const { data } = await axios.get(url, { params, headers, timeout: options.timeout || 10000 });
    return Array.isArray(data) ? data : null;
  } catch (err) {
    const status = err.response && err.response.status;
    const detail = err.response && err.response.data ? JSON.stringify(err.response.data) : '';
    console.warn(`[CanonicalRepo] ${table} read failed (${status || err.message}): ${detail}`);
    return null;
  }
}

async function getAll(table, filters = {}) {
  const rows = await request(table, filters);
  if (!rows || rows.length === 0) return [];
  return rows.map(fromSupabaseRow);
}

async function getAllStrict(table, filters = {}) {
  const rows = await request(table, filters);
  if (rows === null) {
    throw new Error(`Failed to read ${table} from Supabase (query returned no data)`);
  }
  return rows.map(fromSupabaseRow);
}

async function getById(table, id) {
  const rows = await request(table, { id: `eq.${id}`, limit: 1 });
  if (!rows || rows.length === 0) return null;
  return fromSupabaseRow(rows[0]);
}

async function upsert(table, domainObject) {
  if (!isConfigured()) {
    console.warn(`[CanonicalRepo] upsert(${table}): not configured`);
    return null;
  }
  if (!domainObject || !domainObject.id) {
    console.warn(`[CanonicalRepo] upsert(${table}): no id`);
    return null;
  }
  try {
    const result = await cloudSyncStore.upsertRow(table, domainObject.id, domainObject);
    if (result && result.id) {
      return getById(table, result.id);
    }
    return null;
  } catch (err) {
    console.warn(`[CanonicalRepo] ${table} upsert failed:`, err?.message || err);
    return null;
  }
}

async function softDelete(table, id) {
  if (!isConfigured()) return null;
  try {
    const result = await cloudSyncStore.softDeleteRow(table, id);
    if (result && result.id) {
      return getById(table, result.id);
    }
    return null;
  } catch (err) {
    console.warn(`[CanonicalRepo] ${table} softDelete failed:`, err?.message || err);
    return null;
  }
}

async function count(table, filters = {}) {
  if (!isConfigured()) return 0;
  try {
    const url = `${SUPABASE_URL}/rest/v1/${table}`;
    const headers = { ...adminHeaders(), Prefer: 'count=exact' };
    const { headers: respHeaders } = await axios.get(url, {
      params: { select: 'id', ...filters, limit: 1 },
      headers,
      timeout: 15000,
    });
    const contentRange = String(respHeaders?.['content-range'] || '0-0/0');
    const totalMatch = contentRange.split('/')[1];
    const total = Number(totalMatch);
    return Number.isFinite(total) ? total : 0;
  } catch {
    return 0;
  }
}

function buildEntityQueries(tables) {
  const queries = {};
  for (const table of tables) {
    const key = table;
    queries[key] = {
      getAll: (filters = {}) => getAll(table, filters),
      getById: (id) => getById(table, id),
      upsert: (record) => upsert(table, record),
      softDelete: (id) => softDelete(table, id),
    };
  }
  return queries;
}

const ENVELOPE_TABLES = [
  'accounts',
  'acceptance_runs',
  'assets',
  'audit_logs',
  'bank_accounts',
  'bank_adjustments',
  'bank_alerts',
  'bank_cash_flow_forecasts',
  'bank_categories',
  'bank_exchange_rates',
  'bank_fees',
  'bank_reconciliations',
  'bank_scheduled_payments',
  'bank_statements',
  'bank_transactions',
  'bom_default_materials',
  'bom_templates',
  'boms',
  'budgets',
  'cheques',
  'classes',
  'customer_notification_logs',
  'customer_referrals',
  'customer_payments',
  'customers',
  'delivery_notes',
  'departments',
  'documents',
  'employees',
  'engagement_affiliate_commissions',
  'engagement_affiliates',
  'engagement_analytics',
  'engagement_audit',
  'engagement_cashback',
  'engagement_customer_rewards',
  'engagement_customer_tiers',
  'engagement_gift_card_transactions',
  'engagement_gift_cards',
  'engagement_membership_tiers',
  'engagement_points',
  'engagement_point_balances',
  'engagement_promotions',
  'engagement_timeline',
  'examinations',
  'examination_batches',
  'examination_bom_calculations',
  'examination_batch_notifications',
  'examination_class_adjustments',
  'examination_classes',
  'examination_inventory_deductions',
  'examination_invoice_groups',
  'examination_job_subjects',
  'examination_jobs',
  'examination_papers',
  'examination_printing_batches',
  'examination_pricing_audit',
  'examination_recurring_profiles',
  'examination_subjects',
  'expenses',
  'financial_years',
  'goods_receipts',
  'income',
  'inventory',
  'inventory_movements',
  'inventory_transactions',
  'invoices',
  'job_orders',
  'job_tickets',
  'ledger_entries',
  'maintenance_logs',
  'market_adjustments',
  'market_adjustment_transactions',
  'material_batches',
  'material_categories',
  'material_reservations',
  'notification_audit_logs',
  'orders',
  'payroll_runs',
  'payslips',
  'payment_requests',
  'portal_notifications',
  'products',
  'product_variants',
  'products_variants',
  'production_batches',
  'production_resources',
  'profit_margin_settings',
  'purchase_orders',
  'quotations',
  'quotation_requests',
  'receipts',
  'recurring_invoices',
  'referral_analytics',
  'referral_audit_logs',
  'referral_campaigns',
  'referral_event_history',
  'referral_rewards',
  'referral_reversals',
  'referral_timeline',
  'reminders',
  'reprint_jobs',
  'resource_allocations',
  'rounding_logs',
  'sales',
  'sales_exchange_approvals',
  'sales_exchange_items',
  'sales_exchanges',
  'sales_orders',
  'scheduled_payments',
  'schools',
  'settings',
  'shipments',
  'sms_campaigns',
  'sms_templates',
  'subcontract_orders',
  'subscribers',
  'subjects',
  'support_tickets',
  'suppliers',
  'supplier_payments',
  'tasks',
  'tax_rates',
  'transfers',
  'user_groups',
  'user_preferences',
  'vat_transactions',
  'vat_returns',
  'warehouse_inventory',
  'warehouses',
  'wallet_transactions',
  'whatsapp_automations',
  'whatsapp_campaigns',
  'whatsapp_chats',
  'whatsapp_templates',
  'work_centers',
  'work_orders',
];

const entityQueries = buildEntityQueries(ENVELOPE_TABLES);

async function getAllFlat(table, filters = {}) {
  const rows = await request(table, filters);
  return rows || [];
}

async function getByIdFlat(table, id) {
  const rows = await request(table, { id: `eq.${id}`, limit: 1 });
  return rows?.[0] || null;
}

async function upsertFlat(table, record) {
  if (!isConfigured()) return null;
  const { id, ...data } = record;
  const row = { id, ...data, updated_at: new Date().toISOString() };
  try {
    const res = await axios.post(`${SUPABASE_URL}/rest/v1/${table}`, row, {
      headers: { ...adminHeaders(), Prefer: 'resolution=merge-duplicates,return=representation' },
      params: { on_conflict: 'id' },
      timeout: 20000,
    });
    return Array.isArray(res.data) ? (res.data[0] || null) : res.data;
  } catch (err) {
    console.warn(`[CanonicalRepo] ${table} upsertFlat failed:`, err?.message || err);
    return null;
  }
}

async function updateFlat(table, id, updates) {
  if (!isConfigured()) return null;
  try {
    const row = { ...updates, updated_at: new Date().toISOString() };
    const res = await axios.patch(`${SUPABASE_URL}/rest/v1/${table}`, row, {
      headers: { ...adminHeaders(), Prefer: 'return=representation' },
      params: { id: `eq.${id}` },
      timeout: 20000,
    });
    return Array.isArray(res.data) ? (res.data[0] || null) : res.data;
  } catch (err) {
    console.warn(`[CanonicalRepo] ${table} updateFlat failed:`, err?.message || err);
    return null;
  }
}

const portalEntities = {
  portal_users: {
    getAll: (filters = {}) => getAllFlat('portal_users', filters),
    getById: (id) => getByIdFlat('portal_users', id),
    getByEmail: (email) => getAllFlat('portal_users', { email: `eq.${email}`, limit: 1 }).then(rows => rows?.[0] || null),
    getByCustomerId: (customerId) => getAllFlat('portal_users', { customer_id: `eq.${customerId}`, limit: 1 }).then(rows => rows?.[0] || null),
    upsert: (record) => upsertFlat('portal_users', record),
    update: (id, updates) => updateFlat('portal_users', id, updates),
  },
  portal_sessions: {
    getAll: (filters = {}) => getAllFlat('portal_sessions', filters),
    getById: (id) => getByIdFlat('portal_sessions', id),
    upsert: (record) => upsertFlat('portal_sessions', record),
    update: (id, updates) => updateFlat('portal_sessions', id, updates),
  },
  portal_password_resets: {
    getAll: (filters = {}) => getAllFlat('portal_password_resets', filters),
    getById: (id) => getByIdFlat('portal_password_resets', id),
    upsert: (record) => upsertFlat('portal_password_resets', record),
    update: (id, updates) => updateFlat('portal_password_resets', id, updates),
  },
  portal_login_history: {
    getAll: (filters = {}) => getAllFlat('portal_login_history', filters),
    getById: (id) => getByIdFlat('portal_login_history', id),
    upsert: (record) => upsertFlat('portal_login_history', record),
  },
};

module.exports = {
  isConfigured,
  fromSupabaseRow,
  toSupabaseRow,
  request,
  getAll,
  getAllStrict,
  getById,
  upsert,
  softDelete,
  count,
  ...entityQueries,
  financialYears: entityQueries.financial_years,
  profitMarginSettings: entityQueries.profit_margin_settings,
  purchaseOrders: entityQueries.purchase_orders,
  goodsReceipts: entityQueries.goods_receipts,
  workCenters: entityQueries.work_centers,
  productionResources: entityQueries.production_resources,
  customerPayments: entityQueries.customer_payments,
  supplierPayments: entityQueries.supplier_payments,
  entities: entityQueries,
  getAllFlat,
  getByIdFlat,
  upsertFlat,
  updateFlat,
  portalEntities,
};

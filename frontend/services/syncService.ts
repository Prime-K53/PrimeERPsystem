import { supabase } from './supabaseClient';
import { dbService } from './db';
import { mergeRecords, fieldLevelMerge } from './syncConflictResolver';
import { durableSyncQueue, getLocalGeneration, setLocalGeneration } from './durableSyncQueue';
import { logger } from './logger';
import { initAudit, audit } from './syncAudit';
import {
  diagActiveSyncId,
  diagCaller,
  diagDashboardRefreshTriggered,
  diagNewSyncId,
  diagNextTimerGeneration,
  diagPeriodicLifecycleCall,
  diagPullTriggerInvoked,
  diagRequestCompleted,
  diagRequestFailed,
  diagRequestStarted,
  diagStageCompleted,
  diagStageFailed,
  diagStageStarted,
  diagTimerCleared,
  diagTimerFired,
  diagTimerReplaced,
  diagTimerScheduled,
} from './syncDiag';

// ---------------------------------------------------------------------------
// Cross-device sync notification helpers
// After writing a realtime payload to IndexedDB, we must tell the React layer
// (DataContext / Zustand stores) to re-read. Two channels are used so that
// both same-tab contexts and other tabs in the same browser are notified.
// ---------------------------------------------------------------------------

let _broadcastChannel: BroadcastChannel | null = null;

function getBroadcastChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!_broadcastChannel) {
    try {
      _broadcastChannel = new BroadcastChannel('primeerp-data-sync');
    } catch {
      return null;
    }
  }
  return _broadcastChannel;
}

/**
 * Emit a data-changed notification so that DataContext.queueRefresh() picks
 * it up and the React layer re-renders with the newly written IndexedDB data.
 */
function emitDataChanged(table: string, eventType: string) {
  if (typeof window === 'undefined') return;
  // [ERP-SYNC-DIAG] this event is the trigger DataContext.queueRefresh() listens to.
  diagDashboardRefreshTriggered('emit-data-changed', `${table}:${eventType}`);
  try {
    window.dispatchEvent(
      new CustomEvent('primeerp:data-changed', {
        detail: { source: 'realtime-sync', table, eventType }
      })
    );
  } catch { /* best-effort */ }
  try {
    getBroadcastChannel()?.postMessage({ type: 'data-changed', source: 'realtime-sync', table, eventType });
  } catch { /* best-effort */ }
}

const SUPABASE_ENABLED = Boolean(
  import.meta.env.VITE_SUPABASE_URL &&
  import.meta.env.VITE_SUPABASE_ANON_KEY &&
  import.meta.env.VITE_SUPABASE_URL !== 'https://placeholder.supabase.co'
);

const SUPABASE_HOST = (import.meta.env.VITE_SUPABASE_URL || '').replace(/^https?:\/\//, '').split('/')[0];
const SYNC_GATEWAY_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_URL) || '/api';

logger.info('[SyncService] supabase project', { host: SUPABASE_HOST, gateway: SYNC_GATEWAY_URL });

const PUSH_INTERVAL_MS = 60000;
const SYNC_CONCURRENCY = 6;
// Pull pages per table per pass. Keeps one pass bounded even for huge tables
// (e.g. a fresh install pulling 200k products), while still advancing the
// cursor so the NEXT pass continues instead of restarting the page.
const PULL_PAGE_SIZE = 2000;
const MAX_PULL_ROWS_PER_TABLE_PER_PASS = 50000;
let pushTimer: ReturnType<typeof setInterval> | null = null;
// Generation of the currently installed pull-timer interval instance.
// Incremented on every REAL setInterval creation. DEV-diag only.
let pullTimerGeneration = 0;
let realtimeSubscribed = false;
let realtimeChannels: any[] = [];
let subscriptionGeneration = 0; // incremented on each unsubscribe to cancel stale async inits
let syncLifecycleActive = false; // idempotency guard — prevents duplicate initial pulls / subscriptions

export interface SyncProgress {
  totalStores: number;
  completedStores: number;
  currentStore: string;
  phase: 'pull' | 'push' | 'done';
}

const STORE_TO_TABLE: Record<string, string> = {
  warehouses: 'warehouses',
  inventory: 'products',
  ledger: 'ledger_entries',
  batches: 'production_batches',
  resources: 'production_resources',
  workCenters: 'work_centers',
  workOrders: 'work_orders',
  salesOrders: 'sales_orders',
  userGroups: 'user_groups',
  bomTemplates: 'bom_templates',
  boms: 'boms',
  bankAccounts: 'bank_accounts',
  customerPayments: 'customer_payments',
  examinationBatches: 'examination_batches',
  auditLogs: 'audit_logs',
  goodsReceipts: 'goods_receipts',
  supplierPayments: 'supplier_payments',
  resourceAllocations: 'resource_allocations',
  profitMarginSettings: 'profit_margin_settings',
  marketAdjustments: 'market_adjustments',
  materialCategories: 'material_categories',
  taxRates: 'tax_rates',
  customerPricingTiers: 'customerpricingtiers',
  discountRules: 'discountrules',
  bankingAttachments: 'banking_attachments',
  statementSnapshots: 'statement_snapshots',
  // Fixed Assets — single-company, no tenant column
  fixedAssets: 'fixed_assets',
  depreciationEntries: 'depreciation_entries',
  assetDisposals: 'asset_disposals',
  fixedAssetLocations: 'fixed_asset_locations',
  fixedAssetCustodians: 'fixed_asset_custodians',
  fixedAssetTransfers: 'fixed_asset_transfers',
  fixedAssetRevaluations: 'fixed_asset_revaluations',
  fixedAssetImpairments: 'fixed_asset_impairments',
  fixedAssetMaintenance: 'fixed_asset_maintenance',
  fixedAssetWarranty: 'fixed_asset_warranty',
  fixedAssetInsurance: 'fixed_asset_insurance',
  fixedAssetVerification: 'fixed_asset_verification',
  fixedAssetReversals: 'fixed_asset_reversals',
  // Loans / Equity / Year-End — single-company, no tenant column
  loans: 'loans',
  loanRepayments: 'loan_repayments',
  ownerEquityTransactions: 'owner_equity_transactions',
  accrualEntries: 'accrual_entries',
  incomeSummaryEntries: 'income_summary_entries',
  // Service Catalog + Utilities sub-ledgers — single-company, no tenant column
  purchaseInvoices: 'purchase_invoices',
  interestIncomeEntries: 'interest_income_entries',
  prepayments: 'prepayments',
  prepaymentAmortizations: 'prepayment_amortizations',
  staffAdvances: 'staff_advances',
  utilityExpenses: 'utility_expenses',
  utilityPayments: 'utility_payments',
  bankChargeEntries: 'bank_charge_entries',
  payrollEntries: 'payroll_entries',
  serviceRecipes: 'service_recipes',
  serviceJobs: 'service_jobs',
  serviceResources: 'service_resources',
  serviceConsumptions: 'service_consumptions',
  warehouseInventory: 'warehouse_inventory',
  materialBatches: 'material_batches',
  inventoryTransactions: 'inventory_transactions',
  materialReservations: 'material_reservations',
  bankTransactions: 'bank_transactions',
  bankStatements: 'bank_statements',
  bankScheduledPayments: 'bank_scheduled_payments',
  bankExchangeRates: 'bank_exchange_rates',
  bankFees: 'bank_fees',
  bankReconciliations: 'bank_reconciliations',
  bankAdjustments: 'bank_adjustments',
  bankCashFlowForecasts: 'bank_cash_flow_forecasts',
  bankAlerts: 'bank_alerts',
  bankCategories: 'bank_categories',
  idempotencyKeys: 'idempotency_keys',
  customerNotificationLogs: 'customer_notification_logs',
  whatsappChats: 'whatsapp_chats',
  whatsappTemplates: 'whatsapp_templates',
  whatsappCampaigns: 'whatsapp_campaigns',
  whatsappAutomations: 'whatsapp_automations',
  vatTransactions: 'vat_transactions',
  vatReturns: 'vat_returns',
  roundingLogs: 'rounding_logs',
  examinationJobs: 'examination_jobs',
  examinationJobSubjects: 'examination_job_subjects',
  examinationInvoiceGroups: 'examination_invoice_groups',
  examinationRecurringProfiles: 'examination_recurring_profiles',
  examinationInventoryDeductions: 'examination_inventory_deductions',
  examinationBatchNotifications: 'examination_batch_notifications',
  smsCampaigns: 'sms_campaigns',
  smsTemplates: 'sms_templates',
  subcontractOrders: 'subcontract_orders',
  maintenanceLogs: 'maintenance_logs',
  jobTickets: 'job_tickets',
  jobTicketSettings: 'job_ticket_settings',
  jobOrders: 'job_orders',
  examJobs: 'examination_jobs',
  examPapers: 'examination_papers',
   examPrintingBatches: 'examination_printing_batches',
   assessmentContracts: 'assessment_contracts',
   contractAssessments: 'assessment_contract_items',
   contractAmendments: 'contract_amendments',
   salesExchanges: 'sales_exchanges',
  salesExchangeItems: 'sales_exchange_items',
  reprintJobs: 'reprint_jobs',
  salesExchangeApprovals: 'sales_exchange_approvals',
  marketAdjustmentTransactions: 'market_adjustment_transactions',
  notificationAuditLogs: 'notification_audit_logs',
  classes: 'classes',
  subjects: 'subjects',
  recurringInvoices: 'recurring_invoices',
  scheduledPayments: 'scheduled_payments',
  walletTransactions: 'wallet_transactions',
  deliveryNotes: 'delivery_notes',
  payrollRuns: 'payroll_runs',
  expenses: 'expenses',
  income: 'income',
  budgets: 'budgets',
  transfers: 'transfers',
  cheques: 'cheques',
  employees: 'employees',
  payslips: 'payslips',
  subscribers: 'subscribers',
  shipments: 'shipments',
  schools: 'schools',
  financialYears: 'financial_years',
  userPreferences: 'user_preferences',
  tasks: 'tasks',
  portalAds: 'portal_ads',
  engagementPromotions: 'engagement_promotions',
  purchaseOrders: 'purchase_orders',
  // Referral program (single-company envelope tables, no tenant scoping).
  // referralAnalytics is intentionally excluded: snapshots are derived
  // per-device with generated ids. referralEventHistory is excluded: it has
  // no writers and no live cloud table.
  referrals: 'customer_referrals',
  referralRewards: 'referral_rewards',
  referralTimeline: 'referral_timeline',
  referralAuditLogs: 'referral_audit_logs',
  referralCampaigns: 'referral_campaigns',
  referralReversals: 'referral_reversals',
};

const TABLES_TO_SYNC = [
  'userGroups', 'inventory', 'warehouses', 'customers', 'suppliers',
  'sales', 'invoices', 'purchases', 'accounts', 'ledger',
  'settings', 'reminders',
  'workCenters', 'workOrders', 'batches', 'resources',
  'salesOrders', 'quotations', 'orders',
  'jobOrders', 'salesExchanges', 'reprintJobs',
  'examinationBatches', 'examinationJobs',
  'bomTemplates', 'boms', 'profitMarginSettings', 'marketAdjustments',
  'bankAccounts', 'bankTransactions', 'bankStatements',
  'customerPayments', 'supplierPayments', 'goodsReceipts',
   'recurringInvoices', 'scheduledPayments', 'walletTransactions',
   'assessmentContracts', 'contractAssessments', 'contractAmendments',
   'deliveryNotes', 'payrollRuns',
  'vatTransactions', 'vatReturns', 'roundingLogs',
  'expenses', 'income', 'budgets', 'transfers', 'cheques',
  'employees', 'payslips',
  'materialCategories', 'warehouseInventory', 'materialBatches',
  'inventoryTransactions', 'materialReservations',
  'jobTickets', 'jobTicketSettings', 'resourceAllocations',
  'examinationJobSubjects', 'examinationInvoiceGroups',
  'examinationRecurringProfiles', 'examinationInventoryDeductions',
  'examinationBatchNotifications',
  'examPapers', 'examPrintingBatches',
  'salesExchangeItems', 'salesExchangeApprovals',
  'subcontractOrders', 'maintenanceLogs', 'classes', 'subjects',
  'subscribers', 'shipments', 'schools', 'tasks',
  'financialYears',
  'userPreferences',
  'bankScheduledPayments', 'bankExchangeRates', 'bankFees',
  'bankReconciliations', 'bankAdjustments', 'bankCashFlowForecasts',
  'bankAlerts', 'bankCategories',
  'smsCampaigns', 'smsTemplates',
  'marketAdjustmentTransactions', 'notificationAuditLogs',
  'whatsappChats', 'whatsappTemplates', 'whatsappCampaigns', 'whatsappAutomations',
  'taxRates',
  'customerPricingTiers',
  'discountRules',
  'bankingAttachments',
  'statementSnapshots',
  // Fixed Assets — single-company, no tenant column (pull + realtime)
  'fixedAssets', 'depreciationEntries', 'assetDisposals',
  'fixedAssetLocations', 'fixedAssetCustodians', 'fixedAssetTransfers',
  'fixedAssetRevaluations', 'fixedAssetImpairments', 'fixedAssetMaintenance',
  'fixedAssetWarranty', 'fixedAssetInsurance', 'fixedAssetVerification', 'fixedAssetReversals',
  // Loans / Equity / Year-End — single-company, no tenant column
  'loans', 'loanRepayments', 'ownerEquityTransactions', 'accrualEntries', 'incomeSummaryEntries',
  // Service Catalog + Utilities sub-ledgers — single-company, no tenant column
  'purchaseInvoices', 'interestIncomeEntries', 'prepayments', 'prepaymentAmortizations',
  'staffAdvances', 'utilityExpenses', 'utilityPayments', 'bankChargeEntries', 'payrollEntries',
  'serviceRecipes', 'serviceJobs', 'serviceResources', 'serviceConsumptions',
  'customerNotificationLogs',
  'portalAds',
  // Single-company: canonical purchase orders + legacy exam alias + promotions
  'purchaseOrders', 'examJobs', 'engagementPromotions',
  // Referral program — authoritative + history stores (see STORE_TO_TABLE note).
  'referrals', 'referralRewards', 'referralTimeline',
  'referralAuditLogs', 'referralCampaigns', 'referralReversals',
];

const getTable = (storeName: string): string => STORE_TO_TABLE[storeName] || storeName;

const toCloudRecord = (record: any) => {
  const { data: jsonData, updated_at, ...rest } = record;
  const serverUpdatedAt = typeof updated_at === 'string' ? updated_at : undefined;
  return {
    id: record.id,
    ...rest,
    ...(jsonData || {}),
    ...(serverUpdatedAt ? { updated_at: serverUpdatedAt, _updatedAt: serverUpdatedAt, serverUpdatedAt } : {}),
    _cloudSource: true,
  };
};

async function ensureSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  try {
    const { data: { session: refreshed } } = await supabase.auth.refreshSession();
    if (refreshed) return refreshed;
  } catch {
    // Refresh token expired or invalid — skip sync, fall back to local
  }
  return null;
}

const LAST_SYNC_META_PREFIX = 'last_synced_at:';

/**
 * Get the last successful sync timestamp for a given table
 */
async function getLastSyncAt(table: string): Promise<string | null> {
  try {
    const val = await durableSyncQueue.getMeta(`${LAST_SYNC_META_PREFIX}${table}`);
    return val as string | null;
  } catch {
    return null;
  }
}

/**
 * Save the last successful sync timestamp for a given table
 */
async function setLastSyncAt(table: string, timestamp: string): Promise<void> {
  await durableSyncQueue.setMeta(`${LAST_SYNC_META_PREFIX}${table}`, timestamp);
}

// Local stores whose rows predate referral sync enrollment. Their original
// queue operations were dead-lettered while the gateway allow-list excluded
// referral tables, so nothing would ever re-upload them on its own.
const REFERRAL_BACKFILL_STORES = [
  'referrals',
  'referralRewards',
  'referralTimeline',
  'referralAuditLogs',
  'referralCampaigns',
  'referralReversals',
] as const;

const REFERRAL_BACKFILL_META_KEY = 'referral_backfill_v1_done';

/**
 * One-time, idempotent backfill: re-put every existing row of the referral
 * stores through the normal dbService.put path. Ids and domain fields are
 * preserved untouched; the put only refreshes the local sync stamp and
 * enqueues a standard `upsert` op (same mechanism as any local edit, fully
 * covered by the gateway's id-by-id upsert, idempotency keys, and OCC
 * version gate — replays can never duplicate rows).
 *
 * Runs at most once per device (durable meta flag). Rows that already have
 * a pending mutation are skipped to avoid double-enqueue.
 */
export async function backfillReferralStoresOnce(): Promise<{ requeued: number }> {
  try {
    if (!SUPABASE_ENABLED) return { requeued: 0 };
    const done = await durableSyncQueue.getMeta(REFERRAL_BACKFILL_META_KEY).catch(() => null);
    if (done) return { requeued: 0 };
    let requeued = 0;
    for (const storeName of REFERRAL_BACKFILL_STORES) {
      const rows = await dbService.getAll(storeName as never).catch(() => []);
      for (const row of (rows || []) as Array<Record<string, unknown>>) {
        const id = String(row?.id || '');
        if (!id) continue;
        const pending = await durableSyncQueue
          .hasPendingMutation(getTable(storeName), id)
          .catch(() => false);
        if (pending) continue;
        await dbService.put(storeName as never, row as never);
        requeued += 1;
      }
    }
    await durableSyncQueue.setMeta(REFERRAL_BACKFILL_META_KEY, '1').catch(() => {});
    logger.info('[SyncService] referral backfill complete', { requeued });
    return { requeued };
  } catch (err) {
    logger.warn('[SyncService] referral backfill failed — will retry on next start', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { requeued: 0 };
  }
}

/**
 * Pull data from Supabase into local IndexedDB cache using incremental sync.
 * Only fetches rows updated since last sync per table.
 * Falls back to full sync if no prior sync exists.
 */
export async function pullRemoteChanges(
  onProgress?: (progress: SyncProgress) => void,
  forceFullSync: boolean = false
): Promise<{ pulled: number; errors: string[] }> {
  if (!SUPABASE_ENABLED) {
    /* SYNC-FORENSIC suppressed: pullRemoteChanges() SKIPPED — Supabase not enabled */
    return { pulled: 0, errors: [] };
  }

  const session = await ensureSession();
  if (!session) {
    /* SYNC-FORENSIC suppressed: pullRemoteChanges() SKIPPED — not authenticated */
    return { pulled: 0, errors: ['Not authenticated'] };
  }

  /* SYNC-FORENSIC suppressed: PULL-START pullRemoteChanges() */
  // [ERP-SYNC-DIAG] pull (Supabase → IndexedDB) is a real sync stage: Device B
  // needs it to see other devices' changes. Timed with existing boundaries only.
  const diagPullId = diagNewSyncId();
  const diagPullStart = performance.now();
  diagStageStarted(diagActiveSyncId() ?? diagPullId, 'pull-supabase', {
    runId: diagPullId,
    forceFullSync: forceFullSync,
  });
  const errors: string[] = [];
  let pulled = 0;
  const totalStores = TABLES_TO_SYNC.length;
  let completedStores = 0;

  for (let i = 0; i < totalStores; i += SYNC_CONCURRENCY) {
    const batch = TABLES_TO_SYNC.slice(i, i + SYNC_CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map(async (storeName) => {
        const table = getTable(storeName);
        let storeCount = 0;

        try {
          // Incremental sync: only fetch rows updated since last sync.
          // Rows are paged so a table with more updated rows than the gateway's
          // single-request limit still fully converges instead of truncating.
          const pageSize = PULL_PAGE_SIZE;
          let offset = 0;
          let lastTimestamp: string | null = null;
          let rowsInPass = 0;

          while (rowsInPass < MAX_PULL_ROWS_PER_TABLE_PER_PASS) {
            let query = supabase.from(table).select('*');

            // Incremental sync: only fetch rows updated since last sync
            if (!forceFullSync) {
              const lastSyncAt = await getLastSyncAt(table);
              if (lastSyncAt) {
                query = query.gte('updated_at', lastSyncAt);
              }
            }

            const { data, error } = await query
              .order('updated_at', { ascending: true })
              .range(offset, offset + pageSize - 1);

            if (error) { errors.push(`${storeName}: ${error.message}`); break; }
            if (!data || data.length === 0) break;

            const cloudRecords = data.map((record: any) => toCloudRecord(record));

            /* SYNC-FORENSIC suppressed: PULL-PAGE */

            // Apply field-level merge for existing records, skip for new ones
            // All cloud records are marked _cloudSource: true so they don't trigger re-sync
            const mergedRecords = [];
            for (const cloudRecord of cloudRecords) {
              // Server-side tombstone (soft delete via the sync gateway):
              // reconcile locally as a delete, never resurrect the row.
              if (cloudRecord.deleted === true) {
                const existing = await dbService.get(storeName, cloudRecord.id);
                if (existing && !(existing as Record<string, unknown>).deletedAt) {
                  await dbService.delete(storeName, cloudRecord.id, { cloudSource: true });
                }
                continue;
              }
              const existing = await dbService.get(storeName, cloudRecord.id);
              if (existing) {
                const pendingMutation = await durableSyncQueue.hasPendingMutation(table, cloudRecord.id);
                if (pendingMutation) {
                  /* SYNC-FORENSIC suppressed: PULL-SKIP-MERGE */
                  continue;
                }
                const merged = fieldLevelMerge(existing, cloudRecord);
                if (cloudRecord.serverUpdatedAt) {
                  merged.serverUpdatedAt = cloudRecord.serverUpdatedAt;
                }
                merged._cloudSource = true;
                await dbService.put(storeName, merged, { cloudSource: true });
              } else {
                mergedRecords.push(cloudRecord as Record<string, unknown>);
              }
            }
            if (mergedRecords.length > 0) {
              await dbService.bulkPut(storeName, mergedRecords);
            }

            storeCount += cloudRecords.length;
            rowsInPass += cloudRecords.length;
            audit('pull', 'table page processed', { table, pageRows: cloudRecords.length, offset });
            // Track the latest updated_at seen so far for incremental sync
            lastTimestamp = data[data.length - 1]?.updated_at ?? lastTimestamp;

            // Reached the last page for this table — persist the cursor and stop.
            if (data.length < pageSize) break;
            offset += data.length;
          }

          // Persist the final cursor for incremental sync. When a pass was cut
          // short by the pass cap, the cursor still advances to where we stopped,
          // so the next periodic pass resumes from just past the last page.
          if (lastTimestamp) {
            await setLastSyncAt(table, lastTimestamp);
          }
          audit('pull', 'table complete', { table, storeCount, errors: errors.filter(e => e.startsWith(`${storeName}:`)) });

        } catch (err) {
          errors.push(`${storeName}: ${err instanceof Error ? err.message : 'Unknown'}`);
        }

        return storeCount;
      })
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        pulled += result.value;
      }
    }

    completedStores += batch.length;
    onProgress?.({
      totalStores,
      completedStores,
      currentStore: batch[batch.length - 1] || '',
      phase: 'pull',
    });
  }

  if (pulled > 0) {
    localStorage.setItem('nexus_last_sync_pull', new Date().toISOString());
    // Notify the React layer that IndexedDB has been updated via pull.
    // DataContext listens to this event and calls queueRefresh() → refreshAllData()
    // → Zustand stores re-read IndexedDB and re-render. Without this, pulled data
    // would not be visible in the UI until the next periodic poll (5 min) or a
    // realtime event (which may never arrive if channels timeout).
    emitDataChanged('inventory', 'PULL_COMPLETE');
    emitDataChanged('warehouses', 'PULL_COMPLETE');
  }

  /* SYNC-FORENSIC suppressed: PULL-COMPLETE pullRemoteChanges() */
  if (errors.length > 0) {
    diagStageFailed(diagActiveSyncId() ?? diagPullId, 'pull-supabase', 'pull-errors', {
      runId: diagPullId,
      pulled,
      errorCount: errors.length,
    });
  } else {
    diagStageCompleted(diagActiveSyncId() ?? diagPullId, 'pull-supabase', performance.now() - diagPullStart, {
      runId: diagPullId,
      pulled,
    });
  }
  return { pulled, errors };
}

/**
 * Subscribe to real-time changes from Supabase.
 * When another device makes a change, it's pushed to all connected clients.
 *
 * FIX (Bug #1): After each IndexedDB write we now dispatch `primeerp:data-changed`
 * and a BroadcastChannel message so that DataContext.queueRefresh() fires and
 * the React/Zustand stores pick up the new data immediately.
 */
async function subscribeToRemoteChanges() {
  if (!SUPABASE_ENABLED || realtimeSubscribed) {
    /* SYNC-FORENSIC suppressed: subscribeToRemoteChanges() SKIPPED */
    return;
  }
  /* SYNC-FORENSIC suppressed: subscribeToRemoteChanges() START */
  realtimeSubscribed = true;
  const myGeneration = ++subscriptionGeneration;

  for (const storeName of TABLES_TO_SYNC) {
    if (!realtimeSubscribed || subscriptionGeneration !== myGeneration) break; // Race guard: abort if unsubscribed or superseded
    const table = getTable(storeName);

    try {
      const changeFilter: Record<string, string> = { event: '*', schema: 'public', table };
      const channelName = `primeerp:${table}`;

      const channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes' as const,
          changeFilter,
          async (payload: any) => {
            try {
              const eventType: string = payload.eventType || 'UNKNOWN';
              /* SYNC-FORENSIC suppressed: REALTIME event received */

              if (eventType === 'DELETE') {
                const deleteId = payload.old?.id;
                if (!deleteId) {
                  logger.warn(`[Sync] realtime DELETE ${table}: payload.old.id missing — skipping`, payload.old);
                } else {
                  try {
                    await dbService.delete(storeName, deleteId, { cloudSource: true });
                    logger.info(`[Sync] realtime DELETE ${table} id=${deleteId} → dispatching data-changed`);
                    emitDataChanged(table, 'DELETE');
                  } catch (e) { logger.error('Realtime DELETE failed', e as Error); }
                }

              } else if (payload.new) {
                const cloudRecord = toCloudRecord(payload.new);

                // Server-side tombstone arrives as an UPDATE (soft delete):
                // delete locally and skip the merge so the row isn't resurrected.
                if (cloudRecord.deleted === true) {
                  try {
                    await dbService.delete(storeName, payload.new.id, { cloudSource: true });
                    emitDataChanged(table, 'SOFT_DELETE');
                  } catch (e) { logger.error('Realtime soft-delete failed', e as Error); }
                  return;
                }

                const local = await dbService.get(storeName, payload.new.id);
                if (local) {
                  const pendingMutation = await durableSyncQueue.hasPendingMutation(table, payload.new.id);
                  if (pendingMutation) {
                    /* SYNC-FORENSIC suppressed: REALTIME-SKIP-MERGE */
                    return;
                  }
                  const merged = fieldLevelMerge(local, cloudRecord);
                  if (cloudRecord.serverUpdatedAt) {
                    merged.serverUpdatedAt = cloudRecord.serverUpdatedAt;
                  }
                  merged._cloudSource = true;
                  /* SYNC-FORENSIC suppressed: REALTIME MERGE */
                  await dbService.put(storeName, merged as Record<string, unknown>, { cloudSource: true });
                } else {
                  /* SYNC-FORENSIC suppressed: REALTIME NEW */
                  await dbService.put(storeName, cloudRecord as Record<string, unknown>, { cloudSource: true });
                }

                // ── FIX Bug #1 ───────────────────────────────────────────────
                // Notify the React layer that IndexedDB has been updated.
                // DataContext listens to both signals and calls queueRefresh(),
                // which triggers refreshAllData() → Zustand stores re-read IDB
                // and re-render. Without this, Device B's UI never updates.
                logger.info(`[Sync] realtime ${eventType} ${table} → dispatching data-changed`);
                emitDataChanged(table, eventType);
              }
            } catch {
              // best-effort realtime sync
            }
          }
        )
        .subscribe((status: string) => {
          if (status === 'SUBSCRIBED') {
            audit('realtime', 'channel subscribed', { table });
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            logger.warn(`[Sync] realtime channel ${channelName} status=${status} — will rely on polling`);
          }
        });

      realtimeChannels.push(channel);
    } catch {
      // best-effort subscription setup
    }
  }
}

function unsubscribeFromRemoteChanges() {
  subscriptionGeneration++; // invalidate any in-flight subscribeToRemoteChanges call
  for (const channel of realtimeChannels) {
    try { supabase.removeChannel(channel); } catch { /* skip */ }
  }
  realtimeChannels = [];
  realtimeSubscribed = false;
  if (_broadcastChannel) {
    try { _broadcastChannel.close(); } catch { /* skip */ }
    _broadcastChannel = null;
  }
}

const API_BASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE_URL) || '';

export async function fetchServerGeneration(): Promise<number | null> {
  if (!API_BASE_URL) return null;
  try {
    const { getSyncAccessToken } = await import('./syncApiClient');
    const token = await getSyncAccessToken();
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    // [ERP-SYNC-DIAG] safe metadata only — no headers/tokens/bodies logged.
    const diagGenStart = diagRequestStarted('GET', '/sync/generation', { kind: 'sync' });
    try {
      const res = await fetch(`${API_BASE_URL}/sync/generation`, { headers, signal: controller.signal });
      if (!res.ok) {
        diagRequestFailed('GET', '/sync/generation', diagGenStart, `http-${res.status}`, { kind: 'sync' });
        return null;
      }
      const data = await res.json() as { ok?: boolean; generation?: number };
      diagRequestCompleted('GET', '/sync/generation', diagGenStart, res.status, { kind: 'sync' });
      return (data?.ok && Number.isFinite(data?.generation)) ? data.generation : null;
    } catch {
      diagRequestFailed('GET', '/sync/generation', diagGenStart, 'transport-error', { kind: 'sync' });
      throw new Error('generation-fetch-transport-error');
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

export async function handleGenerationMismatch(serverGeneration: number): Promise<void> {
  const localGen = getLocalGeneration();
  if (localGen >= serverGeneration) return;
  logger.warn(`[Sync] Generation mismatch: local=${localGen} server=${serverGeneration} — invalidating queue and clearing local data`);
  audit('sync', 'generation_mismatch', { localGen, serverGeneration });

  try {
    const { backgroundSyncService } = await import('./backgroundSyncService');
    backgroundSyncService.stopPeriodicSync();
  } catch {}

  await durableSyncQueue.destroy();

  try {
    const { deleteDB } = await import('idb');
    await deleteDB('PrimeERP_Final_v3_Clean').catch(() => {});
    for (const name of ['PrimeERP_Production_v1', 'PrimeERP_Legacy_v1', 'PrimeERP_v2']) {
      await deleteDB(name).catch(() => {});
    }
  } catch {}

  const syncKeys = ['nexus_last_sync_pull', 'nexus_initialized'];
  for (const key of syncKeys) {
    try { localStorage.removeItem(key); } catch {}
  }

  setLocalGeneration(serverGeneration);
}

export async function startPeriodicSync(
  intervalMs = PUSH_INTERVAL_MS,
  onSyncComplete?: (result: { pulled: number; pushed: number; errors: string[] }) => void
) {
  // [ERP-SYNC-DIAG] lifecycle entry only — who called, no behavior change.
  const diagStartCaller = diagCaller('startPeriodicSync');
  if (!SUPABASE_ENABLED) {
    diagPeriodicLifecycleCall('syncService', 'start', 'skipped', diagStartCaller, 'supabase-not-enabled');
    logger.warn('[SyncService] startPeriodicSync SKIPPED — SUPABASE_ENABLED=false');
    return;
  }

  // ── Lifecycle ownership ──────────────────────────────────────────────────
  // AuthContext intentionally calls startPeriodicSync() from several startup
  // paths (cold boot, SIGNED_IN auth event, login(), the user-transition
  // safety net) so a single missed timing window can never leave the app
  // without a sync engine. That makes "already active" an EXPECTED, idempotent
  // no-op rather than a problem — so it is logged at info level, not warn.
  //
  // The lifecycle flag is claimed SYNCHRONOUSLY before any await. If it were
  // set after the fetchServerGeneration() gap below, two overlapping calls
  // could both pass the guard and create duplicate realtime subscriptions and
  // duplicate pull timers.
  if (syncLifecycleActive) {
    diagPeriodicLifecycleCall('syncService', 'start', 'skipped', diagStartCaller, 'lifecycle-already-active');
    logger.info('[SyncService] startPeriodicSync SKIPPED — lifecycle already active (idempotent, no duplicate timers created)');
    return;
  }
  syncLifecycleActive = true;
  diagPeriodicLifecycleCall('syncService', 'start', 'started', diagStartCaller);

  logger.info('[SyncService] startPeriodicSync starting', { intervalMs, supabaseEnabled: SUPABASE_ENABLED });

  // Generation handshake before the periodic engine starts. If the server
  // generation moved past ours the local queue/data are stale and are
  // invalidated first. A failure here must not permanently wedge the
  // lifecycle flag (the periodic engine still needs to start), so it is
  // contained and the sync loop is allowed to continue.
  try {
    if (navigator.onLine) {
      const serverGen = await fetchServerGeneration();
      if (serverGen !== null) {
        await handleGenerationMismatch(serverGen);
      }
    }
  } catch (genErr) {
    logger.warn('[SyncService] generation handshake failed — continuing with periodic sync', {
      error: genErr instanceof Error ? genErr.message : String(genErr),
    });
  }

  subscribeToRemoteChanges().catch((err) => {
    logger.warn('[Sync] subscribeToRemoteChanges failed, falling back to polling:', err);
  });

  // One-time referral backfill (idempotent, guarded internally). Requeues
  // pre-enrollment local referral rows so Device-A-style records created
  // before referral sync existed still reach Supabase through the normal
  // push path. Fire-and-forget: must never block engine startup.
  backfillReferralStoresOnce().catch(() => {});

  const { backgroundSyncService } = await import('./backgroundSyncService');
  logger.info('[SyncService] calling backgroundSyncService.start()');
  // Thread the configured interval through so the background push timer uses
  // the normal 60s configuration instead of the backoff fallback (15s base).
  backgroundSyncService.start(intervalMs);
  logger.info('[SyncService] backgroundSyncService.start() called');

  // Periodic pull (incremental sync) - 30 second interval for catching missed realtime events.
  // This pull timer is INDEPENDENT of the 60s background push timer
  // (backgroundSyncService): push drains the local outbox via POST
  // /api/sync/ops, pull fetches Supabase rows into IndexedDB.
  const pullIntervalMs = Math.min(intervalMs, 30000);
  pullTimerGeneration = diagNextTimerGeneration('pull');
  const diagPullGeneration = pullTimerGeneration;
  pushTimer = setInterval(async () => {
    // [ERP-SYNC-DIAG] real pull-timer fire only — decision logic unchanged.
    diagTimerFired('pull', 'syncService', pullIntervalMs, diagPullGeneration);
    diagPullTriggerInvoked('pull-timer');
    if (navigator.onLine) {
      const result = await pullRemoteChanges().catch(() => ({ pulled: 0, errors: [] }));
    }
  }, pullIntervalMs);
  // [ERP-SYNC-DIAG] real interval creation only — value unchanged.
  diagTimerScheduled('pull', 'syncService', pullIntervalMs, diagPullGeneration);

  // Initial sync on start - full pull on first sync, then incremental
  if (navigator.onLine) {
    const isFirstSync = !localStorage.getItem('nexus_last_sync_pull');
    /* SYNC-FORENSIC suppressed: startPeriodicSync() initial pull decision */
    audit('sync', 'initial pull starting', { isFirstSync });
    diagPullTriggerInvoked('initial-pull');
    pullRemoteChanges(undefined, isFirstSync).then(result => {
      /* SYNC-FORENSIC suppressed: startPeriodicSync() initial pull COMPLETE */
      audit('sync', 'initial pull complete', { pulled: result.pulled, errors: result.errors });
      onSyncComplete?.({ pulled: result.pulled, pushed: 0, errors: result.errors });
    }).catch(err => console.warn('[Sync] Initial pull failed:', err));
  } else {
    /* SYNC-FORENSIC suppressed: startPeriodicSync() initial pull SKIPPED — offline */
    audit('sync', 'initial pull skipped offline', {});
    onSyncComplete?.({ pulled: 0, pushed: 0, errors: ['offline'] });
  }
}

export function stopPeriodicSync() {
  // [ERP-SYNC-DIAG] lifecycle entry only — who called, no behavior change.
  diagPeriodicLifecycleCall('syncService', 'stop', 'stopped', diagCaller('stopPeriodicSync'));
  if (pushTimer) {
    clearInterval(pushTimer);
    // [ERP-SYNC-DIAG] real clear only — same clear as before.
    diagTimerCleared('pull', 'syncService', pullTimerGeneration, 'stopPeriodicSync');
    pushTimer = null;
  }
  syncLifecycleActive = false;
  unsubscribeFromRemoteChanges();
  import('./backgroundSyncService').then(({ backgroundSyncService }) => {
    backgroundSyncService.stopPeriodicSync();
  }).catch(() => {});
}

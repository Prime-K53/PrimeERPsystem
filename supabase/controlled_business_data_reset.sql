/*
  ============================================================================
  Prime ERP — Controlled Supabase Business-Data Reset
  STATUS: GENERATED ONLY — NOT EXECUTED
  MANUAL REVIEW REQUIRED BEFORE ANY EXECUTION
  ============================================================================

  Purpose:
    Physically DELETE all approved ERP business data from the Supabase public
    schema while preserving system, authentication, configuration, portal-state,
    synchronization-control, and other explicitly protected tables.

 _SCOPE BASIS_:
    - supabase/migrations/0001_baseline_live_schema.sql (159 tables, live schema)
    - supabase/migrations/0006_reconcile_referral_schema.sql (referral tables)
    - supabase/migrations/0008_payment_requests.sql (payment_requests table)
    - Approved CLEAR list from the READ-ONLY reset audit
    - PRESERVE/REVIEW exclusions as specified

  METHOD:
    - Explicit DELETE FROM public.<table_name> for each approved CLEAR table
    - NO dynamic table discovery (NO information_schema enumeration)
    - NO TRUNCATE of the public schema
    - NO DROP TABLE / DROP SCHEMA
    - NO CASCADE
    - NO wildcard/pattern matching
    - Transaction-protected: BEGIN ... COMMIT

  UPDATE (2026-09-04): After live database verification, 5 previously-unresolved
  tables were confirmed to exist and be empty. They have been added to the
  DELETE list as no-op operations. The remaining REVIEW tables (audit_logs,
  notification_audit_logs) are still NOT deleted.

  TOMBSTONE STRATEGY:
    The ERP uses soft-delete (data.deleted, data.deletedAt) for envelope tables.
    For a FULL clean-state reset, this script PREFERS PHYSICAL DELETION of all
    approved business rows rather than creating thousands of tombstones.
    Rationale: a full reset should leave tables empty, not filled with tombstone
    records that would need separate purge later.

    NOTE: The financial-integrity triggers (0013_financial_integrity.sql) fire
    on INSERT/UPDATE, not on DELETE, so physical DELETE does not corrupt them.
    The payment_allocation_lines trigger (trg_pal_invoice_touch_del) fires a
    no-op UPDATE on invoices when lines are deleted — harmless during a full reset.

  SYNC GENERATION:
    This script does NOT modify sync_generation. The sync_generation row in
    public.settings (id='sync_generation') is preserved.
    The sync generation increment is a SEPARATE step (POST /api/sync/reset)
    that must be performed AFTER this cleanup, not inside it.

  PRE-FLIGHT:  read-only row counts for every targeted table
  POST-FLIGHT: verification that CLEAR tables are empty and PRESERVE tables intact
  ============================================================================
*/

BEGIN;

-- ============================================================================
-- PRE-FLIGHT: row counts for every CLEAR table (read-only, no data changed)
-- ============================================================================

SELECT 'PRE-FLIGHT' AS phase, 'accounts'            AS table_name, count(*)::bigint AS row_count FROM public.accounts;
SELECT 'PRE-FLIGHT' AS phase, 'assets'              AS table_name, count(*)::bigint AS row_count FROM public.assets;
SELECT 'PRE-FLIGHT' AS phase, 'bank_accounts'       AS table_name, count(*)::bigint AS row_count FROM public.bank_accounts;
SELECT 'PRE-FLIGHT' AS phase, 'bank_adjustments'    AS table_name, count(*)::bigint AS row_count FROM public.bank_adjustments;
SELECT 'PRE-FLIGHT' AS phase, 'bank_alerts'         AS table_name, count(*)::bigint AS row_count FROM public.bank_alerts;
SELECT 'PRE-FLIGHT' AS phase, 'bank_cash_flow_forecasts' AS table_name, count(*)::bigint AS row_count FROM public.bank_cash_flow_forecasts;
SELECT 'PRE-FLIGHT' AS phase, 'bank_exchange_rates' AS table_name, count(*)::bigint AS row_count FROM public.bank_exchange_rates;
SELECT 'PRE-FLIGHT' AS phase, 'bank_fees'           AS table_name, count(*)::bigint AS row_count FROM public.bank_fees;
SELECT 'PRE-FLIGHT' AS phase, 'bank_reconciliations' AS table_name, count(*)::bigint AS row_count FROM public.bank_reconciliations;
SELECT 'PRE-FLIGHT' AS phase, 'bank_scheduled_payments' AS table_name, count(*)::bigint AS row_count FROM public.bank_scheduled_payments;
SELECT 'PRE-FLIGHT' AS phase, 'bank_statements'     AS table_name, count(*)::bigint AS row_count FROM public.bank_statements;
SELECT 'PRE-FLIGHT' AS phase, 'bank_transactions'   AS table_name, count(*)::bigint AS row_count FROM public.bank_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'bom_default_materials' AS table_name, count(*)::bigint AS row_count FROM public.bom_default_materials;
SELECT 'PRE-FLIGHT' AS phase, 'bom_templates'       AS table_name, count(*)::bigint AS row_count FROM public.bom_templates;
SELECT 'PRE-FLIGHT' AS phase, 'boms'                AS table_name, count(*)::bigint AS row_count FROM public.boms;
SELECT 'PRE-FLIGHT' AS phase, 'budgets'             AS table_name, count(*)::bigint AS row_count FROM public.budgets;
SELECT 'PRE-FLIGHT' AS phase, 'cheques'             AS table_name, count(*)::bigint AS row_count FROM public.cheques;
SELECT 'PRE-FLIGHT' AS phase, 'chart_of_accounts'   AS table_name, count(*)::bigint AS row_count FROM public.chart_of_accounts;
SELECT 'PRE-FLIGHT' AS phase, 'classes'             AS table_name, count(*)::bigint AS row_count FROM public.classes;
SELECT 'PRE-FLIGHT' AS phase, 'customer_notification_logs' AS table_name, count(*)::bigint AS row_count FROM public.customer_notification_logs;
SELECT 'PRE-FLIGHT' AS phase, 'customer_payments'   AS table_name, count(*)::bigint AS row_count FROM public.customer_payments;
SELECT 'PRE-FLIGHT' AS phase, 'customer_referrals'  AS table_name, count(*)::bigint AS row_count FROM public.customer_referrals;
SELECT 'PRE-FLIGHT' AS phase, 'customerpricingtiers' AS table_name, count(*)::bigint AS row_count FROM public.customerpricingtiers;
SELECT 'PRE-FLIGHT' AS phase, 'customers'           AS table_name, count(*)::bigint AS row_count FROM public.customers;
SELECT 'PRE-FLIGHT' AS phase, 'departments'         AS table_name, count(*)::bigint AS row_count FROM public.departments;
SELECT 'PRE-FLIGHT' AS phase, 'delivery_notes'      AS table_name, count(*)::bigint AS row_count FROM public.delivery_notes;
SELECT 'PRE-FLIGHT' AS phase, 'discountrules'       AS table_name, count(*)::bigint AS row_count FROM public.discountrules;
SELECT 'PRE-FLIGHT' AS phase, 'documents'           AS table_name, count(*)::bigint AS row_count FROM public.documents;
SELECT 'PRE-FLIGHT' AS phase, 'employees'           AS table_name, count(*)::bigint AS row_count FROM public.employees;
SELECT 'PRE-FLIGHT' AS phase, 'expenses'            AS table_name, count(*)::bigint AS row_count FROM public.expenses;
SELECT 'PRE-FLIGHT' AS phase, 'examination_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_batches;
SELECT 'PRE-FLIGHT' AS phase, 'examination_bom_calculations' AS table_name, count(*)::bigint AS row_count FROM public.examination_bom_calculations;
SELECT 'PRE-FLIGHT' AS phase, 'examination_classes' AS table_name, count(*)::bigint AS row_count FROM public.examination_classes;
SELECT 'PRE-FLIGHT' AS phase, 'examination_inventory_deductions' AS table_name, count(*)::bigint AS row_count FROM public.examination_inventory_deductions;
SELECT 'PRE-FLIGHT' AS phase, 'examination_invoice_groups' AS table_name, count(*)::bigint AS row_count FROM public.examination_invoice_groups;
SELECT 'PRE-FLIGHT' AS phase, 'examination_job_subjects' AS table_name, count(*)::bigint AS row_count FROM public.examination_job_subjects;
SELECT 'PRE-FLIGHT' AS phase, 'examination_jobs'     AS table_name, count(*)::bigint AS row_count FROM public.examination_jobs;
SELECT 'PRE-FLIGHT' AS phase, 'examination_papers'  AS table_name, count(*)::bigint AS row_count FROM public.examination_papers;
SELECT 'PRE-FLIGHT' AS phase, 'examination_printing_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_printing_batches;
SELECT 'PRE-FLIGHT' AS phase, 'examination_recurring_profiles' AS table_name, count(*)::bigint AS row_count FROM public.examination_recurring_profiles;
SELECT 'PRE-FLIGHT' AS phase, 'examination_subjects' AS table_name, count(*)::bigint AS row_count FROM public.examination_subjects;
SELECT 'PRE-FLIGHT' AS phase, 'examination_pricing_audit' AS table_name, count(*)::bigint AS row_count FROM public.examination_pricing_audit;
SELECT 'PRE-FLIGHT' AS phase, 'examination_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.examination_class_adjustments;
SELECT 'PRE-FLIGHT' AS phase, 'financial_years'      AS table_name, count(*)::bigint AS row_count FROM public.financial_years;
SELECT 'PRE-FLIGHT' AS phase, 'goods_receipts'       AS table_name, count(*)::bigint AS row_count FROM public.goods_receipts;
SELECT 'PRE-FLIGHT' AS phase, 'income'               AS table_name, count(*)::bigint AS row_count FROM public.income;
SELECT 'PRE-FLIGHT' AS phase, 'inventory'            AS table_name, count(*)::bigint AS row_count FROM public.inventory;
SELECT 'PRE-FLIGHT' AS phase, 'inventory_items'      AS table_name, count(*)::bigint AS row_count FROM public.inventory_items;
SELECT 'PRE-FLIGHT' AS phase, 'inventory_movements'  AS table_name, count(*)::bigint AS row_count FROM public.inventory_movements;
SELECT 'PRE-FLIGHT' AS phase, 'inventory_transactions' AS table_name, count(*)::bigint AS row_count FROM public.inventory_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'job_orders'           AS table_name, count(*)::bigint AS row_count FROM public.job_orders;
SELECT 'PRE-FLIGHT' AS phase, 'job_tickets'          AS table_name, count(*)::bigint AS row_count FROM public.job_tickets;
SELECT 'PRE-FLIGHT' AS phase, 'ledger_entries'       AS table_name, count(*)::bigint AS row_count FROM public.ledger_entries;
SELECT 'PRE-FLIGHT' AS phase, 'maintenance_logs'     AS table_name, count(*)::bigint AS row_count FROM public.maintenance_logs;
SELECT 'PRE-FLIGHT' AS phase, 'market_adjustment_transactions' AS table_name, count(*)::bigint AS row_count FROM public.market_adjustment_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'market_adjustments'   AS table_name, count(*)::bigint AS row_count FROM public.market_adjustments;
SELECT 'PRE-FLIGHT' AS phase, 'material_categories'  AS table_name, count(*)::bigint AS row_count FROM public.material_categories;
SELECT 'PRE-FLIGHT' AS phase, 'material_reservations' AS table_name, count(*)::bigint AS row_count FROM public.material_reservations;
SELECT 'PRE-FLIGHT' AS phase, 'orders'               AS table_name, count(*)::bigint AS row_count FROM public.orders;
SELECT 'PRE-FLIGHT' AS phase, 'product_variants'     AS table_name, count(*)::bigint AS row_count FROM public.product_variants;
SELECT 'PRE-FLIGHT' AS phase, 'products'             AS table_name, count(*)::bigint AS row_count FROM public.products;
SELECT 'PRE-FLIGHT' AS phase, 'promotion_redemptions' AS table_name, count(*)::bigint AS row_count FROM public.promotion_redemptions;
SELECT 'PRE-FLIGHT' AS phase, 'purchase_orders'      AS table_name, count(*)::bigint AS row_count FROM public.purchase_orders;
SELECT 'PRE-FLIGHT' AS phase, 'purchases'            AS table_name, count(*)::bigint AS row_count FROM public.purchases;
SELECT 'PRE-FLIGHT' AS phase, 'profit_margin_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.profit_margin_audit_logs;
SELECT 'PRE-FLIGHT' AS phase, 'quotations'           AS table_name, count(*)::bigint AS row_count FROM public.quotations;
SELECT 'PRE-FLIGHT' AS phase, 'referral_analytics'   AS table_name, count(*)::bigint AS row_count FROM public.referral_analytics;
SELECT 'PRE-FLIGHT' AS phase, 'referral_audit_logs'  AS table_name, count(*)::bigint AS row_count FROM public.referral_audit_logs;
SELECT 'PRE-FLIGHT' AS phase, 'referral_campaigns'   AS table_name, count(*)::bigint AS row_count FROM public.referral_campaigns;
SELECT 'PRE-FLIGHT' AS phase, 'referral_rewards'     AS table_name, count(*)::bigint AS row_count FROM public.referral_rewards;
SELECT 'PRE-FLIGHT' AS phase, 'referral_reversals'   AS table_name, count(*)::bigint AS row_count FROM public.referral_reversals;
SELECT 'PRE-FLIGHT' AS phase, 'referral_timeline'    AS table_name, count(*)::bigint AS row_count FROM public.referral_timeline;
SELECT 'PRE-FLIGHT' AS phase, 'recurring_invoices'   AS table_name, count(*)::bigint AS row_count FROM public.recurring_invoices;
SELECT 'PRE-FLIGHT' AS phase, 'reminders'             AS table_name, count(*)::bigint AS row_count FROM public.reminders;
SELECT 'PRE-FLIGHT' AS phase, 'resource_allocations'  AS table_name, count(*)::bigint AS row_count FROM public.resource_allocations;
SELECT 'PRE-FLIGHT' AS phase, 'rounding_logs'         AS table_name, count(*)::bigint AS row_count FROM public.rounding_logs;
SELECT 'PRE-FLIGHT' AS phase, 'sales'                AS table_name, count(*)::bigint AS row_count FROM public.sales;
SELECT 'PRE-FLIGHT' AS phase, 'sale_items'           AS table_name, count(*)::bigint AS row_count FROM public.sale_items;
SELECT 'PRE-FLIGHT' AS phase, 'sales_exchange_approvals' AS table_name, count(*)::bigint AS row_count FROM public.sales_exchange_approvals;
SELECT 'PRE-FLIGHT' AS phase, 'sales_exchange_items'  AS table_name, count(*)::bigint AS row_count FROM public.sales_exchange_items;
SELECT 'PRE-FLIGHT' AS phase, 'sales_exchanges'      AS table_name, count(*)::bigint AS row_count FROM public.sales_exchanges;
SELECT 'PRE-FLIGHT' AS phase, 'sales_orders'         AS table_name, count(*)::bigint AS row_count FROM public.sales_orders;
SELECT 'PRE-FLIGHT' AS phase, 'scheduled_payments'    AS table_name, count(*)::bigint AS row_count FROM public.scheduled_payments;
SELECT 'PRE-FLIGHT' AS phase, 'shipments'            AS table_name, count(*)::bigint AS row_count FROM public.shipments;
SELECT 'PRE-FLIGHT' AS phase, 'sms_campaigns'        AS table_name, count(*)::bigint AS row_count FROM public.sms_campaigns;
SELECT 'PRE-FLIGHT' AS phase, 'sms_templates'        AS table_name, count(*)::bigint AS row_count FROM public.sms_templates;
SELECT 'PRE-FLIGHT' AS phase, 'schools'              AS table_name, count(*)::bigint AS row_count FROM public.schools;
SELECT 'PRE-FLIGHT' AS phase, 'subcontract_orders'   AS table_name, count(*)::bigint AS row_count FROM public.subcontract_orders;
SELECT 'PRE-FLIGHT' AS phase, 'subscribers'          AS table_name, count(*)::bigint AS row_count FROM public.subscribers;
SELECT 'PRE-FLIGHT' AS phase, 'subjects'             AS table_name, count(*)::bigint AS row_count FROM public.subjects;
SELECT 'PRE-FLIGHT' AS phase, 'suppliers'            AS table_name, count(*)::bigint AS row_count FROM public.suppliers;
SELECT 'PRE-FLIGHT' AS phase, 'supplier_payments'    AS table_name, count(*)::bigint AS row_count FROM public.supplier_payments;
SELECT 'PRE-FLIGHT' AS phase, 'tax_rates'            AS table_name, count(*)::bigint AS row_count FROM public.tax_rates;
SELECT 'PRE-FLIGHT' AS phase, 'tasks'                AS table_name, count(*)::bigint AS row_count FROM public.tasks;
SELECT 'PRE-FLIGHT' AS phase, 'transfers'            AS table_name, count(*)::bigint AS row_count FROM public.transfers;
SELECT 'PRE-FLIGHT' AS phase, 'user_groups'          AS table_name, count(*)::bigint AS row_count FROM public.user_groups;
SELECT 'PRE-FLIGHT' AS phase, 'user_preferences'     AS table_name, count(*)::bigint AS row_count FROM public.user_preferences;
SELECT 'PRE-FLIGHT' AS phase, 'vat_returns'          AS table_name, count(*)::bigint AS row_count FROM public.vat_returns;
SELECT 'PRE-FLIGHT' AS phase, 'vat_transactions'     AS table_name, count(*)::bigint AS row_count FROM public.vat_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'wallet_transactions'  AS table_name, count(*)::bigint AS row_count FROM public.wallet_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'warehouse_inventory'  AS table_name, count(*)::bigint AS row_count FROM public.warehouse_inventory;
SELECT 'PRE-FLIGHT' AS phase, 'warehouses'           AS table_name, count(*)::bigint AS row_count FROM public.warehouses;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_accounts'    AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_accounts;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_automations' AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_automations;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_campaigns'   AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_campaigns;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_chats'       AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_chats;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_message_queue' AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_message_queue;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_messages'    AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_messages;
SELECT 'PRE-FLIGHT' AS phase, 'whatsapp_templates'   AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_templates;
SELECT 'PRE-FLIGHT' AS phase, 'work_centers'         AS table_name, count(*)::bigint AS row_count FROM public.work_centers;
SELECT 'PRE-FLIGHT' AS phase, 'work_orders'          AS table_name, count(*)::bigint AS row_count FROM public.work_orders;
SELECT 'PRE-FLIGHT' AS phase, 'production_batches'         AS table_name, count(*)::bigint AS row_count FROM public.production_batches;
SELECT 'PRE-FLIGHT' AS phase, 'production_resources'        AS table_name, count(*)::bigint AS row_count FROM public.production_resources;
SELECT 'PRE-FLIGHT' AS phase, 'production_bom_templates'     AS table_name, count(*)::bigint AS row_count FROM public.production_bom_templates;
SELECT 'PRE-FLIGHT' AS phase, 'production_bom_template_components' AS table_name, count(*)::bigint AS row_count FROM public.production_bom_template_components;
SELECT 'PRE-FLIGHT' AS phase, 'production_classes'          AS table_name, count(*)::bigint AS row_count FROM public.production_classes;
SELECT 'PRE-FLIGHT' AS phase, 'production_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.production_class_adjustments;
SELECT 'PRE-FLIGHT' AS phase, 'production_bom_calculations'   AS table_name, count(*)::bigint AS row_count FROM public.production_bom_calculations;
SELECT 'PRE-FLIGHT' AS phase, 'production_pricing_audit'     AS table_name, count(*)::bigint AS row_count FROM public.production_pricing_audit;
SELECT 'PRE-FLIGHT' AS phase, 'production_notification_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.production_notification_audit_logs;
SELECT 'PRE-FLIGHT' AS phase, 'production_batch_notifications' AS table_name, count(*)::bigint AS row_count FROM public.production_batch_notifications;
SELECT 'PRE-FLIGHT' AS phase, 'examination_batches'           AS table_name, count(*)::bigint AS row_count FROM public.examination_batches;
SELECT 'PRE-FLIGHT' AS phase, 'examination_classes'          AS table_name, count(*)::bigint AS row_count FROM public.examination_classes;
SELECT 'PRE-FLIGHT' AS phase, 'examination_subjects'         AS table_name, count(*)::bigint AS row_count FROM public.examination_subjects;
SELECT 'PRE-FLIGHT' AS phase, 'examination_job_subjects'     AS table_name, count(*)::bigint AS row_count FROM public.examination_job_subjects;
SELECT 'PRE-FLIGHT' AS phase, 'examination_jobs'             AS table_name, count(*)::bigint AS row_count FROM public.examination_jobs;
SELECT 'PRE-FLIGHT' AS phase, 'examination_papers'           AS table_name, count(*)::bigint AS row_count FROM public.examination_papers;
SELECT 'PRE-FLIGHT' AS phase, 'examination_printing_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_printing_batches;
SELECT 'PRE-FLIGHT' AS phase, 'examination_invoice_groups'   AS table_name, count(*)::bigint AS row_count FROM public.examination_invoice_groups;
SELECT 'PRE-FLIGHT' AS phase, 'examination_recurring_profiles' AS table_name, count(*)::bigint AS row_count FROM public.examination_recurring_profiles;
SELECT 'PRE-FLIGHT' AS phase, 'examination_inventory_deductions' AS table_name, count(*)::bigint AS row_count FROM public.examination_inventory_deductions;
SELECT 'PRE-FLIGHT' AS phase, 'examination_batch_notifications' AS table_name, count(*)::bigint AS row_count FROM public.examination_batch_notifications;
SELECT 'PRE-FLIGHT' AS phase, 'examination_bom_calculations'   AS table_name, count(*)::bigint AS row_count FROM public.examination_bom_calculations;
SELECT 'PRE-FLIGHT' AS phase, 'examination_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.examination_class_adjustments;
SELECT 'PRE-FLIGHT' AS phase, 'examination_pricing_audit'     AS table_name, count(*)::bigint AS row_count FROM public.examination_pricing_audit;
SELECT 'PRE-FLIGHT' AS phase, 'examinations'                 AS table_name, count(*)::bigint AS row_count FROM public.examinations;
SELECT 'PRE-FLIGHT' AS phase, 'purchase_order_items'         AS table_name, count(*)::bigint AS row_count FROM public.purchase_order_items;
SELECT 'PRE-FLIGHT' AS phase, 'referral_event_history'       AS table_name, count(*)::bigint AS row_count FROM public.referral_event_history;
SELECT 'PRE-FLIGHT' AS phase, 'acceptance_runs'              AS table_name, count(*)::bigint AS row_count FROM public.acceptance_runs;
SELECT 'PRE-FLIGHT' AS phase, 'support_tickets'              AS table_name, count(*)::bigint AS row_count FROM public.support_tickets;
SELECT 'PRE-FLIGHT' AS phase, 'payments'                     AS table_name, count(*)::bigint AS row_count FROM public.payments;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_timeline'          AS table_name, count(*)::bigint AS row_count FROM public.engagement_timeline;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_audit'             AS table_name, count(*)::bigint AS row_count FROM public.engagement_audit;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_points'            AS table_name, count(*)::bigint AS row_count FROM public.engagement_points;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_point_balances'    AS table_name, count(*)::bigint AS row_count FROM public.engagement_point_balances;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_cashback'          AS table_name, count(*)::bigint AS row_count FROM public.engagement_cashback;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_membership_tiers'  AS table_name, count(*)::bigint AS row_count FROM public.engagement_membership_tiers;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_customer_tiers'    AS table_name, count(*)::bigint AS row_count FROM public.engagement_customer_tiers;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_gift_cards'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_gift_cards;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_gift_card_transactions' AS table_name, count(*)::bigint AS row_count FROM public.engagement_gift_card_transactions;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_affiliates'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_affiliates;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_affiliate_commissions' AS table_name, count(*)::bigint AS row_count FROM public.engagement_affiliate_commissions;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_promotions'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_promotions;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_customer_rewards'  AS table_name, count(*)::bigint AS row_count FROM public.engagement_customer_rewards;
SELECT 'PRE-FLIGHT' AS phase, 'engagement_analytics'         AS table_name, count(*)::bigint AS row_count FROM public.engagement_analytics;
SELECT 'PRE-FLIGHT' AS phase, 'reprint_jobs'                 AS table_name, count(*)::bigint AS row_count FROM public.reprint_jobs;
SELECT 'PRE-FLIGHT' AS phase, 'payroll_runs'                 AS table_name, count(*)::bigint AS row_count FROM public.payroll_runs;
SELECT 'PRE-FLIGHT' AS phase, 'payslips'                    AS table_name, count(*)::bigint AS row_count FROM public.payslips;
SELECT 'PRE-FLIGHT' AS phase, 'payment_allocation_lines'  AS table_name, count(*)::bigint AS row_count FROM public.payment_allocation_lines;
SELECT 'PRE-FLIGHT' AS phase, 'payment_allocations'     AS table_name, count(*)::bigint AS row_count FROM public.payment_allocations;
SELECT 'PRE-FLIGHT' AS phase, 'invoices'                AS table_name, count(*)::bigint AS row_count FROM public.invoices;
SELECT 'PRE-FLIGHT' AS phase, 'material_batches'        AS table_name, count(*)::bigint AS row_count FROM public.material_batches;

-- Also show PRESERVE table counts for verification baseline
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'companies'            AS table_name, count(*)::bigint AS row_count FROM public.companies;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'profiles'             AS table_name, count(*)::bigint AS row_count FROM public.profiles;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'settings'             AS table_name, count(*)::bigint AS row_count FROM public.settings;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'idempotency_keys'     AS table_name, count(*)::bigint AS row_count FROM public.idempotency_keys;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'sync_log'             AS table_name, count(*)::bigint AS row_count FROM public.sync_log;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_users'         AS table_name, count(*)::bigint AS row_count FROM public.portal_users;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_sessions'      AS table_name, count(*)::bigint AS row_count FROM public.portal_sessions;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_password_resets' AS table_name, count(*)::bigint AS row_count FROM public.portal_password_resets;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_login_history' AS table_name, count(*)::bigint AS row_count FROM public.portal_login_history;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_tickets'       AS table_name, count(*)::bigint AS row_count FROM public.portal_tickets;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_ticket_messages' AS table_name, count(*)::bigint AS row_count FROM public.portal_ticket_messages;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'ticket_attachments'   AS table_name, count(*)::bigint AS row_count FROM public.ticket_attachments;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_notifications' AS table_name, count(*)::bigint AS row_count FROM public.portal_notifications;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'portal_ads'           AS table_name, count(*)::bigint AS row_count FROM public.portal_ads;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'bank_categories'      AS table_name, count(*)::bigint AS row_count FROM public.bank_categories;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'messages'            AS table_name, count(*)::bigint AS row_count FROM public.messages;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'profit_margin_settings' AS table_name, count(*)::bigint AS row_count FROM public.profit_margin_settings;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'job_ticket_settings'  AS table_name, count(*)::bigint AS row_count FROM public.job_ticket_settings;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'payment_requests'     AS table_name, count(*)::bigint AS row_count FROM public.payment_requests;
SELECT 'PRE-FLIGHT-PRESERVE' AS phase, 'quotation_requests'   AS table_name, count(*)::bigint AS row_count FROM public.quotation_requests;

-- Report remaining REVIEW/UNKNOWN table counts for visibility (NOT deleted)
SELECT 'PRE-FLIGHT-REVIEW' AS phase, 'audit_logs'            AS table_name, count(*)::bigint AS row_count FROM public.audit_logs;
SELECT 'PRE-FLIGHT-REVIEW' AS phase, 'notification_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.notification_audit_logs;

-- ============================================================================
-- DELETION SECTION
-- ============================================================================
-- Order rationale:
--   No conventional FOREIGN KEY constraints exist in the 0001 live schema.
--   All relationships are logical (stored inside JSONB data column).
--   The financial-integrity triggers (0013) fire on INSERT/UPDATE, not DELETE,
--   so deletion order does not affect trigger correctness.
--   The payment_allocation_lines DELETE trigger (trg_pal_invoice_touch_del)
--   fires a no-op UPDATE on invoices. It is harmless during bulk deletion.
--   payment_allocations/payment_allocation_lines are deleted BEFORE invoices
--   as a conservative choice, since invoices.paidAmount is derived from them.
--   However, the trigger just sets paidAmount=0 when no lines remain, so even
--   reverse order would be safe.
-- ============================================================================

-- ── Phase 1: Payment allocation lines (child of invoices) ──
DELETE FROM public.payment_allocation_lines;
DELETE FROM public.payment_allocations;

-- ── Phase 2: Promotion redemptions (has UNIQUE constraint, must be clean) ──
DELETE FROM public.promotion_redemptions;

-- ── Phase 3: Financial transaction records (no FK deps) ──
DELETE FROM public.ledger_entries;
DELETE FROM public.chart_of_accounts;
DELETE FROM public.invoices;
DELETE FROM public.customer_payments;
DELETE FROM public.supplier_payments;
DELETE FROM public.sales;
DELETE FROM public.sale_items;
DELETE FROM public.purchases;
DELETE FROM public.purchase_orders;
DELETE FROM public.orders;
DELETE FROM public.sales_orders;
DELETE FROM public.quotations;
DELETE FROM public.sales_exchanges;
DELETE FROM public.sales_exchange_items;
DELETE FROM public.sales_exchange_approvals;
DELETE FROM public.expenses;
DELETE FROM public.income;
DELETE FROM public.budgets;
DELETE FROM public.transfers;
DELETE FROM public.cheques;
DELETE FROM public.assets;
DELETE FROM public.accounts;
DELETE FROM public.reminders;
DELETE FROM public.scheduled_payments;
DELETE FROM public.recurring_invoices;
DELETE FROM public.wallet_transactions;
DELETE FROM public.vat_transactions;
DELETE FROM public.vat_returns;
DELETE FROM public.financial_years;
DELETE FROM public.market_adjustment_transactions;
DELETE FROM public.market_adjustments;
DELETE FROM public.profit_margin_audit_logs;
DELETE FROM public.rounding_logs;
DELETE FROM public.tax_rates;
DELETE FROM public.bank_accounts;
DELETE FROM public.bank_transactions;
DELETE FROM public.bank_statements;
DELETE FROM public.bank_adjustments;
DELETE FROM public.bank_reconciliations;
DELETE FROM public.bank_scheduled_payments;
DELETE FROM public.bank_exchange_rates;
DELETE FROM public.bank_fees;
DELETE FROM public.bank_alerts;
DELETE FROM public.bank_cash_flow_forecasts;

-- ── Phase 4: Customer / supplier master data ──
DELETE FROM public.customers;
DELETE FROM public.suppliers;
DELETE FROM public.employees;
DELETE FROM public.departments;
DELETE FROM public.schools;
DELETE FROM public.classes;
DELETE FROM public.subjects;
DELETE FROM public.user_groups;
DELETE FROM public.user_preferences;

-- ── Phase 5: Product / inventory master data ──
DELETE FROM public.products;
DELETE FROM public.product_variants;
DELETE FROM public.inventory;
DELETE FROM public.inventory_items;
DELETE FROM public.inventory_movements;
DELETE FROM public.inventory_transactions;
DELETE FROM public.warehouse_inventory;
DELETE FROM public.warehouses;
DELETE FROM public.material_batches;
DELETE FROM public.material_categories;
DELETE FROM public.material_reservations;
DELETE FROM public.bom_default_materials;
DELETE FROM public.bom_templates;
DELETE FROM public.boms;
DELETE FROM public.goods_receipts;
DELETE FROM public.subcontract_orders;

-- ── Phase 6: Production / work orders ──
DELETE FROM public.production_batches;
DELETE FROM public.production_resources;
DELETE FROM public.work_centers;
DELETE FROM public.work_orders;
DELETE FROM public.production_bom_templates;
DELETE FROM public.production_bom_template_components;
DELETE FROM public.production_classes;
DELETE FROM public.production_class_adjustments;
DELETE FROM public.production_bom_calculations;
DELETE FROM public.production_pricing_audit;
DELETE FROM public.production_notification_audit_logs;
DELETE FROM public.job_tickets;
DELETE FROM public.job_orders;
DELETE FROM public.resource_allocations;
DELETE FROM public.maintenance_logs;

-- ── Phase 7: Examination module ──
DELETE FROM public.examination_batches;
DELETE FROM public.examination_classes;
DELETE FROM public.examination_subjects;
DELETE FROM public.examination_job_subjects;
DELETE FROM public.examination_jobs;
DELETE FROM public.examination_papers;
DELETE FROM public.examination_printing_batches;
DELETE FROM public.examination_invoice_groups;
DELETE FROM public.examination_recurring_profiles;
DELETE FROM public.examination_inventory_deductions;
DELETE FROM public.examination_batch_notifications;
DELETE FROM public.examination_bom_calculations;
DELETE FROM public.examination_class_adjustments;
DELETE FROM public.examination_pricing_audit;
DELETE FROM public.examinations;
DELETE FROM public.production_batch_notifications;

-- ── Phase 8: Communications / marketing ──
DELETE FROM public.sms_campaigns;
DELETE FROM public.sms_templates;
DELETE FROM public.whatsapp_accounts;
DELETE FROM public.whatsapp_automations;
DELETE FROM public.whatsapp_campaigns;
DELETE FROM public.whatsapp_chats;
DELETE FROM public.whatsapp_message_queue;
DELETE FROM public.whatsapp_messages;
DELETE FROM public.whatsapp_templates;
DELETE FROM public.customer_notification_logs;

-- ── Phase 9: Referral system ──
DELETE FROM public.customer_referrals;
DELETE FROM public.referral_rewards;
DELETE FROM public.referral_timeline;
DELETE FROM public.referral_audit_logs;
DELETE FROM public.referral_campaigns;
DELETE FROM public.referral_analytics;
DELETE FROM public.referral_reversals;

-- ── Phase 10: Customer pricing / rules ──
DELETE FROM public.customerpricingtiers;
DELETE FROM public.discountrules;

-- ── Phase 10b: Additional confirmed business tables (empty, added after live verification) ──
-- These tables were confirmed to exist in the live database during READ-ONLY verification.
-- They are empty, so DELETE is a safe no-op. Included for completeness.
DELETE FROM public.purchase_order_items;
DELETE FROM public.referral_event_history;
DELETE FROM public.acceptance_runs;
DELETE FROM public.support_tickets;
DELETE FROM public.payments;

-- ── Phase 11: Engagement / loyalty (business data) ──
-- These are loyalty program business records, not protected system tables.
DELETE FROM public.engagement_timeline;
DELETE FROM public.engagement_audit;
DELETE FROM public.engagement_points;
DELETE FROM public.engagement_point_balances;
DELETE FROM public.engagement_cashback;
DELETE FROM public.engagement_membership_tiers;
DELETE FROM public.engagement_customer_tiers;
DELETE FROM public.engagement_gift_cards;
DELETE FROM public.engagement_gift_card_transactions;
DELETE FROM public.engagement_affiliates;
DELETE FROM public.engagement_affiliate_commissions;
DELETE FROM public.engagement_promotions;
DELETE FROM public.engagement_customer_rewards;
DELETE FROM public.engagement_analytics;

-- ── Phase 12: Shipping / documents ──
DELETE FROM public.shipments;
DELETE FROM public.delivery_notes;
DELETE FROM public.documents;
DELETE FROM public.subscribers;
DELETE FROM public.tasks;
DELETE FROM public.reprint_jobs;

-- ── Phase 13: Payroll / HR ──
DELETE FROM public.payroll_runs;
DELETE FROM public.payslips;

-- ============================================================================
-- POST-FLIGHT: Verification that CLEAR tables are empty and PRESERVE intact
-- ============================================================================

-- 1. Confirm all CLEAR tables now have zero rows
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'accounts'            AS table_name, count(*)::bigint AS row_count FROM public.accounts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'assets'              AS table_name, count(*)::bigint AS row_count FROM public.assets;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_accounts'       AS table_name, count(*)::bigint AS row_count FROM public.bank_accounts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_adjustments'    AS table_name, count(*)::bigint AS row_count FROM public.bank_adjustments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_alerts'         AS table_name, count(*)::bigint AS row_count FROM public.bank_alerts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_cash_flow_forecasts' AS table_name, count(*)::bigint AS row_count FROM public.bank_cash_flow_forecasts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_exchange_rates' AS table_name, count(*)::bigint AS row_count FROM public.bank_exchange_rates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_fees'           AS table_name, count(*)::bigint AS row_count FROM public.bank_fees;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_reconciliations' AS table_name, count(*)::bigint AS row_count FROM public.bank_reconciliations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_scheduled_payments' AS table_name, count(*)::bigint AS row_count FROM public.bank_scheduled_payments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_statements'     AS table_name, count(*)::bigint AS row_count FROM public.bank_statements;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bank_transactions'   AS table_name, count(*)::bigint AS row_count FROM public.bank_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bom_default_materials' AS table_name, count(*)::bigint AS row_count FROM public.bom_default_materials;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'bom_templates'       AS table_name, count(*)::bigint AS row_count FROM public.bom_templates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'boms'                AS table_name, count(*)::bigint AS row_count FROM public.boms;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'budgets'             AS table_name, count(*)::bigint AS row_count FROM public.budgets;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'cheques'             AS table_name, count(*)::bigint AS row_count FROM public.cheques;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'chart_of_accounts'   AS table_name, count(*)::bigint AS row_count FROM public.chart_of_accounts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'classes'             AS table_name, count(*)::bigint AS row_count FROM public.classes;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'customer_notification_logs' AS table_name, count(*)::bigint AS row_count FROM public.customer_notification_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'customer_payments'   AS table_name, count(*)::bigint AS row_count FROM public.customer_payments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'customer_referrals'  AS table_name, count(*)::bigint AS row_count FROM public.customer_referrals;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'customerpricingtiers' AS table_name, count(*)::bigint AS row_count FROM public.customerpricingtiers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'customers'           AS table_name, count(*)::bigint AS row_count FROM public.customers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'departments'         AS table_name, count(*)::bigint AS row_count FROM public.departments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'delivery_notes'      AS table_name, count(*)::bigint AS row_count FROM public.delivery_notes;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'discountrules'       AS table_name, count(*)::bigint AS row_count FROM public.discountrules;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'documents'           AS table_name, count(*)::bigint AS row_count FROM public.documents;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'employees'           AS table_name, count(*)::bigint AS row_count FROM public.employees;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'expenses'            AS table_name, count(*)::bigint AS row_count FROM public.expenses;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_batches;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_bom_calculations' AS table_name, count(*)::bigint AS row_count FROM public.examination_bom_calculations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_classes' AS table_name, count(*)::bigint AS row_count FROM public.examination_classes;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_inventory_deductions' AS table_name, count(*)::bigint AS row_count FROM public.examination_inventory_deductions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_invoice_groups' AS table_name, count(*)::bigint AS row_count FROM public.examination_invoice_groups;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_job_subjects' AS table_name, count(*)::bigint AS row_count FROM public.examination_job_subjects;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_jobs'     AS table_name, count(*)::bigint AS row_count FROM public.examination_jobs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_papers'  AS table_name, count(*)::bigint AS row_count FROM public.examination_papers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_printing_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_printing_batches;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_recurring_profiles' AS table_name, count(*)::bigint AS row_count FROM public.examination_recurring_profiles;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_subjects' AS table_name, count(*)::bigint AS row_count FROM public.examination_subjects;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_pricing_audit' AS table_name, count(*)::bigint AS row_count FROM public.examination_pricing_audit;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.examination_class_adjustments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'financial_years'      AS table_name, count(*)::bigint AS row_count FROM public.financial_years;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'goods_receipts'       AS table_name, count(*)::bigint AS row_count FROM public.goods_receipts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'income'               AS table_name, count(*)::bigint AS row_count FROM public.income;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'inventory'            AS table_name, count(*)::bigint AS row_count FROM public.inventory;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'inventory_items'      AS table_name, count(*)::bigint AS row_count FROM public.inventory_items;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'inventory_movements'  AS table_name, count(*)::bigint AS row_count FROM public.inventory_movements;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'inventory_transactions' AS table_name, count(*)::bigint AS row_count FROM public.inventory_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'job_orders'           AS table_name, count(*)::bigint AS row_count FROM public.job_orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'job_tickets'          AS table_name, count(*)::bigint AS row_count FROM public.job_tickets;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'ledger_entries'       AS table_name, count(*)::bigint AS row_count FROM public.ledger_entries;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'maintenance_logs'     AS table_name, count(*)::bigint AS row_count FROM public.maintenance_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'market_adjustment_transactions' AS table_name, count(*)::bigint AS row_count FROM public.market_adjustment_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'market_adjustments'   AS table_name, count(*)::bigint AS row_count FROM public.market_adjustments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'material_categories'  AS table_name, count(*)::bigint AS row_count FROM public.material_categories;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'material_reservations' AS table_name, count(*)::bigint AS row_count FROM public.material_reservations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'orders'               AS table_name, count(*)::bigint AS row_count FROM public.orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'product_variants'     AS table_name, count(*)::bigint AS row_count FROM public.product_variants;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'products'             AS table_name, count(*)::bigint AS row_count FROM public.products;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'promotion_redemptions' AS table_name, count(*)::bigint AS row_count FROM public.promotion_redemptions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'purchase_orders'      AS table_name, count(*)::bigint AS row_count FROM public.purchase_orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'purchases'            AS table_name, count(*)::bigint AS row_count FROM public.purchases;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'profit_margin_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.profit_margin_audit_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'quotations'           AS table_name, count(*)::bigint AS row_count FROM public.quotations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_analytics'   AS table_name, count(*)::bigint AS row_count FROM public.referral_analytics;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_audit_logs'  AS table_name, count(*)::bigint AS row_count FROM public.referral_audit_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_campaigns'   AS table_name, count(*)::bigint AS row_count FROM public.referral_campaigns;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_rewards'     AS table_name, count(*)::bigint AS row_count FROM public.referral_rewards;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_reversals'   AS table_name, count(*)::bigint AS row_count FROM public.referral_reversals;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_timeline'    AS table_name, count(*)::bigint AS row_count FROM public.referral_timeline;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'recurring_invoices'   AS table_name, count(*)::bigint AS row_count FROM public.recurring_invoices;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'reminders'             AS table_name, count(*)::bigint AS row_count FROM public.reminders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'resource_allocations'  AS table_name, count(*)::bigint AS row_count FROM public.resource_allocations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'rounding_logs'         AS table_name, count(*)::bigint AS row_count FROM public.rounding_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sales'                AS table_name, count(*)::bigint AS row_count FROM public.sales;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sale_items'           AS table_name, count(*)::bigint AS row_count FROM public.sale_items;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sales_exchange_approvals' AS table_name, count(*)::bigint AS row_count FROM public.sales_exchange_approvals;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sales_exchange_items'  AS table_name, count(*)::bigint AS row_count FROM public.sales_exchange_items;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sales_exchanges'      AS table_name, count(*)::bigint AS row_count FROM public.sales_exchanges;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sales_orders'         AS table_name, count(*)::bigint AS row_count FROM public.sales_orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'scheduled_payments'    AS table_name, count(*)::bigint AS row_count FROM public.scheduled_payments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'shipments'            AS table_name, count(*)::bigint AS row_count FROM public.shipments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sms_campaigns'        AS table_name, count(*)::bigint AS row_count FROM public.sms_campaigns;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'sms_templates'        AS table_name, count(*)::bigint AS row_count FROM public.sms_templates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'schools'              AS table_name, count(*)::bigint AS row_count FROM public.schools;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'subcontract_orders'   AS table_name, count(*)::bigint AS row_count FROM public.subcontract_orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'subscribers'          AS table_name, count(*)::bigint AS row_count FROM public.subscribers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'subjects'             AS table_name, count(*)::bigint AS row_count FROM public.subjects;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'suppliers'            AS table_name, count(*)::bigint AS row_count FROM public.suppliers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'supplier_payments'    AS table_name, count(*)::bigint AS row_count FROM public.supplier_payments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'tax_rates'            AS table_name, count(*)::bigint AS row_count FROM public.tax_rates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'tasks'                AS table_name, count(*)::bigint AS row_count FROM public.tasks;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'transfers'            AS table_name, count(*)::bigint AS row_count FROM public.transfers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'user_groups'          AS table_name, count(*)::bigint AS row_count FROM public.user_groups;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'user_preferences'     AS table_name, count(*)::bigint AS row_count FROM public.user_preferences;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'vat_returns'          AS table_name, count(*)::bigint AS row_count FROM public.vat_returns;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'vat_transactions'     AS table_name, count(*)::bigint AS row_count FROM public.vat_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'wallet_transactions'  AS table_name, count(*)::bigint AS row_count FROM public.wallet_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'warehouse_inventory'  AS table_name, count(*)::bigint AS row_count FROM public.warehouse_inventory;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'warehouses'           AS table_name, count(*)::bigint AS row_count FROM public.warehouses;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_accounts'    AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_accounts;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_automations' AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_automations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_campaigns'   AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_campaigns;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_chats'       AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_chats;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_message_queue' AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_message_queue;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_messages'    AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_messages;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'whatsapp_templates'   AS table_name, count(*)::bigint AS row_count FROM public.whatsapp_templates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'work_centers'         AS table_name, count(*)::bigint AS row_count FROM public.work_centers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'work_orders'          AS table_name, count(*)::bigint AS row_count FROM public.work_orders;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_batches'         AS table_name, count(*)::bigint AS row_count FROM public.production_batches;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_resources'        AS table_name, count(*)::bigint AS row_count FROM public.production_resources;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_bom_templates'     AS table_name, count(*)::bigint AS row_count FROM public.production_bom_templates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_bom_template_components' AS table_name, count(*)::bigint AS row_count FROM public.production_bom_template_components;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_classes'          AS table_name, count(*)::bigint AS row_count FROM public.production_classes;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.production_class_adjustments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_bom_calculations'   AS table_name, count(*)::bigint AS row_count FROM public.production_bom_calculations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_pricing_audit'     AS table_name, count(*)::bigint AS row_count FROM public.production_pricing_audit;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_notification_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.production_notification_audit_logs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'production_batch_notifications' AS table_name, count(*)::bigint AS row_count FROM public.production_batch_notifications;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_batches'           AS table_name, count(*)::bigint AS row_count FROM public.examination_batches;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_classes'          AS table_name, count(*)::bigint AS row_count FROM public.examination_classes;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_subjects'         AS table_name, count(*)::bigint AS row_count FROM public.examination_subjects;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_job_subjects'     AS table_name, count(*)::bigint AS row_count FROM public.examination_job_subjects;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_jobs'             AS table_name, count(*)::bigint AS row_count FROM public.examination_jobs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_papers'           AS table_name, count(*)::bigint AS row_count FROM public.examination_papers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_printing_batches' AS table_name, count(*)::bigint AS row_count FROM public.examination_printing_batches;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_invoice_groups'   AS table_name, count(*)::bigint AS row_count FROM public.examination_invoice_groups;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_recurring_profiles' AS table_name, count(*)::bigint AS row_count FROM public.examination_recurring_profiles;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_inventory_deductions' AS table_name, count(*)::bigint AS row_count FROM public.examination_inventory_deductions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_batch_notifications' AS table_name, count(*)::bigint AS row_count FROM public.examination_batch_notifications;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_bom_calculations'   AS table_name, count(*)::bigint AS row_count FROM public.examination_bom_calculations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_class_adjustments' AS table_name, count(*)::bigint AS row_count FROM public.examination_class_adjustments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examination_pricing_audit'     AS table_name, count(*)::bigint AS row_count FROM public.examination_pricing_audit;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'examinations'                 AS table_name, count(*)::bigint AS row_count FROM public.examinations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'purchase_order_items'         AS table_name, count(*)::bigint AS row_count FROM public.purchase_order_items;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'referral_event_history'       AS table_name, count(*)::bigint AS row_count FROM public.referral_event_history;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'acceptance_runs'              AS table_name, count(*)::bigint AS row_count FROM public.acceptance_runs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'support_tickets'              AS table_name, count(*)::bigint AS row_count FROM public.support_tickets;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'payments'                     AS table_name, count(*)::bigint AS row_count FROM public.payments;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_timeline'          AS table_name, count(*)::bigint AS row_count FROM public.engagement_timeline;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_audit'             AS table_name, count(*)::bigint AS row_count FROM public.engagement_audit;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_points'            AS table_name, count(*)::bigint AS row_count FROM public.engagement_points;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_point_balances'    AS table_name, count(*)::bigint AS row_count FROM public.engagement_point_balances;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_cashback'          AS table_name, count(*)::bigint AS row_count FROM public.engagement_cashback;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_membership_tiers'  AS table_name, count(*)::bigint AS row_count FROM public.engagement_membership_tiers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_customer_tiers'    AS table_name, count(*)::bigint AS row_count FROM public.engagement_customer_tiers;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_gift_cards'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_gift_cards;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_gift_card_transactions' AS table_name, count(*)::bigint AS row_count FROM public.engagement_gift_card_transactions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_affiliates'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_affiliates;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_affiliate_commissions' AS table_name, count(*)::bigint AS row_count FROM public.engagement_affiliate_commissions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_promotions'        AS table_name, count(*)::bigint AS row_count FROM public.engagement_promotions;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_customer_rewards'  AS table_name, count(*)::bigint AS row_count FROM public.engagement_customer_rewards;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'engagement_analytics'         AS table_name, count(*)::bigint AS row_count FROM public.engagement_analytics;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'reprint_jobs'                 AS table_name, count(*)::bigint AS row_count FROM public.reprint_jobs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'payroll_runs'                 AS table_name, count(*)::bigint AS row_count FROM public.payroll_runs;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'payslips'                    AS table_name, count(*)::bigint AS row_count FROM public.payslips;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'payment_allocation_lines'  AS table_name, count(*)::bigint AS row_count FROM public.payment_allocation_lines;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'payment_allocations'     AS table_name, count(*)::bigint AS row_count FROM public.payment_allocations;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'invoices'                AS table_name, count(*)::bigint AS row_count FROM public.invoices;
SELECT 'POST-FLIGHT-CLEAR' AS phase, 'material_batches'        AS table_name, count(*)::bigint AS row_count FROM public.material_batches;

-- 2. Confirm PRESERVE tables still exist and have their original row counts
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'companies'            AS table_name, count(*)::bigint AS row_count FROM public.companies;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'profiles'             AS table_name, count(*)::bigint AS row_count FROM public.profiles;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'settings'             AS table_name, count(*)::bigint AS row_count FROM public.settings;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'idempotency_keys'     AS table_name, count(*)::bigint AS row_count FROM public.idempotency_keys;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'sync_log'             AS table_name, count(*)::bigint AS row_count FROM public.sync_log;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_users'         AS table_name, count(*)::bigint AS row_count FROM public.portal_users;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_sessions'      AS table_name, count(*)::bigint AS row_count FROM public.portal_sessions;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_password_resets' AS table_name, count(*)::bigint AS row_count FROM public.portal_password_resets;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_login_history' AS table_name, count(*)::bigint AS row_count FROM public.portal_login_history;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_tickets'       AS table_name, count(*)::bigint AS row_count FROM public.portal_tickets;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_ticket_messages' AS table_name, count(*)::bigint AS row_count FROM public.portal_ticket_messages;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'ticket_attachments'   AS table_name, count(*)::bigint AS row_count FROM public.ticket_attachments;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_notifications' AS table_name, count(*)::bigint AS row_count FROM public.portal_notifications;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'portal_ads'           AS table_name, count(*)::bigint AS row_count FROM public.portal_ads;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'bank_categories'      AS table_name, count(*)::bigint AS row_count FROM public.bank_categories;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'messages'            AS table_name, count(*)::bigint AS row_count FROM public.messages;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'profit_margin_settings' AS table_name, count(*)::bigint AS row_count FROM public.profit_margin_settings;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'job_ticket_settings'  AS table_name, count(*)::bigint AS row_count FROM public.job_ticket_settings;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'payment_requests'     AS table_name, count(*)::bigint AS row_count FROM public.payment_requests;
SELECT 'POST-FLIGHT-PRESERVE' AS phase, 'quotation_requests'   AS table_name, count(*)::bigint AS row_count FROM public.quotation_requests;

-- 3. Verify settings row id='sync_generation' is preserved and unchanged
SELECT 'POST-FLIGHT-SYNC-GEN' AS phase, 'settings_sync_generation' AS check_name,
       count(*)::bigint AS row_count,
       MAX(data->>'value') AS generation_value
FROM public.settings
WHERE id = 'sync_generation';

-- 4. Confirm remaining REVIEW/UNKNOWN tables were NOT modified
SELECT 'POST-FLIGHT-REVIEW' AS phase, 'audit_logs'            AS table_name, count(*)::bigint AS row_count FROM public.audit_logs;
SELECT 'POST-FLIGHT-REVIEW' AS phase, 'notification_audit_logs' AS table_name, count(*)::bigint AS row_count FROM public.notification_audit_logs;

COMMIT;

/*
  ============================================================================
  END OF CLEANUP SCRIPT
  ============================================================================

  MANUAL POST-CLEANUP STEP — SYNC GENERATION RESET:
  After this cleanup script commits successfully, the sync generation MUST be
  incremented via the application endpoint (NOT via SQL):

    POST /api/sync/reset
    Authorization: Bearer <admin-jwt>
    Content-Type: application/json

  Expected response:
    { "ok": true, "previousGeneration": <N>, "generation": <N+1> }

  This step makes all previously queued operations permanently stale.

  DO NOT attempt to update public.settings directly to change sync_generation.
  DO NOT skip this step — without it, old queued operations could be re-applied.

  UNRESOLVED DECISIONS (RESOLVED AFTER LIVE VERIFICATION):
  All 5 previously-unresolved tables were confirmed to EXIST and be EMPTY
  in the live Supabase database during READ-ONLY verification.
  They have been added to the DELETE list as no-op deletes on empty tables.

  Classification rationale:
  1. payments — EXISTS, EMPTY. No code references it as a Supabase table.
     Added to CLEAR for safety (no-op DELETE on empty table).
  2. purchase_order_items — EXISTS, EMPTY. Used by PO matching AI service.
     CLEAR — business data (purchase order line items).
  3. referral_event_history — EXISTS, EMPTY. Part of referral system.
     CLEAR — business data (referral event tracking).
  4. acceptance_runs — EXISTS, EMPTY. Admin acceptance workflow for exams.
     CLEAR — business data (examination acceptance records).
  5. support_tickets — EXISTS, EMPTY. Customer support ticket system.
     CLEAR — business data (customer support records).

  REMAINING REVIEW TABLE (not deleted):
  - audit_logs — internal audit log, REVIEW status unresolved.
  - notification_audit_logs — notification audit log, REVIEW status unresolved.
  ============================================================================
*/

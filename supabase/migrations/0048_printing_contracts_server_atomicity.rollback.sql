-- =============================================================================
-- 0048 — ROLLBACK (schema only)
-- =============================================================================
-- STATUS: NOT APPLIED TO PRODUCTION. This file is a companion to
-- 0048_printing_contracts_server_atomicity.sql and is applied ONLY when that
-- migration is reverted.
--
-- ── WHAT THIS REVERTS ───────────────────────────────────────────────────────
-- The five functions created by 0048 and the EXECUTE grants attached to them.
-- Nothing else. 0048 created no table, no column and no row, so reverting it
-- cannot lose business data.
--
-- ── WHAT THIS DOES NOT REVERT ───────────────────────────────────────────────
-- Rows already written by these RPCs are ordinary financial records:
--   • wallet_transactions rows with data->>'type' = 'CONTRACT_PREPAID' no —
--     specifically the consumption debits:
--       wallet_transactions.data->>'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
--   • ledger_entries rows with data->>'referenceId' matching a consumed
--     assessment and data->>'debitAccountId' = '21300'
--   • assessment_contract_items rows with data->>'status' = 'consumed'
--   • assessment_contracts rows whose consumed_amount was advanced
--   • idempotency_keys rows with data->>'scope' = 'contract_assessment_consume'
--
-- Reverting those is a COMPENSATING REVERSAL, not a row removal: for every
-- original posting write a reversing wallet transaction and a reversing
-- ledger entry (Dr 41100 / Cr 21300 for the assessment consumption), and
-- restore the contract bucket. Removing rows would destroy the audit trail
-- and break the ledger-wallet reconciliation.
--
-- Run the reconciliation queries in the deployment notes BEFORE reverting, and
-- have a human approve any data reversal.
--
-- ── HOW TO APPLY ────────────────────────────────────────────────────────────
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f \
--     supabase/migrations/0048_printing_contracts_server_atomicity.rollback.sql
--
-- After applying, verify:
--   SELECT COUNT(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname = 'public'
--      AND p.proname IN ('consume_contract_assessment_atomic',
--                        'reserve_contract_assessment_atomic',
--                        'resolve_posting_account',
--                        'is_contract_date_in_closed_fy',
--                        'is_contract_date_in_closed_period',
--                        'current_erp_rpc_role');
--   -- expected: 0
--
-- The functions are dropped in dependency order (consume/reserve first, then
-- the helpers they call).
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.consume_contract_assessment_atomic(TEXT,TEXT,TEXT,DATE);
DROP FUNCTION IF EXISTS public.reserve_contract_assessment_atomic(TEXT,TEXT,JSONB,NUMERIC,DATE);
DROP FUNCTION IF EXISTS public.resolve_posting_account(TEXT);
DROP FUNCTION IF EXISTS public.is_contract_date_in_closed_period(DATE);
DROP FUNCTION IF EXISTS public.is_contract_date_in_closed_fy(DATE);
DROP FUNCTION IF EXISTS public.current_erp_rpc_role();

COMMIT;

-- =============================================================================
-- Optional, HUMAN-APPROVED, compensating reversal of consumption postings.
-- This block is intentionally NOT executed by this file: it is provided as a
-- template for a human-reviewed run against a verified set of assessments.
--
--   BEGIN;
--   WITH to_reverse AS (
--     SELECT wt.id AS wallet_tx_id,
--            le.id AS ledger_id,
--            wt.data->>'customer_id'  AS customer_id,
--            wt.data->>'assessment_item_id' AS item_id,
--            (wt.data->>'amount')::numeric AS amount,
--            wt.data->>'contract_number' AS contract_number
--     FROM public.wallet_transactions wt
--     JOIN public.ledger_entries le
--       ON le.id = 'LG-' || wt.id
--     WHERE wt.data->'data'->>'type' = 'ASSESSMENT_CONSUMPTION'
--       AND wt.data->>'contract_number' = 'PC-REPLACE-ME'
--       AND wt.data->>'consumed_at' >= '2026-01-01T00:00:00Z'
--   )
--   -- 1) reversing wallet transaction
--   -- 2) reversing ledger entry (Dr 41100 / Cr 21300)
--   -- 3) assessment item back to 'reserved' (only if still reversible)
--   -- 4) contract consumed_amount restored, reserved_amount restored
--   -- 5) customers.walletBalance incremented by the reversed amount
--   ;
--   COMMIT;
-- =============================================================================

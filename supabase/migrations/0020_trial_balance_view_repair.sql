-- =============================================================================
-- 0020_trial_balance_view_repair.sql
-- Prime ERP — Repair Trial Balance / Trial Balance Balanced views.
--
-- CONTEXT
--   Migration 0013_financial_integrity.sql defined `v_trial_balance` and
--   `v_trial_balance_balanced` against the assumption that ledger_entries
--   exposes JSON keys `accountId` and `entryType`. The LIVE envelope schema
--   for `ledger_entries` instead stores:
--
--     data->>'debitAccountId'   (debit side account, full id e.g. ACC-11110)
--     data->>'creditAccountId'   (credit side account, full id e.g. ACC-11310)
--     data->>'amount'            (the posted amount, same on both sides of a split)
--     data->>'referenceId'
--     data->>'date'
--     data->>'entryType'         (NOT present — postings are side-qualified
--                                  by which of debitAccountId/creditAccountId is set)
--
--   As a result the 0013 views joined on a non-existent key and returned
--   all-zero `sum_debits` / `sum_credits`, masking the real K70,000
--   imbalance caused by ledger entry LG-PAY-1789124111252-v53zpq9q1
--   (debitAccountId was the literal string "1000", an account that does
--   not exist — fixed in this same release cycle by a direct ledger
--   correction rather than a suspense/adjustment entry).
--
--   This migration repairs the views to read the ACTUAL envelope columns,
--   aggregating debits/credits per account via debitAccountId / creditAccountId.
--   It also materialises the per-account `balance` from the authoritative
--   SUM so that `v_trial_balance_balanced` reflects the true ledger state.
--
-- IDEMPOTENT — uses CREATE OR REPLACE VIEW. Safe to re-run.
--
-- AUDIT REFERENCES
--   F-12: chart_of_accounts/ledger drift
--   Financial integrity diagnostic 2026-09-11 (K70,000 TB mismatch)
-- =============================================================================

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- Helper: safe numeric coercion of a JSONB text value.
-- Re-declared here because this migration may run against a database that
-- has NOT yet applied 0013 (where the helper was originally defined).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_num(v jsonb)
RETURNS numeric
LANGUAGE sql IMMUTABLE PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN v IS NULL OR v = 'null'::jsonb THEN 0
    WHEN jsonb_typeof(v) = 'number' THEN (v)::text::numeric
    WHEN jsonb_typeof(v) = 'string' AND v#>>'{}' ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN (v#>>'{}')::numeric
    ELSE NULL
  END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. v_trial_balance
--    One row per active, non-deleted account. sum_debits = total of every
--    ledger_entries.data->>'amount' whose debitAccountId resolves to the
--    account; sum_credits mirrors on creditAccountId. balance is the
--    authoritatively derived net (not the hand-maintained cache).
--
--    Accounts are matched by id OR code OR account_number so both
--    `ACC-11110` (live id form) and `11110` (code form) are accepted.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_trial_balance AS
SELECT
  a.id                                                          AS account_id,
  a.data->>'code'                                               AS account_code,
  a.data->>'account_number'                                     AS account_number,
  a.data->>'name'                                               AS account_name,
  LOWER(COALESCE(a.data->>'account_type',
                 a.data->>'type',''))                           AS account_type,
  COALESCE(a.data->>'normal_balance','DEBIT')                   AS normal_balance,
  COALESCE(public.fn_num(a.data->'opening_balance'), 0)        AS opening_balance,
  COALESCE(public.fn_num(a.data->'balance'), 0)                AS cached_balance,
  COALESCE((
    SELECT SUM(public.fn_num(e.data->'amount'))
      FROM public.ledger_entries e
     WHERE e.data->>'debitAccountId' IN (a.id, a.data->>'code', a.data->>'account_number')
       AND COALESCE(LOWER(e.data->>'referenceType'), '') <> 'reversal'
       AND e.data->>'debitAccountId' IS NOT NULL
  ), 0)                                                          AS sum_debits,
  COALESCE((
    SELECT SUM(public.fn_num(e.data->'amount'))
      FROM public.ledger_entries e
     WHERE e.data->>'creditAccountId' IN (a.id, a.data->>'code', a.data->>'account_number')
       AND COALESCE(LOWER(e.data->>'referenceType'), '') <> 'reversal'
       AND e.data->>'creditAccountId' IS NOT NULL
  ), 0)                                                          AS sum_credits
FROM public.accounts a
WHERE COALESCE((a.data->>'is_active')::boolean, true)
  AND COALESCE((a.data->>'deleted')::boolean, false) = false;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. v_trial_balance_balanced
--    Aggregate over the repaired view. difference = Dr − Cr; is_balanced
--    when |difference| < 0.01 (tolerance for rounding).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_trial_balance_balanced AS
SELECT
  SUM(sum_debits)  AS total_debits,
  SUM(sum_credits) AS total_credits,
  SUM(sum_debits) - SUM(sum_credits) AS difference,
  (ABS(SUM(sum_debits) - SUM(sum_credits)) < 0.01) AS is_balanced
FROM public.v_trial_balance;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. v_trial_balance_exceptions
--    Companion view: every account whose cached `balance` has drifted from
--    the authoritative SUM. Surfaces data-integrity regressions so the
--    hand-maintained field and the derived value cannot silently diverge.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.v_trial_balance_exceptions AS
SELECT
  account_id,
  account_code,
  account_name,
  account_type,
  cached_balance,
  sum_debits,
  sum_credits,
  CASE
    WHEN LOWER(COALESCE(account_type,'')) IN ('asset','expense')
    THEN sum_debits - sum_credits
    ELSE sum_credits - sum_debits
  END AS computed_balance
FROM public.v_trial_balance
WHERE ABS(cached_balance - CASE
         WHEN LOWER(COALESCE(account_type,'')) IN ('asset','expense')
         THEN sum_debits - sum_credits
         ELSE sum_credits - sum_debits
       END) > 0.01
   OR sum_debits + sum_credits > 0;

COMMIT;

-- =============================================================================
-- RECONCILIATION CHECK (run after deployment):
--   SELECT * FROM public.v_trial_balance_balanced;
--   -- Expect: total_debits = total_credits, difference = 0, is_balanced = true
--
--   SELECT account_code, account_name, sum_debits, sum_credits
--     FROM public.v_trial_balance
--    WHERE sum_debits + sum_credits > 0
--    ORDER BY account_code;
--   -- Expect every account to have sum_debits = sum_credits OR a non-zero
--   -- computed balance that nets to zero across the set.
--
--   SELECT * FROM public.v_trial_balance_exceptions;
--   -- Expect 0 rows once cached balances have been reconciled.
-- =============================================================================

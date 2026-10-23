-- 0056_printing_contracts_void_status.sql
-- Allow the terminal `voided` state on printing contracts and their assessments.
--
-- WHY
--   Cancel (`cancelled`) stops a contract and releases only the remaining
--   reservation. Void is the compensating reversal: every consumed assessment
--   is credited back to the customer wallet with a reversing ledger entry, and
--   the contract/assessment end in the terminal `voided` state
--   (transactionService.voidPrintingContract).
--
--   The sync path stores rows as `{ id, data, version, updated_at }`, so the
--   authoritative status lives in `data->>'status'` and these legacy top-level
--   columns stay at their DEFAULT. The CHECK constraints are still aligned here
--   because they are part of the documented schema and any direct/legacy or
--   future server-side writer must be able to record the same terminal state.
--
-- IDEMPOTENT: safe to re-run. `ALTER TABLE IF EXISTS` + `DROP CONSTRAINT IF
-- EXISTS` make both steps no-ops when the objects are already in the target
-- shape (or the tables are absent on a partial database).

BEGIN;

-- ─── Contracts: draft … cancelled + voided ──────────────────────────────────
ALTER TABLE IF EXISTS public.assessment_contracts
    DROP CONSTRAINT IF EXISTS chk_assessment_contracts_status;

ALTER TABLE IF EXISTS public.assessment_contracts
    ADD CONSTRAINT chk_assessment_contracts_status CHECK (
        status IN (
            'draft',
            'pending_payment',
            'active',
            'suspended',
            'completed',
            'expired',
            'cancelled',
            'voided'
        )
    );

-- ─── Assessment items: reserved … cancelled + voided ────────────────────────
ALTER TABLE IF EXISTS public.assessment_contract_items
    DROP CONSTRAINT IF EXISTS chk_assessment_items_status;

ALTER TABLE IF EXISTS public.assessment_contract_items
    ADD CONSTRAINT chk_assessment_items_status CHECK (
        status IN (
            'reserved',
            'consumed',
            'released',
            'cancelled',
            'voided'
        )
    );

COMMIT;

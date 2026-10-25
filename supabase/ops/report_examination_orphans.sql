-- ============================================================================
-- report_examination_orphans.sql
--
-- READ-ONLY operator report for the Examination ledger orphans. Safe to run
-- repeatedly; it writes nothing.
--
-- Requires 0059 and 0060 to be applied.
--
-- Usage:
--   node supabase/ops/run-sql.mjs supabase/ops/report_examination_orphans.sql --each
-- ============================================================================

\echo '── Orphaned EXM ledger references (net AR impact) ───────────────────────'
SELECT
  invoice_number,
  ledger_rows,
  net_ar_impact,
  number_claimed,
  reconciliation_status,
  latest_decision,
  customers
FROM public.examination_orphan_ledger_reconciliation
ORDER BY ABS(net_ar_impact) DESC, invoice_number;

\echo '── Integrity findings ───────────────────────────────────────────────────'
SELECT finding, subject, occurrences, net_amount, severity, detail
FROM public.examination_integrity_findings
ORDER BY severity DESC, finding, subject;

\echo '── Recorded decisions ───────────────────────────────────────────────────'
SELECT subject, decision, linked_invoice_number, rationale, decided_by, decided_at
FROM public.examination_reconciliation_decisions
ORDER BY decided_at DESC;

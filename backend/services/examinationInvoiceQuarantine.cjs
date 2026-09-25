'use strict';

/**
 * examinationInvoiceQuarantine.cjs — QUARANTINE marker for the backend
 * examination-invoice creation path.
 *
 * READ BEFORE REMOVING OR EXTENDING ANYTHING HERE.
 *
 * The authoritative examination-invoice path is the frontend offline-first
 * flow:
 *   examinationBatchService.generateInvoice
 *     → persistExaminationInvoiceToFinance (mapExaminationPayloadToInvoice)
 *     → invoices store (IndexedDB) → sync gateway → Supabase `invoices`
 *        ({ id, data: { id, invoiceNumber, verificationToken, items, … } })
 *
 * This backend path (examinationService.generateInvoice/regenerateInvoice +
 * routes/examination.cjs + frontend/src embedded copy) is QUARANTINED because
 * it cannot satisfy the ERP invoice verification contract without a schema
 * change (which is out of scope):
 *   1. It writes to a separate store (backend SQLite/Postgres `invoices`
 *      table) that the Supabase-backed ERP list/verify model never reads.
 *   2. It mints EXM numbers on a divergent scheme (EXM-YEAR-######) outside
 *      the canonical invoices-namespace sequence.
 *   3. It never mints/persists `verificationToken`, so anything it creates
 *      can never pass public verification (number + token match).
 *
 * What this module does (intentionally narrow):
 *   - exposes the quarantine status/contract for callers and tests;
 *   - logs a loud deprecation warning whenever the quarantined path runs.
 *
 * What it does NOT do (explicit non-goals, pending separate review):
 *   - delete/retire the route or service (callers may still depend on reads);
 *   - mint verification tokens here (that would be a second token system);
 *   - bridge backend rows into Supabase (that would be a third persistence
 *     mechanism);
 *   - repair, renumber, delete, or rewrite any existing invoice records.
 */

const CANONICAL_EXAMINATION_INVOICE_PATH =
  'examinationBatchService.generateInvoice → persistExaminationInvoiceToFinance → invoices store → Supabase sync gateway';

const QUARANTINE_REASON =
  'Backend examination-invoice creation writes to a separate store, uses a divergent EXM numbering scheme, ' +
  'and never mints verificationToken, so its invoices are invisible to the ERP invoice list and can never ' +
  'satisfy public verification. Use the canonical frontend path instead.';

function examinationBackendInvoiceStatus() {
  return {
    quarantined: true,
    verificationUnsupported: true,
    canonicalPath: CANONICAL_EXAMINATION_INVOICE_PATH,
    reason: QUARANTINE_REASON,
  };
}

function warnExaminationBackendInvoiceUsage(operation) {
  const status = examinationBackendInvoiceStatus();
  console.warn(
    `[QUARANTINED] backend examination invoice path invoked (${operation || 'unknown operation'}). ` +
    `Invoices created here are NOT part of the canonical invoices namespace and do NOT support verification. ` +
    `Canonical path: ${status.canonicalPath}`
  );
  return status;
}

module.exports = {
  CANONICAL_EXAMINATION_INVOICE_PATH,
  QUARANTINE_REASON,
  examinationBackendInvoiceStatus,
  warnExaminationBackendInvoiceUsage,
};

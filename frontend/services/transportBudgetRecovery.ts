/**
 * transportBudgetRecovery.ts — Phase 9B missing-event reconciliation.
 *
 * A committed authoritative source must not permanently lose its Transport
 * Budget event merely because a post-commit fire-and-forget producer failed
 * (crash, kill, append/queue failure). This module is the narrow,
 * deterministic repair path for exactly that window — nothing broader:
 *
 * - Enumerates persisted authoritative source rows (never reconstructs
 *   economics from current policy/config).
 * - Derives the deterministic expected event key per family.
 * - Re-invokes the EXISTING producer only when the event is absent.
 * - Never recalculates historical rates, never mutates ledger rows, never
 *   fabricates targets, never scans on a timer.
 *
 * Family coverage:
 *   SALES_ALLOCATION      <- recognized sales + posted non-mirror invoices
 *   REVERSAL              <- Voided sales + Voided-spelling invoices
 *                            (Cancelled invoices stay with the existing
 *                            transportBudgetVoidRecovery scanner; reused,
 *                            never duplicated here)
 *   INBOUND_CONSUMPTION   <- purchases.landingConsumption GRN events joined
 *                            to their goodsReceipts row (defer when absent)
 *   CONSUMPTION_CORRECTION<- purchases.landingConsumption CORRECTION rows
 *                            (parent resolution stays inside the producer;
 *                            missing parent defers there)
 *   OUTBOUND_CONSUMPTION  <- POSTED non-reversal transportExpenses rows
 *   CONSUMPTION_REVERSAL  <- VOIDED non-reversal expenses joined to their
 *                            POSTED reversal row for the void timestamp
 *                            (absent reversal row defers: no timestamp input
 *                            persists anywhere else)
 *
 * Trigger: requestTransportBudgetReconciliation() — module-level
 * single-flight, fire-and-forget, never throws (AuthContext boot finally,
 * same shape as the void-recovery trigger; also safe for manual/admin
 * invocation). Repeated runs are stable: present events dedupe, conflicts
 * are logged once per run and never retried blindly.
 */

import { dbService } from './db';
import { logger } from './logger';
import {
  allocateForPostedSale,
  allocateForPostedInvoice,
  defaultSalesAllocationDeps,
  resolveMirrorInvoiceIdForSale,
  isMirrorInvoice,
} from './transportBudgetSalesAllocation';
import { produceVoidReversalSafely } from './transportBudgetVoidReversal';
import {
  produceInboundConsumptionForGrn,
  defaultInboundConsumptionDeps,
} from './transportBudgetInboundConsumption';
import {
  produceConsumptionCorrectionForLandingCorrection,
  defaultConsumptionCorrectionDeps,
} from './transportBudgetConsumptionCorrection';
import {
  produceOutboundConsumptionForExpense,
  defaultOutboundConsumptionDeps,
} from './transportBudgetOutboundConsumption';
import {
  produceOutboundReversalsForVoid,
  defaultOutboundReversalDeps,
} from './transportBudgetOutboundReversal';
import {
  transportBudgetRepository,
  consumptionReversalIdempotencyKey,
} from './repositories/transportBudgetRepository';
import type { TransportBudgetEvent } from '../types/transportBudget';
import {
  isRecognizedSaleStatus,
  isPostedInvoiceStatus,
  isCreditNoteStatus,
} from '../utils/revenueRecognition';

export interface TransportBudgetRecoveryFamilySummary {
  scanned: number;
  recreated: number;
  alreadyPresent: number;
  deferred: number;
  failed: number;
}

export interface TransportBudgetRecoverySummary {
  salesAllocation: TransportBudgetRecoveryFamilySummary;
  reversal: TransportBudgetRecoveryFamilySummary;
  inboundConsumption: TransportBudgetRecoveryFamilySummary;
  consumptionCorrection: TransportBudgetRecoveryFamilySummary;
  outboundConsumption: TransportBudgetRecoveryFamilySummary;
  consumptionReversal: TransportBudgetRecoveryFamilySummary;
}

export interface TransportBudgetRecoveryDeps {
  listSales(): Promise<any[]>;
  listInvoices(): Promise<any[]>;
  listPurchases(): Promise<any[]>;
  listGoodsReceipts(): Promise<any[]>;
  listTransportExpenses(): Promise<any[]>;
  findBudgetEventByKey(key: string): Promise<TransportBudgetEvent | null>;
  getInvoiceById(id: string): Promise<any | null>;
  resolveEconomicKeyForSale(saleId: string): Promise<string | null>;
  isMirrorInvoiceDoc(invoice: any): Promise<boolean>;
}

const emptyFamily = (): TransportBudgetRecoveryFamilySummary => ({
  scanned: 0,
  recreated: 0,
  alreadyPresent: 0,
  deferred: 0,
  failed: 0,
});

const emptySummary = (): TransportBudgetRecoverySummary => ({
  salesAllocation: emptyFamily(),
  reversal: emptyFamily(),
  inboundConsumption: emptyFamily(),
  consumptionCorrection: emptyFamily(),
  outboundConsumption: emptyFamily(),
  consumptionReversal: emptyFamily(),
});

export const defaultTransportBudgetRecoveryDeps: TransportBudgetRecoveryDeps = {
  async listSales() {
    try {
      return (await dbService.getAll<any>('sales' as never)) || [];
    } catch {
      return [];
    }
  },
  async listInvoices() {
    try {
      return (await dbService.getAll<any>('invoices' as never)) || [];
    } catch {
      return [];
    }
  },
  async listPurchases() {
    try {
      return (await dbService.getAll<any>('purchases' as never)) || [];
    } catch {
      return [];
    }
  },
  async listGoodsReceipts() {
    try {
      return (await dbService.getAll<any>('goodsReceipts' as never)) || [];
    } catch {
      return [];
    }
  },
  async listTransportExpenses() {
    try {
      return (await dbService.getAll<any>('transportExpenses' as never)) || [];
    } catch {
      return [];
    }
  },
  async findBudgetEventByKey(key: string) {
    try {
      return await transportBudgetRepository.findTransportBudgetEventByIdempotencyKey(
        key,
      );
    } catch {
      return null;
    }
  },
  async getInvoiceById(id: string) {
    return defaultSalesAllocationDeps.getInvoice(id);
  },
  async resolveEconomicKeyForSale(saleId: string) {
    try {
      return await resolveMirrorInvoiceIdForSale(
        defaultSalesAllocationDeps,
        saleId,
      );
    } catch {
      return null;
    }
  },
  async isMirrorInvoiceDoc(invoice: any) {
    try {
      return await isMirrorInvoice(defaultSalesAllocationDeps, invoice);
    } catch {
      return false;
    }
  },
};

async function reconcileSalesAllocations(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.salesAllocation;
  let sales: any[] = [];
  let invoices: any[] = [];
  try {
    [sales, invoices] = await Promise.all([
      deps.listSales(),
      deps.listInvoices(),
    ]);
  } catch (err) {
    logger.error('[TransportBudget] recovery sales/invoices list failed:', err);
    fam.failed += 1;
    return;
  }
  for (const sale of sales || []) {
    let saleId: string;
    try {
      saleId = String((sale as { id?: unknown })?.id || '').trim();
      if (!saleId || !isRecognizedSaleStatus((sale as { status?: unknown })?.status)) {
        continue;
      }
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      const mirrorId = await deps.resolveEconomicKeyForSale(saleId);
      const economicKey = (mirrorId || saleId).trim();
      const existing = await deps.findBudgetEventByKey(
        `SALES_ALLOCATION:${economicKey}`,
      );
      if (existing && existing.kind === 'SALES_ALLOCATION') {
        fam.alreadyPresent += 1;
        continue;
      }
      if (existing) {
        // A non-allocation row under an allocation key: manual review, never
        // overwrite (append-only ledger cannot repair this either).
        logger.error(
          `[TransportBudget] recovery SALES_ALLOCATION key collision (sale ${saleId}); deferring.`,
        );
        fam.deferred += 1;
        continue;
      }
      const outcome = await allocateForPostedSale(
        defaultSalesAllocationDeps,
        sale,
        mirrorId,
      );
      if (outcome.status === 'allocated') fam.recreated += 1;
      else fam.deferred += 1;
    } catch (err) {
      // Conflicts (changed economics) land here: logged, never retried blindly.
      logger.error(
        `[TransportBudget] recovery SALES_ALLOCATION failed (sale ${saleId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
  for (const invoice of invoices || []) {
    let invoiceId: string;
    try {
      invoiceId = String((invoice as { id?: unknown })?.id || '').trim();
      const status = (invoice as { status?: unknown })?.status;
      if (!invoiceId || !isPostedInvoiceStatus(status)) continue;
      if (isCreditNoteStatus(status)) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await deps.isMirrorInvoiceDoc(invoice)) continue;
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      const existing = await deps.findBudgetEventByKey(
        `SALES_ALLOCATION:${invoiceId}`,
      );
      if (existing && existing.kind === 'SALES_ALLOCATION') {
        fam.alreadyPresent += 1;
        continue;
      }
      if (existing) {
        logger.error(
          `[TransportBudget] recovery SALES_ALLOCATION key collision (invoice ${invoiceId}); deferring.`,
        );
        fam.deferred += 1;
        continue;
      }
      const outcome = await allocateForPostedInvoice(
        defaultSalesAllocationDeps,
        invoice,
      );
      if (outcome.status === 'allocated') fam.recreated += 1;
      else fam.deferred += 1;
    } catch (err) {
      logger.error(
        `[TransportBudget] recovery SALES_ALLOCATION failed (invoice ${invoiceId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
}

async function reconcileSaleAndBackendVoids(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.reversal;
  let sales: any[] = [];
  let invoices: any[] = [];
  try {
    [sales, invoices] = await Promise.all([
      deps.listSales(),
      deps.listInvoices(),
    ]);
  } catch (err) {
    logger.error('[TransportBudget] recovery void scan list failed:', err);
    fam.failed += 1;
    return;
  }
  // Voided sales (frontend voidSale AND backend DELETE share this status).
  // Mirror-aware: the allocation lives under the mirror invoice id when one
  // exists; a still-posted mirror means revenue stands and nothing reverses.
  for (const sale of sales || []) {
    let saleId: string;
    try {
      saleId = String((sale as { id?: unknown })?.id || '').trim();
      if (!saleId || String((sale as { status?: unknown })?.status) !== 'Voided') {
        continue;
      }
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      const mirrorId = await deps.resolveEconomicKeyForSale(saleId);
      if (mirrorId) {
        const mirror = await deps.getInvoiceById(mirrorId);
        if (mirror && isPostedInvoiceStatus((mirror as { status?: unknown })?.status)) {
          fam.deferred += 1;
          continue;
        }
      }
      const economicKey = (mirrorId || saleId).trim();
      const allocation = await deps.findBudgetEventByKey(
        `SALES_ALLOCATION:${economicKey}`,
      );
      if (!allocation || allocation.kind !== 'SALES_ALLOCATION') {
        fam.deferred += 1;
        continue;
      }
      const reversal = await deps.findBudgetEventByKey(
        `REVERSAL:${economicKey}:VOID`,
      );
      if (reversal) {
        fam.alreadyPresent += 1;
        continue;
      }
      const outcome = await produceVoidReversalSafely({ id: economicKey });
      if (outcome.status === 'appended') {
        if ((outcome as { deduplicated?: boolean }).deduplicated) {
          fam.alreadyPresent += 1;
        } else {
          fam.recreated += 1;
        }
      } else {
        fam.deferred += 1;
      }
    } catch (err) {
      logger.error(
        `[TransportBudget] recovery REVERSAL failed (sale ${saleId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
  // Backend-spelling invoice voids ('Voided'; the existing void-recovery
  // scanner owns 'Cancelled'). Same primitive, same deterministic key.
  for (const invoice of invoices || []) {
    let invoiceId: string;
    try {
      invoiceId = String((invoice as { id?: unknown })?.id || '').trim();
      if (!invoiceId || String((invoice as { status?: unknown })?.status) !== 'Voided') {
        continue;
      }
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      const allocation = await deps.findBudgetEventByKey(
        `SALES_ALLOCATION:${invoiceId}`,
      );
      if (!allocation || allocation.kind !== 'SALES_ALLOCATION') {
        fam.deferred += 1;
        continue;
      }
      const reversal = await deps.findBudgetEventByKey(
        `REVERSAL:${invoiceId}:VOID`,
      );
      if (reversal) {
        fam.alreadyPresent += 1;
        continue;
      }
      const outcome = await produceVoidReversalSafely({ id: invoiceId });
      if (outcome.status === 'appended') {
        if ((outcome as { deduplicated?: boolean }).deduplicated) {
          fam.alreadyPresent += 1;
        } else {
          fam.recreated += 1;
        }
      } else {
        fam.deferred += 1;
      }
    } catch (err) {
      logger.error(
        `[TransportBudget] recovery REVERSAL failed (invoice ${invoiceId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
}

async function reconcileInboundConsumption(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.inboundConsumption;
  let purchases: any[] = [];
  let receipts: any[] = [];
  try {
    [purchases, receipts] = await Promise.all([
      deps.listPurchases(),
      deps.listGoodsReceipts(),
    ]);
  } catch (err) {
    logger.error('[TransportBudget] recovery inbound list failed:', err);
    fam.failed += 1;
    return;
  }
  const grnById = new Map<string, any>();
  for (const grn of receipts || []) {
    try {
      const id = String((grn as { id?: unknown })?.id || '').trim();
      if (id) grnById.set(id, grn);
    } catch {
      continue;
    }
  }
  for (const purchase of purchases || []) {
    let events: any[];
    try {
      const consumption = (purchase as { landingConsumption?: unknown })
        ?.landingConsumption;
      if (!Array.isArray(consumption)) continue;
      events = consumption.filter(
        (e: any) =>
          e && (e as { kind?: unknown }).kind === 'GRN' && !(e as { billId?: unknown }).billId,
      );
    } catch {
      continue;
    }
    for (const event of events) {
      const landingCostId = String(event?.landingCostId || '').trim();
      const grnId = String(event?.grnId || '').trim();
      if (!landingCostId || !grnId) continue;
      fam.scanned += 1;
      try {
        const key = `INBOUND_CONSUMPTION:${landingCostId}:${grnId}`;
        const existing = await deps.findBudgetEventByKey(key);
        if (existing && existing.kind === 'INBOUND_CONSUMPTION') {
          fam.alreadyPresent += 1;
          continue;
        }
        if (existing) {
          logger.error(
            `[TransportBudget] recovery INBOUND key collision (${key}); deferring.`,
          );
          fam.deferred += 1;
          continue;
        }
        // The GRN row carries the authoritative date + Freight category
        // join. Without it the scope cannot be safely re-derived: defer.
        const grn = grnById.get(grnId);
        if (!grn) {
          fam.deferred += 1;
          continue;
        }
        const landingCosts = Array.isArray((grn as { landingCosts?: unknown })?.landingCosts)
          ? (grn as { landingCosts: unknown[] }).landingCosts
          : [];
        const outcome = await produceInboundConsumptionForGrn(
          defaultInboundConsumptionDeps,
          {
            grnId,
            grnDate: (grn as { date?: unknown })?.date,
            landingCosts,
            events: [event],
          } as never,
        );
        if (outcome.produced.length > 0) fam.recreated += 1;
        else if (outcome.deduplicated.length > 0) fam.alreadyPresent += 1;
        else fam.deferred += 1;
      } catch (err) {
        logger.error(
          `[TransportBudget] recovery INBOUND failed (${landingCostId}:${grnId}):`,
          err,
        );
        fam.failed += 1;
      }
    }
  }
}

async function reconcileConsumptionCorrections(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.consumptionCorrection;
  let purchases: any[] = [];
  try {
    purchases = await deps.listPurchases();
  } catch (err) {
    logger.error('[TransportBudget] recovery correction list failed:', err);
    fam.failed += 1;
    return;
  }
  for (const purchase of purchases || []) {
    let events: any[];
    try {
      const consumption = (purchase as { landingConsumption?: unknown })
        ?.landingConsumption;
      if (!Array.isArray(consumption)) continue;
      events = consumption.filter(
        (e: any) => e && (e as { kind?: unknown }).kind === 'CORRECTION',
      );
    } catch {
      continue;
    }
    for (const correction of events) {
      const landingCostId = String(correction?.landingCostId || '').trim();
      const grnId = String(correction?.grnId || '').trim();
      if (!landingCostId || !grnId) continue;
      fam.scanned += 1;
      try {
        // Parent resolution stays inside the producer (missing or ambiguous
        // parent defers there).
        const outcome = await produceConsumptionCorrectionForLandingCorrection(
          defaultConsumptionCorrectionDeps,
          { correction } as never,
        );
        if (outcome.produced.length > 0) fam.recreated += 1;
        else if (outcome.deduplicated.length > 0) fam.alreadyPresent += 1;
        else fam.deferred += 1;
      } catch (err) {
        logger.error(
          `[TransportBudget] recovery CORRECTION failed (${landingCostId}:${grnId}):`,
          err,
        );
        fam.failed += 1;
      }
    }
  }
}

async function reconcileOutboundConsumption(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.outboundConsumption;
  let expenses: any[] = [];
  try {
    expenses = await deps.listTransportExpenses();
  } catch (err) {
    logger.error('[TransportBudget] recovery outbound list failed:', err);
    fam.failed += 1;
    return;
  }
  for (const expense of expenses || []) {
    let expenseId: string;
    try {
      expenseId = String((expense as { id?: unknown })?.id || '').trim();
      if (
        !expenseId ||
        String((expense as { status?: unknown })?.status) !== 'POSTED' ||
        (expense as { isReversal?: unknown })?.isReversal === true ||
        (expense as { reversesExpenseId?: unknown })?.reversesExpenseId != null
      ) {
        continue;
      }
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      // Re-invoking the producer for the whole expense converges: present
      // lines dedupe by key, missing lines are created, nothing is summed.
      const outcome = await produceOutboundConsumptionForExpense(
        defaultOutboundConsumptionDeps,
        { transportExpense: expense } as never,
      );
      if (outcome.produced.length > 0) fam.recreated += outcome.produced.length;
      else if (outcome.deduplicated.length > 0) {
        fam.alreadyPresent += outcome.deduplicated.length;
      } else if (outcome.failed.length > 0) {
        fam.failed += 1;
      } else {
        fam.deferred += 1;
      }
    } catch (err) {
      logger.error(
        `[TransportBudget] recovery OUTBOUND failed (expense ${expenseId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
}

async function reconcileConsumptionReversals(
  deps: TransportBudgetRecoveryDeps,
  summary: TransportBudgetRecoverySummary,
): Promise<void> {
  const fam = summary.consumptionReversal;
  let expenses: any[] = [];
  try {
    expenses = await deps.listTransportExpenses();
  } catch (err) {
    logger.error('[TransportBudget] recovery reversal list failed:', err);
    fam.failed += 1;
    return;
  }
  const byId = new Map<string, any>();
  for (const expense of expenses || []) {
    try {
      const id = String((expense as { id?: unknown })?.id || '').trim();
      if (id) byId.set(id, expense);
    } catch {
      continue;
    }
  }
  for (const expense of expenses || []) {
    let expenseId: string;
    try {
      expenseId = String((expense as { id?: unknown })?.id || '').trim();
      if (
        !expenseId ||
        String((expense as { status?: unknown })?.status) !== 'VOIDED' ||
        (expense as { isReversal?: unknown })?.isReversal === true ||
        (expense as { reversesExpenseId?: unknown })?.reversesExpenseId != null
      ) {
        continue;
      }
    } catch {
      continue;
    }
    fam.scanned += 1;
    try {
      // The void timestamp persists ONLY on the reversal row. Without it
      // no reversal timestamp exists anywhere: defer, never invent one.
      const reversalRow = [...byId.values()].find(
        (row: any) =>
          row &&
          (row as { isReversal?: unknown })?.isReversal === true &&
          String((row as { reversesExpenseId?: unknown })?.reversesExpenseId || '') ===
            expenseId &&
          String((row as { status?: unknown })?.status) === 'POSTED',
      );
      if (!reversalRow) {
        fam.deferred += 1;
        continue;
      }
      const voidOccurredAt = (reversalRow as { occurredAt?: unknown })?.occurredAt;
      if (typeof voidOccurredAt !== 'string' || !voidOccurredAt) {
        fam.deferred += 1;
        continue;
      }
      const outcome = await produceOutboundReversalsForVoid(
        defaultOutboundReversalDeps,
        { voidedExpense: expense, voidOccurredAt } as never,
      );
      if (outcome.produced.length > 0) fam.recreated += outcome.produced.length;
      else if (outcome.deduplicated.length > 0) {
        fam.alreadyPresent += outcome.deduplicated.length;
      } else if (outcome.failed.length > 0) {
        fam.failed += 1;
      } else {
        fam.deferred += 1;
      }
    } catch (err) {
      logger.error(
        `[TransportBudget] recovery CONS_REVERSAL failed (expense ${expenseId}):`,
        err,
      );
      fam.failed += 1;
    }
  }
}

/**
 * Run the full missing-event reconciliation. Never throws: every family
 * scan is isolated, every item is guarded, and the summary reports
 * deferrals/failures for operator review instead of retrying blindly.
 */
export async function reconcileTransportBudget(
  deps: TransportBudgetRecoveryDeps = defaultTransportBudgetRecoveryDeps,
): Promise<TransportBudgetRecoverySummary> {
  const summary = emptySummary();
  try {
    await reconcileSalesAllocations(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery sales scan failed:', err);
    summary.salesAllocation.failed += 1;
  }
  try {
    await reconcileSaleAndBackendVoids(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery void scan failed:', err);
    summary.reversal.failed += 1;
  }
  try {
    await reconcileInboundConsumption(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery inbound scan failed:', err);
    summary.inboundConsumption.failed += 1;
  }
  try {
    await reconcileConsumptionCorrections(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery correction scan failed:', err);
    summary.consumptionCorrection.failed += 1;
  }
  try {
    await reconcileOutboundConsumption(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery outbound scan failed:', err);
    summary.outboundConsumption.failed += 1;
  }
  try {
    await reconcileConsumptionReversals(deps, summary);
  } catch (err) {
    logger.error('[TransportBudget] recovery cons-reversal scan failed:', err);
    summary.consumptionReversal.failed += 1;
  }
  return summary;
}

let activeRecovery: Promise<TransportBudgetRecoverySummary> | null = null;

/**
 * Single-flight, fire-and-forget entry point (boot + manual/admin use).
 * Shares one in-flight scan across concurrent triggers; errors are logged
 * and swallowed so startup/sync can never break. Safe to invoke repeatedly:
 * present events dedupe and the summary is stable across runs.
 */
export function requestTransportBudgetReconciliation(): void {
  if (!activeRecovery) {
    activeRecovery = reconcileTransportBudget()
      .catch((err) => {
        logger.error('[TransportBudget] recovery scan failed:', err);
        return emptySummary();
      })
      .finally(() => {
        activeRecovery = null;
      });
  }
  activeRecovery.catch(() => {});
}

export type { TransportBudgetEvent };

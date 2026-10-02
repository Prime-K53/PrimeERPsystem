/**
 * transportBudgetSalesAllocation.ts — Phase 5: Sales Allocation producer.
 *
 * The FIRST and ONLY phase permitted to create SALES_ALLOCATION transport
 * budget events. No reversals, no consumptions, no reporting, no journals.
 *
 * Frozen contract:
 *   eligibleBase     = roundMoney(Number(persistedRecord.totalAmount))
 *   allocationAmount = roundMoney(eligibleBase * allocationRatePercent / 100)
 *                      (rounded ONCE, at the end; the rate is never rounded)
 *   economicKey      = convertedInvoiceId ?? saleId
 *   idempotencyKey   = `SALES_ALLOCATION:${economicKey}`
 *
 * Design rules:
 * - The persisted posted record is authoritative: the base comes from its
 *   `totalAmount` (never recomputed from lines), the rate is resolved for
 *   the document's BUSINESS date (never today/sync/replay time), and the
 *   stored event is frozen (server/ledger validate; nothing recalculates).
 * - The producer runs AFTER the sale/invoice commit (post-commit,
 *   fire-and-forget from the posting funnels, same pattern as the referral
 *   hooks). It never blocks posting and never rolls a committed sale back:
 *   allocation failures are logged loudly (never swallowed) and stay
 *   retryable through the idempotent repository + durable queue.
 * - Exactly-once across pathways comes from the economic identity, not from
 *   call-site discipline: POS sale wins, its mirror invoice is suppressed;
 *   order→invoice allocates once on the invoice; repeats dedupe on the
 *   Phase 4 idempotency layer (in-memory mutex is NOT relied upon).
 * - No GL journals, no COGS/WAC/inventory/revenue/AR changes, no customer
 *   payload changes. The K15,000 on a K500,000 sale exists ONLY as an
 *   internal Transport Budget event.
 */

import { dbService } from './db';
import { logger } from './logger';
import { roundMoney } from '../utils/roundingUtils';
import {
  isCreditNoteStatus,
  isPostedInvoiceStatus,
  isRecognizedSaleStatus,
} from '../utils/revenueRecognition';
import { resolveTransportBudgetRate } from '../utils/transportBudgetPolicy';
import {
  TransportBudgetRepository,
  transportBudgetRepository,
  type TransportBudgetAppendResult,
} from './repositories/transportBudgetRepository';
import type { Sale, Invoice } from '../types';
import type { TransportBudgetEvent } from '../types/transportBudget';

export class TransportBudgetAllocationError extends Error {
  readonly code:
    | 'INVALID_BASE'
    | 'INVALID_POLICY'
    | 'INVALID_DATE'
    | 'INVALID_IDENTITY';

  constructor(
    code: TransportBudgetAllocationError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'TransportBudgetAllocationError';
    this.code = code;
  }
}

export type SalesAllocationStatus =
  | 'allocated'
  | 'skipped';

export type SalesAllocationSkipReason =
  | 'not-recognized'
  | 'mirror-invoice'
  | 'credit-note'
  | 'policy-missing'
  | 'policy-disabled'
  | 'zero-amount';

export interface SalesAllocationOutcome {
  status: SalesAllocationStatus;
  /** Present when an event was created or an existing one deduplicated. */
  event?: TransportBudgetEvent;
  /** True when the call resolved to a pre-existing event (retry path). */
  deduplicated?: boolean;
  /** Present when no event was created. */
  reason?: SalesAllocationSkipReason;
}

/** Injectable seams (hermetic tests supply fakes; production uses defaults). */
export interface SalesAllocationDeps {
  /** Returns the stored transport budget policy (or undefined when absent). */
  getPolicy(): unknown;
  getSale(id: string): Promise<Sale | null>;
  getInvoice(id: string): Promise<Invoice | null>;
  /** Lookup by invoice `reference` (sale→mirror resolution fallback). */
  findInvoiceByReference(reference: string): Promise<Invoice | null>;
  repository: Pick<TransportBudgetRepository, 'appendTransportBudgetEvent'>;
  nowIso(): string;
}

/**
 * Established CompanyConfig loading path for posting-time producers: the
 * synchronous `nexus_company_config` localStorage read (same pattern as
 * `getCompanyConfig()` in transactions/_internal, used throughout
 * transactionService postings). No async I/O, no network, offline-safe.
 */
const readStoredTransportBudgetPolicy = (): unknown => {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem('nexus_company_config');
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as {
      transportBudgetPolicy?: unknown;
    };
    return parsed?.transportBudgetPolicy;
  } catch {
    return undefined;
  }
};

export const defaultSalesAllocationDeps: SalesAllocationDeps = {
  getPolicy: readStoredTransportBudgetPolicy,
  async getSale(id: string): Promise<Sale | null> {
    if (!id) return null;
    try {
      return (await dbService.get<Sale>('sales', String(id))) ?? null;
    } catch {
      return null;
    }
  },
  async getInvoice(id: string): Promise<Invoice | null> {
    if (!id) return null;
    try {
      return (await dbService.get<Invoice>('invoices', String(id))) ?? null;
    } catch {
      return null;
    }
  },
  async findInvoiceByReference(reference: string): Promise<Invoice | null> {
    const needle = String(reference || '').trim();
    if (!needle) return null;
    try {
      const all = (await dbService.getAll<Invoice>('invoices')) || [];
      return (
        all.find((entry) => String(entry?.reference || '') === needle) ?? null
      );
    } catch {
      return null;
    }
  },
  repository: transportBudgetRepository,
  nowIso: () => new Date().toISOString(),
};

/** Exact notes template written ONLY by processSale mirror creation. */
const POS_MIRROR_NOTES_PATTERN = /pos sale - source:/i;

/**
 * Consolidated POS-mirror check using the established detector signals
 * (cf. revenueAnalysisService.isPosMirrorInvoice): an explicit sale
 * conversion marker, a persisted sale backing this invoice id/reference, or
 * the processSale mirror notes template. A genuine primary invoice has none
 * of these and is never suppressed.
 */
export async function isMirrorInvoice(
  deps: SalesAllocationDeps,
  invoice: Invoice,
): Promise<boolean> {
  const conversionType = String(
    (invoice as { conversionDetails?: { sourceType?: unknown } })
      ?.conversionDetails?.sourceType || '',
  )
    .trim()
    .toLowerCase();
  if (conversionType === 'sale') return true;

  const invoiceId = String(invoice?.id || '').trim();
  const reference = String(
    (invoice as { reference?: unknown })?.reference || '',
  ).trim();
  if (invoiceId) {
    const saleById = await deps.getSale(invoiceId);
    if (saleById) return true;
  }
  if (reference && reference !== invoiceId) {
    const saleByRef = await deps.getSale(reference);
    if (saleByRef) return true;
  }
  const notes = String(
    (invoice as { notes?: unknown })?.notes || '',
  );
  if (POS_MIRROR_NOTES_PATTERN.test(notes)) return true;
  return false;
}

/**
 * Resolve the mirror invoice id created for a posted sale (processSale
 * always persists one: id = sale.id when free, else a generated POS/INV
 * number, with `reference` = sale.id). Prefers the exact id handed over by
 * the posting funnel; falls back to persisted lookups.
 */
export async function resolveMirrorInvoiceIdForSale(
  deps: SalesAllocationDeps,
  saleId: string,
  knownMirrorInvoiceId?: string | null,
): Promise<string | null> {
  const direct = String(knownMirrorInvoiceId || '').trim();
  if (direct) return direct;
  const id = String(saleId || '').trim();
  if (!id) return null;
  const byId = await deps.getInvoice(id);
  if (
    byId &&
    (String((byId as { reference?: unknown })?.reference || '') === id ||
      POS_MIRROR_NOTES_PATTERN.test(
        String((byId as { notes?: unknown })?.notes || ''),
      ))
  ) {
    return String(byId.id);
  }
  const byRef = await deps.findInvoiceByReference(id);
  return byRef ? String(byRef.id) : null;
}

/** Extract the YYYY-MM-DD business date from a persisted document date. */
const toBusinessDate = (value: unknown): string => {
  const raw = String(value || '').trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) {
    throw new TransportBudgetAllocationError(
      'INVALID_DATE',
      `Cannot derive a business date from document date ${JSON.stringify(raw)}.`,
    );
  }
  return match[1];
};

interface AllocationCoreInput {
  /** Frozen economic identity: convertedInvoiceId ?? saleId. */
  economicId: string;
  totalAmountRaw: unknown;
  businessDateRaw: unknown;
}

const appendSalesAllocation = async (
  deps: SalesAllocationDeps,
  input: AllocationCoreInput,
): Promise<SalesAllocationOutcome> => {
  const economicId = String(input.economicId || '').trim();
  if (!economicId) {
    throw new TransportBudgetAllocationError(
      'INVALID_IDENTITY',
      'Cannot allocate without an economic sale/invoice identity.',
    );
  }

  // 1. Eligible base: persisted totalAmount ONLY (never lines, never payments).
  const rawBase = Number(input.totalAmountRaw);
  if (!Number.isFinite(rawBase)) {
    throw new TransportBudgetAllocationError(
      'INVALID_BASE',
      `Persisted totalAmount is not a finite monetary number (${String(input.totalAmountRaw)}); refusing to invent a base.`,
    );
  }
  const eligibleBase = roundMoney(rawBase);

  // 2. Historical rate for the DOCUMENT business date (never today/sync time).
  const businessDate = toBusinessDate(input.businessDateRaw);
  const resolution = resolveTransportBudgetRate(
    deps.getPolicy(),
    businessDate,
  );
  if (resolution.status === 'missing') {
    return { status: 'skipped', reason: 'policy-missing' };
  }
  if (resolution.status === 'disabled') {
    return { status: 'skipped', reason: 'policy-disabled' };
  }
  if (resolution.status !== 'enabled' || typeof resolution.rate !== 'number') {
    // Invalid policy/configuration fails loudly per the resolver contract:
    // never silently invent a rate or fall back to a default.
    throw new TransportBudgetAllocationError(
      'INVALID_POLICY',
      `Transport budget policy is invalid for business date ${businessDate}; allocation refused.`,
    );
  }
  // The resolved historical rate is stored EXACTLY (never rounded, never
  // re-resolved later). Validity (0..100, ≤4dp) is enforced by Phase 4.
  const allocationRatePercent = resolution.rate;

  // 3. Single final rounding. Zero emits no event.
  const allocationAmount = roundMoney(
    (eligibleBase * allocationRatePercent) / 100,
  );
  if (!(allocationAmount > 0)) {
    return { status: 'skipped', reason: 'zero-amount' };
  }

  // 4. Frozen event shape (Phase 4 contract). No method/provider/journal
  // linkage is fabricated; no GL is touched.
  const result: TransportBudgetAppendResult =
    await deps.repository.appendTransportBudgetEvent({
      kind: 'SALES_ALLOCATION',
      idempotencyKey: `SALES_ALLOCATION:${economicId}`,
      sourceEventId: economicId,
      sourceAmount: eligibleBase,
      allocationRatePercent,
      amount: allocationAmount,
      method: null,
      providerId: null,
      reversesEventId: null,
      businessDate,
      occurredAt: deps.nowIso(),
    });
  return {
    status: 'allocated',
    event: result.event,
    deduplicated: result.deduplicated,
  };
};

/**
 * Allocate for a committed/postable sale. The sale path OWNS the economic
 * event (POS sale wins): the key prefers the converted/mirror invoice id
 * when one exists, else the sale id.
 */
export async function allocateForPostedSale(
  deps: SalesAllocationDeps,
  sale: Sale,
  mirrorInvoiceId?: string | null,
): Promise<SalesAllocationOutcome> {
  if (!sale || !isRecognizedSaleStatus(sale.status)) {
    return { status: 'skipped', reason: 'not-recognized' };
  }
  // Prefer the persisted record (authoritative totalAmount/business date).
  const persisted = (await deps.getSale(String(sale.id))) ?? sale;
  const mirrorId = await resolveMirrorInvoiceIdForSale(
    deps,
    String(sale.id),
    mirrorInvoiceId,
  );
  const economicId = mirrorId || String(persisted.id);
  return appendSalesAllocation(deps, {
    economicId,
    totalAmountRaw: (persisted as Sale).totalAmount,
    businessDateRaw: (persisted as Sale).date,
  });
}

/**
 * Allocate for a posted invoice. Order→invoice conversions allocate here,
 * exactly once, on the invoice. POS mirror invoices are suppressed (the
 * sale path owns them); drafts/voids/cancelled and credit notes never
 * allocate.
 */
export async function allocateForPostedInvoice(
  deps: SalesAllocationDeps,
  invoice: Invoice,
): Promise<SalesAllocationOutcome> {
  if (!invoice) {
    return { status: 'skipped', reason: 'not-recognized' };
  }
  if (isCreditNoteStatus(invoice.status)) {
    return { status: 'skipped', reason: 'credit-note' };
  }
  if (!isPostedInvoiceStatus(invoice.status)) {
    return { status: 'skipped', reason: 'not-recognized' };
  }
  if (await isMirrorInvoice(deps, invoice)) {
    return { status: 'skipped', reason: 'mirror-invoice' };
  }
  // Prefer the persisted record (authoritative totalAmount/business date).
  const persisted = (await deps.getInvoice(String(invoice.id))) ?? invoice;
  return appendSalesAllocation(deps, {
    economicId: String(persisted.id),
    totalAmountRaw: (persisted as Invoice).totalAmount,
    businessDateRaw: (persisted as Invoice).date,
  });
}

/**
 * Post-commit fire-and-forget hook shared by every posting funnel
 * (processSale, processInvoice, quotation/job-order conversions, legacy
 * exam invoice). Loud on failure (logger.error with context), never rolls
 * back the committed document, never blocks posting. Safe to invoke twice:
 * the Phase 4 idempotency layer deduplicates on the economic key.
 */
export function fireAllocationHook(
  task: Promise<SalesAllocationOutcome>,
  context: string,
): void {
  task.catch((err) => {
    logger.error(`[TransportBudget] sales allocation failed (${context}):`, err);
  });
}

export type { TransportBudgetAppendResult };

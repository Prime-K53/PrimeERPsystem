/**
 * landingAllocation.ts — authoritative Landing Cost allocation engine.
 *
 * One deterministic allocation result per landing-cost line per GRN.
 * Supports VALUE (stock-bearing extended goods value) and QUANTITY
 * (stock-bearing received quantity) bases only. Weight, volume, manual
 * percentages and other custom methods are NOT implemented.
 *
 * Exactness: all math in integer cents; each landing line's shares sum to
 * its source amount exactly, with any rounding remainder assigned to the
 * final eligible receipt line in deterministic snapshot order.
 *
 * The engine is pure (no stores, no accounts): eligibility and account
 * resolution are caller-supplied so unit tests can drive it directly while
 * transactionService supplies the canonical resolvers.
 */

export type LandingAllocationMethod = 'VALUE' | 'QUANTITY';

export const LANDING_ALLOCATION_METHODS: LandingAllocationMethod[] = ['VALUE', 'QUANTITY'];

export function normalizeLandingAllocationMethod(value: unknown): LandingAllocationMethod | null {
  if (value === 'VALUE' || value === 'QUANTITY') return value;
  return null;
}

export interface LandingAllocationReceiptLine {
  itemId: string;
  quantityReceived: number;
  unitCost: number;
}

export interface LandingAllocationSourceLine {
  id: string;
  amount: number;
}

export interface LandingAllocationShare {
  /** Source landing-cost line identity (LandingCostItem.id). */
  landingCostId: string;
  /** Receipt-line identity: index within the GRN items snapshot (stable). */
  receiptLineKey: string;
  itemId: string;
  /** Exact allocated amount (currency units); Σ per landing line == source. */
  amount: number;
  /** Received quantity of the line (audit basis for QUANTITY). */
  quantity: number;
  basis: LandingAllocationMethod;
  /** Resolved inventory account id, or null when the caller did not resolve. */
  inventoryAccount: string | null;
}

export interface LandingAllocationResult {
  method: LandingAllocationMethod;
  shares: LandingAllocationShare[];
  sourceTotal: number;
}

const toCents = (value: number): number => Math.round(value * 100);
const fromCents = (cents: number): number => cents / 100;

export type LandingTaxTreatment = 'CAPITALIZE' | 'CUSTOMS_DUTY' | 'NONRECOVERABLE_TAX' | 'RECOVERABLE_VAT' | 'WITHHOLDING';

export function normalizeLandingTaxTreatment(value: unknown): LandingTaxTreatment {
  if (
    value === 'CUSTOMS_DUTY' ||
    value === 'NONRECOVERABLE_TAX' ||
    value === 'RECOVERABLE_VAT' ||
    value === 'WITHHOLDING'
  ) {
    return value;
  }
  return 'CAPITALIZE';
}

export interface LandingTaxSplit {
  gross: number;
  /** Portion that may enter allocation/consumption (net of recoverable VAT). */
  capitalizable: number;
  /** Recoverable VAT diverted to input-VAT posting (never inventory). */
  recoverableVAT: number;
  rate: number;
  treatment: LandingTaxTreatment;
  taxInclusive: boolean;
}

/**
 * Split a landing line into its capitalizable and recoverable-VAT parts.
 * Pure and deterministic; consumes integer cents so capitalizable +
 * recoverableVAT always equals gross exactly. WITHHOLDING and negative
 * amounts are rejected here (fail closed — no parallel engine exists for
 * withholding, and credits flow only through controlled correction).
 */
export function splitLandingLineTax(line: {
  amount?: unknown;
  taxTreatment?: unknown;
  vatRate?: unknown;
  taxInclusive?: unknown;
}): LandingTaxSplit {
  const gross = Number(line?.amount) || 0;
  const treatment = normalizeLandingTaxTreatment((line as any)?.taxTreatment);
  if (treatment === 'WITHHOLDING') {
    throw new Error(
      'Landing-cost withholding is not supported by Prime\u2019s payment infrastructure: no withholding engine exists. ' +
      'Failing closed rather than posting an unrepresentable tax treatment.'
    );
  }
  if (gross < -0.005) {
    throw new Error(
      `Negative landing cost (K${gross.toFixed(2)}) cannot post directly. ` +
      `Use the controlled landing-cost correction flow, which links original → reversal → replacement.`
    );
  }
  if (treatment !== 'RECOVERABLE_VAT') {
    return { gross, capitalizable: gross, recoverableVAT: 0, rate: 0, treatment, taxInclusive: true };
  }
  const rate = Number((line as any)?.vatRate) || 0;
  if (!(rate > 0)) {
    throw new Error(
      'A RECOVERABLE_VAT landing line requires an explicit positive vatRate. Failing closed.'
    );
  }
  const taxInclusive = (line as any)?.taxInclusive ?? true;
  const grossCents = toCents(gross);
  const vatCents = taxInclusive
    ? Math.round((grossCents * rate) / (100 + rate))
    : Math.round((grossCents * rate) / 100);
  const recoverableVAT = fromCents(vatCents);
  return {
    gross,
    capitalizable: fromCents(grossCents - vatCents),
    recoverableVAT,
    rate,
    treatment,
    taxInclusive: !!taxInclusive,
  };
}

/**
 * Cross-GRN proportional entitlement in integer cents: this GRN's share of
 * the source equals its share of the PO's total eligible basis, in the same
 * method. Rounded (never floored away systematically); the caller caps by
 * remaining. Deterministic for identical inputs.
 */
export function computeEntitlementCents(sourceCents: number, grnBasis: number, poBasis: number): number {
  if (!Number.isFinite(sourceCents) || sourceCents < 0) {
    throw new Error('Entitlement requires a finite non-negative source amount in cents.');
  }
  if (!(poBasis > 0)) {
    throw new Error(
      'Cross-GRN entitlement has no PO basis to proportion against (zero eligible PO value/quantity). Failing closed rather than guessing.'
    );
  }
  if (!(grnBasis > 0)) {
    return 0;
  }
  return Math.max(0, Math.round((sourceCents * grnBasis) / poBasis));
}

/**
 * VAT take for a consumed capitalizable amount, in integer cents, capped by
 * the line's VAT remaining. The ratio derives from the line's own
 * gross/capitalizable relationship so full consumption recovers exactly the
 * line VAT: exclusive lines scale by gross/cap, inclusive lines by r/100.
 */
export function computeConsumedVatCents(
  consumableCapCents: number,
  lineGrossCents: number,
  lineCapCents: number,
  rate: number,
  inclusive: boolean,
  vatRemainingCents: number,
): number {
  if (!(consumableCapCents > 0) || !(rate > 0) || !(vatRemainingCents > 0)) return 0;
  const ratio = inclusive ? rate / 100 : (lineGrossCents / Math.max(1, lineCapCents)) * (rate / 100);
  const take = Math.round(consumableCapCents * ratio);
  return Math.max(0, Math.min(take, vatRemainingCents));
}

export function allocateLandingCosts(args: {
  receiptLines: LandingAllocationReceiptLine[];
  /** Stock-bearing eligibility per receipt-line index (snapshot order). */
  isEligible: (lineIndex: number) => boolean;
  /** Positive-amount landing lines to allocate. */
  landingLines: LandingAllocationSourceLine[];
  method: unknown;
  /** Optional per-line inventory-account resolver; null entries fail downstream posting, not here. */
  resolveAccount?: (lineIndex: number) => string | null;
}): LandingAllocationResult {
  const method = normalizeLandingAllocationMethod(args.method);
  if (!method) {
    throw new Error(
      `Unsupported landing-cost allocation method "${String(args.method)}". Supported methods: ${LANDING_ALLOCATION_METHODS.join(', ')}.`
    );
  }

  const receiptLines = args.receiptLines || [];
  const landingLines = args.landingLines || [];

  // Source validation: identity present, unique, positive finite amounts.
  const seenIds = new Set<string>();
  for (const line of landingLines) {
    const id = String(line?.id || '').trim();
    if (!id) throw new Error('Landing-cost allocation requires every source line to carry a LandingCostItem.id.');
    if (seenIds.has(id)) throw new Error(`Duplicate landing-cost line id "${id}" in allocation input.`);
    seenIds.add(id);
    const amount = Number(line?.amount);
    if (!Number.isFinite(amount) || !(amount > 0)) {
      throw new Error(`Landing-cost line "${id}" has no positive amount to allocate (got ${String(line?.amount)}).`);
    }
  }

  // Eligible participant set depends on the method. Deterministic snapshot order.
  const participants: number[] = [];
  const basisValues: number[] = [];
  receiptLines.forEach((line, index) => {
    if (!args.isEligible(index)) return;
    const qty = Number(line?.quantityReceived) || 0;
    if (method === 'QUANTITY') {
      if (!(qty > 0)) return;
      participants.push(index);
      basisValues.push(qty);
    } else {
      const value = (Number(line?.unitCost) || 0) * qty;
      participants.push(index);
      basisValues.push(value);
    }
  });

  if (participants.length === 0) {
    throw new Error(
      method === 'QUANTITY'
        ? 'QUANTITY allocation requires at least one eligible stock-bearing line with received quantity > 0.'
        : 'VALUE allocation requires at least one eligible stock-bearing receipt line.'
    );
  }
  const denominator = basisValues.reduce((s, v) => s + v, 0);
  if (!(denominator > 0)) {
    throw new Error(
      method === 'QUANTITY'
        ? 'QUANTITY allocation denominator is zero: total eligible received quantity is 0. Failing closed (no silent fallback to VALUE).'
        : 'VALUE allocation denominator is zero: total eligible receipt value is 0.'
    );
  }

  const shares: LandingAllocationShare[] = [];
  const seenPairs = new Set<string>();
  for (const source of landingLines) {
    const sourceId = String(source.id);
    const sourceCents = toCents(Number(source.amount));
    // Proportional shares in integer cents (floor), then the exact remainder
    // goes to the FINAL eligible line in deterministic snapshot order.
    const floored = basisValues.map((basis) => Math.floor((sourceCents * basis) / denominator));
    const flooredSum = floored.reduce((s, v) => s + v, 0);
    const remainder = sourceCents - flooredSum;
    if (remainder < 0) {
      throw new Error(`Allocation overflow for landing line "${sourceId}": floored shares exceed the source amount.`);
    }
    const finalPosition = floored.length - 1;
    const cents = floored.map((c, i) => (i === finalPosition ? c + remainder : c));
    const checkSum = cents.reduce((s, v) => s + v, 0);
    if (checkSum !== sourceCents) {
      throw new Error(`Allocation of landing line "${sourceId}" does not equal its source amount exactly.`);
    }
    cents.forEach((lineCents, position) => {
      const lineIndex = participants[position];
      const line = receiptLines[lineIndex];
      if (!Number.isFinite(lineCents) || lineCents < 0) {
        throw new Error(`Non-finite or negative allocation share for landing line "${sourceId}".`);
      }
      const pairKey = `${sourceId}::${lineIndex}`;
      if (seenPairs.has(pairKey)) {
        throw new Error(`Duplicate allocation entry for landing line "${sourceId}" and receipt line ${lineIndex}.`);
      }
      seenPairs.add(pairKey);
      shares.push({
        landingCostId: sourceId,
        receiptLineKey: String(lineIndex),
        itemId: String(line?.itemId || ''),
        amount: fromCents(lineCents),
        quantity: Number(line?.quantityReceived) || 0,
        basis: method,
        inventoryAccount: args.resolveAccount ? args.resolveAccount(lineIndex) ?? null : null,
      });
    });
  }

  const sourceTotal = landingLines.reduce((s, l) => s + Number(l.amount), 0);
  return { method, shares, sourceTotal };
}

/** Sum of shares for one receipt line (across landing lines), in currency units. */
export function sumSharesForReceiptLine(shares: LandingAllocationShare[], receiptLineKey: string): number {
  return shares
    .filter((s) => s.receiptLineKey === receiptLineKey)
    .reduce((sum, s) => sum + (Number(s.amount) || 0), 0);
}

export interface LandingConsumptionSummary {
  landingCostId: string;
  /** Gross source amount (PO line). */
  source: number;
  /** Capitalizable portion of source (net of recoverable VAT). */
  capitalizable: number;
  /** Recoverable VAT portion (never inventory). */
  recoverableVAT: number;
  /** WAC-embedded total (GRN-kind events only, signed corrections included). */
  consumed: number;
  /** Still available for WAC-embedding: capitalizable − consumed. */
  remaining: number;
  billed: boolean;
  billIds: string[];
  grnIds: string[];
  method: 'VALUE' | 'QUANTITY' | null;
}

/**
 * Durable consumption state for one landing line, derived from the PO's
 * immutable consumption events plus current PO line data. Needs no live
 * ledger/PO-price reads: remaining = capitalizable − Σ GRN-kind events.
 */
export function getLandingLineState(
  purchase: { landingCosts?: { id?: unknown; amount?: unknown }[]; landingConsumption?: {
    landingCostId?: unknown; kind?: unknown; amount?: unknown; billId?: unknown;
    grnId?: unknown; method?: unknown;
  }[] } | null | undefined,
  landingCostId: string,
): LandingConsumptionSummary {
  const line = ((purchase as any)?.landingCosts || []).find((c: any) => String(c?.id) === String(landingCostId));
  const source = Number((line as any)?.amount) || 0;
  let capitalizable = source;
  let recoverableVAT = 0;
  try {
    const split = splitLandingLineTax((line as any) || {});
    capitalizable = split.capitalizable;
    recoverableVAT = split.recoverableVAT;
  } catch {
    // Unclassifiable lines (e.g. WITHHOLDING) keep gross semantics here;
    // posting paths fail closed independently with direction.
  }
  const events = (((purchase as any)?.landingConsumption || []) as any[]).filter(
    (e) => String(e?.landingCostId) === String(landingCostId),
  );
  // WAC-embedding consumption: GRN events plus signed CORRECTION events
  // (negative corrections release remaining). BILL/REVERSAL events establish
  // or unwind the AP/debit side and never move WAC remaining.
  const grnEvents = events.filter((e) => e?.kind === 'GRN' || e?.kind === 'CORRECTION');
  const billEvents = events.filter((e) => e?.kind === 'BILL');
  const consumed = grnEvents.reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  return {
    landingCostId: String(landingCostId),
    source,
    capitalizable,
    recoverableVAT,
    consumed,
    remaining: capitalizable - consumed,
    billed: billEvents.length > 0,
    billIds: billEvents.map((e) => String(e?.billId || '')).filter(Boolean),
    grnIds: grnEvents.map((e) => String(e?.grnId || '')).filter(Boolean),
    method: events.length > 0
      ? (normalizeLandingAllocationMethod(events[events.length - 1]?.method) ?? null)
      : null,
  };
}

export interface LandingReconciliation {
  landingCostId: string;
  source: number;
  capitalizable: number;
  consumedWAC: number;
  journalledTotal: number;
  providerAPTotal: number;
  remaining: number;
  recoverableVAT: number;
  correctionTotal: number;
  paidTotal: number;
  apOutstanding: number;
  balanced: boolean;
  notes: string[];
}

/**
 * Deterministic cross-check of one landing line across PO events, ledger
 * journals, bill invoices, VAT rows and supplier payments — testable without
 * reading current PO prices.
 *
 * Invariants asserted:
 * - consumed + remaining == source (signed corrections included)
 * - journalled capitalization == provider AP (every landing journal credits AP)
 * - consumed WAC == journalled capitalization on exactly one establishment path
 * - recoverable VAT tracked separately and never inside consumed/inventory
 * - applied payments never exceed the provider obligation
 */
export function reconcileLandingCostLine(args: {
  landingCostId: string;
  purchase: Parameters<typeof getLandingLineState>[0];
  ledgerEntries: { id?: unknown; debitAccountId?: unknown; creditAccountId?: unknown; amount?: unknown; supplierId?: unknown; landingCostIds?: unknown; entryType?: unknown }[];
  invoices?: { id?: unknown; landingCostId?: unknown; paid_amount?: unknown; total_amount?: unknown; status?: unknown }[];
  vatTransactions?: { reference?: unknown; amount?: unknown; landingCostIds?: unknown }[];
  payments?: { id?: unknown; supplierId?: unknown; amount?: unknown; invoiceApplications?: { invoiceId?: unknown; amount?: unknown }[] }[];
  providerId?: string;
}): LandingReconciliation {
  const state = getLandingLineState(args.purchase, args.landingCostId);
  const notes: string[] = [];
  const carriesLine = (e: any) =>
    Array.isArray(e?.landingCostIds) &&
    (e.landingCostIds as unknown[]).map(String).includes(String(args.landingCostId));
  // Establishment journals only: mirrors (reversals/corrections) are
  // reported separately and never counted as obligations.
  const isBillCap = (e: any) =>
    String(e?.id || '').startsWith('LG-LCB-') &&
    !String(e?.id || '').includes('-VAT') &&
    !String(e?.id || '').includes('-REV') &&
    !(e as any).reversesEntryId;
  const isGrnCap = (e: any) =>
    String(e?.id || '').startsWith('LG-GRN-LC-') && !(e as any).reversesEntryId;
  const isVatLeg = (e: any) =>
    (String(e?.id || '').startsWith('LG-GRN-VAT-') || String(e?.id || '').startsWith('LG-LCB-VAT-')) &&
    !String(e?.id || '').includes('-REV') &&
    !(e as any).reversesEntryId;
  const isMirror = (e: any) =>
    /REVERSAL|CORRECTION/.test(String((e as any)?.entryType || '')) ||
    String(e?.id || '').includes('-REV') ||
    String(e?.id || '').startsWith('LG-GRN-LCR-');
  const reversedIds = new Set(
    (args.ledgerEntries || [])
      .filter((e: any) => e && (e as any).reversesEntryId)
      .map((e: any) => String((e as any).reversesEntryId)),
  );
  const live = (e: any) => !reversedIds.has(String(e?.id || ''));
  const capEntries = (args.ledgerEntries || []).filter(
    (e) => (isBillCap(e) || isGrnCap(e)) && carriesLine(e) && live(e),
  );
  const vatEntries = (args.ledgerEntries || []).filter((e) => isVatLeg(e) && carriesLine(e) && live(e));
  const mirrorEntries = (args.ledgerEntries || []).filter((e) => isMirror(e) && carriesLine(e));
  const journalledTotal = capEntries.reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  const vatPostedTotal = vatEntries.reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  const providerAPTotal = [...capEntries, ...vatEntries]
    .filter((e) => e?.supplierId)
    .reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  const correctionTotal = mirrorEntries.reduce((s, e) => s + (Number(e?.amount) || 0), 0);
  const recoverableVAT = (args.vatTransactions || [])
    .filter(
      (v) =>
        Array.isArray((v as any)?.landingCostIds) &&
        ((v as any).landingCostIds as unknown[]).map(String).includes(String(args.landingCostId)),
    )
    .reduce((s, v) => s + (Number((v as any)?.amount) || 0), 0);
  const billInvoices = (args.invoices || []).filter(
    (inv) => String((inv as any)?.landingCostId || '') === String(args.landingCostId),
  );
  const billIds = new Set(billInvoices.map((inv) => String((inv as any)?.id)));
  const paidTotal = (args.payments || [])
    .filter((p) => !args.providerId || String((p as any)?.supplierId || '') === String(args.providerId))
    .reduce(
      (s, p) =>
        s +
        (((p as any)?.invoiceApplications || []) as any[])
          .filter((a: any) => billIds.has(String(a?.invoiceId)))
          .reduce((t: number, a: any) => t + (Number(a?.amount) || 0), 0),
      0,
    );

  if (state.remaining < -0.005) notes.push(`remaining negative (${state.remaining})`);
  if (Math.abs(state.consumed + state.remaining - state.capitalizable) > 0.005) {
    notes.push('consumed + remaining != capitalizable');
  }
  if (Math.abs(state.capitalizable + state.recoverableVAT - state.source) > 0.005) {
    notes.push('capitalizable + recoverable VAT != source');
  }
  // Exactly one establishment path may journalize a line: bill xor GRN legs.
  // Reversed originals are excluded above via mirror linkage, so a reversed
  // bill (or corrected GRN) followed by a legitimate re-establishment reads
  // as a single obligation, not a duplicate.
  const billPath = billInvoices.length > 0 || capEntries.some((e) => String(e?.id || '').startsWith('LG-LCB'));
  const grnPath = capEntries.some((e) => String(e?.id || '').startsWith('LG-GRN-LC'));
  if (billPath && grnPath) notes.push('both bill and GRN journals present for one line');
  if (capEntries.some((e) => !e?.supplierId)) notes.push('capitalization entry missing provider linkage');
  // WAC-embedded amount must equal the journalled capitalization: a bill
  // establishes the full source while GRNs embed capped shares, so any
  // sustained difference is drift (e.g. edited amounts between bill and GRN).
  if (Math.abs(state.consumed - journalledTotal) > 0.005) {
    notes.push('consumed WAC amount != journalled capitalization');
  }
  if (recoverableVAT > 0 && recoverableVAT - state.recoverableVAT > 0.005) {
    notes.push('posted recoverable VAT exceeds line VAT entitlement');
  }
  if (paidTotal - providerAPTotal > 0.005) notes.push('applied payments exceed provider obligation');

  return {
    landingCostId: String(args.landingCostId),
    source: state.source,
    capitalizable: state.capitalizable,
    consumedWAC: state.consumed,
    journalledTotal,
    providerAPTotal,
    remaining: state.remaining,
    recoverableVAT,
    correctionTotal,
    paidTotal,
    apOutstanding: providerAPTotal - paidTotal,
    balanced: notes.length === 0,
    notes,
  };
}

/**
 * Canonical-path guard for alternate purchase-receipt flows (e.g. quick
 * receive modals that record lots/status without journals, WAC landing
 * allocation, consumption or idempotency). Returns an error message when
 * the PO carries capitalizable landing costs that only GRN Verify
 * (processGoodsReceipt) may post, or null when the fast path is safe.
 */
export function requiresGrnVerifyForLanding(purchase: { id?: unknown; landingCosts?: { amount?: unknown }[] } | null | undefined): string | null {
  const pending = ((purchase as any)?.landingCosts || []).filter((c: any) => Number(c?.amount) >= 0.005);
  if (pending.length === 0) {
    return null;
  }
  return (
    `PO ${String((purchase as any)?.id || 'unknown')} carries landing costs. Quick Receive cannot post them: ` +
    `use Goods Received \u2192 Verify & Commit Stock so landing allocation, consumption, journals and idempotency apply.`
  );
}

export interface LandingCostLineReport {
  landingCostId: string;
  purchaseOrderId: string;
  category: string | null;
  description: string | null;
  providerId: string | null;
  providerName: string | null;
  source: number;
  capitalizable: number;
  recoverableVAT: number;
  taxTreatment: string;
  method: 'VALUE' | 'QUANTITY' | null;
  billedAmount: number;
  billIds: string[];
  billStatus: string | null;
  consumedWAC: number;
  remaining: number;
  grnIds: string[];
  receiptLines: { receiptLineKey: string; itemId: string; amount: number; account: string | null }[];
  inventoryAccounts: { account: string; amount: number }[];
  capitalizationAmount: number;
  vatPosted: number;
  dutyAmount: number;
  paidTotal: number;
  apOutstanding: number;
  corrections: { id: string; grnId: string | null; amount: number; at: string }[];
  reversals: { id: string; billId: string | null; at: string }[];
  balanced: boolean;
  notes: string[];
}

export interface LandingCostReport {
  purchaseOrderId: string;
  lines: LandingCostLineReport[];
  totals: {
    source: number;
    capitalizable: number;
    consumedWAC: number;
    journalled: number;
    providerAP: number;
    recoverableVAT: number;
    paid: number;
    apOutstanding: number;
    remaining: number;
  };
}

/**
 * Read-model report for every landing line of a PO, derived from durable
 * records only (PO lines + consumption events + GRN snapshots + ledger +
 * invoices + payments + VAT rows). No new reporting database; no
 * current-price reads.
 */
export function getLandingCostReport(args: {
  purchaseOrderId: string;
  purchase: {
    landingCosts?: { id?: unknown; amount?: unknown; category?: unknown; description?: unknown; providerId?: unknown; taxTreatment?: unknown }[];
    landingConsumption?: any[];
  } | null | undefined;
  grns?: { id?: unknown; landingAllocations?: { landingCostId?: unknown; receiptLineKey?: unknown; itemId?: unknown; amount?: unknown; inventoryAccount?: unknown }[] }[];
  ledgerEntries?: { id?: unknown; debitAccountId?: unknown; creditAccountId?: unknown; amount?: unknown; supplierId?: unknown; landingCostIds?: unknown; entryType?: unknown }[];
  invoices?: { id?: unknown; landingCostId?: unknown; supplier_id?: unknown; status?: unknown; paid_amount?: unknown; total_amount?: unknown }[];
  payments?: { id?: unknown; supplierId?: unknown; invoiceApplications?: { invoiceId?: unknown; amount?: unknown }[] }[];
  vatTransactions?: { reference?: unknown; amount?: unknown; landingCostIds?: unknown }[];
  supplierNames?: Record<string, string>;
}): LandingCostReport {
  const lines = (((args.purchase as any)?.landingCosts || []) as any[]);
  const out: LandingCostLineReport[] = [];
  for (const line of lines) {
    const id = String(line?.id || '');
    if (!id) {
      continue;
    }
    const rec = reconcileLandingCostLine({
      landingCostId: id,
      purchase: args.purchase as any,
      ledgerEntries: (args.ledgerEntries || []) as any,
      invoices: (args.invoices || []) as any,
      vatTransactions: (args.vatTransactions || []) as any,
      payments: (args.payments || []) as any,
      providerId: String(line?.providerId || ''),
    });
    const stateEvents = (((args.purchase as any)?.landingConsumption || []) as any[]).filter(
      (e: any) => String(e?.landingCostId) === id,
    );
    const billInvoices = (args.invoices || []).filter(
      (inv: any) => String((inv as any)?.landingCostId || '') === id,
    );
    // Receipt-line detail is rebuilt from persisted GRN snapshots (the
    // durable allocation authority), restricted to this line.
    const receiptSeen = new Map<string, { receiptLineKey: string; itemId: string; amount: number; account: string | null }>();
    for (const grn of args.grns || []) {
      for (const s of ((grn as any)?.landingAllocations || []) as any[]) {
        if (String(s?.landingCostId) !== id) {
          continue;
        }
        const key = `${String((grn as any)?.id)}::${String(s?.receiptLineKey || '')}`;
        const prev = receiptSeen.get(key) || {
          receiptLineKey: String(s?.receiptLineKey || ''),
          itemId: String(s?.itemId || ''),
          amount: 0,
          account: (s?.inventoryAccount as string) || null,
        };
        prev.amount += Number(s?.amount) || 0;
        receiptSeen.set(key, prev);
      }
    }
    const invAccounts = new Map<string, number>();
    for (const s of receiptSeen.values()) {
      if (!s.account) {
        continue;
      }
      invAccounts.set(s.account, (invAccounts.get(s.account) || 0) + s.amount);
    }
    const providerId = String(line?.providerId || '');
    out.push({
      landingCostId: id,
      purchaseOrderId: String(args.purchaseOrderId),
      category: line?.category != null ? String(line.category) : null,
      description: line?.description != null ? String(line.description) : null,
      providerId: providerId || null,
      providerName: (args.supplierNames || {})[providerId] || null,
      source: rec.source,
      capitalizable: rec.capitalizable,
      recoverableVAT: rec.recoverableVAT,
      taxTreatment: String((line as any)?.taxTreatment || 'CAPITALIZE'),
      method: getLandingLineState(args.purchase as any, id).method,
      billedAmount: billInvoices.reduce((s: number, inv: any) => s + (Number(inv?.total_amount) || 0), 0),
      billIds: billInvoices.map((inv: any) => String(inv?.id)),
      billStatus: billInvoices.length > 0 ? String(billInvoices[billInvoices.length - 1]?.status || 'pending') : null,
      consumedWAC: rec.consumedWAC,
      remaining: rec.remaining,
      grnIds: [...new Set(stateEvents.filter((e: any) => e?.grnId).map((e: any) => String(e.grnId)))],
      receiptLines: [...receiptSeen.values()],
      inventoryAccounts: [...invAccounts.entries()].map(([account, amount]) => ({ account, amount })),
      capitalizationAmount: rec.journalledTotal,
      vatPosted: rec.recoverableVAT,
      dutyAmount: String((line as any)?.taxTreatment || '') === 'CUSTOMS_DUTY' ? rec.capitalizable : 0,
      paidTotal: rec.paidTotal,
      apOutstanding: rec.apOutstanding,
      corrections: stateEvents
        .filter((e: any) => e?.kind === 'CORRECTION')
        .map((e: any) => ({ id: String(e?.id), grnId: e?.grnId ? String(e.grnId) : null, amount: Number(e?.amount) || 0, at: String(e?.at || '') })),
      reversals: stateEvents
        .filter((e: any) => e?.kind === 'REVERSAL')
        .map((e: any) => ({ id: String(e?.id), billId: e?.billId ? String(e.billId) : null, at: String(e?.at || '') })),
      balanced: rec.balanced,
      notes: rec.notes,
    });
  }
  const sum = (f: (l: LandingCostLineReport) => number) => out.reduce((s, l) => s + f(l), 0);
  return {
    purchaseOrderId: String(args.purchaseOrderId),
    lines: out,
    totals: {
      source: sum((l) => l.source),
      capitalizable: sum((l) => l.capitalizable),
      consumedWAC: sum((l) => l.consumedWAC),
      journalled: sum((l) => l.capitalizationAmount),
      providerAP: sum((l) => l.capitalizationAmount),
      recoverableVAT: sum((l) => l.vatPosted),
      paid: sum((l) => l.paidTotal),
      apOutstanding: sum((l) => l.apOutstanding),
      remaining: sum((l) => l.remaining),
    },
  };
}

/**
 * contractFunds.ts — canonical printing-contract fund calculations (Phase 1).
 *
 * Single source of truth for:
 *   available for unrelated spending = verified wallet balance - active protected reservations
 *
 * Reservation policy (§2.2):
 * - A reservation is an allocation of existing money, never a payment/revenue/credit/debit.
 * - Only `active` + `suspended` contracts hold PROTECTED reservations.
 *   draft / pending_payment track reservations but do NOT subtract from available
 *   (creation happens in draft; protection starts at activation).
 *   completed / expired / cancelled hold zero (released).
 * - For a fully funded contract, the protected amount equals the remaining
 *   value of all outstanding (reserved) assessments.
 * - For a partially funded contract, the protected amount is capped at the
 *   verified eligible funds actually available; the remainder is tracked as
 *   `unfundedObligation` — never fabricated.
 * - prepaid_amount (commercial value) is NEVER proof of funding.
 *
 * Legacy compatibility (safety gate §7):
 * - Some rows were created via direct `addContractAssessment` with
 *   reserved items but `reserved_amount == 0`. The EFFECTIVE reservation for
 *   guard purposes is max(bucket, canonical items sum) — conservative
 *   protection — while reconciliation still reports the drift explicitly.
 * - No function here mutates balances; all are pure derivations.
 */

import type { AssessmentContract, AssessmentContractItem } from '../types';

export const RESERVATION_HOLDING_STATUSES = new Set(['active', 'suspended']);

const money = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
};

export interface ContractFundPosition {
  contractId: string;
  contractNumber: string;
  status: string;
  /** Commercial agreed value (prepaid_amount). NOT proof of funding. */
  contractValue: number;
  /** Bucket value (reserved_amount). */
  bucketReserved: number;
  /** Canonical sum of reserved item prices. */
  itemsReservedValue: number;
  /** Effective protected reservation = max(bucket, items) when holding, else 0. */
  effectiveReserved: number;
  consumed: number;
  released: number;
  totalAssessments: number;
  reservedCount: number;
  consumedCount: number;
  releasedCount: number;
  /** Outstanding (reserved items) value. */
  outstandingValue: number;
  /**
   * Verified eligible funds actually protected from unrelated spending.
   * Filled per-customer by customerFundingPosition (allocation-capped).
   */
  protectedReservation: number;
  /** claim − protected, filled per-customer by customerFundingPosition. */
  unfundedObligation: number;
  /** prepaid - consumed - bucket (commercial remainder, may include unfunded). */
  commercialAvailable: number;
  discrepancies: string[];
}

export const isReservationHoldingStatus = (status: unknown): boolean =>
  RESERVATION_HOLDING_STATUSES.has(String(status || ''));

export const sumReservedItems = (
  items: AssessmentContractItem[] | null | undefined,
): number =>
  money(
    (items || [])
      .filter((it) => String(it?.status || '') === 'reserved')
      .reduce((s, it) => s + money((it as { item_price?: unknown })?.item_price), 0),
  );

export const contractFundPosition = (
  contract: AssessmentContract,
  allItems: AssessmentContractItem[] | null | undefined,
): ContractFundPosition => {
  const cid = String((contract as { id?: unknown })?.id || '');
  const items = (allItems || []).filter((it) => String(it?.contract_id || '') === cid);
  const reservedItems = items.filter((it) => String(it?.status || '') === 'reserved');
  const consumedItems = items.filter((it) => String(it?.status || '') === 'consumed');
  // `voided` items are consumed assessments reversed by the canonical void:
  // their value is back in the wallet, so they belong with the released
  // (no longer held) movements, never with consumed.
  const releasedItems = items.filter((it) => {
    const status = String(it?.status || '');
    return status === 'released' || status === 'cancelled' || status === 'voided';
  });
  const bucketReserved = money((contract as { reserved_amount?: unknown })?.reserved_amount);
  const itemsReservedValue = money(
    reservedItems.reduce((s, it) => s + money((it as { item_price?: unknown })?.item_price), 0),
  );
  const consumed = money((contract as { consumed_amount?: unknown })?.consumed_amount);
  const released = money(
    releasedItems.reduce((s, it) => s + money((it as { item_price?: unknown })?.item_price), 0),
  );
  const holding = isReservationHoldingStatus((contract as { status?: unknown })?.status);
  // Effective = conservative max for guard; reconciliation reports drift separately.
  const effectiveReserved = holding ? money(Math.max(bucketReserved, itemsReservedValue)) : 0;
  const outstandingValue = money(itemsReservedValue);
  const contractValue = money((contract as { prepaid_amount?: unknown })?.prepaid_amount);
  const discrepancies: string[] = [];
  if (holding && Math.abs(bucketReserved - itemsReservedValue) > 0.005) {
    discrepancies.push(
      `reserved_amount bucket (${bucketReserved}) differs from canonical reserved items (${itemsReservedValue}).`,
    );
  }
  return {
    contractId: cid,
    contractNumber: String((contract as { contract_number?: unknown })?.contract_number || ''),
    status: String((contract as { status?: unknown })?.status || ''),
    contractValue,
    bucketReserved,
    itemsReservedValue,
    effectiveReserved,
    consumed,
    released,
    totalAssessments: Math.max(
      0,
      Math.floor(Number((contract as { max_assessments?: unknown })?.max_assessments) || 0),
    ),
    reservedCount: reservedItems.length,
    consumedCount: consumedItems.length,
    releasedCount: releasedItems.length,
    outstandingValue,
    protectedReservation: effectiveReserved,
    unfundedObligation: 0, // refined per-customer by customerFundingPosition
    commercialAvailable: money(contractValue - consumed - bucketReserved),
    discrepancies,
  };
};

export interface CustomerFundingPosition {
  customerId: string;
  walletBalance: number;
  /**
   * Verified eligible funds currently protected from unrelated spending.
   * Capped by actual wallet funds (see allocateEligibleReservations), so a
   * partially funded contract never protects money the customer does not hold.
   */
  totalActiveReservations: number;
  /**
   * Sum of ALL outstanding claims held by active/suspended contracts,
   * uncapped. Protection cannot exceed this; the difference is unfunded.
   */
  totalOutstandingReservations: number;
  availableForUnrelatedSpending: number;
  totalConsumed: number;
  totalUnfundedObligation: number;
  contracts: ContractFundPosition[];
}

export interface ReservationClaim {
  contractId: string;
  contractNumber: string;
  holding: boolean;
  /** max(bucket, outstanding items) — the full outstanding claim. */
  claim: number;
}

export interface EligibleAllocation {
  /** contractId -> verified eligible funds protected. */
  protectedById: Map<string, number>;
  /** contractId -> claim not covered by verified funds. */
  unfundedById: Map<string, number>;
  totalProtected: number;
  totalOutstanding: number;
  totalUnfunded: number;
}

/**
 * Single allocation of verified wallet funds across holding contracts.
 *
 * Policy (§2):
 *  - A contract protects at most the verified funds that exist, and at most
 *    its own outstanding claim.
 *  - Claims are funded in deterministic contract-number order.
 *  - `totalProtected <= walletBalance`, so available-for-unrelated-spending
 *    is never negative and an underfunded contract does not freeze money the
 *    customer does not actually hold.
 *  - Unfunded obligation = claim − protected, exposed explicitly.
 *
 * Pure and read-only; callers apply the result inside their own boundary.
 */
export const allocateEligibleReservations = (
  claims: ReservationClaim[],
  walletBalance: number,
): EligibleAllocation => {
  const wallet = money(walletBalance);
  const ordered = [...(claims || [])].sort((a, b) =>
    String(a.contractNumber || '').localeCompare(String(b.contractNumber || '')) ||
    String(a.contractId || '').localeCompare(String(b.contractId || '')),
  );
  const protectedById = new Map<string, number>();
  const unfundedById = new Map<string, number>();
  let remaining = Math.max(0, wallet);
  let totalProtected = 0;
  let totalOutstanding = 0;
  let totalUnfunded = 0;
  for (const c of ordered) {
    const claim = c.holding ? money(c.claim) : 0;
    if (!c.holding) {
      protectedById.set(c.contractId, 0);
      unfundedById.set(c.contractId, 0);
      continue;
    }
    const cover = money(Math.min(claim, remaining));
    protectedById.set(c.contractId, cover);
    unfundedById.set(c.contractId, money(claim - cover));
    remaining = money(remaining - cover);
    totalProtected = money(totalProtected + cover);
    totalOutstanding = money(totalOutstanding + claim);
    totalUnfunded = money(totalUnfunded + money(claim - cover));
  }
  return { protectedById, unfundedById, totalProtected, totalOutstanding, totalUnfunded };
};

/**
 * Canonical per-customer funding position.
 * totalActiveReservations = SUM(effectiveReserved) over holding contracts.
 * available = walletBalance - totalActiveReservations (floored at wallet when negative? no — can go negative to signal over-reservation; callers block spending when available < amount).
 */
export const customerFundingPosition = (args: {
  contracts: AssessmentContract[];
  items: AssessmentContractItem[];
  customerId: string;
  walletBalance: number;
}): CustomerFundingPosition => {
  const { contracts, items, customerId } = args;
  const walletBalance = money(args.walletBalance);
  const mine = (contracts || []).filter(
    (c) => String((c as { customer_id?: unknown })?.customer_id || '') === String(customerId),
  );
  const positions = mine.map((c) => contractFundPosition(c, items));
  let totalConsumed = 0;
  for (const p of positions) totalConsumed = money(totalConsumed + p.consumed);

  // One allocation drives BOTH the protected amount and the unfunded
  // obligation, so available / protected / unfunded can never disagree.
  const alloc = allocateEligibleReservations(
    positions.map((p) => ({
      contractId: p.contractId,
      contractNumber: p.contractNumber,
      holding: isReservationHoldingStatus(p.status),
      claim: p.effectiveReserved,
    })),
    walletBalance,
  );
  for (const p of positions) {
    p.protectedReservation = alloc.protectedById.get(p.contractId) || 0;
    p.unfundedObligation = alloc.unfundedById.get(p.contractId) || 0;
  }

  return {
    customerId: String(customerId),
    walletBalance,
    totalActiveReservations: alloc.totalProtected,
    totalOutstandingReservations: alloc.totalOutstanding,
    availableForUnrelatedSpending: money(walletBalance - alloc.totalProtected),
    totalConsumed,
    totalUnfundedObligation: alloc.totalUnfunded,
    contracts: positions,
  };
};

/** Canonical guard used by every unrelated wallet debit path. */
export const assertUnrelatedSpendingAllowed = (
  walletBalance: number,
  totalActiveReservations: number,
  spendAmount: number,
  action = 'wallet spending',
): void => {
  const available = money(money(walletBalance) - money(totalActiveReservations));
  const spend = money(spendAmount);
  if (!(spend > 0)) throw new Error(`${action}: spend amount must be positive (got ${String(spendAmount)}).`);
  if (!(available >= spend)) {
    throw new Error(
      `INSUFFICIENT_AVAILABLE_FUNDS: ${action} requires ${spend.toFixed(2)} but only ${available.toFixed(2)} is available for unrelated spending (wallet ${money(walletBalance).toFixed(2)} minus protected contract reservations ${money(totalActiveReservations).toFixed(2)}). Protected contract funds cannot be spent.`,
    );
  }
};

/**
 * Read-only legacy drift diagnosis (safety gate §7). Returns contracts whose
 * bucket disagrees with canonical items — WITHOUT mutating anything.
 */
export const diagnoseReservationDrift = (args: {
  contracts: AssessmentContract[];
  items: AssessmentContractItem[];
}): Array<{ contractId: string; contractNumber: string; bucketReserved: number; itemsReservedValue: number; detail: string }> => {
  const out: Array<{ contractId: string; contractNumber: string; bucketReserved: number; itemsReservedValue: number; detail: string }> = [];
  for (const c of args.contracts || []) {
    const pos = contractFundPosition(c, args.items);
    if (pos.discrepancies.length > 0) {
      out.push({
        contractId: pos.contractId,
        contractNumber: pos.contractNumber,
        bucketReserved: pos.bucketReserved,
        itemsReservedValue: pos.itemsReservedValue,
        detail: pos.discrepancies.join(' '),
      });
    }
  }
  return out;
};

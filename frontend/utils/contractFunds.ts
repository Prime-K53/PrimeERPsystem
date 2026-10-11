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
  /** Unfunded obligation = max(0, outstanding - effectiveReserved capped by wallet — computed per-customer). */
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
  const releasedItems = items.filter(
    (it) => String(it?.status || '') === 'released' || String(it?.status || '') === 'cancelled',
  );
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
    unfundedObligation: 0, // filled per-customer by customerFundingPosition
    commercialAvailable: money(contractValue - consumed - bucketReserved),
    discrepancies,
  };
};

export interface CustomerFundingPosition {
  customerId: string;
  walletBalance: number;
  totalActiveReservations: number;
  availableForUnrelatedSpending: number;
  totalConsumed: number;
  contracts: ContractFundPosition[];
}

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
  let totalActive = 0;
  let totalConsumed = 0;
  for (const p of positions) {
    totalActive = money(totalActive + p.effectiveReserved);
    totalConsumed = money(totalConsumed + p.consumed);
  }
  // Per-contract unfunded = outstanding beyond what the wallet can cover.
  // Allocate wallet in contract order (stable by contractNumber) — first contracts
  // are funded first; remainder is unfunded. Explicit and deterministic.
  const ordered = [...positions].sort((a, b) => a.contractNumber.localeCompare(b.contractNumber));
  let remaining = walletBalance;
  const unfundedById = new Map<string, number>();
  for (const p of ordered) {
    if (!isReservationHoldingStatus(p.status)) {
      unfundedById.set(p.contractId, 0);
      continue;
    }
    const cover = Math.min(p.outstandingValue, Math.max(0, remaining));
    // Reservation actually protected cannot exceed verified cover.
    unfundedById.set(p.contractId, money(Math.max(0, p.outstandingValue - cover)));
    remaining = money(remaining - Math.min(p.outstandingValue, Math.max(0, remaining)));
  }
  for (const p of positions) p.unfundedObligation = unfundedById.get(p.contractId) || 0;
  return {
    customerId: String(customerId),
    walletBalance,
    totalActiveReservations: totalActive,
    availableForUnrelatedSpending: money(walletBalance - totalActive),
    totalConsumed,
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

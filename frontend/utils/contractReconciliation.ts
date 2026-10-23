/**
 * contractReconciliation.ts — independent verification of the
 * printing-contract fund position against canonical records.
 *
 * Everything here is DERIVED from the canonical stores
 * (assessmentContracts, contractAssessments, walletTransactions,
 * ledger, customer.walletBalance). Nothing is mutated: this is a
 * read-only diagnostic that reports discrepancies explicitly
 * instead of silently repairing historical balances.
 *
 * Fund model (§4):
 *   Available for unrelated spending
 *     = Total wallet funds − Active contract reservations
 *   where "active contract reservations" is the sum of the
 *   remaining reservation (reserved_amount) held by every
 *   contract that still holds funds (active + suspended — a
 *   suspended contract retains its reservation).
 *
 * A reservation is an allocation of existing money, never a
 * payment, credit, revenue or expense. Consumed amounts are
 * recognised exactly once through the canonical consumption
 * operation (one wallet debit + one ledger posting).
 */

import type {
  AssessmentContract,
  AssessmentContractItem,
  WalletTransaction,
  LedgerEntry,
} from '../types';

const money = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Contract statuses that still hold a reservation. */
const RESERVATION_HOLDING_STATUSES = new Set(['active', 'suspended']);

export interface ContractReconciliationLine {
  contractId: string;
  contractNumber: string;
  status: string;
  customerId: string;
  /** Agreed commercial value (prepaid_amount). */
  contractValue: number;
  /** Total value ever reserved (derived from canonical items). */
  originalReserved: number;
  /** Remaining reservation currently held (reserved_amount bucket). */
  currentReserved: number;
  /** Cumulative value consumed (consumed_amount bucket). */
  consumedToDate: number;
  /** Value released from the reservation without consumption. */
  releasedAmount: number;
  /** Genuinely unallocated / refundable balance. */
  unallocatedFunds: number;
  /** Sum of currently-reserved item prices (canonical items). */
  reservedItemsValue: number;
  /** Sum of consumed item prices (canonical items). */
  consumedItemsValue: number;
  totalAssessments: number;
  reservedCount: number;
  consumedCount: number;
  releasedCount: number;
  /** Explicit discrepancy descriptions (empty when reconciled). */
  discrepancies: string[];
}

export interface ContractReconciliationReport {
  customerId: string;
  /** Actual customer wallet balance (authoritative). */
  walletBalance: number;
  /** Sum of remaining reservations across reservation-holding contracts. */
  totalActiveReservations: number;
  /** walletBalance − totalActiveReservations. */
  availableForUnrelatedSpending: number;
  totalConsumed: number;
  totalUnallocated: number;
  contracts: ContractReconciliationLine[];
  /** Wallet transactions linked to the customer's contracts. */
  contractWalletTransactions: WalletTransaction[];
  /** Ledger entries linked to the customer's contract assessments. */
  contractLedgerEntries: LedgerEntry[];
  /** Global discrepancy descriptions (empty when reconciled). */
  discrepancies: string[];
}

/**
 * Linkage test for a wallet transaction: does it belong to one of
 * the customer's printing contracts? Matches on contract_id in the
 * transaction payload, the contract number reference, or the
 * contract id embedded in the reference string.
 */
const matchesContract = (
  tx: WalletTransaction,
  contractIds: Set<string>,
  contractNumbers: Set<string>,
): boolean => {
  const data = (tx as any)?.data || {};
  const txContractId = String(data.contract_id || '').trim();
  const txContractNumber = String(data.contract_number || tx.reference || '').trim();
  if (txContractId && contractIds.has(txContractId)) return true;
  if (txContractNumber && contractNumbers.has(txContractNumber)) return true;
  return false;
};

export const reconcilePrintingContracts = (args: {
  contracts: AssessmentContract[];
  items: AssessmentContractItem[];
  walletTransactions: WalletTransaction[];
  ledger: LedgerEntry[];
  customerId: string;
  walletBalance: number;
}): ContractReconciliationReport => {
  const { contracts, items, walletTransactions, ledger, customerId } = args;
  const balance = money(args.walletBalance);

  const customerContracts = (contracts || []).filter(
    (c) => String(c.customer_id || '') === String(customerId),
  );
  const contractIds = new Set(customerContracts.map((c) => String(c.id)));
  const contractNumbers = new Set(
    customerContracts.map((c) => String(c.contract_number || '').trim()).filter(Boolean),
  );

  const lines: ContractReconciliationLine[] = [];
  let totalActiveReservations = 0;
  let totalConsumed = 0;
  let totalUnallocated = 0;

  for (const contract of customerContracts) {
    const cid = String(contract.id);
    const contractItems = (items || []).filter(
      (it) => String(it.contract_id || '') === cid,
    );

    const reservedItems = contractItems.filter((it) => it.status === 'reserved');
    const consumedItems = contractItems.filter((it) => it.status === 'consumed');
    // `voided` = a consumed assessment reversed by the canonical void. It is
    // no longer consumed, but its value is not an outstanding reservation
    // either: count it with released movements so the item totals still add
    // up to the original reserved value.
    const releasedItems = contractItems.filter(
      (it) => it.status === 'released' || it.status === 'cancelled' || it.status === 'voided',
    );

    const reservedItemsValue = money(reservedItems.reduce((s, it) => s + money(it.item_price), 0));
    const consumedItemsValue = money(consumedItems.reduce((s, it) => s + money(it.item_price), 0));
    const releasedAmount = money(releasedItems.reduce((s, it) => s + money(it.item_price), 0));

    const contractValue = money(contract.prepaid_amount);
    const currentReserved = money(contract.reserved_amount);
    const consumedToDate = money(contract.consumed_amount);
    const originalReserved = money(reservedItemsValue + consumedItemsValue + releasedAmount);
    const unallocatedFunds = money(contractValue - consumedToDate - currentReserved);

    const discrepancies: string[] = [];
    // Bucket vs canonical-item reconciliation.
    if (Math.abs(currentReserved - reservedItemsValue) > 0.005) {
      discrepancies.push(
        `reserved_amount bucket (${currentReserved}) does not match the sum of reserved assessment items (${reservedItemsValue}).`,
      );
    }
    if (Math.abs(consumedToDate - consumedItemsValue) > 0.005) {
      discrepancies.push(
        `consumed_amount bucket (${consumedToDate}) does not match the sum of consumed assessment items (${consumedItemsValue}).`,
      );
    }
    // Over-consumption guard: consumed + reserved must never exceed value.
    if (unallocatedFunds < -0.005) {
      discrepancies.push(
        `consumed (${consumedToDate}) + reserved (${currentReserved}) exceeds the contract value (${contractValue}) by ${money(-unallocatedFunds)}.`,
      );
    }
    // Legacy reservation-coverage gap: items were reserved but the
    // bucket was never bumped (reserved_amount stayed 0).
    if (
      originalReserved > 0.005 &&
      currentReserved < 0.005 &&
      consumedToDate < 0.005 &&
      reservedItemsValue > 0.005
    ) {
      discrepancies.push(
        `legacy row: ${reservedItemsValue} of reserved assessments carry no recorded reservation bucket (reserved_amount is 0).`,
      );
    }

    if (RESERVATION_HOLDING_STATUSES.has(String(contract.status))) {
      totalActiveReservations = money(totalActiveReservations + currentReserved);
    }
    totalConsumed = money(totalConsumed + consumedToDate);
    totalUnallocated = money(totalUnallocated + unallocatedFunds);

    lines.push({
      contractId: cid,
      contractNumber: String(contract.contract_number || ''),
      status: String(contract.status || ''),
      customerId: String(contract.customer_id || ''),
      contractValue,
      originalReserved,
      currentReserved,
      consumedToDate,
      releasedAmount,
      unallocatedFunds,
      reservedItemsValue,
      consumedItemsValue,
      totalAssessments: Math.max(0, Math.floor(Number(contract.max_assessments) || 0)),
      reservedCount: reservedItems.length,
      consumedCount: consumedItems.length,
      releasedCount: releasedItems.length,
      discrepancies,
    });
  }

  // ── Wallet / ledger linkage for the customer's contracts ──
  const contractWalletTransactions = (walletTransactions || []).filter(
    (tx) => String(tx.customerId || '') === String(customerId) && matchesContract(tx, contractIds, contractNumbers),
  );
  const contractLedgerEntries = (ledger || []).filter((entry) => {
    if (String(entry.customerId || '') !== String(customerId)) return false;
    const refId = String(entry.referenceId || '');
    return contractItemsHaveId(items, contractIds, refId);
  });

  // ── Global wallet-to-ledger reconciliation ──
  // Consumption debits are netted against canonical void-reversal credits:
  // after a void the wallet debits still exist (history is immutable), but the
  // contracts' consumed_amount is zero and the money has been returned. The
  // net movement is what must reconcile.
  const globalDiscrepancies: string[] = [];
  const ledgerById = new Map((ledger || []).map((e) => [String(e.id), e]));
  let consumptionDebits = 0;
  let consumptionLedgerTotal = 0;
  let reversalCredits = 0;
  let reversalLedgerTotal = 0;
  for (const tx of contractWalletTransactions) {
    const data = (tx as any)?.data || {};
    const kind = String(data.type || '');
    const ledgerId = `LG-${String(tx.id || '')}`;
    if (String(tx.type || '') === 'Deduction' && kind === 'ASSESSMENT_CONSUMPTION') {
      consumptionDebits = money(consumptionDebits + money(tx.amount));
      const entry = ledgerById.get(ledgerId);
      if (!entry) {
        globalDiscrepancies.push(
          `consumption wallet transaction ${tx.id} has no matching ledger entry (${ledgerId}).`,
        );
      } else {
        consumptionLedgerTotal = money(consumptionLedgerTotal + money(entry.amount));
      }
    } else if (String(tx.type || '') === 'Credit' && kind === 'ASSESSMENT_VOID_REVERSAL') {
      reversalCredits = money(reversalCredits + money(tx.amount));
      const entry = ledgerById.get(ledgerId);
      if (!entry) {
        globalDiscrepancies.push(
          `void-reversal wallet transaction ${tx.id} has no matching ledger entry (${ledgerId}).`,
        );
      } else {
        reversalLedgerTotal = money(reversalLedgerTotal + money(entry.amount));
      }
    }
  }
  if (Math.abs(consumptionDebits - consumptionLedgerTotal) > 0.005) {
    globalDiscrepancies.push(
      `consumption wallet debits (${consumptionDebits}) do not match consumption ledger postings (${consumptionLedgerTotal}).`,
    );
  }
  if (Math.abs(reversalCredits - reversalLedgerTotal) > 0.005) {
    globalDiscrepancies.push(
      `void-reversal wallet credits (${reversalCredits}) do not match reversal ledger postings (${reversalLedgerTotal}).`,
    );
  }
  const netConsumed = money(consumptionDebits - reversalCredits);
  if (Math.abs(netConsumed - totalConsumed) > 0.005) {
    globalDiscrepancies.push(
      `net consumption wallet debits (${netConsumed} = ${consumptionDebits} debited − ${reversalCredits} voided) do not match the contracts' consumed_amount total (${totalConsumed}).`,
    );
  }

  for (const line of lines) {
    for (const d of line.discrepancies) {
      globalDiscrepancies.push(`${line.contractNumber}: ${d}`);
    }
  }

  return {
    customerId: String(customerId),
    walletBalance: balance,
    totalActiveReservations,
    availableForUnrelatedSpending: money(balance - totalActiveReservations),
    totalConsumed,
    totalUnallocated,
    contracts: lines,
    contractWalletTransactions,
    contractLedgerEntries,
    discrepancies: globalDiscrepancies,
  };
};

const contractItemsHaveId = (
  items: AssessmentContractItem[],
  contractIds: Set<string>,
  referenceId: string,
): boolean => {
  if (!referenceId) return false;
  const item = (items || []).find((it) => String(it.id) === referenceId);
  if (!item) return false;
  return contractIds.has(String(item.contract_id || ''));
};

import { dbService } from './db';
import { pricingService } from './pricingService';
import { inventoryTransactionService } from './inventoryTransactionService';
import { currencyService } from './currencyService';
import {
    Sale, CartItem, LedgerEntry, WalletTransaction, Customer, SalesExchange,
    ReprintJob, SalesExchangeItem, SalesExchangeApproval, Invoice, Expense,
    Income, Transfer, Item, Purchase, GoodsReceipt, ProductionBatch, WorkOrder,
    Order, OrderPayment, CustomerPayment, SupplierPayment, PurchaseAllocation, Supplier, VatTransaction, VATConfig,
    ConsumptionSnapshot, BOMTemplate, MarketAdjustment, MarketAdjustmentTransaction, TransactionAdjustmentSnapshot,
    Shipment, DeliveryNote, ProofOfDeliveryRecord, TransactionPricingSnapshot,
    SalesOrder, SalesOrderItem, PurchaseInvoice
} from '../types';
import { BankAccount, BankTransaction } from '../types/banking';
import { MultiCurrencyJournalEntry, MultiCurrencyTransactionLine, CurrencyGainLoss } from '../types/currency';

import { assertInvoiceNumberFormat, calculateDueDate, generateNextId, resolveCustomerPaymentTerms, roundToCurrency } from '../utils/helpers';
import { traceExamInvoice } from '../utils/examinationInvoiceDiag';
import { extractProfitMargin } from '../utils/financial/extractors';
import { pagesToReams, pagesToTonerKg } from '../utils/printConversions';
import { inferSignatureInputMode, resolveSignatureDataUrl } from '../utils/signatureUtils';
import {
    calculateCustomerPaymentSnapshot,
    CustomerReceiptInvoiceInput
} from './receiptCalculationService';
import { logger } from './logger';
import { salesOrderService } from './salesOrderService';
import { produceVoidReversalSafely } from './transportBudgetVoidReversal';

import {
    getCompanyConfig, getGLConfig, generateId, calculateBankBalance,
    ensureBankAccounts, resolveBankAccountForPayment, reserveIdempotencyKey, clearIdempotencyKey,
    ensureMirroredBankTransaction, getVatConfig, toMoney,
    createMultiCurrencyJournalEntry, calculatePaymentGainLoss,
    resolveItemUnitCost, resolveInventoryRecord, calculateItemsCost,
    validateLedgerBalance, distributePosRetainedAmounts, getIdempotencyKeys, resolveToAccountId,
    resolveAccountForPosting, requireResolvedAccount, buildResolvedJournalLine,
    loadAccountsFromStore, UnresolvedAccountError,
    JournalLineInput, resolveInventoryAccountByItemType, resolveInventoryAccountFromItems,
    calculateCogsLegsPerInventoryAccount,
    isPostedInvoiceStatus, resolveInvoiceRevenueAccount, assertInvoiceEditable,
    computePostEditCorrection, isPostEditCorrectionRef,
    type PostEditCorrectionSpec
} from './transactions/_internal';
import { entryTouchesAccount, getNormalBalance, isPostedLedgerEntry } from './accountingEngine';
import { decideMarketPosting } from './marketPosting';
import { isMarketPostingActive, isVatPostingActive } from '../utils/pricingMode';
import {
    resolveStockAdjustmentPosting,
    assertNoInterestIncomeForInventoryMovement,
    type StockAdjustmentReason,
} from './inventoryAdjustmentAccounting';
import { isInventoryBearingItem, resolveInventoryCostPerUnit, resolveInventoryQuantity } from '../utils/inventoryNormalization';
import { resolveReceiptUnitCost, costAliasValues } from './purchaseCosting';
import {
    allocateLandingCosts,
    sumSharesForReceiptLine,
    normalizeLandingAllocationMethod,
    splitLandingLineTax,
    computeEntitlementCents,
    computeConsumedVatCents,
    type LandingAllocationResult,
} from './landingAllocation';
import { ensureInvoiceVerificationToken } from '../utils/invoiceVerification';
import { ensureDocumentVerificationToken } from '../utils/documentVerification';
import { derivePurchasePaymentStatus } from '../utils/paymentUtils';

const AR_POSTING_PREFIXES = ['LG-INV-AR-', 'LG-QTN-INV-AR-', 'LG-JO-INV-AR-', 'LG-REV-AR-'];

/**
 * Same-tab serialization for contract assessment consumption. The
 * idempotency-key reservation inside the operation is check-then-put, so two
 * interleaved same-tab invocations (double-click, React duplicate render)
 * could both pass the check before either writes. Chaining per-item promises
 * closes that gap for the current tab — the same in-flight-guard precedent
 * used by salesOrderStore.inFlightCreates. Cross-tab/cross-device races are
 * still governed by deterministic ids + OCC version conflicts at sync (see
 * consumeContractAssessment docs).
 */
const consumeContractLocks = new Map<string, Promise<void>>();

/**
 * Same-tab serialization for landing-cost consumption (same convention as
 * consumeContractLocks above). GRN verification reads PO consumption events
 * then appends its own; two interleaved same-tab verifies of different GRNs
 * against one PO could otherwise both consume the same remaining amount
 * before either writes. Chaining per-PO promises closes that gap for the
 * current tab. Cross-tab races remain governed by deterministic ids and
 * sync conflict handling, as with the contract precedent.
 */
const landingConsumptionLocks = new Map<string, Promise<void>>();

function isOriginalArPosting(invoiceId: string, entry: any): boolean {
    if (String(entry?.referenceId || '') !== String(invoiceId)) return false;
    return AR_POSTING_PREFIXES.some((p) => String(entry?.id || '').startsWith(p));
}

/**
 * Shared post-edit correction writer used by postInvoiceEditCorrection and
 * applyPostedInvoiceEdit. Reads the original AR postings + prior corrections,
 * computes the delta via computePostEditCorrection, enforces idempotency and
 * conflict-STOP, then journals one balanced LG-ADJ correction through the
 * normal ledgerStore path (durable sync + OCC preserved).
 */
async function postEditCorrectionInTx(
    tx: any,
    opts: {
        invoice: any;
        currentTotal: number;
        requireOriginals: boolean;
        ledgerStore: any;
        resolveAcct: (ref: string | undefined) => string;
    }
): Promise<{ posted: boolean; reason?: string; spec?: PostEditCorrectionSpec; entryId?: string }> {
    const { invoice, currentTotal, requireOriginals, ledgerStore, resolveAcct } = opts;
    const invoiceId = String(invoice.id);
    const allLedger: any[] = await ledgerStore.getAll();
    const originals = allLedger.filter((e) => isOriginalArPosting(invoiceId, e));
    if (originals.length === 0) {
        if (requireOriginals) {
            throw new Error(`Invoice #${invoiceId} has no original AR posting to correct. Nothing posted, nothing to adjust.`);
        }
        return { posted: false, reason: 'no-original-posting' };
    }
    const arAccounts = Array.from(new Set(originals.map((e) => e.debitAccountId)));
    const revenueAccounts = Array.from(new Set(originals.map((e) => e.creditAccountId)));
    if (arAccounts.length !== 1 || revenueAccounts.length !== 1) {
        throw new Error(
            `STOP: original AR postings for invoice #${invoiceId} span multiple account pairs. Manual reconciliation required — no automatic correction posted.`
        );
    }
    const arAccountId = resolveAcct(arAccounts[0]);
    const revenueAccountId = resolveAcct(revenueAccounts[0]);
    const priors = allLedger
        .filter((e) => isPostEditCorrectionRef(invoiceId, e.referenceId))
        .map((e) => ({ debitAccountId: e.debitAccountId, creditAccountId: e.creditAccountId, amount: e.amount, referenceId: e.referenceId }));
    const spec = computePostEditCorrection({
        invoiceId,
        currentTotal,
        originalArEntries: originals,
        priorCorrections: priors,
        arAccountId,
        revenueAccountId,
    });
    if (!spec) return { posted: false, reason: 'in-agreement' };
    const clash = priors.find((p) => String(p.referenceId) === spec.referenceId);
    if (clash) {
        const sameShape = Number(clash.amount) === Number(spec.amount)
            && clash.debitAccountId === spec.debitAccountId
            && clash.creditAccountId === spec.creditAccountId;
        if (sameShape) return { posted: false, reason: 'already-corrected', spec };
        throw new Error(
            `STOP: a correction ${spec.referenceId} already exists with a different amount/structure. Manual reconciliation required — no duplicate correction posted.`
        );
    }
    await reserveIdempotencyKey(tx, 'invoice_edit_correction', spec.referenceId);
    const entry = {
        id: generateId('LG-ADJ'),
        date: new Date().toISOString(),
        description: spec.description,
        debitAccountId: spec.debitAccountId,
        creditAccountId: spec.creditAccountId,
        amount: spec.amount,
        referenceId: spec.referenceId,
        reconciled: false,
        customerId: invoice.customerId,
        customerName: invoice.customerName,
    };
    await ledgerStore.put(entry);
    validateLedgerBalance([entry as any], `Post-edit correction ${spec.referenceId}`);
    return { posted: true, spec, entryId: entry.id };
}

export const transactionService = {
    /**
     * Internal helper to handle structured inventory deduction with audit trail
     */
    async _executeDeductInventory(
        inventoryStore: any,
        inventoryTransactionsStore: any,
        items: CartItem[],
        snapshots: ConsumptionSnapshot[],
        referenceType: string,
        referenceId: string,
        performedBy: string,
        inventorySnapshot?: any[]
    ) {
        const timestamp = new Date().toISOString();

        // Sales are never blocked on stock availability — not every item
        // carries stock. Deduction below may push stock negative; low-stock
        // is surfaced as a warning in the UI, never as a hard error.

        // 1. Deduct Materials from BOM Snapshots (stock-bearing components only)
        for (const snap of snapshots) {
            if (!snap.bomBreakdown) continue;
            for (const comp of snap.bomBreakdown) {
                const matItem = await resolveInventoryRecord(comp.materialId, inventorySnapshot, inventoryStore);
                if (matItem && isInventoryBearingItem(matItem)) {
                    const previousQuantity = matItem.stock || 0;
                    const newQuantity = previousQuantity - comp.quantity;
                    matItem.stock = newQuantity;
                    await inventoryStore.put(matItem);

                    // Create audit trail record
                    const transaction = {
                        id: generateId('TXN'),
                        itemId: comp.materialId,
                        type: 'OUT',
                        quantity: -comp.quantity,
                        previousQuantity,
                        newQuantity,
                        unitCost: matItem.cost || 0,
                        totalCost: -(comp.quantity * (matItem.cost || 0)),
                        reference: referenceType,
                        referenceId,
                        reason: `BOM Component for ${referenceType}`,
                        performedBy,
                        timestamp
                    };
                    await inventoryTransactionsStore.put(transaction);
                }
            }
        }

        // 2. Deduct stock-bearing items without BOM snapshots.
        // Product/Service lines are non-stock: never deducted here (their
        // raw-material cost was captured at production/consumption time).
        // When the line carries no type, the stored record's type governs.
        for (const item of items) {
            const hasSnapshot = snapshots.some(s => s.itemId === (item.parentId || item.id));
            if (hasSnapshot) continue;
            const invItem = await resolveInventoryRecord(item.id, inventorySnapshot, inventoryStore);
            if (!invItem) continue;
            const eligibilityProbe = item?.type ? item : invItem;
            if (!isInventoryBearingItem(eligibilityProbe)) continue;
            {
                const previousQuantity = invItem.stock || 0;
                const newQuantity = previousQuantity - item.quantity;
                invItem.stock = newQuantity;
                await inventoryStore.put(invItem);

                // Create audit trail record
                const transaction = {
                    id: generateId('TXN'),
                    itemId: item.id,
                    type: 'OUT',
                    quantity: -item.quantity,
                    previousQuantity,
                    newQuantity,
                    unitCost: invItem.cost || 0,
                    totalCost: -(item.quantity * (invItem.cost || 0)),
                    reference: referenceType,
                    referenceId,
                    reason: `${referenceType} Sale`,
                    performedBy,
                    timestamp
                };
                await inventoryTransactionsStore.put(transaction);
            }
        }
    },

    /**
     * Internal helper to process market adjustments for any transaction type.
     * This shared method handles adjustment snapshot generation and transaction recording.
     * 
     * @param items - Cart items to process adjustments for
     * @param inventory - Full inventory array for lookups
     * @param bomTemplates - BOM templates for production items
     * @param marketAdjustments - Active market adjustments
     * @param transactionId - The sale/invoice/order ID
     * @param transactionType - Type of transaction for proper ID field naming
     * @param inventoryStore - IndexedDB store for inventory lookups
     * @returns Processed adjustment data including snapshots and transactions
     */
    async _processMarketAdjustments(
        items: CartItem[],
        inventory: any[],
        bomTemplates: BOMTemplate[],
        marketAdjustments: MarketAdjustment[],
        transactionId: string,
        transactionType: 'sale' | 'invoice' | 'order' | 'quotation',
        inventoryStore: any
    ): Promise<{
        transactionAdjustmentSnapshots: TransactionAdjustmentSnapshot[];
        adjustmentTransactions: MarketAdjustmentTransaction[];
        adjustmentSnapshots: any[];
        adjustmentTotal: number;
        // Normalised to the adjustmentSnapshots shape by
        // pricingService.generateAdjustmentSummary (Phase 5).
        adjustmentSummary: any[];
    }> {
        const allTransactionSnapshots: TransactionAdjustmentSnapshot[] = [];
        const allAdjustmentTransactions: MarketAdjustmentTransaction[] = [];
        const allSnapshots: any[] = [];
        let totalAdjustment = 0;

        for (const item of items) {
            // Check if item already has transaction adjustment snapshots
            // OR basic adjustmentSnapshots (for variants passed from POS/OrderForm)
            const hasTransactionSnapshots = item.transactionAdjustmentSnapshots && item.transactionAdjustmentSnapshots.length > 0;
            const hasBasicSnapshots = item.adjustmentSnapshots && item.adjustmentSnapshots.length > 0;
            
            if (hasTransactionSnapshots) {
                // Use existing transaction-level snapshots (full format)
                const updatedSnapshots = item.transactionAdjustmentSnapshots.map((snap: any) => ({
                    ...snap,
                    ...(transactionType === 'sale' ? { saleId: transactionId } :
                        transactionType === 'invoice' ? { invoiceId: transactionId } :
                            transactionType === 'order' ? { orderId: transactionId } :
                                { quotationId: transactionId })
                }));
                allTransactionSnapshots.push(...updatedSnapshots);

                // Create adjustment transactions from snapshots
                const transactions = pricingService.createAdjustmentTransactions(updatedSnapshots, transactionId);
                allAdjustmentTransactions.push(...transactions);
            } else if (hasBasicSnapshots) {
                // ✅ Convert basic adjustmentSnapshots to TransactionAdjustmentSnapshot format
                // This ensures POS items have proper transaction-level tracking
                const basicSnapshots = item.adjustmentSnapshots;
                const quantity = item.quantity || 1;
                const itemCost = item.cost || 0;
                
                const convertedSnapshots: TransactionAdjustmentSnapshot[] = basicSnapshots.map((snap: any) => ({
                    adjustmentId: snap.adjustmentId || '',
                    itemId: item.id,
                    itemName: item.name || item.productName || 'Unknown Item',
                    variantId: item.variantId || item.parentId,
                    quantity: quantity,
                    baseCost: itemCost,
                    unitAdjustmentAmount: snap.calculatedAmount || 0,
                    totalAdjustmentAmount: (snap.calculatedAmount || 0) * quantity,
                    timestamp: new Date().toISOString(),
                    name: snap.name,
                    type: snap.type || 'PERCENTAGE',
                    value: snap.value || snap.percentage || 0,
                    calculatedAmount: snap.calculatedAmount || 0,
                    category: snap.category,
                    isActive: true,
                    // Add transaction ID based on type
                    ...(transactionType === 'sale' ? { saleId: transactionId } :
                        transactionType === 'invoice' ? { invoiceId: transactionId } :
                            transactionType === 'order' ? { orderId: transactionId } :
                                { quotationId: transactionId })
                }));
                
                allTransactionSnapshots.push(...convertedSnapshots);
                
                // Create adjustment transactions from converted snapshots
                const transactions = pricingService.createAdjustmentTransactions(convertedSnapshots, transactionId);
                allAdjustmentTransactions.push(...transactions);
                
                // Aggregate for basic adjustmentSnapshots tracking
                basicSnapshots.forEach((snap: any) => {
                    const amount = (snap.calculatedAmount || 0) * quantity;
                    const existing = allSnapshots.find(s => s.name === snap.name);
                    if (existing) {
                        existing.calculatedAmount = Number((existing.calculatedAmount + amount).toFixed(2));
                    } else {
                        allSnapshots.push({ ...snap, calculatedAmount: amount });
                    }
                });
                totalAdjustment += item.adjustmentTotal || basicSnapshots.reduce((sum: number, s: any) => sum + (s.calculatedAmount || 0) * quantity, 0);
            } else {
                // Generate new snapshots using pricingService
                const invItem = await resolveInventoryRecord(item.id, inventory, inventoryStore);
                if (invItem && item.type !== 'Service') {
                    const res = pricingService.calculateItemPrice(
                        invItem,
                        item.quantity,
                        item.variantId,
                        item.pagesOverride,
                        inventory,
                        bomTemplates,
                        marketAdjustments
                    );

                    if (res.transactionAdjustmentSnapshots && res.transactionAdjustmentSnapshots.length > 0) {
                        // Update transaction ID in snapshots based on transaction type
                        const updatedSnapshots = res.transactionAdjustmentSnapshots.map(snap => ({
                            ...snap,
                            ...(transactionType === 'sale' ? { saleId: transactionId } :
                                transactionType === 'invoice' ? { invoiceId: transactionId } :
                                    transactionType === 'order' ? { orderId: transactionId } :
                                        { quotationId: transactionId })
                        }));
                        allTransactionSnapshots.push(...updatedSnapshots);

                        // Create adjustment transactions
                        const transactions = pricingService.createAdjustmentTransactions(updatedSnapshots, transactionId);
                        allAdjustmentTransactions.push(...transactions);
                    }

                    // Also capture basic adjustment snapshots for backward compatibility
                    if (res.adjustmentSnapshots) {
                        res.adjustmentSnapshots.forEach((snap: any) => {
                            const existing = allSnapshots.find(s => s.name === snap.name);
                            if (existing) {
                                existing.calculatedAmount = Number((existing.calculatedAmount + snap.calculatedAmount).toFixed(2));
                            } else {
                                allSnapshots.push({ ...snap });
                            }
                        });
                    }
                    totalAdjustment += (res.adjustmentTotal || 0);
                }
            }
        }

        // Generate adjustment summary
        const adjustmentSummary = pricingService.generateAdjustmentSummary(allTransactionSnapshots);

        return {
            transactionAdjustmentSnapshots: allTransactionSnapshots,
            adjustmentTransactions: allAdjustmentTransactions,
            adjustmentSnapshots: allSnapshots,
            adjustmentTotal: Number(totalAdjustment.toFixed(2)),
            adjustmentSummary
        };
    },

    _normalizeProofOfDelivery(
        proof?: ProofOfDeliveryRecord | null
    ): ProofOfDeliveryRecord | undefined {
        if (!proof) return undefined;

        const signatureDataUrl = resolveSignatureDataUrl(proof);
        if (!signatureDataUrl) return undefined;

        const normalizedMode = inferSignatureInputMode(
            proof.signatureInputMode,
            signatureDataUrl
        );

        return {
            ...proof,
            signature: signatureDataUrl,
            signatureDataUrl,
            signatureInputMode: normalizedMode,
            notes: proof.notes || proof.remarks,
            remarks: proof.remarks || proof.notes
        } as ProofOfDeliveryRecord;
    },

    async updateShipmentStatus(shipment: Shipment, deliveryNotePatch?: Partial<DeliveryNote>) {
        return dbService.executeAtomicOperation(
            ['shipments', 'deliveryNotes'],
            async (tx) => {
                const shipmentStore = tx.objectStore('shipments');
                const deliveryNoteStore = tx.objectStore('deliveryNotes');

                const normalizedShipmentProof = this._normalizeProofOfDelivery(shipment.proofOfDelivery);
                const normalizedShipment: Shipment = {
                    ...shipment,
                    proofOfDelivery: normalizedShipmentProof || shipment.proofOfDelivery
                };

                await shipmentStore.put(normalizedShipment);

                const deliveryNoteId = deliveryNotePatch?.id || shipment.orderId;
                let linkedDeliveryNote: DeliveryNote | undefined;

                if (deliveryNoteId) {
                    linkedDeliveryNote = await deliveryNoteStore.get(deliveryNoteId);
                }

                if (!linkedDeliveryNote && shipment.orderId) {
                    const allDeliveryNotes: DeliveryNote[] = await deliveryNoteStore.getAll();
                    linkedDeliveryNote = allDeliveryNotes.find((note) =>
                        note.id === shipment.orderId || note.invoiceId === shipment.orderId
                    );
                }

                if (!linkedDeliveryNote && !deliveryNotePatch) {
                    return { success: true, shipment: normalizedShipment, deliveryNote: null };
                }

                const mappedStatus: DeliveryNote['status'] | undefined =
                    (deliveryNotePatch?.status as DeliveryNote['status'] | undefined) ||
                    (shipment.status === 'Delivered'
                        ? 'Delivered'
                        : shipment.status === 'In Transit'
                            ? 'In Transit'
                            : undefined);

                const normalizedDeliveryProof = this._normalizeProofOfDelivery(
                    deliveryNotePatch?.proofOfDelivery || shipment.proofOfDelivery
                );

                const dnId = deliveryNoteId || shipment.orderId;
                const fallbackDeliveryNote: DeliveryNote = {
                    id: dnId,
                    number: dnId,
                    dnNumber: dnId,
                    invoiceId: shipment.orderId,
                    date: shipment.actualArrival || shipment.estimatedDelivery || new Date().toISOString(),
                    customerName: shipment.customerName,
                    clientName: shipment.customerName,
                    shippingAddress: '',
                    items: [],
                    status: mappedStatus || 'Pending'
                };

                const mergedDeliveryNote: DeliveryNote = {
                    ...(linkedDeliveryNote || fallbackDeliveryNote),
                    ...(deliveryNotePatch || {}),
                    id: linkedDeliveryNote?.id || deliveryNotePatch?.id || deliveryNoteId || shipment.orderId,
                    customerName:
                        deliveryNotePatch?.customerName ||
                        linkedDeliveryNote?.customerName ||
                        shipment.customerName,
                    carrier: deliveryNotePatch?.carrier ?? shipment.carrier ?? linkedDeliveryNote?.carrier,
                    driverName: deliveryNotePatch?.driverName ?? shipment.driverName ?? linkedDeliveryNote?.driverName,
                    vehicleNo: deliveryNotePatch?.vehicleNo ?? shipment.vehicleNo ?? linkedDeliveryNote?.vehicleNo,
                    trackingNumber:
                        deliveryNotePatch?.trackingNumber ?? shipment.trackingNumber ?? linkedDeliveryNote?.trackingNumber,
                    estimatedDelivery:
                        deliveryNotePatch?.estimatedDelivery ??
                        shipment.estimatedDelivery ??
                        linkedDeliveryNote?.estimatedDelivery,
                    actualArrival:
                        deliveryNotePatch?.actualArrival ?? shipment.actualArrival ?? linkedDeliveryNote?.actualArrival,
                    currentLocation:
                        deliveryNotePatch?.currentLocation ??
                        shipment.currentLocation ??
                        linkedDeliveryNote?.currentLocation,
                    status: mappedStatus || linkedDeliveryNote?.status || 'Pending',
                    proofOfDelivery:
                        normalizedDeliveryProof ||
                        linkedDeliveryNote?.proofOfDelivery ||
                        deliveryNotePatch?.proofOfDelivery
                };

                await deliveryNoteStore.put(mergedDeliveryNote);

                return { success: true, shipment: normalizedShipment, deliveryNote: mergedDeliveryNote };
            }
        );
    },

    async reconcileLegacyShipmentProofToDeliveryNotes() {
        return dbService.executeAtomicOperation(
            ['shipments', 'deliveryNotes'],
            async (tx) => {
                const shipmentStore = tx.objectStore('shipments');
                const deliveryNoteStore = tx.objectStore('deliveryNotes');

                const allShipments: Shipment[] = await shipmentStore.getAll();
                const allDeliveryNotes: DeliveryNote[] = await deliveryNoteStore.getAll();
                const deliveryNoteById = new Map(allDeliveryNotes.map((note) => [note.id, note]));
                const updatedDeliveryNotes: DeliveryNote[] = [];

                for (const shipment of allShipments) {
                    if (shipment.status !== 'Delivered' || !shipment.proofOfDelivery) continue;

                    const note = deliveryNoteById.get(shipment.orderId);
                    if (!note) continue;

                    const hasAuthoritativeProof = Boolean(
                        resolveSignatureDataUrl(note.proofOfDelivery)
                    );
                    if (hasAuthoritativeProof) continue;

                    const normalizedProof = this._normalizeProofOfDelivery(shipment.proofOfDelivery);
                    if (!normalizedProof) continue;

                    const patchedNote: DeliveryNote = {
                        ...note,
                        status: note.status === 'Delivered' ? note.status : 'Delivered',
                        carrier: note.carrier ?? shipment.carrier,
                        driverName: note.driverName ?? shipment.driverName,
                        vehicleNo: note.vehicleNo ?? shipment.vehicleNo,
                        trackingNumber: note.trackingNumber ?? shipment.trackingNumber,
                        estimatedDelivery: note.estimatedDelivery ?? shipment.estimatedDelivery,
                        actualArrival: note.actualArrival ?? shipment.actualArrival ?? normalizedProof.timestamp,
                        currentLocation: note.currentLocation ?? shipment.currentLocation ?? normalizedProof.locationStamp,
                        proofOfDelivery: normalizedProof
                    };

                    await deliveryNoteStore.put(patchedNote);
                    updatedDeliveryNotes.push(patchedNote);
                    deliveryNoteById.set(patchedNote.id, patchedNote);
                }

                return {
                    success: true,
                    updatedCount: updatedDeliveryNotes.length,
                    updatedDeliveryNotes
                };
            }
        );
    },

    /**
     * Processes a sale atomically: 
     * 1. Saves the sale record
     * 2. Updates inventory stock
     * 3. Creates ledger entries
     * 4. Handles excess payment (Wallet deposit)
     */
    async processSale(sale: Sale, excessHandling?: 'Change' | 'Wallet', performedBy?: string) {
        const stores: any[] = ['sales', 'inventory', 'ledger', 'accounts', 'customers', 'walletTransactions', 'customerPayments', 'vatTransactions', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'bankAccounts', 'bankTransactions', 'invoices', 'inventoryTransactions', 'idempotencyKeys'];

        const saleResult = await dbService.executeAtomicOperation(
            stores,
            async (tx) => {
                await reserveIdempotencyKey(tx, 'sale', sale.id, sale.idempotencyKey);

                const salesStore = tx.objectStore('sales');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const walletStore = tx.objectStore('walletTransactions');
                const customerPaymentsStore = tx.objectStore('customerPayments');
                const vatStore = tx.objectStore('vatTransactions');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const invoicesStore = tx.objectStore('invoices');

                // Pre-fetch data for snapshots
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();
                
                // Load accounts for resolution (required for all ledger writes)
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                
                // Helper to resolve GL account references to canonical account.id
                // STRICT MODE: throws UnresolvedAccountError if account cannot be resolved
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // 1. Validation & Snapshot Generation
                // We trust the snapshots passed from the UI (OrderForm/POS) if they exist and are valid.
                let snapshots: ConsumptionSnapshot[] = sale.consumptionSnapshots || [];

                // Fallback: If no snapshots provided (e.g. legacy/API), try to generate them using pricingService
                if (!snapshots || snapshots.length === 0) {
                    for (const item of sale.items) {
                        if (item.type !== 'Service' && item.printConsumptionEnabled) {
                            // Use the pricingService helper to generate a snapshot
                            // We need to fetch the item fully first
                            const invItem = await resolveInventoryRecord(item.id, inventory, inventoryStore);
                            if (invItem) {
                                const res = pricingService.calculateItemPrice(
                                    invItem,
                                    item.quantity,
                                    item.variantId,
                                    item.pagesOverride,
                                    inventory,
                                    bomTemplates,
                                    marketAdjustments // Include market adjustments in fallback
                                );
                                if (res.consumption) snapshots.push({ ...res.consumption, saleId: sale.id });
                            }
                        }
                    }
                    // Update sale with generated snapshots
                    sale.consumptionSnapshots = snapshots;
                }

                // 2a. Capture Transaction Pricing Snapshots for profit reporting
                const pricingSnapshots: TransactionPricingSnapshot[] = sale.items.map(cartItem => {
                    const invItem = inventory.find(i => i.id === cartItem.id);
                    const variantId = cartItem.variantId || cartItem.variant_id;
                    const variant = variantId && invItem?.variants?.find((v: any) => v.id === variantId);

                    const itemCost = Number(
                        variant?.costPrice ?? variant?.cost ?? invItem?.costPrice ?? invItem?.cost ?? invItem?.cost_price ?? 0
                    );
                    const itemPrice = Number(
                        variant?.sellingPrice ?? variant?.price ?? cartItem.price ?? invItem?.sellingPrice ?? invItem?.selling_price ?? invItem?.price ?? 0
                    );
                    const qty = cartItem.quantity || 1;
                    const profit = itemPrice - itemCost;
                    const margin = itemCost > 0 ? (profit / itemCost) * 100 : 0;
                    return {
                        itemId: cartItem.id,
                        itemName: variant?.name || invItem?.name || cartItem.name || '',
                        variantId: variant?.id,
                        variantName: variant?.name,
                        recipeVersion: variant?.recipeVersion,
                        costPrice: itemCost,
                        sellingPrice: itemPrice,
                        profitAmount: profit,
                        profitMargin: margin,
                        quantity: qty,
                        totalCost: itemCost * qty,
                        totalRevenue: itemPrice * qty,
                        totalProfit: profit * qty,
                        capturedAt: new Date().toISOString(),
                    };
                });
                sale.pricingSnapshots = pricingSnapshots;

                // 2. Inventory Deduction Gate
                const shouldDeduct = sale.status === 'Paid' || sale.status === 'Completed' || (sale.status === 'Partial' && sale.fulfillmentStatus === 'Delivered');

                if (shouldDeduct) {
                    await this._executeDeductInventory(
                        inventoryStore,
                        inventoryTransactionsStore,
                        sale.items,
                        snapshots,
                        'Sale',
                        sale.id,
                        performedBy || 'System',
                        inventory
                    );
                }

                // 3. Save the sale with snapshots
                sale.consumptionSnapshots = snapshots;

                // 4. Process Market Adjustments using shared helper
                const adjustmentResult = await this._processMarketAdjustments(
                    sale.items,
                    inventory,
                    bomTemplates,
                    marketAdjustments,
                    sale.id,
                    'sale',
                    inventoryStore
                );

                // Store both basic and granular adjustment data
                sale.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                    ? adjustmentResult.adjustmentSnapshots
                    : sale.adjustmentSnapshots;
                sale.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                    ? adjustmentResult.adjustmentTotal
                    : sale.adjustmentTotal;
                sale.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                sale.adjustmentSummary = adjustmentResult.adjustmentSummary;

                // Backward compatibility: store profitAdjustment from snapshots
                try {
                    const profit = extractProfitMargin(sale);
                    sale.profitAdjustment = profit;
                } catch (e) {
                    // ignore extraction errors
                }

                // Save adjustment transactions to the store
                for (const adjTx of adjustmentResult.adjustmentTransactions) {
                    await marketAdjustmentTransactionsStore.put(adjTx);
                }

                await salesStore.put(sale);

                const rawPayments = sale.payments && sale.payments.length > 0
                    ? sale.payments.map(payment => ({
                        method: payment.method,
                        amount: toMoney(payment.amount),
                        accountId: payment.accountId
                    }))
                    : [{
                        method: sale.paymentMethod || 'Cash',
                        amount: toMoney(sale.totalAmount),
                        accountId: undefined
                    }];

                const totalTendered = toMoney(rawPayments.reduce((sum, payment) => sum + payment.amount, 0));
                const saleTotal = toMoney(sale.totalAmount);
                const walletDepositAmount = excessHandling === 'Wallet'
                    ? toMoney(Math.max(0, totalTendered - saleTotal))
                    : 0;
                const retainedTarget = toMoney(
                    excessHandling === 'Wallet' ? totalTendered : saleTotal
                );
                const retainedAmounts = distributePosRetainedAmounts(rawPayments, retainedTarget);

                const normalizedPayments = rawPayments.map((payment, index) => {
                    const retained = toMoney(retainedAmounts[index] || 0);
                    const tendered = toMoney(payment.amount);
                    const excess = toMoney(Math.max(0, tendered - retained));
                    return {
                        ...payment,
                        tendered,
                        retained,
                        excess,
                        reference: rawPayments.length > 1 ? `POS-${sale.id}-${index + 1}` : `POS-${sale.id}`,
                        description: `POS Sale #${sale.id} (${payment.method})`
                    };
                });

                const totalRetained = toMoney(normalizedPayments.reduce((sum, payment) => sum + payment.retained, 0));
                const totalChange = toMoney(Math.max(0, totalTendered - totalRetained));
                sale.cash_tendered = totalTendered;
                sale.change_due = totalChange;
                sale.excessAmount = walletDepositAmount > 0 ? walletDepositAmount : totalChange;
                await salesStore.put(sale);

                // 3. Create Ledger Entries
                const gl = getGLConfig();
                const vatConfig = getVatConfig();
                const totalAmount = Number(sale.totalAmount);
                const roundingDiff = Number(sale.roundingDifference || 0);
                let revenueAmount = totalAmount - roundingDiff;
                let taxAmount = 0;
                // Phase 5 / B10: VAT and market adjustments compose independently.
                // Legacy configs without explicit flags fall back to pricingMode.
                const isVatMode = isVatPostingActive(vatConfig);
                const isMarketMode = isMarketPostingActive(vatConfig);
                // B2: split to the market account ONLY when it resolves to a real
                // postable account — otherwise the full amount stays in revenue
                // (previously revenue was reduced with no offsetting credit).
                const marketDecision = decideMarketPosting({
                    isMarketMode,
                    adjustmentTotal: (sale as any).adjustmentTotal,
                    configuredAccountId: vatConfig?.marketAdjustmentAccount,
                    resolveAccount: (id: string) => resolveAccountForPosting(id, accounts, accountOptions),
                });
                const marketAdjustmentAmount = marketDecision.marketAmount;
                const marketAdjustmentAccountId = marketDecision.marketAccountId;
                if (marketDecision.unpostedAmount > 0) {
                    logger.warn(`Market adjustment ${marketDecision.unpostedAmount} kept in revenue for sale #${sale.id}: no valid marketAdjustmentAccount configured`);
                    (sale as any).marketAdjustmentAccountId = null;
                    (sale as any).marketAdjustmentUnposted = marketDecision.unpostedAmount;
                    await salesStore.put(sale);
                } else if (marketAdjustmentAccountId) {
                    (sale as any).marketAdjustmentAccountId = marketAdjustmentAccountId;
                    (sale as any).marketAdjustmentUnposted = 0;
                    await salesStore.put(sale);
                }

                const paymentRatio = totalAmount > 0 ? Math.min(1, totalRetained / totalAmount) : 0;
                const outstandingAmount = Math.max(0, toMoney(totalAmount - totalRetained));

                // VAT leg posts first (tax on total - rounding); the market leg
                // below then splits off revenue. Both may post on one sale.
                if (isVatMode && vatConfig?.outputTaxAccount) {
                    const rate = vatConfig.rate || 17.5;
                    // Tax is typically calculated on the unrounded, unadjusted base.
                    // But simplified here: assume tax included in total, proportional.
                    // If rounding exists, tax should be on (Total - Rounding).
                    const baseForTax = revenueAmount;
                    taxAmount = baseForTax - (baseForTax / (1 + rate / 100));
                    revenueAmount -= taxAmount;

                    const vatTx: VatTransaction = {
                        id: generateId('VAT'),
                        date: sale.date,
                        type: 'Output',
                        amount: Number(taxAmount.toFixed(2)),
                        taxableAmount: Number(revenueAmount.toFixed(2)),
                        rate: rate,
                        referenceId: sale.id,
                        referenceType: 'Invoice',
                        description: `VAT on Sale #${sale.id}`,
                        isFiled: false,
                        customerName: sale.customerName
                    };
                    await vatStore.put(vatTx);

                    const paidTax = roundToCurrency(taxAmount * paymentRatio);
                    const unpaidTax = roundToCurrency(taxAmount - paidTax);

                    if (paidTax > 0) {
                        const taxEntry: LedgerEntry = {
                            id: generateId('LG-TAX'),
                            date: sale.date,
                            description: `VAT Output - Sale #${sale.id}`,
                            debitAccountId: resolveAcct(gl.cashDrawerAccount),
                            creditAccountId: resolveAcct(vatConfig.outputTaxAccount),
                            amount: Number(paidTax.toFixed(2)),
                            referenceId: sale.id,
                            reconciled: false,
                            customerId: sale.customerId,
                            customerName: sale.customerName
                        };
                        await ledgerStore.put(taxEntry);
                    }

                    if (unpaidTax > 0) {
                        const taxEntry: LedgerEntry = {
                            id: generateId('LG-TAX-AR'),
                            date: sale.date,
                            description: `VAT Output (AR) - Sale #${sale.id}`,
                            debitAccountId: resolveAcct(gl.accountsReceivable),
                            creditAccountId: resolveAcct(vatConfig.outputTaxAccount),
                            amount: Number(unpaidTax.toFixed(2)),
                            referenceId: sale.id,
                            reconciled: false,
                            customerId: sale.customerId,
                            customerName: sale.customerName
                        };
                        await ledgerStore.put(taxEntry);
                    }
                }

                if (marketAdjustmentAccountId && marketAdjustmentAmount > 0) {
                    revenueAmount -= marketAdjustmentAmount;

                    {
                        const paidMarket = roundToCurrency(marketAdjustmentAmount * paymentRatio);
                        const unpaidMarket = roundToCurrency(marketAdjustmentAmount - paidMarket);

                        if (paidMarket > 0) {
                            const marketEntry: LedgerEntry = {
                                id: generateId('LG-MKT'),
                                date: sale.date,
                                description: `Market Adjustment - Sale #${sale.id}`,
                                debitAccountId: resolveAcct(gl.cashDrawerAccount),
                                creditAccountId: resolveAcct(marketAdjustmentAccountId),
                                amount: Number(paidMarket.toFixed(2)),
                                referenceId: sale.id,
                                reconciled: false,
                                customerId: sale.customerId,
                                customerName: sale.customerName
                            };
                            await ledgerStore.put(marketEntry);
                        }

                        if (unpaidMarket > 0) {
                            const marketEntry: LedgerEntry = {
                                id: generateId('LG-MKT-AR'),
                                date: sale.date,
                                description: `Market Adjustment (AR) - Sale #${sale.id}`,
                                debitAccountId: resolveAcct(gl.accountsReceivable),
                                creditAccountId: resolveAcct(marketAdjustmentAccountId),
                                amount: Number(unpaidMarket.toFixed(2)),
                                referenceId: sale.id,
                                reconciled: false,
                                customerId: sale.customerId,
                                customerName: sale.customerName
                            };
                            await ledgerStore.put(marketEntry);
                        }
                    }
                }


                const paidRevenue = roundToCurrency(revenueAmount * paymentRatio);
                const unpaidRevenue = roundToCurrency(revenueAmount - paidRevenue);

                const revenueAccountId = sale.salesAccountId || gl.defaultSalesAccount;

                if (paidRevenue > 0) {
                    const revenueEntry: LedgerEntry = {
                        id: generateId('LG-REV'),
                        date: sale.date,
                        description: `POS Sale Revenue #${sale.id}`,
                        debitAccountId: resolveAcct(gl.cashDrawerAccount),
                        creditAccountId: resolveAcct(revenueAccountId),
                        amount: Number(paidRevenue.toFixed(2)),
                        referenceId: sale.id,
                        reconciled: false,
                        customerId: sale.customerId,
                        customerName: sale.customerName
                    };
                    await ledgerStore.put(revenueEntry);
                }

                if (unpaidRevenue > 0) {
                    const revenueEntry: LedgerEntry = {
                        id: generateId('LG-REV-AR'),
                        date: sale.date,
                        description: `POS Sale Revenue (AR) #${sale.id}`,
                        debitAccountId: resolveAcct(gl.accountsReceivable),
                        creditAccountId: resolveAcct(revenueAccountId),
                        amount: Number(unpaidRevenue.toFixed(2)),
                        referenceId: sale.id,
                        reconciled: false,
                        customerId: sale.customerId,
                        customerName: sale.customerName
                    };
                    await ledgerStore.put(revenueEntry);
                }

                if (shouldDeduct) {
                    // Split COGS across inventory accounts by line cost:
                    // DR 51200 (total) = CR 11410 + CR 11420 + CR 11430.
                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        sale.items || [],
                        inventory,
                        (item) => item.parentId || item.id,
                        accounts,
                        () => resolveAcct(gl.defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    for (const leg of cogsLegs) {
                        if (!leg.inventoryAccountId) continue;
                        const cogsEntry: LedgerEntry = {
                            id: generateId('LG-COGS'),
                            date: sale.date,
                            description: `COGS - Sale #${sale.id}`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: leg.inventoryAccountId,
                            amount: leg.amount,
                            referenceId: sale.id,
                            reconciled: false,
                            customerId: sale.customerId,
                            customerName: sale.customerName
                        };
                        await ledgerStore.put(cogsEntry);
                        cogsEntries.push(cogsEntry);
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Sale #${sale.id}`);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed — views use canonicalLedger via
                // customerLedger.ts instead of this stale cache field.

                // If sale has specific payments, reflect retained amounts in GL.
                for (const payment of normalizedPayments) {
                    if (payment.retained <= 0) continue;

                    let targetDebitAccount = gl.cashDrawerAccount;
                    if (payment.method === 'Wallet') {
                        targetDebitAccount = gl.customerDepositAccount;
                } else if (payment.accountId) {
                    targetDebitAccount = resolveAcct(payment.accountId);
                    } else {
                        if (payment.method === 'Card' || payment.method === 'Bank Transfer') targetDebitAccount = gl.bankAccount;
                        if (payment.method === 'Mobile Money') targetDebitAccount = gl.mobileMoneyAccount;
                    }

                    const payEntry: LedgerEntry = {
                        id: generateId('LG-PAY'),
                        date: sale.date,
                        description: `Payment [${payment.method}] - Sale #${sale.id}`,
                        debitAccountId: resolveAcct(targetDebitAccount),
                        creditAccountId: resolveAcct(gl.cashDrawerAccount), // Clear temporary cash debit from revenue entry
                        amount: payment.retained,
                        referenceId: sale.id,
                        reconciled: false,
                        customerId: sale.customerId,
                        customerName: sale.customerName
                    };
                    await ledgerStore.put(payEntry);

                    // Automatic transfer to Main Ledger for cash payments
                    if (payment.method === 'Cash') {
                        const transferEntry: LedgerEntry = {
                            id: generateId('LG-TRANSFER'),
                            date: sale.date,
                            description: `Auto-transfer to Main Ledger - Sale #${sale.id}`,
                            debitAccountId: resolveAcct(gl.bankAccount),
                            creditAccountId: resolveAcct(gl.cashDrawerAccount),
                            amount: payment.retained,
                            referenceId: sale.id,
                            reconciled: false,
                            customerId: sale.customerId,
                            customerName: sale.customerName
                        };
                        await ledgerStore.put(transferEntry);
                    }
                }

                if (walletDepositAmount > 0 && sale.customerId && sale.customerId !== 'walk-in') {
                    const customer = await customerStore.get(sale.customerId);
                    if (customer) {
                        customer.walletBalance = toMoney((customer.walletBalance || 0) + walletDepositAmount);
                        await customerStore.put(customer);

                        const walletTx: WalletTransaction = {
                            id: generateId('WLT-POS'),
                            customerId: sale.customerId,
                            amount: walletDepositAmount,
                            type: 'Deposit',
                            date: sale.date,
                            description: `Wallet deposit from POS Sale #${sale.id}`
                        };
                        await walletStore.put(walletTx);
                    }

                    const walletLedgerEntry: LedgerEntry = {
                        id: generateId('LG-WLT'),
                        date: sale.date,
                        description: `POS wallet deposit - Sale #${sale.id}`,
                        debitAccountId: resolveAcct(gl.cashDrawerAccount),
                        creditAccountId: resolveAcct(gl.customerDepositAccount),
                        amount: walletDepositAmount,
                        referenceId: sale.id,
                        reconciled: false,
                        customerId: sale.customerId,
                        customerName: sale.customerName
                    };
                    await ledgerStore.put(walletLedgerEntry);
                }

                // 5. Create Customer Payment Records
                const allPayments = await customerPaymentsStore.getAll();
                let tempPayments = [...allPayments];

                for (const payment of normalizedPayments) {
                    const nextId = generateNextId('REC', tempPayments);
                    const snapshot = calculateCustomerPaymentSnapshot({
                        amountTendered: payment.tendered,
                        appliedInvoices: [{
                            invoiceId: sale.id,
                            allocationAmount: payment.retained,
                            outstandingAmount: payment.retained
                        }],
                        excessHandling: payment.excess > 0
                            ? (excessHandling === 'Wallet' ? 'Wallet' : 'Change')
                            : undefined,
                        paymentPurpose: 'POS_PAYMENT',
                        paymentDate: sale.date,
                        customerName: sale.customerName
                    });

                    const custPayment: CustomerPayment = {
                        id: nextId,
                        date: sale.date,
                        customerId: sale.customerId || 'WALK-IN',
                        customerName: sale.customerName || 'Walk-in Customer',
                        amount: payment.retained,
                        paymentMethod: payment.method,
                        accountId: payment.accountId,
                        reference: sale.id,
                        notes: `POS Sale #${sale.id} - ${payment.method}${payment.excess > 0 ? ` (Tendered ${payment.tendered})` : ''}`,
                        allocations: [],
                        status: 'Cleared',
                        reconciled: false,
                        excessHandling: payment.excess > 0 ? (excessHandling === 'Wallet' ? 'Wallet' : 'Change') : undefined,
                        excessAmount: payment.excess > 0 && excessHandling === 'Wallet' ? payment.excess : undefined,
                        receiptSnapshot: snapshot,
                        invoiceTotal: snapshot.invoiceTotalAtPosting,
                        paymentStatus: snapshot.paymentStatus,
                        balanceDue: snapshot.balanceDueAfterPayment,
                        overpaymentAmount: snapshot.walletDeposit,
                        walletDeposit: snapshot.walletDeposit,
                        changeGiven: snapshot.changeGiven,
                        amountApplied: snapshot.amountApplied,
                        amountRetained: snapshot.amountRetained,
                        calculationVersion: snapshot.calculationVersion
                    };

                    await customerPaymentsStore.put(ensureDocumentVerificationToken(custPayment as any));
                    tempPayments.push(custPayment);
                }

                // 6. Mirror POS payments to Banking accounts (if linked)
                const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                let bankTransactions = await bankTransactionsStore.getAll();

                const recordBankDeposit = async (
                    amount: number,
                    method: string,
                    accountId: string | undefined,
                    reference: string,
                    description: string
                ) => {
                    if (!amount || amount <= 0) return;
                    const bankAccount = resolveBankAccountForPayment(bankAccounts, {
                        accountId,
                        paymentMethod: method
                    });
                    if (!bankAccount) return;

                    const existing = bankTransactions.find(tx =>
                        tx.bankAccountId === bankAccount.id &&
                        tx.reference === reference &&
                        tx.type === 'Deposit'
                    );
                    if (existing) return;

                    const bankTx: BankTransaction = {
                        id: generateNextId('TXN', bankTransactions),
                        date: sale.date,
                        amount: amount,
                        type: 'Deposit',
                        description,
                        reference,
                        bankAccountId: bankAccount.id,
                        counterparty: sale.customerName ? { name: sale.customerName } : undefined,
                        category: 'Income',
                        reconciled: false,
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString()
                    };

                    await bankTransactionsStore.put(bankTx);
                    bankTransactions = [...bankTransactions, bankTx];

                    const nextBalance = calculateBankBalance(bankTransactions, bankAccount.id);
                    await bankAccountsStore.put({
                        ...bankAccount,
                        balance: roundToCurrency(nextBalance),
                        availableBalance: roundToCurrency(nextBalance),
                        updatedAt: new Date().toISOString()
                    });
                };

                for (const payment of normalizedPayments) {
                    if (payment.method === 'Wallet' || payment.method === 'Loyalty' || payment.method === 'Credit') continue;
                    await recordBankDeposit(
                        Number(payment.retained || 0),
                        payment.method,
                        payment.accountId,
                        payment.reference,
                        payment.description
                    );
                }

                // Create Invoice record for POS sales to appear in general invoice list
                const invoicePaid = Math.max(0, Math.min(totalRetained, saleTotal));
                const invoiceStatus: Invoice['status'] =
                    invoicePaid >= saleTotal ? 'Paid' : (invoicePaid > 0 ? 'Partial' : 'Unpaid');
                const existingInvoices = await invoicesStore.getAll();
                const hasInvoiceIdConflict = existingInvoices.some(
                    (existing: any) => String(existing?.id || '') === String(sale.id)
                );
                let invoiceId = hasInvoiceIdConflict ? '' : String(sale.id);
                if (!hasInvoiceIdConflict) {
                    try {
                        assertInvoiceNumberFormat(invoiceId, getCompanyConfig(), 'invoice');
                    } catch {
                        invoiceId = '';
                    }
                }
                if (!invoiceId) {
                    // Avoid nested/non-transactional async work inside an active IDB transaction.
                    // Calling document-number service here can commit this tx early, causing
                    // "TransactionInactiveError: The transaction has finished" on later puts.
                    const prefix = String(sale.id || '').toUpperCase().startsWith('POS-') ? 'POS' : 'INV';
                    invoiceId = generateNextId(prefix, existingInvoices);
                }

                const invoice: Invoice = {
                    id: invoiceId,
                    date: sale.date,
                    dueDate: sale.date, // POS sales are immediate, due immediately
                    customerId: sale.customerId,
                    customerName: sale.customerName || 'Walk-in Customer',
                    totalAmount: sale.totalAmount,
                    paidAmount: invoicePaid,
                    status: invoiceStatus,
                    items: sale.items,
                    subAccountName: sale.subAccountName,
                    notes: `POS Sale - Source: ${sale.source || 'POS'}`,
                    reference: sale.id,
                    warehouseId: sale.warehouseId,
                    originalPrice: sale.originalPrice,
                    roundedPrice: sale.roundedPrice,
                    roundingDifference: sale.roundingDifference,
                    roundingMethod: sale.roundingMethod,
                    applyRounding: sale.applyRounding,
                    adjustmentTotal: sale.adjustmentTotal,
                    adjustmentSnapshots: sale.adjustmentSnapshots,
                    consumptionSnapshots: sale.consumptionSnapshots,
                    isPriceLocked: sale.isPriceLocked,
                    transactionAdjustments: sale.transactionAdjustments,
                    adjustmentSummary: sale.adjustmentSummary,
                    referredBy: sale.referredBy,
                    referredByName: sale.referredByName,
                };
                await invoicesStore.put(invoice);

                return { success: true, id: sale.id, _mirrorInvoiceId: invoiceId, _paidInvoice: invoiceStatus === 'Paid' && sale.customerId ? { id: invoiceId, status: invoiceStatus, customerId: sale.customerId, totalAmount: sale.totalAmount, paidAmount: invoicePaid, referredBy: sale.referredBy, referredByName: sale.referredByName } : null };
            }
        );
        if (saleResult?._paidInvoice) {
            import('./referralService').then(({ referralService }) =>
                referralService.processInvoiceReward(saleResult._paidInvoice).catch(err =>
                    logger.error('Referral reward processing failed:', err)
                )
            );
        }
        // Phase 5 — Transport Budget sales allocation (post-commit,
        // fire-and-forget like the referral hook above: never blocks posting,
        // never rolls back the committed sale; safe to invoke twice via the
        // Phase 4 economic-idempotency layer).
        import('./transportBudgetSalesAllocation').then(
            ({ allocateForPostedSale, defaultSalesAllocationDeps, fireAllocationHook }) =>
                fireAllocationHook(
                    allocateForPostedSale(
                        defaultSalesAllocationDeps,
                        sale,
                        (saleResult as any)?._mirrorInvoiceId
                    ),
                    `sale:${sale.id}`
                )
        );
        return saleResult;
    },

    async deleteSalesExchange(id: string) {
        // Enforce "No deletion" policy by converting delete to cancel if it's pending, 
        // or just blocking it if it's already processed.
        return dbService.executeAtomicOperation(
            ['salesExchanges'],
            async (tx) => {
                const store = tx.objectStore('salesExchanges');
                const exchange = await store.get(id);
                if (!exchange) throw new Error("Exchange not found");

                if (exchange.status === 'approved' || exchange.status === 'completed') {
                    throw new Error("Cannot delete/cancel an exchange that has already been approved or completed.");
                }

                exchange.status = 'Cancelled';
                await store.put(exchange);
            }
        );
    },

    async cancelSalesExchange(id: string, reason: string = "Cancelled by user") {
        return dbService.executeAtomicOperation(
            ['salesExchanges'],
            async (tx) => {
                const store = tx.objectStore('salesExchanges');
                const exchange = await store.get(id);
                if (!exchange) throw new Error("Exchange not found");

                if (exchange.status === 'Approved' || exchange.status === 'Completed' || exchange.status === 'approved' || exchange.status === 'completed') {
                    throw new Error("Cannot cancel an exchange that has already been approved or completed.");
                }

                exchange.status = 'Cancelled';
                exchange.cancel_reason = reason;
                exchange.cancelled_at = new Date().toISOString();
                await store.put(exchange);
            }
        );
    },

    async bulkCancelSalesExchanges(ids: string[], reason: string = "Bulk cancelled by user") {
        return dbService.executeAtomicOperation(
            ['salesExchanges'],
            async (tx) => {
                const store = tx.objectStore('salesExchanges');
                const results = { cancelled: 0, failed: 0, errors: [] as string[] };

                for (const id of ids) {
                    try {
                        const exchange = await store.get(id);
                        if (!exchange) {
                            results.failed++;
                            results.errors.push(`Exchange ${id} not found`);
                            continue;
                        }

                        if (exchange.status === 'Approved' || exchange.status === 'Completed' || exchange.status === 'approved' || exchange.status === 'completed') {
                            results.failed++;
                            results.errors.push(`Exchange ${id} already processed`);
                            continue;
                        }

                        exchange.status = 'Cancelled';
                        exchange.cancel_reason = reason;
                        exchange.cancelled_at = new Date().toISOString();
                        await store.put(exchange);
                        results.cancelled++;
                    } catch (err: any) {
                        results.failed++;
                        results.errors.push(`Error cancelling ${id}: ${err.message}`);
                    }
                }
                return results;
            }
        );
    },

    async processRefund(refund: any) {
        return dbService.executeAtomicOperation(
            ['sales', 'inventory', 'ledger', 'customers', 'vatTransactions', 'accounts'],
            async (tx) => {
                const salesStore = tx.objectStore('sales');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const vatStore = tx.objectStore('vatTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // 1. Save refund record (using sales store for now)
                await salesStore.put(refund);

                // 2. Return to inventory
                for (const item of refund.items) {
                    if (item.type !== 'Service') {
                        const targetItemId = item.itemId || item.id;
                        if (!targetItemId) continue;
                        const invItem = await inventoryStore.get(targetItemId);
                        if (invItem) {
                            invItem.stock = (invItem.stock || 0) + item.quantity;
                            await inventoryStore.put(invItem);
                        }
                    }
                }

                const refundCogsLegs = await calculateCogsLegsPerInventoryAccount(
                    refund.items || [],
                    inventoryStore,
                    (item) => item.itemId || item.id,
                    accounts,
                    () => resolveAcct(getGLConfig().defaultInventoryAccount)
                );

                if (refundCogsLegs.length > 0) {
                    const gl = getGLConfig();
                    const reversalEntries: LedgerEntry[] = [];
                    for (const leg of refundCogsLegs) {
                        const cogsReversal: LedgerEntry = {
                            id: generateId('LG-COGS-REV'),
                            date: refund.date,
                            description: `COGS Reversal - Refund #${refund.saleId || refund.id}`,
                            debitAccountId: leg.inventoryAccountId || resolveAcct(gl.defaultInventoryAccount),
                            creditAccountId: resolveAcct(gl.defaultCOGSAccount),
                            amount: leg.amount,
                            referenceId: refund.id,
                            reconciled: false,
                            customerId: refund.customerId,
                            customerName: refund.customerName
                        };
                        await ledgerStore.put(cogsReversal);
                        reversalEntries.push(cogsReversal);
                    }
                    validateLedgerBalance(reversalEntries, `COGS reversal split - Refund #${refund.saleId || refund.id}`);
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed — views use canonicalLedger via
                // customerLedger.ts instead of this stale cache field.

                // 4. Ledger Entry for Refund
                const gl = getGLConfig();
                const vatConfig = getVatConfig();
                const totalAmount = Number(refund.totalAmount || refund.refundAmount || 0);

                let targetCreditAccount = gl.cashDrawerAccount;
                if (refund.accountId) {
                    targetCreditAccount = refund.accountId;
                } else if (refund.refundMethod === 'Mobile Money') {
                    targetCreditAccount = gl.mobileMoneyAccount;
                } else if (refund.refundMethod === 'Bank Transfer' || refund.refundMethod === 'Card') {
                    targetCreditAccount = gl.bankAccount;
                }

                let revenueReturnAmount = totalAmount;
                let taxReturnAmount = 0;
                let marketAdjustmentReturnAmount = 0; // Need to fetch original sale to know this, but for now assuming proportional if not stored

                // If we can fetch the original sale, we should reverse VAT and Market Adjustments proportionally
                if (refund.saleId) {
                    const originalSale = await salesStore.get(refund.saleId);
                    if (originalSale) {
                        const originalTotal = originalSale.totalAmount;
                        const ratio = totalAmount / originalTotal;

                        const adjustmentTotal = originalSale.adjustmentTotal || originalSale.marketAdjustmentApplied || 0;
                        if (adjustmentTotal > 0) {
                            // Proportional share only — the revenue split happens below,
                            // once we know whether a valid market account exists.
                            marketAdjustmentReturnAmount = adjustmentTotal * ratio;
                        }

                        // VAT Reversal
                        if (vatConfig?.enabled && vatConfig.outputTaxAccount) {
                            const rate = vatConfig.rate || 17.5;
                            // Calculate tax component of the refund amount
                            taxReturnAmount = totalAmount - (totalAmount / (1 + rate / 100));
                            revenueReturnAmount -= taxReturnAmount;

                            // Create Negative VAT Transaction (Input/Credit Note)
                            const vatTx: VatTransaction = {
                                id: generateId('VAT-REF'),
                                date: refund.date,
                                type: 'Input', // Treated as Input to reduce liability, or negative Output
                                amount: Number(taxReturnAmount.toFixed(2)),
                                taxableAmount: Number(revenueReturnAmount.toFixed(2)),
                                rate: rate,
                                referenceId: refund.id,
                                referenceType: 'Invoice', // Credit Note
                                description: `VAT Reversal - Refund #${refund.id} for Sale #${refund.saleId}`,
                                isFiled: false,
                                customerName: refund.customerName
                            };
                            await vatStore.put(vatTx);

                            // Debit VAT Account (Reduce Liability)
                            const taxEntry: LedgerEntry = {
                                id: generateId('LG-TAX-REF'),
                                date: refund.date,
                                description: `VAT Reversal - Refund #${refund.id}`,
                                debitAccountId: resolveAcct(vatConfig.outputTaxAccount),
                                creditAccountId: resolveAcct(targetCreditAccount),
                                amount: Number(taxReturnAmount.toFixed(2)),
                                referenceId: refund.id,
                                reconciled: false,
                                customerId: refund.customerId,
                                customerName: refund.customerName
                            };
                            await ledgerStore.put(taxEntry);
                        }

                        // Market Adjustment Reversal — mirror the sale: reverse through the
                        // ORIGINAL sale's market account when present, else current config.
                        // If neither resolves, the amount stays inside the revenue return
                        // instead of being dropped.
                        if (marketAdjustmentReturnAmount > 0) {
                            const originalMarketAccountId =
                                (originalSale as any)?.marketAdjustmentAccountId ||
                                vatConfig?.marketAdjustmentAccount;
                            const reversalDecision = decideMarketPosting({
                                isMarketMode: true,
                                adjustmentTotal: marketAdjustmentReturnAmount,
                                configuredAccountId: originalMarketAccountId,
                                resolveAccount: (id: string) => resolveAccountForPosting(id, accounts, accountOptions),
                            });
                            if (reversalDecision.marketAccountId && reversalDecision.marketAmount > 0) {
                                revenueReturnAmount -= reversalDecision.marketAmount;
                                const marketEntry: LedgerEntry = {
                                    id: generateId('LG-MKT-REF'),
                                    date: refund.date,
                                    description: `Market Adjustment Reversal - Refund #${refund.id}`,
                                    debitAccountId: resolveAcct(reversalDecision.marketAccountId),
                                    creditAccountId: resolveAcct(targetCreditAccount),
                                    amount: Number(reversalDecision.marketAmount.toFixed(2)),
                                    referenceId: refund.id,
                                    reconciled: false,
                                    customerId: refund.customerId,
                                    customerName: refund.customerName
                                };
                                await ledgerStore.put(marketEntry);
                            } else {
                                logger.warn(`Market reversal ${marketAdjustmentReturnAmount} kept in revenue return for refund #${refund.id}: no valid market account`);
                            }
                        }
                    }
                }

                // Debit Revenue Return (Net Amount)
                const revenueReturnEntry: LedgerEntry = {
                    id: generateId('LG-REF-REV'),
                    date: refund.date,
                    description: `Refund Revenue Return - Sale #${refund.saleId || refund.id}`,
                    debitAccountId: resolveAcct(refund.salesAccountId || gl.salesReturnAccount || gl.defaultSalesAccount),
                    creditAccountId: resolveAcct(targetCreditAccount),
                    amount: Number(revenueReturnAmount.toFixed(2)),
                    referenceId: refund.id,
                    reconciled: false,
                    customerId: refund.customerId,
                    customerName: refund.customerName
                };
                await ledgerStore.put(revenueReturnEntry);

                return { success: true };
            }
        );
    },

    async processQuotation(quotation: any) {
        const result = await dbService.executeAtomicOperation(
            ['quotations'],
            async (tx) => {
                const store = tx.objectStore('quotations');
                const issuedDate = quotation.date || new Date().toISOString();
                const quotationPaymentTerms = 'Net 7';
                const quotationDueDate = calculateDueDate(issuedDate, quotationPaymentTerms);
                quotation.date = issuedDate;
                quotation.paymentTerms = quotationPaymentTerms;
                quotation.dueDate = quotationDueDate;
                quotation.validUntil = quotationDueDate;
                await store.put(ensureDocumentVerificationToken(quotation));
                return { success: true };
            }
        );
        return result;
    },

    async approveQuotation(id: string) {
        return dbService.executeAtomicOperation(
            ['quotations'],
            async (tx) => {
                const store = tx.objectStore('quotations');
                const quotation = await store.get(id);
                if (!quotation) throw new Error("Quotation not found");
                quotation.status = 'Approved';
                quotation.isPriceLocked = true; // Lock price once approved
                await store.put(quotation);
                return { success: true };
            }
        );
    },

    async processQuotationRevision(originalId: string, revision: any) {
        return dbService.executeAtomicOperation(
            ['quotations'],
            async (tx) => {
                const store = tx.objectStore('quotations');

                // Update original quotation status
                const original = await store.get(originalId);
                if (original) {
                    original.status = 'Revised';
                    await store.put(original);
                }

                // Save new revision
                await store.put(revision);
                return { success: true };
            }
        );
    },

    async processRecurringInvoice(invoice: Invoice, subId: string, updatedSub: any) {
        return dbService.executeAtomicOperation(
            ['invoices', 'recurringInvoices', 'ledger', 'customers', 'inventory', 'inventoryTransactions', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'customerPayments', 'bankAccounts', 'bankTransactions', 'accounts'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const subStore = tx.objectStore('recurringInvoices');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const inventoryStore = tx.objectStore('inventory');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const customerPaymentsStore = tx.objectStore('customerPayments');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // Pre-fetch data for adjustment processing
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();

                // Enforce invoice terms policy before persistence.
                const issuedDate = invoice.date || new Date().toISOString();
                invoice.date = issuedDate;
                let effectivePaymentTerms = String(invoice.paymentTerms || '').trim();
                if (!effectivePaymentTerms && invoice.customerId) {
                    const customer = await customerStore.get(invoice.customerId);
                    if (customer) {
                        effectivePaymentTerms = resolveCustomerPaymentTerms({
                            customer,
                            subAccountName: invoice.subAccountName,
                            transactionType: 'invoice',
                            preserveCustomTerms: true
                        });
                    }
                }

                if (effectivePaymentTerms) {
                    invoice.paymentTerms = effectivePaymentTerms;
                    invoice.dueDate = calculateDueDate(issuedDate, effectivePaymentTerms);
                } else if (!invoice.dueDate) {
                    invoice.dueDate = issuedDate;
                }

                assertInvoiceNumberFormat(invoice.id, getCompanyConfig(), 'invoice');

                // 1. Save Invoice
                await invoiceStore.put(invoice);

                // 2. Update Subscription
                await subStore.put(updatedSub);

                // 3. Update Inventory (Gated)
                const shouldDeduct = updatedSub.status === 'Active'; // For recurring, we deduct if the sub is active when firing
                if (shouldDeduct) {
                    await this._executeDeductInventory(
                        inventoryStore,
                        inventoryTransactionsStore,
                        invoice.items || [],
                        invoice.consumptionSnapshots || [],
                        'RecurringInvoice',
                        invoice.id,
                        'System'
                    );
                }

                // 4. Process Market Adjustments using shared helper
                const adjustmentResult = await this._processMarketAdjustments(
                    invoice.items,
                    inventory,
                    bomTemplates,
                    marketAdjustments,
                    invoice.id,
                    'invoice',
                    inventoryStore
                );

                // Store adjustment data on invoice
                invoice.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                    ? adjustmentResult.adjustmentSnapshots
                    : invoice.adjustmentSnapshots;
                invoice.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                    ? adjustmentResult.adjustmentTotal
                    : invoice.adjustmentTotal;
                invoice.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                invoice.adjustmentSummary = adjustmentResult.adjustmentSummary;

                // Backward compatibility: store profitAdjustment from snapshots on invoice
                try {
                    const profitInv = extractProfitMargin(invoice);
                    invoice.profitAdjustment = profitInv;
                } catch (e) {
                    // ignore
                }

                // Save adjustment transactions to the store
                for (const adjTx of adjustmentResult.adjustmentTransactions) {
                    await marketAdjustmentTransactionsStore.put(adjTx);
                }

                // F-11: Normalize paid amount and status before final save.
                // Do not silently clamp the overpayment — route the excess to
                // the customer's wallet so it's auditable, then keep
                // `invoice.paidAmount` within [0, totalAmount].
                const totalAmount = Number(invoice.totalAmount || 0);
                const rawPaidAmount = Number(invoice.paidAmount || 0);
                const overpayment = Math.max(0, rawPaidAmount - totalAmount);
                if (overpayment > 0.01) {
                    await this.processOverpaymentToWallet(invoice, overpayment);
                }
                const paidAmount = Math.max(0, Math.min(rawPaidAmount, totalAmount));
                invoice.paidAmount = paidAmount;

                if (invoice.status !== 'Draft' && invoice.status !== 'Cancelled') {
                    if (paidAmount >= totalAmount && totalAmount > 0) {
                        invoice.status = 'Paid';
                    } else if (paidAmount > 0) {
                        invoice.status = 'Partial';
                    } else if (invoice.status === 'Paid' || invoice.status === 'Partial') {
                        invoice.status = 'Unpaid';
                    }
                }

                // Update invoice with adjustment data
                await invoiceStore.put(invoice);

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed — views use canonicalLedger via
                // customerLedger.ts instead of this stale cache field.

                // 6. Ledger Entry
                const gl = getGLConfig();

                // Debit AR
                const arEntry: LedgerEntry = {
                    id: generateId('LG-REC-AR'),
                    date: invoice.date,
                    description: `Recurring Invoice #${invoice.id}`,
                    debitAccountId: resolveAcct(gl.accountsReceivable),
                    creditAccountId: resolveAcct(invoice.salesAccountId || gl.defaultSalesAccount),
                    amount: totalAmount,
                    referenceId: invoice.id,
                    reconciled: false,
                    customerId: invoice.customerId,
                    customerName: invoice.customerName
                };
                await ledgerStore.put(arEntry);

                // 7. If invoice is paid/partially paid on creation, create payment records
                if (paidAmount > 0) {
                    const allPayments = await customerPaymentsStore.getAll();
                    const paymentId = generateNextId('RCPT', allPayments);
                    const paymentMethod = invoice.paymentMethod || invoice.payment_method || 'Bank Transfer';
                    const paymentAccountId = invoice.accountId;
                    const snapshot = calculateCustomerPaymentSnapshot({
                        amountTendered: paidAmount,
                        appliedInvoices: [{
                            invoiceId: invoice.id,
                            allocationAmount: paidAmount,
                            outstandingAmount: paidAmount
                        }],
                        paymentPurpose: 'INVOICE_PAYMENT',
                        paymentDate: invoice.date,
                        customerName: invoice.customerName
                    });

                    const custPayment: CustomerPayment = {
                        id: paymentId,
                        date: invoice.date,
                        customerId: invoice.customerId || invoice.customerName,
                        customerName: invoice.customerName,
                        amount: paidAmount,
                        paymentMethod,
                        accountId: paymentAccountId,
                        reference: invoice.id,
                        notes: `Recurring invoice payment for #${invoice.id}`,
                        allocations: [{ invoiceId: invoice.id, amount: paidAmount }],
                        status: 'Cleared',
                        reconciled: false,
                        receiptSnapshot: snapshot,
                        invoiceTotal: snapshot.invoiceTotalAtPosting,
                        paymentStatus: snapshot.paymentStatus,
                        balanceDue: snapshot.balanceDueAfterPayment,
                        overpaymentAmount: snapshot.walletDeposit,
                        walletDeposit: snapshot.walletDeposit,
                        changeGiven: snapshot.changeGiven,
                        amountApplied: snapshot.amountApplied,
                        amountRetained: snapshot.amountRetained,
                        calculationVersion: snapshot.calculationVersion
                    };
                    await customerPaymentsStore.put(ensureDocumentVerificationToken(custPayment as any));

                    let targetDebitAccount = gl.bankAccount;
                    if (paymentMethod === 'Wallet') {
                        targetDebitAccount = gl.customerDepositAccount;
                    } else if (paymentAccountId) {
                        targetDebitAccount = paymentAccountId;
                    } else {
                        if (paymentMethod === 'Cash') targetDebitAccount = gl.cashDrawerAccount;
                        if (paymentMethod === 'Mobile Money') targetDebitAccount = gl.mobileMoneyAccount;
                    }

                    const payEntry: LedgerEntry = {
                        id: generateId('LG-REC-PAY'),
                        date: invoice.date,
                        description: `Payment for Recurring Invoice #${invoice.id}`,
                        debitAccountId: resolveAcct(targetDebitAccount),
                        creditAccountId: resolveAcct(gl.accountsReceivable),
                        amount: paidAmount,
                        referenceId: paymentId,
                        reconciled: false,
                        customerId: invoice.customerId,
                        customerName: invoice.customerName
                    };
                    await ledgerStore.put(payEntry);

                    const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                    let bankTransactions = await bankTransactionsStore.getAll();
                    const bankAccount = resolveBankAccountForPayment(bankAccounts, {
                        accountId: paymentAccountId,
                        paymentMethod
                    });
                    if (bankAccount) {
                        const reference = `REC-${invoice.id}-${paymentId}`;
                        const existing = bankTransactions.find(tx =>
                            tx.bankAccountId === bankAccount.id &&
                            tx.reference === reference &&
                            tx.type === 'Deposit'
                        );

                        if (!existing) {
                            const bankTx: BankTransaction = {
                                id: generateNextId('TXN', bankTransactions),
                                date: invoice.date,
                                amount: paidAmount,
                                type: 'Deposit',
                                description: `Recurring Invoice Payment #${invoice.id}`,
                                reference,
                                bankAccountId: bankAccount.id,
                                counterparty: invoice.customerName ? { name: invoice.customerName } : undefined,
                                category: 'Income',
                                reconciled: false,
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString()
                            };
                            await bankTransactionsStore.put(bankTx);
                            bankTransactions = [...bankTransactions, bankTx];

                            const nextBalance = calculateBankBalance(bankTransactions, bankAccount.id);
                            await bankAccountsStore.put({
                                ...bankAccount,
                                balance: roundToCurrency(nextBalance),
                                availableBalance: roundToCurrency(nextBalance),
                                updatedAt: new Date().toISOString()
                            });
                        }
                    }
                }

                return { success: true };
            }
        );
    },

    /**
     * Keeps the Quotation -> Order -> Invoice chain intact for invoices the
     * admin creates directly (no portal request involved). When such an
     * invoice is saved we also materialise a real sales order for the SAME
     * customerId so the customer portal sees it under "Orders" and in recent
     * activity as an order made, with a cross-reference back to the invoice.
     *
     * Skipped entirely when the invoice already descends from an order
     * (Converted-from / sourceOrderId), is POS/walk-in, or has no customer.
     */
    async ensureOrderFromInvoice(invoice: Invoice) {
        try {
            if (!invoice?.customerId) return null;
            const customerId = invoice.customerId;

            const isPos = /pos|walk[ -]?in/i.test(
                `${invoice.notes || ''} ${invoice.reference || ''} ${invoice.documentTitle || ''}`
            );
            const alreadyHasOrder = Boolean(invoice.sourceOrderId)
                || /converted from \[(order|sales order|so)\]/i.test(String(invoice.notes || ''))
                || Boolean((invoice as any).orderNumber);
            if (isPos || alreadyHasOrder) return null;

            const existing = (await dbService.getAll<SalesOrder>('salesOrders')) || [];
            const dup = existing.find(
                (o) => (o as any).invoiceId === invoice.id || o.id === invoice.id
            );
            if (dup) return null;

            const orderId = salesOrderService.generateLocalSalesOrderId();

            const items: SalesOrderItem[] = (invoice.items || []).map((it: CartItem, idx: number) => {
                const quantity = Number(it.quantity ?? it.qty ?? 1);
                const unitPrice = Number(it.price ?? it.unitPrice ?? it.unit_price ?? 0);
                const discount = Number(it.discount ?? 0);
                const lineTotal = Number(it.lineTotal ?? (it.line_total ?? (quantity * unitPrice - discount)));
                return {
                    id: it.id || `item-${orderId}-${idx}`,
                    productId: it.parentId || it.id || it.productId || `item-${orderId}-${idx}`,
                    description: it.name || it.productName || it.description || 'Product',
                    quantity,
                    unitPrice,
                    discount,
                    lineTotal,
                };
            });

            const subtotal = items.reduce((sum, it) => sum + Number(it.lineTotal ?? it.quantity * it.unitPrice), 0);
            const discounts = Number(invoice.adjustmentTotal ?? 0);
            const total = Number(invoice.totalAmount ?? invoice.total ?? (subtotal - discounts));
            const tax = Number(invoice.tax ?? invoice.taxRate ?? 0);

            const order: SalesOrder & { orderNumber?: string | null; customerName?: string; invoiceId?: string; invoiceNumber?: string; source?: string } = {
                id: orderId,
                // No fabricated number: null until the server assigns ORD.
                orderNumber: null,
                orderNumberProvisional: false,
                creation_source: 'INVOICE_DERIVED',
                creationSource: 'INVOICE_DERIVED',
                quotationId: null,
                customerId,
                customerName: invoice.customerName,
                orderDate: invoice.date || new Date().toISOString(),
                deliveryDate: invoice.dueDate ?? null,
                status: String(invoice.status || '').toLowerCase() === 'draft' ? 'Draft' : 'Confirmed',
                items,
                subtotal,
                discounts,
                tax,
                total,
                notes: invoice.notes,
                invoiceId: invoice.id,
                invoiceNumber: invoice.invoiceNumber,
                source: 'invoice',
            };

            await dbService.put('salesOrders', order);
            logger.info(`[transactionService] Created SalesOrder ${orderId} from invoice ${invoice.id} for customer ${customerId}`);
            return order;
        } catch (err: any) {
            logger.error('Failed to create order from invoice:', err);
            return null;
        }
    },

    async updateSale(sale: Sale) {
        return dbService.executeAtomicOperation(
            ['sales'],
            async (tx) => {
                const store = tx.objectStore('sales');
                await store.put(sale);
                return { success: true };
            }
        );
    },

    async updateCustomerPayment(payment: CustomerPayment) {
        return dbService.executeAtomicOperation(
            ['customerPayments'],
            async (tx) => {
                const store = tx.objectStore('customerPayments');
                const existing = await store.get(payment.id);
                if (!existing) throw new Error('Payment not found');

                const hasFinancialMutation =
                    Number(existing.amount || 0) !== Number(payment.amount || 0) ||
                    (existing.customerId || '') !== (payment.customerId || '') ||
                    (existing.paymentMethod || '') !== (payment.paymentMethod || '') ||
                    (existing.accountId || '') !== (payment.accountId || '') ||
                    (existing.excessHandling || '') !== (payment.excessHandling || '') ||
                    JSON.stringify(existing.allocations || []) !== JSON.stringify(payment.allocations || []);

                if (hasFinancialMutation) {
                    throw new Error(
                        'Financial fields are immutable after posting. Void and re-post payment for financial corrections.'
                    );
                }

                const metadataOnlyUpdate: CustomerPayment = {
                    ...existing,
                    reference: payment.reference,
                    notes: payment.notes,
                    status: payment.status,
                    reconciled: payment.reconciled,
                    bankCharges: payment.bankCharges,
                    subAccountName: payment.subAccountName
                };

                await store.put(metadataOnlyUpdate);
                return { success: true };
            }
        );
    },

    async postJournalEntry(entries: Array<Omit<LedgerEntry, 'id' | 'date'> & { id?: string }>) {
        const date = new Date().toISOString();

        return dbService.executeAtomicOperation(
            ['ledger', 'accounts'],
            async (tx) => {
                const store = tx.objectStore('ledger');
                const accounts = await loadAccountsFromStore(tx);
                
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                
                for (const entry of entries) {
                    if (!entry.debitAccountId || !entry.creditAccountId) {
                        throw new UnresolvedAccountError(
                            `Journal entry missing account reference: debit=${entry.debitAccountId}, credit=${entry.creditAccountId}`
                        );
                    }
                    
                    const resolvedDebitId = resolveAccountForPosting(
                        entry.debitAccountId, 
                        accounts, 
                        { allowNonPosting: false, companyId }
                    );
                    const resolvedCreditId = resolveAccountForPosting(
                        entry.creditAccountId, 
                        accounts, 
                        { allowNonPosting: false, companyId }
                    );
                    
                    if (!resolvedDebitId) {
                        throw new UnresolvedAccountError(entry.debitAccountId);
                    }
                    if (!resolvedCreditId) {
                        throw new UnresolvedAccountError(entry.creditAccountId);
                    }
                    
                    const newEntry: LedgerEntry = {
                        ...entry,
                        // Honor an explicit id when the caller provides one
                        // (e.g. deterministic ids make retried system postings
                        // converge instead of duplicating).
                        id: entry.id || generateId('LG'),
                        date,
                        reconciled: entry.reconciled || false,
                        amount: entry.amount || 0,
                        debitAccountId: resolvedDebitId,
                        creditAccountId: resolvedCreditId,
                    };
                    await store.put(newEntry);
                }
                return { success: true };
            }
        );
    },

    async processInvoice(invoice: Invoice, performedBy?: string) {
        const _processInvoiceResult = await dbService.executeAtomicOperation(
            ['invoices', 'inventory', 'ledger', 'customers', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'customerPayments', 'bankAccounts', 'bankTransactions', 'inventoryTransactions', 'idempotencyKeys'],
            async (tx) => {
                // Temporary diagnostic trace (EXM-P726/021 only, read-only).
                await traceExamInvoice('process-entry', {
                    id: (invoice as any)?.id,
                    invoiceNumber: (invoice as any)?.invoiceNumber,
                    originModule: (invoice as any)?.originModule ?? (invoice as any)?.origin_module,
                    verificationToken: (invoice as any)?.verificationToken,
                });
                await reserveIdempotencyKey(tx, 'invoice', invoice.id, invoice.idempotencyKey);

                const invoiceStore = tx.objectStore('invoices');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const customerPaymentsStore = tx.objectStore('customerPayments');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');

                // Load accounts for resolution (required for all ledger writes)
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };

                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // Pre-fetch data for adjustment processing
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();

                const issuedDate = invoice.date || new Date().toISOString();
                invoice.date = issuedDate;
                let effectivePaymentTerms = String(invoice.paymentTerms || '').trim();
                if (!effectivePaymentTerms && invoice.customerId) {
                    const customer = await customerStore.get(invoice.customerId);
                    if (customer) {
                        effectivePaymentTerms = resolveCustomerPaymentTerms({
                            customer,
                            subAccountName: invoice.subAccountName,
                            transactionType: 'invoice',
                            preserveCustomTerms: true
                        });
                    }
                }

                if (effectivePaymentTerms) {
                    invoice.paymentTerms = effectivePaymentTerms;
                    invoice.dueDate = calculateDueDate(issuedDate, effectivePaymentTerms);
                } else if (!invoice.dueDate) {
                    invoice.dueDate = issuedDate;
                }

                const invoiceType = String(invoice.originModule || invoice.origin_module || '').toLowerCase() === 'examination' ? 'examination_invoice' : 'invoice';
                assertInvoiceNumberFormat(invoice.id, getCompanyConfig(), invoiceType);

                // 1. Save Invoice (with its permanent, idempotent verification token)
                invoice = ensureInvoiceVerificationToken(invoice);
                await invoiceStore.put(invoice);

                // 2. Update Inventory (Gated by fulfillment, not payment status).
                // The same active-status gate controls AR/revenue/COGS below:
                // Draft/Cancelled invoices post nothing.
                const shouldDeduct = isPostedInvoiceStatus(invoice.status);
                if (shouldDeduct) {
                    await this._executeDeductInventory(
                        inventoryStore,
                        inventoryTransactionsStore,
                        invoice.items,
                        invoice.consumptionSnapshots || [],
                        'Invoice',
                        invoice.id,
                        performedBy || 'System',
                        inventory
                    );
                }

                // 3. Process Market Adjustments using shared helper
                const adjustmentResult = await this._processMarketAdjustments(
                    invoice.items,
                    inventory,
                    bomTemplates,
                    marketAdjustments,
                    invoice.id,
                    'invoice',
                    inventoryStore
                );

                // Store adjustment data on invoice
                invoice.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                    ? adjustmentResult.adjustmentSnapshots
                    : invoice.adjustmentSnapshots;
                invoice.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                    ? adjustmentResult.adjustmentTotal
                    : invoice.adjustmentTotal;
                invoice.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                invoice.adjustmentSummary = adjustmentResult.adjustmentSummary;

                // Save adjustment transactions to the store
                for (const adjTx of adjustmentResult.adjustmentTransactions) {
                    await marketAdjustmentTransactionsStore.put(adjTx);
                }

                // Normalize paid amount and status before final save
                const totalAmount = Number(invoice.totalAmount || 0);
                const rawPaidAmount = Number(invoice.paidAmount || 0);
                const paidAmount = Math.min(rawPaidAmount, totalAmount);
                const overpayment = Math.max(0, rawPaidAmount - totalAmount);
                if (overpayment > 0.01) {
                    await this.processOverpaymentToWallet(invoice, overpayment);
                }
                invoice.paidAmount = paidAmount;

                if (invoice.status !== 'Draft' && invoice.status !== 'Cancelled') {
                    if (paidAmount >= totalAmount && totalAmount > 0) {
                        invoice.status = 'Paid';
                    } else if (paidAmount > 0) {
                        invoice.status = 'Partial';
                    } else if (invoice.status === 'Paid' || invoice.status === 'Partial') {
                        invoice.status = 'Unpaid';
                    }
                }

                // Update invoice with adjustment data
                await invoiceStore.put(invoice);

                if (shouldDeduct) {
                    // Split COGS across inventory accounts by line cost so mixed
                    // invoices relieve each 114xx account for its own share:
                    // DR 51200 (total) = CR 11410 + CR 11420 + CR 11430.
                    // (Block-scoped config: the AR section below declares its own.)
                    const gl = getGLConfig();
                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        invoice.items || [],
                        inventory,
                        (item) => item.parentId || item.id,
                        accounts,
                        () => resolveAcct(gl.defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    for (const leg of cogsLegs) {
                        if (!leg.inventoryAccountId) continue;
                        const cogsEntry: LedgerEntry = {
                            id: generateId('LG-COGS'),
                            date: invoice.date,
                            description: `COGS - Invoice #${invoice.id}`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: leg.inventoryAccountId,
                            amount: leg.amount,
                            referenceId: invoice.id,
                            reconciled: false,
                            customerId: invoice.customerId,
                            customerName: invoice.customerName
                        };
                        await ledgerStore.put(cogsEntry);
                        cogsEntries.push(cogsEntry);
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Invoice #${invoice.id}`);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // 5. Create Ledger Entry — active invoices only. Draft/Cancelled
                // invoices must not contribute AR or revenue (same gate as COGS).
                const gl = getGLConfig();

                // Debit AR
                if (shouldDeduct) {
                    // Service-only invoices credit 41200 Service Income; explicit
                    // salesAccountId always wins (e.g. POS selector).
                    const revenueAccountRef = resolveInvoiceRevenueAccount(invoice, gl.defaultSalesAccount);
                    const arEntry: LedgerEntry = {
                        id: generateId('LG-INV-AR'),
                        date: invoice.date,
                        description: `Invoice #${invoice.id}`,
                        debitAccountId: resolveAcct(gl.accountsReceivable),
                        creditAccountId: resolveAcct(revenueAccountRef),
                        amount: totalAmount,
                        referenceId: invoice.id,
                        reconciled: false,
                        customerId: invoice.customerId,
                        customerName: invoice.customerName
                    };
                    await ledgerStore.put(arEntry);
                }

                // 6. If invoice is paid/partially paid on creation, create payment records
                // SKIP if this invoice was converted from an order — the payment was already
                // recorded against the order (see `LG-ORD-INIT` / `LG-ORD-PAY` ledger entries).
                // Re-creating it here would double-count the same payment.
                // SKIP for Draft/Cancelled invoices — they carry no AR to settle.
                const convertedFromOrder = !!(invoice as any).sourceOrderId
                    || (invoice.conversionDetails && (invoice.conversionDetails as any).sourceType === 'order');
                if (paidAmount > 0 && !convertedFromOrder && shouldDeduct) {
                    const allPayments = await customerPaymentsStore.getAll();
                    const paymentId = generateNextId('RCPT', allPayments);
                    const paymentMethod = invoice.paymentMethod || invoice.payment_method || 'Cash';
                    const paymentAccountId = invoice.accountId;
                    const snapshot = calculateCustomerPaymentSnapshot({
                        amountTendered: paidAmount,
                        appliedInvoices: [{
                            invoiceId: invoice.id,
                            allocationAmount: paidAmount,
                            outstandingAmount: paidAmount
                        }],
                        paymentPurpose: 'INVOICE_PAYMENT',
                        paymentDate: invoice.date,
                        customerName: invoice.customerName
                    });

                    const custPayment: CustomerPayment = {
                        id: paymentId,
                        date: invoice.date,
                        customerId: invoice.customerId || invoice.customerName,
                        customerName: invoice.customerName,
                        amount: paidAmount,
                        paymentMethod,
                        accountId: paymentAccountId,
                        reference: invoice.id,
                        notes: `Invoice payment for #${invoice.id}`,
                        allocations: [{ invoiceId: invoice.id, amount: paidAmount }],
                        status: 'Cleared',
                        reconciled: false,
                        receiptSnapshot: snapshot,
                        invoiceTotal: snapshot.invoiceTotalAtPosting,
                        paymentStatus: snapshot.paymentStatus,
                        balanceDue: snapshot.balanceDueAfterPayment,
                        overpaymentAmount: snapshot.walletDeposit,
                        walletDeposit: snapshot.walletDeposit,
                        changeGiven: snapshot.changeGiven,
                        amountApplied: snapshot.amountApplied,
                        amountRetained: snapshot.amountRetained,
                        calculationVersion: snapshot.calculationVersion
                    };
                    await customerPaymentsStore.put(ensureDocumentVerificationToken(custPayment as any));

                    let targetDebitAccount = gl.cashDrawerAccount;
                    if (paymentMethod === 'Wallet') {
                        targetDebitAccount = gl.customerDepositAccount;
                    } else if (paymentAccountId) {
                        targetDebitAccount = paymentAccountId;
                    } else {
                        if (paymentMethod === 'Card' || paymentMethod === 'Bank Transfer') targetDebitAccount = gl.bankAccount;
                        if (paymentMethod === 'Mobile Money') targetDebitAccount = gl.mobileMoneyAccount;
                    }

                    const payEntry: LedgerEntry = {
                        id: generateId('LG-INV-PAY'),
                        date: invoice.date,
                        description: `Payment for Invoice #${invoice.id}`,
                        debitAccountId: resolveAcct(targetDebitAccount),
                        creditAccountId: resolveAcct(gl.accountsReceivable),
                        amount: paidAmount,
                        referenceId: paymentId,
                        reconciled: false,
                        customerId: invoice.customerId,
                        customerName: invoice.customerName
                    };
                    await ledgerStore.put(payEntry);

                    const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                    let bankTransactions = await bankTransactionsStore.getAll();
                    const bankAccount = resolveBankAccountForPayment(bankAccounts, {
                        accountId: paymentAccountId,
                        paymentMethod
                    });
                    if (bankAccount) {
                        const reference = `INV-${invoice.id}-${paymentId}`;
                        const existing = bankTransactions.find(tx =>
                            tx.bankAccountId === bankAccount.id &&
                            tx.reference === reference &&
                            tx.type === 'Deposit'
                        );

                        if (!existing) {
                            const bankTx: BankTransaction = {
                                id: generateNextId('TXN', bankTransactions),
                                date: invoice.date,
                                amount: paidAmount,
                                type: 'Deposit',
                                description: `Invoice Payment #${invoice.id}`,
                                reference,
                                bankAccountId: bankAccount.id,
                                counterparty: invoice.customerName ? { name: invoice.customerName } : undefined,
                                category: 'Income',
                                reconciled: false,
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString()
                            };
                            await bankTransactionsStore.put(bankTx);
                            bankTransactions = [...bankTransactions, bankTx];

                            const nextBalance = calculateBankBalance(bankTransactions, bankAccount.id);
                            await bankAccountsStore.put({
                                ...bankAccount,
                                balance: roundToCurrency(nextBalance),
                                availableBalance: roundToCurrency(nextBalance),
                                updatedAt: new Date().toISOString()
                            });
                        }
                    }
                }

                return { success: true, id: invoice.id };
            }
        );
        console.log('[REFERRAL] processInvoice complete. invoice.id:', invoice.id, 'referredBy:', invoice.referredBy, 'status:', invoice.status, 'customerId:', invoice.customerId);
        if (invoice.referredBy) {
            console.log('[REFERRAL] calling registerReferralFromInvoice for', invoice.id, 'referredBy:', invoice.referredBy);
            import('./referralService').then(({ referralService }) =>
                referralService.registerReferralFromInvoice({
                    id: invoice.id,
                    customerId: invoice.customerId || '',
                    customerName: invoice.customerName,
                    totalAmount: invoice.totalAmount,
                    referredById: invoice.referredBy,
                    referredByName: invoice.referredByName,
                }).then(result => {
                    console.log('[REFERRAL] registerReferralFromInvoice result:', result?.id, result?.status);
                }).catch(err =>
                    logger.error('Referral registration from invoice failed:', err)
                )
            );
        } else {
            console.log('[REFERRAL] invoice.referredBy is falsy — skipping registerReferralFromInvoice');
        }

        if (invoice.status === 'Paid' && invoice.referredBy) {
            console.log('[REFERRAL] calling processInvoiceReward for', invoice.id);
            import('./referralService').then(({ referralService }) =>
                referralService.processInvoiceReward({
                    id: invoice.id,
                    customerId: invoice.customerId || '',
                    totalAmount: invoice.totalAmount,
                    paidAmount: invoice.paidAmount,
                    referredBy: invoice.referredBy,
                    referredByName: invoice.referredByName,
                }).then(result => {
                    console.log('[REFERRAL] processInvoiceReward result:', result?.id, result?.status);
                }).catch(err =>
                    logger.error('Referral reward processing from invoice failed:', err)
                )
            );
        }
        // Phase 5 — Transport Budget sales allocation (post-commit,
        // fire-and-forget: order→invoice conversions allocate once on the
        // invoice here; POS mirror invoices are suppressed inside the
        // producer; repeats deduplicate on the economic idempotency key).
        import('./transportBudgetSalesAllocation').then(
            ({ allocateForPostedInvoice, defaultSalesAllocationDeps, fireAllocationHook }) =>
                fireAllocationHook(
                    allocateForPostedInvoice(defaultSalesAllocationDeps, invoice),
                    `invoice:${invoice.id}`
                )
        );
        return _processInvoiceResult;
    },

    async convertQuotationToInvoice(quotationId: string, invoiceData: Invoice) {
        let postedQuotationInvoice: Invoice | null = null;
        const conversionResult = await dbService.executeAtomicOperation(
            ['quotations', 'invoices', 'inventory', 'ledger', 'customers', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'inventoryTransactions', 'accounts'],
            async (tx) => {
                const quotationStore = tx.objectStore('quotations');
                const invoiceStore = tx.objectStore('invoices');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // Pre-fetch data for adjustment processing
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();

                // 1. Update Quotation status
                const quotation = await quotationStore.get(quotationId);
                if (!quotation) throw new Error("Quotation not found");
                quotation.status = 'Converted';
                quotation.isPriceLocked = true; // Lock price on conversion

                // Add conversion note to quotation
                const timestamp = new Date().toLocaleString();
                const conversionNote = `Converted to [Invoice] #[${invoiceData.id}] on [${timestamp}] and price locked.`;
                quotation.notes = quotation.notes ? `${quotation.notes}\n${conversionNote}` : conversionNote;

                await quotationStore.put(quotation);

                // 2. Save Invoice
                invoiceData.isPriceLocked = true; // Ensure invoice price is locked
                invoiceData.isConverted = true;
                invoiceData.quotationId = quotation.id;
                invoiceData.conversionDetails = {
                    sourceType: 'Quotation',
                    sourceNumber: quotation.id,
                    date: timestamp,
                    acceptedBy: quotation.customerName || invoiceData.customerName || 'System'
                };
                // Add conversion note to invoice
                invoiceData.notes = invoiceData.notes ?
                    `${invoiceData.notes}\nConverted from [Quotation] #[${quotationId}] on [${timestamp}] - Price Locked.` :
                    `Converted from [Quotation] #[${quotationId}] on [${timestamp}] - Price Locked.`;
                const issuedDate = invoiceData.date || new Date().toISOString();
                invoiceData.date = issuedDate;
                let effectivePaymentTerms = String(invoiceData.paymentTerms || '').trim();
                if (!effectivePaymentTerms && invoiceData.customerId) {
                    const customer = await customerStore.get(invoiceData.customerId);
                    if (customer) {
                        effectivePaymentTerms = resolveCustomerPaymentTerms({
                            customer,
                            subAccountName: invoiceData.subAccountName,
                            transactionType: 'invoice',
                            preserveCustomTerms: true
                        });
                    }
                }
                if (effectivePaymentTerms) {
                    invoiceData.paymentTerms = effectivePaymentTerms;
                    invoiceData.dueDate = calculateDueDate(issuedDate, effectivePaymentTerms);
                } else if (!invoiceData.dueDate) {
                    invoiceData.dueDate = issuedDate;
                }

                // 3. Update Inventory (fulfillment-based — goods delivered)
                const shouldDeductConv = isPostedInvoiceStatus(invoiceData.status);
                if (shouldDeductConv) {
                    await this._executeDeductInventory(
                        inventoryStore,
                        inventoryTransactionsStore,
                        invoiceData.items,
                        invoiceData.consumptionSnapshots || [],
                        'Invoice',
                        invoiceData.id,
                        'System',
                        inventory
                    );
                }

                // 4. Process Market Adjustments using shared helper
                const adjustmentResult = await this._processMarketAdjustments(
                    invoiceData.items,
                    inventory,
                    bomTemplates,
                    marketAdjustments,
                    invoiceData.id,
                    'invoice',
                    inventoryStore
                );

                // Store adjustment data on invoice
                invoiceData.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                    ? adjustmentResult.adjustmentSnapshots
                    : invoiceData.adjustmentSnapshots;
                invoiceData.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                    ? adjustmentResult.adjustmentTotal
                    : invoiceData.adjustmentTotal;
                invoiceData.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                invoiceData.adjustmentSummary = adjustmentResult.adjustmentSummary;

                // Save adjustment transactions to the store
                for (const adjTx of adjustmentResult.adjustmentTransactions) {
                    await marketAdjustmentTransactionsStore.put(adjTx);
                }

                invoiceData = ensureInvoiceVerificationToken(invoiceData);
                await invoiceStore.put(invoiceData);

                // COGS entries split by inventory account (gated by active status)
                if (shouldDeductConv) {
                    const gl = getGLConfig();
                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        invoiceData.items || [],
                        inventory,
                        (item) => item.parentId || item.id,
                        accounts,
                        () => resolveAcct(gl.defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    for (const leg of cogsLegs) {
                        if (!leg.inventoryAccountId) continue;
                        const cogsEntry: LedgerEntry = {
                            id: generateId('LG-COGS'),
                            date: invoiceData.date,
                            description: `COGS - Invoice #${invoiceData.id}`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: leg.inventoryAccountId,
                            amount: leg.amount,
                            referenceId: invoiceData.id,
                            reconciled: false,
                            customerId: invoiceData.customerId,
                            customerName: invoiceData.customerName
                        };
                        await ledgerStore.put(cogsEntry);
                        cogsEntries.push(cogsEntry);
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Invoice #${invoiceData.id}`);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // 6. Create Ledger Entry — active invoices only
                const gl = getGLConfig();
                const totalAmount = Number(invoiceData.totalAmount);

                // Debit AR
                if (shouldDeductConv) {
                    const revenueAccountRef = resolveInvoiceRevenueAccount(invoiceData, gl.defaultSalesAccount);
                    const arEntry: LedgerEntry = {
                        id: generateId('LG-QTN-INV-AR'),
                        date: invoiceData.date,
                        description: `Invoice #${invoiceData.id} from QTN #${quotationId}`,
                        debitAccountId: resolveAcct(gl.accountsReceivable),
                        creditAccountId: resolveAcct(revenueAccountRef),
                        amount: totalAmount,
                        referenceId: invoiceData.id,
                        reconciled: false,
                        customerId: invoiceData.customerId,
                        customerName: invoiceData.customerName
                    };
                    await ledgerStore.put(arEntry);
                }

                postedQuotationInvoice = invoiceData;
                return { success: true, id: invoiceData.id };
            }
        );
        // Phase 5 — Transport Budget sales allocation for quotation-converted
        // posted invoices (post-commit, fire-and-forget; duplicates dedupe).
        if (postedQuotationInvoice) {
            const convertedInvoice = postedQuotationInvoice;
            import('./transportBudgetSalesAllocation').then(
                ({ allocateForPostedInvoice, defaultSalesAllocationDeps, fireAllocationHook }) =>
                    fireAllocationHook(
                        allocateForPostedInvoice(defaultSalesAllocationDeps, convertedInvoice),
                        `invoice:${convertedInvoice.id}`
                    )
            );
        }
        return conversionResult;
    },

    async convertQuotationToWorkOrder(quotationId: string, workOrderData: WorkOrder) {
        return dbService.executeAtomicOperation(
            ['quotations', 'workOrders'],
            async (tx) => {
                const quotationStore = tx.objectStore('quotations');
                const workOrderStore = tx.objectStore('workOrders');

                // 1. Update Quotation status
                const quotation = await quotationStore.get(quotationId);
                if (!quotation) throw new Error("Quotation not found");
                quotation.status = 'Converted';

                // Add conversion note
                const timestamp = new Date().toLocaleString();
                const conversionNote = `Converted to [WorkOrder] #[${workOrderData.id}] on [${timestamp}] as accepted by [System]`;
                quotation.notes = quotation.notes ? `${quotation.notes}\n${conversionNote}` : conversionNote;

                await quotationStore.put(quotation);

                // 2. Save Work Order
                workOrderData.notes = workOrderData.notes ?
                    `${workOrderData.notes}\nConverted from [Quotation] #[${quotationId}] on [${timestamp}] as accepted by [System]` :
                    `Converted from [Quotation] #[${quotationId}] on [${timestamp}] as accepted by [System]`;
                await workOrderStore.put(workOrderData);

                return { success: true, id: workOrderData.id };
            }
        );
    },

    async convertJobOrderToInvoice(jobOrderId: string, invoiceData: Invoice) {
        let postedJobInvoice: Invoice | null = null;
        const jobConversionResult = await dbService.executeAtomicOperation(
            ['jobOrders', 'invoices', 'inventory', 'ledger', 'customers', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions'],
            async (tx) => {
                const jobOrderStore = tx.objectStore('jobOrders');
                const invoiceStore = tx.objectStore('invoices');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');

                // Pre-fetch data for adjustment processing
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) throw new UnresolvedAccountError(ref || 'undefined');
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) throw new UnresolvedAccountError(ref);
                    return resolved;
                };

                // 1. Update Job Order status
                const jobOrder = await jobOrderStore.get(jobOrderId);
                if (!jobOrder) throw new Error("Job Order not found");
                jobOrder.status = 'Completed';

                // Add conversion note
                const timestamp = new Date().toLocaleString();
                const conversionNote = `Converted to [Invoice] #[${invoiceData.id}] on [${timestamp}] as accepted by [System]`;
                jobOrder.notes = jobOrder.notes ? `${jobOrder.notes}\n${conversionNote}` : conversionNote;

                await jobOrderStore.put(jobOrder);

                // 2. Save Invoice
                invoiceData.notes = invoiceData.notes ?
                    `${invoiceData.notes}\nConverted from [JobOrder] #[${jobOrderId}] on [${timestamp}] as accepted by [System]` :
                    `Converted from [JobOrder] #[${jobOrderId}] on [${timestamp}] as accepted by [System]`;

                // 3. Update Inventory (fulfillment-based — goods delivered)
                const shouldDeductJob = isPostedInvoiceStatus(invoiceData.status);
                if (shouldDeductJob) {
                    for (const item of invoiceData.items) {
                        const invItem = await resolveInventoryRecord(item.id, inventory, inventoryStore);
                        if (invItem) {
                            invItem.stock = (invItem.stock || 0) - item.quantity;
                            await inventoryStore.put(invItem);
                        }
                    }
                }

                // 4. Process Market Adjustments using shared helper
                const adjustmentResult = await this._processMarketAdjustments(
                    invoiceData.items,
                    inventory,
                    bomTemplates,
                    marketAdjustments,
                    invoiceData.id,
                    'invoice',
                    inventoryStore
                );

                // Store adjustment data on invoice
                invoiceData.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                    ? adjustmentResult.adjustmentSnapshots
                    : invoiceData.adjustmentSnapshots;
                invoiceData.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                    ? adjustmentResult.adjustmentTotal
                    : invoiceData.adjustmentTotal;
                invoiceData.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                invoiceData.adjustmentSummary = adjustmentResult.adjustmentSummary;

                // Save adjustment transactions to the store
                for (const adjTx of adjustmentResult.adjustmentTransactions) {
                    await marketAdjustmentTransactionsStore.put(adjTx);
                }

                invoiceData = ensureInvoiceVerificationToken(invoiceData);
                await invoiceStore.put(invoiceData);

                // COGS entries split by inventory account (gated by active status)
                if (shouldDeductJob) {
                    const gl = getGLConfig();
                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        invoiceData.items || [],
                        inventory,
                        (item) => item.parentId || item.id,
                        accounts,
                        () => resolveAcct(gl.defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    for (const leg of cogsLegs) {
                        if (!leg.inventoryAccountId) continue;
                        const cogsEntry: LedgerEntry = {
                            id: generateId('LG-COGS'),
                            date: invoiceData.date,
                            description: `COGS - Invoice #${invoiceData.id} (from Job Order #${jobOrderId})`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: leg.inventoryAccountId,
                            amount: leg.amount,
                            referenceId: invoiceData.id,
                            reconciled: false,
                            customerId: invoiceData.customerId,
                            customerName: invoiceData.customerName
                        };
                        await ledgerStore.put(cogsEntry);
                        cogsEntries.push(cogsEntry);
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Invoice #${invoiceData.id}`);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // 7. Create Ledger Entry — active invoices only
                const gl = getGLConfig();
                const totalAmount = Number(invoiceData.totalAmount);

                // Debit AR
                if (shouldDeductJob) {
                    const revenueAccountRef = resolveInvoiceRevenueAccount(invoiceData, gl.defaultSalesAccount);
                    const arEntry: LedgerEntry = {
                        id: generateId('LG-JO-INV-AR'),
                        date: invoiceData.date,
                        description: `Invoice #${invoiceData.id} (from Job Order #${jobOrderId})`,
                        debitAccountId: resolveAcct(gl.accountsReceivable),
                        creditAccountId: resolveAcct(revenueAccountRef),
                        amount: totalAmount,
                        referenceId: invoiceData.id,
                        reconciled: false,
                        customerId: invoiceData.customerId,
                        customerName: invoiceData.customerName
                    };
                    await ledgerStore.put(arEntry);
                }

                postedJobInvoice = invoiceData;
                return { success: true, id: invoiceData.id };
            }
        );
        // Phase 5 — Transport Budget sales allocation for job-order-converted
        // posted invoices (post-commit, fire-and-forget; duplicates dedupe).
        if (postedJobInvoice) {
            const convertedInvoice = postedJobInvoice;
            import('./transportBudgetSalesAllocation').then(
                ({ allocateForPostedInvoice, defaultSalesAllocationDeps, fireAllocationHook }) =>
                    fireAllocationHook(
                        allocateForPostedInvoice(defaultSalesAllocationDeps, convertedInvoice),
                        `invoice:${convertedInvoice.id}`
                    )
            );
        }
        return jobConversionResult;
    },

    async addCustomerPayment(payment: CustomerPayment) {
        const paidInvoices: any[] = [];
        const payResult = await dbService.executeAtomicOperation(
            ['customerPayments', 'invoices', 'customers', 'ledger', 'walletTransactions', 'accounts', 'bankAccounts', 'bankTransactions', 'idempotencyKeys'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'customer_payment', payment.id, payment.idempotencyKey);

                const paymentStore = tx.objectStore('customerPayments');
                const invoiceStore = tx.objectStore('invoices');
                const customerStore = tx.objectStore('customers');
                const ledgerStore = tx.objectStore('ledger');
                const walletStore = tx.objectStore('walletTransactions');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                // Load accounts for resolution (required for all ledger writes)
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };

                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const customerId = payment.customerId || '';
                const paymentAmount = toMoney(payment.amount);
                const requestedAllocations = (payment.allocations || []).filter(a => Number(a.amount || 0) > 0);

                // 1. Validate allocations against live outstanding balances.
                const validatedInvoiceAllocations: (CustomerReceiptInvoiceInput & { invoice: Invoice })[] = [];
                for (const allocation of requestedAllocations) {
                    const invoice = await invoiceStore.get(allocation.invoiceId);
                    if (!invoice) {
                        throw new Error(`Cannot allocate payment to missing invoice ${allocation.invoiceId}.`);
                    }

                    const outstanding = toMoney(Math.max(0, (invoice.totalAmount || 0) - (invoice.paidAmount || 0)));
                    const allocationAmount = toMoney(allocation.amount);
                    if (allocationAmount - outstanding > 0.01) {
                        throw new Error(
                            `Allocation for invoice ${allocation.invoiceId} exceeds outstanding balance (${allocationAmount} > ${outstanding}).`
                        );
                    }

                    validatedInvoiceAllocations.push({
                        invoiceId: allocation.invoiceId,
                        allocationAmount,
                        outstandingAmount: outstanding,
                        invoice
                    });
                }

                const totalAllocated = toMoney(
                    validatedInvoiceAllocations.reduce((sum, allocation) => sum + allocation.allocationAmount, 0)
                );
                if (totalAllocated - paymentAmount > 0.01) {
                    throw new Error(
                        `Invalid payment: total allocations (${totalAllocated}) exceed payment amount (${paymentAmount}).`
                    );
                }

                const notes = (payment.notes || '').toLowerCase();
                const paymentPurpose = notes.includes('examination invoice')
                    ? 'EXAM_PAYMENT'
                    : (validatedInvoiceAllocations.length === 0
                        ? (payment.excessHandling === 'Wallet' ? 'WALLET_TOPUP' : 'UNALLOCATED_PAYMENT')
                        : 'INVOICE_PAYMENT');

                // 2. Calculate immutable receipt snapshot for posting-time facts.
                const snapshot = calculateCustomerPaymentSnapshot({
                    amountTendered: paymentAmount,
                    appliedInvoices: validatedInvoiceAllocations.map(allocation => ({
                        invoiceId: allocation.invoiceId,
                        allocationAmount: allocation.allocationAmount,
                        outstandingAmount: allocation.outstandingAmount
                    })),
                    excessHandling: payment.excessHandling,
                    paymentPurpose,
                    paymentDate: payment.date,
                    customerName: payment.customerName
                });

                // 3. Save payment with compatibility fields.
                const auditedPayment: CustomerPayment = {
                    ...payment,
                    customerId,
                    amount: paymentAmount,
                    allocations: validatedInvoiceAllocations.map(allocation => ({
                        invoiceId: allocation.invoiceId,
                        amount: allocation.allocationAmount
                    })),
                    receiptSnapshot: snapshot,
                    invoiceTotal: snapshot.invoiceTotalAtPosting,
                    paymentStatus: snapshot.paymentStatus,
                    balanceDue: snapshot.balanceDueAfterPayment,
                    overpaymentAmount: snapshot.walletDeposit,
                    walletDeposit: snapshot.walletDeposit,
                    changeGiven: snapshot.changeGiven,
                    amountApplied: snapshot.amountApplied,
                    amountRetained: snapshot.amountRetained,
                    excessAmount: snapshot.walletDeposit > 0 ? snapshot.walletDeposit : undefined,
                    calculationVersion: snapshot.calculationVersion
                };
                await paymentStore.put(ensureDocumentVerificationToken(auditedPayment));

                // 4. Update Invoices
                for (const allocation of validatedInvoiceAllocations) {
                    const invoice = allocation.invoice;
                    invoice.paidAmount = toMoney((invoice.paidAmount || 0) + allocation.allocationAmount);

                    if (invoice.paidAmount >= invoice.totalAmount) {
                        invoice.status = 'Paid';
                        paidInvoices.push({ id: invoice.id, status: invoice.status, customerId: invoice.customerId, totalAmount: invoice.totalAmount, paidAmount: invoice.paidAmount, referredBy: invoice.referredBy, referredByName: invoice.referredByName });
                    } else if (invoice.paidAmount > 0) {
                        invoice.status = 'Partial';
                    }
                    await invoiceStore.put(invoice);
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // Load customer record for wallet operations below.
                let customer = null as any;
                if (customerId) {
                    customer = await customerStore.get(customerId);
                }

                // 6a. Handle wallet DEPOSIT (overpayment credited to wallet).
                if (snapshot.walletDeposit > 0 && payment.excessHandling === 'Wallet' && customerId) {
                    const walletTx: WalletTransaction = {
                        id: generateId('WLT-PAY'),
                        customerId,
                        amount: snapshot.walletDeposit,
                        type: 'Deposit',
                        date: payment.date,
                        description: `Overpayment from payment ${payment.id}`
                    };
                    await walletStore.put(walletTx);

                    if (customer) {
                        customer.walletBalance = toMoney((customer.walletBalance || 0) + snapshot.walletDeposit);
                        await customerStore.put(customer);
                    }
                }

                // 6b. Handle wallet PAYMENT (customer pays FROM wallet balance).
                if (payment.paymentMethod === 'Wallet' && customerId && snapshot.amountRetained > 0) {
                    if (!customer) throw new Error('Customer not found for wallet deduction');
                    customer.walletBalance = toMoney((customer.walletBalance || 0) - snapshot.amountRetained);
                    await customerStore.put(customer);
                    const walletTx: WalletTransaction = {
                        id: generateId('WLT-DBT'),
                        customerId,
                        amount: -snapshot.amountRetained,
                        type: 'Debit',
                        date: payment.date,
                        description: `Wallet payment #${payment.id} applied to invoices`
                    };
                    await walletStore.put(walletTx);
                }

                // 7. Create Ledger entry for retained cash (ignore pure change-only records).
                const gl = getGLConfig();
                 let targetDebitAccount = resolveAcct(gl.cashDrawerAccount);

                 if (payment.paymentMethod === 'Wallet') {
                     targetDebitAccount = resolveAcct(gl.customerDepositAccount);
                 } else if (payment.accountId) {
                     targetDebitAccount = resolveAcct(payment.accountId);
                 } else {
                     if (payment.paymentMethod === 'Card' || payment.paymentMethod === 'Bank Transfer') targetDebitAccount = resolveAcct(gl.bankAccount);
                     if (payment.paymentMethod === 'Mobile Money') targetDebitAccount = resolveAcct(gl.mobileMoneyAccount);
                 }

                if (snapshot.amountRetained > 0) {
                    // Split ledger when overpayment goes to wallet alongside invoice payment
                    if (snapshot.walletDeposit > 0 && payment.excessHandling === 'Wallet' && snapshot.amountApplied > 0) {
                        const arEntry: LedgerEntry = {
                            id: generateId('LG-PAY'),
                            date: payment.date,
                            description: `Payment #${payment.id} from ${payment.customerName} - Status: ${snapshot.paymentStatus}`,
                            debitAccountId: targetDebitAccount,
                            creditAccountId: resolveAcct(gl.accountsReceivable),
                            amount: snapshot.amountApplied,
                            referenceId: payment.id,
                            reconciled: false,
                            customerId: customerId || payment.customerId,
                            customerName: payment.customerName
                        };
                        await ledgerStore.put(arEntry);
                        const depositEntry: LedgerEntry = {
                            id: generateId('LG-PAY-WLT'),
                            date: payment.date,
                            description: `Wallet deposit from payment #${payment.id}`,
                            debitAccountId: targetDebitAccount,
                            creditAccountId: resolveAcct(gl.customerDepositAccount),
                            amount: snapshot.walletDeposit,
                            referenceId: payment.id,
                            reconciled: false,
                            customerId: customerId || payment.customerId,
                            customerName: payment.customerName
                        };
                        await ledgerStore.put(depositEntry);
                    } else {
                        const creditAccountId = paymentPurpose === 'WALLET_TOPUP'
                            ? resolveAcct(gl.customerDepositAccount)
                            : resolveAcct(gl.accountsReceivable);

                        const ledgerEntry: LedgerEntry = {
                            id: generateId('LG-PAY'),
                            date: payment.date,
                            description: `Payment #${payment.id} from ${payment.customerName} - Status: ${snapshot.paymentStatus}`,
                            debitAccountId: targetDebitAccount,
                            creditAccountId,
                            amount: snapshot.amountRetained,
                            referenceId: payment.id,
                            reconciled: false,
                            customerId: customerId || payment.customerId,
                            customerName: payment.customerName
                        };
                        await ledgerStore.put(ledgerEntry);
                    }
                }

                // 8. Mirror to Banking (if a linked bank account exists — skip for wallet, no real money moved)
                const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                const bankAccount = payment.paymentMethod === 'Wallet' ? null : resolveBankAccountForPayment(bankAccounts, payment);
                if (bankAccount && snapshot.amountRetained > 0) {
                    const allBankTransactions = await bankTransactionsStore.getAll();
                    const existing = allBankTransactions.find(tx =>
                        tx.bankAccountId === bankAccount.id &&
                        tx.reference === payment.id &&
                        tx.type === 'Deposit'
                    );

                    if (!existing) {
                        const bankTx: BankTransaction = {
                            id: generateNextId('TXN', allBankTransactions),
                            date: payment.date,
                            amount: snapshot.amountRetained,
                            type: 'Deposit',
                            description: `Customer Payment #${payment.id}`,
                            reference: payment.id,
                            bankAccountId: bankAccount.id,
                            counterparty: payment.customerName ? { name: payment.customerName } : undefined,
                            category: 'Income',
                            reconciled: false,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };

                        await bankTransactionsStore.put(bankTx);

                        const nextBalance = calculateBankBalance(
                            [...allBankTransactions, bankTx],
                            bankAccount.id
                        );

                        await bankAccountsStore.put({
                            ...bankAccount,
                            balance: roundToCurrency(nextBalance),
                            availableBalance: roundToCurrency(nextBalance),
                            updatedAt: new Date().toISOString()
                        });
                    }
                }

                return { success: true };
            }
        );
        console.log('[REFERRAL-PAYMENT] paidInvoices:', paidInvoices.length, paidInvoices.map((pi: any) => ({ id: pi.id, referredBy: pi.referredBy, paidAmount: pi.paidAmount })));
        for (const pi of paidInvoices) {
            import('./referralService').then(({ referralService }) =>
                referralService.processInvoiceReward(pi).catch(err =>
                    logger.error('Referral reward processing failed for payment:', err)
                )
            );
        }
    },

    async voidCustomerPayment(paymentId: string, reason: string) {
        return dbService.executeAtomicOperation(
            ['customerPayments', 'invoices', 'customers', 'ledger', 'walletTransactions', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'customer_payment_void', paymentId);

                const paymentStore = tx.objectStore('customerPayments');
                const invoiceStore = tx.objectStore('invoices');
                const customerStore = tx.objectStore('customers');
                const ledgerStore = tx.objectStore('ledger');
                const walletStore = tx.objectStore('walletTransactions');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const payment = await paymentStore.get(paymentId);
                if (!payment) throw new Error("Payment not found");

                // 1. Reverse Invoices
                for (const allocation of payment.allocations) {
                    const invoice = await invoiceStore.get(allocation.invoiceId);
                    if (invoice) {
                        invoice.paidAmount = Math.max(0, (invoice.paidAmount || 0) - allocation.amount);
                        if (invoice.paidAmount <= 0) {
                            invoice.status = 'Unpaid';
                        } else {
                            invoice.status = 'Partial';
                        }
                        await invoiceStore.put(invoice);
                    }
                }

                // 2. Reverse Customer Balance
                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // Load customer for wallet reversal below.
                let customer = null as any;
                if (payment.customerId) {
                    customer = await customerStore.get(payment.customerId);
                }

                // 3. Reverse Wallet (if wallet deposit was posted)
                const walletDeposit = toMoney(
                    payment.walletDeposit ??
                    payment.receiptSnapshot?.walletDeposit ??
                    payment.overpaymentAmount ??
                    payment.excessAmount ??
                    0
                );
                if (walletDeposit > 0 && payment.excessHandling === 'Wallet') {
                    const walletTx: WalletTransaction = {
                        id: generateId('WLT-REV'),
                        customerId: payment.customerId,
                        amount: walletDeposit,
                        type: 'Deduction',
                        date: new Date().toISOString(),
                        description: `REVERSAL: Excess from payment ${payment.id}`
                    };
                    await walletStore.put(walletTx);

                    if (customer) {
                        customer.walletBalance = toMoney((customer.walletBalance || 0) - walletDeposit);
                        await customerStore.put(customer);
                    }
                }

                // 3b. Reverse Wallet Payment (if payment was made FROM wallet)
                if (payment.paymentMethod === 'Wallet') {
                    const walletPayAmount = toMoney(payment.amount || 0);
                    if (walletPayAmount > 0 && customer) {
                        customer.walletBalance = toMoney((customer.walletBalance || 0) + walletPayAmount);
                        await customerStore.put(customer);
                        const walletTx: WalletTransaction = {
                            id: generateId('WLT-REV'),
                            customerId: payment.customerId,
                            amount: walletPayAmount,
                            type: 'Credit',
                            date: new Date().toISOString(),
                            description: `REVERSAL: Wallet payment ${payment.id} voided`
                        };
                        await walletStore.put(walletTx);
                    }
                }

                // 4. Create Reversal Ledger Entry
                const gl = getGLConfig();
                const retainedAmount = toMoney(
                    payment.amountRetained ??
                    payment.receiptSnapshot?.amountRetained ??
                    payment.amount
                );
                let originalDebitAccount = gl.cashDrawerAccount;
                if (payment.paymentMethod === 'Wallet') {
                    originalDebitAccount = gl.customerDepositAccount;
                } else if (payment.accountId) {
                    originalDebitAccount = payment.accountId;
                } else {
                    if (payment.paymentMethod === 'Card' || payment.paymentMethod === 'Bank Transfer') originalDebitAccount = gl.bankAccount;
                    if (payment.paymentMethod === 'Mobile Money') originalDebitAccount = gl.mobileMoneyAccount;
                }
                const originalCreditAccount = payment.receiptSnapshot?.paymentPurpose === 'WALLET_TOPUP'
                    ? gl.customerDepositAccount
                    : gl.accountsReceivable;
                const reversal: LedgerEntry = {
                    id: generateId('LG-REV'),
                    date: new Date().toISOString(),
                    description: `VOID: Payment #${paymentId} - ${reason}`,
                    debitAccountId: resolveAcct(originalCreditAccount),
                    creditAccountId: resolveAcct(originalDebitAccount),
                    amount: retainedAmount,
                    referenceId: paymentId,
                    reconciled: false,
                    customerId: payment.customerId,
                    customerName: payment.customerName
                };
                await ledgerStore.put(reversal);

                // 5. Update Payment Status
                payment.status = 'Voided';
                payment.voidReason = reason;
                await paymentStore.put(payment);

                // 6. Mirror reversal to Banking (if linked bank account exists — skip for wallet, no real money moved)
                const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                const bankAccount = payment.paymentMethod === 'Wallet' ? null : resolveBankAccountForPayment(bankAccounts, payment);
                if (bankAccount) {
                    const allBankTransactions = await bankTransactionsStore.getAll();
                    const reversalRef = `VOID-${paymentId}`;
                    const existingReversal = allBankTransactions.find(tx =>
                        tx.bankAccountId === bankAccount.id &&
                        tx.reference === reversalRef &&
                        tx.type === 'Withdrawal'
                    );

                    if (!existingReversal) {
                        const bankTx: BankTransaction = {
                            id: generateNextId('TXN', allBankTransactions),
                            date: new Date().toISOString(),
                            amount: retainedAmount,
                            type: 'Withdrawal',
                            description: `Reversal for Payment #${paymentId}`,
                            reference: reversalRef,
                            bankAccountId: bankAccount.id,
                            counterparty: payment.customerName ? { name: payment.customerName } : undefined,
                            category: 'Income',
                            reconciled: false,
                            createdAt: new Date().toISOString(),
                            updatedAt: new Date().toISOString()
                        };

                        await bankTransactionsStore.put(bankTx);

                        const nextBalance = calculateBankBalance(
                            [...allBankTransactions, bankTx],
                            bankAccount.id
                        );

                        await bankAccountsStore.put({
                            ...bankAccount,
                            balance: roundToCurrency(nextBalance),
                            availableBalance: roundToCurrency(nextBalance),
                            updatedAt: new Date().toISOString()
                        });
                    }
                }

                return { success: true };
            }
        );
    },

    /**
     * Permanently remove a Voided customer payment record.
     * Only payments whose status is 'Voided' may be purged — active
     * transactions must go through voidCustomerPayment first. The record is
     * removed locally and a cloud delete op is enqueued so other devices
     * reconcile (standard dbService.delete tombstone flow).
     */
    async purgeVoidedCustomerPayment(paymentId: string) {
        const payment = await dbService.get<CustomerPayment>('customerPayments', paymentId);
        if (!payment) throw new Error("Payment not found");
        if (String(payment.status || '').toLowerCase() !== 'voided') {
            throw new Error("Only voided payments can be deleted permanently. Void the payment first.");
        }
        await dbService.delete('customerPayments', paymentId);
        return { success: true };
    },

    async saveCustomer(customer: Customer, oldCustomer?: Customer) {
        return dbService.executeAtomicOperation(
            ['customers'],
            async (tx) => {
                const store = tx.objectStore('customers');
                await store.put(customer);
                return { success: true };
            }
        );
    },

    async saveItem(item: Item, oldItem?: Item) {
        return dbService.executeAtomicOperation(
            ['inventory'],
            async (tx) => {
                const store = tx.objectStore('inventory');
                await store.put(item);
                return { success: true };
            }
        );
    },

    async deleteItem(id: string) {
        const item = await dbService.get<Item>('inventory', id);
        if (item) {
            (item as any).status = 'Deleted';
            (item as any).deleted_at = new Date().toISOString();
            await dbService.put('inventory', item);
        }
        return { success: true };
    },

    async updateInvoice(invoice: Invoice) {
        const result = await dbService.executeAtomicOperation(
            ['invoices'],
            async (tx) => {
                const store = tx.objectStore('invoices');
                const existing = await store.get(invoice.id);
                // Posted invoices are immutable by bare edit (AR, revenue and
                // COGS were already journalised): cancels must go through
                // voidInvoice and total/line changes need void-and-reissue.
                assertInvoiceEditable(existing, invoice);
                // The verification token is append-only: a partial edit that
                // omits it must never strip it from the stored record.
                if (existing && existing.verificationToken && !invoice.verificationToken) {
                    invoice.verificationToken = existing.verificationToken;
                }
                await store.put(invoice);
                return { success: true };
            }
        );
        return result;
    },

    /**
     * Returns the invoice's permanent verification token, issuing and
     * persisting one first when the invoice predates tokens (safe backfill:
     * single non-accounting field through the normal invoice save path, so
     * it syncs like any other invoice field; never regenerates).
     */
    async getOrIssueInvoiceVerificationToken(invoiceId: string): Promise<{ token: string; issued: boolean }> {
        const result = await dbService.executeAtomicOperation(
            ['invoices'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const invoice = await invoiceStore.get(invoiceId);
                if (!invoice) throw new Error(`Invoice #${invoiceId} not found`);
                if (invoice.verificationToken) return { token: String(invoice.verificationToken), issued: false };
                const next = ensureInvoiceVerificationToken(invoice);
                try {
                    await invoiceStore.put(next);
                } catch (putErr) {
                    // dbService.put persists to IndexedDB first, then enqueues
                    // cloud sync. A sync-enqueue failure must not surface as a
                    // missing token: the token is already stored locally —
                    // re-read and return it so Copy/View links work offline.
                    try {
                        const reread = await invoiceStore.get(invoiceId);
                        const recovered = String(reread?.verificationToken || '').trim();
                        if (recovered) return { token: recovered, issued: true };
                    } catch { /* fall through to the original put error */ }
                    throw putErr;
                }
                return { token: String(next.verificationToken), issued: true };
            }
        );
        return result;
    },

    /**
     * Generic backfill accessor: returns the permanent verification token for
     * any supported document record, issuing + persisting one first when the
     * record predates tokens. Single non-data field through the normal store
     * path (syncs like any other field); never regenerates. Used by
     * Copy/View verification actions and on-open backfills.
     */
    async getOrIssueDocumentVerificationToken(storeName: string, id: string): Promise<{ token: string; issued: boolean }> {
        const result = await dbService.executeAtomicOperation(
            [storeName],
            async (tx) => {
                const store = tx.objectStore(storeName);
                const record = await store.get(id);
                if (!record) throw new Error(`Record #${id} not found in ${storeName}`);
                if (record.verificationToken) return { token: String(record.verificationToken), issued: false };
                const next = ensureDocumentVerificationToken(record);
                try {
                    await store.put(next);
                } catch (putErr) {
                    // Same offline resilience as the invoice variant: the local
                    // write lands before the cloud-sync enqueue, so recover the
                    // just-issued token instead of reporting "no token".
                    try {
                        const reread = await store.get(id);
                        const recovered = String(reread?.verificationToken || '').trim();
                        if (recovered) return { token: recovered, issued: true };
                    } catch { /* fall through to the original put error */ }
                    throw putErr;
                }
                return { token: String(next.verificationToken), issued: true };
            }
        );
        return result;
    },

    /**
     * Explicit one-shot post-edit correction for a posted invoice whose
     * commercial total drifted from its net posted AR (e.g. INV-P726/023:
     * posted K592,000, now K575,500 → posts DR revenue / CR AR K16,500).
     *
     * - Original K592,000 journal is preserved untouched.
     * - Exactly one correction per delta (idempotent; conflicts STOP).
     * - Cancelled/Voided invoices are rejected (use voidInvoice instead);
     *   drafts are rejected (nothing posted to correct).
     * - AR/revenue only — never touches COGS or inventory.
     */
    async postInvoiceEditCorrection(invoiceId: string) {
        const result = await dbService.executeAtomicOperation(
            ['invoices', 'ledger', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const ledgerStore = tx.objectStore('ledger');
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) throw new UnresolvedAccountError(ref || 'undefined');
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) throw new UnresolvedAccountError(ref);
                    return resolved;
                };
                const invoice = await invoiceStore.get(invoiceId);
                if (!invoice) throw new Error(`Invoice #${invoiceId} not found`);
                const status = String(invoice.status || '');
                if (status === 'Cancelled' || status === 'Voided') {
                    throw new Error(`Invoice #${invoiceId} is ${status}: cancellation reversals go through voidInvoice, not the post-edit correction.`);
                }
                if (status === 'Draft') {
                    throw new Error(`Invoice #${invoiceId} is a Draft: nothing is posted, so there is nothing to correct.`);
                }
                return postEditCorrectionInTx(tx, {
                    invoice,
                    currentTotal: Number(invoice.totalAmount || 0),
                    requireOriginals: true,
                    ledgerStore,
                    resolveAcct,
                });
            }
        );
        return result;
    },

    /**
     * Controlled posted-invoice edit (STEP 6 preferred workflow): persists the
     * caller's next invoice state AND journals the resulting AR/revenue delta
     * atomically, preserving the original journal plus a full audit trail.
     * Drafts and non-accounting edits pass through with no correction.
     */
    async applyPostedInvoiceEdit(nextInvoice: any) {
        const result = await dbService.executeAtomicOperation(
            ['invoices', 'ledger', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const ledgerStore = tx.objectStore('ledger');
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) throw new UnresolvedAccountError(ref || 'undefined');
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) throw new UnresolvedAccountError(ref);
                    return resolved;
                };
                const existing = await invoiceStore.get(nextInvoice.id);
                if (!existing) throw new Error(`Invoice #${nextInvoice.id} not found`);
                const wasPosted = isPostedInvoiceStatus(existing.status);
                if (existing.verificationToken && !nextInvoice.verificationToken) {
                    nextInvoice.verificationToken = existing.verificationToken;
                }
                await invoiceStore.put(nextInvoice);
                if (!wasPosted) return { corrected: false, reason: 'unposted' as const };
                const correction = await postEditCorrectionInTx(tx, {
                    invoice: nextInvoice,
                    currentTotal: Number(nextInvoice.totalAmount || 0),
                    requireOriginals: false,
                    ledgerStore,
                    resolveAcct,
                });
                return { corrected: correction.posted, reason: correction.reason, spec: correction.spec, entryId: correction.entryId };
            }
        );
        return result;
    },

    async voidInvoice(id: string, reason: string) {
        const result = await dbService.executeAtomicOperation(
            ['invoices', 'inventory', 'ledger', 'customers', 'customerPayments', 'bankAccounts', 'bankTransactions', 'walletTransactions', 'accounts'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const paymentStore = tx.objectStore('customerPayments');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');
                const walletStore = tx.objectStore('walletTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const invoice = await invoiceStore.get(id);
                if (!invoice) throw new Error("Invoice not found");
                if (invoice.status === 'Cancelled' || invoice.status === 'Voided' || (invoice.status as string) === 'Void') {
                    throw new Error('Invoice is already voided/cancelled');
                }

                // Reversals must mirror the original postings exactly — even when a
                // referenced account has since been deactivated or removed from the
                // CoA (e.g. legacy pre-migration codes). Fall back to the stored
                // account id so a void can never fail closed on stale references.
                const resolveAcctLenient = (ref: string | undefined): string => {
                    if (!ref) throw new UnresolvedAccountError(ref || 'undefined');
                    try {
                        return resolveAcct(ref);
                    } catch {
                        return ref;
                    }
                };

                // 1. Reverse Inventory (lines may key stock by id, productId or itemId)
                for (const item of invoice.items) {
                    const invItem = await inventoryStore.get(item.id)
                        || (item.productId ? await inventoryStore.get(item.productId) : null)
                        || (item.itemId ? await inventoryStore.get(item.itemId) : null);
                    if (invItem) {
                        invItem.stock = (invItem.stock || 0) + item.quantity;
                        await inventoryStore.put(invItem);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // Load customer for wallet reversal below.
                let customer = null as any;
                if (invoice.customerId) {
                    customer = await customerStore.get(invoice.customerId);
                }

                const allPayments = await paymentStore.getAll();
                const relatedPayments = allPayments.filter((payment: CustomerPayment) => {
                    if (payment.status === 'Voided') return false;
                    if (payment.reference === id) return true;
                    return (payment.allocations || []).some(a => a.invoiceId === id);
                });

                const gl = getGLConfig();
                const voidInvLedgerEntries: LedgerEntry[] = [];

                for (const payment of relatedPayments) {
                    const retainedAmount = toMoney(
                        payment.amountRetained ??
                        payment.receiptSnapshot?.amountRetained ??
                        payment.amount
                    );
                    const walletDeposit = toMoney(
                        payment.walletDeposit ??
                        payment.receiptSnapshot?.walletDeposit ??
                        payment.overpaymentAmount ??
                        payment.excessAmount ??
                        0
                    );

                    if (walletDeposit > 0 && payment.excessHandling === 'Wallet' && payment.customerId) {
                        const walletTx: WalletTransaction = {
                            id: generateId('WLT-REV'),
                            customerId: payment.customerId,
                            amount: walletDeposit,
                            type: 'Deduction',
                            date: new Date().toISOString(),
                            description: `REVERSAL: Excess from payment ${payment.id}`
                        };
                        await walletStore.put(walletTx);

                        if (customer) {
                            customer.walletBalance = toMoney((customer.walletBalance || 0) - walletDeposit);
                            await customerStore.put(customer);
                        }
                    }

                    let originalDebitAccount = gl.cashDrawerAccount;
                    if (payment.paymentMethod === 'Wallet') {
                        originalDebitAccount = gl.customerDepositAccount;
                    } else if (payment.accountId) {
                        originalDebitAccount = payment.accountId;
                    } else {
                        if (payment.paymentMethod === 'Card' || payment.paymentMethod === 'Bank Transfer') originalDebitAccount = gl.bankAccount;
                        if (payment.paymentMethod === 'Mobile Money') originalDebitAccount = gl.mobileMoneyAccount;
                    }
                    const originalCreditAccount = payment.receiptSnapshot?.paymentPurpose === 'WALLET_TOPUP'
                        ? gl.customerDepositAccount
                        : gl.accountsReceivable;

                    if (retainedAmount > 0) {
                        const reversal: LedgerEntry = {
                            id: generateId('LG-REV'),
                            date: new Date().toISOString(),
                            description: `VOID: Payment #${payment.id} - Invoice ${id} voided`,
                            debitAccountId: resolveAcctLenient(originalCreditAccount),
                            creditAccountId: resolveAcctLenient(originalDebitAccount),
                            amount: retainedAmount,
                            referenceId: payment.id,
                            reconciled: false,
                            customerId: payment.customerId,
                            customerName: payment.customerName
                        };
                        await ledgerStore.put(reversal);
                        voidInvLedgerEntries.push(reversal);
                    }

                    const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                    const bankAccount = payment.paymentMethod === 'Wallet' ? null : resolveBankAccountForPayment(bankAccounts, payment);
                    if (bankAccount && retainedAmount > 0) {
                        const allBankTransactions = await bankTransactionsStore.getAll();
                        const reversalRef = `VOID-${payment.id}`;
                        const existingReversal = allBankTransactions.find(tx =>
                            tx.bankAccountId === bankAccount.id &&
                            tx.reference === reversalRef &&
                            tx.type === 'Withdrawal'
                        );

                        if (!existingReversal) {
                            const bankTx: BankTransaction = {
                                id: generateNextId('TXN', allBankTransactions),
                                date: new Date().toISOString(),
                                amount: retainedAmount,
                                type: 'Withdrawal',
                                description: `Reversal for Payment #${payment.id}`,
                                reference: reversalRef,
                                bankAccountId: bankAccount.id,
                                counterparty: payment.customerName ? { name: payment.customerName } : undefined,
                                category: 'Income',
                                reconciled: false,
                                createdAt: new Date().toISOString(),
                                updatedAt: new Date().toISOString()
                            };

                            await bankTransactionsStore.put(bankTx);

                            const nextBalance = calculateBankBalance(
                                [...allBankTransactions, bankTx],
                                bankAccount.id
                            );

                            await bankAccountsStore.put({
                                ...bankAccount,
                                balance: roundToCurrency(nextBalance),
                                availableBalance: roundToCurrency(nextBalance),
                                updatedAt: new Date().toISOString()
                            });
                        }
                    }

                    payment.status = 'Voided';
                    payment.voidReason = reason;
                    await paymentStore.put(payment);
                }

                // 3. Reverse Ledger Entries (Find existing ones for this invoice)
                const allLedger = await ledgerStore.getAll();
                const relatedEntries = allLedger.filter(l => l.referenceId === id);
                for (const entry of relatedEntries) {
                    const reversal: LedgerEntry = {
                        ...entry,
                        id: generateId('LG-REV'),
                        date: new Date().toISOString(),
                        description: `REVERSAL: ${entry.description}`,
                        debitAccountId: resolveAcctLenient(entry.creditAccountId),
                        creditAccountId: resolveAcctLenient(entry.debitAccountId),
                        amount: entry.amount,
                        reconciled: false
                    };
                    await ledgerStore.put(reversal);
                    voidInvLedgerEntries.push(reversal);
                }

                // Validate ledger balance for this void operation
                validateLedgerBalance(voidInvLedgerEntries, `voidInvoice #${id}`);

                // 4. Update Invoice Status
                invoice.status = 'Cancelled';
                invoice.voidReason = reason;
                invoice.paidAmount = 0;
                await invoiceStore.put(invoice);

                return { success: true };
            }
        );

        // Phase 6 — isolated Transport Budget full-void REVERSAL.
        // The commercial void above MUST persist first: executeAtomicOperation
        // provides no aggregate rollback, so the reversal is produced strictly
        // AFTER commit. A failure here is logged/swallowed by
        // produceVoidReversalSafely so the committed commercial void is never
        // affected; a retry reuses the deterministic key
        // REVERSAL:${economicKey}:VOID and converges via Phase 4 dedup.
        await produceVoidReversalSafely({ id });

        return result;
    },

    async voidSale(id: string, reason: string) {
        const result = await dbService.executeAtomicOperation(
            ['sales', 'inventory', 'ledger', 'customers', 'customerPayments', 'bankAccounts', 'bankTransactions', 'walletTransactions', 'inventoryTransactions', 'accounts'],
            async (tx) => {
                const salesStore = tx.objectStore('sales');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const paymentStore = tx.objectStore('customerPayments');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');
                const walletStore = tx.objectStore('walletTransactions');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const sale = await salesStore.get(id);
                if (!sale) throw new Error("Sale not found");
                if (sale.status === 'Voided') throw new Error("Sale already voided");

                const gl = getGLConfig();

                // Track all new ledger entries for validation
                const voidLedgerEntries: LedgerEntry[] = [];

                // 1. Reverse Inventory (restore stock)
                for (const item of sale.items || []) {
                    const invItem = await inventoryStore.get(item.id);
                    if (invItem && item.type !== 'Service') {
                        const previousQuantity = invItem.stock || 0;
                        const newQuantity = previousQuantity + item.quantity;
                        invItem.stock = newQuantity;
                        await inventoryStore.put(invItem);

                        // Create inventory reversal transaction record
                        const transaction = {
                            id: generateId('TXN'),
                            itemId: item.id,
                            type: 'IN',
                            quantity: item.quantity,
                            previousQuantity,
                            newQuantity,
                            unitCost: invItem.cost || 0,
                            totalCost: item.quantity * (invItem.cost || 0),
                            reference: 'SALE_VOID',
                            referenceId: id,
                            reason: `Void: ${reason}`,
                            performedBy: 'System',
                            timestamp: new Date().toISOString()
                        };
                        await inventoryTransactionsStore.put(transaction);
                    }
                }

                // [LEDGER] customer.balance is now derived from the authoritative ledger.
                // Independent balance mutation removed.

                // Reverse wallet deposits if any
                if (sale.customerId && sale.customerId !== 'walk-in') {
                    const customer = await customerStore.get(sale.customerId);
                    if (customer && sale.walletDeposit > 0) {
                        customer.walletBalance = toMoney((customer.walletBalance || 0) - sale.walletDeposit);
                        await customerStore.put(customer);

                        const walletTx: WalletTransaction = {
                            id: generateId('WLT-REV'),
                            customerId: sale.customerId,
                            amount: sale.walletDeposit,
                            type: 'Deduction',
                            date: new Date().toISOString(),
                            description: `REVERSAL: Void Sale #${sale.id}`
                        };
                        await walletStore.put(walletTx);
                    }
                }

                // 3. Void related payments
                const allPayments = await paymentStore.getAll();
                const relatedPayments = allPayments.filter((payment: CustomerPayment) => {
                    if (payment.status === 'Voided') return false;
                    if (payment.reference === id) return true;
                    return (payment.allocations || []).some(a => a.invoiceId === id || a.saleId === id);
                });

                for (const payment of relatedPayments) {
                    const retainedAmount = toMoney(
                        payment.amountRetained ??
                        payment.receiptSnapshot?.amountRetained ??
                        payment.amount
                    );

                    if (retainedAmount > 0) {
                        // Reverse payment ledger entry
                        let originalDebitAccount = gl.cashDrawerAccount;
                        if (payment.paymentMethod === 'Wallet') {
                            originalDebitAccount = gl.customerDepositAccount;
                        } else if (payment.accountId) {
                            originalDebitAccount = payment.accountId;
                        } else {
                            if (payment.paymentMethod === 'Card' || payment.paymentMethod === 'Bank Transfer') originalDebitAccount = gl.bankAccount;
                            if (payment.paymentMethod === 'Mobile Money') originalDebitAccount = gl.mobileMoneyAccount;
                        }

                        const reversal: LedgerEntry = {
                            id: generateId('LG-REV'),
                            date: new Date().toISOString(),
                            description: `VOID: Payment #${payment.id} - Sale ${id} voided`,
                            debitAccountId: resolveAcct(gl.cashDrawerAccount),
                            creditAccountId: resolveAcct(originalDebitAccount),
                            amount: retainedAmount,
                            referenceId: payment.id,
                            reconciled: false,
                            customerId: payment.customerId,
                            customerName: payment.customerName
                        };
                        await ledgerStore.put(reversal);
                        voidLedgerEntries.push(reversal);

                        // Reverse bank transaction
                        const bankAccounts = await ensureBankAccounts(bankAccountsStore);
                        const bankAccount = payment.paymentMethod === 'Wallet' ? null : resolveBankAccountForPayment(bankAccounts, payment);
                        if (bankAccount) {
                            const allBankTransactions = await bankTransactionsStore.getAll();
                            const reversalRef = `VOID-${payment.id}`;
                            const existingReversal = allBankTransactions.find(tx =>
                                tx.bankAccountId === bankAccount.id &&
                                tx.reference === reversalRef &&
                                tx.type === 'Withdrawal'
                            );

                            if (!existingReversal) {
                                const bankTx: BankTransaction = {
                                    id: generateNextId('TXN', allBankTransactions),
                                    date: new Date().toISOString(),
                                    amount: retainedAmount,
                                    type: 'Withdrawal',
                                    description: `Reversal for Payment #${payment.id}`,
                                    reference: reversalRef,
                                    bankAccountId: bankAccount.id,
                                    counterparty: payment.customerName ? { name: payment.customerName } : undefined,
                                    category: 'Income',
                                    reconciled: false,
                                    createdAt: new Date().toISOString(),
                                    updatedAt: new Date().toISOString()
                                };

                                await bankTransactionsStore.put(bankTx);

                                const nextBalance = calculateBankBalance(
                                    [...allBankTransactions, bankTx],
                                    bankAccount.id
                                );

                                await bankAccountsStore.put({
                                    ...bankAccount,
                                    balance: roundToCurrency(nextBalance),
                                    availableBalance: roundToCurrency(nextBalance),
                                    updatedAt: new Date().toISOString()
                                });
                            }
                        }
                    }

                    payment.status = 'Voided';
                    payment.voidReason = reason;
                    await paymentStore.put(payment);
                }

                // 4. Reverse COGS entries — mirror the ACTUAL posted legs (same
                // accounts, same amounts), never recompute from today's costs.
                // Sales whose COGS was never posted (legacy gap) need no GL
                // reversal here; only operational stock is restored above.
                const allLedgerForCogs = await ledgerStore.getAll();
                const postedCogsLegs = allLedgerForCogs.filter(l => {
                    if (l.referenceId !== id) return false;
                    const desc = String(l.description || '');
                    if (!desc.includes('COGS')) return false;
                    if (/reversal/i.test(desc)) return false;
                    return true;
                });
                for (const leg of postedCogsLegs) {
                    const cogsReversal: LedgerEntry = {
                        id: generateId('LG-COGS-REV'),
                        date: new Date().toISOString(),
                        description: `COGS Reversal - Void Sale #${sale.id}`,
                        debitAccountId: resolveAcct(leg.creditAccountId),
                        creditAccountId: resolveAcct(leg.debitAccountId),
                        amount: leg.amount,
                        referenceId: id,
                        reconciled: false,
                        customerId: sale.customerId,
                        customerName: sale.customerName
                    };
                    await ledgerStore.put(cogsReversal);
                    voidLedgerEntries.push(cogsReversal);
                }

                // 5. Reverse all other ledger entries for this sale
                const allLedger = await ledgerStore.getAll();
                const relatedEntries = allLedger.filter(l => l.referenceId === id && !l.description?.includes('COGS'));
                for (const entry of relatedEntries) {
                    const reversal: LedgerEntry = {
                        ...entry,
                        id: generateId('LG-REV'),
                        date: new Date().toISOString(),
                        description: `REVERSAL: ${entry.description}`,
                        debitAccountId: resolveAcct(entry.creditAccountId),
                        creditAccountId: resolveAcct(entry.debitAccountId),
                        amount: entry.amount,
                        reconciled: false
                    };
                    await ledgerStore.put(reversal);
                    voidLedgerEntries.push(reversal);
                }

                // Validate ledger balance for this void operation
                validateLedgerBalance(voidLedgerEntries, `voidSale #${id}`);

                // 6. Update Sale Status
                sale.status = 'Voided';
                sale.voidReason = reason;
                sale.voidedAt = new Date().toISOString();
                await salesStore.put(sale);

                return { success: true };
            }
        );

        // Phase 9B — isolated Transport Budget full-void REVERSAL, mirroring
        // voidInvoice. Runs strictly AFTER the commercial commit above and
        // never affects it (produceVoidReversalSafely logs/swallows).
        // Exactly-once by construction: non-mirror sales carry their own
        // SALES_ALLOCATION:{saleId} key and reverse here; mirror/converted
        // sales resolve to missing-allocation (their economics live under
        // the mirror/converted invoice key, reversed via the invoice path),
        // so no second reversal can arise from this call.
        await produceVoidReversalSafely({ id });

        return result;
    },

    async syncInventoryValuation(accountId: string, physicalValue: number, currentLedgerBalance: number, inventoryItems?: any[]) {
        return dbService.executeAtomicOperation(
            ['ledger', 'accounts', 'inventory', 'idempotencyKeys'],
            async (tx) => {
                const ledgerStore = tx.objectStore('ledger');
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };
                const getAccountCode = (acc: any): string => acc.account_number || acc.code || acc.id;

                const allEntries = await ledgerStore.getAll();
                const childAccountBalances: Record<string, number> = {};

                if (inventoryItems && inventoryItems.length > 0) {
                    for (const item of inventoryItems) {
                        if (item.type === 'Service') continue;
                        const childCode = resolveInventoryAccountByItemType(item.type, accounts, (item as any)?.inventoryRole);
                        if (childCode) {
                            const found = accounts.find(a => a.id === childCode || a.code === childCode || a.account_number === childCode);
                            const childId = found?.id || childCode;
                            // Canonical economics: quantity × cost (never SP).
                            const itemValue = resolveInventoryQuantity(item) * resolveInventoryCostPerUnit(item);
                            childAccountBalances[childId] = (childAccountBalances[childId] || 0) + itemValue;
                        }
                    }
                } else {
                    const targetAccount = accounts.find(a => a.id === accountId || a.code === accountId || a.account_number === accountId);
                    if (targetAccount && targetAccount.allow_posting === false) {
                        const childAccounts = accounts.filter(a => a.parent_account_id === accountId || a.parent_account_id === (targetAccount.account_number || targetAccount.code));
                        for (const child of childAccounts) {
                            const childBalance = allEntries.reduce((s: number, e: LedgerEntry) => {
                                if (!isPostedLedgerEntry(e)) return s;
                                if (entryTouchesAccount(e, child, 'debit')) return s + e.amount;
                                if (entryTouchesAccount(e, child, 'credit')) return s - e.amount;
                                return s;
                            }, 0);
                            childAccountBalances[child.id] = childBalance;
                        }
                    } else {
                        childAccountBalances[accountId] = currentLedgerBalance;
                    }
                }

                let totalPhysicalValue = 0;
                let totalGLBalance = 0;
                const childDetails: Record<string, { physical: number; gl: number; variance: number }> = {};

                for (const [childAccountId, childPhysicalValue] of Object.entries(childAccountBalances)) {
                    const childAccount = accounts.find(a => a.id === childAccountId);
                    if (!childAccount) continue;
                    const childBalance = allEntries.reduce((s: number, e: LedgerEntry) => {
                        if (!isPostedLedgerEntry(e)) return s;
                        if (entryTouchesAccount(e, childAccount, 'debit')) return s + e.amount;
                        if (entryTouchesAccount(e, childAccount, 'credit')) return s - e.amount;
                        return s;
                    }, 0);
                    // Normal-positive presentation (explicit normal_balance
                    // wins, else type-derived). Inverting this sign posts the
                    // valuation adjustment backwards, corrupting the ledger.
                    const childLedgerBalance = getNormalBalance(childAccount) === 'DEBIT' ? childBalance : -childBalance;
                    const variance = childPhysicalValue - childLedgerBalance;

                    childDetails[childAccountId] = {
                        physical: childPhysicalValue,
                        gl: childLedgerBalance,
                        variance,
                    };
                    totalPhysicalValue += childPhysicalValue;
                    totalGLBalance += childLedgerBalance;
                }

                const totalVariance = totalPhysicalValue - totalGLBalance;
                const withinTolerance = Math.abs(totalVariance) <= 0.01;

                let entriesPosted = 0;
                if (!withinTolerance) {
                    // Valuation-sync GL (fail-closed, symmetric COGS):
                    // - Surplus (physical > GL):  DR Inventory / CR COGS
                    // - Shortage (physical < GL): DR COGS / CR Inventory
                    // Never income (previously resolveAcct('42000') silently
                    // returned 42100 Interest Income via parent fallback).
                    const gl = getGLConfig();
                    const cogsAccountId = resolveAcct(gl.defaultCOGSAccount);
                    const syncRef = `INV-SYNC-${new Date().toISOString().split('T')[0]}`;

                    for (const [childAccountId, details] of Object.entries(childDetails)) {
                        const childVariance = details.variance;
                        if (Math.abs(childVariance) <= 0.01) continue;

                        const entry: LedgerEntry = {
                            id: generateId('LG-INVSYNC'),
                            date: new Date().toISOString(),
                            description: `Inventory Valuation Sync - ${details.variance > 0 ? 'Surplus' : 'Shortage'} (${childAccountId})`,
                            debitAccountId: childVariance > 0 ? childAccountId : cogsAccountId,
                            creditAccountId: childVariance > 0 ? cogsAccountId : childAccountId,
                            amount: Math.abs(childVariance),
                            referenceId: syncRef,
                            referenceType: 'inventory_valuation_sync',
                            entryType: 'inventory_valuation_sync',
                            reconciled: true
                        };
                        assertNoInterestIncomeForInventoryMovement({
                            debitAccountId: entry.debitAccountId as string,
                            creditAccountId: entry.creditAccountId as string,
                            accounts,
                            context: 'syncInventoryValuation',
                        });
                        await ledgerStore.put(entry);
                        entriesPosted++;
                    }
                }

                return {
                    success: true,
                    alreadyReconciled: withinTolerance,
                    withinTolerance,
                    totalPhysicalValue,
                    totalGLBalance,
                    totalVariance,
                    childDetails,
                    entriesPosted,
                };
            }
        );
    },

    async addExpense(expense: Expense) {
        return dbService.executeAtomicOperation(
            ['expenses', 'ledger', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'expense', expense.id, expense.idempotencyKey);

                const expenseStore = tx.objectStore('expenses');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const normalizedExpense: Expense = {
                    ...expense,
                    status: 'Paid'
                };
                await expenseStore.put(normalizedExpense);

                const gl = getGLConfig();
                const totalAmount = Number(normalizedExpense.amount);
                const expenseEntry: LedgerEntry = {
                    id: generateId('LG-EXP-MAIN'),
                    date: new Date().toISOString(),
                    description: `Expense: ${normalizedExpense.description}`,
                    debitAccountId: resolveAcct(gl.defaultExpenseAccount),
                    creditAccountId: resolveAcct(normalizedExpense.accountId || gl.bankAccount),
                    amount: totalAmount,
                    referenceId: normalizedExpense.id,
                    reconciled: false
                };
                await ledgerStore.put(expenseEntry);

                const settlementAccountId = normalizedExpense.accountId || gl.bankAccount || '11210';
                const settlementMethod = settlementAccountId === gl.cashDrawerAccount
                    ? 'Cash'
                    : settlementAccountId === gl.mobileMoneyAccount
                        ? 'Mobile Money'
                        : 'Bank Transfer';

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: normalizedExpense.date || new Date().toISOString(),
                    amount: totalAmount,
                    type: 'Withdrawal',
                    description: `Expense: ${normalizedExpense.description}`,
                    reference: `EXP-${normalizedExpense.id}`,
                    accountId: settlementAccountId,
                    paymentMethod: settlementMethod,
                    category: 'Expense'
                });

                return { success: true };
            }
        );
    },

    async approveExpense(id: string) {
        return dbService.executeAtomicOperation(
            ['expenses', 'ledger', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'expense_approval', id);

                const expenseStore = tx.objectStore('expenses');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const expense = await expenseStore.get(id);
                if (!expense) throw new Error("Expense not found");

                const existingEntries = await ledgerStore.getAll();
                const alreadyPosted = existingEntries.some((entry: LedgerEntry) => entry.referenceId === expense.id);

                if (alreadyPosted) {
                    expense.status = expense.status === 'Pending Approval' ? 'Approved' : expense.status;
                    await expenseStore.put(expense);
                    return { success: true, alreadyPosted: true };
                }

                expense.status = 'Approved';
                await expenseStore.put(expense);

                // Create Ledger Entry
                const gl = getGLConfig();
                const totalAmount = Number(expense.amount);

                // Debit Expense Account, Credit Payment Account
                const expenseEntry: LedgerEntry = {
                    id: generateId('LG-EXP-MAIN'),
                    date: new Date().toISOString(),
                    description: `Expense: ${expense.description}`,
                    debitAccountId: resolveAcct(gl.defaultExpenseAccount),
                    creditAccountId: resolveAcct(expense.accountId || gl.bankAccount),
                    amount: totalAmount,
                    referenceId: expense.id,
                    reconciled: false
                };
                await ledgerStore.put(expenseEntry);

                const settlementAccountId = expense.accountId || gl.bankAccount || '11210';
                const settlementMethod = settlementAccountId === gl.cashDrawerAccount
                    ? 'Cash'
                    : settlementAccountId === gl.mobileMoneyAccount
                        ? 'Mobile Money'
                        : 'Bank Transfer';

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: expense.date || new Date().toISOString(),
                    amount: totalAmount,
                    type: 'Withdrawal',
                    description: `Expense: ${expense.description}`,
                    reference: `EXP-${expense.id}`,
                    accountId: settlementAccountId,
                    paymentMethod: settlementMethod,
                    category: 'Expense'
                });

                return { success: true };
            }
        );
    },

    async addIncome(income: Income) {
        return dbService.executeAtomicOperation(
            ['income', 'ledger', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'income', income.id, income.idempotencyKey);

                const incomeStore = tx.objectStore('income');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                await incomeStore.put(income);

                // Create Ledger Entry
                const gl = getGLConfig();
                const entry: LedgerEntry = {
                    id: generateId('LG-INC'),
                    date: income.date,
                    description: `Income: ${income.description}`,
                    debitAccountId: resolveAcct(income.accountId || gl.bankAccount),
                    creditAccountId: resolveAcct(gl.otherIncomeAccount),
                    amount: income.amount,
                    referenceId: income.id,
                    reconciled: false
                };
                await ledgerStore.put(entry);

                const settlementAccountId = income.accountId || gl.bankAccount || '11210';
                const settlementMethod = settlementAccountId === gl.cashDrawerAccount
                    ? 'Cash'
                    : settlementAccountId === gl.mobileMoneyAccount
                        ? 'Mobile Money'
                        : 'Bank Transfer';

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: income.date,
                    amount: income.amount,
                    type: 'Deposit',
                    description: `Income: ${income.description}`,
                    reference: `INC-${income.id}`,
                    accountId: settlementAccountId,
                    paymentMethod: settlementMethod,
                    category: 'Income'
                });

                return { success: true };
            }
        );
    },

    async executeTransfer(transfer: Transfer) {
        return dbService.executeAtomicOperation(
            ['transfers', 'ledger', 'bankAccounts', 'bankTransactions', 'accounts', 'idempotencyKeys'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'transfer', transfer.id, transfer.idempotencyKey);

                const transferStore = tx.objectStore('transfers');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');
                const accountsStore = tx.objectStore('accounts');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                await transferStore.put(transfer);

                const fromAccountId = resolveAcct(transfer.fromAccountId);
                const toAccountId = resolveAcct(transfer.toAccountId);

                const entry: LedgerEntry = {
                    id: generateId('LG-TRF'),
                    date: transfer.date,
                    description: `Internal Transfer: ${transfer.description || ''}`,
                    debitAccountId: toAccountId,
                    creditAccountId: fromAccountId,
                    amount: transfer.amount,
                    referenceId: transfer.id,
                    reconciled: true
                };
                await ledgerStore.put(entry);

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: transfer.date,
                    amount: transfer.amount,
                    type: 'Withdrawal',
                    description: `Transfer out: ${transfer.description || transfer.id}`,
                    reference: `TRF-OUT-${transfer.id}`,
                    accountId: fromAccountId,
                    paymentMethod: 'Bank Transfer',
                    category: 'Transfer'
                });

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: transfer.date,
                    amount: transfer.amount,
                    type: 'Deposit',
                    description: `Transfer in: ${transfer.description || transfer.id}`,
                    reference: `TRF-IN-${transfer.id}`,
                    accountId: toAccountId,
                    paymentMethod: 'Bank Transfer',
                    category: 'Transfer'
                });

                return { success: true };
            }
        );
    },

    async applyLateFeeToInvoice(invoiceId: string, fee: number) {
        return dbService.executeAtomicOperation(
            ['invoices', 'ledger', 'accounts'],
            async (tx) => {
                const invoiceStore = tx.objectStore('invoices');
                const ledgerStore = tx.objectStore('ledger');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const invoice = await invoiceStore.get(invoiceId);
                if (!invoice) throw new Error("Invoice not found");

                invoice.totalAmount += fee;
                await invoiceStore.put(invoice);

                const gl = getGLConfig();
                const entry: LedgerEntry = {
                    id: generateId('LG-FEE'),
                    date: new Date().toISOString(),
                    description: `Late Fee for Invoice #${invoice.id}`,
                    debitAccountId: resolveAcct(gl.accountsReceivable),
                    creditAccountId: resolveAcct(gl.otherIncomeAccount),
                    amount: fee,
                    referenceId: invoice.id,
                    reconciled: false,
                    customerId: invoice.customerId,
                    customerName: invoice.customerName
                };
                await ledgerStore.put(entry);

                return { success: true };
            }
        );
    },

    async processGoodsReceipt(grn: GoodsReceipt, performedBy?: string) {
        // Serialize same-PO landing consumption within this tab; a GRN
        // without landing costs takes the direct path unchanged.
        const needsLandingLock = !!(grn?.purchaseOrderId) && ((grn as any).landingCosts || []).some((c: any) => Number(c?.amount) >= 0.005);
        let result: any;
        if (!needsLandingLock) {
            result = await this.processGoodsReceiptTx(grn, performedBy);
        } else {
            const lockKey = `landing-consume-grn:${grn.purchaseOrderId}`;
            const previous = landingConsumptionLocks.get(lockKey) || Promise.resolve();
            let releaseLock!: () => void;
            const current = new Promise<void>((resolve) => { releaseLock = resolve; });
            landingConsumptionLocks.set(lockKey, current);
            try {
                await previous.catch(() => {});
                result = await this.processGoodsReceiptTx(grn, performedBy);
            } finally {
                if (landingConsumptionLocks.get(lockKey) === current) {
                    landingConsumptionLocks.delete(lockKey);
                }
                releaseLock();
            }
        }
        // Phase 7F: post-commit inbound consumption producer (fire-and-forget,
        // same pattern as the sales-allocation hooks below). The Landing Cost
        // GRN transaction already committed: a transport failure never fails
        // the GRN and stays retryable through the deterministic economic key
        // (INBOUND_CONSUMPTION:{landingCostId}:{grnId}).
        import('./transportBudgetInboundConsumption').then(
            ({
                produceInboundConsumptionSafely,
                defaultInboundConsumptionDeps,
                fireInboundConsumptionHook,
            }) =>
                fireInboundConsumptionHook(
                    produceInboundConsumptionSafely(defaultInboundConsumptionDeps, {
                        grnId: (grn as any)?.id,
                        grnDate: (grn as any)?.date,
                        landingCosts: (((grn as any)?.landingCosts || []) as any[]),
                        events: (result as any)?.grnConsumptionEvents || [],
                    }),
                    String((grn as any)?.id || ''),
                ),
        ).catch(() => {
            // Module load failure must not affect the committed GRN either.
        });
        return result;
    },

    async processGoodsReceiptTx(grn: GoodsReceipt, performedBy?: string) {
        return dbService.executeAtomicOperation(
            ['inventory', 'goodsReceipts', 'purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'inventoryTransactions', 'idempotencyKeys', 'materialBatches', 'accounts', 'vatTransactions'],
            async (tx) => {
                const inventoryStore = tx.objectStore('inventory');
                const grnStore = tx.objectStore('goodsReceipts');
                const purchaseStore = tx.objectStore('purchases');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');
                const inventoryTransactionsStore = tx.objectStore('inventoryTransactions');
                const materialBatchesStore = tx.objectStore('materialBatches');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const gl = getGLConfig();
                // Stock-bearing goods value (ex-landing) and capitalized landed
                // value are tracked separately so the goods supplier is credited
                // for goods only, each landing provider is credited for its own
                // lines, and landing never leaks into the Purchases variance leg.
                let goodsValue = 0;
                let landedValue = 0;
                // Non-stock (Product/Service) receipt value: never inventory —
                // booked to Purchases so payables stay whole.
                let nonStockValue = 0;

                // Negative landing amounts never post directly: credits flow
                // only through the controlled correction flow (original →
                // reversal → replacement). Fail closed with direction.
                for (const c of ((grn.landingCosts || []) as any[])) {
                    if (Number(c?.amount) < -0.005) {
                        throw new Error(
                            `Landing cost line ${c?.id || 'unknown'} on GRN ${grn.id} is negative ` +
                            `(K${Number(c.amount).toFixed(2)}). Negative landing costs post only as controlled ` +
                            `corrections linked to the original line — failing closed.`
                        );
                    }
                }
                // Capitalized landing set: lines at or above currency precision
                // (K0.005). Zero lines (e.g. unfilled estimates) and sub-cent
                // dust capitalize nothing — consistent with the 0.005 posting
                // gates below.
                const capitalizableLanding: any[] = ((grn.landingCosts || []) as any[])
                    .filter((c: any) => Number(c?.amount) >= 0.005);
                const landingCostTotal = capitalizableLanding.reduce((s: number, c: any) => s + (Number(c.amount) || 0), 0);
                // Tax split per line (pure, deterministic): RECOVERABLE_VAT
                // diverts its portion to input-VAT posting (never inventory);
                // WITHHOLDING and unrated recoverable lines throw here, before
                // any reservation or mutation. Allocation/consumption operate
                // on the capitalizable portion only.
                const taxSplitByLine = new Map<string, {
                    gross: number; capitalizable: number; recoverableVAT: number;
                    rate: number; treatment: string; taxInclusive: boolean;
                }>();
                for (const cost of capitalizableLanding) {
                    taxSplitByLine.set(String(cost.id), splitLandingLineTax(cost));
                }
                // VAT takes per line (journal stage reads this; hoisted to tx
                // scope because the journal stage lives outside the pre-pass).
                const vatTakeByLine = new Map<string, number>();

                // Authoritative allocation: one deterministic result per landing
                // line, computed from THIS GRN snapshot only (never current PO
                // state, prices, quantities or UI state). The method and shares
                // are persisted on the GRN in section 3 for audit, reload and
                // sync. Supported: VALUE, QUANTITY (see landingAllocation.ts).
                let landingAllocation: LandingAllocationResult | null = null;
                const billedLandingLineIds = new Set<string>();
                // providerId -> supplier record for UNBILLED posting lines,
                // resolved up front so an unresolvable provider fails the whole
                // GRN clearly BEFORE the idempotency key is reserved.
                const landingProviderRecords = new Map<string, any>();
                // Pre-built (provider, inventory account) posting groups,
                // validated pre-mutation; the journal stage only writes them.
                const landingJournalGroups: {
                    providerId: string; provider: any; account: string;
                    amount: number; lineIds: string[]; detail: string[];
                }[] = [];
                // GRN consumption events for this verify, appended to the PO
                // in section 2 (same atomic tx); journalIds backfilled below.
                const grnConsumptionEvents: {
                    id: string; landingCostId: string; kind: 'GRN';
                    billId: null; grnId: string; amount: number; sourceAmount: number;
                    method: string; providerId: string;
                    accountSplits: { account: string; amount: number }[];
                    journalIds: string[]; at: string;
                    taxTreatment: string; taxAmount: number;
                }[] = [];
                if (landingCostTotal > 0) {
                    const rawMethod = (grn as any).landingAllocationMethod ?? 'VALUE';
                    const method = normalizeLandingAllocationMethod(rawMethod);
                    if (!method) {
                        throw new Error(
                            `GRN ${grn.id} names unsupported landing-cost allocation method "${String(rawMethod)}". ` +
                            `Supported methods: VALUE, QUANTITY.`
                        );
                    }
                    const snapshotItems = (grn.items || []) as any[];
                    const invRecords: any[] = [];
                    for (const item of snapshotItems) {
                        invRecords.push(await inventoryStore.get(item.itemId));
                    }
                    const isEligible = (lineIndex: number) => {
                        const rec = invRecords[lineIndex];
                        return !!rec && isInventoryBearingItem(rec);
                    };
                    // Lines already settled by a landing-cost bill post no new
                    // journals here, but their consumable amounts stay in the
                    // WAC basis so carrying cost and the bill's inventory debit
                    // agree. Cancelled (reversed) bills settle nothing.
                    for (const inv of await tx.objectStore('purchaseInvoices').getAll()) {
                        if (inv && (inv as any).landingCostId && (inv as any).status !== 'cancelled') {
                            billedLandingLineIds.add(String((inv as any).landingCostId));
                        }
                    }
                    // Durable consumption state: remaining per line = source −
                    // prior GRN-kind consumption events on the PO. BILL events
                    // establish AP/debit but never reduce WAC-embedding
                    // remaining. This GRN may only consume what remains.
                    let poDocForConsumption: any = null;
                    if (grn.purchaseOrderId) {
                        try {
                            poDocForConsumption = await purchaseStore.get(grn.purchaseOrderId);
                        } catch {
                            poDocForConsumption = null;
                        }
                    }
                    const consumedByLine = new Map<string, number>();
                    // Manual/standalone GRNs must not capitalize landing: with no
                    // source PO there is no durable consumption state and no
                    // cross-GRN basis. Plain manual GRNs without landing costs
                    // pass through untouched (landingCostTotal == 0 skips all).
                    if (!poDocForConsumption) {
                        throw new Error(
                            `GRN ${grn.id} carries landing costs but is not linked to a valid purchase order. ` +
                            `Landing Cost financial posting requires a valid source PO/LandingCostItem — failing closed. ` +
                            `Manual GRNs without landing costs are unaffected.`
                        );
                    }
                    // Note: GRN snapshot lines need not be present on the PO:
                    // the snapshot is the posted document authority (Prompt-4
                    // §11). Consumption events keyed by LandingCostItem.id
                    // track remaining regardless; drift between PO lines and
                    // consumed snapshots surfaces through reconciliation.
                    for (const ev of ((poDocForConsumption as any).landingConsumption || [])) {
                        if (ev && (ev.kind === 'GRN' || ev.kind === 'CORRECTION') && ev.landingCostId) {
                            const id = String(ev.landingCostId);
                            consumedByLine.set(id, (consumedByLine.get(id) || 0) + (Number(ev.amount) || 0));
                        }
                    }
                    // Cross-GRN proportional entitlement (integer cents): this
                    // GRN consumes its share of each line's still-unconsumed
                    // capitalizable amount, proportioned by its eligible
                    // snapshot basis against the PO's total eligible basis in
                    // the same method. First-GRN-takes-all is NOT used.
                    const toCents = (v: number) => Math.round(v * 100);
                    let poEligibleBasis = 0;
                    for (const poLine of (((poDocForConsumption as any).items || []) as any[])) {
                        const rec = await inventoryStore.get(poLine.itemId);
                        if (!rec || !isInventoryBearingItem(rec)) {
                            continue;
                        }
                        if (method === 'QUANTITY') {
                            poEligibleBasis += Number(poLine.quantity ?? poLine.quantityReceived ?? 0) || 0;
                        } else {
                            poEligibleBasis += resolveReceiptUnitCost(poLine) * (Number(poLine.quantity ?? poLine.quantityReceived ?? 0) || 0);
                        }
                    }
                    if (!(poEligibleBasis > 0)) {
                        throw new Error(
                            `GRN ${grn.id} cannot compute cross-GRN landing entitlement: the source PO has no eligible ` +
                            `${method === 'QUANTITY' ? 'quantity' : 'value'} basis. Failing closed rather than guessing.`
                        );
                    }
                    // This GRN's eligible basis in the same method.
                    let grnEligibleBasis = 0;
                    snapshotItems.forEach((item: any, lineIndex: number) => {
                        if (!isEligible(lineIndex)) {
                            return;
                        }
                        if (method === 'QUANTITY') {
                            grnEligibleBasis += Number(item.quantityReceived) || 0;
                        } else {
                            grnEligibleBasis += resolveReceiptUnitCost(item) * (Number(item.quantityReceived) || 0);
                        }
                    });
                    const consumableByLine = new Map<string, number>();
                    // vatTakeByLine is hoisted to tx scope (declared above):
                    // the journal stage reads the takes computed here.
                    const vatConsumedByLine = new Map<string, number>();
                    for (const ev of ((poDocForConsumption as any).landingConsumption || [])) {
                        if (ev && ev.landingCostId && Number((ev as any).taxAmount) > 0) {
                            const id = String(ev.landingCostId);
                            vatConsumedByLine.set(id, (vatConsumedByLine.get(id) || 0) + Number((ev as any).taxAmount));
                        }
                    }
                    let totalRemainingCents = 0;
                    for (const cost of capitalizableLanding) {
                        const id = String(cost.id);
                        const split = taxSplitByLine.get(id)!;
                        const sourceCapCents = toCents(split.capitalizable);
                        const consumedCents = toCents(consumedByLine.get(id) || 0);
                        const remainingCents = sourceCapCents - consumedCents;
                        if (remainingCents < 0) {
                            throw new Error(
                                `Landing cost line ${id} on GRN ${grn.id} is over-consumed ` +
                                `(capitalizable K${(sourceCapCents / 100).toFixed(2)}, already consumed K${(consumedCents / 100).toFixed(2)}). ` +
                                `Consumption state inconsistent — failing closed before financial mutation.`
                            );
                        }
                        totalRemainingCents += remainingCents;
                        const entitlementCents = computeEntitlementCents(sourceCapCents, grnEligibleBasis, poEligibleBasis);
                        const consumableCents = Math.min(entitlementCents, remainingCents);
                        consumableByLine.set(id, consumableCents / 100);
                        // VAT recovered proportionally to this GRN's consumed
                        // share, capped by the line's VAT remainder.
                        const lineVatCents = toCents(split.recoverableVAT);
                        const vatRemainingCents = lineVatCents - toCents(vatConsumedByLine.get(id) || 0);
                        vatTakeByLine.set(
                            id,
                            computeConsumedVatCents(
                                consumableCents, toCents(split.gross), sourceCapCents,
                                split.rate, split.taxInclusive, Math.max(0, vatRemainingCents),
                            ) / 100
                        );
                    }
                    if (totalRemainingCents > 0 && !(grnEligibleBasis > 0)) {
                        throw new Error(
                            `GRN ${grn.id} carries unconsumed landing costs but has no eligible receipt basis to allocate them to. ` +
                            `Failing closed rather than guessing.`
                        );
                    }
                    for (const cost of capitalizableLanding) {
                        if (billedLandingLineIds.has(String(cost.id))) {
                            continue;
                        }
                        // Lines with nothing left to consume post nothing and
                        // need no provider validation.
                        if (!(consumableByLine.get(String(cost.id))! > 0)) {
                            continue;
                        }
                        const providerId = String(cost.providerId || '').trim();
                        if (!providerId) {
                            throw new Error(
                                `Landing cost "${cost.category || 'Uncategorized'}" (K${Number(cost.amount).toFixed(2)}, line ${cost.id || 'unknown'}) on GRN ${grn.id} ` +
                                `has no provider. Select the actual carrier/customs broker/supplier before verifying so the payable posts to the correct provider.`
                            );
                        }
                        const provider = await supplierStore.get(providerId);
                        if (!provider) {
                            throw new Error(
                                `Landing cost "${cost.category || 'Uncategorized'}" (K${Number(cost.amount).toFixed(2)}, line ${cost.id || 'unknown'}) on GRN ${grn.id} ` +
                                `names unknown provider "${providerId}". Register the provider as a supplier first so the payable posts to the correct provider.`
                            );
                        }
                        landingProviderRecords.set(providerId, provider);
                    }
                    const consumableLines = capitalizableLanding.filter(
                        (c: any) => consumableByLine.get(String(c.id))! > 0
                    );
                    if (consumableLines.length > 0) {
                        landingAllocation = allocateLandingCosts({
                            receiptLines: snapshotItems.map((item: any) => ({
                                itemId: String(item.itemId || ''),
                                quantityReceived: Number(item.quantityReceived) || 0,
                                unitCost: resolveReceiptUnitCost(item),
                            })),
                            isEligible,
                            // Only the still-unconsumed remainder enters WAC:
                            // the amount actually consumed by THIS GRN.
                            landingLines: consumableLines.map((c: any) => ({
                                id: String(c.id),
                                amount: consumableByLine.get(String(c.id))!,
                            })),
                            method,
                            resolveAccount: (lineIndex: number) => {
                                const rec = invRecords[lineIndex];
                                const line = snapshotItems[lineIndex];
                                if (!rec || !isInventoryBearingItem(rec)) return null;
                                const merged = {
                                    ...(line as any),
                                    type: (rec as any).type ?? (line as any).type,
                                    inventoryRole: (rec as any).inventoryRole ?? (line as any).inventoryRole,
                                };
                                return resolveInventoryAccountFromItems([merged], accounts);
                            },
                        });
                        // Snapshot persistence (written with the GRN in section 3).
                        (grn as any).landingAllocationMethod = landingAllocation.method;
                        (grn as any).landingAllocations = landingAllocation.shares;
                        // Consumption events for this verify (journalIds and VAT
                        // backfilled at posting). One event per consumed line,
                        // billed or not: billed lines embed WAC without new
                        // journals; unbilled lines embed and journalize.
                        // sourceAmount is the capitalizable source the
                        // entitlement was computed from.
                        const at = new Date().toISOString();
                        for (const cost of consumableLines) {
                            const id = String(cost.id);
                            const split = taxSplitByLine.get(id)!;
                            grnConsumptionEvents.push({
                                id: generateId('LCC'),
                                landingCostId: id,
                                kind: 'GRN',
                                billId: null,
                                grnId: grn.id,
                                amount: consumableByLine.get(id)!,
                                sourceAmount: split.capitalizable,
                                method,
                                providerId: String(cost.providerId || '').trim(),
                                accountSplits: [],
                                journalIds: [],
                                at,
                                taxTreatment: split.treatment,
                                taxAmount: 0,
                            });
                        }
                    }

                    // Pre-build posting groups (UNBILLED consumable shares only)
                    // and enforce the boundary invariant BEFORE any mutation:
                    // journalled landing must equal the unbilled consumable
                    // total exactly, and every posting share must carry a
                    // resolved inventory account — otherwise fail closed here,
                    // with the ledger, stock and idempotency key all untouched.
                    // Per-line account splits are recorded onto this GRN's
                    // consumption events for audit.
                    if (landingAllocation) {
                        const costById = new Map<string, any>(
                            capitalizableLanding.map((c: any) => [String(c.id), c])
                        );
                        const grouped = new Map<string, {
                            providerId: string; provider: any; account: string;
                            amount: number; lineIds: string[]; detail: string[];
                        }>();
                        const lineSplits = new Map<string, { account: string; amount: number }[]>();
                        for (const share of landingAllocation.shares) {
                            if (!share.inventoryAccount) {
                                if (billedLandingLineIds.has(share.landingCostId)) {
                                    continue;
                                }
                                throw new Error(
                                    `Cannot resolve an inventory account for landing share of line ${share.landingCostId} ` +
                                    `on receipt line ${share.receiptLineKey} (item ${share.itemId}). ` +
                                    `Failing closed before financial mutation.`
                                );
                            }
                            const splits = lineSplits.get(share.landingCostId) || [];
                            const existing = splits.find((s) => s.account === share.inventoryAccount);
                            if (existing) {
                                existing.amount += share.amount;
                            } else {
                                splits.push({ account: share.inventoryAccount, amount: share.amount });
                            }
                            lineSplits.set(share.landingCostId, splits);
                            if (billedLandingLineIds.has(share.landingCostId)) {
                                continue;
                            }
                            if (!(share.amount > 0)) {
                                continue;
                            }
                            const cost = costById.get(share.landingCostId);
                            const shareProviderId = String(cost?.providerId || '').trim();
                            const shareProvider = landingProviderRecords.get(shareProviderId);
                            if (!shareProvider) {
                                throw new Error(
                                    `Landing provider "${shareProviderId}" for line ${share.landingCostId} cannot be posted: supplier record missing.`
                                );
                            }
                            if (!share.inventoryAccount) {
                                throw new Error(
                                    `Cannot resolve an inventory account for landing share of line ${share.landingCostId} ` +
                                    `on receipt line ${share.receiptLineKey} (item ${share.itemId}). ` +
                                    `Failing closed before financial mutation.`
                                );
                            }
                            const key = `${shareProviderId}::${share.inventoryAccount}`;
                            let group = grouped.get(key);
                            if (!group) {
                                group = {
                                    providerId: shareProviderId, provider: shareProvider,
                                    account: share.inventoryAccount, amount: 0, lineIds: [], detail: [],
                                };
                                grouped.set(key, group);
                            }
                            group.amount += share.amount;
                            if (!group.lineIds.includes(share.landingCostId)) {
                                group.lineIds.push(share.landingCostId);
                                group.detail.push(`${cost?.category || 'Cost'} (${share.landingCostId})`);
                            }
                        }
                        // Boundary invariant: journalled landing must equal the
                        // unbilled CONSUMABLE total exactly — never lose, never
                        // invent. (Consumable already reflects remaining.)
                        const unbilledConsumable = [...consumableByLine.entries()]
                            .filter(([id]) => !billedLandingLineIds.has(id))
                            .reduce((s, [, v]) => s + v, 0);
                        const groupedTotal = [...grouped.values()].reduce((s, g) => s + g.amount, 0);
                        if (Math.abs(groupedTotal - unbilledConsumable) > 0.005) {
                            throw new Error(
                                `Landing journal grouping mismatch on GRN ${grn.id}: grouped K${groupedTotal.toFixed(2)} vs unbilled consumable K${unbilledConsumable.toFixed(2)}. ` +
                                `Failing closed before financial mutation.`
                            );
                        }
                        for (const ev of grnConsumptionEvents) {
                            ev.accountSplits = lineSplits.get(ev.landingCostId) || [];
                        }
                        landingJournalGroups.push(...grouped.values());
                    }
                }

                await reserveIdempotencyKey(tx, 'goods_receipt', grn.id, grn.idempotencyKey);

                // 1. Update Inventory Stock and Cost (before saving GRN to get accurate totals).
                // Eligibility-first: only Raw Material / Stationery lines are
                // stock-bearing. Product/Service lines accrue no stock/WAC/
                // batch/audit/inventory value; their purchase value is tracked
                // separately for the Purchases (expense) leg below.
                const timestamp = new Date().toISOString();
                let receiptLineIndex = -1;
                for (const item of grn.items) {
                    receiptLineIndex += 1;
                    const invItem = await inventoryStore.get(item.itemId);
                    if (invItem && !isInventoryBearingItem(invItem)) {
                        nonStockValue += resolveReceiptUnitCost(item) * (item.quantityReceived || 0);
                        continue;
                    }
                    if (invItem && isInventoryBearingItem(invItem)) {
                        const oldStock = invItem.stock || 0;
                        const newStock = oldStock + item.quantityReceived;
                        const lineUnitCost = resolveReceiptUnitCost(item);

                        // Landed share from the persisted authoritative
                        // allocation (includes billed lines for carrying cost;
                        // billed lines post no new journals below).
                        let landedCostPerUnit = 0;
                        let itemLandingShare = 0;
                        if (landingAllocation) {
                            itemLandingShare = sumSharesForReceiptLine(landingAllocation.shares, String(receiptLineIndex));
                            if (item.quantityReceived > 0) {
                                landedCostPerUnit = itemLandingShare / item.quantityReceived;
                            }
                        }
                        const effectiveUnitCost = lineUnitCost + landedCostPerUnit;

                        // Weighted Average Cost calculation (using landed cost)
                        const oldCost = invItem.cost || 0;
                        const newCost = ((oldCost * oldStock) + (effectiveUnitCost * item.quantityReceived)) / newStock;

                        invItem.stock = newStock;
                        // Every cost alias carries the fresh average:
                        // resolveStoredCost reads cost_price/cost_per_unit
                        // BEFORE cost, so a stale alias would shadow it for
                        // PO defaults, POS snapshots, and sale CP.
                        Object.assign(invItem, costAliasValues(newCost));
                        await inventoryStore.put(invItem);

                        goodsValue += lineUnitCost * item.quantityReceived;
                        landedValue += itemLandingShare;

                        // Create inventory transaction audit trail
                        const transaction: any = {
                            id: generateId('TXN'),
                            itemId: item.itemId,
                            type: 'IN',
                            quantity: item.quantityReceived,
                            previousQuantity: oldStock,
                            newQuantity: newStock,
                            unitCost: lineUnitCost,
                            totalCost: lineUnitCost * item.quantityReceived,
                            landedCostPerUnit: landedCostPerUnit || 0,
                            landedCostTotal: (landedCostPerUnit || 0) * item.quantityReceived,
                            effectiveUnitCost,
                            reference: 'GRN',
                            referenceId: grn.id,
                            reason: `Goods Receipt from ${grn.supplierName || 'Supplier'}`,
                            performedBy: performedBy || 'System',
                            timestamp
                        };
                        await inventoryTransactionsStore.put(transaction);

                        // Create MaterialBatch record if batch/lot number provided
                        if (item.batchNumber) {
                            const batchRecord: any = {
                                id: `BATCH-${item.batchNumber}-${Date.now()}`,
                                itemId: item.itemId,
                                batchNumber: item.batchNumber,
                                quantity: item.quantityReceived,
                                remainingQuantity: item.quantityReceived,
                                costPerUnit: effectiveUnitCost,
                                purchaseCostPerUnit: lineUnitCost,
                                landedCostPerUnit: landedCostPerUnit || 0,
                                receivedDate: timestamp,
                                expiryDate: item.expiryDate || '',
                                supplierId: grn.supplierId || '',
                                supplierName: grn.supplierName || '',
                                warehouseId: item.warehouseId || 'WH-MAIN',
                                status: 'active',
                                costingMethod: invItem.costingMethod || 'weighted_average',
                                createdAt: timestamp
                            };
                            await materialBatchesStore.put(batchRecord);
                        }
                    }
                }

                // 2. Update Purchase Order status if linked
                let relatedPurchase: Purchase | null = null;
                let poAmount = 0;
                if (grn.purchaseOrderId) {
                    const po = await purchaseStore.get(grn.purchaseOrderId);
                    if (po) {
                        relatedPurchase = po;
                        poAmount = po.total || po.totalAmount || 0;

                        // Reverse the PO AP entry since we're now recording actual GRN.
                        // Must mirror approvePurchaseOrder's debit account: the
                        // eligible-items inventory account, else Purchases for
                        // non-stock procurements.
                        if (po.status === 'Approved') {
                            const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountFromItems(po.items || [], accounts) : null;
                            // Reverse PO AP entry
                            const poReversal: LedgerEntry = {
                                id: generateId('LG-GRN-POREV'),
                                date: grn.date,
                                description: `PO Reversal on GRN - ${po.id}`,
                                debitAccountId: resolveAcct(gl.accountsPayable),
                                creditAccountId: inventoryAccountId || resolveAcct(gl.purchasesAccount || '51100'),
                                amount: poAmount,
                                referenceId: grn.id,
                                reconciled: false,
                                supplierId: po.supplierId
                            };
                            await ledgerStore.put(poReversal);

                            // Adjust supplier balance (remove PO amount)
                            if (po.supplierId) {
                                const supplier = await supplierStore.get(po.supplierId);
                                if (supplier) {
                                    supplier.balance = (supplier.balance || 0) - poAmount;
                                    await supplierStore.put(supplier);
                                }
                            }
                        }

                        // Update PO status
                        po.status = 'Received';
                        if (!po.paymentStatus || po.paymentStatus === 'Cancelled' || po.paymentStatus === 'Approved') {
                            // Re-derive from amounts instead of blanket "Partial":
                            // a fully paid PO with an Approved payment status
                            // must land on Paid, not Partial.
                            po.paymentStatus = derivePurchasePaymentStatus({ ...po, paymentStatus: undefined });
                        }
                        // Append this verify's consumption events (immutable
                        // history driving remaining for later GRNs).
                        if (grnConsumptionEvents.length > 0) {
                            const existing = Array.isArray((po as any).landingConsumption)
                                ? (po as any).landingConsumption
                                : [];
                            (po as any).landingConsumption = [...existing, ...grnConsumptionEvents];
                        }
                        await purchaseStore.put(po);
                    }
                }

                // 3. Save GRN
                await grnStore.put(grn);

                // 4. Create Actual GRN Ledger Entries.
                // Canonical landing-cost model:
                //   goods value       → DR Inventory / CR goods-supplier AP
                //   capitalized landing → DR Inventory / CR landing-provider AP
                //     (one entry per landing provider, grouped by provider)
                // Non-stock (Product/Service) value → DR Purchases / CR AP so the
                // payable stays whole without capitalizing non-inventory.
                // The goods supplier is credited for goods (+ non-stock) ONLY;
                // landing providers are credited for their own lines.
                const goodsAmount = goodsValue;
                const grnGoodsTotal = goodsValue + nonStockValue;

                const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountFromItems(grn.items || [], accounts) : null;
                const apAccountId = resolveAcct(gl.accountsPayable);
                const goodsSupplierId = grn.supplierId || relatedPurchase?.supplierId;

                // Debit Inventory, Credit goods-supplier AP (goods only)
                const inventoryEntry: LedgerEntry = {
                    id: generateId('LG-GRN-INV'),
                    date: grn.date,
                    description: `Goods Receipt #${grn.id}${relatedPurchase ? ` (PO: ${relatedPurchase.id})` : ''}`,
                    debitAccountId: inventoryAccountId || resolveAcct(gl.purchasesAccount || '51100'),
                    creditAccountId: apAccountId,
                    amount: goodsAmount,
                    referenceId: grn.id,
                    reconciled: false,
                    supplierId: goodsSupplierId
                };
                await ledgerStore.put(inventoryEntry);

                // Debit Inventory, Credit landing-provider AP (capitalized landing).
                // Only unbilled lines post here: lines already settled by a
                // landing-cost bill keep their WAC allocation above (carrying
                // cost) while their journals come from the bill — never both.
                // Groups were built and validated pre-mutation above: one entry
                // per (provider, inventory account) pair, credits per provider
                // summing to that provider's unbilled total exactly.
                if (landedValue > 0.005 && landingAllocation) {
                    for (const group of landingJournalGroups) {
                        const accountCode = accounts.find((a: any) => a.id === group.account)?.code || group.account;
                        const providerName = group.provider?.name || group.providerId;
                        const landingEntry: LedgerEntry = {
                            id: generateId('LG-GRN-LC'),
                            date: grn.date,
                            description: `Landing cost capitalization - GRN #${grn.id}${relatedPurchase ? ` (PO: ${relatedPurchase.id})` : ''} - ${providerName} -> ${accountCode}: ${group.detail.join('; ')}`,
                            debitAccountId: group.account,
                            creditAccountId: apAccountId,
                            amount: group.amount,
                            referenceId: grn.id,
                            reconciled: false,
                            supplierId: group.providerId,
                            landingCostIds: group.lineIds,
                            landingProviderId: group.providerId,
                        };
                        await ledgerStore.put(landingEntry);
                        // Backfill the journal id onto this GRN's consumption
                        // events so each event traces to its exact postings.
                        for (const lid of group.lineIds) {
                            const ev = grnConsumptionEvents.find((e) => e.landingCostId === lid);
                            if (ev && !ev.journalIds.includes(landingEntry.id)) {
                                ev.journalIds.push(landingEntry.id);
                            }
                        }

                        // Provider subledger: the landing obligation belongs to
                        // the actual provider, never the goods supplier.
                        group.provider.balance = (group.provider.balance || 0) + group.amount;
                        await supplierStore.put(group.provider);
                    }
                    // Recoverable VAT legs (unbilled lines only; billed lines
                    // recovered at bill time): DR input-VAT position / CR
                    // provider AP, mirroring vatService input-VAT conventions
                    // (entryType VAT_INPUT + VatTransaction row). Never
                    // inventory. Provider balance grows by the VAT so the full
                    // gross obligation stays whole. The VAT account resolves
                    // only when VAT actually posts (fail-closed then).
                    const vatTakes = capitalizableLanding
                        .filter((c: any) => !billedLandingLineIds.has(String(c.id)))
                        .map((c: any) => ({ id: String(c.id), take: vatTakeByLine.get(String(c.id)) || 0 }))
                        .filter((t) => t.take > 0);
                    const vatInAccount = vatTakes.length > 0 ? resolveAcct(gl.vatPayableAccount || '21210') : null;
                    let postedVatTotal = 0;
                    for (const { id, take } of vatTakes) {
                        const cost = capitalizableLanding.find((c: any) => String(c.id) === id);
                        const providerId = String(cost.providerId || '').trim();
                        const provider = landingProviderRecords.get(providerId);
                        const split = taxSplitByLine.get(id)!;
                        const vatEntry: LedgerEntry = {
                            id: generateId('LG-GRN-VAT'),
                            date: grn.date,
                            description: `Landing input VAT - GRN #${grn.id}${relatedPurchase ? ` (PO: ${relatedPurchase.id})` : ''} - ${provider?.name || providerId}: ${(cost as any).category || 'Cost'} K${take.toFixed(2)} at ${split.rate}% (${id})`,
                            debitAccountId: vatInAccount,
                            creditAccountId: apAccountId,
                            amount: take,
                            entryType: 'VAT_INPUT',
                            referenceId: grn.id,
                            reconciled: false,
                            supplierId: providerId,
                            landingCostIds: [id],
                            landingProviderId: providerId,
                        };
                        validateLedgerBalance([vatEntry as any], `Landing input VAT ${grn.id}:${id}`);
                        await ledgerStore.put(vatEntry);
                        const vatTx: VatTransaction = {
                            id: generateId('VAT_IN'),
                            date: grn.date,
                            type: 'Input',
                            amount: take,
                            rate: split.rate,
                            vatAmount: take,
                            reference: grn.id,
                            description: `Recoverable VAT on landing cost line ${id} (GRN ${grn.id})`,
                            isFiled: false,
                            glEntryId: vatEntry.id,
                            landingCostIds: [id],
                            created_at: new Date().toISOString(),
                        };
                        await tx.objectStore('vatTransactions').put(vatTx);
                        const ev = grnConsumptionEvents.find((e) => e.landingCostId === id);
                        if (ev) {
                            ev.taxAmount = (ev.taxAmount || 0) + take;
                            if (!ev.journalIds.includes(vatEntry.id)) {
                                ev.journalIds.push(vatEntry.id);
                            }
                        }
                        if (provider) {
                            provider.balance = (provider.balance || 0) + take;
                            await supplierStore.put(provider);
                        }
                        postedVatTotal += take;
                    }
                    const expectedVatTotal = [...vatTakeByLine.entries()]
                        .filter(([id]) => !billedLandingLineIds.has(id))
                        .reduce((s, [, v]) => s + v, 0);
                    if (Math.abs(postedVatTotal - expectedVatTotal) > 0.005) {
                        throw new Error(
                            `Landing VAT posting mismatch on GRN ${grn.id}: posted K${postedVatTotal.toFixed(2)} vs computed K${expectedVatTotal.toFixed(2)}.`
                        );
                    }
                }

                if (nonStockValue > 0.005) {
                    const nonStockEntry: LedgerEntry = {
                        id: generateId('LG-GRN-EXP'),
                        date: grn.date,
                        description: `Goods Receipt (non-stock) #${grn.id}${relatedPurchase ? ` (PO: ${relatedPurchase.id})` : ''}`,
                        debitAccountId: resolveAcct(gl.purchasesAccount || '51100'),
                        creditAccountId: apAccountId,
                        amount: nonStockValue,
                        referenceId: grn.id,
                        reconciled: false,
                        supplierId: goodsSupplierId
                    };
                    await ledgerStore.put(nonStockEntry);
                }

                // 5. Update goods-supplier balance with the goods (+ non-stock)
                // obligation only. Landing obligations were credited to each
                // landing provider above.
                if (goodsSupplierId) {
                    const supplier = await supplierStore.get(goodsSupplierId);
                    if (supplier) {
                        supplier.balance = (supplier.balance || 0) + grnGoodsTotal;
                        await supplierStore.put(supplier);
                    }
                }

                // 6. Handle variance if GRN goods amount differs from PO amount.
                // Goods-only comparison: capitalized landing is posted by the
                // landing entries above and must NOT flow into Purchases here.
                if (relatedPurchase && Math.abs(grnGoodsTotal - poAmount) > 0.01) {
                    const variance = grnGoodsTotal - poAmount;
                    // Variance accounting (proper): the difference between PO commitment and actual
                    // GRN goods value goes to a Purchase Price Variance account (Purchases = 51100),
                    // NOT to COGS. COGS is for goods already sold.
                    // - variance > 0 (GRN goods more than PO, e.g. price increase): Debit Purchases, Credit AP
                    // - variance < 0 (GRN goods less than PO, e.g. discount/shortage): Debit AP, Credit Purchases
                    const purchasesAccountId = resolveAcct(gl.purchasesAccount || '51100');
                    const varianceEntry: LedgerEntry = {
                        id: generateId('LG-GRN-VAR'),
                        date: grn.date,
                        description: `GRN Variance - ${grn.id} (Actual goods: ${grnGoodsTotal.toFixed(2)} vs PO: ${poAmount.toFixed(2)})`,
                        debitAccountId: variance > 0 ? purchasesAccountId : apAccountId,
                        creditAccountId: variance > 0 ? apAccountId : purchasesAccountId,
                        amount: Math.abs(variance),
                        referenceId: grn.id,
                        reconciled: false,
                        supplierId: goodsSupplierId
                    };
                    await ledgerStore.put(varianceEntry);

                    // Adjust supplier balance to reflect the variance vs AP ledger
                    if (goodsSupplierId) {
                        const supplier = await supplierStore.get(goodsSupplierId);
                        if (supplier) {
                            // variance > 0 means supplier balance is short vs what we recorded as AP
                            // (we credited AP by full GRN goods amount, so supplier balance should match)
                            // No further adjustment needed - the AP ledger and supplier balance both
                            // use the goods amount, so they remain in sync. The variance entry uses the
                            // purchases account, NOT AP, so AP is unchanged from the goods amount.
                        }
                    }
                }

                return { success: true, poReversed: !!relatedPurchase, variance: relatedPurchase ? grnGoodsTotal - poAmount : 0, grnConsumptionEvents };
            }
        );
    },

    /**
     * Post a Landing Cost bill as a proper AP transaction (purchase-invoice
     * primitive), NOT an ordinary operating expense.
     *
     * Canonical posting per capitalized landing line:
     *   DR applicable inventory account
     *   CR landing-provider AP (provider subledger + balance)
     *
     * Mutual exclusion with GRN capitalization is enforced at this financial
     * boundary in both directions:
     *   - a line already billed here cannot be billed again (bill record +
     *     idempotency key on the landing-line id);
     *   - a line already capitalized by GRN verify (LG-GRN-LC carrying its id)
     *     is rejected: bill first, GRN skips billed lines — never both.
     * GRN capitalization (processGoodsReceipt) skips billed lines' journals
     * while still allocating their amounts into WAC, so the bill's inventory
     * debit and the GRN's carrying cost agree instead of double-posting.
     */
    async postLandingCostBill(input: { purchaseOrderId: string; landingCostId: string; invoiceNumber?: string; billDate?: string; dueDate?: string; performedBy?: string }) {
        // Serialize same-line billing within this tab (same convention as
        // the GRN landing lock above): two concurrent bills for one
        // LandingCostItem.id must converge, never double-post.
        const lockKey = `landing-bill:${input.purchaseOrderId}:${input.landingCostId}`;
        const previous = landingConsumptionLocks.get(lockKey) || Promise.resolve();
        let releaseLock!: () => void;
        const current = new Promise<void>((resolve) => { releaseLock = resolve; });
        landingConsumptionLocks.set(lockKey, current);
        try {
            await previous.catch(() => {});
            return await this.postLandingCostBillTx(input);
        } finally {
            if (landingConsumptionLocks.get(lockKey) === current) {
                landingConsumptionLocks.delete(lockKey);
            }
            releaseLock();
        }
    },

    async postLandingCostBillTx(input: { purchaseOrderId: string; landingCostId: string; invoiceNumber?: string; billDate?: string; dueDate?: string; performedBy?: string }) {
        return dbService.executeAtomicOperation(
            ['purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'idempotencyKeys', 'accounts', 'inventory', 'vatTransactions'],
            async (tx) => {
                const purchaseStore = tx.objectStore('purchases');
                const invoiceStore = tx.objectStore('purchaseInvoices');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');
                const inventoryStore = tx.objectStore('inventory');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const gl = getGLConfig();

                // 0. Resolve the authoritative landing line from the PO (single source).
                const purchase = await purchaseStore.get(input.purchaseOrderId);
                if (!purchase) {
                    throw new Error(`Purchase order ${input.purchaseOrderId} not found; cannot bill landing cost line ${input.landingCostId}.`);
                }
                const line = ((purchase as any).landingCosts || []).find((c: any) => String(c?.id) === String(input.landingCostId));
                if (!line) {
                    throw new Error(`Landing cost line ${input.landingCostId} not found on PO ${input.purchaseOrderId}. Commit landing costs to the order first.`);
                }
                const amount = Number(line.amount) || 0;
                if (amount < -0.005) {
                    throw new Error(
                        `Landing cost line ${input.landingCostId} is negative (K${amount.toFixed(2)}). ` +
                        `Negative landing costs post only as controlled corrections linked to the original line — failing closed.`
                    );
                }
                if (!(amount > 0)) {
                    throw new Error(`Landing cost line ${input.landingCostId} has no positive amount to bill.`);
                }
                // Tax split (pure, deterministic): RECOVERABLE_VAT diverts its
                // portion to input-VAT posting (never inventory); WITHHOLDING
                // and unrated recoverable lines throw here. Capitalization,
                // allocation and the bill journals below operate on the
                // capitalizable portion; the provider obligation stays gross.
                const billTax = splitLandingLineTax(line);
                const billCapAmount = billTax.capitalizable;

                // 1. Provider validation BEFORE any mutation or reservation.
                const providerId = String(line.providerId || '').trim();
                if (!providerId) {
                    throw new Error(
                        `Landing cost "${line.category || 'Uncategorized'}" (K${amount.toFixed(2)}, line ${line.id}) has no provider. ` +
                        `Select the actual carrier/customs broker/supplier before posting it as a bill.`
                    );
                }
                const provider = await supplierStore.get(providerId);
                if (!provider) {
                    throw new Error(
                        `Landing cost "${line.category || 'Uncategorized'}" (K${amount.toFixed(2)}, line ${line.id}) ` +
                        `names unknown provider "${providerId}". Register the provider as a supplier first.`
                    );
                }

                // 2. Already billed? A landing line settles exactly one ACTIVE
                // bill. Cancelled (reversed) bills settle nothing and do not
                // block a corrected re-bill.
                const existingInvoices = await invoiceStore.getAll();
                const priorBill = existingInvoices.find((inv: any) => inv
                    && String((inv as any).landingCostId || '') === String(line.id)
                    && (inv as any).status !== 'cancelled');
                if (priorBill) {
                    throw new Error(`Landing cost line ${line.id} was already billed as ${priorBill.id}. A landing line cannot be billed twice.`);
                }

                // 3. Already GRN-capitalized? Unreversed GRN journals for this
                // line mean the obligation already exists — billing again
                // would manufacture a second obligation. Journals unwound by
                // a mirror (reversesEntryId), and the mirrors themselves,
                // establish nothing.
                const ledgerRows = await ledgerStore.getAll();
                const reversedIds = new Set(
                    ledgerRows
                        .filter((e: any) => e && (e as any).reversesEntryId)
                        .map((e: any) => String((e as any).reversesEntryId))
                );
                const isMirrorRow = (e: any) =>
                    /REVERSAL|CORRECTION/.test(String((e as any)?.entryType || '')) ||
                    String(e?.id || '').includes('-REV') ||
                    String(e?.id || '').startsWith('LG-GRN-LCR-') ||
                    (e as any).reversesEntryId;
                const capitalized = ledgerRows.find((e: any) =>
                    Array.isArray((e as any).landingCostIds) && (e as any).landingCostIds.map(String).includes(String(line.id))
                    && !reversedIds.has(String((e as any).id))
                    && !isMirrorRow(e));
                if (capitalized) {
                    throw new Error(
                        `Landing cost line ${line.id} was already capitalized by ${capitalized.id} (GRN ${capitalized.referenceId || 'unknown'}). ` +
                        `Post the bill before verifying the GRN, not after.`
                    );
                }

                // 4. Inventory debit distribution (fail-closed: no
                // Purchases/expense fallback — that is exactly the treatment
                // being eliminated). The line amount is allocated across the
                // PO's stock-bearing lines with the PO's persisted method
                // (default VALUE), and one bill journal posts per inventory
                // account so multi-account POs distribute correctly.
                const rawBillMethod = (purchase as any).landingAllocationMethod ?? 'VALUE';
                const billMethod = normalizeLandingAllocationMethod(rawBillMethod);
                if (!billMethod) {
                    throw new Error(
                        `PO ${purchase.id} names unsupported landing-cost allocation method "${String(rawBillMethod)}". ` +
                        `Supported methods: VALUE, QUANTITY.`
                    );
                }
                const poSnapshotItems = ((purchase as any).items || []) as any[];
                const poInvRecords: any[] = [];
                for (const poLine of poSnapshotItems) {
                    poInvRecords.push(await inventoryStore.get(poLine.itemId));
                }
                const billAllocation = allocateLandingCosts({
                    receiptLines: poSnapshotItems.map((poLine: any) => ({
                        itemId: String(poLine.itemId || ''),
                        quantityReceived: Number(poLine.quantity ?? poLine.quantityReceived ?? 0) || 0,
                        unitCost: resolveReceiptUnitCost(poLine),
                    })),
                    isEligible: (lineIndex: number) => {
                        const rec = poInvRecords[lineIndex];
                        return !!rec && isInventoryBearingItem(rec);
                    },
                    landingLines: [{ id: String(line.id), amount: billCapAmount }],
                    method: billMethod,
                    resolveAccount: (lineIndex: number) => {
                        const rec = poInvRecords[lineIndex];
                        const poLine = poSnapshotItems[lineIndex];
                        if (!rec || !isInventoryBearingItem(rec)) return null;
                        const merged = {
                            ...(poLine as any),
                            type: (rec as any).type ?? (poLine as any).type,
                            inventoryRole: (rec as any).inventoryRole ?? (poLine as any).inventoryRole,
                        };
                        return resolveInventoryAccountFromItems([merged], accounts);
                    },
                });
                const apAccountId = resolveAcct(gl.accountsPayable);

                await reserveIdempotencyKey(tx, 'landing_cost_bill', String(line.id));

                const billId = generateId('LCB');
                const billDate = input.billDate || new Date().toISOString();
                const now = new Date().toISOString();
                // One entry per inventory account; credits sum to the line
                // amount exactly (engine exactness invariant).
                const billGroups = new Map<string, { amount: number }>();
                for (const share of billAllocation.shares) {
                    if (!(share.amount > 0)) {
                        continue;
                    }
                    if (!share.inventoryAccount) {
                        throw new Error(
                            `Cannot resolve an inventory account for landing bill line ${line.id} (item ${share.itemId}). ` +
                            `Failing closed before financial mutation.`
                        );
                    }
                    const grouped = billGroups.get(share.inventoryAccount) || { amount: 0 };
                    grouped.amount += share.amount;
                    billGroups.set(share.inventoryAccount, grouped);
                }
                const billedTotal = [...billGroups.values()].reduce((s, g) => s + g.amount, 0);
                if (Math.abs(billedTotal - billCapAmount) > 0.005) {
                    throw new Error(
                        `Landing bill distribution mismatch for line ${line.id}: distributed K${billedTotal.toFixed(2)} vs capitalizable K${billCapAmount.toFixed(2)}. ` +
                        `Failing closed before financial mutation.`
                    );
                }
                const billEntryIds: string[] = [];
                for (const [accountId, group] of billGroups) {
                    const accountCode = accounts.find((a: any) => a.id === accountId)?.code || accountId;
                    const entry: LedgerEntry = {
                        id: generateId('LG-LCB'),
                        date: billDate,
                        description: `Landing cost bill - PO #${purchase.id} - ${provider?.name || providerId} -> ${accountCode}: ${(line.category || 'Cost')} K${amount.toFixed(2)} (${line.id})`,
                        debitAccountId: accountId,
                        creditAccountId: apAccountId,
                        amount: group.amount,
                        entryType: 'LANDING_COST_BILL',
                        referenceId: billId,
                        reconciled: false,
                        supplierId: providerId,
                        landingCostIds: [line.id],
                        landingProviderId: providerId,
                    };
                    validateLedgerBalance([entry as any], `Landing cost bill ${billId}`);
                    await ledgerStore.put(entry);
                    billEntryIds.push(entry.id);
                }

                const invoice: PurchaseInvoice = {
                    id: billId,
                    supplier_id: providerId,
                    invoice_number: input.invoiceNumber || billId,
                    invoice_date: billDate,
                    due_date: input.dueDate || billDate,
                    purchase_order_id: purchase.id,
                    status: 'pending',
                    subtotal: billCapAmount,
                    tax_amount: billTax.recoverableVAT,
                    freight_amount: 0,
                    discount_amount: 0,
                    total_amount: amount,
                    paid_amount: 0,
                    notes: `Capitalized landing cost "${line.category || 'Cost'}" (${line.description || 'no description'}) for PO #${purchase.id}; settles landing line ${line.id}. Posts to inventory, not expense.${billTax.recoverableVAT > 0 ? ` Includes recoverable VAT K${billTax.recoverableVAT.toFixed(2)} at ${billTax.rate}%.` : ''}`,
                    landingCostId: String(line.id),
                    landingProviderId: providerId,
                    created_at: now,
                    updated_at: now,
                };
                await invoiceStore.put(invoice);

                // Recoverable VAT (never inventory): DR input-VAT position /
                // CR provider AP, mirroring vatService input-VAT conventions
                // (entryType VAT_INPUT + VatTransaction row), plus provider
                // balance, so the full gross obligation stays whole.
                if (billTax.recoverableVAT > 0) {
                    const vatInAccount = resolveAcct(gl.vatPayableAccount || '21210');
                    const vatEntry: LedgerEntry = {
                        id: generateId('LG-LCB-VAT'),
                        date: billDate,
                        description: `Landing input VAT - bill ${billId} - PO #${purchase.id} - ${provider?.name || providerId}: ${(line.category || 'Cost')} K${billTax.recoverableVAT.toFixed(2)} at ${billTax.rate}% (${line.id})`,
                        debitAccountId: vatInAccount,
                        creditAccountId: apAccountId,
                        amount: billTax.recoverableVAT,
                        entryType: 'VAT_INPUT',
                        referenceId: billId,
                        reconciled: false,
                        supplierId: providerId,
                        landingCostIds: [line.id],
                        landingProviderId: providerId,
                    };
                    validateLedgerBalance([vatEntry as any], `Landing input VAT ${billId}`);
                    await ledgerStore.put(vatEntry);
                    billEntryIds.push(vatEntry.id);
                    const vatTx: VatTransaction = {
                        id: generateId('VAT_IN'),
                        date: billDate,
                        type: 'Input',
                        amount: billTax.recoverableVAT,
                        rate: billTax.rate,
                        vatAmount: billTax.recoverableVAT,
                        reference: billId,
                        description: `Recoverable VAT on landing cost bill ${billId} (line ${line.id})`,
                        isFiled: false,
                        glEntryId: vatEntry.id,
                        landingCostIds: [line.id],
                        created_at: now,
                    };
                    await tx.objectStore('vatTransactions').put(vatTx);
                }

                // Durable BILL consumption marker on the PO: establishes the
                // AP/debit side and freezes this line + the PO method against
                // silent edits. It does NOT reduce WAC-embedding remaining —
                // GRNs still allocate the line's capitalizable amount into
                // carrying cost while posting no new journals for it.
                {
                    const existing = Array.isArray((purchase as any).landingConsumption)
                        ? (purchase as any).landingConsumption
                        : [];
                    (purchase as any).landingConsumption = [
                        ...existing,
                        {
                            id: generateId('LCC'),
                            landingCostId: String(line.id),
                            kind: 'BILL',
                            billId,
                            grnId: null,
                            amount: billCapAmount,
                            sourceAmount: billCapAmount,
                            method: billMethod,
                            providerId,
                            accountSplits: [...billGroups.entries()].map(([account, group]) => ({ account, amount: group.amount })),
                            journalIds: [...billEntryIds],
                            at: now,
                            taxTreatment: billTax.treatment,
                            taxAmount: billTax.recoverableVAT,
                        },
                    ];
                    await purchaseStore.put(purchase);
                }

                provider.balance = (provider.balance || 0) + amount;
                await supplierStore.put(provider);

                return { success: true, billId, ledgerEntryIds: billEntryIds };
            }
        );
    },

    /**
     * Reverse an un-consumed landing-cost bill (controlled reversal).
     * Allowed ONLY when the billed line has no GRN consumption events:
     * once a GRN has embedded the line into WAC, unwinding requires the
     * GRN-consumption correction path below, never a silent bill edit.
     *
     * Mirror legs (per bill account split + VAT leg), provider balance down,
     * invoice → cancelled, REVERSAL event appended, bill idempotency key
     * cleared so a corrected re-bill may proceed. Never deletes history.
     */
    async reverseLandingCostBill(input: { purchaseOrderId: string; landingCostId: string; billId?: string; reason?: string }) {
        return dbService.executeAtomicOperation(
            ['purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'idempotencyKeys', 'accounts', 'vatTransactions'],
            async (tx) => {
                const purchaseStore = tx.objectStore('purchases');
                const invoiceStore = tx.objectStore('purchaseInvoices');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');
                const vatStore = tx.objectStore('vatTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };
                const gl = getGLConfig();
                const apAccountId = resolveAcct(gl.accountsPayable);
                const now = new Date().toISOString();

                const purchase = await purchaseStore.get(input.purchaseOrderId);
                if (!purchase) {
                    throw new Error(`Purchase order ${input.purchaseOrderId} not found; cannot reverse landing bill.`);
                }
                const line = ((purchase as any).landingCosts || []).find((c: any) => String(c?.id) === String(input.landingCostId));
                if (!line) {
                    throw new Error(`Landing cost line ${input.landingCostId} not found on PO ${input.purchaseOrderId}.`);
                }
                const bill = (await invoiceStore.getAll()).find(
                    (inv: any) => inv
                        && String((inv as any).landingCostId || '') === String(line.id)
                        && (!input.billId || String(inv.id) === String(input.billId))
                        && (inv as any).status !== 'cancelled'
                );
                if (!bill) {
                    throw new Error(`No active landing bill found for line ${line.id} on PO ${input.purchaseOrderId}.`);
                }
                // Guard: net GRN consumption (GRN events plus signed
                // CORRECTION events) must be zero. A fully corrected-away
                // consumption restores bill reversibility; anything still
                // embedded needs the restatement path, not a bill reversal.
                const events = (((purchase as any).landingConsumption || []) as any[]).filter(
                    (e: any) => String(e?.landingCostId) === String(line.id)
                );
                const netGrnConsumed = events
                    .filter((e: any) => e?.kind === 'GRN' || e?.kind === 'CORRECTION')
                    .reduce((s: number, e: any) => s + (Number(e?.amount) || 0), 0);
                if (netGrnConsumed > 0.005) {
                    throw new Error(
                        `Landing cost line ${line.id} still has K${netGrnConsumed.toFixed(2)} of GRN-embedded consumption; ` +
                        `a bill reversal alone would strand carrying cost. ` +
                        `Use the controlled GRN-consumption correction instead — failing closed.`
                    );
                }
                const billEvent = events.find((e: any) => e?.kind === 'BILL' && String(e?.billId || '') === String(bill.id));

                await reserveIdempotencyKey(tx, 'landing_bill_reversal', String(bill.id));

                // Mirror every bill journal (inventory splits + VAT leg).
                const originals = (await ledgerStore.getAll()).filter(
                    (e: any) => String(e?.referenceId || '') === String(bill.id)
                        && (String(e?.id || '').startsWith('LG-LCB'))
                );
                if (originals.length === 0) {
                    throw new Error(`Bill ${bill.id} has no posted journals to reverse.`);
                }
                const reversalIds: string[] = [];
                let reversedTotal = 0;
                for (const orig of originals) {
                    const isVatLeg = String(orig.id || '').includes('-VAT');
                    const rev: LedgerEntry = {
                        id: generateId(isVatLeg ? 'LG-LCB-VAT-REV' : 'LG-LCB-REV'),
                        date: now,
                        description: `REVERSAL: ${(orig as any).description || `landing bill ${bill.id}`} — ${input.reason || 'controlled bill reversal'}`,
                        debitAccountId: (orig as any).creditAccountId,
                        creditAccountId: (orig as any).debitAccountId,
                        amount: Number((orig as any).amount) || 0,
                        entryType: 'LANDING_BILL_REVERSAL',
                        referenceId: String(bill.id),
                        reconciled: false,
                        supplierId: (orig as any).supplierId,
                        landingCostIds: [line.id],
                        landingProviderId: (orig as any).landingProviderId,
                        reversesEntryId: (orig as any).id,
                    };
                    validateLedgerBalance([rev as any], `Landing bill reversal ${bill.id}`);
                    await ledgerStore.put(rev);
                    reversalIds.push(rev.id);
                    reversedTotal += rev.amount;
                    if (isVatLeg) {
                        const vatTx: VatTransaction = {
                            id: generateId('VAT_IN-REV'),
                            date: now,
                            type: 'Input',
                            amount: -rev.amount,
                            rate: Number((billEvent as any)?.taxRate ?? 0),
                            vatAmount: -rev.amount,
                            reference: String(bill.id),
                            description: `REVERSAL of recoverable VAT on landing bill ${bill.id} (line ${line.id})`,
                            isFiled: false,
                            glEntryId: rev.id,
                            landingCostIds: [line.id],
                            reversalOf: (orig as any).glEntryId || orig.id,
                            created_at: now,
                        };
                        await vatStore.put(vatTx);
                    }
                }

                const provider = await supplierStore.get(String((bill as any).supplier_id));
                if (provider) {
                    provider.balance = (provider.balance || 0) - reversedTotal;
                    await supplierStore.put(provider);
                }
                bill.status = 'cancelled';
                bill.updated_at = now;
                await invoiceStore.put(bill);

                // REVERSAL marker (audit; AP/debit unwound above). The VAT
                // take-back restores the line's VAT remainder for future GRNs.
                {
                    const existing = Array.isArray((purchase as any).landingConsumption)
                        ? (purchase as any).landingConsumption
                        : [];
                    const vatTakenBack = originals
                        .filter((o: any) => String(o.id || '').includes('-VAT'))
                        .reduce((s: number, o: any) => s + (Number(o.amount) || 0), 0);
                    (purchase as any).landingConsumption = [
                        ...existing,
                        {
                            id: generateId('LCC'),
                            landingCostId: String(line.id),
                            kind: 'REVERSAL',
                            billId: String(bill.id),
                            grnId: null,
                            amount: 0,
                            sourceAmount: Number(line.amount) || 0,
                            method: (billEvent as any)?.method || (purchase as any).landingAllocationMethod || 'VALUE',
                            providerId: String((bill as any).supplier_id || ''),
                            accountSplits: [],
                            journalIds: [...reversalIds],
                            at: now,
                            reversesEventId: (billEvent as any)?.id || null,
                            taxTreatment: (billEvent as any)?.taxTreatment || null,
                            taxAmount: vatTakenBack > 0 ? -vatTakenBack : 0,
                        },
                    ];
                    await purchaseStore.put(purchase);
                }
                // Allow a corrected re-bill: the consumed line key is freed now
                // that every journal it guarded has a mirror.
                await clearIdempotencyKey(tx, 'landing_cost_bill', String(line.id));

                return { success: true, billId: String(bill.id), reversalIds };
            }
        );
    },

    /**
     * Controlled correction of GRN-consumed landing cost (pristine inventory
     * only). Reverses one landing line's capitalization from one GRN:
     * mirror AP/inventory journals, provider balance down, WAC value down
     * (quantity untouched), matched untouched batches restored to purchase
     * cost, corrective audit rows appended — history never edited.
     *
     * Fails closed when: a bill exists for the line (mixed state needs manual
     * review), any OUT movement post-dates the GRN, current stock no longer
     * covers the received quantity, or batches are missing/partially consumed.
     * Sold/moved inventory can never be silently restated.
     */
    async correctLandingConsumption(input: { purchaseOrderId: string; landingCostId: string; grnId: string; reason?: string; performedBy?: string }) {
        const result = await dbService.executeAtomicOperation(
            ['goodsReceipts', 'purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'inventory', 'inventoryTransactions', 'materialBatches', 'idempotencyKeys', 'accounts', 'vatTransactions'],
            async (tx) => {
                const grnStore = tx.objectStore('goodsReceipts');
                const purchaseStore = tx.objectStore('purchases');
                const invoiceStore = tx.objectStore('purchaseInvoices');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');
                const inventoryStore = tx.objectStore('inventory');
                const invTxnStore = tx.objectStore('inventoryTransactions');
                const batchStore = tx.objectStore('materialBatches');
                const vatStore = tx.objectStore('vatTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };
                const gl = getGLConfig();
                const apAccountId = resolveAcct(gl.accountsPayable);
                const vatInAccount = resolveAcct(gl.vatPayableAccount || '21210');
                const now = new Date().toISOString();
                const lineId = String(input.landingCostId);

                const purchase = await purchaseStore.get(input.purchaseOrderId);
                if (!purchase) {
                    throw new Error(`Purchase order ${input.purchaseOrderId} not found; cannot correct landing consumption.`);
                }
                const grn = await grnStore.get(input.grnId);
                if (!grn) {
                    throw new Error(`GRN ${input.grnId} not found; cannot correct landing consumption.`);
                }
                // Mixed bill+GRN state needs manual review, never automation:
                // an active bill alongside GRN consumption cannot be unwound
                // one side at a time without orphaning the other side's
                // accounting. (Cancelled bills are fully unwound already.)
                const billForLine = (await invoiceStore.getAll()).find(
                    (inv: any) => inv && String((inv as any).landingCostId || '') === lineId && (inv as any).status !== 'cancelled'
                );
                if (billForLine) {
                    throw new Error(
                        `Landing cost line ${lineId} has an active bill (${billForLine.id}) alongside GRN consumption. ` +
                        `Mixed bill/capitalization states require manual review — failing closed.`
                    );
                }
                const grnEvent = (((purchase as any).landingConsumption || []) as any[]).find(
                    (e: any) => e?.kind === 'GRN' && String(e?.landingCostId) === lineId && String(e?.grnId || '') === String(input.grnId)
                );
                if (!grnEvent || !((Number(grnEvent.amount) || 0) > 0)) {
                    throw new Error(`No GRN consumption of line ${lineId} by GRN ${input.grnId} exists to correct.`);
                }
                // Convergent retry: the same (line, GRN) correction requested
                // twice must not post twice. Guards below validate live state
                // and would trip on already-corrected data, so check the
                // durable marker first.
                const priorCorrection = (((purchase as any).landingConsumption || []) as any[]).find(
                    (e: any) => e?.kind === 'CORRECTION' && String(e?.landingCostId) === lineId
                        && String(e?.grnId || '') === String(input.grnId)
                        && String(e?.correctsEventId || '') === String((grnEvent as any).id || '')
                );
                if (priorCorrection) {
                    throw new Error(
                        `Landing consumption of line ${lineId} by GRN ${input.grnId} was already corrected ` +
                        `(${(priorCorrection as any).id}). Retry converges without another posting.`
                    );
                }
                const line = ((purchase as any).landingCosts || []).find((c: any) => String(c?.id) === lineId);
                const providerId = String(grnEvent.providerId || line?.providerId || '').trim();
                if (!providerId) {
                    throw new Error(`Cannot determine the provider for landing line ${lineId}; failing closed.`);
                }
                const provider = await supplierStore.get(providerId);
                if (!provider) {
                    throw new Error(`Landing provider "${providerId}" is not a known supplier; failing closed.`);
                }
                // Per-item landed shares from the GRN's persisted allocation
                // (durable snapshot — never recomputed from live prices).
                const shares = (((grn as any).landingAllocations || []) as any[]).filter(
                    (s: any) => String(s?.landingCostId) === lineId && (Number(s?.amount) || 0) > 0
                );
                if (shares.length === 0) {
                    throw new Error(`GRN ${input.grnId} holds no persisted allocation shares for line ${lineId}; cannot correct safely.`);
                }
                const perItem = new Map<string, { landedTotal: number; receivedQty: number; batchNumber?: string; effectiveUnitCost: number }>();
                for (const share of shares) {
                    const itemId = String(share.itemId || '');
                    const agg = perItem.get(itemId) || { landedTotal: 0, receivedQty: 0, effectiveUnitCost: 0 };
                    agg.landedTotal += Number(share.amount) || 0;
                    agg.receivedQty += Number(share.quantity) || 0;
                    perItem.set(itemId, agg);
                }
                // Pristine-inventory guards per affected item.
                const grnTs = String(((await invTxnStore.getAll()) as any[])
                    .find((t: any) => t && t.itemId && String(t.referenceId || '') === String(input.grnId) && t.type === 'IN')?.timestamp || '');
                for (const [itemId, agg] of perItem) {
                    const invItem = await inventoryStore.get(itemId);
                    if (!invItem) {
                        throw new Error(`Inventory item ${itemId} is missing; cannot correct safely.`);
                    }
                    if (!((Number(invItem.stock) || 0) >= agg.receivedQty && (Number(invItem.stock) || 0) > 0)) {
                        throw new Error(
                            `Item ${itemId} no longer holds the full received quantity (${agg.receivedQty}) on hand ` +
                            `(stock ${(Number(invItem.stock) || 0)}). Sold/moved inventory cannot be restated silently — failing closed.`
                        );
                    }
                    const laterOut = ((await invTxnStore.getAll()) as any[]).find(
                        (t: any) => t && String(t.itemId || '') === itemId && t.type === 'OUT'
                            && (!grnTs || String(t.timestamp || '') >= grnTs)
                    );
                    if (laterOut) {
                        throw new Error(
                            `Item ${itemId} has outbound movements at or after the GRN; historical COGS will not be rewritten — failing closed.`
                        );
                    }
                    const grnLine = ((grn as any).items || []).find((l: any) => String(l?.itemId || '') === itemId);
                    const inTxn = ((await invTxnStore.getAll()) as any[]).find(
                        (t: any) => t && String(t.itemId || '') === itemId && String(t.referenceId || '') === String(input.grnId) && t.type === 'IN'
                    );
                    const effective = Number(inTxn?.effectiveUnitCost);
                    if (grnLine?.batchNumber) {
                        const batch = ((await batchStore.getAll()) as any[]).find(
                            (b: any) => b && String(b.itemId || '') === itemId && String(b.batchNumber || '') === String(grnLine.batchNumber)
                        );
                        if (!batch || Number(batch.remainingQuantity) !== Number(batch.quantity) || Math.abs(Number(batch.costPerUnit) - effective) > 0.005) {
                            throw new Error(
                                `Batch ${grnLine.batchNumber} (${itemId}) is missing, partially consumed, or cost-drifted; ` +
                                `batch-tracked corrections need manual review — failing closed.`
                            );
                        }
                        agg.batchNumber = String(grnLine.batchNumber);
                        agg.effectiveUnitCost = effective;
                    } else {
                        const stray = ((await batchStore.getAll()) as any[]).find(
                            (b: any) => b && String(b.itemId || '') === itemId
                                && Math.abs(Number(b.costPerUnit) - effective) <= 0.005
                                && String(b.receivedDate || '').slice(0, 10) === String((grn as any).date || '').slice(0, 10)
                        );
                        if (stray) {
                            throw new Error(
                                `Item ${itemId} has a batch matching this GRN receipt that the GRN did not declare; ` +
                                `cannot attribute safely — failing closed.`
                            );
                        }
                        agg.effectiveUnitCost = effective;
                    }
                    if (!(agg.effectiveUnitCost > 0)) {
                        throw new Error(`Cannot determine the booked unit cost for item ${itemId} on GRN ${input.grnId}; failing closed.`);
                    }
                }

                await reserveIdempotencyKey(tx, 'landing_correction', `${input.grnId}:${lineId}`);

                // Mirror the original posting groups (from the event's durable
                // splits): DR provider AP / CR inventory, per account.
                // reversesEntryId links each mirror to its original so later
                // establishment checks treat reversed journals as unwound.
                const originalLcEntries = (await ledgerStore.getAll()).filter(
                    (e: any) => String(e?.id || '').startsWith('LG-GRN-LC')
                        && String(e?.referenceId || '') === String(input.grnId)
                        && Array.isArray((e as any).landingCostIds)
                        && ((e as any).landingCostIds as unknown[]).map(String).includes(lineId)
                );
                const mirrorIds: string[] = [];
                let mirroredTotal = 0;
                for (const split of ((grnEvent as any).accountSplits || [])) {
                    const splitAccount = resolveAcct(String(split.account));
                    const splitAmount = Number(split.amount) || 0;
                    if (!(splitAmount > 0)) {
                        continue;
                    }
                    const mirror: LedgerEntry = {
                        id: generateId('LG-GRN-LCR'),
                        date: now,
                        description: `CORRECTION: reverse landing capitalization - GRN #${input.grnId} - line ${lineId} -> ${split.account}: ${input.reason || 'controlled correction'}`,
                        debitAccountId: apAccountId,
                        creditAccountId: splitAccount,
                        amount: splitAmount,
                        entryType: 'LANDING_CORRECTION',
                        referenceId: String(input.grnId),
                        reconciled: false,
                        supplierId: providerId,
                        landingCostIds: [lineId],
                        landingProviderId: providerId,
                        reversesEntryId: originalLcEntries.find((o: any) => String((o as any).debitAccountId) === String(splitAccount))?.id || null,
                    };
                    validateLedgerBalance([mirror as any], `Landing correction ${input.grnId}:${lineId}`);
                    await ledgerStore.put(mirror);
                    mirrorIds.push(mirror.id);
                    mirroredTotal += splitAmount;
                }
                // Mirror the VAT legs this GRN posted for the line.
                let mirroredVat = 0;
                const vatLegs = (await ledgerStore.getAll()).filter(
                    (e: any) => String(e?.id || '').startsWith('LG-GRN-VAT')
                        && String(e?.referenceId || '') === String(input.grnId)
                        && Array.isArray((e as any).landingCostIds)
                        && ((e as any).landingCostIds as unknown[]).map(String).includes(lineId)
                );
                for (const leg of vatLegs) {
                    const mirror: LedgerEntry = {
                        id: generateId('LG-GRN-VAT-REV'),
                        date: now,
                        description: `CORRECTION: reverse landing input VAT - GRN #${input.grnId} - line ${lineId}: ${input.reason || 'controlled correction'}`,
                        debitAccountId: apAccountId,
                        creditAccountId: String((leg as any).debitAccountId),
                        amount: Number((leg as any).amount) || 0,
                        entryType: 'LANDING_CORRECTION',
                        referenceId: String(input.grnId),
                        reconciled: false,
                        supplierId: providerId,
                        landingCostIds: [lineId],
                        landingProviderId: providerId,
                    };
                    validateLedgerBalance([mirror as any], `Landing VAT correction ${input.grnId}:${lineId}`);
                    await ledgerStore.put(mirror);
                    mirrorIds.push(mirror.id);
                    mirroredVat += mirror.amount;
                    const vatTx: VatTransaction = {
                        id: generateId('VAT_IN-REV'),
                        date: now,
                        type: 'Input',
                        amount: -mirror.amount,
                        rate: 0,
                        vatAmount: -mirror.amount,
                        reference: String(input.grnId),
                        description: `REVERSAL of recoverable VAT on landing line ${lineId} (GRN ${input.grnId})`,
                        isFiled: false,
                        glEntryId: mirror.id,
                        landingCostIds: [lineId],
                        reversalOf: (leg as any).id,
                        created_at: now,
                    };
                    await vatStore.put(vatTx);
                }
                // WAC value down (quantity untouched), batches restored, audit
                // rows appended — history rows never edited.
                for (const [itemId, agg] of perItem) {
                    const invItem = await inventoryStore.get(itemId);
                    const currentTotal = (Number(invItem.stock) || 0) * (Number(invItem.cost) || 0);
                    const newTotal = currentTotal - agg.landedTotal;
                    if (newTotal < -0.005) {
                        throw new Error(`Correcting item ${itemId} would drive inventory value negative; failing closed.`);
                    }
                    const newCost = (Number(invItem.stock) || 0) > 0 ? newTotal / Number(invItem.stock) : 0;
                    Object.assign(invItem, costAliasValues(newCost));
                    await inventoryStore.put(invItem);
                    if (agg.batchNumber) {
                        const batch = ((await batchStore.getAll()) as any[]).find(
                            (b: any) => b && String(b.itemId || '') === itemId && String(b.batchNumber || '') === agg.batchNumber
                        );
                        const landedPerUnit = agg.receivedQty > 0 ? agg.landedTotal / agg.receivedQty : 0;
                        batch.costPerUnit = Math.max(0, Number(batch.costPerUnit) - landedPerUnit);
                        batch.landedCostPerUnit = 0;
                        await batchStore.put(batch);
                    }
                    await invTxnStore.put({
                        id: generateId('TXN'),
                        itemId,
                        type: 'CORRECTION',
                        quantity: 0,
                        previousQuantity: Number(invItem.stock) || 0,
                        newQuantity: Number(invItem.stock) || 0,
                        unitCost: 0,
                        totalCost: 0,
                        landedCostPerUnit: agg.receivedQty > 0 ? -(agg.landedTotal / agg.receivedQty) : 0,
                        landedCostTotal: -agg.landedTotal,
                        effectiveUnitCost: newCost,
                        reference: 'GRN_CORRECTION',
                        referenceId: String(input.grnId),
                        reason: `Controlled landing correction for line ${lineId}: ${input.reason || 'no reason given'}`,
                        performedBy: (input as any).performedBy || 'System',
                        timestamp: now,
                    });
                }
                if (provider) {
                    provider.balance = (provider.balance || 0) - mirroredTotal - mirroredVat;
                    await supplierStore.put(provider);
                }
                // CORRECTION event releases remaining (negative amount); the
                // original GRN event stays untouched for audit.
                // (Phase 7G: captured for the post-commit Transport hook below;
                // the persisted bytes are unchanged.)
                const committedCorrectionEvent = {
                    id: generateId('LCC'),
                    landingCostId: lineId,
                    kind: 'CORRECTION',
                    billId: null,
                    grnId: String(input.grnId),
                    amount: -mirroredTotal,
                    sourceAmount: Number(grnEvent.sourceAmount) || 0,
                    method: (grnEvent as any).method || 'VALUE',
                    providerId,
                    accountSplits: [],
                    journalIds: [...mirrorIds],
                    at: now,
                    correctsEventId: (grnEvent as any).id || null,
                    taxTreatment: (grnEvent as any).taxTreatment || null,
                    taxAmount: mirroredVat > 0 ? -mirroredVat : 0,
                };
                {
                    const existing = Array.isArray((purchase as any).landingConsumption)
                        ? (purchase as any).landingConsumption
                        : [];
                    (purchase as any).landingConsumption = [
                        ...existing,
                        committedCorrectionEvent,
                    ];
                    await purchaseStore.put(purchase);
                }

                return { success: true, mirrorIds, correctionEvent: committedCorrectionEvent };
            }
        );
        // Phase 7G: post-commit correction producer (fire-and-forget, same
        // pattern as the GRN inbound hook above). The Landing correction
        // already committed: a transport failure never fails the correction
        // and stays retryable through the deterministic economic key
        // (CONSUMPTION_CORRECTION:{transportInboundId}).
        import('./transportBudgetConsumptionCorrection').then(
            ({
                produceConsumptionCorrectionSafely,
                defaultConsumptionCorrectionDeps,
                fireConsumptionCorrectionHook,
            }) =>
                fireConsumptionCorrectionHook(
                    produceConsumptionCorrectionSafely(defaultConsumptionCorrectionDeps, {
                        correction: (result as any)?.correctionEvent || null,
                    }),
                    String((result as any)?.correctionEvent?.id || ''),
                ),
        ).catch(() => {
            // Module load failure must not affect the committed correction.
        });
        return result;
    },

    async adjustStock(params: { itemId: string, qtyChange: number, reason: string, warehouseId: string, notes?: string, variantId?: string, accountingReason?: StockAdjustmentReason, operationId?: string, idempotencyKey?: string }) {
        try {
            if (!Number.isFinite(params.qtyChange) || params.qtyChange === 0) {
                return { success: false, error: 'Stock adjustment quantity must be non-zero' };
            }
            const item = await dbService.get<any>('inventory', params.itemId);
            if (!item) return { success: false, error: 'Item not found' };

            // Authoritative eligibility: only Raw Material / Stationery
            // support stock operations. Product/Service adjustments are
            // rejected before any mutation or posting (fail-safe, no state
            // change) per the existing {success, error} convention.
            if (!isInventoryBearingItem(item)) {
                return { success: false, error: `Item "${item.name || params.itemId}" is type "${item.type || 'unknown'}" and does not support stock operations` };
            }

            let adjustmentCost = item.cost || 0;
            // Semantic accounting intent: explicit reason required. Legacy
            // callers that omit it are treated as OPERATIONAL_ADJUSTMENT
            // (COGS-based, never income). Opening balances must go through
            // openInventory() or pass accountingReason:'OPENING_BALANCE'.
            const accountingReason: StockAdjustmentReason =
                params.accountingReason || 'OPERATIONAL_ADJUSTMENT';

            return await dbService.executeAtomicOperation(
                ['inventory', 'ledger', 'warehouseInventory', 'inventoryTransactions', 'accounts', 'idempotencyKeys'],
                async (tx) => {
                    // Idempotency: retried bulk operations converge instead of
                    // duplicating journals. Explicit operationId wins; the
                    // idempotencyKey alias is accepted for API symmetry.
                    const operationScope = 'stock_adjustment';
                    const operationSource = String(params.operationId || params.idempotencyKey || '').trim();
                    if (operationSource) {
                        await reserveIdempotencyKey(tx, operationScope, operationSource, `${operationScope}:${operationSource}`);
                    }

                    const inventoryStore = tx.objectStore('inventory');
                    const ledgerStore = tx.objectStore('ledger');
                    const whStore = tx.objectStore('warehouseInventory');
                    const auditStore = tx.objectStore('inventoryTransactions');

                    const accounts = await loadAccountsFromStore(tx);
                    const companyConfig = getCompanyConfig();
                    const companyId = companyConfig?.companyId;
                    const accountOptions = { allowNonPosting: false, companyId };
                    const resolveAcct = (ref: string | undefined) => {
                        if (!ref) {
                            throw new UnresolvedAccountError(ref || 'undefined');
                        }
                        const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                        if (!resolved) {
                            throw new UnresolvedAccountError(ref);
                        }
                        return resolved;
                    };

                    const storedItem = await inventoryStore.get(params.itemId);
                    if (!storedItem) throw new Error("Item not found");

                    // FAIL-CLOSED ORDERING: resolve the full GL posting BEFORE
                    // mutating inventory. If accounting configuration is
                    // invalid, the inventory change is never applied and no
                    // half-completed state is left behind.
                    const itemTypeForPosting =
                        (params.variantId && storedItem.variants
                            ? storedItem.type
                            : storedItem.type) as string | undefined;
                    const isServiceItem = String(itemTypeForPosting || '').toLowerCase().includes('service');
                    const variantCost = params.variantId && storedItem.variants
                        ? storedItem.variants.find((v: any) => v.id === params.variantId)?.cost
                        : undefined;
                    const previewCost = Number(variantCost ?? storedItem.cost ?? 0);
                    const previewAmount = Math.abs(params.qtyChange * previewCost);
                    let posting: { debitAccountId: string; creditAccountId: string } | null = null;
                    if (!isServiceItem && previewAmount > 0) {
                        const gl = getGLConfig();
                        posting = resolveStockAdjustmentPosting({
                            reason: accountingReason,
                            qtyChange: params.qtyChange,
                            itemType: itemTypeForPosting,
                            inventoryRole: (storedItem as any)?.inventoryRole,
                            accounts,
                            gl,
                        });
                        // Defence-in-depth: the resolved pair must never touch 42100.
                        assertNoInterestIncomeForInventoryMovement({
                            debitAccountId: posting.debitAccountId,
                            creditAccountId: posting.creditAccountId,
                            accounts,
                            context: 'adjustStock',
                        });
                    }

                    if (params.variantId && storedItem.variants) {
                        const variantIndex = storedItem.variants.findIndex((v: any) => v.id === params.variantId);
                        if (variantIndex !== -1) {
                            storedItem.variants[variantIndex].stock = (storedItem.variants[variantIndex].stock || 0) + params.qtyChange;
                            adjustmentCost = storedItem.variants[variantIndex].cost || storedItem.cost || 0;
                        }
                    }

                    storedItem.stock = (storedItem.stock || 0) + params.qtyChange;
                    await inventoryStore.put(storedItem);

                    const warehouseId = params.warehouseId || 'WH-MAIN';
                    const whKey = [warehouseId, params.itemId].join('_');
                    const whRecord = await whStore.get(whKey);
                    if (whRecord) {
                        whRecord.quantity = (whRecord.quantity || 0) + params.qtyChange;
                        await whStore.put(whRecord);
                    } else {
                        await whStore.put({ id: whKey, itemId: params.itemId, warehouseId, quantity: Math.max(0, params.qtyChange), reserved: 0 });
                    }

                    await auditStore.put({
                        id: `ADJ-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                        itemId: params.itemId,
                        warehouseId,
                        quantity: params.qtyChange,
                        type: 'ADJUSTMENT',
                        date: new Date().toISOString(),
                        referenceId: params.reason,
                        notes: params.notes || ''
                    });

                    // Services never carry inventory value: quantity moves, no GL.
                    if (!isServiceItem && Math.abs(params.qtyChange * adjustmentCost) > 0 && posting) {
                        const entry: LedgerEntry = {
                            id: operationSource ? `LG-ADJ-${operationSource}` : generateId('LG-ADJ'),
                            date: new Date().toISOString(),
                            description: `Stock Adjustment: ${params.reason} (${params.notes || ''})`,
                            debitAccountId: posting.debitAccountId,
                            creditAccountId: posting.creditAccountId,
                            amount: Math.abs(params.qtyChange * adjustmentCost),
                            referenceId: params.itemId,
                            referenceType: 'stock_adjustment',
                            entryType: accountingReason === 'OPENING_BALANCE' ? 'opening_balance_adjustment' : 'stock_adjustment',
                            reconciled: false
                        };
                        await ledgerStore.put(entry);
                    }

                    return { success: true };
                }
            );
        } catch (error: any) {
            // Idempotent retry: the operation already posted — report success
            // without duplicating inventory or ledger writes.
            if (String(error?.message || '').includes('Duplicate financial request blocked')) {
                return { success: true, idempotent: true };
            }
            logger.error('[TransactionService] adjustStock error:', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    },

    async updateReservedStock(itemId: string, reservedChange: number, variantId?: string) {
        if (!itemId) {
            logger.debug(`[Inventory] Skipping reserved stock update: no item ID provided`);
            return { success: false, error: 'No item ID' };
        }

        try {
            return dbService.executeAtomicOperation(
                ['inventory'],
                async (tx) => {
                    const store = tx.objectStore('inventory');
                    const item = await store.get(itemId);
                    if (!item) {
                        logger.warn(`[Inventory] Cannot update reserved stock: item ${itemId} not found`);
                        return { success: false, error: 'Item not found' };
                    }

                    if (variantId && item.variants) {
                        const variantIndex = item.variants.findIndex(v => v.id === variantId);
                        if (variantIndex !== -1) {
                            item.variants[variantIndex].reserved = (item.variants[variantIndex].reserved || 0) + reservedChange;
                        }
                    }

                    item.reserved = (item.reserved || 0) + reservedChange;
                    await store.put(item);
                    return { success: true };
                }
            );
        } catch (error: any) {
            logger.error('[TransactionService] updateReservedStock error:', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    },

    async transferStock(itemId: string, fromWarehouseId: string, toWarehouseId: string, quantity: number) {
        try {
            return dbService.executeAtomicOperation(
                ['inventory', 'warehouseInventory', 'inventoryTransactions'],
                async (tx) => {
                    const invStore = tx.objectStore('inventory');
                    const whStore = tx.objectStore('warehouseInventory');
                    const auditStore = tx.objectStore('inventoryTransactions');

                    // Eligibility-first: only stock-bearing items can move
                    // between warehouses. Checked before any write.
                    const item = await invStore.get(itemId);
                    if (item && !isInventoryBearingItem(item)) {
                        throw new Error(`Item "${item.name || itemId}" is type "${item.type || 'unknown'}" and does not support stock operations`);
                    }

                    const sourceWhKey = [fromWarehouseId, itemId].join('_');
                    const sourceWh = await whStore.get(sourceWhKey);
                    if (sourceWh) {
                        sourceWh.quantity = (sourceWh.quantity || 0) - quantity;
                        if (sourceWh.quantity < 0) sourceWh.quantity = 0;
                        await whStore.put(sourceWh);
                    }

                    const destWhKey = [toWarehouseId, itemId].join('_');
                    const destWh = await whStore.get(destWhKey);
                    if (destWh) {
                        destWh.quantity = (destWh.quantity || 0) + quantity;
                        await whStore.put(destWh);
                    } else {
                        await whStore.put({ id: destWhKey, itemId, warehouseId: toWarehouseId, quantity, reserved: 0 });
                    }

                    if (item) {
                        item.stock = (item.stock || 0);
                        await invStore.put(item);
                    }

                    await auditStore.put({
                        id: `TRF-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
                        itemId,
                        fromWarehouseId,
                        toWarehouseId,
                        quantity,
                        type: 'TRANSFER',
                        date: new Date().toISOString(),
                        referenceId: `TRF-${itemId}-${Date.now()}`
                    });

                    return { success: true };
                }
            );
        } catch (error: any) {
            logger.error('[TransactionService] transferStock error:', error);
            return { success: false, error: error.message || 'Unknown error' };
        }
    },

    async processPurchaseOrder(purchase: Purchase) {
        return dbService.executeAtomicOperation(
            ['purchases'],
            async (tx) => {
                const store = tx.objectStore('purchases');
                // Permanent verification identity: issued once at creation,
                // preserved forever after (edits/prints/syncs never rotate).
                // Single non-accounting field — posting logic untouched.
                const existing = purchase?.id ? await store.get(purchase.id) : null;
                const withIdentity = ensureDocumentVerificationToken(purchase as Purchase & { verificationToken?: string });
                if (existing && (existing as any).verificationToken && !(withIdentity as any).verificationToken) {
                    (withIdentity as any).verificationToken = (existing as any).verificationToken;
                }
                // Landing-cost financial immutability: once a line has any
                // BILL/GRN consumption event, its posted amount and provider
                // are frozen; the PO method is frozen while any events exist.
                // Corrections require a controlled reversal, never silent edit.
                // Consumption history itself is append-only: a save that does
                // not carry it cannot erase it.
                if (existing) {
                    const priorEvents = ((existing as any).landingConsumption || []) as any[];
                    if (!Array.isArray((withIdentity as any).landingConsumption) && priorEvents.length > 0) {
                        (withIdentity as any).landingConsumption = [...priorEvents];
                    }
                    if (priorEvents.length > 0) {
                        const priorLines = new Map<string, any>(
                            (((existing as any).landingCosts || []) as any[]).map((c: any) => [String(c?.id), c])
                        );
                        const nextLines = new Map<string, any>(
                            (((purchase as any).landingCosts || []) as any[]).map((c: any) => [String(c?.id), c])
                        );
                        const touchedIds = new Set(priorEvents.map((e: any) => String(e?.landingCostId)));
                        for (const id of touchedIds) {
                            const before = priorLines.get(id);
                            const after = nextLines.get(id);
                            if (!after) {
                                throw new Error(
                                    `Landing cost line ${id} has posted financial activity (bill/capitalization) and cannot be removed from PO ${purchase.id}.`
                                );
                            }
                            if (Number(after.amount) !== Number(before?.amount)) {
                                throw new Error(
                                    `Landing cost line ${id} has posted financial activity and its amount cannot be changed ` +
                                    `(was K${Number(before?.amount || 0).toFixed(2)}). Use a controlled correction instead.`
                                );
                            }
                            if (String(after.providerId || '') !== String(before?.providerId || '')) {
                                throw new Error(
                                    `Landing cost line ${id} has posted financial activity and its provider cannot be changed. ` +
                                    `Use a controlled correction instead.`
                                );
                            }
                            // Tax classification shapes posted VAT/inventory splits;
                            // changing it under posted activity would silently
                            // re-split history.
                            for (const field of ['taxTreatment', 'vatRate', 'taxInclusive']) {
                                if (String((after as any)?.[field] ?? '') !== String((before as any)?.[field] ?? '')) {
                                    throw new Error(
                                        `Landing cost line ${id} has posted financial activity and its ${field} cannot be changed. ` +
                                        `Use a controlled correction instead.`
                                    );
                                }
                            }
                        }
                        const beforeMethod = (existing as any).landingAllocationMethod ?? 'VALUE';
                        const afterMethod = (purchase as any).landingAllocationMethod ?? 'VALUE';
                        if (beforeMethod !== afterMethod) {
                            throw new Error(
                                `PO ${purchase.id} has posted landing-cost activity, so its allocation method cannot be changed ` +
                                `from ${beforeMethod} to ${afterMethod}.`
                            );
                        }
                    }
                }
                await store.put(withIdentity);
                return { success: true };
            }
        );
    },

    async approvePurchaseOrder(id: string) {
        return dbService.executeAtomicOperation(
            ['purchases', 'ledger', 'suppliers', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'purchase_order_approval', id);

                const purchaseStore = tx.objectStore('purchases');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const purchase = await purchaseStore.get(id);
                if (!purchase) throw new Error("Purchase order not found");
                if (purchase.status === 'Approved') throw new Error("Purchase order already approved");
                if (purchase.status === 'Cancelled') throw new Error("Cannot approve cancelled purchase order");

                const gl = getGLConfig();
                const totalAmount = purchase.total || purchase.totalAmount || 0;
                const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountFromItems(purchase.items || [], accounts) : null;

                // 1. Post AP Ledger Entry for Purchase Order
                // Debit: PO Receiving Account (or Inventory Account if direct).
                // Non-stock procurements (no eligible lines) debit Purchases
                // (expense) — never an inventory account.
                const apEntry: LedgerEntry = {
                    id: generateId('LG-PO-AP'),
                    date: new Date().toISOString(),
                    description: `PO Commitment - ${purchase.id}`,
                    debitAccountId: inventoryAccountId || resolveAcct(gl.purchasesAccount || '51100'),
                    creditAccountId: resolveAcct(gl.accountsPayable),
                    amount: totalAmount,
                    referenceId: purchase.id,
                    reconciled: false,
                    supplierId: purchase.supplierId
                };
                await ledgerStore.put(apEntry);

                // 2. Update Supplier Balance
                if (purchase.supplierId) {
                    const supplier = await supplierStore.get(purchase.supplierId);
                    if (supplier) {
                        supplier.balance = (supplier.balance || 0) + totalAmount;
                        await supplierStore.put(supplier);
                    }
                }

                // 3. Update Purchase Order Status
                purchase.status = 'Approved';
                purchase.paymentStatus = 'Approved';
                purchase.approvedAt = new Date().toISOString();
                await purchaseStore.put(purchase);

                return { success: true, apEntryId: apEntry.id };
            }
        );
    },

    async cancelPurchaseOrder(id: string, reason: string) {
        return dbService.executeAtomicOperation(
            ['purchases', 'ledger', 'suppliers', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'purchase_order_cancel', `${id}:${reason}`);

                const purchaseStore = tx.objectStore('purchases');
                const ledgerStore = tx.objectStore('ledger');
                const supplierStore = tx.objectStore('suppliers');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const purchase = await purchaseStore.get(id);
                if (!purchase) throw new Error("Purchase order not found");
                if (purchase.status === 'Cancelled') throw new Error("Purchase order already cancelled");
                if (purchase.status === 'Received') throw new Error("Cannot cancel received purchase order");

                const gl = getGLConfig();
                const totalAmount = purchase.total || purchase.totalAmount || 0;

                // 1. Reverse AP Ledger Entry if PO was approved
                if (purchase.status === 'Approved') {
                    const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountFromItems(purchase.items || [], accounts) : null;
                    const reversalEntry: LedgerEntry = {
                        id: generateId('LG-PO-REV'),
                        date: new Date().toISOString(),
                        description: `PO Cancellation - ${purchase.id} - ${reason}`,
                        debitAccountId: resolveAcct(gl.accountsPayable),
                        creditAccountId: inventoryAccountId || resolveAcct(gl.defaultInventoryAccount),
                        amount: totalAmount,
                        referenceId: purchase.id,
                        reconciled: false,
                        supplierId: purchase.supplierId
                    };
                    await ledgerStore.put(reversalEntry);

                    // 2. Reverse Supplier Balance
                    if (purchase.supplierId) {
                        const supplier = await supplierStore.get(purchase.supplierId);
                        if (supplier) {
                            supplier.balance = (supplier.balance || 0) - totalAmount;
                            await supplierStore.put(supplier);
                        }
                    }
                }

                // 3. Update Purchase Order Status
                purchase.status = 'Cancelled';
                purchase.paymentStatus = 'Cancelled';
                purchase.cancelledAt = new Date().toISOString();
                purchase.cancelReason = reason;
                await purchaseStore.put(purchase);

                return { success: true };
            }
        );
    },

    async createReplenishmentOrder(itemId: string) {
        return dbService.executeAtomicOperation(
            ['inventory', 'purchases', 'suppliers'],
            async (tx) => {
                const inventoryStore = tx.objectStore('inventory');
                const purchaseStore = tx.objectStore('purchases');

                const item = await inventoryStore.get(itemId);
                if (!item) throw new Error("Item not found");

                const allPurchases = await purchaseStore.getAll();
                const nextId = generateNextId('PO', allPurchases);

                const newPurchase: Purchase = {
                    id: nextId,
                    date: new Date().toISOString(),
                    supplierId: item.preferredSupplierId || 'SUPP-001',
                    items: [{
                        id: item.id,
                        itemId: item.id,
                        name: item.name,
                        quantity: (item.maxStockLevel || 100) - (item.stock || 0),
                        cost: item.cost || 0,
                        price: item.cost || 0,
                        receivedQty: 0
                    }],
                    total: ((item.maxStockLevel || 100) - (item.stock || 0)) * (item.cost || 0),
                    totalAmount: ((item.maxStockLevel || 100) - (item.stock || 0)) * (item.cost || 0),
                    status: 'Draft'
                };

                await purchaseStore.put(newPurchase);
                return newPurchase;
            }
        );
    },

    async reconcileInventory(results: { itemId: string; variance: number; warehouseId: string }[], totalVarianceCost: number) {
        return dbService.executeAtomicOperation(
            ['inventory', 'ledger', 'accounts'],
            async (tx) => {
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // Eligibility-first: reconciliation only touches stock-bearing
                // items. Non-stock rows (Product/Service) are ignored here and
                // excluded from the variance cost below.
                const eligibleResults: typeof results = [];
                for (const res of results) {
                    const item = await inventoryStore.get(res.itemId);
                    if (item && isInventoryBearingItem(item)) eligibleResults.push(res);
                }
                if (eligibleResults.length === 0) return { success: true };

                let eligibleVarianceCost = 0;
                for (const res of eligibleResults) {
                    const item = await inventoryStore.get(res.itemId);
                    if (item) {
                        eligibleVarianceCost += res.variance * (item.cost || 0);
                        item.stock = (item.stock || 0) + res.variance;
                        await inventoryStore.put(item);
                    }
                }

                if (Math.abs(eligibleVarianceCost) > 0.01) {
                    const gl = getGLConfig();
                    const firstItem = eligibleResults.length > 0 ? await inventoryStore.get(eligibleResults[0].itemId) : null;
                    const inventoryAccountId = accounts.length > 0 && firstItem ? resolveInventoryAccountByItemType(firstItem.type, accounts, (firstItem as any)?.inventoryRole) : null;
                    // Reconciliation GL (fail-closed, symmetric COGS — never
                    // income; previously resolveAcct('42000') silently
                    // returned 42100 Interest Income via parent fallback):
                    // - eligibleVarianceCost > 0 (physical > GL): Debit Inventory, Credit COGS (gain)
                    // - eligibleVarianceCost < 0 (physical < GL): Debit COGS (loss), Credit Inventory
                    const entry: LedgerEntry = {
                        id: generateId('LG-REC'),
                        date: new Date().toISOString(),
                        description: `Inventory Reconciliation Variance`,
                        debitAccountId: eligibleVarianceCost < 0 ? resolveAcct(gl.defaultCOGSAccount) : (inventoryAccountId || resolveAcct(gl.defaultInventoryAccount)),
                        creditAccountId: eligibleVarianceCost < 0 ? (inventoryAccountId || resolveAcct(gl.defaultInventoryAccount)) : resolveAcct(gl.defaultCOGSAccount),
                        amount: Math.abs(eligibleVarianceCost),
                        referenceId: 'RECONCILE',
                        referenceType: 'inventory_reconciliation',
                        entryType: 'inventory_reconciliation',
                        reconciled: true
                    };
                    assertNoInterestIncomeForInventoryMovement({
                        debitAccountId: entry.debitAccountId as string,
                        creditAccountId: entry.creditAccountId as string,
                        accounts,
                        context: 'reconcileInventory',
                    });
                    await ledgerStore.put(entry);
                }

                return { success: true };
            }
        );
    },

    async getCompanyConfig() {
        // Mocking company config for now as it's not in DB schema but used in ProductionContext
        return {
            productionSettings: {
                requireQAApproval: false,
                allowOverproduction: true
            },
            lateFeePolicy: {
                enabled: false,
                type: 'Flat',
                value: 0
            }
        };
    },

    async completeWorkOrder(orderId: string, consumedMaterials: { materialId: string, quantity: number, cost: number }[] = []) {
        return dbService.executeAtomicOperation(
            ['workOrders', 'inventory', 'ledger', 'accounts'],
            async (tx) => {
                const woStore = tx.objectStore('workOrders');
                const invStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const wo = await woStore.get(orderId);
                if (!wo) throw new Error("Work order not found");

                // 1. Update status
                wo.status = 'Completed';
                wo.endDate = new Date().toISOString();
                await woStore.put(wo);

                // 2. Consume Materials (BOM) — stock-bearing inputs only.
                // Non-stock materials carry no inventory value: no stock
                // movement, no consumption posting.
                // Note: `reserved` is NOT decremented here because
                // `inventoryReservationService.consumeReservation()` already handles
                // the reserved-field update before this method is called.
                const gl = getGLConfig();
                let totalMaterialCost = 0;
                for (const mat of consumedMaterials) {
                    const item = await invStore.get(mat.materialId);
                    if (item && isInventoryBearingItem(item)) {
                        item.stock = (item.stock || 0) - mat.quantity;
                        await invStore.put(item);

                        const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountByItemType(item.type, accounts, (item as any)?.inventoryRole) : null;
                        // Ledger entry for material consumption
                        const entry: LedgerEntry = {
                            id: generateId('LG-CONS'),
                            date: new Date().toISOString(),
                            description: `Material Consumption: ${item.name} (WO: ${wo.id})`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: inventoryAccountId || resolveAcct(gl.defaultInventoryAccount),
                            amount: mat.cost,
                            referenceId: wo.id,
                            reconciled: false
                        };
                        await ledgerStore.put(entry);
                        totalMaterialCost += mat.cost;
                    }
                }

                // 3. Production output: only a stock-bearing item is added to
                // stock. A Product is produced against orders/BOM without
                // being stored as inventory, so its output accrues no stock
                // and no weighted-average cost.
                const product = await invStore.get(wo.productId);
                if (product && isInventoryBearingItem(product)) {
                    const oldStock = product.stock || 0;
                    const qtyProduced = wo.quantityPlanned || 0;
                    product.stock = oldStock + qtyProduced;
                    if (qtyProduced > 0) {
                        const unitCost = totalMaterialCost / qtyProduced;
                        const oldNormalizedCP = product.normalizedCP ?? product.costPrice ?? product.cost ?? 0;
                        const newNormalizedCP = oldNormalizedCP
                            ? ((oldNormalizedCP * oldStock) + (unitCost * qtyProduced)) / (oldStock + qtyProduced)
                            : unitCost;
                        // Same alias-sync rule as receipts: no stale alias
                        // may shadow the fresh average.
                        Object.assign(product, costAliasValues(newNormalizedCP));
                    }
                    await invStore.put(product);
                }

                return { success: true };
            }
        );
    },

    async processWorkOrderCreation(wo: WorkOrder, reservations: { materialId: string, quantity: number }[] = []) {
        // DEPRECATED: Reservation logic moved to inventoryReservationService.
        // Kept for backward compatibility; no longer called from production flow.
        return dbService.executeAtomicOperation(
            ['workOrders', 'inventory'],
            async (tx) => {
                const woStore = tx.objectStore('workOrders');
                const invStore = tx.objectStore('inventory');

                // 1. Save Work Order
                await woStore.put(wo);

                // 2. Reserve Materials
                for (const res of reservations) {
                    const item = await invStore.get(res.materialId);
                    if (item) {
                        item.reserved = (item.reserved || 0) + res.quantity;
                        await invStore.put(item);
                    }
                }

                return { success: true };
            }
        );
    },

    async cancelWorkOrder(orderId: string, reservations: { materialId: string, quantity: number }[] = []) {
        return dbService.executeAtomicOperation(
            ['workOrders', 'inventory', 'accounts'],
            async (tx) => {
                const store = tx.objectStore('workOrders');
                const invStore = tx.objectStore('inventory');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const wo = await store.get(orderId);

                if (wo) {
                    wo.status = 'Cancelled';
                    await store.put(wo);
                }

                // Release reservations if any
                for (const res of reservations) {
                    const item = await invStore.get(res.materialId);
                    if (item) {
                        item.reserved = Math.max(0, (item.reserved || 0) - res.quantity);
                        await invStore.put(item);
                    }
                }

                return { success: true };
            }
        );
    },

    async processProductionWaste(materialId: string, quantity: number, cost: number, referenceId: string, description: string) {
        return dbService.executeAtomicOperation(
            ['inventory', 'ledger', 'accounts'],
            async (tx) => {
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // 1. Update Inventory — stock-bearing items only. Waste of a
                // non-stock item carries no inventory value: fail safe with
                // no mutation and no posting.
                const item = await inventoryStore.get(materialId);
                if (item && !isInventoryBearingItem(item)) {
                    return { success: false, error: `Item "${item.name || materialId}" is type "${item.type || 'unknown'}" and does not support stock operations` };
                }
                if (item) {
                    item.stock = (item.stock || 0) - quantity;
                    await inventoryStore.put(item);
                }

                // 2. Create Ledger Entry (Debit COGS/Waste, Credit Inventory)
                const gl = getGLConfig();
                const inventoryAccountId = accounts.length > 0 ? resolveInventoryAccountByItemType(item?.type, accounts, (item as any)?.inventoryRole) : null;
                const entry: LedgerEntry = {
                    id: generateId('LG-WST'),
                    date: new Date().toISOString(),
                    description: description,
                    debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                    creditAccountId: inventoryAccountId || resolveAcct(gl.defaultInventoryAccount),
                    amount: cost,
                    referenceId: referenceId,
                    reconciled: false
                };
                await ledgerStore.put(entry);

                return { success: true };
            }
        );
    },

    async createOrder(order: Order) {
        const canonical = salesOrderService.canonicalizeOrder(order);
        const result = await dbService.executeAtomicOperation(
            ['salesOrders', 'inventory', 'ledger', 'customers', 'walletTransactions', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                const order = canonical;
                await reserveIdempotencyKey(tx, 'order', order.id, order.idempotencyKey);

                const orderStore = tx.objectStore('salesOrders');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const walletStore = tx.objectStore('walletTransactions');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };
                const gl = getGLConfig();

                // Pre-fetch data for adjustment processing
                const inventory = await inventoryStore.getAll();
                const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();

                // 1. Save Order
                await orderStore.put(order);

                // 2. Reserve Stock — stock-bearing items only. Non-stock
                // (Product/Service) order lines reserve nothing.
                for (const item of order.items) {
                    const invItem = await inventoryStore.get(item.productId);
                    if (invItem && !isInventoryBearingItem(invItem)) continue;
                    if (invItem) {
                        if (item.variantId && invItem.variants) {
                            const vIdx = invItem.variants.findIndex(v => v.id === item.variantId);
                            if (vIdx !== -1) {
                                invItem.variants[vIdx].reserved = (invItem.variants[vIdx].reserved || 0) + item.quantity;
                            }
                        }
                        invItem.reserved = (invItem.reserved || 0) + item.quantity;
                        await inventoryStore.put(invItem);
                    }
                }

                // 3. Status-based processing
                if (order.status === 'Fulfilled' || order.status === 'Completed') {
                    // Deduct actual stock immediately if created as Completed —
                    // stock-bearing lines only. Product/Service lines hold no
                    // stock, so nothing is deducted for them.
                    for (const item of order.items) {
                        const invItem = await inventoryStore.get(item.productId);
                        if (invItem && !isInventoryBearingItem(invItem)) continue;
                        if (invItem) {
                            // Rule: Use snapshot quantities for deduction if available
                            const qtyToDeduct = item.productionCostSnapshot?.components?.reduce((sum: number, c: any) => sum + (c.quantity || 0), 0) || item.quantity;

                            if (item.variantId && invItem.variants) {
                                const vIdx = invItem.variants.findIndex(v => v.id === item.variantId);
                                if (vIdx !== -1) {
                                    invItem.variants[vIdx].stock = (invItem.variants[vIdx].stock || 0) - qtyToDeduct;
                                    invItem.variants[vIdx].reserved = Math.max(0, (invItem.variants[vIdx].reserved || 0) - qtyToDeduct);
                                }
                            }
                            invItem.stock = (invItem.stock || 0) - qtyToDeduct;
                            invItem.reserved = Math.max(0, (invItem.reserved || 0) - qtyToDeduct);
                            await inventoryStore.put(invItem);
                        }
                    }

                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        order.items || [],
                        inventoryStore,
                        (item) => item.productId,
                        accounts,
                        () => resolveAcct(gl.defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    for (const leg of cogsLegs) {
                        if (!leg.inventoryAccountId) continue;
                        const cogsEntry: LedgerEntry = {
                            id: generateId('LG-COGS'),
                            date: order.orderDate,
                            description: `COGS - Order #${order.orderNumber}`,
                            debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                            creditAccountId: leg.inventoryAccountId,
                            amount: leg.amount,
                            referenceId: order.id,
                            reconciled: false,
                            customerId: order.customerId,
                            customerName: order.customerName
                        };
                        await ledgerStore.put(cogsEntry);
                        cogsEntries.push(cogsEntry);
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Order #${order.orderNumber}`);
                    }

                    // Process Market Adjustments for completed orders
                    // Convert order items to cart items format for the helper
                    const cartItems: any[] = order.items.map(item => ({
                        id: item.productId,
                        name: item.productName,
                        price: item.unitPrice,
                        quantity: item.quantity,
                        type: 'Product',
                        cost: item.productionCostSnapshot?.baseProductionCost || 0,
                        variantId: item.variantId,
                        adjustmentSnapshots: item.adjustmentSnapshots,
                        transactionAdjustmentSnapshots: item.transactionAdjustmentSnapshots
                    }));

                    const adjustmentResult = await this._processMarketAdjustments(
                        cartItems,
                        inventory,
                        bomTemplates,
                        marketAdjustments,
                        order.id,
                        'order',
                        inventoryStore
                    );

                    // Store adjustment data on order
                    order.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                        ? adjustmentResult.adjustmentSnapshots
                        : order.adjustmentSnapshots;
                    order.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                        ? adjustmentResult.adjustmentTotal
                        : order.adjustmentTotal;
                    order.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                    order.adjustmentSummary = adjustmentResult.adjustmentSummary;

                    // Save adjustment transactions to the store
                    for (const adjTx of adjustmentResult.adjustmentTransactions) {
                        await marketAdjustmentTransactionsStore.put(adjTx);
                    }

                    // Update order with adjustment data
                    await orderStore.put(order);

                    // Recognize Revenue immediately
                    const revenueEntry: LedgerEntry = {
                        id: generateId('LG-ORD-REV-NEW'),
                        date: order.orderDate,
                        description: `Immediate Revenue recognition for Order #${order.orderNumber}`,
                        debitAccountId: resolveAcct(gl.customerDeposits || gl.customerDepositAccount),
                        creditAccountId: resolveAcct(gl.salesRevenueAccount || gl.defaultSalesAccount || gl.incomeAccount),
                        amount: order.totalAmount,
                        referenceId: order.id,
                        reconciled: true,
                        customerId: order.customerId,
                        customerName: order.customerName
                    };
                    await ledgerStore.put(revenueEntry);
                }

                // 4. Create Ledger Entry for initial payment and update Wallet if needed
                if (order.paidAmount > 0 && order.payments && order.payments.length > 0) {
                    const lastPayment = order.payments[order.payments.length - 1];
                    const isWallet = lastPayment.paymentMethod === 'Wallet';

                    if (isWallet && order.customerId) {
                        const customer = await customerStore.get(order.customerId);
                        if (customer) {
                            customer.walletBalance = (customer.walletBalance || 0) - order.paidAmount;
                            await customerStore.put(customer);

                            const walletTx: WalletTransaction = {
                                id: generateId('WLT-ORD'),
                                customerId: order.customerId,
                                date: new Date().toISOString(),
                                type: 'Deduction',
                                amount: order.paidAmount,
                                description: `Wallet payment for Order #${order.orderNumber}`
                            };
                            await walletStore.put(walletTx);
                        }
                    }

                    const entry: LedgerEntry = {
                        id: generateId('LG-ORD-INIT'),
                        date: order.orderDate,
                        description: `Initial payment for Order #${order.orderNumber} via ${lastPayment.paymentMethod}`,
                        debitAccountId: isWallet ? resolveAcct(gl.walletAccount || gl.customerDepositAccount || gl.bankAccount) : resolveAcct(gl.cashDrawerAccount || gl.bankAccount),
                        creditAccountId: resolveAcct(gl.customerDeposits || gl.customerDepositAccount),
                        amount: order.paidAmount,
                        referenceId: order.id,
                        reconciled: false,
                        customerId: order.customerId,
                        customerName: order.customerName
                    };
                    await ledgerStore.put(entry);

                    if (!isWallet) {
                        await ensureMirroredBankTransaction({
                            bankAccountsStore,
                            bankTransactionsStore,
                            date: order.orderDate,
                            amount: order.paidAmount,
                            type: 'Deposit',
                            description: `Initial payment for Order #${order.orderNumber}`,
                            reference: `ORD-INIT-${order.id}`,
                            accountId: lastPayment.accountId,
                            paymentMethod: lastPayment.paymentMethod,
                            category: 'Income',
                            counterpartyName: order.customerName
                        });
                    }
                }

                return { success: true, id: order.id };
            }
        );
        return result;
    },

    async recordOrderPayment(orderId: string, payment: OrderPayment) {
        const result = await dbService.executeAtomicOperation(
            ['salesOrders', 'ledger', 'customers', 'walletTransactions', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'order_payment', `${orderId}:${payment.id || payment.paymentDate}:${payment.amountPaid}`);

                const orderStore = tx.objectStore('salesOrders');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const walletStore = tx.objectStore('walletTransactions');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const order = await orderStore.get(orderId);
                if (!order) throw new Error("Order not found");

                // Terminal status protection: cannot record payment on a Cancelled order
                const orderCanonical = salesOrderService.canonicalizeStatus(order.status);
                if (orderCanonical === 'Cancelled') {
                    throw new Error("Cannot record payment on a cancelled sales order");
                }

                // 1. Update Order
                order.payments = [...(order.payments || []), payment];
                order.paidAmount += payment.amountPaid;
                order.remainingBalance = order.totalAmount - order.paidAmount;

                const isTerminal = order.status === 'Fulfilled' || order.status === 'Completed'
                    || order.status === 'Cancelled' || order.status === 'Converted';
                if (!isTerminal) {
                    order.paymentStatus = order.paidAmount >= order.totalAmount ? 'Paid' : 'Partially Paid';
                }

                await orderStore.put(order);

                // 2. Wallet Update if needed
                const isWallet = payment.paymentMethod === 'Wallet';
                if (isWallet && order.customerId) {
                    const customer = await customerStore.get(order.customerId);
                    if (customer) {
                        customer.walletBalance = (customer.walletBalance || 0) - payment.amountPaid;
                        await customerStore.put(customer);

                        const walletTx: WalletTransaction = {
                            id: generateId('WLT-ORD-PAY'),
                            customerId: order.customerId,
                            date: new Date().toISOString(),
                            type: 'Deduction',
                            amount: payment.amountPaid,
                            description: `Wallet payment for Order #${order.orderNumber}`
                        };
                        await walletStore.put(walletTx);
                    }
                }

                // 3. Ledger Entry
                const gl = getGLConfig();
                let targetDebitAccount = gl.cashDrawerAccount;

                if (isWallet) {
                    targetDebitAccount = gl.customerDepositAccount;
                } else if (payment.accountId) {
                    targetDebitAccount = payment.accountId;
                } else {
                    if (payment.paymentMethod === 'Card' || payment.paymentMethod === 'Bank Transfer') targetDebitAccount = gl.bankAccount;
                    if (payment.paymentMethod === 'Mobile Money') targetDebitAccount = gl.mobileMoneyAccount;
                }

                const entry: LedgerEntry = {
                    id: generateId('LG-ORD-PAY'),
                    date: payment.paymentDate,
                    description: `Payment for Order #${order.orderNumber} via ${payment.paymentMethod}`,
                    debitAccountId: resolveAcct(targetDebitAccount),
                    creditAccountId: resolveAcct(gl.customerDeposits),
                    amount: payment.amountPaid,
                    referenceId: order.id,
                    reconciled: false,
                    customerId: order.customerId,
                    customerName: order.customerName
                };
                await ledgerStore.put(entry);

                if (!isWallet) {
                    await ensureMirroredBankTransaction({
                        bankAccountsStore,
                        bankTransactionsStore,
                        date: payment.paymentDate,
                        amount: payment.amountPaid,
                        type: 'Deposit',
                        description: `Payment for Order #${order.orderNumber}`,
                        reference: `ORD-PAY-${order.id}-${payment.id || payment.paymentDate}`,
                        accountId: payment.accountId,
                        paymentMethod: payment.paymentMethod,
                        category: 'Income',
                        counterpartyName: order.customerName
                    });
                }

                return { success: true };
            }
        );
        return result;
    },

    /**
     * Canonical wallet-first assessment consumption for Printing Contracts.
     *
     * ONE reserved→consumed transition == ONE wallet debit + ONE ledger posting.
     * Everything happens inside a single executeAtomicOperation covering the
     * contract, the item, the customer, the wallet transaction, the ledger
     * entry and the idempotency key. All reads and validations run BEFORE the
     * first write, so a validation failure can never leave partial state.
     *
     * Idempotency is structural, not best-effort:
     *  - wallet transaction id is deterministic: `WTX-<assessmentItemId>-CONSUMED`
     *  - idempotency key is deterministic: `wallet:assessment:<assessmentItemId>:consumed`
     *    and is reserved FIRST via reserveIdempotencyKey (duplicate ⇒ throw)
     *  - ledger entry id is derived from the wallet transaction id
     * A retry/double-click/sync-replay therefore converges instead of
     * duplicating: same keys → same rows → upsert-by-key, never a second debit.
     */
    async consumeContractAssessment(args: {
        contractId: string;
        assessmentItemId: string;
        idempotencyKey?: string;
        performedBy?: string;
    }) {
        const contractId = String(args?.contractId || '').trim();
        const assessmentItemId = String(args?.assessmentItemId || '').trim();
        if (!contractId) throw new Error('consumeContractAssessment: contractId is required.');
        if (!assessmentItemId) throw new Error('consumeContractAssessment: assessmentItemId is required.');
        // Serialize same-item invocations within this tab; a prior failure
        // must not fail this call, so prior rejections are swallowed here
        // (the fresh attempt re-validates everything itself).
        const lockKey = `consume-contract-assessment:${contractId}:${assessmentItemId}`;
        const previous = consumeContractLocks.get(lockKey) || Promise.resolve();
        let releaseLock!: () => void;
        const current = new Promise<void>((resolve) => { releaseLock = resolve; });
        consumeContractLocks.set(lockKey, current);
        try {
            await previous.catch(() => {});
            return await this.consumeContractAssessmentTx(args);
        } finally {
            if (consumeContractLocks.get(lockKey) === current) {
                consumeContractLocks.delete(lockKey);
            }
            releaseLock();
        }
    },

    /**
     * Inner implementation behind the per-item mutex above. MUST only be
     * called via consumeContractAssessment (same-tab serialization).
     */
    async consumeContractAssessmentTx(args: {
        contractId: string;
        assessmentItemId: string;
        idempotencyKey?: string;
        performedBy?: string;
    }) {
        const contractId = String(args?.contractId || '').trim();
        const assessmentItemId = String(args?.assessmentItemId || '').trim();
        const explicitKey = args?.idempotencyKey
            ? String(args.idempotencyKey)
            : `wallet:assessment:${assessmentItemId}:consumed`;
        const walletTxId = `WTX-${assessmentItemId}-CONSUMED`;
        const nowIso = new Date().toISOString();

        const result = await dbService.executeAtomicOperation(
            ['assessmentContracts', 'contractAssessments', 'customers', 'walletTransactions', 'ledger', 'accounts', 'idempotencyKeys'],
            async (tx) => {
                const contractStore = tx.objectStore('assessmentContracts');
                const itemStore = tx.objectStore('contractAssessments');
                const customerStore = tx.objectStore('customers');
                const walletStore = tx.objectStore('walletTransactions');
                const ledgerStore = tx.objectStore('ledger');

                // ── Reads ──────────────────────────────────────────────
                const contract = await contractStore.get(contractId);
                if (!contract) {
                    throw new Error(`consumeContractAssessment: contract ${contractId} not found. Nothing written.`);
                }
                const item = await itemStore.get(assessmentItemId);
                if (!item) {
                    throw new Error(`consumeContractAssessment: assessment item ${assessmentItemId} not found. Nothing written.`);
                }

                // ── Linkage: the item must belong to this contract ──────
                if (String(item.contract_id || '') !== String(contract.id || contractId)) {
                    throw new Error(`consumeContractAssessment: assessment ${assessmentItemId} does not belong to contract ${contractId}. Nothing written.`);
                }

                // ── Contract eligibility: only active contracts execute ──
                const contractStatus = String(contract.status || '').trim().toLowerCase();
                if (contractStatus !== 'active') {
                    throw new Error(`consumeContractAssessment: contract ${contractId} is '${contract.status || 'unknown'}' — only active contracts can consume assessments. Nothing written.`);
                }

                // ── Item must be reserved (exactly once semantics) ──────
                if (String(item.status || '') !== 'reserved') {
                    throw new Error(`consumeContractAssessment: assessment ${assessmentItemId} is '${item.status || 'unknown'}' — only reserved assessments can be consumed. Nothing written.`);
                }

                // ── Price must be a positive, finite amount (schema CHECK
                // agrees: chk_assessment_items_positive_price) ────────────
                const price = toMoney(Number(item.item_price));
                if (!Number.isFinite(price) || price <= 0) {
                    throw new Error(`consumeContractAssessment: assessment ${assessmentItemId} has invalid price (${String(item.item_price)}). Refusing to charge. Nothing written.`);
                }

                // ── Customer + funds gate (inside the tx, not a UI pre-check)
                const customerId = String(contract.customer_id || '');
                if (!customerId) {
                    throw new Error(`consumeContractAssessment: contract ${contractId} has no customer. Nothing written.`);
                }
                const customer = await customerStore.get(customerId);
                if (!customer) {
                    throw new Error(`consumeContractAssessment: customer ${customerId} not found. Nothing written.`);
                }
                const balance = toMoney(Number(customer.walletBalance || 0));
                if (!Number.isFinite(balance) || !(balance >= price)) {
                    throw new Error(`INSUFFICIENT_WALLET_FUNDS: required ${price.toFixed(2)}, available ${Number.isFinite(balance) ? balance.toFixed(2) : 'unknown'}. No wallet transaction created, no ledger posting, assessment remains reserved.`);
                }

                // ── Idempotency reservation FIRST among writes ──────────
                await reserveIdempotencyKey(tx, 'contract_assessment_consume', assessmentItemId, explicitKey);

                // ── Defensive: deterministic debit already present? ─────
                // Unreachable through the normal path (the reservation above
                // throws first), but a manual/backfilled row with the same
                // deterministic id must never gain a sibling debit.
                const priorTx = await walletStore.get(walletTxId);
                if (priorTx) {
                    throw new Error(`consumeContractAssessment: assessment ${assessmentItemId} already has consumption transaction ${walletTxId}. Refusing duplicate debit.`);
                }

                // ── Accounts (existing GL resolution, no new accounts) ──
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };
                const gl = getGLConfig();
                // Economic meaning: spending down the customer's prepaid
                // deposit liability into earned revenue — the same legs as
                // immediate revenue recognition on completed orders.
                const debitAccountId = resolveAcct(gl.customerDeposits || gl.customerDepositAccount);
                const creditAccountId = resolveAcct(gl.salesRevenueAccount || gl.defaultSalesAccount || gl.incomeAccount);

                const customerName = contract.customerName
                    || (customer as any)?.name
                    || (customer as any)?.customerName
                    || '';
                const contractNumber = contract.contract_number || contractId;
                const itemLabel = item.assessment_name || assessmentItemId;

                // ── Wallet debit (canonical Deduction, positive amount) ─
                const walletTx: WalletTransaction = {
                    id: walletTxId,
                    customerId,
                    customerName,
                    date: nowIso,
                    type: 'Deduction',
                    amount: price,
                    description: `Assessment consumption ${contractNumber} — ${itemLabel}`,
                    reference: contractNumber,
                    idempotencyKey: explicitKey,
                    data: {
                        type: 'ASSESSMENT_CONSUMPTION',
                        contract_id: contract.id || contractId,
                        contract_number: contractNumber,
                        assessment_item_id: assessmentItemId,
                        customer_id: customerId,
                        amount: price,
                        idempotencyKey: explicitKey,
                        consumed_at: nowIso,
                    },
                } as WalletTransaction;
                await walletStore.put(walletTx);
                await customerStore.put({ ...customer, walletBalance: toMoney(balance - price) });

                // ── Ledger posting (existing mechanism, no new accounts) ─
                const ledgerEntry: LedgerEntry = {
                    id: `LG-${walletTxId}`,
                    date: nowIso,
                    description: `Assessment consumption ${contractNumber} — ${itemLabel}`,
                    debitAccountId,
                    creditAccountId,
                    amount: price,
                    referenceId: assessmentItemId,
                    reconciled: true,
                    customerId,
                    customerName,
                };
                await ledgerStore.put(ledgerEntry);

                // ── Item + contract buckets (same tx, schema CHECKs hold) ─
                // Reservation-coverage healing (documented, not silent): rows
                // created before reservation accounting existed carry
                // reserved_amount === 0 despite genuinely reserved items.
                // Coverage is computed transparently here so consuming such an
                // item debits exactly once and leaves truthful buckets, instead
                // of throwing on (or clamping away) the shortfall.
                const storedReserved = toMoney(Number(contract.reserved_amount || 0));
                const storedConsumed = toMoney(Number(contract.consumed_amount || 0));
                const effectiveReservedBefore = Math.max(storedReserved, price);
                const newReserved = toMoney(effectiveReservedBefore - price);
                const newConsumed = toMoney(storedConsumed + price);
                if (!(newReserved >= 0) || !(newConsumed >= 0)) {
                    throw new Error(`consumeContractAssessment: contract invariant violated for ${contractId} (reserved ${newReserved}, consumed ${newConsumed}). Aborting without writes applied after this point; earlier writes in this operation roll back with it.`);
                }
                await itemStore.put({
                    ...item,
                    status: 'consumed',
                    consumed_at: nowIso,
                    version: Number(item.version || 0) + 1,
                });
                await contractStore.put({
                    ...contract,
                    reserved_amount: newReserved,
                    consumed_amount: newConsumed,
                    updated_at: nowIso,
                    version: Number(contract.version || 0) + 1,
                });

                return {
                    success: true,
                    walletTransactionId: walletTxId,
                    ledgerEntryId: ledgerEntry.id,
                    newBalance: toMoney(balance - price),
                    contractId: contract.id || contractId,
                    assessmentItemId,
                };
            }
        );
        return result;
    },

    async updateOrderStatus(orderId: string, status: Order['status']) {
        const incoming = salesOrderService.canonicalizeStatus(status);
        const incomingLegacyPayment = salesOrderService.legacyPaymentStatus(status);
        const result = await dbService.executeAtomicOperation(
            ['salesOrders', 'inventory', 'ledger', 'bomTemplates', 'marketAdjustments', 'marketAdjustmentTransactions', 'accounts'],
            async (tx) => {
                const orderStore = tx.objectStore('salesOrders');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const bomTemplatesStore = tx.objectStore('bomTemplates');
                const marketAdjustmentsStore = tx.objectStore('marketAdjustments');
                const marketAdjustmentTransactionsStore = tx.objectStore('marketAdjustmentTransactions');
                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const order = await orderStore.get(orderId);
                if (!order) {
                    const allOrders = await orderStore.getAll();
                    const found = allOrders.find((o: Order) => o.id === orderId);
                    if (!found) {
                        console.warn(`[Orders.UpdateStatus] Order ${orderId} not found locally — skipping status update. Invoice was already created.`);
                        return { success: true, message: 'Order not found locally — no-op' };
                    }
                    orderStore.put(found);
                    return { success: true, message: 'Order re-synced locally, no status change applied' };
                }

                const oldStatus = order.status;
                const oldCanonical = salesOrderService.canonicalizeStatus(oldStatus);

                // Idempotency: if the order is already in the target canonical status, no-op
                if (!incomingLegacyPayment && incoming === oldCanonical) {
                    return { success: true, message: `Order already in status ${incoming}` };
                }

                // Terminal status protection: cannot transition FROM a terminal status
                // (except specific allowed transitions like Fulfilled/Converted are both terminal)
                if (salesOrderService.isTerminalStatus(oldCanonical) && !salesOrderService.isTerminalStatus(incoming) && incoming !== 'Cancelled') {
                    throw new Error(`Cannot transition from terminal status ${oldCanonical} to ${incoming}`);
                }

                if (incoming === 'Converted' && !incomingLegacyPayment) {
                    order.invoiceStatus = 'Invoiced';
                } else if (incomingLegacyPayment) {
                    order.paymentStatus = incomingLegacyPayment;
                } else {
                    order.status = incoming;
                }

                // Fulfillment logic
                if (incoming === 'Fulfilled' && oldCanonical !== 'Fulfilled') {
                    // 1. Pre-fetch data for adjustment processing
                    const inventory = await inventoryStore.getAll();
                    const bomTemplates: BOMTemplate[] = await bomTemplatesStore.getAll();
                    const marketAdjustments: MarketAdjustment[] = await marketAdjustmentsStore.getAll();

                    // 2. Deduct actual stock, clear reserved
                    for (const item of order.items) {
                        const invItem = await inventoryStore.get(item.productId);
                        if (invItem) {
                            // Rule: Use snapshot quantities for deduction if available
                            const qtyToDeduct = item.productionCostSnapshot?.components?.reduce((sum: number, c: any) => sum + (c.quantity || 0), 0) || item.quantity;

                            if (item.variantId && invItem.variants) {
                                const vIdx = invItem.variants.findIndex(v => v.id === item.variantId);
                                if (vIdx !== -1) {
                                    invItem.variants[vIdx].stock = (invItem.variants[vIdx].stock || 0) - qtyToDeduct;
                                    invItem.variants[vIdx].reserved = Math.max(0, (invItem.variants[vIdx].reserved || 0) - qtyToDeduct);
                                }
                            }
                            invItem.stock = (invItem.stock || 0) - qtyToDeduct;
                            invItem.reserved = Math.max(0, (invItem.reserved || 0) - qtyToDeduct);
                            await inventoryStore.put(invItem);
                        }
                    }

                    const cogsLegs = await calculateCogsLegsPerInventoryAccount(
                        order.items || [],
                        inventoryStore,
                        (item) => item.productId,
                        accounts,
                        () => resolveAcct(getGLConfig().defaultInventoryAccount)
                    );
                    const cogsEntries: LedgerEntry[] = [];
                    {
                        const gl = getGLConfig();
                        for (const leg of cogsLegs) {
                            if (!leg.inventoryAccountId) continue;
                            const cogsEntry: LedgerEntry = {
                                id: generateId('LG-COGS'),
                                date: new Date().toISOString(),
                                description: `COGS - Order #${order.orderNumber}`,
                                debitAccountId: resolveAcct(gl.defaultCOGSAccount),
                                creditAccountId: leg.inventoryAccountId,
                                amount: leg.amount,
                                referenceId: order.id,
                                reconciled: false,
                                customerId: order.customerId,
                                customerName: order.customerName
                            };
                            await ledgerStore.put(cogsEntry);
                            cogsEntries.push(cogsEntry);
                        }
                    }
                    if (cogsEntries.length > 0) {
                        validateLedgerBalance(cogsEntries, `COGS split - Order #${order.orderNumber}`);
                    }

                    // 3. Process Market Adjustments for completed orders
                    const cartItems: any[] = order.items.map(item => ({
                        id: item.productId,
                        name: item.productName,
                        price: item.unitPrice,
                        quantity: item.quantity,
                        type: 'Product',
                        cost: item.productionCostSnapshot?.baseProductionCost || 0,
                        variantId: item.variantId,
                        adjustmentSnapshots: item.adjustmentSnapshots,
                        transactionAdjustmentSnapshots: item.transactionAdjustmentSnapshots
                    }));

                    const adjustmentResult = await this._processMarketAdjustments(
                        cartItems,
                        inventory,
                        bomTemplates,
                        marketAdjustments,
                        order.id,
                        'order',
                        inventoryStore
                    );

                    // Store adjustment data on order
                    order.adjustmentSnapshots = adjustmentResult.adjustmentSnapshots.length > 0
                        ? adjustmentResult.adjustmentSnapshots
                        : order.adjustmentSnapshots;
                    order.adjustmentTotal = adjustmentResult.adjustmentTotal > 0
                        ? adjustmentResult.adjustmentTotal
                        : order.adjustmentTotal;
                    order.transactionAdjustments = adjustmentResult.adjustmentTransactions;
                    order.adjustmentSummary = adjustmentResult.adjustmentSummary;

                    // Save adjustment transactions to the store
                    for (const adjTx of adjustmentResult.adjustmentTransactions) {
                        await marketAdjustmentTransactionsStore.put(adjTx);
                    }

                    // 4. Recognize Revenue
                    const gl = getGLConfig();
                    const revenueEntry: LedgerEntry = {
                        id: generateId('LG-ORD-REV'),
                        date: new Date().toISOString(),
                        description: `Revenue recognition for Order #${order.orderNumber}`,
                        debitAccountId: resolveAcct(gl.customerDeposits),
                        creditAccountId: resolveAcct(gl.salesRevenueAccount || gl.incomeAccount),
                        amount: order.totalAmount,
                        referenceId: order.id,
                        reconciled: true,
                        customerId: order.customerId,
                        customerName: order.customerName
                    };
                    await ledgerStore.put(revenueEntry);
                }

                await orderStore.put(order);
                return { success: true };
            }
        );
        return result;
    },

    async cancelOrder(orderId: string, reason: string) {
        if (!orderId || String(orderId).trim() === '') {
            throw new Error("Cannot cancel order: missing order id");
        }
        const result = await dbService.executeAtomicOperation(
            ['salesOrders', 'inventory', 'ledger', 'customers', 'walletTransactions'],
            async (tx) => {
                const orderStore = tx.objectStore('salesOrders');
                const inventoryStore = tx.objectStore('inventory');
                const ledgerStore = tx.objectStore('ledger');
                const customerStore = tx.objectStore('customers');
                const walletStore = tx.objectStore('walletTransactions');

                const order = await orderStore.get(orderId);
                if (!order) throw new Error("Order not found");

                const orderCanonical = salesOrderService.canonicalizeStatus(order.status);
                // Idempotency: if already cancelled, no-op
                if (orderCanonical === 'Cancelled') {
                    return { success: true, message: 'Order already cancelled' };
                }
                if (orderCanonical === 'Fulfilled' || orderCanonical === 'Converted') throw new Error("Cannot cancel a completed order");

                // 1. Release Reserved Stock (skip lines without an inventory key —
                // service/custom lines carry no productId and hold no reservation).
                for (const item of order.items || []) {
                    const productKey = item?.productId || item?.product_id || item?.itemId || item?.item_id;
                    if (!productKey || String(productKey).trim() === '') continue;
                    const invItem = await inventoryStore.get(productKey);
                    if (invItem) {
                        if (item.variantId && invItem.variants) {
                            const vIdx = invItem.variants.findIndex(v => v.id === item.variantId);
                            if (vIdx !== -1) {
                                invItem.variants[vIdx].reserved = Math.max(0, (invItem.variants[vIdx].reserved || 0) - item.quantity);
                            }
                        }
                        invItem.reserved = Math.max(0, (invItem.reserved || 0) - item.quantity);
                        await inventoryStore.put(invItem);
                    }
                }

                // 2. Reverse Payments if any (move to customer wallet)
                if (order.paidAmount > 0) {
                    if (order.customerId) {
                        const customer = await customerStore.get(order.customerId);
                        if (customer) {
                            customer.walletBalance = (customer.walletBalance || 0) + order.paidAmount;
                            await customerStore.put(customer);

                            const walletTx: WalletTransaction = {
                                id: generateId('WLT-CAN'),
                                customerId: order.customerId,
                                date: new Date().toISOString(),
                                type: 'Deposit',
                                amount: order.paidAmount,
                                description: `Refund from Cancelled Order #${order.orderNumber}`
                            };
                            await walletStore.put(walletTx);
                        }
                    }

                    const reversal: LedgerEntry = {
                        id: generateId('LG-ORD-CAN'),
                        date: new Date().toISOString(),
                        description: `Order #${order.orderNumber} Cancelled - Payment refunded to Wallet`,
                        debitAccountId: resolveAcct(gl.customerDeposits),
                        creditAccountId: resolveAcct(gl.walletAccount || gl.bankAccount),
                        amount: order.paidAmount,
                        referenceId: order.id,
                        reconciled: false,
                        customerId: order.customerId,
                        customerName: order.customerName
                    };
                    await ledgerStore.put(reversal);
                }

                order.status = 'Cancelled';
                order.cancelReason = reason;
                await orderStore.put(order);

                // Trigger automatic referral reward reversal for any approved referral rewards linked to this order
                import('./referralService').then(({ referralService }) => {
                    referralService.getAllRewards().then(rewards => {
                        const orderRewards = rewards.filter(r =>
                            r.invoiceId === order.id && r.status === 'approved'
                        );
                        orderRewards.forEach(reward => {
                            referralService.createReversal({
                                reward_id: reward.id,
                                reason: `Order ${order.orderNumber || order.id} was cancelled — reward auto-reversed`
                            }).catch(err => console.error('[Referral] Auto-reversal failed for reward', reward.id, err));
                        });
                    }).catch(err => console.error('[Referral] Could not load rewards for auto-reversal:', err));
                }).catch(err => console.error('[Referral] Could not import referralService for auto-reversal:', err));

                return { success: true };
            }
        );
        return result;
    },

    async createSalesExchangeRequest(exchange: Partial<SalesExchange>) {
        return dbService.executeAtomicOperation(
            ['salesExchanges', 'salesExchangeItems'],
            async (tx) => {
                const exchangeStore = tx.objectStore('salesExchanges');

                // Get all exchanges for ID generation
                const allExchanges = await exchangeStore.getAll();
                const nextId = generateNextId('SE', allExchanges);

                const newExchange: SalesExchange = {
                    ...exchange as SalesExchange,
                    id: nextId, // Using string ID for simplicity in local DB
                    exchange_number: nextId,
                    exchange_date: new Date().toISOString(),
                    status: 'pending',
                    total_price_difference: exchange.total_price_difference || 0
                };

                await exchangeStore.put(newExchange);
                return { success: true, id: nextId };
            }
        );
    },

    async approveSalesExchange(id: string, comments: string) {
        return dbService.executeAtomicOperation(
            ['salesExchanges', 'reprintJobs', 'salesExchangeApprovals', 'ledger', 'inventory', 'accounts'],
            async (tx) => {
                const exchangeStore = tx.objectStore('salesExchanges');
                const reprintStore = tx.objectStore('reprintJobs');
                const approvalStore = tx.objectStore('salesExchangeApprovals');
                const ledgerStore = tx.objectStore('ledger');
                const inventoryStore = tx.objectStore('inventory');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const exchange = await exchangeStore.get(id);
                if (!exchange) throw new Error("Exchange not found");
                if (exchange.status !== 'pending') throw new Error("Only pending exchanges can be approved");

                // 1. Update status
                exchange.status = 'approved';
                await exchangeStore.put(exchange);

                // 2. Create Approval Entry
                const approvalId = generateId('APPR');
                const approval: SalesExchangeApproval = {
                    id: approvalId,
                    exchange_id: id,
                    approved_by: 'Supervisor', // Should get from context in real app
                    approval_date: new Date().toISOString(),
                    comments,
                    status: 'approved'
                };
                await approvalStore.put(approval);

                // 3. Auto-generate Reprint Jobs and Update Inventory
                if (exchange.items) {
                    for (const item of exchange.items) {
                        // Inventory Adjustments
                        const invItem = await inventoryStore.get(item.product_id);
                        if (invItem) {
                            // Increase stock for returned items (if not damaged beyond use)
                            if (item.qty_returned > 0 && item.condition !== 'damaged') {
                            if (item.variant_id && invItem.variants) {
                                const vIdx = invItem.variants.findIndex(v => v.id === item.variant_id);
                                if (vIdx !== -1) {
                                    invItem.variants[vIdx].stock = (invItem.variants[vIdx].stock || 0) + item.qty_returned;
                                }
                            }
                            invItem.stock = (invItem.stock || 0) + item.qty_returned;
                        }
                        // Decrease stock for replaced items
                        if (item.qty_replaced > 0) {
                            if (item.variant_id && invItem.variants) {
                                const vIdx = invItem.variants.findIndex(v => v.id === item.variant_id);
                                    if (vIdx !== -1) {
                                        invItem.variants[vIdx].stock = (invItem.variants[vIdx].stock || 0) - item.qty_replaced;
                                    }
                                }
                                invItem.stock = (invItem.stock || 0) - item.qty_replaced;
                            }
                            await inventoryStore.put(invItem);
                        }

                        // Auto-generate Reprint Jobs for items requiring reprint
                        if (item.reprint_required || item.qty_replaced > 0) {
                            const reprintJob: ReprintJob = {
                                id: generateId('EXCH-REPRINT'),
                                exchange_id: id,
                                job_description: `Reprint for ${item.product_name} (Exchange ${exchange.exchange_number})`,
                                paper_used: "0",
                                ink_used: "0",
                                finishing_cost: 0,
                                total_reprint_cost: 0,
                                status: 'Pending'
                            };
                            await reprintStore.put(reprintJob);
                        }
                    }
                }

                // 4. Financial adjustment (if price difference exists)
                if (exchange.total_price_difference !== 0) {
                    const gl = getGLConfig();
                    const entry: LedgerEntry = {
                        id: generateId('LG-EX'),
                        date: new Date().toISOString(),
                        description: `Exchange Adjustment for SE #${exchange.exchange_number}`,
                        debitAccountId: exchange.total_price_difference > 0 ? resolveAcct(gl.cashDrawerAccount || gl.bankAccount) : resolveAcct(gl.otherIncomeAccount || gl.salesRevenueAccount),
                        creditAccountId: exchange.total_price_difference > 0 ? resolveAcct(gl.otherIncomeAccount || gl.salesRevenueAccount) : resolveAcct(gl.cashDrawerAccount || gl.bankAccount),
                        amount: Math.abs(exchange.total_price_difference),
                        referenceId: id,
                        reconciled: false,
                        customerId: exchange.customer_id,
                        customerName: exchange.customer_name
                    };
                    await ledgerStore.put(entry);
                }

                return { success: true };
            }
        );
    },

    async recordSupplierPayment(payment: SupplierPayment) {
        return dbService.executeAtomicOperation(
            ['supplierPayments', 'purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'supplier_payment', payment.id, payment.idempotencyKey);

                const paymentStore = tx.objectStore('supplierPayments');
                const purchaseStore = tx.objectStore('purchases');
                const invoiceStore = tx.objectStore('purchaseInvoices');
                const supplierStore = tx.objectStore('suppliers');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                // 1. Save the payment (with its permanent, idempotent
                // verification token — single non-accounting field; all
                // ledger/AP postings below are untouched).
                // 1b. Generic invoice application (all supplier purchase
                // invoices, landing bills included): allocation-linked
                // invoices first, then oldest pending/partial. Paid amounts
                // drive invoice status pending/partial/paid, so
                // invoice.paid_amount always equals applied payments.
                const invoiceApplications: { invoiceId: string; amount: number }[] = [];
                {
                    const linkedPOs = new Set(
                        ((payment as any).allocations || []).map((a: any) => String(a?.purchaseId || a?.purchaseOrderId || ''))
                    );
                    const openInvoices = (await invoiceStore.getAll())
                        .filter((inv: any) => inv
                            && String(inv.supplier_id || '') === String(payment.supplierId)
                            && (inv.status === 'pending' || inv.status === 'partial')
                            && (Number(inv.total_amount) - Number(inv.paid_amount || 0)) > 0.005);
                    openInvoices.sort((a: any, b: any) => {
                        const aLinked = a.purchase_order_id && linkedPOs.has(String(a.purchase_order_id)) ? 0 : 1;
                        const bLinked = b.purchase_order_id && linkedPOs.has(String(b.purchase_order_id)) ? 0 : 1;
                        if (aLinked !== bLinked) return aLinked - bLinked;
                        return String(a.invoice_date || '').localeCompare(String(b.invoice_date || ''));
                    });
                    let toApply = Number(payment.amount) || 0;
                    for (const inv of openInvoices) {
                        if (!(toApply > 0.005)) {
                            break;
                        }
                        const outstanding = Number(inv.total_amount) - Number(inv.paid_amount || 0);
                        if (!(outstanding > 0.005)) {
                            continue;
                        }
                        const applied = Math.min(outstanding, toApply);
                        inv.paid_amount = (Number(inv.paid_amount) || 0) + applied;
                        inv.status = (Number(inv.total_amount) - Number(inv.paid_amount)) <= 0.005 ? 'paid' : 'partial';
                        inv.updated_at = new Date().toISOString();
                        await invoiceStore.put(inv);
                        invoiceApplications.push({ invoiceId: inv.id, amount: applied });
                        toApply -= applied;
                    }
                }
                (payment as any).invoiceApplications = invoiceApplications;
                await paymentStore.put(ensureDocumentVerificationToken({ ...(payment as any) }));

                // 2. Update linked Purchase Orders
                if (payment.allocations && payment.allocations.length > 0) {
                    for (const allocation of payment.allocations) {
                        const po = await purchaseStore.get(allocation.purchaseId);
                        if (po) {
                            po.paidAmount = (po.paidAmount || 0) + allocation.amount;
                            po.paymentStatus = derivePurchasePaymentStatus(po);
                            await purchaseStore.put(po);
                        }
                    }
                }

                // 3. Update Supplier Balance
                const supplier = await supplierStore.get(payment.supplierId);
                if (supplier) {
                    supplier.balance = (supplier.balance || 0) - payment.amount;
                    await supplierStore.put(supplier);
                }

                // 4. Ledger Entry
                const gl = getGLConfig();
                let targetCreditAccount = gl.bankAccount;

                if (payment.accountId) {
                    targetCreditAccount = payment.accountId;
                } else {
                    if (payment.paymentMethod === 'Cash') targetCreditAccount = gl.cashDrawerAccount;
                    if (payment.paymentMethod === 'Mobile Money') targetCreditAccount = gl.mobileMoneyAccount;
                    if (payment.paymentMethod === 'Wallet') targetCreditAccount = gl.customerWalletAccount;
                }

                const ledgerEntry: LedgerEntry = {
                    id: generateId('LG-SPAY'),
                    date: payment.date,
                    description: `Supplier Payment #${payment.id} to ${payment.supplierId}`,
                    debitAccountId: resolveAcct(gl.accountsPayable),
                    creditAccountId: resolveAcct(targetCreditAccount),
                    amount: payment.amount,
                    referenceId: payment.id,
                    reconciled: false
                };
                await ledgerStore.put(ledgerEntry);

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: payment.date,
                    amount: payment.amount,
                    type: 'Withdrawal',
                    description: `Supplier Payment #${payment.id}`,
                    reference: `SPAY-${payment.id}`,
                    accountId: targetCreditAccount,
                    paymentMethod: payment.paymentMethod,
                    category: 'Expense',
                    counterpartyName: payment.supplierId
                });

                return { success: true };
            }
        );
    },

    async updateSupplierPayment(payment: SupplierPayment) {
        return dbService.executeAtomicOperation(
            ['supplierPayments'],
            async (tx) => {
                const store = tx.objectStore('supplierPayments');
                // Never rotate or drop the verification identity on edit.
                const existing = payment?.id ? await store.get(payment.id) : null;
                const next = { ...(payment as any) };
                if (existing && (existing as any).verificationToken && !next.verificationToken) {
                    next.verificationToken = (existing as any).verificationToken;
                }
                await store.put(ensureDocumentVerificationToken(next));
                return { success: true };
            }
        );
    },

    async voidSupplierPayment(paymentId: string) {
        return dbService.executeAtomicOperation(
            ['supplierPayments', 'purchases', 'purchaseInvoices', 'ledger', 'suppliers', 'bankAccounts', 'bankTransactions', 'idempotencyKeys', 'accounts'],
            async (tx) => {
                await reserveIdempotencyKey(tx, 'supplier_payment_void', paymentId);

                const paymentStore = tx.objectStore('supplierPayments');
                const purchaseStore = tx.objectStore('purchases');
                const supplierStore = tx.objectStore('suppliers');
                const ledgerStore = tx.objectStore('ledger');
                const bankAccountsStore = tx.objectStore('bankAccounts');
                const bankTransactionsStore = tx.objectStore('bankTransactions');

                const accounts = await loadAccountsFromStore(tx);
                const companyConfig = getCompanyConfig();
                const companyId = companyConfig?.companyId;
                const accountOptions = { allowNonPosting: false, companyId };
                const resolveAcct = (ref: string | undefined) => {
                    if (!ref) {
                        throw new UnresolvedAccountError(ref || 'undefined');
                    }
                    const resolved = resolveAccountForPosting(ref, accounts, accountOptions);
                    if (!resolved) {
                        throw new UnresolvedAccountError(ref);
                    }
                    return resolved;
                };

                const payment = await paymentStore.get(paymentId);
                if (!payment) throw new Error("Payment not found");

                // 1. Reverse Purchase Orders balances
                if (payment.allocations && payment.allocations.length > 0) {
                    for (const allocation of payment.allocations) {
                        const po = await purchaseStore.get(allocation.purchaseId);
                        if (po) {
                            po.paidAmount = Math.max(0, (po.paidAmount || 0) - allocation.amount);
                            po.paymentStatus = derivePurchasePaymentStatus(po);
                            await purchaseStore.put(po);
                        }
                    }
                }

                // 2. Reverse Supplier Balance
                const supplier = await supplierStore.get(payment.supplierId);
                if (supplier) {
                    supplier.balance = (supplier.balance || 0) + payment.amount;
                    await supplierStore.put(supplier);
                }

                // 2b. Reverse invoice applications recorded by
                // recordSupplierPayment (generic primitive symmetry): subtract
                // exactly what was applied; recompute pending/partial/paid.
                // Payments predating application tracking carry no
                // invoiceApplications and reverse nothing here.
                for (const app of ((payment as any).invoiceApplications || [])) {
                    const inv = await tx.objectStore('purchaseInvoices').get(String((app as any).invoiceId));
                    if (!inv) {
                        continue;
                    }
                    inv.paid_amount = Math.max(0, (Number(inv.paid_amount) || 0) - (Number((app as any).amount) || 0));
                    const outstanding = Number(inv.total_amount) - Number(inv.paid_amount);
                    inv.status = outstanding <= 0.005 ? 'paid' : (Number(inv.paid_amount) > 0.005 ? 'partial' : 'pending');
                    inv.updated_at = new Date().toISOString();
                    await tx.objectStore('purchaseInvoices').put(inv);
                }

                // 3. Mark Payment as Voided
                payment.status = 'Voided';
                await paymentStore.put(payment);

                // 4. Ledger Entry for Reversal
                const gl = getGLConfig();
                let targetDebitAccount = gl.bankAccount;
                if (payment.paymentMethod === 'Cash') targetDebitAccount = gl.cashDrawerAccount;

                const reversalEntry: LedgerEntry = {
                    id: generateId('LG-SPAY-VOID'),
                    date: new Date().toISOString(),
                    description: `REVERSAL: Supplier Payment #${payment.id} voided`,
                    debitAccountId: resolveAcct(targetDebitAccount),
                    creditAccountId: resolveAcct(gl.accountsPayable),
                    amount: payment.amount,
                    referenceId: payment.id,
                    reconciled: false
                };
                await ledgerStore.put(reversalEntry);

                await ensureMirroredBankTransaction({
                    bankAccountsStore,
                    bankTransactionsStore,
                    date: new Date().toISOString(),
                    amount: payment.amount,
                    type: 'Deposit',
                    description: `Supplier Payment Reversal #${payment.id}`,
                    reference: `SPAY-VOID-${payment.id}`,
                    accountId: targetDebitAccount,
                    paymentMethod: payment.paymentMethod,
                    category: 'Transfer',
                    counterpartyName: payment.supplierId
                });

                return { success: true };
            }
        );
    },

    async processOverpaymentToWallet(invoice, overpaymentAmount) {
        const walletTx = {
            id: `WALLET-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            customerId: invoice.customerId || invoice.customerName,
            customerName: invoice.customerName,
            amount: overpaymentAmount,
            type: 'deposit',
            reference: invoice.id,
            description: `Overpayment credit from invoice #${invoice.id}`,
            date: new Date().toISOString()
        };
        await dbService.put('walletTransactions', walletTx);
        const customer = await dbService.get<Customer>('customers', walletTx.customerId);
        if (customer) {
            customer.walletBalance = (customer.walletBalance || 0) + overpaymentAmount;
            await dbService.put('customers', customer);
        }
        return walletTx;
    },

    async clearStaleIdempotencyKeys(scope?: string, maxAgeMinutes = 60) {
        const allKeys = await dbService.getAll('idempotencyKeys');
        const cutoff = new Date(Date.now() - maxAgeMinutes * 60000);
        let cleared = 0;
        for (const key of allKeys) {
            if (scope && key.scope !== scope) continue;
            if (new Date(key.createdAt) < cutoff) {
                await dbService.executeAtomicOperation(
                    ['idempotencyKeys'],
                    async (tx: any) => {
                        await tx.objectStore('idempotencyKeys').delete(key.id);
                    }
                );
                cleared++;
            }
        }
        return { cleared, scope: scope || 'all', maxAgeMinutes };
    }
};

import { dbService } from './db';
import { getCustomerDisplayName } from '../utils/customerDisplay';
import { logger } from './logger';

/**
 * Customer rename propagation.
 *
 * The `customers` record is the single source of truth for a customer's
 * display name. Every transaction store denormalizes that name onto its own
 * rows (`customerName`, sometimes `customer_name`) so lists, receipts and
 * statements can render without a second lookup.
 *
 * When a client is renamed, the denormalized copies MUST be rewritten as
 * well. Otherwise the same customer appears twice in the books: once under
 * the old name (all previous transactions) and once under the new name
 * (everything booked after the edit). This module performs that rewrite,
 * locally and (through the normal store write path) on the cloud.
 */

export interface CustomerNamePropagationTarget {
    /** IndexedDB store that denormalizes the customer display name. */
    store: string;
    /** Row fields that link the record back to the customers record. */
    idFields: string[];
    /** Row fields carrying the denormalized name — canonical field first. */
    nameFields: string[];
}

/**
 * Stores whose rows carry a customer display name.
 *
 * Deliberately excluded:
 * - `ledger` / `statementSnapshots`: posted accounting narratives and signed,
 *   point-in-time statement documents are immutable records, not a live
 *   customer label. The `customerId` link (not the denormalized name) drives
 *   reporting for those.
 * - `examinationBatches`: examination drafts carry school naming that the
 *   examination module owns end-to-end; the invoices they produce ARE
 *   propagated through `invoices`.
 */
export const CUSTOMER_NAME_PROPAGATION_TARGETS: CustomerNamePropagationTarget[] = [
    { store: 'sales', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
    { store: 'invoices', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
    { store: 'quotations', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'orders', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'customerPayments', idFields: ['customerId'], nameFields: ['customerName', 'customer_name'] },
    { store: 'salesOrders', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'jobOrders', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'jobTickets', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'deliveryNotes', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'shipments', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'recurringInvoices', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'salesExchanges', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'workOrders', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'batches', idFields: ['customerId'], nameFields: ['customerName'] },
    { store: 'assessmentContracts', idFields: ['customerId', 'customer_id'], nameFields: ['customerName', 'customer_name'] },
];

export interface CustomerRenamePlanEntry {
    store: string;
    id: string;
    /** Fields to overwrite, merged onto the existing row by the caller. */
    patch: Record<string, unknown>;
}

export interface CustomerRenamePlan {
    entries: CustomerRenamePlanEntry[];
    /**
     * True when a DIFFERENT live customer still answers to the previous name.
     * Unlinked legacy rows (no customerId) are then left alone, because they
     * cannot be attributed to this customer with any confidence.
     */
    ambiguousPreviousName: boolean;
}

export interface CustomerRenamePlanInput {
    customerId: string;
    previousName: string;
    nextName: string;
    rowsByStore: Record<string, Array<Record<string, any>>>;
    /** Display names of every OTHER live customer. */
    otherCustomerNames?: string[];
}

const normalizeName = (value: unknown): string => String(value ?? '').trim();

const isSameName = (a: unknown, b: unknown): boolean =>
    normalizeName(a).toLowerCase() === normalizeName(b).toLowerCase();

/** Soft-deleted rows are history — their stored label is left untouched. */
const isDeletedRow = (row: Record<string, any>): boolean =>
    row?.deleted === true || Boolean(row?.deletedAt);

/**
 * Pure rename planner: decides which rows change and to what. Kept free of
 * storage access so the matching rules can be tested directly.
 */
export function planCustomerRename(input: CustomerRenamePlanInput): CustomerRenamePlan {
    const customerId = normalizeName(input.customerId);
    const previousName = normalizeName(input.previousName);
    const nextName = normalizeName(input.nextName);

    if (!customerId || !previousName || !nextName || isSameName(previousName, nextName)) {
        return { entries: [], ambiguousPreviousName: false };
    }

    const ambiguousPreviousName = (input.otherCustomerNames || [])
        .some((name) => isSameName(name, previousName));

    const entries: CustomerRenamePlanEntry[] = [];

    for (const target of CUSTOMER_NAME_PROPAGATION_TARGETS) {
        const rows = input.rowsByStore?.[target.store];
        if (!Array.isArray(rows) || rows.length === 0) continue;

        const canonicalField = target.nameFields[0];

        for (const row of rows) {
            if (!row || row.id == null || isDeletedRow(row)) continue;

            const linked = target.idFields.some((field) => {
                const value = row[field];
                return value != null && String(value).trim() !== '' && String(value) === customerId;
            });

            // A row that carries a link to a DIFFERENT customer is somebody
            // else's transaction, however similar its label looks.
            const linkedElsewhere = target.idFields.some((field) => {
                const value = row[field];
                return value != null && String(value).trim() !== '' && String(value) !== customerId;
            });
            if (linkedElsewhere) continue;

            const carriesPreviousName = target.nameFields.some((field) => {
                const value = row[field];
                return typeof value === 'string' && isSameName(value, previousName);
            });

            // Linked rows: the id is authoritative, rewrite the stale label.
            // Unlinked legacy rows: only when they still carry the previous
            // name AND no other customer answers to it — otherwise this
            // rename would silently re-parent somebody else's history.
            if (!linked && !(carriesPreviousName && !ambiguousPreviousName)) continue;

            const hasAnyName = target.nameFields.some((field) => {
                const value = row[field];
                return typeof value === 'string' && normalizeName(value).length > 0;
            });

            const patch: Record<string, unknown> = {};
            for (const field of target.nameFields) {
                const current = row[field];
                if (typeof current === 'string') {
                    if (isSameName(current, previousName)) patch[field] = nextName;
                    continue;
                }
                // Linked row that never denormalized the name at all: fill it
                // in so this customer's documents no longer need a lookup.
                // Rows that already carry a name in another field are left
                // alone — they are either already correct or deliberately
                // custom.
                if (linked && field === canonicalField && !hasAnyName) {
                    patch[field] = nextName;
                }
            }

            if (Object.keys(patch).length > 0) {
                entries.push({ store: target.store, id: String(row.id), patch });
            }
        }
    }

    return { entries, ambiguousPreviousName };
}

export interface CustomerRenamePropagationResult {
    updatedRecords: number;
    stores: string[];
    ambiguousPreviousName: boolean;
}

/**
 * Same-tab serialization so two overlapping saves (double-click, React
 * duplicate render) cannot interleave renames of one customer.
 */
const inflightRenames = new Map<string, Promise<CustomerRenamePropagationResult>>();

/**
 * Rewrite the denormalized customer name on every transaction that belongs to
 * `customerId`. Writes go through `dbService.put`, so each updated row is
 * persisted locally and queued for the cloud exactly like a normal edit.
 */
export async function propagateCustomerRename(params: {
    customerId: string;
    previousName: string;
    nextName: string;
    /** Live customers used for the name-collision guard. */
    customers?: Array<Record<string, any>>;
}): Promise<CustomerRenamePropagationResult> {
    const customerId = normalizeName(params.customerId);
    const previousName = normalizeName(params.previousName);
    const nextName = normalizeName(params.nextName);

    if (!customerId || !previousName || !nextName || isSameName(previousName, nextName)) {
        return { updatedRecords: 0, stores: [], ambiguousPreviousName: false };
    }

    const inflight = inflightRenames.get(customerId);
    if (inflight) return inflight;

    const run = (async (): Promise<CustomerRenamePropagationResult> => {
        const customers = params.customers ?? await dbService.getAll<Record<string, any>>('customers');
        const otherCustomerNames = customers
            .filter((customer) => String(customer?.id) !== customerId)
            .map((customer) => getCustomerDisplayName({
                businessName: customer?.businessName,
                companyName: customer?.companyName,
                legacyCustomerName: customer?.name,
            }))
            .filter((name) => name.length > 0);

        const rowsByStore: Record<string, Array<Record<string, any>>> = {};
        for (const target of CUSTOMER_NAME_PROPAGATION_TARGETS) {
            rowsByStore[target.store] = await dbService.getAll<Record<string, any>>(target.store as any);
        }

        const plan = planCustomerRename({
            customerId,
            previousName,
            nextName,
            rowsByStore,
            otherCustomerNames,
        });

        let updatedRecords = 0;
        const stores = new Set<string>();

        for (const entry of plan.entries) {
            const row = rowsByStore[entry.store].find((candidate) => String(candidate?.id) === entry.id);
            if (!row) continue;
            await dbService.put(entry.store as any, { ...row, ...entry.patch });
            stores.add(entry.store);
            updatedRecords += 1;
        }

        if (updatedRecords > 0) {
            logger.info('[customerRename] propagated rename', {
                customerId,
                previousName,
                nextName,
                updatedRecords,
                stores: Array.from(stores),
            });
        }

        return { updatedRecords, stores: Array.from(stores), ambiguousPreviousName: plan.ambiguousPreviousName };
    })();

    inflightRenames.set(customerId, run);
    try {
        return await run;
    } finally {
        inflightRenames.delete(customerId);
    }
}

/**
 * Convenience resolver for the display name of a customer record, using the
 * single authoritative resolver in `utils/customerDisplay`.
 */
export function resolveCustomerDisplayName(customer: Record<string, any> | null | undefined): string {
    if (!customer) return '';
    return getCustomerDisplayName({
        businessName: customer.businessName,
        companyName: customer.companyName,
        legacyCustomerName: customer.name,
    });
}

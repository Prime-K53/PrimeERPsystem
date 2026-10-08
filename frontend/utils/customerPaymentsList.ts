/**
 * customerPaymentsList.ts
 *
 * Pure, UI-agnostic helpers for the admin Customer Payments list page.
 * Covers the high-priority upgrades: allocation status, advanced filtering,
 * server-style sorting/pagination, summary stats, and CSV export.
 */

export type AllocationStatus = 'unallocated' | 'partial' | 'allocated';

export interface PaymentAllocationLike {
    invoiceId?: string;
    orderId?: string;
    amount?: number;
    [key: string]: unknown;
}

export interface CustomerPaymentLike {
    id: string;
    customerId?: string;
    customerName?: string;
    amount?: number;
    date?: string;
    paymentMethod?: string;
    method?: string;
    accountId?: string;
    reference?: string;
    notes?: string;
    status?: string;
    reconciled?: boolean;
    createdBy?: string;
    createdAt?: string;
    updatedAt?: string;
    allocations?: PaymentAllocationLike[];
    orderAllocations?: PaymentAllocationLike[];
    [key: string]: unknown;
}

export interface PaymentListFilters {
    search?: string;
    method?: string; // 'all' | concrete method
    status?: string; // 'all' | Cleared | Pending | Voided | ...
    allocation?: 'all' | AllocationStatus;
    dateFrom?: string; // YYYY-MM-DD
    dateTo?: string; // YYYY-MM-DD
    minAmount?: number | '';
    maxAmount?: number | '';
    reconciled?: 'all' | 'reconciled' | 'unreconciled';
    invoiceId?: string;
}

export type PaymentSortKey = 'date' | 'amount' | 'customerName' | 'status' | 'allocated';
export type SortDir = 'asc' | 'desc';

export function getAllocatedTotal(payment: CustomerPaymentLike): number {
    const inv = (payment.allocations || []).reduce((s, a) => s + (Number(a?.amount) || 0), 0);
    const ord = (payment.orderAllocations || []).reduce((s, a) => s + (Number(a?.amount) || 0), 0);
    return Math.round((inv + ord) * 100) / 100;
}

export function getUnallocatedTotal(payment: CustomerPaymentLike): number {
    const amount = Number(payment.amount) || 0;
    return Math.round((amount - getAllocatedTotal(payment)) * 100) / 100;
}

export function getAllocationStatus(payment: CustomerPaymentLike): AllocationStatus {
    const amount = Number(payment.amount) || 0;
    const allocated = getAllocatedTotal(payment);
    if (allocated <= 0.009) return 'unallocated';
    if (allocated + 0.01 >= amount) return 'allocated';
    return 'partial';
}

export function getPaymentMethodKey(payment: CustomerPaymentLike): string {
    return String(payment.paymentMethod || payment.method || 'Cash');
}

/** Invoice numbers referenced by this payment (for display + search). */
export function getPaymentInvoiceRefs(payment: CustomerPaymentLike): string[] {
    const refs: string[] = [];
    for (const a of payment.allocations || []) {
        if (a?.invoiceId) refs.push(String(a.invoiceId));
    }
    return refs;
}

const norm = (v: unknown): string => String(v ?? '').toLowerCase();

export function filterCustomerPayments<T extends CustomerPaymentLike>(
    list: T[],
    filters: PaymentListFilters,
): T[] {
    const search = (filters.search || '').trim().toLowerCase();
    const method = filters.method && filters.method !== 'all' ? filters.method.toLowerCase() : '';
    const status = filters.status && filters.status !== 'all' ? filters.status.toLowerCase() : '';
    const allocation = filters.allocation && filters.allocation !== 'all' ? filters.allocation : null;
    const reconciled = filters.reconciled && filters.reconciled !== 'all' ? filters.reconciled : null;
    const invoiceId = (filters.invoiceId || '').trim().toLowerCase();
    const min = filters.minAmount === '' || filters.minAmount == null ? NaN : Number(filters.minAmount);
    const max = filters.maxAmount === '' || filters.maxAmount == null ? NaN : Number(filters.maxAmount);
    const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : NaN;
    const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : NaN;

    return (list || []).filter((p) => {
        if (method && norm(getPaymentMethodKey(p)) !== method) return false;
        if (status && norm(p.status) !== status) return false;
        if (allocation && getAllocationStatus(p) !== allocation) return false;
        if (reconciled === 'reconciled' && !p.reconciled) return false;
        if (reconciled === 'unreconciled' && p.reconciled) return false;
        if (invoiceId && !getPaymentInvoiceRefs(p).some((r) => r.toLowerCase().includes(invoiceId))) return false;

        const amt = Number(p.amount) || 0;
        if (!Number.isNaN(min) && amt < min) return false;
        if (!Number.isNaN(max) && amt > max) return false;

        if (!Number.isNaN(from) || !Number.isNaN(to)) {
            const t = p.date ? new Date(p.date).getTime() : NaN;
            if (Number.isNaN(t)) return false;
            if (!Number.isNaN(from) && t < from) return false;
            if (!Number.isNaN(to) && t > to) return false;
        }

        if (search) {
            const hay = [
                p.id,
                p.customerName,
                p.customerId,
                p.reference,
                p.notes,
                getPaymentMethodKey(p),
                p.status,
                String(p.amount ?? ''),
                ...getPaymentInvoiceRefs(p),
                ...(p.orderAllocations || []).map((a) => String(a?.orderId || '')),
            ]
                .map(norm)
                .join(' | ');
            if (!hay.includes(search)) return false;
        }
        return true;
    });
}

export function sortCustomerPayments<T extends CustomerPaymentLike>(
    list: T[],
    sortBy: PaymentSortKey = 'date',
    dir: SortDir = 'desc',
): T[] {
    const mul = dir === 'asc' ? 1 : -1;
    return [...(list || [])].sort((a, b) => {
        switch (sortBy) {
            case 'amount':
                return (Number(a.amount) - Number(b.amount)) * mul;
            case 'customerName':
                return String(a.customerName || '').localeCompare(String(b.customerName || '')) * mul;
            case 'status':
                return String(a.status || '').localeCompare(String(b.status || '')) * mul;
            case 'allocated':
                return (getAllocatedTotal(a) - getAllocatedTotal(b)) * mul;
            case 'date':
            default:
                return (new Date(a.date || 0).getTime() - new Date(b.date || 0).getTime()) * mul;
        }
    });
}

export function paginateList<T>(list: T[], page: number, pageSize: number): { rows: T[]; total: number; totalPages: number; page: number } {
    const total = (list || []).length;
    const safeSize = Math.max(1, Math.min(200, Math.floor(pageSize) || 25));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const safePage = Math.max(1, Math.min(totalPages, Math.floor(page) || 1));
    const start = (safePage - 1) * safeSize;
    return { rows: (list || []).slice(start, start + safeSize), total, totalPages, page: safePage };
}

export interface PaymentSummary {
    count: number;
    totalAmount: number;
    totalAllocated: number;
    totalUnallocated: number;
    byStatus: Record<string, number>;
    byMethod: Record<string, number>;
    byAllocation: Record<AllocationStatus, number>;
}

export function summarizePayments(list: CustomerPaymentLike[]): PaymentSummary {
    const summary: PaymentSummary = {
        count: (list || []).length,
        totalAmount: 0,
        totalAllocated: 0,
        totalUnallocated: 0,
        byStatus: {},
        byMethod: {},
        byAllocation: { unallocated: 0, partial: 0, allocated: 0 },
    };
    for (const p of list || []) {
        const amt = Number(p.amount) || 0;
        const allocated = getAllocatedTotal(p);
        summary.totalAmount = Math.round((summary.totalAmount + amt) * 100) / 100;
        summary.totalAllocated = Math.round((summary.totalAllocated + allocated) * 100) / 100;
        const st = String(p.status || 'Unknown');
        summary.byStatus[st] = (summary.byStatus[st] || 0) + 1;
        const m = getPaymentMethodKey(p);
        summary.byMethod[m] = (summary.byMethod[m] || 0) + 1;
        summary.byAllocation[getAllocationStatus(p)] += 1;
    }
    summary.totalUnallocated = Math.round((summary.totalAmount - summary.totalAllocated) * 100) / 100;
    return summary;
}

function csvCell(v: unknown): string {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function paymentsToCsv(list: CustomerPaymentLike[]): string {
    const header = ['Payment #', 'Date', 'Customer', 'Method', 'Status', 'Allocation', 'Amount', 'Allocated', 'Unallocated', 'Reference', 'Invoices', 'Reconciled'];
    const lines = [header.map(csvCell).join(',')];
    for (const p of list || []) {
        const allocated = getAllocatedTotal(p);
        lines.push(
            [
                p.id,
                p.date ? new Date(p.date).toISOString().slice(0, 10) : '',
                p.customerName || '',
                getPaymentMethodKey(p),
                p.status || '',
                getAllocationStatus(p),
                Number(p.amount) || 0,
                allocated,
                getUnallocatedTotal(p),
                p.reference || '',
                getPaymentInvoiceRefs(p).join('; '),
                p.reconciled ? 'yes' : 'no',
            ]
                .map(csvCell)
                .join(','),
        );
    }
    return lines.join('\n');
}

export function downloadCsv(filename: string, csv: string): void {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

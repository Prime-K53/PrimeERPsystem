/**
 * examinationInvoicesList.ts
 *
 * Pure, UI-agnostic helpers for the Examination → Invoices page
 * (views/examination/ExaminationInvoices.tsx).
 *
 * Covers: balance due, overdue/aging, advanced filtering, sorting,
 * pagination, summary KPIs and CSV export. The canonical selection
 * (selectExaminationInvoices) and batch join stay in the view — this
 * module only operates on the resulting rows.
 */
import { resolveExaminationVerificationReadiness } from './invoiceIdentity';

export interface ExamInvoiceLike {
    id: string;
    invoiceNumber: string;
    customerName: string;
    batchId?: string | null;
    batchNumber?: string;
    batchRecordId?: string;
    date?: string;
    dueDate?: string;
    totalAmount?: number;
    paidAmount?: number;
    status?: string;
    verificationToken?: string;
    [key: string]: unknown;
}

export type ExamInvoiceSortKey = 'date' | 'dueDate' | 'amount' | 'balance' | 'customer' | 'status';
export type SortDir = 'asc' | 'desc';
export type ReadinessFilter = 'all' | 'verifiable' | 'pending-sync' | 'unverifiable';

export interface ExamInvoiceFilters {
    search?: string;
    status?: string; // '' = all (case-insensitive exact)
    readiness?: ReadinessFilter;
    dateFrom?: string; // YYYY-MM-DD
    dateTo?: string; // YYYY-MM-DD
    minAmount?: number | '';
    maxAmount?: number | '';
    overdueOnly?: boolean;
    batch?: string; // substring match on batch number
}

const TERMINAL_STATUSES = new Set(['voided', 'void', 'cancelled']);
const PAID_STATUSES = new Set(['paid']);

export function getExamInvoiceBalance(row: ExamInvoiceLike): number {
    const total = Number(row?.totalAmount) || 0;
    const paid = Number(row?.paidAmount) || 0;
    return Math.round(Math.max(0, total - paid) * 100) / 100;
}

export function isExamInvoiceTerminal(row: ExamInvoiceLike): boolean {
    return TERMINAL_STATUSES.has(String(row?.status || '').toLowerCase());
}

function startOfDay(value: Date): Date {
    const copy = new Date(value);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

/** Days past the due date (0 when not overdue or not yet due). */
export function getExamInvoiceDaysOverdue(row: ExamInvoiceLike, now: Date = new Date()): number {
    if (!row?.dueDate) return 0;
    if (isExamInvoiceTerminal(row)) return 0;
    if (PAID_STATUSES.has(String(row?.status || '').toLowerCase())) return 0;
    if (getExamInvoiceBalance(row) <= 0.005) return 0;
    const due = new Date(row.dueDate);
    if (Number.isNaN(due.getTime())) return 0;
    const diff = startOfDay(now).getTime() - startOfDay(due).getTime();
    return diff > 0 ? Math.floor(diff / 86400000) : 0;
}

export function isExamInvoiceOverdue(row: ExamInvoiceLike, now: Date = new Date()): boolean {
    return getExamInvoiceDaysOverdue(row, now) > 0;
}

export function filterExamInvoices<T extends ExamInvoiceLike>(
    list: T[],
    filters: ExamInvoiceFilters,
    pendingIds?: ReadonlyArray<unknown>,
    now: Date = new Date(),
): T[] {
    const search = (filters.search || '').trim().toLowerCase();
    const status = (filters.status || '').trim().toLowerCase();
    const readiness = filters.readiness && filters.readiness !== 'all' ? filters.readiness : null;
    const batch = (filters.batch || '').trim().toLowerCase();
    const min = filters.minAmount === '' || filters.minAmount == null ? NaN : Number(filters.minAmount);
    const max = filters.maxAmount === '' || filters.maxAmount == null ? NaN : Number(filters.maxAmount);
    const from = filters.dateFrom ? new Date(`${filters.dateFrom}T00:00:00`).getTime() : NaN;
    const to = filters.dateTo ? new Date(`${filters.dateTo}T23:59:59.999`).getTime() : NaN;

    return (list || []).filter((row) => {
        if (status && String(row.status || '').toLowerCase() !== status) return false;
        if (readiness && resolveExaminationVerificationReadiness(row, pendingIds) !== readiness) return false;
        if (batch && !String((row as ExamInvoiceLike).batchNumber || '').toLowerCase().includes(batch)) return false;
        if (filters.overdueOnly && !isExamInvoiceOverdue(row, now)) return false;

        const total = Number(row.totalAmount) || 0;
        if (!Number.isNaN(min) && total < min) return false;
        if (!Number.isNaN(max) && total > max) return false;

        if (!Number.isNaN(from) || !Number.isNaN(to)) {
            const t = row.date ? new Date(row.date).getTime() : NaN;
            if (Number.isNaN(t)) return false;
            if (!Number.isNaN(from) && t < from) return false;
            if (!Number.isNaN(to) && t > to) return false;
        }

        if (search) {
            const hay = [row.invoiceNumber, row.id, row.customerName, row.batchNumber, row.status]
                .map((v) => String(v || '').toLowerCase())
                .join(' | ');
            if (!hay.includes(search)) return false;
        }
        return true;
    });
}

export function sortExamInvoices<T extends ExamInvoiceLike>(
    list: T[],
    sortBy: ExamInvoiceSortKey = 'date',
    dir: SortDir = 'desc',
): T[] {
    const mul = dir === 'asc' ? 1 : -1;
    return [...(list || [])].sort((a, b) => {
        switch (sortBy) {
            case 'dueDate':
                return (new Date(a.dueDate || 0).getTime() - new Date(b.dueDate || 0).getTime()) * mul;
            case 'amount':
                return (Number(a.totalAmount) - Number(b.totalAmount)) * mul;
            case 'balance':
                return (getExamInvoiceBalance(a) - getExamInvoiceBalance(b)) * mul;
            case 'customer':
                return String(a.customerName || '').localeCompare(String(b.customerName || '')) * mul;
            case 'status':
                return String(a.status || '').localeCompare(String(b.status || '')) * mul;
            case 'date':
            default:
                return (String(a.date || '').localeCompare(String(b.date || ''))) * mul;
        }
    });
}

export function paginateExamInvoices<T>(list: T[], page: number, pageSize: number): { rows: T[]; total: number; totalPages: number; page: number } {
    const total = (list || []).length;
    const safeSize = Math.max(1, Math.min(200, Math.floor(pageSize) || 25));
    const totalPages = Math.max(1, Math.ceil(total / safeSize));
    const safePage = Math.max(1, Math.min(totalPages, Math.floor(page) || 1));
    const start = (safePage - 1) * safeSize;
    return { rows: (list || []).slice(start, start + safeSize), total, totalPages, page: safePage };
}

export interface ExamInvoiceAging {
    current: number;
    days1to30: number;
    days31to60: number;
    days60plus: number;
}

export interface ExamInvoiceSummary {
    count: number;
    billed: number;
    collected: number;
    outstanding: number;
    collectionRate: number; // 0..1
    overdueCount: number;
    overdueAmount: number;
    byStatus: Record<string, number>;
    aging: ExamInvoiceAging;
}

export function summarizeExamInvoices(list: ExamInvoiceLike[], now: Date = new Date()): ExamInvoiceSummary {
    const summary: ExamInvoiceSummary = {
        count: (list || []).length,
        billed: 0,
        collected: 0,
        outstanding: 0,
        collectionRate: 0,
        overdueCount: 0,
        overdueAmount: 0,
        byStatus: {},
        aging: { current: 0, days1to30: 0, days31to60: 0, days60plus: 0 },
    };
    for (const row of list || []) {
        const total = Number(row?.totalAmount) || 0;
        const balance = getExamInvoiceBalance(row);
        const collected = Math.round(Math.min(Math.max(0, total - balance), total) * 100) / 100;
        summary.billed = Math.round((summary.billed + total) * 100) / 100;
        summary.collected = Math.round((summary.collected + collected) * 100) / 100;
        const st = String(row?.status || 'Unknown');
        summary.byStatus[st] = (summary.byStatus[st] || 0) + 1;
        const days = getExamInvoiceDaysOverdue(row, now);
        if (days > 0) {
            summary.overdueCount += 1;
            summary.overdueAmount = Math.round((summary.overdueAmount + balance) * 100) / 100;
            if (days <= 30) summary.aging.days1to30 = Math.round((summary.aging.days1to30 + balance) * 100) / 100;
            else if (days <= 60) summary.aging.days31to60 = Math.round((summary.aging.days31to60 + balance) * 100) / 100;
            else summary.aging.days60plus = Math.round((summary.aging.days60plus + balance) * 100) / 100;
        } else if (balance > 0.005 && !isExamInvoiceTerminal(row)) {
            summary.aging.current = Math.round((summary.aging.current + balance) * 100) / 100;
        }
    }
    summary.outstanding = Math.round((summary.billed - summary.collected) * 100) / 100;
    summary.collectionRate = summary.billed > 0 ? Math.round((summary.collected / summary.billed) * 1000) / 1000 : 0;
    return summary;
}

function csvCell(v: unknown): string {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function examInvoicesToCsv(list: ExamInvoiceLike[], now: Date = new Date()): string {
    const header = ['Invoice', 'School / Customer', 'Batch', 'Date', 'Due Date', 'Days Overdue', 'Total', 'Paid', 'Balance', 'Status', 'Verification'];
    const lines = [header.map(csvCell).join(',')];
    for (const row of list || []) {
        const total = Number(row?.totalAmount) || 0;
        const paid = Math.round((total - getExamInvoiceBalance(row)) * 100) / 100;
        lines.push(
            [
                row.invoiceNumber || row.id,
                row.customerName || '',
                row.batchNumber || '',
                row.date ? new Date(row.date).toISOString().slice(0, 10) : '',
                row.dueDate ? new Date(row.dueDate).toISOString().slice(0, 10) : '',
                getExamInvoiceDaysOverdue(row, now),
                total,
                paid,
                getExamInvoiceBalance(row),
                row.status || '',
                resolveExaminationVerificationReadiness(row),
            ]
                .map(csvCell)
                .join(','),
        );
    }
    return lines.join('\n');
}

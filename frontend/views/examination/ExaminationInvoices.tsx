import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, RefreshCw, Eye, ShieldCheck, ExternalLink, FileText, DollarSign, Clock, MoreHorizontal, Download, History, Ban, Trash2, X, ChevronDown, ChevronRight, ArrowUpDown, SlidersHorizontal } from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useExamination } from '../../context/ExaminationContext';
import { useAuth } from '../../context/AuthContext';
import { useSales } from '../../context/SalesContext';
import { durableSyncQueue } from '../../services/durableSyncQueue';
import { dbService } from '../../services/db';
import { downloadBlob } from '../../utils/helpers';
import { mapToInvoiceData } from '../../utils/pdfMapper';
import { attachDocumentSecurity } from '../../utils/documentSecurity';
import { enrichDocumentCustomerData } from '../../utils/documentCustomerData';
import { generatePrimeDocumentBlob } from '../shared/components/PDF/generatePrimeDocumentBlob';
import type { PrimeDocData } from '../shared/components/PDF/schemas';
import { hydrateCompanyPdfAssets } from '../../utils/companyAssetUtils';
import { getStoredCompanyConfig, initializePrimePdfFonts } from '../shared/components/PDF/templateSettings';
import { PreviewModal } from '../shared/components/PDF/PreviewModal';
import {
  isExaminationInvoiceRecord,
  getExaminationBatchLinkage,
  resolveExaminationVerificationReadiness,
  PENDING_SYNC_VERIFICATION_COPY,
} from '../../utils/invoiceIdentity';
import { ExaminationInvoiceDetailModal } from './components/ExaminationInvoiceDetailModal';
import { buildInvoiceVerificationUrl } from '../../utils/invoiceVerification';
import {
  examInvoicesToCsv,
  filterExamInvoices,
  getExamInvoiceBalance,
  getExamInvoiceDaysOverdue,
  isExamInvoiceOverdue,
  paginateExamInvoices,
  sortExamInvoices,
  summarizeExamInvoices,
} from '../../utils/examinationInvoicesList';
import type { ExamInvoiceSortKey, ReadinessFilter, SortDir } from '../../utils/examinationInvoicesList';

/**
 * Examination → Invoices.
 *
 * A specialized VIEW over the canonical invoices store — no second table,
 * no second identity, no second persistence path. Rows are the same records
 * the general invoice list, accounting, verification and portal all use,
 * filtered by the shared examination linkage
 * (see isExaminationInvoiceRecord). All actions delegate to the existing
 * invoice flows (detail, preview/print/download, public verification).
 *
 * Presentation follows the Clients "Add Customer" modal (ClientModal.tsx):
 * paper/teal/amber tokens, serif titles, gradient icon tile + accent
 * stripe, hairline cards, ghost + gradient buttons.
 */

const teal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a'
};
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px 9px 36px',
  borderRadius: 9,
  border: `1.4px solid ${hairline}`,
  background: paper,
  fontSize: 13,
  color: ink,
  outline: 'none',
  fontFamily: "'Inter','DM Sans',sans-serif",
};

const selectStyle: React.CSSProperties = {
  padding: '9px 12px',
  borderRadius: 9,
  border: `1.4px solid ${hairline}`,
  background: paper,
  fontSize: 13,
  fontWeight: 600,
  color: inkSoft,
  cursor: 'pointer',
  fontFamily: "'Inter','DM Sans',sans-serif",
};

const ghostButtonStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 9,
  background: paper,
  border: `1.4px solid ${hairline}`,
  color: inkSoft,
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: "'Inter','DM Sans',sans-serif",
  transition: 'all .15s ease',
};

const iconButtonStyle: React.CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 8,
  border: `1px solid ${hairline}`,
  background: paper,
  color: inkSoft,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  transition: 'all .15s ease',
};

const pillStyle = (fg: string, bg: string, border: string): React.CSSProperties => ({
  display: 'inline-block',
  padding: '2px 10px',
  borderRadius: 20,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.04,
  textTransform: 'uppercase',
  color: fg,
  background: bg,
  border: `1px solid ${border}`,
  whiteSpace: 'nowrap',
});

const statusPill = (status: string): React.CSSProperties => {
  const s = String(status || '').toLowerCase();
  if (s === 'paid') return pillStyle(teal[700], teal[50], teal[200]);
  if (s === 'partial' || s === 'partially paid') return pillStyle('#8a5a1a', amber[100], amber[300]);
  if (s === 'unpaid' || s === 'overdue' || s === 'sent') return pillStyle(amber[600], amber[100], amber[300]);
  if (s === 'voided' || s === 'void' || s === 'cancelled') return pillStyle(danger, `${danger}12`, `${danger}55`);
  return pillStyle(inkSoft, '#f4f1ec', hairline);
};

const overduePill = (days: number): React.CSSProperties =>
  pillStyle(danger, `${danger}12`, `${danger}55`);

const EXAM_INVOICE_PAGE_SIZES = [10, 25, 50, 100];

export interface ExamInvoiceRow {
  id: string;
  invoiceNumber: string;
  customerName: string;
  batchId: string | null;
  batchNumber: string;
  date: string;
  dueDate: string;
  totalAmount: number;
  paidAmount: number;
  status: string;
  verificationToken: string;
}

/** Pure selection: canonical invoices → examination rows (unit-tested). */
export const selectExaminationInvoices = (
  invoices: ReadonlyArray<Record<string, any>> | null | undefined,
  batches?: ReadonlyArray<Record<string, any>> | null
): ExamInvoiceRow[] => {
  if (!Array.isArray(invoices)) return [];
  return (invoices as Array<Record<string, any>>)
    .filter((invoice) => isExaminationInvoiceRecord(invoice, batches))
    .map((invoice) => ({
      id: String(invoice?.id ?? ''),
      invoiceNumber: String(invoice?.invoiceNumber ?? invoice?.id ?? ''),
      customerName: String(invoice?.customerName || (invoice as any)?.schoolName || ''),
      batchId: String(invoice?.batchId || (invoice as any)?.origin_batch_id || (invoice as any)?.originBatchId || '') || null,
      batchNumber: '',
      date: String(invoice?.date || ''),
      dueDate: String((invoice as any)?.dueDate || ''),
      totalAmount: Number(invoice?.totalAmount ?? 0) || 0,
      paidAmount: Number(invoice?.paidAmount ?? 0) || 0,
      status: String(invoice?.status || ''),
      verificationToken: String(invoice?.verificationToken || ''),
    }))
    .filter((row) => row.id || row.invoiceNumber);
};

const normalizeBatchKey = (value: unknown): string => {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return '';
  if (text.startsWith('EXM-BATCH-')) return text.slice('EXM-BATCH-'.length);
  if (text.startsWith('EXAM-BATCH-')) return text.slice('EXAM-BATCH-'.length);
  return text;
};

/** Pure join: examination row → owning batch record (unit-tested). */
export const resolveExamInvoiceBatch = (
  row: Pick<ExamInvoiceRow, 'id' | 'invoiceNumber' | 'batchId'> & Record<string, any>,
  batches: ReadonlyArray<Record<string, any>> | null | undefined
): Record<string, any> | null => {
  if (!Array.isArray(batches)) return null;
  const direct = batches.find(
    (batch) =>
      String(batch?.invoice_id || '') === String(row?.id || '') ||
      String(batch?.invoice_id || '') === String(row?.invoiceNumber || '')
  );
  if (direct) return direct;
  const linkKeys = new Set(
    [
      ...getExaminationBatchLinkage(row as Record<string, unknown>),
      normalizeBatchKey((row as Record<string, any>)?.batchId),
    ].filter(Boolean)
  );
  if (linkKeys.size === 0) return null;
  return (
    batches.find((batch) =>
      [batch?.id, (batch as any)?.batch_number, (batch as any)?.batchNumber, (batch as any)?.name]
        .map((value) => normalizeBatchKey(value))
        .some((key) => key && linkKeys.has(key))
    ) || null
  );
};

/**
 * Examination invoice action menu (unit-tested). Mirrors the general
 * invoice menu minus the paths that would fork exam financials outside
 * the batch workflow (edit/duplicate/credit/DN/exchange/email/analytics
 * stay on the canonical detail view or are intentionally unavailable —
 * exam invoices are priced only by calculation snapshots). Void and
 * permanent delete are first-class here with the same semantics as the
 * general list: void reverses ledger effects; permanent delete is offered
 * only for already-voided invoices.
 */
export type ExamInvoiceMenuKey =
  | 'view'
  | 'preview'
  | 'download'
  | 'payment'
  | 'ledger'
  | 'void'
  | 'purge';

export const examInvoiceMenuItems = (
  row: Pick<ExamInvoiceRow, 'status' | 'paidAmount' | 'totalAmount'>
): ExamInvoiceMenuKey[] => {
  const status = String(row?.status || '').toLowerCase();
  const isTerminal = status === 'voided' || status === 'void' || status === 'cancelled';
  const paid = status === 'paid' || (Number(row?.paidAmount || 0) > 0 && Number(row?.paidAmount || 0) >= Number(row?.totalAmount || 0));
  const items: ExamInvoiceMenuKey[] = ['view', 'preview', 'download'];
  if (!paid) items.push('payment');
  items.push('ledger');
  // Mirrors the general list: void only while unpaid (paid/partial go
  // through payment-aware flows), permanent delete only once voided.
  if (!isTerminal && !paid) items.push('void');
  if (isTerminal) items.push('purge');
  return items;
};

const ExaminationInvoices: React.FC = () => {
  const navigate = useNavigate();
  const { invoices, fetchFinanceData, cancelInvoice, getInvoiceVerificationToken } = useFinance() as unknown as {
    invoices: Array<Record<string, any>>;
    fetchFinanceData: () => Promise<unknown>;
    cancelInvoice: (id: string, reason: string) => Promise<unknown>;
    getInvoiceVerificationToken?: (id: string) => Promise<string | null>;
  };
  const { batches } = useExamination() as unknown as {
    batches: Array<Record<string, any>>;
  };
  const { companyConfig, notify, addAuditLog } = useAuth() as unknown as {
    companyConfig: Record<string, any> | null;
    notify: (message: string, kind?: string) => void;
    addAuditLog: (entry: Record<string, any>) => void;
  };
  const { customers } = useSales() as unknown as { customers: Array<Record<string, any>> };
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  // --- List upgrades: advanced filters / sorting / batch selection ---
  const [showFilters, setShowFilters] = useState(false);
  const [readinessFilter, setReadinessFilter] = useState<ReadinessFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [minAmount, setMinAmount] = useState('');
  const [maxAmount, setMaxAmount] = useState('');
  const [batchFilter, setBatchFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [sortBy, setSortBy] = useState<ExamInvoiceSortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingIds, setPendingIds] = useState<ReadonlyArray<string>>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [previewInvoice, setPreviewInvoice] = useState<Record<string, any> | null>(null);
  const [busyInvoiceId, setBusyInvoiceId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    fetchFinanceData?.().catch(() => {});
    durableSyncQueue
      .getAll('pending')
      .then((ops: Array<{ table?: string; recordId?: unknown }>) =>
        setPendingIds(
          (ops || [])
            .filter((op) => String(op?.table || '') === 'invoices')
            .map((op) => String(op?.recordId || '').trim())
            .filter(Boolean)
        )
      )
      .catch(() => setPendingIds([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Canonical selection + batch join (unchanged contract), then the
  // upgraded pipeline: advanced filter → sort → paginate.
  const baseRows = useMemo(() => {
    const selected = selectExaminationInvoices(invoices, batches);
    return selected.map((row) => {
      const batch = resolveExamInvoiceBatch(row, batches);
      return {
        ...row,
        batchNumber: String(batch?.batch_number || batch?.batchNumber || row.batchId || ''),
        batchRecordId: String(batch?.id || ''),
      };
    });
  }, [invoices, batches]);

  const listFilters = useMemo(() => ({
    search: searchTerm,
    status: statusFilter,
    readiness: readinessFilter,
    dateFrom,
    dateTo,
    minAmount: minAmount === '' ? '' as const : Number(minAmount),
    maxAmount: maxAmount === '' ? '' as const : Number(maxAmount),
    overdueOnly,
    batch: batchFilter,
  }), [searchTerm, statusFilter, readinessFilter, dateFrom, dateTo, minAmount, maxAmount, overdueOnly, batchFilter]);

  const filteredRows = useMemo(
    () => sortExamInvoices(filterExamInvoices(baseRows, listFilters as never, pendingIds), sortBy, sortDir),
    [baseRows, listFilters, pendingIds, sortBy, sortDir],
  );

  const summary = useMemo(() => summarizeExamInvoices(filteredRows as never), [filteredRows]);

  const paged = useMemo(
    () => paginateExamInvoices(filteredRows, page, pageSize),
    [filteredRows, page, pageSize],
  );
  const rows = paged.rows;

  const hasActiveFilters = Boolean(
    searchTerm || statusFilter || readinessFilter !== 'all' || dateFrom || dateTo ||
    minAmount !== '' || maxAmount !== '' || batchFilter || overdueOnly,
  );

  const clearFilters = () => {
    setSearchTerm('');
    setStatusFilter('');
    setReadinessFilter('all');
    setDateFrom('');
    setDateTo('');
    setMinAmount('');
    setMaxAmount('');
    setBatchFilter('');
    setOverdueOnly(false);
    setPage(1);
  };

  useEffect(() => {
    setPage(1);
  }, [searchTerm, statusFilter, readinessFilter, dateFrom, dateTo, minAmount, maxAmount, batchFilter, overdueOnly, sortBy, sortDir, pageSize]);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => filteredRows.some((row) => (row.id || row.invoiceNumber) === id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filteredRows.length]);

  // Keyboard shortcut: "/" focuses the list search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key === '/' && target && !/INPUT|TEXTAREA|SELECT/.test(target.tagName)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rowKey = (row: ExamInvoiceRow) => row.id || row.invoiceNumber;

  const toggleSelectAllVisible = () => {
    const visibleIds = rows.map(rowKey);
    const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
    setSelectedIds(allSelected ? selectedIds.filter((id) => !visibleIds.includes(id)) : Array.from(new Set([...selectedIds, ...visibleIds])));
  };

  const toggleSelectOne = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const handleExportCsv = () => {
    const exportRows = selectedIds.length > 0
      ? filteredRows.filter((row) => selectedIds.includes(rowKey(row)))
      : filteredRows;
    const csv = examInvoicesToCsv(exportRows as never);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), `examination-invoices-${new Date().toISOString().slice(0, 10)}.csv`);
    notify(`Exported ${exportRows.length} examination invoice${exportRows.length === 1 ? '' : 's'} to CSV.`, 'success');
  };

  const cycleSort = (key: ExamInvoiceSortKey) => {
    if (sortBy !== key) {
      setSortBy(key);
      setSortDir(key === 'customer' || key === 'status' ? 'asc' : 'desc');
    } else {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
    }
  };

  const sortHint = (key: ExamInvoiceSortKey) => (sortBy === key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '');

  // Full detail lives HERE in the Examination module (detail modal below):
  // same canonical record, same accounting, same token — but without
  // forking exam financials into the general invoice flows (edit/duplicate/
  // credit paths stay unavailable for calculation-priced exam invoices).
  const [detailRow, setDetailRow] = useState<ExamInvoiceRow | null>(null);

  const openInvoice = (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    setDetailRow(row);
  };

  const openBatch = (batchRecordId: string) => {
    if (batchRecordId) navigate(`/examination/batches/${batchRecordId}`);
  };

  const openVerification = (row: ExamInvoiceRow) => {
    const readiness = resolveExaminationVerificationReadiness(row, pendingIds);
    if (readiness !== 'verifiable') return;
    const url = buildInvoiceVerificationUrl({ invoiceNumber: row.invoiceNumber, verificationToken: row.verificationToken });
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  const findRecord = (row: ExamInvoiceRow): Record<string, any> | undefined =>
    (invoices || []).find((invoice) => String(invoice?.id || '') === String(row.id || ''));

  const handlePreview = (row: ExamInvoiceRow) => {
    const record = findRecord(row);
    if (record) setPreviewInvoice(record);
    setOpenMenuId(null);
  };

  const handleDownload = async (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    const record = findRecord(row);
    if (!record || busyInvoiceId) return;
    setBusyInvoiceId(row.id);
    try {
      // Same hardened pipeline as the general list: token backfill, enrich,
      // map as EXAMINATION_INVOICE, secure, render, download. No new logic.
      let source = record;
      if (record?.id && !record.verificationToken && getInvoiceVerificationToken) {
        try {
          const token = await getInvoiceVerificationToken(String(record.id));
          if (token) source = { ...record, verificationToken: token };
        } catch { /* offline-safe: legacy payload until synced */ }
      }
      const config = await hydrateCompanyPdfAssets(getStoredCompanyConfig());
      const enriched = enrichDocumentCustomerData(source, customers as any);
      const mapped = mapToInvoiceData(enriched, config, 'EXAMINATION_INVOICE' as any);
      await initializePrimePdfFonts();
      const secured = await attachDocumentSecurity(mapped, (config as any)?.companyName);
      const blob = await generatePrimeDocumentBlob('EXAMINATION_INVOICE' as any, secured as PrimeDocData, config);
      downloadBlob(blob, `Exam Invoice - ${row.invoiceNumber || row.id}.pdf`);
      notify(`Exam invoice ${row.invoiceNumber || row.id} downloaded`, 'success');
    } catch {
      notify('Failed to generate invoice PDF', 'error');
    } finally {
      setBusyInvoiceId(null);
    }
  };

  const handlePayment = (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    navigate('/sales-flow/payments', { state: { action: 'create', customer: row.customerName, invoiceId: row.id } });
  };

  const handleLedger = (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    navigate(`/fiscal-reports/ledgers?query=${encodeURIComponent(row.id)}`);
  };

  const handleVoid = async (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    if (!window.confirm(`VOID INVOICE ${row.invoiceNumber || row.id}: this reverses all ledger entries. Continue?`)) return;
    try {
      await cancelInvoice(row.id, 'Voided from Examination Invoices');
      await fetchFinanceData?.();
      // The detail modal holds a row snapshot — close it so a voided record
      // can never linger on screen with pre-void totals.
      setDetailRow(null);
    } catch {
      // cancelInvoice already notifies; list refresh keeps the row truthful.
      await fetchFinanceData?.().catch(() => {});
    }
  };

  const handlePurge = async (row: ExamInvoiceRow) => {
    setOpenMenuId(null);
    // Permanent delete is offered only for already-voided invoices (gated by
    // examInvoiceMenuItems), mirroring the general list: void first reverses
    // the ledger, then the row itself can be removed completely.
    if (!window.confirm(`DELETE PERMANENTLY: Invoice #${row.invoiceNumber || row.id} is already voided. Delete it completely from the system? This cannot be undone.`)) return;
    try {
      await dbService.delete('invoices', row.id);
      await fetchFinanceData?.();
      addAuditLog({ action: 'DELETE', entityType: 'Invoice', entityId: row.id, details: `Exam invoice ${row.invoiceNumber || row.id} permanently deleted.` });
      notify(`Invoice #${row.invoiceNumber || row.id} deleted completely`, 'success');
      setDetailRow(null);
    } catch (err: any) {
      notify(`Delete failed: ${err?.message || 'unknown error'}`, 'error');
    }
  };

  const openMenu = (event: React.MouseEvent, row: ExamInvoiceRow) => {
    event.stopPropagation();
    const menuWidth = 256;
    const menuHeight = 320;
    setOpenMenuId(row.id || row.invoiceNumber);
    setMenuPos({
      x: Math.max(0, Math.min(event.clientX, window.innerWidth - menuWidth)),
      y: Math.max(0, Math.min(event.clientY, window.innerHeight - menuHeight)),
    });
  };

  useEffect(() => {
    if (!openMenuId) return;
    const close = () => setOpenMenuId(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openMenuId]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetchFinanceData?.();
    } finally {
      setRefreshing(false);
    }
  };

  const kpis = [
    { label: 'Invoices', value: String(summary.count), sub: 'Examination records', icon: <FileText size={18} />, borderColor: teal[500], iconColor: teal[500], bg: teal[50] },
    { label: 'Total Billed', value: summary.billed.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: 'Across these invoices', icon: <DollarSign size={18} />, borderColor: amber[500], iconColor: amber[500], bg: amber[100] },
    { label: 'Collected', value: summary.collected.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: `${Math.round(summary.collectionRate * 100)}% collection rate`, icon: <DollarSign size={18} />, borderColor: teal[500], iconColor: teal[600], bg: teal[50] },
    { label: 'Outstanding', value: summary.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: 'Billed minus collected', icon: <Clock size={18} />, borderColor: teal[300], iconColor: teal[600], bg: teal[50] },
    { label: 'Overdue', value: summary.overdueAmount.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: `${summary.overdueCount} invoice${summary.overdueCount === 1 ? '' : 's'} past due`, icon: <Clock size={18} />, borderColor: danger, iconColor: danger, bg: `${danger}12` },
  ];

  const agingChips: Array<{ label: string; value: number }> = [
    { label: 'Current', value: summary.aging.current },
    { label: '1–30 days', value: summary.aging.days1to30 },
    { label: '31–60 days', value: summary.aging.days31to60 },
    { label: '60+ days', value: summary.aging.days60plus },
  ];

  const [isLargeDevice, setIsLargeDevice] = useState(window.innerWidth >= 1024);

useEffect(() => {
  const handleResize = () => {
    setIsLargeDevice(window.innerWidth >= 1024);
  };
  
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);

return (
  <div style={{
    width: '100%', fontFamily: "'Inter','DM Sans',sans-serif",
    fontWeight: 400, color: ink, fontSize: 13.5,
    padding: isLargeDevice ? '20px 0 20px 0' : '20px 20px 20px 20px',
  }}>
      <div style={{ 
        maxWidth: isLargeDevice ? '100%' : 1200, 
        margin: '0 auto', 
        display: 'flex', 
        flexDirection: 'column', 
        gap: 16,
        marginLeft: isLargeDevice ? 24 : 'auto',
        paddingRight: isLargeDevice ? 0 : 20,
      }}>
        {/* Header — Add Customer title treatment */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
            }}>
              <FileText size={19} color="#fff" />
            </div>
            <div>
              <h1 style={{
                fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
                fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2
              }}>
                Examination Invoices
              </h1>
              <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>
                Canonical invoice records for examination batches — same records, accounting and verification as everywhere else
              </p>
            </div>
          </div>
          <button onClick={refresh} disabled={refreshing} style={{ ...ghostButtonStyle, opacity: refreshing ? 0.6 : 1 }}>
            <RefreshCw size={15} style={refreshing ? { animation: 'spin 1s linear infinite' } : {}} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>

        {/* KPI cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
          {kpis.map((kpi) => (
            <div key={kpi.label} style={{
              background: paper, borderRadius: 12, padding: '14px 16px',
              border: `1.4px solid ${hairline}`, borderLeft: `3px solid ${kpi.borderColor}`,
              display: 'flex', alignItems: 'center', gap: 14,
              boxShadow: '0 1px 3px rgba(0,0,0,.04)'
            }}>
              <div style={{
                width: 38, height: 38, borderRadius: 8,
                background: kpi.bg, color: kpi.iconColor,
                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
              }}>
                {kpi.icon}
              </div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.02 }}>{kpi.label}</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: ink, marginTop: 2 }}>{kpi.value}</div>
                <div style={{ fontSize: 9.5, color: inkSoft, marginTop: 1 }}>{kpi.sub}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Aging strip */}
        <div style={{
          background: paper, padding: '10px 20px', borderRadius: 12,
          border: `1.4px solid ${hairline}`, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center'
        }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 }}>Aging</span>
          {agingChips.map((chip) => (
            <span key={chip.label} style={{
              fontSize: 11, fontWeight: 700, color: ink, background: '#f4f1ec',
              border: `1px solid ${hairline}`, borderRadius: 16, padding: '3px 12px',
              fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap'
            }}>
              {chip.label}: {chip.value.toLocaleString(undefined, { minimumFractionDigits: 2 })}
            </span>
          ))}
        </div>

        {/* Filters */}
        <div style={{
          background: paper, padding: '16px 20px', borderRadius: 12,
          border: `1.4px solid ${hairline}`, display: 'flex', flexDirection: 'column', gap: 12
        }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
              <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
              <input
                ref={searchInputRef}
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Search invoice, school, batch or status  ( / )"
                style={inputStyle}
              />
            </div>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ ...selectStyle, minWidth: 160 }}>
              <option value="">All statuses</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Partial</option>
              <option value="paid">Paid</option>
              <option value="voided">Voided</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button
              onClick={() => setShowFilters((visible) => !visible)}
              style={{
                ...ghostButtonStyle,
                ...(showFilters || hasActiveFilters ? { background: teal[50], borderColor: teal[200], color: teal[700] } : {}),
              }}
              title="Advanced filters"
            >
              <SlidersHorizontal size={15} />
              Filters{hasActiveFilters ? ' •' : ''}
            </button>
            <button onClick={() => setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))} style={ghostButtonStyle} title="Toggle sort direction">
              <ArrowUpDown size={15} />
              {sortDir === 'asc' ? 'Asc' : 'Desc'}
            </button>
            <button onClick={handleExportCsv} style={ghostButtonStyle} title={selectedIds.length > 0 ? `Export ${selectedIds.length} selected` : 'Export filtered results'}>
              <Download size={15} />
              Export{selectedIds.length > 0 ? ` (${selectedIds.length})` : ''}
            </button>
          </div>
          {showFilters && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                Verification
                <select value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value as ReadinessFilter)} style={selectStyle}>
                  <option value="all">All</option>
                  <option value="verifiable">Verifiable</option>
                  <option value="pending-sync">Pending sync</option>
                  <option value="unverifiable">Unavailable</option>
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                From
                <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} style={{ ...selectStyle, fontWeight: 400 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                To
                <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} style={{ ...selectStyle, fontWeight: 400 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                Min amount
                <input type="number" placeholder="0" value={minAmount} onChange={(event) => setMinAmount(event.target.value)} style={{ ...selectStyle, fontWeight: 400 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                Max amount
                <input type="number" placeholder="∞" value={maxAmount} onChange={(event) => setMaxAmount(event.target.value)} style={{ ...selectStyle, fontWeight: 400 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>
                Batch
                <input type="text" placeholder="BTC-…" value={batchFilter} onChange={(event) => setBatchFilter(event.target.value)} style={{ ...selectStyle, fontWeight: 400 }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'row', gap: 8, fontSize: 11, fontWeight: 700, color: ink, alignItems: 'center', paddingTop: 18, cursor: 'pointer' }}>
                <input type="checkbox" checked={overdueOnly} onChange={(event) => setOverdueOnly(event.target.checked)} style={{ width: 15, height: 15, accentColor: teal[600] }} />
                Overdue only
              </label>
              {hasActiveFilters && (
                <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 2 }}>
                  <button onClick={clearFilters} style={{ ...ghostButtonStyle, color: danger }}>Clear all</button>
                </div>
              )}
            </div>
          )}
          {selectedIds.length > 0 && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
              background: teal[800], color: '#fff', borderRadius: 9, padding: '8px 14px', fontSize: 12, fontWeight: 600
            }}>
              <span>{selectedIds.length} selected</span>
              <button onClick={handleExportCsv} style={{ ...ghostButtonStyle, background: 'rgba(255,255,255,.12)', borderColor: 'transparent', color: '#fff', padding: '5px 12px', fontSize: 12 }}>
                <Download size={13} /> Export selected
              </button>
              <button onClick={() => setSelectedIds([])} style={{ ...ghostButtonStyle, background: 'rgba(255,255,255,.12)', borderColor: 'transparent', color: '#fff', padding: '5px 12px', fontSize: 12 }}>
                <X size={13} /> Clear
              </button>
            </div>
          )}
        </div>

        {/* Table card */}
        <div style={{
          background: paper, borderRadius: 12,
          border: `1.4px solid ${hairline}`,
          boxShadow: '0 1px 3px rgba(0,0,0,.04)',
          overflow: 'hidden'
        }}>
          <div style={{ height: 4, background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)` }} />
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: 'left', borderBottom: `1px solid ${hairline}`, background: teal[50] }}>
                  <th style={{ padding: '10px 8px 10px 14px', width: 30 }}>
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && rows.every((row) => selectedIds.includes(rowKey(row)))}
                      onChange={toggleSelectAllVisible}
                      style={{ width: 14, height: 14, accentColor: teal[600] }}
                      title="Select visible page"
                    />
                  </th>
                  <th style={{ padding: '10px 4px', width: 28 }} />
                  {(
                    [
                      { label: 'Invoice', key: null },
                      { label: 'School / Customer', key: 'customer' as ExamInvoiceSortKey },
                      { label: 'Batch', key: null },
                      { label: 'Date', key: 'date' as ExamInvoiceSortKey },
                      { label: 'Due', key: 'dueDate' as ExamInvoiceSortKey },
                      { label: 'Amount', key: 'amount' as ExamInvoiceSortKey, right: true },
                      { label: 'Paid', key: null, right: true },
                      { label: 'Balance', key: 'balance' as ExamInvoiceSortKey, right: true },
                      { label: 'Status', key: 'status' as ExamInvoiceSortKey },
                      { label: 'Verification', key: null },
                      { label: 'Actions', key: null },
                    ] as Array<{ label: string; key: ExamInvoiceSortKey | null; right?: boolean }>
                  ).map((heading) => (
                    <th key={heading.label} style={{
                      padding: '10px 14px', fontSize: 10, fontWeight: 700, color: inkSoft,
                      textTransform: 'uppercase', letterSpacing: 0.08, whiteSpace: 'nowrap',
                      textAlign: heading.right ? 'right' : 'left'
                    }}>
                      {heading.key ? (
                        <button
                          onClick={() => cycleSort(heading.key as ExamInvoiceSortKey)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, font: 'inherit', color: sortBy === heading.key ? teal[700] : inkSoft }}
                          title={`Sort by ${heading.label}`}
                        >
                          {heading.label}{sortHint(heading.key as ExamInvoiceSortKey)}
                        </button>
                      ) : (
                        heading.label
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const readiness = resolveExaminationVerificationReadiness(row, pendingIds);
                  const balance = getExamInvoiceBalance(row as never);
                  const daysOverdue = getExamInvoiceDaysOverdue(row as never);
                  const key = rowKey(row);
                  const isChecked = selectedIds.includes(key);
                  const isExpanded = expandedId === key;
                  return (
                    <React.Fragment key={key}>
                      <tr style={{ borderBottom: isExpanded ? 'none' : `1px solid ${hairline}`, background: isChecked ? teal[50] : undefined }}>
                        <td style={{ padding: '10px 8px 10px 14px' }} onClick={(event) => event.stopPropagation()}>
                          <input type="checkbox" checked={isChecked} onChange={() => toggleSelectOne(key)} style={{ width: 14, height: 14, accentColor: teal[600] }} />
                        </td>
                        <td style={{ padding: '10px 4px' }}>
                          <button
                            onClick={() => setExpandedId(isExpanded ? null : key)}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', color: inkSoft, padding: 2, display: 'inline-flex' }}
                            title={isExpanded ? 'Collapse details' : 'Expand details'}
                          >
                            {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                          </button>
                        </td>
                        <td style={{ padding: '10px 14px', fontWeight: 700, color: teal[800], whiteSpace: 'nowrap', fontFamily: "'JetBrains Mono', monospace", fontSize: 12.5 }}>
                          {row.invoiceNumber}
                        </td>
                        <td style={{ padding: '10px 14px' }}>{row.customerName || '—'}</td>
                        <td style={{ padding: '10px 14px' }}>
                          {row.batchRecordId ? (
                            <button
                              onClick={() => openBatch(row.batchRecordId)}
                              style={{ color: teal[600], fontWeight: 600, fontSize: 12.5, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                            >
                              {row.batchNumber || 'Open batch'}
                            </button>
                          ) : (
                            row.batchNumber || '—'
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          {row.date ? new Date(row.date).toLocaleDateString() : '—'}
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          {row.dueDate ? new Date(row.dueDate).toLocaleDateString() : '—'}
                          {daysOverdue > 0 && (
                            <div style={{ marginTop: 2 }}><span style={overduePill(daysOverdue)}>{daysOverdue}d overdue</span></div>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                          {row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: inkSoft }}>
                          {(Number(row.paidAmount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap', color: balance > 0 ? amber[600] : teal[700] }}>
                          {balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '10px 14px' }}>
                          <span style={statusPill(row.status)}>{row.status || '—'}</span>
                        </td>
                        <td style={{ padding: '10px 14px', fontSize: 12 }}>
                          {readiness === 'verifiable' ? (
                            <span style={pillStyle(teal[700], teal[50], teal[200])}>Verifiable</span>
                          ) : readiness === 'pending-sync' ? (
                            <span title={PENDING_SYNC_VERIFICATION_COPY} style={pillStyle('#8a5a1a', amber[100], amber[300])}>Pending sync</span>
                          ) : (
                            <span style={pillStyle(inkSoft, '#f4f1ec', hairline)}>Unavailable</span>
                          )}
                        </td>
                        <td style={{ padding: '10px 14px', whiteSpace: 'nowrap' }}>
                          <button title="View invoice" onClick={() => openInvoice(row)} style={iconButtonStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <Eye size={15} />
                          </button>{' '}
                          <button title="Open batch" disabled={!row.batchRecordId} onClick={() => openBatch(row.batchRecordId)}
                            style={{ ...iconButtonStyle, opacity: row.batchRecordId ? 1 : 0.4, cursor: row.batchRecordId ? 'pointer' : 'not-allowed' }}
                            onMouseEnter={e => { if (row.batchRecordId) { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; } }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <ExternalLink size={15} />
                          </button>{' '}
                          <button title={readiness === 'verifiable' ? 'Verify' : PENDING_SYNC_VERIFICATION_COPY}
                            disabled={readiness !== 'verifiable'} onClick={() => openVerification(row)}
                            style={{ ...iconButtonStyle, opacity: readiness === 'verifiable' ? 1 : 0.4, cursor: readiness === 'verifiable' ? 'pointer' : 'not-allowed' }}
                            onMouseEnter={e => { if (readiness === 'verifiable') { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; } }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <ShieldCheck size={15} />
                          </button>{' '}
                          <button title="Invoice actions" onClick={(event) => openMenu(event, row)} style={iconButtonStyle}
                            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
                            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                            <MoreHorizontal size={15} />
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr style={{ borderBottom: `1px solid ${hairline}`, background: '#f8f6f2' }}>
                          <td colSpan={13} style={{ padding: '10px 20px 14px 48px' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '8px 20px', fontSize: 12 }}>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>School</div><div style={{ fontWeight: 600 }}>{row.customerName || '—'}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Batch</div><div style={{ fontWeight: 600 }}>{row.batchNumber || '—'}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Invoiced</div><div style={{ fontVariantNumeric: 'tabular-nums' }}>{row.date ? new Date(row.date).toLocaleDateString() : '—'}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Due</div><div style={{ fontVariantNumeric: 'tabular-nums' }}>{row.dueDate ? new Date(row.dueDate).toLocaleDateString() : '—'}{daysOverdue > 0 ? ` (${daysOverdue}d overdue)` : ''}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Paid</div><div style={{ fontVariantNumeric: 'tabular-nums' }}>{(Number(row.paidAmount) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Balance due</div><div style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}</div></div>
                              <div><div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Verification</div><div>{readiness === 'verifiable' ? 'Verifiable' : readiness === 'pending-sync' ? 'Pending sync' : 'Unavailable'}</div></div>
                              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
                                <button onClick={() => openInvoice(row)} style={{ ...ghostButtonStyle, padding: '5px 12px', fontSize: 12 }}>Full detail</button>
                                {isExamInvoiceOverdue(row as never) && (
                                  <button onClick={() => handlePayment(row)} style={{ ...ghostButtonStyle, padding: '5px 12px', fontSize: 12, color: teal[700], borderColor: teal[200] }}>
                                    <DollarSign size={13} /> Receive payment
                                  </button>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: inkSoft, margin: 0 }}>
                {hasActiveFilters ? 'No examination invoices match these filters' : 'No examination invoices found'}
              </p>
              <p style={{ fontSize: 11.5, color: inkSoft, margin: '4px 0 0' }}>
                {hasActiveFilters ? 'Try widening the date range or clearing the search.' : 'Generate one from an approved batch.'}
              </p>
              {hasActiveFilters && (
                <button onClick={clearFilters} style={{ ...ghostButtonStyle, marginTop: 12 }}>Clear all filters</button>
              )}
            </div>
          )}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap',
            padding: '10px 20px', borderTop: `1px solid ${hairline}`, fontSize: 11, color: inkSoft
          }}>
            <span>Showing {rows.length} of {paged.total} invoices · Page {paged.page} of {paged.totalPages}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <select value={pageSize} onChange={(event) => setPageSize(Number(event.target.value))} style={{ ...selectStyle, padding: '5px 8px', fontSize: 11 }}>
                {EXAM_INVOICE_PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>{size} / page</option>
                ))}
              </select>
              <button onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={paged.page <= 1} style={{ ...ghostButtonStyle, padding: '5px 12px', fontSize: 11, opacity: paged.page <= 1 ? 0.45 : 1 }}>Previous</button>
              <button onClick={() => setPage((current) => Math.min(paged.totalPages, current + 1))} disabled={paged.page >= paged.totalPages} style={{ ...ghostButtonStyle, padding: '5px 12px', fontSize: 11, opacity: paged.page >= paged.totalPages ? 0.45 : 1 }}>Next</button>
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px',
            borderTop: `1px solid ${hairline}`, fontSize: 11, color: inkSoft
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: amber[500] }} />
            Full detail, print and download live right here — one canonical record, one accounting effect, one verification token.
          </div>
        </div>
      </div>

      {openMenuId && menuPos && (() => {
        const activeRow = filteredRows.find((row) => (row.id || row.invoiceNumber) === openMenuId);
        if (!activeRow) return null;
        const items = examInvoiceMenuItems(activeRow);
        const menuItem = (
          label: string,
          icon: React.ReactNode,
          onSelect: () => void,
          tone: 'ink' | 'teal' | 'amber' | 'danger' = 'ink',
          disabled = false
        ) => {
          const tones = {
            ink: { color: ink, hoverBg: '#f5f2ed' },
            teal: { color: teal[600], hoverBg: teal[50] },
            amber: { color: amber[600], hoverBg: amber[100] },
            danger: { color: danger, hoverBg: `${danger}15` },
          }[tone];
          return (
            <button
              onClick={onSelect}
              disabled={disabled}
              style={{
                width: '100%', padding: '8px 16px', fontSize: 12, fontWeight: 600,
                color: tones.color, background: 'transparent', border: 'none',
                display: 'flex', alignItems: 'center', gap: 12, cursor: disabled ? 'not-allowed' : 'pointer',
                textAlign: 'left', opacity: disabled ? 0.45 : 1, transition: 'background .1s'
              }}
              onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = tones.hoverBg; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
            >
              {icon}
              {label}
              {busyInvoiceId === activeRow.id && (label === 'Download PDF Invoice') && (
                <span style={{ marginLeft: 'auto', fontSize: 10, color: inkSoft }}>…</span>
              )}
            </button>
          );
        };
        const has = (key: ExamInvoiceMenuKey) => items.includes(key);
        return (
          <div
            ref={menuRef}
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'fixed', top: menuPos.y, left: menuPos.x, width: 256, zIndex: 70,
              background: 'rgba(254,253,251,.95)', borderRadius: 12,
              boxShadow: '0 30px 70px -20px rgba(0,0,0,.35)',
              border: `1px solid ${hairline}`, overflow: 'hidden'
            }}
          >
            <div style={{
              padding: '8px 16px', borderBottom: `1px solid ${hairline}`,
              fontSize: 10, fontWeight: 700, color: inkSoft,
              textTransform: 'uppercase', letterSpacing: 0.08, background: teal[50]
            }}>
              Invoice actions
            </div>
            <div style={{ padding: '4px 0' }}>
              {has('view') && menuItem('View full detail', <FileText size={14} />, () => openInvoice(activeRow), 'ink')}
              {has('preview') && menuItem('Preview PDF Invoice', <Eye size={14} />, () => handlePreview(activeRow), 'teal')}
              {has('download') && menuItem('Download PDF Invoice', <Download size={14} />, () => handleDownload(activeRow), 'teal')}
              <div style={{ margin: '4px 0', borderTop: `1px solid ${hairline}` }} />
              {has('payment') && menuItem('Receive Payment', <DollarSign size={14} />, () => handlePayment(activeRow), 'teal')}
              {has('ledger') && menuItem('Audit Ledger Entries', <History size={14} />, () => handleLedger(activeRow), 'ink')}
              {has('void') && menuItem('Void Invoice', <Ban size={14} />, () => handleVoid(activeRow), 'amber')}
              {has('purge') && menuItem('Delete Permanently', <Trash2 size={14} />, () => handlePurge(activeRow), 'danger')}
            </div>
          </div>
        );
      })()}

      {detailRow && (() => {
        const record = findRecord(detailRow) || null;
        const batchId = (filteredRows.find((row) => (row.id || row.invoiceNumber) === (detailRow.id || detailRow.invoiceNumber)) as unknown as { batchRecordId?: string } | undefined)?.batchRecordId || '';
        return (
          <ExaminationInvoiceDetailModal
            row={detailRow}
            record={record}
            batchRecordId={batchId}
            readiness={resolveExaminationVerificationReadiness(detailRow, pendingIds)}
            balance={getExamInvoiceBalance(detailRow as never)}
            daysOverdue={getExamInvoiceDaysOverdue(detailRow as never)}
            menuKeys={examInvoiceMenuItems(detailRow)}
            currencySymbol={String((companyConfig as Record<string, any> | null)?.currencySymbol || '$')}
            onClose={() => setDetailRow(null)}
            onPreview={() => handlePreview(detailRow)}
            onDownload={() => { void handleDownload(detailRow); }}
            onPayment={() => handlePayment(detailRow)}
            onLedger={() => handleLedger(detailRow)}
            onVerify={() => openVerification(detailRow)}
            onVoid={() => { void handleVoid(detailRow); }}
            onPurge={() => { void handlePurge(detailRow); }}
            onOpenBatch={() => { if (batchId) openBatch(batchId); }}
          />
        );
      })()}

      {previewInvoice && (
        <PreviewModal
          isOpen={!!previewInvoice}
          onClose={() => setPreviewInvoice(null)}
          type="EXAMINATION_INVOICE"
          data={previewInvoice as never}
        />
      )}
    </div>
  );
};

export default ExaminationInvoices;

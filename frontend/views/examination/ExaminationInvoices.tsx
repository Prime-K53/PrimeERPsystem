import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, RefreshCw, Eye, ShieldCheck, ExternalLink, FileText, DollarSign, Clock, MoreHorizontal, Download, History, Ban, Trash2, X } from 'lucide-react';
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
import { hydrateCompanyPdfAssets, getStoredCompanyConfig } from '../../utils/companyAssetUtils';
import { initializePrimePdfFonts } from '../shared/components/PDF/templateSettings';
import { PreviewModal } from '../shared/components/PDF/PreviewModal';
import {
  isExaminationInvoiceRecord,
  getExaminationBatchLinkage,
  resolveExaminationInvoiceNavigationKey,
  buildExaminationInvoiceViewState,
  resolveExaminationVerificationReadiness,
  PENDING_SYNC_VERIFICATION_COPY,
} from '../../utils/invoiceIdentity';
import { buildInvoiceVerificationUrl } from '../../utils/invoiceVerification';

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
export const selectExaminationInvoices = (invoices: ReadonlyArray<Record<string, any>> | null | undefined): ExamInvoiceRow[] => {
  if (!Array.isArray(invoices)) return [];
  return (invoices as Array<Record<string, any>>)
    .filter((invoice) => isExaminationInvoiceRecord(invoice))
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

  const rows = useMemo(() => {
    const selected = selectExaminationInvoices(invoices);
    const query = searchTerm.trim().toLowerCase();
    return selected
      .map((row) => {
        const batch = resolveExamInvoiceBatch(row, batches);
        return {
          ...row,
          batchNumber: String(batch?.batch_number || batch?.batchNumber || row.batchId || ''),
          batchRecordId: String(batch?.id || ''),
        };
      })
      .filter((row) => {
        if (statusFilter && String(row.status || '').toLowerCase() !== statusFilter.toLowerCase()) return false;
        if (!query) return true;
        return [row.invoiceNumber, row.id, row.customerName, row.batchNumber, row.status]
          .map((value) => String(value || '').toLowerCase())
          .some((value) => value.includes(query));
      })
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }, [invoices, batches, searchTerm, statusFilter]);

  const totals = useMemo(() => {
    const billed = rows.reduce((sum, row) => sum + row.totalAmount, 0);
    const collected = rows.reduce((sum, row) => sum + Math.min(row.paidAmount, row.totalAmount), 0);
    return { count: rows.length, billed, outstanding: billed - collected };
  }, [rows]);

  // View reuses the canonical invoice detail (print/download/verify all
  // live there): same record, same accounting, same token.
  const openInvoice = (row: ExamInvoiceRow) => {
    const key =
      resolveExaminationInvoiceNavigationKey({ invoiceNumber: row.invoiceNumber, id: row.id }) || row.id;
    navigate('/sales-flow/invoices', { state: buildExaminationInvoiceViewState(key) });
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
    { label: 'Invoices', value: String(totals.count), sub: 'Examination records', icon: <FileText size={18} />, borderColor: teal[500], iconColor: teal[500], bg: teal[50] },
    { label: 'Total Billed', value: totals.billed.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: 'Across these invoices', icon: <DollarSign size={18} />, borderColor: amber[500], iconColor: amber[500], bg: amber[100] },
    { label: 'Outstanding', value: totals.outstanding.toLocaleString(undefined, { minimumFractionDigits: 2 }), sub: 'Billed minus collected', icon: <Clock size={18} />, borderColor: teal[300], iconColor: teal[600], bg: teal[50] },
  ];

  return (
    <div style={{
      width: '100%', fontFamily: "'Inter','DM Sans',sans-serif",
      fontWeight: 400, color: ink, fontSize: 13.5, padding: 20,
    }}>
      <div style={{ maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
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

        {/* Filters */}
        <div style={{
          background: paper, padding: '16px 20px', borderRadius: 12,
          border: `1.4px solid ${hairline}`, display: 'flex', gap: 12, flexWrap: 'wrap'
        }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 220 }}>
            <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: inkSoft }} />
            <input
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              placeholder="Search invoice, school, batch or status"
              style={inputStyle}
            />
          </div>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} style={{ ...selectStyle, minWidth: 180 }}>
            <option value="">All statuses</option>
            <option value="unpaid">Unpaid</option>
            <option value="partial">Partial</option>
            <option value="paid">Paid</option>
            <option value="voided">Voided</option>
            <option value="cancelled">Cancelled</option>
          </select>
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
                  {['Invoice', 'School / Customer', 'Batch', 'Date', 'Amount', 'Status', 'Verification', 'Actions'].map((heading, index) => (
                    <th key={heading} style={{
                      padding: '10px 14px', fontSize: 10, fontWeight: 700, color: inkSoft,
                      textTransform: 'uppercase', letterSpacing: 0.08, whiteSpace: 'nowrap',
                      textAlign: index === 4 ? 'right' : 'left'
                    }}>
                      {heading}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const readiness = resolveExaminationVerificationReadiness(row, pendingIds);
                  return (
                    <tr key={row.id || row.invoiceNumber} style={{ borderBottom: `1px solid ${hairline}` }}>
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
                      <td style={{ padding: '10px 14px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}
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
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length === 0 && (
            <div style={{ textAlign: 'center', padding: 32 }}>
              <p style={{ fontSize: 13, fontWeight: 700, color: inkSoft, margin: 0 }}>No examination invoices found</p>
              <p style={{ fontSize: 11.5, color: inkSoft, margin: '4px 0 0' }}>Generate one from an approved batch.</p>
            </div>
          )}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '12px 20px',
            borderTop: `1px solid ${hairline}`, fontSize: 11, color: inkSoft
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: amber[500] }} />
            Print and Download live on the invoice view — one canonical record, one accounting effect, one verification token.
          </div>
        </div>
      </div>

      {openMenuId && menuPos && (() => {
        const activeRow = rows.find((row) => (row.id || row.invoiceNumber) === openMenuId);
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

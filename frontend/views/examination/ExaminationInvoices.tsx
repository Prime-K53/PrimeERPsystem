import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, RefreshCw, Eye, ShieldCheck, ExternalLink } from 'lucide-react';
import { useFinance } from '../../context/FinanceContext';
import { useExamination } from '../../context/ExaminationContext';
import { durableSyncQueue } from '../../services/durableSyncQueue';
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
 */

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

const ExaminationInvoices: React.FC = () => {
  const navigate = useNavigate();
  const { invoices, fetchFinanceData } = useFinance() as unknown as {
    invoices: Array<Record<string, any>>;
    fetchFinanceData: () => Promise<unknown>;
  };
  const { batches } = useExamination() as unknown as {
    batches: Array<Record<string, any>>;
  };
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [pendingIds, setPendingIds] = useState<ReadonlyArray<string>>([]);
  const [refreshing, setRefreshing] = useState(false);

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

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetchFinanceData?.();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div style={{ padding: 20, maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Examination Invoices</h1>
          <p style={{ fontSize: 12, color: '#64748b', margin: '4px 0 0' }}>
            Canonical invoice records for examination batches — same records, accounting and verification as everywhere else.
          </p>
        </div>
        <button onClick={refresh} disabled={refreshing} style={{ padding: '8px 16px', borderRadius: 9 }}>
          <RefreshCw size={16} /> {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)' }} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Search invoice, school, batch or status"
            style={{ width: '100%', padding: '8px 12px 8px 34px' }}
          />
        </div>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
          <option value="">All statuses</option>
          <option value="unpaid">Unpaid</option>
          <option value="partial">Partial</option>
          <option value="paid">Paid</option>
          <option value="voided">Voided</option>
          <option value="cancelled">Cancelled</option>
        </select>
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '2px solid #e2e8f0' }}>
            <th style={{ padding: '8px' }}>Invoice</th>
            <th style={{ padding: '8px' }}>School / Customer</th>
            <th style={{ padding: '8px' }}>Batch</th>
            <th style={{ padding: '8px' }}>Date</th>
            <th style={{ padding: '8px', textAlign: 'right' }}>Amount</th>
            <th style={{ padding: '8px' }}>Status</th>
            <th style={{ padding: '8px' }}>Verification</th>
            <th style={{ padding: '8px' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const readiness = resolveExaminationVerificationReadiness(row, pendingIds);
            return (
              <tr key={row.id || row.invoiceNumber} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '8px', fontWeight: 600 }}>{row.invoiceNumber}</td>
                <td style={{ padding: '8px' }}>{row.customerName || '—'}</td>
                <td style={{ padding: '8px' }}>
                  {row.batchRecordId ? (
                    <button onClick={() => openBatch(row.batchRecordId)} style={{ color: '#0f766e', textDecoration: 'underline' }}>
                      {row.batchNumber || 'Open batch'}
                    </button>
                  ) : (
                    row.batchNumber || '—'
                  )}
                </td>
                <td style={{ padding: '8px' }}>{row.date ? new Date(row.date).toLocaleDateString() : '—'}</td>
                <td style={{ padding: '8px', textAlign: 'right' }}>{row.totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                <td style={{ padding: '8px' }}>{row.status || '—'}</td>
                <td style={{ padding: '8px', fontSize: 12 }}>
                  {readiness === 'verifiable' ? (
                    <span style={{ color: '#059669', fontWeight: 600 }}>Verifiable</span>
                  ) : readiness === 'pending-sync' ? (
                    <span title={PENDING_SYNC_VERIFICATION_COPY} style={{ color: '#b45309', fontWeight: 600 }}>Pending sync</span>
                  ) : (
                    <span style={{ color: '#94a3b8' }}>Unavailable</span>
                  )}
                </td>
                <td style={{ padding: '8px', whiteSpace: 'nowrap' }}>
                  <button title="View" onClick={() => openInvoice(row)}><Eye size={15} /></button>{' '}
                  <button title="Open batch" disabled={!row.batchRecordId} onClick={() => openBatch(row.batchRecordId)}>
                    <ExternalLink size={15} />
                  </button>{' '}
                  <button title={readiness === 'verifiable' ? 'Verify' : PENDING_SYNC_VERIFICATION_COPY} disabled={readiness !== 'verifiable'} onClick={() => openVerification(row)}>
                    <ShieldCheck size={15} />
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && (
        <p style={{ fontSize: 12, color: '#64748b', marginTop: 12 }}>No examination invoices found. Generate one from an approved batch.</p>
      )}
      <p style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
        Print and Download are available on the invoice view — one canonical record, one accounting effect, one verification token.
      </p>
    </div>
  );
};

export default ExaminationInvoices;

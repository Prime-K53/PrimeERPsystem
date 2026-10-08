import React, { useEffect } from 'react';
import {
  X, Eye, Download, DollarSign, History, Ban, Trash2,
  ShieldCheck, ExternalLink, FileText,
} from 'lucide-react';
import type { ExamInvoiceRow, ExamInvoiceMenuKey } from '../ExaminationInvoices';
import type { ExaminationVerificationReadiness } from '../../../utils/invoiceIdentity';
import { PENDING_SYNC_VERIFICATION_COPY } from '../../../utils/invoiceIdentity';

/**
 * ExaminationInvoiceDetailModal — the full-detail view for an examination
 * invoice, owned by the Examination module.
 *
 * Previously "View full detail" navigated away to the general Sales invoice
 * list. That forked exam financials out of the batch workflow (the general
 * detail offers edit/duplicate/credit paths that must never apply to
 * calculation-priced exam invoices). This modal keeps examination billing
 * inside Examination → Invoices: same canonical record, examination-only
 * actions (preview/download/pay/ledger/verify/void/purge, gated exactly
 * like the list menu).
 *
 * Pure presentation: all data flows in via props, all actions delegate
 * out via callbacks. No persistence, no navigation of its own.
 */

const teal = {
  50: '#eef7f6', 200: '#a6d9d3', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39',
};
const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

const ghostButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 14px', borderRadius: 9, background: paper,
  border: `1.4px solid ${hairline}`, color: inkSoft,
  fontSize: 13, fontWeight: 600, cursor: 'pointer',
  fontFamily: "'Inter','DM Sans',sans-serif", transition: 'all .15s ease',
};

const gradientButtonStyle: React.CSSProperties = {
  ...ghostButtonStyle,
  background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
  border: 'none', color: '#fff',
  boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
};

export interface ExaminationInvoiceDetailModalProps {
  row: ExamInvoiceRow;
  /** Canonical invoice record (line items, totals, exam context). */
  record: Record<string, any> | null;
  batchRecordId: string;
  readiness: ExaminationVerificationReadiness;
  balance: number;
  daysOverdue: number;
  /** Same gating as the list menu — actions render only when listed here. */
  menuKeys: ExamInvoiceMenuKey[];
  currencySymbol: string;
  onClose: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onPayment: () => void;
  onLedger: () => void;
  onVerify: () => void;
  onVoid: () => void;
  onPurge: () => void;
  onOpenBatch: () => void;
}

interface LineItemView {
  key: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

const toLineItems = (record: Record<string, any> | null): LineItemView[] => {
  const items = Array.isArray(record?.items) ? record.items : [];
  return items.map((item: Record<string, any>, index: number) => {
    const quantity = Number(item?.quantity ?? 1) || 0;
    const lineTotal = Number(item?.total ?? item?.amount ?? (quantity * Number(item?.price ?? item?.unitPrice ?? 0))) || 0;
    const unitPrice = quantity > 0 ? lineTotal / quantity : Number(item?.price ?? item?.unitPrice ?? 0) || 0;
    return {
      key: String(item?.id ?? `line-${index}`),
      name: String(item?.name ?? item?.description ?? `Item ${index + 1}`),
      quantity,
      unitPrice: Math.round(unitPrice * 100) / 100,
      lineTotal: Math.round(lineTotal * 100) / 100,
    };
  });
};

export const ExaminationInvoiceDetailModal: React.FC<ExaminationInvoiceDetailModalProps> = ({
  row, record, batchRecordId, readiness, balance, daysOverdue, menuKeys,
  currencySymbol, onClose, onPreview, onDownload, onPayment, onLedger,
  onVerify, onVoid, onPurge, onOpenBatch,
}) => {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const can = (key: ExamInvoiceMenuKey) => menuKeys.includes(key);
  const items = toLineItems(record);
  const total = Number(record?.totalAmount ?? row.totalAmount) || 0;
  const paid = Number(record?.paidAmount ?? row.paidAmount) || 0;
  const subtotal = Number(record?.subtotal ?? total) || 0;
  const money = (value: number) => `${currencySymbol} ${value.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

  const field = (label: string, value: React.ReactNode) => (
    <div>
      <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.06 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: ink, marginTop: 2 }}>{value}</div>
    </div>
  );

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15,23,42,.6)', padding: '40px 20px',
        fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
      }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div style={{
        width: 760, maxWidth: '100%', maxHeight: '92vh',
        background: paper, borderRadius: 14,
        boxShadow: '0 30px 70px -20px rgba(0,0,0,.55)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
      }}>
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 4,
          background: `linear-gradient(90deg, ${teal[600]}, ${teal[500]} 40%, ${amber[500]} 100%)`,
        }} />

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 18px 14px', borderBottom: `1px solid ${hairline}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 40, height: 40, borderRadius: 10,
              background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0,
            }}>
              <FileText size={19} color="#fff" />
            </div>
            <div>
              <h1 style={{ fontFamily: "'DM Serif Display','Georgia',serif", fontWeight: 400, fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2 }}>
                Examination Invoice
              </h1>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: inkSoft, fontFamily: "'JetBrains Mono',monospace", fontWeight: 700 }}>
                {row.invoiceNumber || row.id} · {row.status || '—'}
                {readiness === 'verifiable' ? ' · Verifiable' : readiness === 'pending-sync' ? ' · Pending sync' : ''}
              </p>
            </div>
          </div>
          <button type="button" onClick={onClose} style={{ ...ghostButtonStyle, padding: 8 }} title="Close (Esc)">
            <X size={15} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Amount banner */}
          <div style={{ background: teal[50], borderRadius: 12, padding: '12px 16px', border: `1px solid ${hairline}`, display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Total billed</div>
              <div style={{ fontSize: 20, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{money(total)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Paid</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: teal[700], fontVariantNumeric: 'tabular-nums' }}>{money(paid)}</div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Balance due</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: balance > 0 ? amber[600] : teal[700], fontVariantNumeric: 'tabular-nums' }}>
                {money(balance)}{daysOverdue > 0 ? ` (${daysOverdue}d overdue)` : ''}
              </div>
            </div>
          </div>

          {/* Parties + dates */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '10px 20px' }}>
            {field('School / Customer', row.customerName || '—')}
            {field('Batch', batchRecordId ? (
              <button onClick={onOpenBatch} style={{ color: teal[600], fontWeight: 700, textDecoration: 'underline', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 13 }}>
                {row.batchNumber || 'Open batch'}
              </button>
            ) : (row.batchNumber || '—'))}
            {field('Invoice date', row.date ? new Date(row.date).toLocaleDateString() : '—')}
            {field('Due date', row.dueDate ? new Date(row.dueDate).toLocaleDateString() : '—')}
            {field('Academic year', String(record?.academicYear ?? '—'))}
            {field('Term', String(record?.term ?? '—'))}
            {field('Exam type', String(record?.examType ?? record?.exam_type ?? '—'))}
            {field('Reference', String(record?.reference ?? row.invoiceNumber ?? '—'))}
          </div>

          {/* Line items */}
          <div>
            <h3 style={{ fontSize: 12.5, fontWeight: 700, margin: '0 0 8px' }}>Billed items ({items.length})</h3>
            {items.length > 0 ? (
              <div style={{ border: `1px solid ${hairline}`, borderRadius: 8, overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: teal[50], textAlign: 'left' }}>
                      <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase' }}>Item</th>
                      <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', textAlign: 'right' }}>Qty</th>
                      <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', textAlign: 'right' }}>Unit price</th>
                      <th style={{ padding: '8px 12px', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', textAlign: 'right' }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => (
                      <tr key={item.key} style={{ borderTop: `1px solid ${hairline}` }}>
                        <td style={{ padding: '7px 12px', fontWeight: 600 }}>{item.name}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{item.quantity.toLocaleString()}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(item.unitPrice)}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{money(item.lineTotal)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: `1px solid ${hairline}`, background: '#f8f6f2', fontWeight: 700 }}>
                      <td colSpan={3} style={{ padding: '8px 12px', textAlign: 'right', color: inkSoft, fontSize: 11, textTransform: 'uppercase' }}>
                        Subtotal{subtotal !== total ? ' / Total' : ''}
                      </td>
                      <td style={{ padding: '8px 12px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{money(total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <p style={{ fontSize: 12.5, color: inkSoft, fontStyle: 'italic', margin: 0 }}>
                No line-item breakdown stored on this record — totals above are authoritative.
              </p>
            )}
            <p style={{ fontSize: 11, color: inkSoft, margin: '8px 0 0' }}>
              Examination invoices are priced only by the approved batch calculation snapshot and post no tax/VAT.
            </p>
          </div>

          {/* Verification */}
          <div style={{ border: `1px solid ${hairline}`, borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 12.5 }}>
              <span style={{ fontWeight: 700 }}>Public verification: </span>
              {readiness === 'verifiable' ? 'ready — the QR on the PDF resolves to this record.'
                : readiness === 'pending-sync' ? PENDING_SYNC_VERIFICATION_COPY
                  : 'unavailable for this record.'}
            </div>
            <button
              onClick={onVerify}
              disabled={readiness !== 'verifiable'}
              style={{ ...ghostButtonStyle, opacity: readiness === 'verifiable' ? 1 : 0.5, cursor: readiness === 'verifiable' ? 'pointer' : 'not-allowed' }}
            >
              <ShieldCheck size={14} /> Open verification
            </button>
          </div>

          {record?.notes && (
            <p style={{ fontSize: 12.5, fontStyle: 'italic', color: inkSoft, margin: 0 }}>“{String(record.notes)}”</p>
          )}
        </div>

        {/* Footer actions */}
        <div style={{ padding: '12px 18px', borderTop: `1px solid ${hairline}`, background: '#f8f6f2', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button onClick={onPreview} style={gradientButtonStyle}><Eye size={14} /> Preview PDF</button>
          <button onClick={onDownload} style={ghostButtonStyle}><Download size={14} /> Download</button>
          {can('payment') && <button onClick={onPayment} style={ghostButtonStyle}><DollarSign size={14} /> Receive payment</button>}
          {can('ledger') && <button onClick={onLedger} style={ghostButtonStyle}><History size={14} /> Ledger</button>}
          {batchRecordId && <button onClick={onOpenBatch} style={ghostButtonStyle}><ExternalLink size={14} /> Batch</button>}
          <span style={{ flex: 1 }} />
          {can('void') && (
            <button onClick={onVoid} style={{ ...ghostButtonStyle, color: amber[600], borderColor: amber[300] }}><Ban size={14} /> Void</button>
          )}
          {can('purge') && (
            <button onClick={onPurge} style={{ ...ghostButtonStyle, color: danger, borderColor: `${danger}55` }}><Trash2 size={14} /> Delete permanently</button>
          )}
          <button onClick={onClose} style={ghostButtonStyle}><X size={14} /> Close</button>
        </div>
      </div>
    </div>
  );
};

export default ExaminationInvoiceDetailModal;

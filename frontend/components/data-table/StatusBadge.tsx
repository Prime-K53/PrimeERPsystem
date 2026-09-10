import React from 'react';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const NORMALISED: Record<string, { label: string; tone: StatusTone }> = {
  paid: { label: 'Paid', tone: 'success' },
  fulfilled: { label: 'Paid', tone: 'success' },
  completed: { label: 'Completed', tone: 'success' },
  active: { label: 'Active', tone: 'success' },
  cleared: { label: 'Cleared', tone: 'success' },
  approved: { label: 'Approved', tone: 'success' },
  accepted: { label: 'Accepted', tone: 'success' },
  delivered: { label: 'Delivered', tone: 'success' },
  confirmed: { label: 'Confirmed', tone: 'success' },
  converted: { label: 'Converted', tone: 'success' },
  ready: { label: 'Ready', tone: 'success' },
  partiallypaid: { label: 'Partially paid', tone: 'warning' },
  partial: { label: 'Partially paid', tone: 'warning' },
  pending: { label: 'Pending', tone: 'warning' },
  unpaid: { label: 'Unpaid', tone: 'warning' },
  processing: { label: 'Processing', tone: 'info' },
  inprogress: { label: 'In progress', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'info' },
  submitted: { label: 'Submitted', tone: 'info' },
  shipped: { label: 'Shipped', tone: 'info' },
  overdue: { label: 'Overdue', tone: 'danger' },
  draft: { label: 'Draft', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
  voided: { label: 'Voided', tone: 'danger' },
  rejected: { label: 'Rejected', tone: 'danger' },
  expired: { label: 'Expired', tone: 'neutral' },
};

const TONE_STYLE: Record<StatusTone, { bg: string; fg: string; border: string; dot: string }> = {
  success: { bg: '#ECFDF5', fg: '#065F46', border: '#A7F3D0', dot: '#059669' },
  warning: { bg: '#FFFBEB', fg: '#92400E', border: '#FDE68A', dot: '#D97706' },
  danger: { bg: '#FEF2F2', fg: '#991B1B', border: '#FECACA', dot: '#DC2626' },
  info: { bg: '#EFF6FF', fg: '#1E40AF', border: '#BFDBFE', dot: '#2563EB' },
  neutral: { bg: '#F8FAFC', fg: '#475569', border: '#E2E8F0', dot: '#94A3B8' },
};

interface Props {
  status: string;
  size?: 'sm' | 'md';
}

/**
 * ERP-wide status badge. Text + dot (never colour alone), high-contrast
 * Prime palette, deterministic mapping with graceful fallback.
 */
export const StatusBadge: React.FC<Props> = ({ status, size = 'md' }) => {
  const key = String(status ?? '').toLowerCase().replace(/[\s-]+/g, '_').replace(/__+/g, '_');
  const squashed = key.replace(/_/g, '');
  const meta =
    NORMALISED[key] ?? NORMALISED[squashed] ?? { label: String(status || '—'), tone: 'neutral' as StatusTone };
  const s = TONE_STYLE[meta.tone];
  const sm = size === 'sm';
  return (
    <span
      role="status"
      aria-label={`Status: ${meta.label}`}
      className="rpt-badge"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        background: s.bg,
        color: s.fg,
        border: `1px solid ${s.border}`,
        fontSize: sm ? 10 : 11,
        fontWeight: 700,
        letterSpacing: '0.02em',
        padding: sm ? '2px 8px' : '3px 10px',
        borderRadius: 9999,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
      }}
    >
      <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: '50%', background: s.dot, flexShrink: 0 }} />
      {meta.label}
    </span>
  );
};

export default StatusBadge;

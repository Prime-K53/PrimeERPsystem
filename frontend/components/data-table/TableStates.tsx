import React from 'react';
import { AlertTriangle, Inbox, RotateCcw } from 'lucide-react';

export const TableLoadingSkeleton: React.FC<{ rows?: number; columns?: number }> = ({
  rows = 8,
  columns = 5,
}) => (
  <div className="rpt-state" role="status" aria-label="Loading records" aria-live="polite">
    {/* Desktop skeleton table */}
    <div className="rpt-only-wide" aria-hidden="true" style={{ width: '100%' }}>
      <div className="rpt-skeleton-head" style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 12, padding: '10px 14px' }}>
        {Array.from({ length: columns }).map((_, i) => (
          <div key={i} className="rpt-pulse" style={{ height: 12, borderRadius: 6 }} />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'grid', gridTemplateColumns: `repeat(${columns}, 1fr)`, gap: 12, padding: '10px 14px', borderTop: '1px solid #f1f0ec' }}>
          {Array.from({ length: columns }).map((_, c) => (
            <div key={c} className="rpt-pulse" style={{ height: 14, borderRadius: 6, opacity: 0.7 }} />
          ))}
        </div>
      ))}
    </div>
    {/* Mobile skeleton cards */}
    <div className="rpt-only-narrow" aria-hidden="true" style={{ width: '100%' }}>
      {Array.from({ length: Math.min(rows, 5) }).map((_, r) => (
        <div key={r} style={{ padding: '14px', borderBottom: '1px solid #f1f0ec' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div className="rpt-pulse" style={{ height: 14, width: '55%', borderRadius: 6 }} />
            <div className="rpt-pulse" style={{ height: 14, width: 84, borderRadius: 6 }} />
          </div>
          <div className="rpt-pulse" style={{ height: 12, width: '40%', borderRadius: 6, marginTop: 10 }} />
        </div>
      ))}
    </div>
  </div>
);

export const TableEmptyState: React.FC<{
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}> = ({ title, description, actionLabel, onAction }) => (
  <div className="rpt-state" role="status" style={{ padding: '48px 20px', textAlign: 'center' }}>
    <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, color: '#c9c2b4' }}>
      <Inbox size={40} />
    </div>
    <h3 style={{ fontSize: 15, fontWeight: 700, color: '#23282A', margin: '0 0 6px' }}>{title}</h3>
    {description && (
      <p style={{ fontSize: 13, color: '#5c6567', margin: '0 auto 16px', maxWidth: 420, lineHeight: 1.5 }}>{description}</p>
    )}
    {actionLabel && onAction && (
      <button type="button" onClick={onAction} className="rpt-btn-primary" style={{ minHeight: 44 }}>
        {actionLabel}
      </button>
    )}
  </div>
);

export const TableErrorState: React.FC<{ message?: string; onRetry?: () => void }> = ({
  message,
  onRetry,
}) => (
  <div className="rpt-state" role="alert" style={{ padding: '48px 20px', textAlign: 'center' }}>
    <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', marginBottom: 12, color: '#b5493f' }}>
      <AlertTriangle size={40} />
    </div>
    <h3 style={{ fontSize: 15, fontWeight: 700, color: '#23282A', margin: '0 0 6px' }}>Couldn&apos;t load records</h3>
    <p style={{ fontSize: 13, color: '#5c6567', margin: '0 auto 16px', maxWidth: 420 }}>{message || 'Something went wrong. Please try again.'}</p>
    {onRetry && (
      <button type="button" onClick={onRetry} className="rpt-btn-secondary" style={{ minHeight: 44 }}>
        <RotateCcw size={15} aria-hidden="true" /> Try again
      </button>
    )}
  </div>
);

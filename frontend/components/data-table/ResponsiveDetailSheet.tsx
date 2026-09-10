import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { DetailField } from './types';

interface Props {
  title: string;
  subtitle?: string;
  amountSlot?: React.ReactNode;
  statusSlot?: React.ReactNode;
  fields: DetailField[];
  actions?: React.ReactNode;
  onClose: () => void;
}

/**
 * Row detail surface: bottom sheet on narrow containers (uses the existing
 * `.bottom-sheet-*` system), centred dialog on wide containers. No new modal
 * stack — purely presentational, caller keeps business logic.
 */
export const ResponsiveDetailSheet: React.FC<Props> = ({
  title,
  subtitle,
  amountSlot,
  statusSlot,
  fields,
  actions,
  onClose,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const prevFocus = useRef<Element | null>(null);

  useEffect(() => {
    prevFocus.current = document.activeElement;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      (prevFocus.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="rpt-sheet-root">
      <div className="bottom-sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="bottom-sheet-panel rpt-sheet-panel"
        style={{ padding: 0 }}
      >
        <div style={{ position: 'sticky', top: 0, background: 'var(--paper, #FEFDFB)', padding: '16px 20px 12px', borderBottom: '1px solid #efe9dd' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <h2 style={{ fontSize: 16, fontWeight: 700, color: '#23282A', margin: 0, lineHeight: 1.3 }}>{title}</h2>
              {subtitle && <p style={{ fontSize: 12.5, color: '#5c6567', margin: '4px 0 0' }}>{subtitle}</p>}
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close details"
              className="rpt-icon-btn"
              style={{ minWidth: 44, minHeight: 44 }}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          {(amountSlot || statusSlot) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginTop: 12, flexWrap: 'wrap' }}>
              <div className="rpt-money-lg">{amountSlot}</div>
              <div>{statusSlot}</div>
            </div>
          )}
        </div>
        <dl style={{ margin: 0, padding: '12px 20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '14px 16px' }}>
          {fields.map((f) => (
            <div key={f.label} style={{ minWidth: 0 }}>
              <dt style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#5c6567', marginBottom: 4 }}>
                {f.label}
              </dt>
              <dd style={{ margin: 0, fontSize: 13.5, color: '#23282A', fontWeight: 500, overflowWrap: 'anywhere' }}>{f.value ?? '—'}</dd>
            </div>
          ))}
        </dl>
        {actions && (
          <div style={{ display: 'flex', gap: 10, padding: '12px 20px 20px', flexWrap: 'wrap' }}>{actions}</div>
        )}
      </div>
    </div>
  );
};

export default ResponsiveDetailSheet;

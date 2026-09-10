import React from 'react';
import { X, ChevronRight } from 'lucide-react';

/**
 * Shared modal chrome for Printing Contracts, mirroring the Add Customer
 * modal (`views/sales/components/ClientModal.tsx`): overlay, accent stripe,
 * icon-tile header with serif title, styled form controls, footer with step
 * hint + ghost/gradient actions.
 *
 * Deliberately NO sidebar nav — all contract modals are single-column with
 * an optional horizontal tab strip supplied by the caller.
 */

export const contractTeal = {
  50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
  400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
  800: '#0b3e39', 900: '#082e2a',
};
export const contractAmber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
export const contractPaper = '#FEFDFB';
export const contractInk = '#23282A';
export const contractInkSoft = '#5c6567';
export const contractHairline = '#e4ddd1';
export const contractDanger = '#b5493f';

export const contractLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  fontSize: 12, fontWeight: 600, color: contractTeal[800],
  marginBottom: 6, letterSpacing: 0.01,
};

export const contractInputStyle: React.CSSProperties = {
  width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5,
  color: contractInk, background: contractPaper,
  border: `1.4px solid ${contractHairline}`, borderRadius: 9,
  padding: '9px 12px', outline: 'none',
  transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease',
};

export const contractTextareaStyle: React.CSSProperties = {
  ...contractInputStyle, resize: 'none', minHeight: 66, lineHeight: 1.5,
};

export const contractSelectStyle: React.CSSProperties = {
  ...contractInputStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 12px center',
  paddingRight: 30,
  cursor: 'pointer',
};

export const contractGridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 18,
};

const requiredMark = <span style={{ color: contractDanger, fontWeight: 700 }}>*</span>;
export const ContractRequiredMark: React.FC = () => requiredMark;

export const ContractSectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '26px 0 14px' }}>
    <span style={{
      fontSize: 11, fontWeight: 800, letterSpacing: 0.12,
      textTransform: 'uppercase', color: contractTeal[700], whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
    <div style={{ flex: 1, height: 1, background: contractHairline }} />
  </div>
);

/* ── Page (dashboard) language — same tokens, non-modal surfaces ── */

export const contractIconTileStyle = (size = 40): React.CSSProperties => ({
  width: size, height: size, borderRadius: 10,
  background: `linear-gradient(155deg, ${contractTeal[500]}, ${contractTeal[700]})`,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0,
});

export const contractPageTitleStyle: React.CSSProperties = {
  fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
  fontSize: 22, margin: 0, color: contractTeal[800], letterSpacing: 0.2,
};

export const contractPageSubtitleStyle: React.CSSProperties = {
  margin: '2px 0 0', fontSize: 11.5, color: contractInkSoft, letterSpacing: 0.02,
};

export const contractFilterControlStyle: React.CSSProperties = {
  fontFamily: "'Inter', sans-serif", fontSize: 12, fontWeight: 600,
  color: contractInkSoft, background: contractPaper,
  border: `1.4px solid ${contractHairline}`, borderRadius: 9,
  padding: '7px 10px', outline: 'none', width: 'auto',
};

export const contractFilterSelectStyle: React.CSSProperties = {
  ...contractFilterControlStyle,
  appearance: 'none',
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat',
  backgroundPosition: 'right 10px center',
  paddingRight: 28,
  cursor: 'pointer',
};

export const ContractCloseButton: React.FC<{ onClose: () => void; label?: string }> = ({ onClose, label = 'Close' }) => (
  <button onClick={onClose} aria-label={label} style={{
    width: 32, height: 32, borderRadius: 8,
    border: `1px solid ${contractHairline}`, background: contractPaper, color: contractInkSoft,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer', transition: 'all .15s ease', fontSize: 16, flexShrink: 0,
  }}
    onMouseEnter={e => { e.currentTarget.style.background = contractTeal[50]; e.currentTarget.style.color = contractTeal[700]; e.currentTarget.style.borderColor = contractTeal[200]; }}
    onMouseLeave={e => { e.currentTarget.style.background = contractPaper; e.currentTarget.style.color = contractInkSoft; e.currentTarget.style.borderColor = contractHairline; }}
  >
    <X size={15} />
  </button>
);

export const ContractGhostButton: React.FC<{
  onClick: () => void; children: React.ReactNode; type?: 'button' | 'submit';
  compact?: boolean;
}> = ({ onClick, children, type = 'button', compact }) => (
  <button type={type} onClick={onClick} style={{
    fontFamily: "'Inter', sans-serif", fontSize: compact ? 12 : 13, fontWeight: 600,
    padding: compact ? '7px 14px' : '9px 18px', borderRadius: 9, cursor: 'pointer',
    background: contractPaper, border: `1.4px solid ${contractHairline}`, color: contractInkSoft,
    display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s ease',
    whiteSpace: 'nowrap',
  }}
    onMouseEnter={e => { e.currentTarget.style.background = contractTeal[50]; e.currentTarget.style.color = contractTeal[800]; e.currentTarget.style.borderColor = contractTeal[200]; }}
    onMouseLeave={e => { e.currentTarget.style.background = contractPaper; e.currentTarget.style.color = contractInkSoft; e.currentTarget.style.borderColor = contractHairline; }}
  >
    {children}
  </button>
);

export const ContractPrimaryButton: React.FC<{
  onClick?: () => void; children: React.ReactNode; disabled?: boolean; type?: 'button' | 'submit';
  compact?: boolean; chevron?: boolean;
}> = ({ onClick, children, disabled, type = 'button', compact, chevron = true }) => (
  <button type={type} onClick={onClick} disabled={disabled} style={{
    fontFamily: "'Inter', sans-serif", fontSize: compact ? 12 : 13, fontWeight: 600,
    padding: compact ? '7px 14px' : '9px 18px', borderRadius: 9, cursor: disabled ? 'not-allowed' : 'pointer',
    border: '1.4px solid transparent', opacity: disabled ? 0.6 : 1,
    background: `linear-gradient(155deg, ${contractTeal[500]}, ${contractTeal[700]})`,
    color: '#fff', display: 'flex', alignItems: 'center', gap: 7,
    boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
    transition: 'all .15s ease', whiteSpace: 'nowrap',
  }}
    onMouseEnter={e => { if (!disabled) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 8px 20px -6px rgba(15,84,76,.65)'; } }}
    onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = '0 6px 16px -6px rgba(15,84,76,.55)'; }}
  >
    {children}
    {chevron && <ChevronRight size={14} />}
  </button>
);

interface ContractModalShellProps {
  width?: number;
  zIndex?: number;
  icon: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  footerHint?: React.ReactNode;
  /** Custom footer actions. Defaults to Cancel + submit button. */
  footerActions?: React.ReactNode;
  submitLabel?: string;
  onSubmit?: () => void;
  submitDisabled?: boolean;
  children: React.ReactNode;
}

export const ContractModalShell: React.FC<ContractModalShellProps> = ({
  width = 920, zIndex = 9000, icon, title, subtitle, onClose,
  footerHint, footerActions, submitLabel, onSubmit, submitDisabled, children,
}) => (
  <div style={{
    position: 'fixed', inset: 0, zIndex,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(15, 23, 42, 0.6)',
    padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: contractInk,
  }} onClick={() => onClose()}>
    <div style={{
      width, maxWidth: '100%', maxHeight: '92vh',
      background: contractPaper, borderRadius: 14,
      boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative',
    }} onClick={e => e.stopPropagation()}>
      {/* Accent stripe */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 4,
        background: `linear-gradient(90deg, ${contractTeal[600]}, ${contractTeal[400]} 40%, ${contractAmber[500]} 100%)`,
      }} />

      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '22px 28px 18px',
        borderBottom: `1px solid ${contractHairline}`,
        background: contractPaper, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10,
            background: `linear-gradient(155deg, ${contractTeal[500]}, ${contractTeal[700]})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0,
          }}>
            {icon}
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 style={{
              fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
              fontSize: 22, margin: 0, color: contractTeal[800], letterSpacing: 0.2,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {title}
            </h1>
            {subtitle && (
              <p style={{ margin: '2px 0 0', fontSize: 11.5, color: contractInkSoft, letterSpacing: 0.02 }}>
                {subtitle}
              </p>
            )}
          </div>
        </div>
        <ContractCloseButton onClose={onClose} />
      </div>

      {/* Body — single column, no sidebar */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 30px 8px', minHeight: 0 }}>
        {children}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, padding: '16px 28px',
        borderTop: `1px solid ${contractHairline}`, background: contractPaper, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: contractInkSoft, minWidth: 0 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: contractAmber[500], flexShrink: 0 }} />
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{footerHint}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
          {footerActions ?? (
            <>
              <ContractGhostButton onClick={onClose}>Cancel</ContractGhostButton>
              {onSubmit && submitLabel && (
                <ContractPrimaryButton onClick={onSubmit} disabled={submitDisabled}>
                  {submitDisabled ? 'Saving…' : submitLabel}
                </ContractPrimaryButton>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  </div>
);

export default ContractModalShell;

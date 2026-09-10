import React from 'react';
import { X, ChevronRight } from 'lucide-react';

/* ── Shared Finance chrome: exact Add-Customer modal language (mirrors ClientModal.tsx) ──
 * Single source of truth for every Finance Hub tab (Payroll, Fixed Assets, Loans,
 * Owner Equity, Year-End Closing, Chart of Accounts, Banking, Transfers, VAT).
 * Pages AND all modals must import from here — no local token duplication.
 */
export const teal = {
    50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7',
    400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c',
    800: '#0b3e39', 900: '#082e2a'
};
export const amber = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
export const paper = '#FEFDFB';
export const ink = '#23282A';
export const inkSoft = '#5c6567';
export const hairline = '#e4ddd1';
export const danger = '#b5493f';
export const assets = teal[500];

export const pageFont: React.CSSProperties = {
    fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
};

export const labelStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 12, fontWeight: 600, color: teal[800],
    marginBottom: 6, letterSpacing: 0.01
};

export const inputStyle: React.CSSProperties = {
    width: '100%', fontFamily: "'Inter', sans-serif", fontSize: 13.5,
    color: ink, background: paper,
    border: `1.4px solid ${hairline}`, borderRadius: 9,
    padding: '9px 12px', outline: 'none',
    transition: 'border-color .15s ease, box-shadow .15s ease, background .15s ease'
};

export const textareaStyle: React.CSSProperties = {
    ...inputStyle, resize: 'none', minHeight: 66, lineHeight: 1.5
};

export const selectStyle: React.CSSProperties = {
    ...inputStyle,
    appearance: 'none',
    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235c6567'/%3E%3C/svg%3E")`,
    backgroundRepeat: 'no-repeat',
    backgroundPosition: 'right 12px center',
    paddingRight: 30,
    cursor: 'pointer'
};

export const sectionLabelStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 10,
    margin: '4px 0 14px',
    fontSize: 11, fontWeight: 700, color: teal[800],
    textTransform: 'uppercase', letterSpacing: 0.1,
};

export const btnGhostStyle: React.CSSProperties = {
    fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
    padding: '9px 18px', borderRadius: 9, cursor: 'pointer',
    background: paper, border: `1.4px solid ${hairline}`, color: inkSoft,
    display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s ease'
};

export const btnPrimaryStyle: React.CSSProperties = {
    fontFamily: "'Inter', sans-serif", fontSize: 13, fontWeight: 600,
    padding: '9px 18px', borderRadius: 9, cursor: 'pointer', border: '1.4px solid transparent',
    background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
    color: '#fff', display: 'flex', alignItems: 'center', gap: 7,
    boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
    transition: 'all .15s ease'
};

export const btnDangerStyle: React.CSSProperties = {
    ...btnPrimaryStyle,
    background: 'linear-gradient(155deg, #c05a4e, #8f352b)',
    boxShadow: '0 6px 16px -6px rgba(181,73,63,.55)',
};

export const modalOverlayStyle: React.CSSProperties = {
    position: 'fixed', inset: 0, zIndex: 9999,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'rgba(15, 23, 42, 0.6)',
    padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
};

export const modalShell = (width: number): React.CSSProperties => ({
    width, maxWidth: '100%', maxHeight: '92vh',
    background: paper, borderRadius: 14,
    boxShadow: '0 30px 70px -20px rgba(0,0,0,.55), 0 8px 24px -8px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.04)',
    display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative'
});

export const AccentStripe: React.FC = () => (
    <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 4, zIndex: 2,
        background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)`
    }} />
);

export const ghostHover = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { const t = e.currentTarget as HTMLElement; t.style.background = teal[50]; t.style.color = teal[800]; t.style.borderColor = teal[200]; },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { const t = e.currentTarget as HTMLElement; t.style.background = paper; t.style.color = inkSoft; t.style.borderColor = hairline; },
};

export const liftHover = {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(-1px)'; },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => { (e.currentTarget as HTMLElement).style.transform = 'translateY(0)'; },
};

export const ModalHeader: React.FC<{ icon: React.ReactNode; title: string; subtitle?: string; onClose: () => void; dangerTile?: boolean }> = ({ icon, title, subtitle, onClose, dangerTile }) => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '22px 28px 18px',
        borderBottom: `1px solid ${hairline}`,
        background: paper, flexShrink: 0,
    }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
            <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: dangerTile
                    ? 'linear-gradient(155deg, #c05a4e, #8f352b)'
                    : `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: dangerTile ? '0 4px 10px -3px rgba(143,53,43,.6)' : '0 4px 10px -3px rgba(15,84,76,.6)',
                flexShrink: 0
            }}>
                {icon}
            </div>
            <div style={{ minWidth: 0 }}>
                <h1 style={{
                    fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
                    fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                    {title}
                </h1>
                {subtitle && (
                    <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>{subtitle}</p>
                )}
            </div>
        </div>
        <button onClick={onClose} aria-label="Close" style={{
            width: 32, height: 32, borderRadius: 8,
            border: `1px solid ${hairline}`, background: paper, color: inkSoft,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all .15s ease', fontSize: 16, flexShrink: 0,
        }}
            onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[700]; e.currentTarget.style.borderColor = teal[200]; }}
            onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}
        >
            <X size={15} />
        </button>
    </div>
);

export const ModalFooter: React.FC<{ stepLabel?: string; onCancel: () => void; submitLabel: string; submitFormId?: string; danger?: boolean; onSubmit?: () => void }> = ({ stepLabel, onCancel, submitLabel, submitFormId, danger, onSubmit }) => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 14, padding: '16px 28px',
        borderTop: `1px solid ${hairline}`, background: paper, flexShrink: 0,
    }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: inkSoft }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: amber[500] }} />
            {stepLabel || 'Finance ledger'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
            <button type="button" onClick={onCancel}
                style={btnGhostStyle}
                onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; }}
                onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; }}>
                Cancel
            </button>
            <button
                type={submitFormId ? 'submit' : 'button'}
                form={submitFormId}
                onClick={submitFormId ? undefined : onSubmit}
                style={danger ? btnDangerStyle : btnPrimaryStyle}
                onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; }}>
                {submitLabel}
                <ChevronRight size={14} />
            </button>
        </div>
    </div>
);

/** Page header in the Add-Customer modal header language (no sidebar). */
export const PageHeader: React.FC<{
    icon: React.ReactNode; title: string; subtitle: string;
    actions?: React.ReactNode;
}> = ({ icon, title, subtitle, actions }) => (
    <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '22px 28px 18px',
        borderBottom: `1px solid ${hairline}`,
        background: paper, position: 'relative',
    }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: `linear-gradient(90deg, ${teal[600]}, ${teal[400]} 40%, ${amber[500]} 100%)` }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
                width: 40, height: 40, borderRadius: 10,
                background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 10px -3px rgba(15,84,76,.6)', flexShrink: 0
            }}>
                {icon}
            </div>
            <div>
                <h1 style={{
                    fontFamily: "'DM Serif Display', 'Georgia', serif", fontWeight: 400,
                    fontSize: 22, margin: 0, color: teal[800], letterSpacing: 0.2
                }}>
                    {title}
                </h1>
                <p style={{ margin: '2px 0 0', fontSize: 11.5, color: inkSoft, letterSpacing: 0.02 }}>{subtitle}</p>
            </div>
        </div>
        {actions && <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{actions}</div>}
    </div>
);

export interface KpiItem { label: string; value: string; icon: any; color: string; bg: string }

export const KpiCards: React.FC<{ items: KpiItem[] }> = ({ items }) => (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14, padding: '18px 28px 0' }}>
        {items.map((item, idx) => (
            <div key={idx} style={{ padding: '14px 16px', borderRadius: 14, background: paper, border: `1.4px solid ${hairline}`, borderLeft: `4px solid ${item.color}`, boxShadow: '0 1px 3px rgba(0,0,0,.04)', display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                <div style={{ padding: 10, borderRadius: 10, background: item.bg, color: item.color, display: 'inline-flex' }}><item.icon size={20} /></div>
                <div style={{ minWidth: 0 }}>
                    <p style={{ fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08, margin: '0 0 6px' }}>{item.label}</p>
                    <p style={{ fontSize: 18, fontWeight: 700, color: ink, margin: 0, fontFamily: "'JetBrains Mono', monospace", letterSpacing: -0.2 }}>{item.value}</p>
                </div>
            </div>
        ))}
    </div>
);

export const GhostButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ style, children, ...rest }) => (
    <button
        {...rest}
        style={{ ...btnGhostStyle, ...(style || {}) }}
        onMouseEnter={e => { e.currentTarget.style.background = teal[50]; e.currentTarget.style.color = teal[800]; e.currentTarget.style.borderColor = teal[200]; (rest as any).onMouseEnter?.(e); }}
        onMouseLeave={e => { e.currentTarget.style.background = paper; e.currentTarget.style.color = inkSoft; e.currentTarget.style.borderColor = hairline; (rest as any).onMouseLeave?.(e); }}
    >
        {children}
    </button>
);

export const PrimaryButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ style, children, ...rest }) => (
    <button
        {...rest}
        style={{ ...btnPrimaryStyle, ...(style || {}) }}
        onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; (rest as any).onMouseEnter?.(e); }}
        onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; (rest as any).onMouseLeave?.(e); }}
    >
        {children}
    </button>
);

export const EmptyState: React.FC<{ icon: React.ReactNode; title: string; hint?: string }> = ({ icon, title, hint }) => (
    <div style={{ textAlign: 'center', padding: 48, border: `2px dashed ${teal[100]}`, borderRadius: 12, background: teal[50] }}>
        <div style={{ margin: '0 auto 12', color: teal[200], display: 'flex', justifyContent: 'center' }}>{icon}</div>
        <p style={{ fontSize: 13, fontWeight: 700, color: teal[300], margin: 0 }}>{title}</p>
        {hint && <p style={{ fontSize: 11.5, color: inkSoft, margin: '6px 0 0' }}>{hint}</p>}
    </div>
);

export const tableHeadCell: React.CSSProperties = { padding: '12px 16px', fontWeight: 700 };
export const tableHeadRow: React.CSSProperties = { background: teal[50], textAlign: 'left', fontSize: 10, fontWeight: 700, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.08 };
export const tableCard: React.CSSProperties = { background: paper, border: `1.4px solid ${hairline}`, borderRadius: 14, overflow: 'hidden', boxShadow: '0 1px 3px rgba(0,0,0,.04)' };

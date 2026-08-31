import React from 'react';

interface Props {
  title: string;
  subtitle?: string;
  icon?: React.ElementType;
  iconBg?: string;
  iconColor?: string;
  action?: {
    label: string;
    onClick: () => void;
    icon?: React.ElementType;
    disabled?: boolean;
  };
  children?: React.ReactNode;
  style?: React.CSSProperties;
}

const PortalPageHeader: React.FC<Props> = ({
  title,
  subtitle,
  icon: Icon,
  iconBg = 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
  iconColor = '#fff',
  action,
  children,
  style,
}) => {
  return (
    <div
      className="portal-page-header glass-panel-premium rounded-2xl p-5 flex items-center justify-between flex-wrap gap-4"
      style={{
        background: 'rgba(255,255,255,0.8)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(226,232,240,0.8)',
        boxShadow: '0 1px 3px rgba(15,23,42,0.02), 0 4px 16px -4px rgba(15,23,42,0.04)',
        borderRadius: 20,
        ...style,
      }}
    >
      <div className="flex items-center gap-4 min-w-0">
        {Icon && (
          <div
            className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg"
            style={{
              background: iconBg,
              boxShadow: '0 4px 16px -4px rgba(99,102,241,0.35)',
            }}
          >
            <Icon size={22} color={iconColor} />
          </div>
        )}
        <div className="min-w-0">
          <h1
            className="text-xl md:text-2xl font-extrabold text-slate-900 tracking-tight leading-tight"
            style={{
              fontSize: 22,
              fontWeight: 800,
              color: '#0F172A',
              letterSpacing: '-0.02em',
              margin: 0,
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p
              className="text-xs font-medium text-slate-500 mt-1 leading-relaxed"
              style={{
                fontSize: 13,
                color: '#64748B',
                margin: '4px 0 0',
                lineHeight: 1.5,
              }}
            >
              {subtitle}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {children}
        {action && (
          <button
            onClick={action.onClick}
            disabled={action.disabled}
            className="btn-press px-5 py-2.5 rounded-xl text-xs font-bold text-white inline-flex items-center gap-2 transition-all shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #6366F1 0%, #4F46E5 100%)',
              boxShadow: '0 4px 14px -4px rgba(99,102,241,0.4)',
              fontSize: 13,
              fontWeight: 600,
              padding: '10px 18px',
              borderRadius: 12,
              border: 'none',
              cursor: action.disabled ? 'not-allowed' : 'pointer',
              color: '#fff',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            {action.icon && <action.icon size={15} />}
            <span>{action.label}</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default PortalPageHeader;

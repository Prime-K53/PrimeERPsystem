import React from 'react';
import { TrendingUp, TrendingDown, ArrowUpRight, ChevronRight } from 'lucide-react';

interface ModernKPICardProps {
  label: string;
  value: string | number;
  icon: React.ElementType;
  sublabel?: string;
  sublabelColor?: string;
  trend?: { value: number; positive: boolean; suffix?: string };
  gradient: string;
  glowColor?: string;
  onClick?: () => void;
  badge?: string;
  badgeColor?: string;
  lightBg?: string;
  iconBg?: string;
  description?: string;
  delay?: number;
}

const ModernKPICard: React.FC<ModernKPICardProps> = ({
  label,
  value,
  icon: Icon,
  sublabel,
  sublabelColor,
  trend,
  gradient,
  glowColor,
  onClick,
  badge,
  badgeColor,
  lightBg,
  iconBg,
  description,
  delay = 0,
}) => {
  const bgColor = lightBg || '#fff';
  const iconBackground = iconBg || gradient;

  return (
    <div
      onClick={onClick}
      className="mkpi-card"
      style={{
        position: 'relative',
        borderRadius: 20,
        padding: 0,
        background: bgColor,
        cursor: onClick ? 'pointer' : 'default',
        border: '1px solid rgba(226,232,240,0.8)',
        boxShadow: '0 1px 3px rgba(15,23,42,0.02), 0 4px 12px -4px rgba(15,23,42,0.04)',
        transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
        minHeight: 120,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: `mkpiFadeIn 0.4s ease ${delay}ms both`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'translateY(-3px)';
        e.currentTarget.style.boxShadow = '0 12px 28px -8px rgba(15,44,89,0.12), 0 4px 8px -4px rgba(15,44,89,0.06)';
        e.currentTarget.style.borderColor = 'rgba(99,102,241,0.3)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '0 1px 3px rgba(15,23,42,0.02), 0 4px 12px -4px rgba(15,23,42,0.04)';
        e.currentTarget.style.borderColor = 'rgba(226,232,240,0.8)';
      }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: gradient,
          opacity: 0.03,
        }}
      />

      {glowColor && (
        <div
          className="absolute -top-10 -right-10 w-28 h-28 rounded-full pointer-events-none"
          style={{
            background: `radial-gradient(circle, ${glowColor} 0%, transparent 70%)`,
            opacity: 0.4,
          }}
        />
      )}

      <div style={{ padding: '16px 16px 14px', display: 'flex', flexDirection: 'column', flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
          <div
            className="mkpi-icon"
            style={{
              width: 42,
              height: 42,
              borderRadius: 14,
              background: iconBackground,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              boxShadow: `0 4px 14px -4px ${iconBg || gradient}`,
              transition: 'transform 0.2s ease, box-shadow 0.2s ease',
            }}
          >
            <Icon size={20} strokeWidth={2} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            {badge && (
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                padding: '4px 10px',
                borderRadius: 8,
                background: badgeColor ? `${badgeColor}15` : 'rgba(100,116,139,0.1)',
                color: badgeColor || '#64748B',
                whiteSpace: 'nowrap',
                border: `1px solid ${badgeColor ? `${badgeColor}25` : 'rgba(100,116,139,0.15)'}`,
              }}>
                {badge}
              </span>
            )}
            {onClick && (
              <ChevronRight
                size={18}
                color="#CBD5E0"
                style={{ flexShrink: 0, transition: 'transform 0.15s ease' }}
                className="mkpi-chevron"
              />
            )}
          </div>
        </div>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
          <div style={{
            fontSize: 11,
            fontWeight: 600,
            color: '#64748B',
            marginBottom: 4,
            letterSpacing: '0.01em',
            textTransform: 'uppercase',
          }}>
            {label}
          </div>
          <div style={{
            fontSize: 22,
            fontWeight: 800,
            color: '#0F172A',
            lineHeight: 1.2,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
            fontFamily: "'Inter', sans-serif",
          }}>
            {value}
          </div>

          {description && (
            <div style={{
              fontSize: 11.5,
              color: '#94A3B8',
              marginTop: 4,
              lineHeight: 1.4,
            }}>
              {description}
            </div>
          )}

          {sublabel && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 600,
              color: sublabelColor || '#94A3B8',
              marginTop: 6,
            }}>
              {sublabel}
            </div>
          )}

          {trend && (
            <div style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 8,
              fontSize: 11,
              fontWeight: 700,
              padding: '4px 8px',
              borderRadius: 8,
              background: trend.positive ? 'rgba(5,150,105,0.08)' : 'rgba(220,38,38,0.08)',
              width: 'fit-content',
            }}>
              {trend.positive ? (
                <TrendingUp size={13} color="#059669" />
              ) : (
                <TrendingDown size={13} color="#DC2626" />
              )}
              <span style={{ color: trend.positive ? '#047857' : '#DC2626' }}>
                {Math.round(Number(trend.value) || 0)}%
              </span>
              {trend.suffix && (
                <span style={{ color: '#94A3B8', fontWeight: 500 }}>{trend.suffix}</span>
              )}
            </div>
          )}
        </div>
      </div>

      <style>{`
        @keyframes mkpiFadeIn {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mkpi-card:hover .mkpi-icon {
          transform: translateY(-2px) scale(1.06);
          box-shadow: 0 8px 20px -6px rgba(0,0,0,0.25);
        }
        .mkpi-card:hover .mkpi-chevron {
          transform: translateX(3px);
        }
      `}</style>
    </div>
  );
};

export default ModernKPICard;

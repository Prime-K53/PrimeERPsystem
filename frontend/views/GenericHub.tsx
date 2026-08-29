import React from 'react';
import { useNavigate } from 'react-router-dom';

interface HubOption {
  label: string;
  description: string;
  path?: string;
  onClick?: () => void;
  icon:
    | React.ComponentType<{ size?: number; color?: string }>
    | React.ReactElement<{ size?: number; color?: string }>;
  badge?: number | string;
  badgeColor?: string;
  badgeSecondary?: number | string;
  urgentCount?: number;
}

export interface HubTheme {
  primary: string;
  primaryDark: string;
  primaryLight: string;
  background: string;
  surface: string;
  border: string;
  text: string;
  textMuted: string;
  badgeBg: string;
}

interface GenericHubProps {
  title: string;
  subtitle: string;
  options: HubOption[];
  accentColor?: string;
  theme?: Partial<HubTheme>;
  extraContent?: React.ReactNode;
}

const defaultTheme = {
  primary: '#1f8577',
  primaryDark: '#0f544c',
  primaryLight: '#3fa294',
  background: '#FEFDFB',
  surface: '#FEFDFB',
  border: '#e4ddd1',
  text: '#23282A',
  textMuted: '#5c6567',
  badgeBg: '#dc2626',
};

const GenericHub: React.FC<GenericHubProps> = ({
  title,
  subtitle,
  options,
  accentColor = '#2eb12e',
  theme: customTheme,
  extraContent
}) => {
  const navigate = useNavigate();
  const t = { ...defaultTheme, ...customTheme };

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      background: t.background,
      padding: '40px 20px',
      fontFamily: "'Inter','DM Sans',sans-serif",
      color: t.text,
    }}>
      <div style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        overflow: 'hidden',
        maxWidth: 1200,
        width: '100%',
        margin: '0 auto',
      }}>
        {/* Header */}
        <div style={{
          textAlign: 'center',
          marginBottom: 36,
          animation: 'fadeInUp 0.6s ease-out',
          flexShrink: 0,
        }}>
          <h1 style={{
            fontFamily: "'DM Serif Display', 'Georgia', serif",
            fontWeight: 400,
            fontSize: 36,
            margin: '0 0 8px',
            letterSpacing: 0.2,
            background: `linear-gradient(160deg, ${t.primaryDark}, ${t.primaryLight})`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }}>
            {title} <span style={{
              background: `linear-gradient(160deg, ${t.primaryDark}, ${accentColor})`,
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              backgroundClip: 'text',
            }}>Command</span>
          </h1>
          <p style={{
            margin: 0,
            fontSize: 13.5,
            color: t.textMuted,
            fontWeight: 500,
            lineHeight: 1.5,
            maxWidth: 520,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}>
            {subtitle}
          </p>
        </div>

        <div style={{
          width: '100%',
          maxWidth: 1200,
          padding: '32px 24px',
        }}>
          {/* Navigation Grid */}
          <div style={{
            width: '100%',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
            gap: 16,
          }}>
            {options.map((option, index) => (
              <button
                key={option.label}
                onClick={() => {
                  if (option.onClick) {
                    option.onClick();
                  } else if (option.path) {
                    navigate(option.path);
                  }
                }}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 14,
                  padding: '24px 20px',
                  background: t.surface,
                  borderRadius: 14,
                  border: `1px solid ${t.border}`,
                  boxShadow: '0 1px 3px rgba(0,0,0,.04)',
                  cursor: 'pointer',
                  transition: 'all .2s ease',
                  textAlign: 'center',
                  width: '100%',
                  position: 'relative',
                  animation: `fadeInUp 0.5s ease-out ${index * 0.05}s both`,
                }}
                onMouseEnter={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = t.primaryLight;
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = `0 4px 12px ${t.primary}18`;
                  (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)';
                }}
                onMouseLeave={e => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = t.border;
                  (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 1px 3px rgba(0,0,0,.04)';
                  (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)';
                }}
              >
                <div style={{
                  width: 44,
                  height: 44,
                  borderRadius: 12,
                  background: `linear-gradient(155deg, ${t.primary}, ${t.primaryDark})`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: `0 4px 10px -3px ${t.primary}66`,
                  flexShrink: 0,
                }}>
                  {React.isValidElement(option.icon)
                    ? React.cloneElement(option.icon, { size: 22, color: '#fff' })
                    : React.createElement(option.icon as React.ComponentType, { size: 22, color: '#fff' })}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'center' }}>
                    <h3 style={{
                      fontSize: '16px',
                      fontWeight: 700,
                      color: t.primaryDark,
                      margin: 0,
                      letterSpacing: 0.01,
                    }}>
                      {option.label}
                    </h3>
                    {option.badge !== undefined ? (
                        <span style={{
                          padding: '1px 8px',
                          background: option.badgeColor || t.badgeBg,
                          color: '#fff',
                          borderRadius: 999,
                          fontSize: 10,
                          fontWeight: 800,
                          lineHeight: '18px',
                          minWidth: 20,
                          textAlign: 'center',
                        }}>{option.badge}</span>
                      ) : null}
                      {option.urgentCount !== undefined && option.urgentCount > 0 && (
                        <span style={{
                          padding: '1px 6px',
                          background: '#ef4444',
                          color: '#fff',
                          borderRadius: 999,
                          fontSize: 9,
                          fontWeight: 800,
                          lineHeight: '16px',
                          minWidth: 16,
                          textAlign: 'center',
                        }}>{option.urgentCount}</span>
                      )}
                  </div>
                  <p style={{
                    fontSize: '11px',
                    color: t.textMuted,
                    lineHeight: 1.5,
                    margin: 0,
                  }}>
                    {option.description}
                  </p>
                </div>
              </button>
            ))}
          </div>

          {/* Extra content */}
          {extraContent && (
            <div style={{
              marginTop: 28,
              width: '100%',
              maxWidth: 960,
              animation: 'fadeInUp 0.5s ease-out 0.3s both',
            }}>
              {extraContent}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div style={{
        marginTop: 32,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        flexShrink: 0,
      }}>
        <div style={{ width: 40, height: 1, background: t.border }} />
        <span style={{
          fontSize: 9,
          fontWeight: 800,
          color: t.textMuted,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}>
          Operational Neural Link
        </span>
        <div style={{ width: 40, height: 1, background: t.border }} />
      </div>
    </div>
  );
};

export default GenericHub;

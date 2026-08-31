import React from 'react';

export const FONT_FAMILY = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
export const MONO_FAMILY = "'JetBrains Mono','Fira Code',monospace";

export const colors = {
  navy: {
    50:  '#EFF3F9',
    100: '#D6E1F0',
    200: '#ADC3E0',
    300: '#7A9CCB',
    400: '#4A76B5',
    500: '#0F2C59',
    600: '#0D254D',
    700: '#0A1F42',
    800: '#071836',
    900: '#04102B',
  },
  slate: {
    50:  '#F8FAFC',
    100: '#F1F5F9',
    200: '#E2E8F0',
    300: '#CBD5E1',
    400: '#94A3B8',
    500: '#64748B',
    600: '#475569',
    700: '#334155',
    800: '#1E293B',
    900: '#0F172A',
  },
  emerald: {
    50:  '#ECFDF5',
    100: '#D1FAE5',
    200: '#A7F3D0',
    300: '#6EE7B7',
    400: '#34D399',
    500: '#059669',
    600: '#047857',
    700: '#065F46',
    800: '#064E3B',
    900: '#022C22',
  },
  white: '#FFFFFF',
  background: '#F8FAFC',
  surface: '#FFFFFF',
  outline: '#E2E8F0',
  error: '#DC2626',
  errorLight: '#FEF2F2',
  warning: '#D97706',
  warningLight: '#FFFBEB',
  success: '#059669',
  successLight: '#ECFDF5',
  info: '#2563EB',
  infoLight: '#EFF6FF',
  indigo: {
    50:  '#EEF2FF',
    100: '#E0E7FF',
    200: '#C7D2FE',
    300: '#A5B4FC',
    400: '#818CF8',
    500: '#6366F1',
    600: '#4F46E5',
    700: '#4338CA',
    800: '#3730A3',
    900: '#312E81',
  },
  violet: {
    50:  '#F5F3FF',
    100: '#EDE9FE',
    200: '#DDD6FE',
    300: '#C4B5FD',
    400: '#A78BFA',
    500: '#8B5CF6',
    600: '#7C3AED',
    700: '#6D28D9',
    800: '#5B21B6',
    900: '#4C1D95',
  },
  rose: {
    50:  '#FFF1F2',
    100: '#FFE4E6',
    200: '#FECDD3',
    300: '#FDA4AF',
    400: '#FB7185',
    500: '#F43F5E',
    600: '#E11D48',
    700: '#BE123C',
    800: '#9F1239',
    900: '#881337',
  },
  amber: {
    50:  '#FFFBEB',
    100: '#FEF3C7',
    200: '#FDE68A',
    300: '#FCD34D',
    400: '#FBBF24',
    500: '#F59E0B',
    600: '#D97706',
    700: '#B45309',
    800: '#92400E',
    900: '#78350F',
  },
};

export const shadows = {
  xs:  '0 1px 2px rgba(15,23,42,0.04)',
  sm:  '0 1px 3px rgba(15,23,42,0.06), 0 1px 2px rgba(15,23,42,0.04)',
  md:  '0 4px 6px -1px rgba(15,23,42,0.07), 0 2px 4px -2px rgba(15,23,42,0.05)',
  lg:  '0 10px 15px -3px rgba(15,23,42,0.08), 0 4px 6px -4px rgba(15,23,42,0.04)',
  xl:  '0 20px 25px -5px rgba(15,23,42,0.1), 0 8px 10px -6px rgba(15,23,42,0.06)',
  card: '0 1px 3px rgba(15,23,42,0.04), 0 1px 2px rgba(15,23,42,0.02)',
  elevated: '0 4px 12px -2px rgba(15,23,42,0.1)',
  glow: '0 0 20px rgba(99,102,241,0.15)',
  glowEmerald: '0 0 20px rgba(5,150,105,0.2)',
  glowNavy: '0 0 20px rgba(15,44,89,0.2)',
};

export const radius = {
  xs:   4,
  sm:   6,
  md:   8,
  lg:   12,
  xl:   16,
  '2xl': 20,
  '3xl': 24,
  full: 9999,
};

export const spacing = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  7: 28,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
};

export const typography = {
  fontFamily: FONT_FAMILY,
  sizes: {
    xs:   11,
    label: 12,
    sm:   12.5,
    base: 13.5,
    tableBody: 13,
    tableHeader: 13.5,
    md:   14,
    lg:   16,
    xl:   18,
    '2xl': 20,
    '3xl': 24,
    title: 20,
    titleLg: 24,
  },
  weights: {
    normal: 400,
    medium: 500,
    semibold: 600,
    bold: 700,
    extrabold: 800,
  },
  lineHeights: {
    tight: 1.2,
    normal: 1.45,
    table: 1.4,
    relaxed: 1.6,
  },
};

export const componentTokens = {
  card: {
    background: colors.white,
    border: `1px solid ${colors.outline}`,
    borderRadius: radius.lg,
    padding: spacing[3],
    shadow: shadows.card,
  },
  input: {
    background: colors.white,
    border: `1px solid ${colors.outline}`,
    borderRadius: radius.md,
    padding: '8px 12px',
    fontSize: typography.sizes.base,
    focusBorder: colors.navy[500],
    focusRing: `0 0 0 3px ${colors.navy[100]}`,
  },
  button: {
    primary: {
      background: `linear-gradient(135deg, ${colors.navy[500]} 0%, ${colors.navy[700]} 100%)`,
      color: colors.white,
      border: 'none',
      shadow: `0 2px 8px -1px ${colors.navy[500]}40`,
    },
    secondary: {
      background: colors.white,
      color: colors.navy[700],
      border: `1px solid ${colors.outline}`,
      shadow: shadows.xs,
    },
    success: {
      background: `linear-gradient(135deg, ${colors.emerald[500]} 0%, ${colors.emerald[700]} 100%)`,
      color: colors.white,
      border: 'none',
      shadow: `0 2px 8px -1px ${colors.emerald[500]}40`,
    },
    danger: {
      background: `linear-gradient(135deg, ${colors.error} 0%, #B91C1C 100%)`,
      color: colors.white,
      border: 'none',
      shadow: `0 2px 8px -1px ${colors.error}40`,
    },
  },
  sidebar: {
    background: `linear-gradient(180deg, ${colors.navy[500]}, ${colors.navy[800]})`,
    width: 286,
    collapsedWidth: 64,
    activeIndicator: colors.emerald[500],
    hoverBg: 'rgba(255,255,255,0.05)',
    sectionLabel: 'rgba(255,255,255,0.35)',
    itemDefault: 'rgba(255,255,255,0.55)',
    itemHover: 'rgba(255,255,255,0.85)',
    itemActive: colors.white,
  },
};

export const NAVY = '#0F2C59';
export const EMERALD = '#059669';
export const TEAL_GRADIENT = 'linear-gradient(135deg, #146b60 0%, #0f544c 100%)';
export const INDIGO_GRADIENT = 'linear-gradient(135deg, #4F46E5 0%, #3730A3 100%)';
export const VIOLET_GRADIENT = 'linear-gradient(135deg, #7C3AED 0%, #5B21B6 100%)';
export const ROSE_GRADIENT = 'linear-gradient(135deg, #F43F5E 0%, #E11D48 100%)';
export const AMBER_GRADIENT = 'linear-gradient(135deg, #F59E0B 0%, #D97706 100%)';

export const glassSidebarStyle: React.CSSProperties = {
  background: 'linear-gradient(180deg, rgba(15,44,89,0.95) 0%, rgba(7,24,54,0.98) 100%)',
  backdropFilter: 'blur(20px)',
  WebkitBackdropFilter: 'blur(20px)',
};

export const glassCardStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.8)',
  backdropFilter: 'blur(12px)',
  WebkitBackdropFilter: 'blur(12px)',
  border: '1px solid rgba(255,255,255,0.6)',
};

export const glassMorphismStyle: React.CSSProperties = {
  background: 'rgba(255,255,255,0.6)',
  backdropFilter: 'blur(16px)',
  WebkitBackdropFilter: 'blur(16px)',
  border: '1px solid rgba(255,255,255,0.4)',
};

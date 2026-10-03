import React from 'react';
import { FOCUS_RING, NUMERIC_FONT, UI_FONT, hairline, ink, inkSoft, radius, teal, amber, danger } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'quiet';
export type ButtonSize = 'sm' | 'md' | 'lg';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: ButtonVariant;
    size?: ButtonSize;
    /** Visible leading glyph. Decorative — the accessible name comes from children. */
    icon?: React.ReactNode;
    /** Announced to screen readers in addition to the visible label. */
    srLabel?: string;
    block?: boolean;
};

const SIZES: Record<ButtonSize, React.CSSProperties> = {
    sm: { padding: '6px 12px', fontSize: 12 },
    md: { padding: '9px 16px', fontSize: 13 },
    lg: { padding: '12px 20px', fontSize: 14 },
};

function baseFor(variant: ButtonVariant): React.CSSProperties {
    switch (variant) {
        case 'primary':
            return {
                background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                color: '#fff',
                border: '1.4px solid transparent',
                boxShadow: '0 6px 16px -6px rgba(15,84,76,.55)',
            };
        case 'secondary':
            return { background: '#FEFDFB', color: ink, border: `1.4px solid ${hairline}` };
        case 'quiet':
            return { background: 'transparent', color: inkSoft, border: '1.4px solid transparent' };
        case 'danger':
            return {
                background: 'linear-gradient(155deg, #dc2626, #b91c1c)',
                color: '#fff',
                border: '1.4px solid transparent',
                boxShadow: '0 6px 16px -6px rgba(185,28,28,.55)',
            };
        default:
            return { background: amber[100], color: '#7c4a12', border: `1.4px solid ${amber[300]}` };
    }
}

/**
 * The only sanctioned button in POS. Exists so that an interactive control can
 * never be a <div onClick> again — the div-as-button defect was structural, not
 * incidental, and a primitive removes the possibility.
 */
export const Button: React.FC<ButtonProps> = ({
    variant = 'secondary',
    size = 'md',
    icon,
    srLabel,
    block,
    children,
    style,
    disabled,
    onMouseEnter,
    onMouseLeave,
    ...rest
}) => {
    const enabled = !disabled;
    return (
        <button
            type="button"
            disabled={disabled}
            aria-label={srLabel}
            onMouseEnter={e => {
                if (enabled) onMouseEnter?.(e);
            }}
            onMouseLeave={e => {
                if (enabled) onMouseLeave?.(e);
            }}
            onFocus={e => { e.currentTarget.style.boxShadow = FOCUS_RING; }}
            onBlur={e => {
                e.currentTarget.style.boxShadow = baseFor(variant).boxShadow ?? 'none';
            }}
            style={{
                fontFamily: UI_FONT,
                fontSize: SIZES[size].fontSize,
                fontWeight: 600,
                padding: SIZES[size].padding,
                borderRadius: radius.md,
                cursor: enabled ? 'pointer' : 'not-allowed',
                opacity: enabled ? 1 : 0.45,
                display: block ? 'flex' : 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                width: block ? '100%' : undefined,
                transition: 'all .15s ease',
                ...baseFor(variant),
                ...style,
            }}
            {...rest}
        >
            {icon}
            {children}
        </button>
    );
};

/** Monospaced, right-aligned money cell. Keeps digits in a stable column. */
export const Money: React.FC<{
    value: number;
    symbol: string;
    currencyCode?: string | null;
    /** Digits rendered after the decimal point. */
    decimals?: number;
    size?: number;
    weight?: number;
    color?: string;
    signed?: boolean;
    style?: React.CSSProperties;
}> = ({ value, symbol, currencyCode, size = 13, weight = 700, color = ink, signed, style }) => {
    const v = Number.isFinite(value) ? value : 0;
    const decimals = decimals ?? 2;
    const body = Math.abs(v).toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });
    const prefix = v < 0 ? '−' : signed && v > 0 ? '+' : '';
    return (
        <span
            style={{
                fontFamily: NUMERIC_FONT,
                fontVariantNumeric: 'tabular-nums',
                fontWeight: weight,
                fontSize: size,
                color,
                whiteSpace: 'nowrap',
                ...style,
            }}
        >
            {`${prefix}${symbol}${body}`}
        </span>
    );
};

export default Button;
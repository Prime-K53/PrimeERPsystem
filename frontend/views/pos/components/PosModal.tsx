import React, { useCallback } from 'react';
import { X } from 'lucide-react';
import { useModalA11y } from '../../../utils/useModalA11y';
import { Z_INDEX } from '../../../utils/zIndex';
import {
    ACCENT_BAR,
    CARD_SHADOW,
    OVERLAY_BG,
    UI_FONT,
    hairline,
    ink,
    inkSoft,
    radius,
    teal,
    modalWidth,
} from '../theme';

export type PosModalSize = keyof typeof modalWidth;

type PosModalProps = {
    open: boolean;
    onClose: () => void;
    /** Accessible name. Always supply it — it is the dialog's only name. */
    title: string;
    subtitle?: React.ReactNode;
    /** Decorative glyph rendered in the brand chip. Hidden from the a11y tree. */
    icon?: React.ReactNode;
    size?: PosModalSize;
    /**
     * Escape and the close button are suppressed while this is false. Use for
     * any dialog with an in-flight async submit so the result stays visible.
     */
    dismissible?: boolean;
    /** Clicking the backdrop closes the dialog. Keep false for money entry. */
    closeOnBackdrop?: boolean;
    /** Rendered under the header. Defaults to no padding so panels can bleed. */
    children: React.ReactNode;
    footer?: React.ReactNode;
    /** Set when the footer content is a dismiss/back affordance. */
    footerTone?: 'default' | 'quiet';
};

const headerWrap: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '20px 24px 16px',
    borderBottom: `1px solid ${hairline}`,
    flexShrink: 0,
};

const closeBtn: React.CSSProperties = {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    border: `1px solid ${hairline}`,
    background: 'transparent',
    color: inkSoft,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
};

export const PosModal: React.FC<PosModalProps> = ({
    open,
    onClose,
    title,
    subtitle,
    icon,
    size = 'md',
    dismissible = true,
    closeOnBackdrop = true,
    children,
    footer,
    footerTone = 'default',
}) => {
    const handleClose = useCallback(() => {
        if (dismissible) onClose();
    }, [dismissible, onClose]);

    const a11yRef = useModalA11y(open, handleClose, title, { closeOnEscape: dismissible });

    if (!open) return null;

    const titleId = `pos-modal-title-${title.replace(/\W+/g, '-').toLowerCase()}`;

    return (
        <div
            ref={a11yRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onClick={e => {
                if (closeOnBackdrop && e.target === e.currentTarget) handleClose();
            }}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: Z_INDEX.POS_MODAL,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: OVERLAY_BG,
                // Fluid gutters: 16px on phones, 40px on desktop.
                padding: 'max(16px, 4vh) 16px',
                fontFamily: UI_FONT,
                fontSize: 13.5,
                color: ink,
                outline: 'none',
            }}
        >
            <div
                style={{
                    width: '100%',
                    maxWidth: modalWidth[size],
                    // Cap by viewport height so tall dialogs never overflow.
                    maxHeight: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#FEFDFB',
                    borderRadius: radius.xl,
                    boxShadow: CARD_SHADOW,
                    overflow: 'hidden',
                    position: 'relative',
                }}
            >
                <div
                    aria-hidden="true"
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 4, background: ACCENT_BAR }}
                />

                <div style={headerWrap}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
                        {icon ? (
                            <div
                                aria-hidden="true"
                                style={{
                                    width: 40,
                                    height: 40,
                                    borderRadius: radius.lg,
                                    background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    boxShadow: `0 4px 10px -3px ${teal[600]}99`,
                                    flexShrink: 0,
                                }}
                            >
                                {icon}
                            </div>
                        ) : null}
                        <div style={{ minWidth: 0 }}>
                            <h1
                                id={titleId}
                                style={{
                                    fontFamily: UI_FONT,
                                    fontWeight: 400,
                                    fontSize: 20,
                                    margin: 0,
                                    color: teal[800],
                                    letterSpacing: 0.2,
                                    lineHeight: 1.2,
                                }}
                            >
                                {title}
                            </h1>
                            {subtitle ? (
                                <p
                                    style={{
                                        margin: '3px 0 0',
                                        fontSize: 12,
                                        color: inkSoft,
                                        letterSpacing: 0.02,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}
                                >
                                    {subtitle}
                                </p>
                            ) : null}
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={!dismissible}
                        aria-label={dismissible ? `Close ${title}` : undefined}
                        style={{
                            ...closeBtn,
                            cursor: dismissible ? 'pointer' : 'not-allowed',
                            opacity: dismissible ? 1 : 0.4,
                        }}
                        onMouseEnter={e => {
                            if (!dismissible) return;
                            e.currentTarget.style.background = teal[50];
                            e.currentTarget.style.color = teal[700];
                            e.currentTarget.style.borderColor = teal[200];
                        }}
                        onMouseLeave={e => {
                            e.currentTarget.style.background = 'transparent';
                            e.currentTarget.style.color = inkSoft;
                            e.currentTarget.style.borderColor = hairline;
                        }}
                        onFocus={e => { e.currentTarget.style.boxShadow = `0 0 0 2px #FEFDFB, 0 0 0 4px ${teal[500]}`; }}
                        onBlur={e => { e.currentTarget.style.boxShadow = 'none'; }}
                    >
                        <X size={15} />
                    </button>
                </div>

                {children}

                {footer ? (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: footerTone === 'quiet' ? 'flex-start' : 'flex-end',
                            gap: 10,
                            padding: '14px 24px 16px',
                            borderTop: `1px solid ${hairline}`,
                            background: footerTone === 'quiet' ? 'transparent' : teal[50],
                            flexShrink: 0,
                            flexWrap: 'wrap',
                        }}
                    >
                        {footer}
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export default PosModal;
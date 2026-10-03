import { useEffect, useRef } from 'react';

type UseModalA11yOptions = {
    /**
     * Whether Escape dismisses the dialog. Set false while an async submit is
     * in flight: closing mid-flight hides the surface that must display the
     * result (and the error) of that submit.
     */
    closeOnEscape?: boolean;
    /** Label used for the accessible name when no aria-label is supplied. */
    label?: string;
};

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog accessibility: labelled role, focus trap, focus restoration and a
 * guarded Escape handler. Applied by <PosModal>; call directly only when a
 * bespoke overlay genuinely cannot use the primitive.
 */
export function useModalA11y(
    isOpen: boolean,
    onClose: () => void,
    label?: string,
    options?: UseModalA11yOptions
) {
    const containerRef = useRef<HTMLDivElement>(null);
    const previousActiveEl = useRef<HTMLElement | null>(null);
    const onCloseRef = useRef(onClose);
    const closeOnEscape = options?.closeOnEscape !== false;

    // Keep the latest handler without re-running the effect (which would
    // otherwise steal focus again on every render of an unstable callback).
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;

        const container = containerRef.current;
        if (!container) return;

        const previouslyFocused = document.activeElement as HTMLElement | null;

        const focusables = () =>
            Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
                el => el.offsetParent !== null || el === document.activeElement
            );

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                if (!closeOnEscape) return;
                e.preventDefault();
                e.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (e.key !== 'Tab') return;

            const items = focusables();
            if (items.length === 0) {
                e.preventDefault();
                return;
            }
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;

            if (e.shiftKey && (active === first || !container.contains(active))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && active === last) {
                e.preventDefault();
                first.focus();
            }
        };

        // Capture phase so the dialog wins over any window-level handler that
        // a host screen may have registered (e.g. the POS global shortcuts).
        document.addEventListener('keydown', handleKeyDown, true);
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';

        const raf = window.setTimeout(() => {
            const items = focusables();
            (items[0] ?? container).focus();
        }, 50);

        return () => {
            document.removeEventListener('keydown', handleKeyDown, true);
            document.body.style.overflow = previousOverflow;
            window.clearTimeout(raf);
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
                previouslyFocused.focus();
            }
        };
    }, [isOpen, closeOnEscape, label]);

    return containerRef;
}
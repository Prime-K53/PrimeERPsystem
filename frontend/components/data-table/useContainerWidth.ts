import { useEffect, useRef, useState } from 'react';

/**
 * Container-aware width via ResizeObserver. Prefer CSS container queries
 * (`responsive-table.css`) for layout; use this hook only when JS needs the
 * width (e.g. choosing bottom-sheet vs drawer, virtualised rows).
 */
export function useContainerWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width ?? 0;
      setWidth(w);
    });
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  return { ref, width, isNarrow: width > 0 && width < 640 };
}

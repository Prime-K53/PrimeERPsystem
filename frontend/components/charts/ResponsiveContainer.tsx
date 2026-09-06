/**
 * ResponsiveContainer.tsx — app-level chart container.
 *
 * WHY THIS EXISTS
 * ----------------
 * Recharts v3's <ResponsiveContainer width="100%" height="100%"> starts with an
 * internal size of {-1, -1} and only measures its parent asynchronously after
 * the first commit. While unmeasured it emits:
 *
 *   The width(-1) and height(-1) of chart should be greater than 0 ...
 *
 * on every mount (and repeatedly while the container reports 0x0, e.g. charts
 * inside a tab/modal that is hidden at mount time). We do not patch Recharts
 * internals and we do not filter console warnings globally; instead this
 * component owns the measurement step:
 *
 *   1. It renders the layout div (width/height/minWidth/minHeight exactly as
 *      Recharts would have).
 *   2. It measures that div with a ResizeObserver and mounts the Recharts
 *      <ResponsiveContainer> ONLY once a real, positive width+height exists,
 *      passing the measured size as `initialDimension` (so Recharts never
 *      starts from -1 and never warns).
 *   3. When the container is later shown/resized (tab switch, modal open,
 *      window resize) the observer fires and the mounted container follows —
 *      no invalid dimensions during any of those states.
 *
 * The component keeps the exact name/props of the Recharts export so a chart
 * file can swap its `import { ResponsiveContainer } from 'recharts'` line for
 * this module without touching the JSX.
 */
import React, { memo, useEffect, useRef, useState } from 'react';
import { ResponsiveContainer as RechartsResponsiveContainer } from 'recharts';

export interface ResponsiveContainerProps {
  children: React.ReactNode;
  width?: string | number;
  height?: string | number;
  minWidth?: number;
  minHeight?: number;
  aspect?: number;
  maxHeight?: number;
  debounce?: number;
  className?: string;
  style?: React.CSSProperties;
  id?: string;
  onResize?: (width: number, height: number) => void;
}

interface MeasuredSize {
  width: number;
  height: number;
}

function joinClass(...parts: Array<string | undefined | null>): string {
  return parts.filter(Boolean).join(' ');
}

export const ResponsiveContainer: React.FC<ResponsiveContainerProps> = memo(function ResponsiveContainer({
  children,
  width = '100%',
  height = '100%',
  minWidth,
  minHeight,
  aspect,
  debounce,
  className,
  style,
  id,
  onResize,
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<MeasuredSize | null>(null);
  const onResizeRef = useRef(onResize);
  onResizeRef.current = onResize;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const measure = () => {
      if (disposed || !hostRef.current) return;
      const rect = hostRef.current.getBoundingClientRect();
      const next = {
        width: Math.floor(rect.width),
        height: Math.floor(rect.height),
      };
      if (next.width <= 0 || next.height <= 0) {
        // Hidden (display:none inside a tab/modal) or not laid out yet — do not
        // mount the chart with invalid dimensions. The observer fires again
        // once the container becomes measurable.
        setMeasured(null);
        return;
      }
      setMeasured((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next));
      onResizeRef.current?.(next.width, next.height);
    };

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(host);
      measure();
      return () => {
        disposed = true;
        observer.disconnect();
      };
    }

    // No ResizeObserver (rare / non-browser) — measure once and on window resize.
    measure();
    window.addEventListener('resize', measure);
    return () => {
      disposed = true;
      window.removeEventListener('resize', measure);
    };
  }, []);

  const hostStyle: React.CSSProperties = {
    width,
    height,
    ...(minWidth != null ? { minWidth } : {}),
    ...(minHeight != null ? { minHeight } : {}),
    ...style,
  };

  return (
    <div
      ref={hostRef}
      id={id}
      className={joinClass('recharts-responsive-container', className)}
      style={hostStyle}
    >
      {measured ? (
        <RechartsResponsiveContainer
          width="100%"
          height="100%"
          minWidth={minWidth}
          minHeight={minHeight}
          aspect={aspect}
          debounce={debounce}
          initialDimension={measured}
          className={className}
          style={style}
        >
          {children}
        </RechartsResponsiveContainer>
      ) : null}
    </div>
  );
});

ResponsiveContainer.displayName = 'ResponsiveContainer';

export default ResponsiveContainer;

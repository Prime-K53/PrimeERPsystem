import React, { useEffect, useRef } from 'react';

let pdfjsLib: any = null;
let pdfjsPromise: Promise<any> | null = null;

async function ensurePdfjs(): Promise<any> {
  if (pdfjsLib) return pdfjsLib;
  if (pdfjsPromise) return pdfjsPromise;

  pdfjsPromise = (async () => {
    const lib = await import('pdfjs-dist');
    const workerUrl = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).href;
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    pdfjsLib = lib;
    return lib;
  })();
  return pdfjsPromise;
}

export interface PageCanvasProps {
  pdf: any;
  pageNumber: number;
  scale: number;
  maxDpr?: number;
  className?: string;
}

export const PageCanvas: React.FC<PageCanvasProps> = ({
  pdf,
  pageNumber,
  scale,
  maxDpr = 2,
  className,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<any>(null);
  const scaleKey = Math.round(scale * 1000);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;

    let cancelled = false;
    const canvas = canvasRef.current;

    const render = async () => {
      try {
        if (renderTaskRef.current) {
          try { renderTaskRef.current.cancel(); } catch { /* noop */ }
          renderTaskRef.current = null;
        }

        const page = await pdf.getPage(pageNumber);
        if (cancelled) return;

        const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
        const viewport = page.getViewport({ scale: scale * dpr });

        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        const cssWidth = viewport.width / dpr;
        const cssHeight = viewport.height / dpr;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const task = page.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;

        try {
          await task.promise;
        } catch (err: any) {
          if (err?.name !== 'RenderingCancelledException') {
            throw err;
          }
        }
      } catch (err) {
        if (cancelled) return;
        if ((err as any)?.name === 'RenderingCancelledException') return;
        console.error('PageCanvas render error:', err);
      } finally {
        renderTaskRef.current = null;
      }
    };

    render();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* noop */ }
        renderTaskRef.current = null;
      }
    };
  }, [pdf, pageNumber, scaleKey, maxDpr]);

  return (
    <canvas
      key={`${pageNumber}-${scaleKey}`}
      ref={canvasRef}
      className={className}
      style={{ display: 'block', background: '#fff' }}
    />
  );
};

export const loadPdfjs = ensurePdfjs;

export default PageCanvas;

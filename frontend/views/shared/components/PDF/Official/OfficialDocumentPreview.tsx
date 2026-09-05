import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Download,
  Printer,
  X,
  Loader2,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { PageCanvas, loadPdfjs } from './PageCanvas';
import { preparePdfBytes, getPdfErrorMessage } from '../pdfPreviewUtils';
import { useOfficialDocument } from '../../../../../hooks/officialDocument/useOfficialDocument';

const MIN_ZOOM = 0.4;
const MAX_ZOOM_FIT = 3;
const MAX_ZOOM_FREE = 4;
const SWIPE_THRESHOLD = 50;
const ZOOM_STEP = 0.15;
const PAGE_WIDTH_PT = 794;

export type FitMode = 'width' | 'custom';

export interface OfficialDocumentPreviewProps {
  source: Blob | Uint8Array | ArrayBuffer | null;
  title?: string;
  onClose?: () => void;
  className?: string;
  showToolbar?: boolean;
  showHeader?: boolean;
  onDownload?: (blob: Blob, filename: string) => void | Promise<void>;
}

export const OfficialDocumentPreview: React.FC<OfficialDocumentPreviewProps> = ({
  source,
  title = 'Document Preview',
  onClose,
  className,
  showToolbar = true,
  showHeader = true,
  onDownload,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { state, blob, blobUrl, error, load, download: hookDownload, print } = useOfficialDocument();

  const [pdf, setPdf] = useState<any>(null);
  const [pageCount, setPageCount] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [fitMode, setFitMode] = useState<FitMode>('width');
  const [scale, setScale] = useState(1);
  const [containerWidth, setContainerWidth] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pdfReady, setPdfReady] = useState(false);

  const touchStartX = useRef<number | null>(null);
  const touchPinchDist = useRef<number | null>(null);
  const pageWidthAtUnitScale = useRef<number>(PAGE_WIDTH_PT);

  useEffect(() => {
    if (!source) {
      setPdf(null);
      setPageCount(0);
      setCurrentPage(1);
      setPdfReady(false);
      setLoadError(null);
      return;
    }
    setLoadError(null);
    setPdfReady(false);
    load(source);
  }, [source, load]);

  useEffect(() => {
    if (state !== 'ready' || !blob) {
      setPdf(null);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const bytes = await preparePdfBytes(blob, title);
        const lib = await loadPdfjs();
        if (cancelled) return;

        const copy = new Uint8Array(bytes);
        const task = lib.getDocument({ data: copy });
        const doc = await task.promise;
        if (cancelled) {
          doc.destroy();
          return;
        }
        setPdf(doc);
        setPageCount(doc.numPages);
        setCurrentPage(1);

        const first = await doc.getPage(1);
        if (!cancelled) {
          const vp = first.getViewport({ scale: 1 });
          pageWidthAtUnitScale.current = vp.width;
        }
        setPdfReady(true);
      } catch (err: any) {
        if (cancelled) return;
        if (err?.name === 'RenderingCancelledException') return;
        setLoadError(getPdfErrorMessage(err));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [state, blob, title]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (fitMode !== 'width' || !pageWidthAtUnitScale.current || containerWidth === 0) return;
    const padding = 32;
    const next = Math.max(
      MIN_ZOOM,
      Math.min(MAX_ZOOM_FIT, (containerWidth - padding) / pageWidthAtUnitScale.current)
    );
    setScale(next);
  }, [fitMode, containerWidth]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setScale((s) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM_FREE, s + delta)));
      setFitMode('custom');
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        touchPinchDist.current = dist;
        touchStartX.current = null;
        return;
      }
      if (e.touches.length === 1) {
        touchStartX.current = e.touches[0].clientX;
      }
    },
    []
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 2 && touchPinchDist.current != null) {
        const dist = Math.hypot(
          e.touches[0].clientX - e.touches[1].clientX,
          e.touches[0].clientY - e.touches[1].clientY
        );
        const delta = (dist - touchPinchDist.current) * 0.012;
        touchPinchDist.current = dist;
        if (Math.abs(delta) > 0.0001) {
          setScale((s) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM_FREE, s + delta)));
          setFitMode('custom');
        }
        return;
      }
    },
    []
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchPinchDist.current != null) {
        touchPinchDist.current = null;
        return;
      }
      if (touchStartX.current != null && e.changedTouches.length === 1) {
        const dx = e.changedTouches[0].clientX - touchStartX.current;
        if (Math.abs(dx) >= SWIPE_THRESHOLD && fitMode === 'width' && pageCount > 1) {
          if (dx < 0) {
            setCurrentPage((p) => Math.min(pageCount, p + 1));
          } else {
            setCurrentPage((p) => Math.max(1, p - 1));
          }
        }
        touchStartX.current = null;
      }
    },
    [fitMode, pageCount]
  );

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(MAX_ZOOM_FREE, parseFloat((s + ZOOM_STEP).toFixed(2))));
    setFitMode('custom');
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(MIN_ZOOM, parseFloat((s - ZOOM_STEP).toFixed(2))));
    setFitMode('custom');
  }, []);

  const handleFitWidth = useCallback(() => {
    setFitMode('width');
  }, []);

  const handleDownload = useCallback(async () => {
    if (!blob) return;
    if (onDownload) {
      await onDownload(blob, `${title}.pdf`);
      return;
    }
    await hookDownload(`${title}.pdf`);
  }, [blob, onDownload, hookDownload, title]);

  const handlePrint = useCallback(() => {
    if (!blobUrl) return;
    print();
  }, [blobUrl, print]);

  const maxZoom = fitMode === 'width' ? MAX_ZOOM_FIT : MAX_ZOOM_FREE;
  const zoomPercent = Math.round(scale * 100);
  const errorMessage = loadError || error;

  return (
    <div
      className={`flex flex-col bg-slate-900 text-slate-200 ${className ?? ''}`}
      style={{ minHeight: 0, height: '100%' }}
    >
      {showHeader && (
        <header
          className="flex shrink-0 items-center justify-between px-4 py-2.5 border-b"
          style={{
            background: 'rgba(15,23,42,0.85)',
            borderColor: 'rgba(255,255,255,0.08)',
            backdropFilter: 'blur(20px)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <div
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
              style={{ background: 'linear-gradient(135deg,#6366f1,#8b5cf6)' }}
            >
              <FileText className="h-3.5 w-3.5 text-white" />
            </div>
            <h2 className="truncate text-sm font-bold">{title}</h2>
            {pageCount > 0 && (
              <span className="text-[11px] font-semibold text-slate-500 tabular-nums">
                {currentPage}/{pageCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            {blob && (
              <>
                <button
                  onClick={handleDownload}
                  className="rounded-lg p-1.5 hover:bg-white/10 transition-colors"
                  title="Download"
                  aria-label="Download"
                >
                  <Download className="h-4 w-4" />
                </button>
                <button
                  onClick={handlePrint}
                  className="rounded-lg p-1.5 hover:bg-white/10 transition-colors"
                  title="Print"
                  aria-label="Print"
                >
                  <Printer className="h-4 w-4" />
                </button>
              </>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="rounded-lg p-1.5 hover:bg-white/10 transition-colors"
                title="Close"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </header>
      )}

      <div
        ref={(el) => {
          containerRef.current = el;
          scrollRef.current = el;
        }}
        className="relative flex flex-1 min-h-0 items-start justify-center overflow-auto"
        style={{ touchAction: 'pan-x pan-y pinch-zoom' }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {!source ? (
          <div className="flex h-full w-full items-center justify-center p-8">
            <div className="text-center">
              <FileText className="mx-auto h-12 w-12 opacity-30" />
              <p className="mt-3 text-sm font-medium text-slate-500">No document to preview</p>
            </div>
          </div>
        ) : errorMessage ? (
          <div className="flex h-full w-full items-center justify-center p-8">
            <div className="w-full max-w-md rounded-2xl border border-rose-200 bg-rose-50/10 p-6 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100/20 text-rose-400">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <p className="text-sm font-semibold text-rose-200">Preview failed</p>
              <p className="mt-1 text-xs text-slate-400">{errorMessage}</p>
            </div>
          </div>
        ) : !pdfReady || !pdf ? (
          <div className="flex h-full w-full items-center justify-center p-8">
            <div className="text-center">
              <Loader2 className="mx-auto h-7 w-7 animate-spin text-indigo-400" />
              <p className="mt-3 text-xs font-medium text-slate-500">Rendering document…</p>
            </div>
          </div>
        ) : (
          <div
            className="flex flex-col items-center"
            style={{ padding: '16px 12px 24px', gap: 16 }}
          >
            {Array.from({ length: pageCount }, (_, i) => i + 1).map((page) => (
              <PageCanvas
                key={`page-${page}`}
                pdf={pdf}
                pageNumber={page}
                scale={scale}
                className="rounded-md shadow-2xl"
              />
            ))}
          </div>
        )}
      </div>

      {showToolbar && pdfReady && (
        <footer
          className="flex shrink-0 items-center justify-between gap-2 px-3 py-2 border-t"
          style={{
            background: 'rgba(15,23,42,0.85)',
            borderColor: 'rgba(255,255,255,0.07)',
            backdropFilter: 'blur(16px)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <button
              onClick={handleZoomOut}
              disabled={scale <= MIN_ZOOM}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Zoom out"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-[3rem] text-center text-[11px] font-semibold tabular-nums text-slate-300">
              {zoomPercent}%
            </span>
            <button
              onClick={handleZoomIn}
              disabled={scale >= maxZoom}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
              title="Zoom in"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
            <div className="mx-1 h-4 w-px bg-white/10" />
            <button
              onClick={handleFitWidth}
              className="rounded-lg px-2 py-1 text-[10px] font-semibold transition-colors"
              style={{
                background: fitMode === 'width' ? 'rgba(99,102,241,0.25)' : 'rgba(255,255,255,0.06)',
                color: fitMode === 'width' ? '#a5b4fc' : '#94a3b8',
              }}
              title="Fit width"
            >
              <Maximize2 className="inline h-3 w-3 mr-1" />
              Fit
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {pageCount > 1 && (
              <>
                <button
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                  title="Previous page"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-[11px] font-semibold tabular-nums text-slate-300 min-w-[3rem] text-center">
                  {currentPage} / {pageCount}
                </span>
                <button
                  onClick={() => setCurrentPage((p) => Math.min(pageCount, p + 1))}
                  disabled={currentPage >= pageCount}
                  className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                  title="Next page"
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </footer>
      )}
    </div>
  );
};

export default OfficialDocumentPreview;

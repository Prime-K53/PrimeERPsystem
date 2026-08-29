import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Crop, Check, Loader2, RotateCcw, X, ZoomIn, ZoomOut, ShieldCheck } from 'lucide-react';
import {
  BANNER_SPEC,
  aspectConformance,
  canvasToWebPBlob,
  clampPan,
  coverTransform,
  cropRectFromTransform,
  renderBannerCanvas,
} from '../../services/bannerImage';

interface BannerCropModalProps {
  image: HTMLImageElement;
  /** Still-live blob URL for displaying the image. Revoked by the parent after the modal closes. */
  blobUrl: string;
  sourceName: string;
  onCancel: () => void;
  onConfirm: (blob: Blob, output: { width: number; height: number }) => void;
}

const teal = {
  100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7', 400: '#3fa294',
  500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a',
};
const amber = { 300: '#eec27a', 500: '#d99a3f' };
const paper = '#FEFDFB', ink = '#23282A', inkSoft = '#5c6567', hairline = '#e4ddd1';

const SAFE_AREA_W = 0.9;
const SAFE_AREA_H = 0.8;

/**
 * Interactive 3:1 crop tool for customer portal banners.
 *
 * A fixed 3:1 crop window sits over the image; the user drags the image to
 * position it and zooms with the slider / mouse-wheel. A safe-area guide
 * protects logos and text. The confirmed crop is rendered to an exact
 * 1500 × 500 WebP and returned to the caller for upload.
 */
export const BannerCropModal: React.FC<BannerCropModalProps> = ({
  image, blobUrl, sourceName, onCancel, onConfirm,
}) => {
  const srcW = image.naturalWidth;
  const srcH = image.naturalHeight;
  const conformant = aspectConformance(srcW, srcH);

  const stageRef = useRef<HTMLDivElement>(null);
  // Measured pixel size of the stage div.
  const [win, setWin] = useState({ w: 0, h: 0 });
  const [transform, setTransform] = useState({ scale: 1, panX: 0, panY: 0 });
  const [busy, setBusy] = useState(false);
  // Snapshot of pan at the start of a drag; null when not dragging.
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);

  // ── Crop window size ──────────────────────────────────────────────────────
  // A 3:1 rectangle that fits inside the stage with 20 px padding each side.
  const windowSize = useMemo(() => {
    if (win.w <= 0 || win.h <= 0) return { w: 0, h: 0 };
    let w = win.w - 40;
    let h = w / BANNER_SPEC.targetRatio;
    if (h > win.h - 40) {
      h = win.h - 40;
      w = h * BANNER_SPEC.targetRatio;
    }
    return { w: Math.round(w), h: Math.round(h) };
  }, [win]);

  const minScale = useMemo(
    () => (windowSize.w > 0 && srcW > 0
      ? Math.max(windowSize.w / srcW, windowSize.h / srcH)
      : 1),
    [windowSize, srcW, srcH],
  );
  const maxScale = useMemo(() => minScale * 4, [minScale]);

  const resetTransform = useCallback(() => {
    setTransform(coverTransform(srcW, srcH, windowSize.w, windowSize.h));
  }, [srcW, srcH, windowSize]);

  // ── Measure the stage via ResizeObserver ──────────────────────────────────
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const rw = Math.round(r.width);
      const rh = Math.round(r.height);
      setWin(prev => (prev.w === rw && prev.h === rh ? prev : { w: rw, h: rh }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);

  // Re-fit whenever the crop window dimensions change.
  useEffect(() => {
    if (windowSize.w > 0 && windowSize.h > 0) resetTransform();
  }, [windowSize, resetTransform]);

  // Escape key closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  // clampPan is called directly inside the state updater so the closure
  // always captures the current windowSize / srcW / srcH — no stale refs.
  const setZoom = useCallback((next: number) => {
    setTransform(t => {
      const scale = Math.max(minScale, Math.min(maxScale, next));
      return {
        ...clampPan(t.panX, t.panY, scale, srcW, srcH, windowSize.w, windowSize.h),
        scale,
      };
    });
  }, [minScale, maxScale, srcW, srcH, windowSize]);

  // ── Pointer drag ─────────────────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, y: e.clientY, panX: transform.panX, panY: transform.panY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setTransform(t => ({
      ...clampPan(d.panX + dx, d.panY + dy, t.scale, srcW, srcH, windowSize.w, windowSize.h),
      scale: t.scale,
    }));
  };

  const onPointerUp = () => { drag.current = null; };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setTransform(t => {
      const scale = Math.max(minScale, Math.min(maxScale, t.scale * factor));
      return { ...clampPan(t.panX, t.panY, scale, srcW, srcH, windowSize.w, windowSize.h), scale };
    });
  };

  // ── Derived geometry ──────────────────────────────────────────────────────
  const sliderValue = maxScale > minScale
    ? ((transform.scale - minScale) / (maxScale - minScale)) * 100
    : 0;

  const imgDisplayW = srcW * transform.scale;
  const imgDisplayH = srcH * transform.scale;
  // Crop window is centred in the stage.
  const winLeft = (win.w - windowSize.w) / 2;
  const winTop  = (win.h - windowSize.h) / 2;
  // Image top-left: stage-centre minus half image size plus pan.
  const imgLeft = win.w / 2 - imgDisplayW / 2 + transform.panX;
  const imgTop  = win.h / 2 - imgDisplayH / 2 + transform.panY;

  // Scale factor for the 280 px wide live mini-preview.
  const previewK = windowSize.w > 0 ? 280 / windowSize.w : 1;

  const safeArea = {
    w: Math.round(windowSize.w * SAFE_AREA_W),
    h: Math.round(windowSize.h * SAFE_AREA_H),
    x: Math.round((windowSize.w * (1 - SAFE_AREA_W)) / 2),
    y: Math.round((windowSize.h * (1 - SAFE_AREA_H)) / 2),
  };

  // ── Confirm ───────────────────────────────────────────────────────────────
  const handleConfirm = async () => {
    setBusy(true);
    try {
      const rect = cropRectFromTransform(transform, srcW, srcH, windowSize.w, windowSize.h);
      const canvas = renderBannerCanvas(image, rect);
      const blob = await canvasToWebPBlob(canvas);
      onConfirm(blob, { width: canvas.width, height: canvas.height });
    } finally {
      setBusy(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div
      className="banner-crop-overlay"
      style={{
        position: 'fixed', inset: 0, zIndex: 10001,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(6, 10, 20, 0.82)',
        padding: '24px 16px',
        fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
      }}
    >
      {/*
       * Give the modal a fixed height (not just maxHeight) so that
       * flex: 1 on the stage div results in a real pixel height that
       * ResizeObserver can measure.
       */}
      <div
        style={{
          width: 960, maxWidth: '100%',
          height: 'min(90vh, 720px)',
          background: paper, borderRadius: 16,
          boxShadow: '0 40px 90px -20px rgba(0,0,0,.75)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '14px 20px 12px', borderBottom: `1px solid ${hairline}`,
          flexShrink: 0,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: 10, flexShrink: 0,
            background: `linear-gradient(155deg, ${teal[500]}, ${teal[700]})`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Crop size={17} color="#fff" />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: teal[800], lineHeight: 1.3 }}>
              Crop to 3:1 banner
            </h3>
            <p style={{
              margin: '2px 0 0', fontSize: 11, color: inkSoft,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>
              {sourceName} &middot; {srcW}&thinsp;×&thinsp;{srcH} px &middot; ratio{' '}
              {(srcW / srcH).toFixed(2)}:1
              {conformant ? ' — already 3:1' : ' — needs a 3:1 crop'}
            </p>
          </div>
          <button
            type="button" onClick={onCancel} aria-label="Close crop tool"
            style={{
              width: 30, height: 30, borderRadius: 8, border: `1px solid ${hairline}`,
              background: paper, color: inkSoft, flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Instruction */}
        <div style={{ padding: '8px 20px 0', flexShrink: 0 }}>
          <p style={{ margin: 0, fontSize: 11.5, color: inkSoft, display: 'flex', alignItems: 'flex-start', gap: 7, lineHeight: 1.5 }}>
            <ShieldCheck size={13} color={teal[600]} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              <b style={{ color: ink }}>Drag</b> to reposition &middot;&nbsp;
              <b style={{ color: ink }}>Scroll</b> or use the slider to zoom &middot;&nbsp;
              Keep content inside the <b style={{ color: amber[500] }}>dashed safe area</b>
            </span>
          </p>
        </div>

        {/* ── Stage ── */}
        <div
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onWheel={onWheel}
          style={{
            position: 'relative',
            flex: 1,           // fills the remaining vertical space → gives ResizeObserver a real height
            margin: '10px 20px',
            borderRadius: 10,
            overflow: 'hidden',
            cursor: drag.current ? 'grabbing' : 'grab',
            touchAction: 'none',
            background: '#080d1a',
            userSelect: 'none',
          }}
        >
          {win.w > 0 && windowSize.w > 0 && (
            <>
              {/* The image, positioned by the current transform */}
              <img
                src={blobUrl}
                alt=""
                draggable={false}
                style={{
                  position: 'absolute',
                  left: imgLeft, top: imgTop,
                  width: imgDisplayW, height: imgDisplayH,
                  maxWidth: 'none',
                  userSelect: 'none', pointerEvents: 'none',
                }}
              />

              {/* Scrim — four strips framing the crop window */}
              <div style={{ position: 'absolute', inset: 0, top: 0, height: winTop, background: 'rgba(4,8,20,.74)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: 0, right: 0, top: winTop + windowSize.h, bottom: 0, background: 'rgba(4,8,20,.74)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', left: 0, top: winTop, width: Math.max(0, winLeft), height: windowSize.h, background: 'rgba(4,8,20,.74)', pointerEvents: 'none' }} />
              <div style={{ position: 'absolute', right: 0, top: winTop, width: Math.max(0, win.w - winLeft - windowSize.w), height: windowSize.h, background: 'rgba(4,8,20,.74)', pointerEvents: 'none' }} />

              {/* Crop window frame */}
              <div style={{
                position: 'absolute',
                left: winLeft, top: winTop,
                width: windowSize.w, height: windowSize.h,
                border: '2px solid rgba(255,255,255,.9)',
                boxShadow: '0 0 0 1px rgba(0,0,0,.6)',
                pointerEvents: 'none',
              }}>
                {/* Rule-of-thirds guides */}
                {[1, 2].map(i => (
                  <React.Fragment key={i}>
                    <div style={{ position: 'absolute', left: `${(i / 3) * 100}%`, top: 0, bottom: 0, width: 1, background: 'rgba(255,255,255,.15)' }} />
                    <div style={{ position: 'absolute', top: `${(i / 3) * 100}%`, left: 0, right: 0, height: 1, background: 'rgba(255,255,255,.15)' }} />
                  </React.Fragment>
                ))}

                {/* Safe-area dashed guide */}
                <div style={{
                  position: 'absolute',
                  left: safeArea.x, top: safeArea.y,
                  width: safeArea.w, height: safeArea.h,
                  border: `1.5px dashed ${amber[300]}`,
                }}>
                  <span style={{
                    position: 'absolute', top: -19, left: '50%', transform: 'translateX(-50%)',
                    fontSize: 9, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase',
                    color: amber[300], background: 'rgba(6,10,20,.82)',
                    padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
                  }}>
                    Safe area — keep content inside
                  </span>
                  <span style={{
                    position: 'absolute', right: -7, bottom: -7,
                    width: 12, height: 12, borderRadius: '50%',
                    background: amber[500], border: '2px solid #fff',
                    boxShadow: '0 2px 6px rgba(0,0,0,.5)',
                  }} />
                </div>
              </div>

              {/* Corner handles */}
              {([
                { left: winLeft - 1,               top: winTop - 1,                borderTop: '3px solid #fff', borderLeft: '3px solid #fff' },
                { left: winLeft + windowSize.w - 15, top: winTop - 1,              borderTop: '3px solid #fff', borderRight: '3px solid #fff' },
                { left: winLeft - 1,               top: winTop + windowSize.h - 15, borderBottom: '3px solid #fff', borderLeft: '3px solid #fff' },
                { left: winLeft + windowSize.w - 15, top: winTop + windowSize.h - 15, borderBottom: '3px solid #fff', borderRight: '3px solid #fff' },
              ] as React.CSSProperties[]).map((s, i) => (
                <div key={i} style={{ position: 'absolute', width: 16, height: 16, pointerEvents: 'none', ...s }} />
              ))}
            </>
          )}
        </div>

        {/* ── Zoom controls ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '2px 20px 10px', flexShrink: 0, flexWrap: 'wrap',
        }}>
          <button type="button" onClick={() => setZoom(transform.scale / 1.12)} aria-label="Zoom out" style={controlBtnStyle}>
            <ZoomOut size={14} />
          </button>
          <input
            type="range" min={0} max={100} step={0.1}
            value={sliderValue}
            onChange={e => setZoom(minScale + (Number(e.target.value) / 100) * (maxScale - minScale))}
            aria-label="Zoom level"
            style={{ flex: '1 1 120px', accentColor: teal[600], cursor: 'pointer' }}
          />
          <button type="button" onClick={() => setZoom(transform.scale * 1.12)} aria-label="Zoom in" style={controlBtnStyle}>
            <ZoomIn size={14} />
          </button>
          <button
            type="button" onClick={resetTransform}
            style={{ ...controlBtnStyle, width: 'auto', padding: '0 10px', gap: 5, fontSize: 11.5, display: 'flex' }}
          >
            <RotateCcw size={12} /> Reset
          </button>
          <span style={{ fontSize: 10.5, color: inkSoft, fontFamily: "'JetBrains Mono', monospace", minWidth: 42, textAlign: 'right' }}>
            {Math.round(transform.scale * 100)}%
          </span>
        </div>

        {/* ── Footer: mini preview + actions ── */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 18,
          padding: '12px 20px 16px', borderTop: `1px solid ${hairline}`,
          background: '#f9f8f5', flexWrap: 'wrap', flexShrink: 0,
        }}>
          {/* 3:1 live preview thumbnail */}
          <div style={{ flexShrink: 0 }}>
            <div style={{
              fontSize: 9, fontWeight: 800, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: teal[700], marginBottom: 5,
            }}>
              Live crop preview
            </div>
            <div style={{
              width: 280,
              aspectRatio: '3 / 1',
              borderRadius: 6, overflow: 'hidden',
              position: 'relative', background: '#080d1a',
              boxShadow: '0 4px 14px -4px rgba(0,0,0,.4)',
            }}>
              {win.w > 0 && windowSize.w > 0 && (
                <img
                  src={blobUrl}
                  alt="Crop preview"
                  draggable={false}
                  style={{
                    position: 'absolute',
                    left: imgLeft * previewK,
                    top: imgTop * previewK,
                    width: imgDisplayW * previewK,
                    height: imgDisplayH * previewK,
                    maxWidth: 'none',
                    pointerEvents: 'none',
                  }}
                />
              )}
            </div>
            <div style={{ fontSize: 9.5, color: inkSoft, marginTop: 4, fontFamily: "'JetBrains Mono', monospace" }}>
              {BANNER_SPEC.recommendedWidth}&thinsp;×&thinsp;{BANNER_SPEC.recommendedHeight} px &middot; WebP
            </div>
          </div>

          <p style={{ flex: 1, margin: 0, fontSize: 11, color: inkSoft, lineHeight: 1.55, minWidth: 140 }}>
            Output will be rendered at exactly{' '}
            <b style={{ color: ink }}>{BANNER_SPEC.recommendedWidth}&thinsp;×&thinsp;{BANNER_SPEC.recommendedHeight} px</b>{' '}
            (3:1), encoded as optimised WebP.
          </p>

          <div style={{ display: 'flex', gap: 10, marginLeft: 'auto', flexShrink: 0 }}>
            <button type="button" onClick={onCancel} style={{
              padding: '9px 18px', borderRadius: 10,
              border: `1.4px solid ${hairline}`, fontWeight: 600,
              fontSize: 13, color: ink, background: 'transparent', cursor: 'pointer',
            }}>
              Cancel
            </button>
            <button type="button" onClick={handleConfirm} disabled={busy} style={{
              padding: '9px 20px', borderRadius: 10, border: 'none',
              cursor: busy ? 'default' : 'pointer',
              background: `linear-gradient(135deg, ${teal[500]}, ${teal[700]})`,
              color: '#fff', fontSize: 13, fontWeight: 700,
              display: 'flex', alignItems: 'center', gap: 7,
              boxShadow: '0 8px 20px -8px rgba(15,84,76,.55)',
              opacity: busy ? 0.7 : 1,
            }}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {busy ? 'Preparing…' : 'Crop & Prepare'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const controlBtnStyle: React.CSSProperties = {
  width: 32, height: 32, borderRadius: 8,
  border: `1.4px solid ${hairline}`,
  background: paper, color: inkSoft, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
};

export default BannerCropModal;

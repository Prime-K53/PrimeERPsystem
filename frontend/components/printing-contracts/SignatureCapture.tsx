import React, { useRef, useState } from 'react';
import { PenLine, Upload, RotateCcw } from 'lucide-react';
import {
  normalizeSignatureDataUrl,
  validateSignatureUploadFile,
} from '../../utils/signatureUtils';

export interface CapturedContractSignature {
  name: string;
  role: string;
  signatureDataUrl: string;
  mode: 'Draw' | 'Upload';
}

interface SignatureCaptureProps {
  signerLabel: string;
  initialName?: string;
  initialRole?: string;
  submitLabel?: string;
  onConfirm: (sig: CapturedContractSignature) => void;
  onCancel: () => void;
}

const CANVAS_WIDTH = 600;
const CANVAS_HEIGHT = 220;

type Point = { x: number; y: number };

/**
 * Same-device signature capture for printing contracts: canvas draw or
 * file upload, plus printed name + role. Self-contained (inline errors,
 * no notification dependency) so the ceremony stays testable.
 *
 * A blank canvas normalizes to a syntactically valid PNG — stroke
 * tracking refuses it, because an empty image is not a signature.
 */
export const SignatureCapture: React.FC<SignatureCaptureProps> = ({
  signerLabel,
  initialName = '',
  initialRole = '',
  submitLabel = 'Confirm signature',
  onConfirm,
  onCancel,
}) => {
  const [name, setName] = useState(initialName);
  const [role, setRole] = useState(initialRole);
  const [mode, setMode] = useState<'Draw' | 'Upload'>('Draw');
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasStrokes, setHasStrokes] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastPointRef = useRef<Point | null>(null);

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: ((e.clientX - rect.left) / rect.width) * CANVAS_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * CANVAS_HEIGHT,
    };
  };

  const startDrawing = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode !== 'Draw') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (canvas.hasPointerCapture?.(e.pointerId)) {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
    } else {
      try {
        canvas.setPointerCapture?.(e.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
    }
    const point = getCanvasPoint(e);
    if (!point) return;
    lastPointRef.current = point;
    setIsDrawing(true);
  };

  const draw = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing || mode !== 'Draw') return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const point = getCanvasPoint(e);
    const last = lastPointRef.current;
    if (!canvas || !ctx || !point || !last) return;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0f172a';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    if (!hasStrokes) setHasStrokes(true);
  };

  const stopDrawing = (e?: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawing) return;
    setIsDrawing(false);
    lastPointRef.current = null;
    const canvas = canvasRef.current;
    if (canvas && e && canvas.hasPointerCapture?.(e.pointerId)) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* release is best-effort */
      }
    }
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (canvas && ctx) {
      ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    }
    setHasStrokes(false);
    setError('');
  };

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const validationError = validateSignatureUploadFile(file);
    if (validationError || !file) {
      setError(validationError || 'No file selected.');
      e.target.value = '';
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const normalized = normalizeSignatureDataUrl(ev.target?.result as string);
      if (!normalized) {
        setError('Uploaded signature format is invalid.');
        return;
      }
      setUploadedDataUrl(normalized);
      setError('');
    };
    reader.readAsDataURL(file);
  };

  const handleConfirm = () => {
    if (!name.trim()) {
      setError('Printed name is required — a signature without an identified signer proves nothing.');
      return;
    }
    if (!role.trim()) {
      setError('Role is required (e.g. Sales Manager, Head Teacher).');
      return;
    }
    if (mode === 'Draw') {
      if (!hasStrokes) {
        setError('No signature drawn yet.');
        return;
      }
      const dataUrl = normalizeSignatureDataUrl(canvasRef.current?.toDataURL('image/png') || '');
      if (!dataUrl) {
        setError('Could not read the drawn signature.');
        return;
      }
      onConfirm({ name: name.trim(), role: role.trim(), signatureDataUrl: dataUrl, mode });
      return;
    }
    if (!uploadedDataUrl) {
      setError('Upload a signature image first.');
      return;
    }
    onConfirm({
      name: name.trim(),
      role: role.trim(),
      signatureDataUrl: uploadedDataUrl,
      mode: 'Upload',
    });
  };

  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 0',
    fontSize: 12,
    fontWeight: 700,
    borderRadius: 8,
    cursor: 'pointer',
    border: '1px solid transparent',
    background: active ? '#0f766e' : '#f1f5f9',
    color: active ? '#fff' : '#475569',
  });

  return (
    <div>
      <p style={{ fontSize: 12, color: '#5c6567', margin: '0 0 12px' }}>
        Signing as <strong style={{ color: '#23282a' }}>{signerLabel}</strong>. Both the image and the
        printed name are stored on the contract audit trail.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#5c6567', marginBottom: 4 }}>
            Printed name *
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Full name"
            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1.4px solid #e4ddd1', borderRadius: 8, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#5c6567', marginBottom: 4 }}>
            Role *
          </label>
          <input
            value={role}
            onChange={e => setRole(e.target.value)}
            placeholder="e.g. Sales Manager"
            style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1.4px solid #e4ddd1', borderRadius: 8, outline: 'none', boxSizing: 'border-box' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button type="button" style={tabStyle(mode === 'Draw')} onClick={() => { setMode('Draw'); setError(''); }}>
          <PenLine size={14} /> Draw
        </button>
        <button type="button" style={tabStyle(mode === 'Upload')} onClick={() => { setMode('Upload'); setError(''); }}>
          <Upload size={14} /> Upload
        </button>
      </div>
      {mode === 'Draw' ? (
        <div>
          <canvas
            ref={canvasRef}
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            onPointerDown={startDrawing}
            onPointerMove={draw}
            onPointerUp={stopDrawing}
            onPointerLeave={() => stopDrawing()}
            style={{
              width: '100%', height: 150, border: '1.4px dashed #94a3b8', borderRadius: 8,
              background: '#fff', cursor: 'crosshair', touchAction: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
            <button
              type="button"
              onClick={clearCanvas}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 600, color: '#5c6567', background: 'none', border: 'none', cursor: 'pointer' }}
            >
              <RotateCcw size={13} /> Clear
            </button>
          </div>
        </div>
      ) : (
        <div>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleUpload} style={{ display: 'none' }} />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            style={{ width: '100%', padding: '14px 10px', fontSize: 13, fontWeight: 600, color: '#0f766e', background: '#f0fdfa', border: '1.4px dashed #0f766e', borderRadius: 8, cursor: 'pointer' }}
          >
            {uploadedDataUrl ? 'Signature uploaded — click to replace' : 'Upload signature image (PNG/JPG/WEBP, max 5 MB)'}
          </button>
          {uploadedDataUrl && (
            <div style={{ marginTop: 8, textAlign: 'center' }}>
              <img src={uploadedDataUrl} alt="Uploaded signature preview" style={{ maxWidth: '100%', maxHeight: 110, border: '1px solid #e4ddd1', borderRadius: 8, background: '#fff' }} />
            </div>
          )}
        </div>
      )}
      {error && (
        <p role="alert" style={{ fontSize: 12, fontWeight: 600, color: '#b91c1c', margin: '10px 0 0' }}>{error}</p>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
        <button
          type="button"
          onClick={onCancel}
          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, color: '#5c6567', background: '#f1f5f9', border: '1px solid #e4ddd1', borderRadius: 8, cursor: 'pointer' }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 700, color: '#fff', background: 'linear-gradient(155deg, #0f766e, #115e59)', border: '1px solid transparent', borderRadius: 8, cursor: 'pointer' }}
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
};

export default SignatureCapture;

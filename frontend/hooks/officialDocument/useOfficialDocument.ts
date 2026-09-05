import { useCallback, useEffect, useRef, useState } from 'react';
import type { PDFPreviewSource } from '../views/shared/components/PDF/pdfPreviewUtils';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';

export interface UseOfficialDocumentResult {
  state: LoadState;
  source: PDFPreviewSource | null;
  blob: Blob | null;
  blobUrl: string | null;
  error: string | null;
  load: (input: PDFPreviewSource | Uint8Array | ArrayBuffer | Blob | null) => void;
  download: (filename?: string) => Promise<void>;
  print: () => void;
  reset: () => void;
}

const toBlob = (input: PDFPreviewSource | Uint8Array | ArrayBuffer | Blob): Blob => {
  if (input instanceof Blob) return input;
  if (input instanceof Uint8Array) {
    return new Blob([input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)], { type: 'application/pdf' });
  }
  if (input instanceof ArrayBuffer) {
    return new Blob([input], { type: 'application/pdf' });
  }
  return new Blob([input], { type: 'application/pdf' });
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const useOfficialDocument = (): UseOfficialDocumentResult => {
  const [state, setState] = useState<LoadState>('idle');
  const [source, setSource] = useState<PDFPreviewSource | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const revokeRef = useRef<string | null>(null);
  const cancelledRef = useRef(false);

  const cleanup = useCallback(() => {
    if (revokeRef.current) {
      URL.revokeObjectURL(revokeRef.current);
      revokeRef.current = null;
    }
  }, []);

  const load = useCallback(
    (input: PDFPreviewSource | Uint8Array | ArrayBuffer | Blob | null) => {
      cleanup();
      cancelledRef.current = false;

      if (!input) {
        setSource(null);
        setBlob(null);
        setBlobUrl(null);
        setState('idle');
        setError(null);
        return;
      }

      setState('loading');
      setError(null);

      const next = toBlob(input);
      const url = URL.createObjectURL(next);
      revokeRef.current = url;

      setSource(next);
      setBlob(next);
      setBlobUrl(url);
      setState('ready');
    },
    [cleanup]
  );

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      cleanup();
    };
  }, [cleanup]);

  const download = useCallback(
    async (filename = 'document.pdf') => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        await sleep(50);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    [blob]
  );

  const print = useCallback(() => {
    if (!blobUrl) return;
    const iframe = document.createElement('iframe');
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.src = blobUrl;
    document.body.appendChild(iframe);

    let removed = false;
    const cleanupPrint = () => {
      if (removed) return;
      removed = true;
      try { document.body.removeChild(iframe); } catch { /* already removed */ }
    };

    iframe.addEventListener('load', () => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        window.open(blobUrl, '_blank');
      } finally {
        setTimeout(cleanupPrint, 60_000);
      }
    });

    setTimeout(cleanupPrint, 60_000);
  }, [blobUrl]);

  const reset = useCallback(() => {
    cleanup();
    cancelledRef.current = false;
    setSource(null);
    setBlob(null);
    setBlobUrl(null);
    setState('idle');
    setError(null);
  }, [cleanup]);

  return { state, source, blob, blobUrl, error, load, download, print, reset };
};

export default useOfficialDocument;

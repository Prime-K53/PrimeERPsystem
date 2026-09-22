import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useVoiceDictation — browser-native speech-to-text (Web Speech API),
 * same mechanism as AICopilot's voice input. No new provider, no API keys,
 * no audio leaves the device except to the browser's own recognizer.
 *
 * Delivers the FINAL transcript via `onFinalText`; interim results only
 * drive the `listening` indicator. When unsupported, `supported` is false
 * and callers must offer typing instead — never pretend to listen.
 */
export function useVoiceDictation(onFinalText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<{ start: () => void; stop: () => void; abort?: () => void } | null>(null);
  const cbRef = useRef(onFinalText);
  cbRef.current = onFinalText;

  useEffect(() => {
    const SR = (window as unknown as Record<string, unknown>).SpeechRecognition
      || (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
    if (!SR || typeof SR !== 'function') {
      setSupported(false);
      return;
    }
    setSupported(true);
    const rec = new (SR as new () => {
      continuous: boolean;
      interimResults: boolean;
      lang: string;
      onresult: ((e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
      onend: (() => void) | null;
      onerror: ((e: { error?: string }) => void) | null;
      start: () => void;
      stop: () => void;
      abort: () => void;
    })();
    rec.continuous = false;
    rec.interimResults = true;
    try {
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
    } catch {
      rec.lang = 'en-US';
    }
    rec.onresult = (e) => {
      let transcript = '';
      let hasFinal = false;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        transcript += e.results[i][0].transcript;
        if (e.results[i].isFinal) hasFinal = true;
      }
      if (hasFinal && transcript.trim()) {
        cbRef.current(transcript.trim());
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = (e) => {
      setListening(false);
      if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') {
        setError('Microphone access was denied — allow it in the browser, or type instead.');
      } else if (e?.error === 'no-speech') {
        setError('No speech detected — try again, or type instead.');
      }
    };
    recRef.current = rec;
    return () => {
      try { rec.abort(); } catch { /* already stopped */ }
      recRef.current = null;
    };
  }, []);

  const toggle = useCallback(() => {
    setError(null);
    const rec = recRef.current;
    if (!rec) {
      setError('Voice input is not supported in this browser — please type instead.');
      return;
    }
    setListening((prev) => {
      if (prev) {
        try { rec.stop(); } catch { /* ignore */ }
        return false;
      }
      try {
        rec.start();
        return true;
      } catch {
        return false;
      }
    });
  }, []);

  const stop = useCallback(() => {
    try { recRef.current?.stop(); } catch { /* ignore */ }
    setListening(false);
  }, []);

  return { supported, listening, error, toggle, stop };
}

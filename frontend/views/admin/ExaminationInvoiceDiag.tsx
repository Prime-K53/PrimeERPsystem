import React, { useCallback, useState } from 'react';
import { Activity, ArrowLeft, ClipboardCopy, FileSearch, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { dbService } from '../../services/db';
import { backgroundSyncService } from '../../services/backgroundSyncService';
import { durableSyncQueue } from '../../services/durableSyncQueue';
import { findInvoiceByIdOrNumber } from '../../utils/invoiceIdentity';
import {
  EXAM_DIAG_DEFAULT_NUMBER,
  buildExaminationInvoiceDiag,
  renderExamDiagCopy,
  type ExamDiagResult,
} from '../../services/examinationInvoiceDiag';

const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';

const HISTORICAL_STAGES = [
  'context-generate', 'generate', 'persist-entry', 'persist-guard-reject', 'persist-mapped',
  'process-entry', 'db-put-local', 'db-put-enqueued', 'db-put-enqueue-failed',
  'queue-created', 'queue-duplicated', 'queue-merged',
  'sync-transport-failure', 'sync-gateway-result', 'sync-settle',
  'collision-check', 'remint', 'deadletter',
];

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="prime-card" style={{ background: paper, padding: '12px 16px', borderRadius: 14, border: `1.4px solid ${hairline}`, marginBottom: 12 }}>
    <p style={{ fontSize: 11, fontWeight: 800, color: inkSoft, textTransform: 'uppercase', letterSpacing: 0.6, margin: '0 0 8px' }}>{title}</p>
    {children}
  </div>
);

const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ display: 'flex', gap: 8, padding: '3px 0', fontSize: 13 }}>
    <span style={{ color: inkSoft, minWidth: 170 }}>{label}</span>
    <span style={{ color: ink, fontWeight: 600, wordBreak: 'break-all' }}>{value ?? '—'}</span>
  </div>
);

const ExaminationInvoiceDiag: React.FC = () => {
  const navigate = useNavigate();
  const [lookup, setLookup] = useState(EXAM_DIAG_DEFAULT_NUMBER);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ExamDiagResult | null>(null);
  const [readErrors, setReadErrors] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  const inspect = useCallback(async () => {
    const number = String(lookup || '').trim();
    if (!number) return;
    setBusy(true);
    setCopied(false);
    const errors: string[] = [];
    // Local reads only — no writes, no enqueues, no replays, no repairs.
    const invoices = await dbService.getAll<Record<string, unknown>>('invoices').catch((e) => {
      errors.push(`invoices read failed: ${String((e as Error)?.message || e)}`);
      return [] as Record<string, unknown>[];
    });
    const invoice = findInvoiceByIdOrNumber(invoices, number) as Record<string, unknown> | undefined;
    const queueOps = await durableSyncQueue.getAll().catch((e) => {
      errors.push(`queue read failed: ${String((e as Error)?.message || e)}`);
      return [];
    });
    const conflicts = await backgroundSyncService.getConflicts(100).catch((e) => {
      errors.push(`conflicts read failed: ${String((e as Error)?.message || e)}`);
      return [] as unknown[];
    });
    const syncState = await backgroundSyncService.getState().catch((e) => {
      errors.push(`sync state read failed: ${String((e as Error)?.message || e)}`);
      return null;
    });
    const authBlocked = await durableSyncQueue.isAuthBlocked().catch(() => null);
    let enginePaused: boolean | null = null;
    try {
      enginePaused = backgroundSyncService.isPaused();
    } catch {
      enginePaused = null;
    }
    const built = await buildExaminationInvoiceDiag({
      invoiceNumber: number,
      invoice: invoice ?? null,
      queueOps: queueOps as never,
      conflicts: conflicts as never,
      syncMeta: {
        authBlocked,
        enginePaused,
        lastSyncStart: syncState?.lastSyncStart ?? null,
        lastSyncSuccess: syncState?.lastSyncSuccess ?? null,
        lastSyncFailure: syncState?.lastSyncFailure ?? null,
      },
    });
    setResult(built);
    setReadErrors(errors);
    setBusy(false);
  }, [lookup]);

  const copyDiagnostic = useCallback(async () => {
    if (!result) return;
    const text = renderExamDiagCopy(result);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      document.body.removeChild(area);
    }
    setCopied(true);
  }, [result]);

  return (
    <div style={{ padding: 20, maxWidth: 860 }}>
      <button onClick={() => navigate('/admin/sync-health')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12, background: 'none', border: 'none', color: inkSoft, cursor: 'pointer', fontSize: 13 }}>
        <ArrowLeft size={14} /> Back to Sync Health
      </button>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8, color: ink, margin: '0 0 4px' }}>
        <FileSearch size={20} /> Examination Invoice Diagnostic
      </h2>
      <p style={{ color: inkSoft, fontSize: 13, margin: '0 0 16px' }}>
        Read-only local inspection for one examination invoice. Nothing here writes, replays, repairs, or regenerates anything.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          placeholder="EXM-P726/021"
          style={{ flex: 1, padding: '8px 12px', borderRadius: 8, border: `1.4px solid ${hairline}`, fontSize: 14 }}
        />
        <button onClick={inspect} disabled={busy || !String(lookup || '').trim()} style={{ padding: '8px 18px', borderRadius: 8, border: 'none', background: '#146b60', color: '#fff', fontWeight: 700, cursor: 'pointer' }}>
          {busy ? 'Inspecting…' : 'Inspect'}
        </button>
      </div>
      {readErrors.length > 0 && (
        <Section title="Read warnings">
          {readErrors.map((e, i) => (
            <p key={i} style={{ color: '#b5493f', fontSize: 13, margin: '2px 0' }}>{e}</p>
          ))}
        </Section>
      )}
      {result && (
        <>
          <Section title="Diagnostic conclusion">
            <p style={{ fontSize: 16, fontWeight: 800, color: ink, margin: '0 0 4px' }}>{result.conclusion}</p>
            <p style={{ fontSize: 13, color: inkSoft, margin: 0 }}>{result.diagnosticStatus}</p>
            <button onClick={copyDiagnostic} style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 14px', borderRadius: 8, border: `1.4px solid ${hairline}`, background: paper, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              <ClipboardCopy size={14} /> {copied ? 'Copied' : 'Copy diagnostic'}
            </button>
          </Section>
          <Section title="Local invoice">
            <Row label="Present" value={String(result.localInvoice.present)} />
            <Row label="ID" value={result.localInvoice.id} />
            <Row label="Invoice number" value={result.localInvoice.invoiceNumber} />
            <Row label="Origin module" value={result.localInvoice.originModule} />
            <Row label="Batch ID" value={result.localInvoice.batchId} />
            <Row label="Status" value={result.localInvoice.status} />
            <Row label="ID equals number" value={String(result.localInvoice.idEqualsNumber)} />
            <Row label="Token present" value={String(result.localInvoice.tokenPresent)} />
            <Row label="Token length" value={String(result.localInvoice.tokenLength)} />
            <Row label="Token fingerprint" value={result.localInvoice.tokenFingerprint} />
            <Row label="Created" value={result.localInvoice.createdAt} />
            <Row label="Updated" value={result.localInvoice.updatedAt} />
            <Row label="Server version stamp" value={result.localInvoice.serverVersionStamp} />
          </Section>
          <Section title="Durable sync queue">
            {result.queue.operations.length === 0 && <p style={{ fontSize: 13, color: inkSoft }}>No operation for this invoice.</p>}
            {result.queue.operations.map((op, i) => (
              <div key={i} style={{ borderTop: i ? `1px solid ${hairline}` : 'none', paddingTop: i ? 8 : 0, marginTop: i ? 8 : 0 }}>
                <Row label="Operation ID" value={op.opId} />
                <Row label="Operation" value={op.operation} />
                <Row label="Status" value={op.status} />
                <Row label="Created" value={op.createdAt} />
                <Row label="Last attempt" value={op.lastAttempt} />
                <Row label="Retry count" value={op.retryCount} />
                <Row label="Error" value={op.lastErrorSnippet} />
                <Row label="Error type" value={op.errorType} />
                <Row label="Retry eligibility" value={op.retryEligibility} />
              </div>
            ))}
          </Section>
          <Section title="Sync metadata">
            <Row label="Auth blocked" value={String(result.sync.authBlocked)} />
            <Row label="Engine paused" value={String(result.sync.enginePaused)} />
            <Row label="Last sync start" value={result.sync.lastSyncStart} />
            <Row label="Last sync success" value={result.sync.lastSyncSuccess} />
            <Row label="Last sync failure" value={result.sync.lastSyncFailure} />
            {result.conflicts.length > 0 && (
              <>
                <p style={{ fontSize: 12, fontWeight: 800, color: inkSoft, margin: '8px 0 4px' }}>CONFLICTS</p>
                {result.conflicts.map((c, i) => (
                  <Row key={i} label={c.recordId || 'record'} value={`${c.resolved || '—'} — ${(c.conflictedFields || []).join(', ') || '—'}`} />
                ))}
              </>
            )}
          </Section>
          <Section title="Lifecycle trace">
            <p style={{ fontSize: 13, color: inkSoft, margin: '0 0 6px', display: 'flex', gap: 6, alignItems: 'center' }}>
              <Activity size={14} /> NO HISTORICAL TRACE AVAILABLE — stage history is ephemeral console output, not persisted state.
            </p>
            <p style={{ fontSize: 12, color: inkSoft, margin: 0 }}>{HISTORICAL_STAGES.join(' → ')}</p>
          </Section>
          <p style={{ fontSize: 12, color: inkSoft, display: 'flex', gap: 6, alignItems: 'center' }}>
            <ShieldAlert size={14} /> {result.verification.note}
          </p>
        </>
      )}
    </div>
  );
};

export default ExaminationInvoiceDiag;

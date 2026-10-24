import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE_URL } from '../../config/api.js';
import { REDESIGN_CSS, Seal } from './DocumentVerify';

/**
 * Public printing-contract verification page.
 *
 *   /verify?c=<contract-number-url-safe>&h=<full-sha256>
 *
 * Two independent outcomes are deliberately kept separate:
 *   - Document Verification: whether the authoritative record can be resolved and
 *     the document-level checks pass.
 *   - SHA-256 Integrity Verification: whether the supplied/recomputed digest
 *     matches the authoritative stored digest.
 *  A valid document with an integrity mismatch must still be identified as a
 *  document and must show both results independently.
 *
 * The QR still points at this same page; nothing here changes the QR payload.
 */

type ContractDetails = {
  contractNumber: string;
  customerName: string;
  contractDate: string;
  status: string;
  total: number;
  currency: string;
  companyName?: string;
};

type DocStatus = 'Verified' | 'Not Found / Invalid' | 'Unavailable';
type IntegrityStatus = 'Integrity Verified' | 'Integrity Mismatch' | 'Hash Missing' | 'Integrity Check Unavailable' | 'Not Evaluated';

type VerificationOutcome = {
  docStatus: DocStatus;
  integrityStatus: IntegrityStatus;
  contract?: ContractDetails;
  reason?: string;
};

type PageState =
  | { kind: 'idle' }
  | { kind: 'loading'; lookup: string }
  | { kind: 'result'; lookup: string; hash: string; outcome: VerificationOutcome }
  | { kind: 'error'; lookup: string; hash: string };

const SHORT_CODE_RE = /^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i;

const CONTRACT_VERIFY_CSS = `
.ppv-lede{ font-size:13px; line-height:1.55; color:var(--ink-soft); margin:-6px 0 22px; }
.ppv-form{ display:grid; gap:8px; margin-top:4px; }
.ppv-form label{ font-size:11px; letter-spacing:.06em; text-transform:uppercase; color:var(--ink-soft); font-weight:600; }
.ppv-input{
  width:100%; box-sizing:border-box; padding:10px 12px; border:1px solid var(--line);
  border-radius:3px; background:#FCFAF3; color:var(--ink); font-size:14px;
  font-family:'Inter',system-ui,-apple-system,sans-serif; outline:none;
}
.ppv-input:focus{ border-color:var(--teal); box-shadow:0 0 0 2px rgba(20,92,84,.12); }
.ppv-btn{
  justify-self:start; margin-top:4px; padding:9px 18px; border:1px solid var(--teal-deep);
  border-radius:3px; background:var(--teal-deep); color:#FCFAF3; font-size:13px;
  font-weight:600; letter-spacing:.02em; cursor:pointer;
}
.ppv-btn:hover{ background:var(--teal); }
.ppv-btn:disabled{ opacity:.55; cursor:not-allowed; }
.ppv-note{ margin-top:18px; padding-top:14px; border-top:1px solid var(--line-soft); font-size:11.5px; line-height:1.55; color:var(--ink-soft); }
.ppv-note b{ color:var(--ink); font-weight:600; }
.ppv-mono{ font-family:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
.ppv-err{ margin-top:14px; padding:10px 12px; border:1px solid rgba(178,58,46,.35); background:rgba(178,58,46,.05); color:var(--stamp); font-size:12.5px; line-height:1.5; }
.ppv-result{ margin-top:14px; padding:10px 12px; border:1px solid var(--line); background:#FCFAF3; border-radius:3px; }
.ppv-result-row{ display:flex; justify-content:space-between; gap:10px; font-size:12.5px; padding:6px 0; border-bottom:1px solid var(--line-soft); }
.ppv-result-row:last-child{ border-bottom:none; }
.ppv-result-label{ font-weight:600; color:var(--ink); }
.ppv-result-value{ color:var(--ink-soft); text-align:right; }
`;

const str = (value: unknown, fallback = '—'): string => {
  const text = String(value ?? '').trim();
  return text || fallback;
};

const fmtTotal = (currency: string, value: unknown): string =>
  `${String(currency || 'MWK')} ${Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const fmtDate = (raw: unknown): string => {
  const text = String(raw ?? '').trim();
  if (!text) return '—';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dmy = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (dmy) return `${dmy[1].padStart(2, '0')}/${dmy[2].padStart(2, '0')}/${dmy[3]}`;
  return text;
};

const statusTone = (status: unknown): 'teal' | 'amber' | 'red' => {
  const value = String(status || '').toUpperCase();
  if (['ACTIVE', 'COMPLETED', 'SIGNED', 'APPROVED'].includes(value)) return 'teal';
  if (['CANCELLED', 'CANCELED', 'VOID', 'VOIDED'].includes(value)) return 'red';
  return 'amber';
};

/** Reads `c`/`h` from the real query string AND the hash-router query. */
export function readContractVerifyParams(search?: string, hash?: string): { c: string; h: string } {
  const actualSearch = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const actualHash = hash ?? (typeof window !== 'undefined' ? window.location.hash : '');
  const queryIndex = actualHash.indexOf('?');
  const hashQuery = queryIndex >= 0 ? actualHash.slice(queryIndex + 1) : '';

  const fromSearch = new URLSearchParams(String(actualSearch || '').replace(/^\?/, ''));
  const fromHash = new URLSearchParams(hashQuery);

  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = fromSearch.get(key) ?? fromHash.get(key);
      if (value && value.trim()) return value.trim();
    }
    return '';
  };

  return {
    c: pick('c', 'contract', 'number', 'sc', 'shortCode'),
    h: pick('h', 'hash'),
  };
}

async function requestContract(
  lookup: string,
  hash: string,
): Promise<VerificationOutcome> {
  const empty: VerificationOutcome = { docStatus: 'Unavailable', integrityStatus: 'Integrity Check Unavailable' };
  const safe = (value: string | undefined, fallback: string) => String(value || fallback).trim() || fallback;

  try {
    const params = new URLSearchParams();
    params.set('c', lookup);
    if (hash) params.set('h', hash);

    const res = await fetch(
      `${API_BASE_URL}/public/documents/contract-verify?${params.toString()}`,
      { headers: { Accept: 'application/json' } },
    );
    if (!res.ok) return empty;

    const body = await res.json().catch(() => null) as Record<string, any> | null;
    const result = String(body?.result || (body?.verified === true ? 'verified' : 'not_found'));
    const reason = String(body?.reason || '').trim();

    if (result === 'verified' && body?.verified === true) {
      const detail = body as any;
      return {
        docStatus: 'Verified',
        integrityStatus: 'Integrity Verified',
        contract: {
          contractNumber: str(detail.contractNumber),
          customerName: str(detail.customerName),
          contractDate: fmtDate(detail.contractDate),
          status: str(detail.status),
          total: Number(detail.total || 0),
          currency: String(detail.currency || 'MWK'),
          companyName: detail.companyName ? String(detail.companyName) : undefined,
        },
        reason: 'verified',
      };
    }

    if (result === 'altered') {
      const integrityResult = String(body?.integrityResult || '').trim();
      const mapped: IntegrityStatus =
        integrityResult === 'Hash Missing' || reason === 'missing_stored_hash' || reason === 'stored_hash_not_sha256'
          ? 'Hash Missing'
          : 'Integrity Mismatch';
      return {
        docStatus: 'Verified',
        integrityStatus: mapped,
        reason: reason || 'integrity_failed',
      };
    }

    return {
      docStatus: 'Not Found / Invalid',
      integrityStatus: 'Not Evaluated',
      reason: reason || 'not_found',
    };
  } catch {
    return empty;
  }
}

export const ContractVerify: React.FC = () => {
  const initial = useMemo(() => readContractVerifyParams(), []);
  const [state, setState] = useState<PageState>({ kind: 'idle' });
  const [lookup, setLookup] = useState(() => (SHORT_CODE_RE.test(initial.c) ? initial.c : ''));
  const [formError, setFormError] = useState('');
  const requestSeq = useRef(0);

  const runLookup = useCallback(async (value: string, hash: string) => {
    const requestId = ++requestSeq.current;
    setState({ kind: 'loading', lookup: value });
    try {
      const outcome = await requestContract(value, hash);
      if (requestId !== requestSeq.current) return;
      setState({ kind: 'result', lookup: value, hash, outcome });
    } catch {
      if (requestId === requestSeq.current) setState({ kind: 'error', lookup: value, hash });
    }
    if (SHORT_CODE_RE.test(value)) setLookup(value);
  }, []);

  useEffect(() => {
    if (initial.c) void runLookup(initial.c, initial.h);
    return () => {
      requestSeq.current += 1;
    };
  }, [initial.c, initial.h, runLookup]);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = String(lookup || '').trim();
    if (!SHORT_CODE_RE.test(value)) {
      setFormError('Enter the short code exactly as printed: three groups of four characters (for example 4612-f2e1-2ecc).');
      return;
    }
    setFormError('');
    void runLookup(value, '');
  };

  const shell = (body: React.ReactNode) => (
    <div className="ppv-page">
      <style>{REDESIGN_CSS}</style>
      <style>{CONTRACT_VERIFY_CSS}</style>
      <link rel="preconnect" href="https://fonts.googleapis.com" />
      <link
        href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600;9..144,700&family=Inter:wght@400;500;600;700&display=swap"
        rel="stylesheet"
      />
      <div className="ppv-stub">
        <div className="ppv-perf" aria-hidden="true">
          <span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
        </div>
        <div className="ppv-card">{body}</div>
      </div>
    </div>
  );

  const mark = (
    <div className="ppv-mark">
      <div className="glyph">P</div>
      <div className="name">PRIME PRINTING</div>
      <div className="sub">Printing contract verification</div>
    </div>
  );

  const sectionBlock = (title: string, value: string, tone: 'teal' | 'amber' | 'red') => (
    <div className="ppv-result-row">
      <span className="ppv-result-label">{title}</span>
      <span className="ppv-result-value">{value}</span>
    </div>
  );

  const toneForDoc = (doc: DocStatus): 'teal' | 'amber' | 'red' =>
    doc === 'Verified' ? 'teal' : doc === 'Unavailable' ? 'amber' : 'red';

  const toneForIntegrity = (integrity: IntegrityStatus): 'teal' | 'amber' | 'red' =>
    integrity === 'Integrity Verified' ? 'teal' : integrity === 'Hash Missing' ? 'amber' : 'red';

  const form = (submitLabel = 'Verify contract') => (
    <form className="ppv-form" onSubmit={submit}>
      <label htmlFor="contract-lookup">Short code</label>
      <input
        id="contract-lookup"
        className="ppv-input ppv-mono"
        value={lookup}
        onChange={(event) => {
          setLookup(event.target.value);
          if (formError) setFormError('');
        }}
        placeholder="4612-f2e1-2ecc"
        autoComplete="off"
        spellCheck={false}
        maxLength={14}
        aria-describedby="contract-lookup-note"
        aria-invalid={Boolean(formError)}
      />
      {formError ? <div className="ppv-err" role="alert">{formError}</div> : null}
      <button className="ppv-btn" type="button" onClick={() => void runLookup(lookup, '')} disabled={state.kind === 'loading'}>
        {submitLabel}
      </button>
      <div className="ppv-note" id="contract-lookup-note">
        The <b>short code</b> is printed under the content hash. It identifies the contract for a manual
        lookup, but it is <b>not proof on its own</b> — the server still validates the full stored digest
        before reporting a match.
      </div>
    </form>
  );

  const submitForm = form('Check another contract');

  if (state.kind === 'loading') {
    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp ppv-pulse"><Seal tone="teal" glyph="dots" /></div>
          <div className="ppv-stamp-text">
            <div className="h1">Verifying contract</div>
            <div className="p1">Recomputing the content hash from Prime Printing records…</div>
          </div>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 8 }}>
          <div className="ppv-skel" style={{ width: '100%' }} />
          <div className="ppv-skel" style={{ width: '82%' }} />
          <div className="ppv-skel" style={{ width: '64%' }} />
        </div>
      </>
    );
  }

  if (state.kind === 'result') {
    const { outcome, lookup: stateLookup, hash } = state;
    const docTone = toneForDoc(outcome.docStatus);
    const integrityTone = toneForIntegrity(outcome.integrityStatus);
    const isVerified = outcome.docStatus === 'Verified' && outcome.integrityStatus === 'Integrity Verified';

    const markTone = outcome.docStatus === 'Verified' ? 'teal' : outcome.docStatus === 'Unavailable' ? 'amber' : 'red';
    const sealGlyph = isVerified
      ? 'check'
      : outcome.docStatus === 'Unavailable'
        ? 'dots'
        : 'warn';

    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp"><Seal tone={markTone} glyph={sealGlyph} /></div>
          <div className="ppv-stamp-text">
            <div className="h1">
              {outcome.docStatus === 'Verified'
                ? outcome.integrityStatus === 'Integrity Verified'
                  ? 'Verified - matches our records'
                  : 'Document found - integrity not verified'
                : outcome.docStatus === 'Unavailable'
                  ? 'Verification unavailable'
                  : 'Document not found'}
            </div>
            <div className="p1">
              {outcome.docStatus === 'Verified'
                ? outcome.integrityStatus === 'Integrity Verified'
                  ? 'The contract data still matches the content hash printed on the document.'
                  : 'The printed hash does not match the authoritative record.'
                : outcome.docStatus === 'Unavailable'
                  ? 'The verification service could not be reached. Please try again.'
                  : 'No contract matches that number or short code in Prime Printing records.'}
            </div>
          </div>
        </div>

        <div className="ppv-result" style={{ marginTop: 12 }}>
          {sectionBlock('Document Verification', outcome.docStatus, docTone)}
          {sectionBlock('SHA-256 Integrity Verification', outcome.integrityStatus, integrityTone)}
          {outcome.contract ? sectionBlock('Document Status', str(outcome.contract.status), statusTone(outcome.contract.status)) : null}
        </div>

        {outcome.docStatus === 'Verified' && outcome.contract ? (
          <div style={{ marginTop: 12 }}>
            <div className="ppv-doctype">Document type <b>Printing contract</b></div>
            <div>
              <div className="ppv-row">
                <span className="label">Contract number</span><span className="fill" />
                <span className="value">{str(outcome.contract.contractNumber)}</span>
              </div>
              <div className="ppv-row">
                <span className="label">Client</span><span className="fill" />
                <span className="value">{str(outcome.contract.customerName)}</span>
              </div>
              <div className="ppv-row">
                <span className="label">Date</span><span className="fill" />
                <span className="value">{fmtDate(outcome.contract.contractDate)}</span>
              </div>
              <div className="ppv-row total">
                <span className="label">Total</span><span className="fill" />
                <span className="value">{fmtTotal(outcome.contract.currency, outcome.contract.total)}</span>
              </div>
            </div>
          </div>
        ) : null}

        {outcome.docStatus === 'Verified' && outcome.integrityStatus !== 'Integrity Verified' ? (
          <div className="ppv-err">
            {outcome.integrityStatus === 'Hash Missing'
              ? 'No authoritative SHA-256 content hash exists for this contract. Content integrity could not be established.'
              : 'The contract data no longer matches the content hash on the document. Do not rely on this copy — contact Prime Printing.'}
          </div>
        ) : null}

        {outcome.docStatus !== 'Verified' ? (
          <>
            {outcome.docStatus === 'Unavailable' ? (
              <button
                className="ppv-btn"
                type="button"
                disabled={!state.lookup}
                onClick={() => void runLookup(state.lookup, state.hash)}
              >
                Retry
              </button>
            ) : null}
            {submitForm}
          </>
        ) : null}
        {outcome.docStatus === 'Unavailable' ? (
          <div className="ppv-err">
            The verification service could not be reached. Please try again.
          </div>
        ) : null}
      </>
    );
  }

  if (state.kind === 'idle') {
    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp"><Seal tone="teal" glyph="dots" /></div>
          <div className="ppv-stamp-text">
            <div className="h1">Verify a printing contract</div>
            <div className="p1">Scan the QR on the contract, or enter the short code printed under its hash.</div>
          </div>
        </div>
        <p className="ppv-lede">
          The QR opens this page with the contract number and its full SHA-256 content hash. A short-code
          lookup runs the same server-side check.
        </p>
        {form()}
      </>
    );
  }

  // Preserve a fallback for an unexpected state.
  return shell(
    <>
      {mark}
      <hr className="ppv-rule" />
      {form()}
    </>
  );
};

export default ContractVerify;
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { API_BASE_URL } from '../../config/api.js';
import { documentTypeFromSlug, type VerifiableDocumentType } from '../../utils/documentVerification';

type VerificationData = Record<string, any>;

type PageState =
  | { kind: 'loading' }
  | { kind: 'verified'; data: VerificationData }
  | { kind: 'terminal'; data: VerificationData }
  | { kind: 'invalid' };

const TYPE_TITLES: Record<string, string> = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  quotation: 'Quotation',
  sales_order: 'Sales order',
  purchase_order: 'Purchase order',
  delivery_note: 'Delivery note',
  supplier_payment: 'Supplier payment',
  statement: 'Statement',
  'printing-contract': 'Printing contract',
};

const TERMINAL_STATUSES = ['VOID', 'CANCELLED', 'SUPERSEDED'];

/* ── Redesign formatting (matches invoice-verification-redesign.html) ── */

const fmt2 = (n: unknown): string =>
  (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const fmtTotal = (currency: string, n: unknown): string =>
  `${String(currency || 'MWK')} ${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

const fmtDateYMD = (raw: unknown): string => {
  const s = String(raw ?? '').trim();
  if (!s) return '—';
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
};

const checkedOn = (): string => {
  try {
    return new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date().toDateString();
  }
};

const str = (v: unknown, fallback = '—'): string => {
  const s = String(v ?? '').trim();
  return s || fallback;
};

type StubRow = { label: string; value: string };
type StubModel = {
  docTypeLabel: string;
  rows: StubRow[];
  total: StubRow | null;
  statusLabel: string;
  statusValue: string;
  statusTone: 'teal' | 'amber' | 'red';
};

const TEAL_STATUSES = new Set(['PAID', 'VALID', 'CLEARED', 'COMPLETED', 'APPROVED', 'DELIVERED', 'SENT', 'CONFIRMED', 'ACTIVE']);
const AMBER_STATUSES = new Set(['PARTIALLY PAID', 'PARTIAL', 'PENDING', 'PROCESSING', 'DRAFT', 'OVERPAID', 'SUSPENDED']);

function statusToneOf(status: unknown): 'teal' | 'amber' | 'red' {
  const s = String(status || '').toUpperCase().trim();
  if (TEAL_STATUSES.has(s)) return 'teal';
  if (AMBER_STATUSES.has(s) || s.includes('PARTIAL') || s.includes('PENDING')) return 'amber';
  return 'red';
}

function stubModel(data: VerificationData, slug: string): StubModel {
  const docTypeLabel = TYPE_TITLES[slug] || 'Document';
  const currency = String(data.currency || 'MWK');
  const statusValue = String(data.status || '').toUpperCase() || '—';
  const tone = statusToneOf(statusValue);

  switch (slug) {
    case 'invoice': {
      const balance = data.balanceDue ?? (Number(data.total || 0) - Number(data.amountPaid || 0));
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: str(data.invoiceNumber) },
          { label: 'Date issued', value: fmtDateYMD(data.invoiceDate) },
          { label: 'Customer', value: str(data.customerName) },
          { label: 'Currency', value: currency },
          { label: 'Subtotal', value: fmt2(data.subtotal ?? data.total) },
          { label: 'Tax', value: fmt2(data.tax) },
          { label: 'Amount paid', value: fmt2(data.amountPaid) },
        ],
        total: { label: 'Balance due', value: fmtTotal(currency, balance) },
        statusLabel: 'Payment status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'receipt': {
      const rows: StubRow[] = [
        { label: 'Document number', value: str(data.receiptNumber) },
        { label: 'Date issued', value: fmtDateYMD(data.receiptDate) },
        { label: 'Customer', value: str(data.customerName) },
        { label: 'Currency', value: currency },
      ];
      if (data.paymentMethod) rows.push({ label: 'Payment method', value: str(data.paymentMethod) });
      if (data.reference) rows.push({ label: 'Reference', value: str(data.reference) });
      return {
        docTypeLabel,
        rows,
        total: { label: 'Amount received', value: fmtTotal(currency, data.amount) },
        statusLabel: 'Payment status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'quotation': {
      const rows: StubRow[] = [
        { label: 'Document number', value: str(data.quotationNumber) },
        { label: 'Date issued', value: fmtDateYMD(data.quotationDate) },
        { label: 'Customer', value: str(data.customerName) },
        { label: 'Currency', value: currency },
        { label: 'Subtotal', value: fmt2(data.subtotal ?? data.total) },
        { label: 'Tax', value: fmt2(data.tax) },
      ];
      if (data.validUntil) rows.push({ label: 'Valid until', value: fmtDateYMD(data.validUntil) });
      return {
        docTypeLabel,
        rows,
        total: { label: 'Total', value: fmtTotal(currency, data.total) },
        statusLabel: 'Status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'sales_order': {
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: str(data.orderNumber) },
          { label: 'Date issued', value: fmtDateYMD(data.orderDate) },
          { label: 'Customer', value: str(data.customerName) },
          { label: 'Currency', value: currency },
        ],
        total: { label: 'Total', value: fmtTotal(currency, data.total) },
        statusLabel: 'Status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'purchase_order': {
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: str(data.purchaseOrderNumber) },
          { label: 'Date issued', value: fmtDateYMD(data.orderDate) },
          { label: 'Supplier', value: str(data.supplierName) },
          { label: 'Currency', value: currency },
        ],
        total: { label: 'Total', value: fmtTotal(currency, data.total) },
        statusLabel: 'Status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'delivery_note': {
      const rows: StubRow[] = [
        { label: 'Document number', value: str(data.deliveryNoteNumber) },
        { label: 'Date issued', value: fmtDateYMD(data.deliveryDate) },
        { label: 'Customer', value: str(data.customerName) },
      ];
      if (data.reference) rows.push({ label: 'Linked invoice', value: str(data.reference) });
      return {
        docTypeLabel,
        rows,
        total: null,
        statusLabel: 'Status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'supplier_payment': {
      const rows: StubRow[] = [
        { label: 'Document number', value: str(data.paymentNumber) },
        { label: 'Date issued', value: fmtDateYMD(data.paymentDate) },
        { label: 'Supplier', value: str(data.supplierName) },
        { label: 'Currency', value: currency },
      ];
      if (data.paymentMethod) rows.push({ label: 'Payment method', value: str(data.paymentMethod) });
      if (data.reference) rows.push({ label: 'Reference', value: str(data.reference) });
      return {
        docTypeLabel,
        rows,
        total: { label: 'Amount paid', value: fmtTotal(currency, data.amount) },
        statusLabel: 'Payment status',
        statusValue,
        statusTone: tone,
      };
    }
    case 'statement': {
      const period = [data.statementPeriodStart, data.statementPeriodEnd].filter((v) => String(v ?? '').trim());
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: str(data.statementNumber) },
          { label: 'Date issued', value: fmtDateYMD(data.statementDate) },
          { label: 'Customer', value: str(data.customerName) },
          { label: 'Currency', value: currency },
          ...(period.length ? [{ label: 'Period', value: period.map((v) => fmtDateYMD(v)).join(' – ') }] : []),
          { label: 'Opening balance', value: fmt2(data.openingBalance) },
          { label: 'Total invoiced', value: fmt2(data.totalInvoiced) },
          { label: 'Total received', value: fmt2(data.totalReceived) },
        ],
        total: { label: 'Closing balance', value: fmtTotal(currency, data.closingBalance) },
        statusLabel: 'Snapshot status',
        statusValue,
        statusTone: tone,
      };
    }
    // NOTE: hyphenated URL slug (like the QR encodes), not the underscored
    // internal type name — the switch matches what the route delivers.
    case 'printing-contract': {
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: str(data.contractNumber) },
          { label: 'Date issued', value: fmtDateYMD(data.contractDate) },
          { label: 'Customer', value: str(data.customerName) },
          { label: 'Currency', value: currency },
        ],
        total: { label: 'Prepaid amount', value: fmtTotal(currency, data.prepaidTotal) },
        statusLabel: 'Contract status',
        statusValue,
        statusTone: tone,
      };
    }
    default: {
      const number = str(
        data.invoiceNumber ?? data.receiptNumber ?? data.quotationNumber ?? data.orderNumber
          ?? data.purchaseOrderNumber ?? data.deliveryNoteNumber ?? data.paymentNumber ?? data.statementNumber
      );
      const date = fmtDateYMD(
        data.invoiceDate ?? data.receiptDate ?? data.quotationDate ?? data.orderDate
          ?? data.paymentDate ?? data.deliveryDate ?? data.statementDate
      );
      const partyLabel = data.supplierName !== undefined ? 'Supplier' : 'Customer';
      return {
        docTypeLabel,
        rows: [
          { label: 'Document number', value: number },
          { label: 'Date issued', value: date },
          { label: partyLabel, value: str(data.customerName ?? data.supplierName) },
          { label: 'Currency', value: currency },
        ],
        total: null,
        statusLabel: 'Status',
        statusValue,
        statusTone: tone,
      };
    }
  }
}

/* Redesign stylesheet — scoped to .ppv- so the ERP theme never leaks in. */
const REDESIGN_CSS = `
.ppv-page{
  --paper:#F2EEE3; --paper-deep:#EAE4D2; --ink:#20261E; --ink-soft:#5B6156;
  --teal:#145C54; --teal-deep:#0E413B; --stamp:#B23A2E; --gold:#A9822F;
  --line:#D8D0BD; --line-soft:#E4DECB;
  margin:0; min-height:100vh; position:relative;
  background:radial-gradient(ellipse at 20% -10%, rgba(20,92,84,0.06), transparent 55%), var(--paper);
  display:flex; align-items:center; justify-content:center;
  padding:48px 20px; font-family:'Inter',system-ui,-apple-system,sans-serif; color:var(--ink);
}
.ppv-page::before{
  content:""; position:fixed; inset:0; pointer-events:none; opacity:.5;
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='matrix' values='0 0 0 0 0.13  0 0 0 0 0.15  0 0 0 0 0.12  0 0 0 0.02 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}
.ppv-stub{ position:relative; width:100%; max-width:460px; }
.ppv-perf{ display:flex; justify-content:space-evenly; position:relative; z-index:2; }
.ppv-perf span{ width:9px; height:9px; border-radius:50%; background:var(--paper); box-shadow:0 0 0 1px var(--line); transform:translateY(5px); }
.ppv-card{
  background:#FCFAF3; border:1px solid var(--line); border-top:none; position:relative;
  padding:44px 40px 36px;
  box-shadow:0 1px 0 rgba(255,255,255,.6) inset, 0 24px 48px -24px rgba(32,38,30,.28);
}
.ppv-card::before,.ppv-card::after{ content:""; position:absolute; top:-1px; width:22px; height:22px; background:var(--paper); border-radius:50%; }
.ppv-card::before{ left:-11px; } .ppv-card::after{ right:-11px; }
.ppv-mark{ text-align:center; margin-bottom:28px; }
.ppv-mark .glyph{
  width:34px; height:34px; margin:0 auto 10px; border:1.5px solid var(--teal); border-radius:50%;
  display:flex; align-items:center; justify-content:center;
  font-family:'Fraunces',Georgia,serif; font-size:16px; font-weight:600; color:var(--teal);
}
.ppv-mark .name{ font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:15px; letter-spacing:.03em; color:var(--teal-deep); }
.ppv-mark .sub{ font-size:12px; color:var(--ink-soft); margin-top:2px; }
.ppv-rule{ border:none; border-top:1px solid var(--line); margin:26px 0; }
.ppv-stamp-row{ display:flex; align-items:center; gap:18px; margin-bottom:26px; }
.ppv-stamp{ flex:none; width:76px; height:76px; position:relative; }
.ppv-stamp svg{ width:100%; height:100%; display:block; }
.ppv-stamp-text{ display:flex; flex-direction:column; }
.ppv-stamp-text .h1{ font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:22px; color:var(--ink); line-height:1.15; }
.ppv-stamp-text .p1{ font-size:13px; color:var(--ink-soft); margin-top:4px; max-width:26ch; }
.ppv-doctype{ display:inline-flex; align-items:center; gap:8px; font-size:12px; color:var(--ink-soft); margin-bottom:22px; }
.ppv-doctype b{ color:var(--ink); font-weight:600; background:var(--paper-deep); padding:2px 8px; border-radius:3px; }
.ppv-row{ display:flex; align-items:baseline; gap:8px; padding:8px 0; }
.ppv-row .label{ font-size:13px; color:var(--ink-soft); white-space:nowrap; }
.ppv-row .fill{ flex:1; border-bottom:1px dotted var(--line); transform:translateY(-3px); }
.ppv-row .value{
  font-size:13.5px; font-weight:600; color:var(--ink); font-variant-numeric:tabular-nums;
  white-space:nowrap; max-width:58%; overflow:hidden; text-overflow:ellipsis;
}
.ppv-row.total{ margin-top:6px; padding-top:16px; border-top:1px solid var(--line); }
.ppv-row.total .label{ font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:15px; color:var(--ink); }
.ppv-row.total .value{ font-family:'Fraunces',Georgia,serif; font-size:20px; font-weight:600; color:var(--teal-deep); }
.ppv-band{ margin-top:18px; display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-radius:2px; border:1px solid; }
.ppv-band .lab{ font-size:12px; color:var(--ink-soft); }
.ppv-band .val{ font-family:'Fraunces',Georgia,serif; font-weight:600; font-size:14px; letter-spacing:.04em; }
.ppv-band.red{ background:repeating-linear-gradient(-45deg, rgba(178,58,46,.06), rgba(178,58,46,.06) 6px, transparent 6px, transparent 12px); border-color:rgba(178,58,46,.35); }
.ppv-band.red .val{ color:var(--stamp); }
.ppv-band.teal{ background:repeating-linear-gradient(-45deg, rgba(20,92,84,.07), rgba(20,92,84,.07) 6px, transparent 6px, transparent 12px); border-color:rgba(20,92,84,.4); }
.ppv-band.teal .val{ color:var(--teal-deep); }
.ppv-band.amber{ background:repeating-linear-gradient(-45deg, rgba(169,130,47,.09), rgba(169,130,47,.09) 6px, transparent 6px, transparent 12px); border-color:rgba(169,130,47,.45); }
.ppv-band.amber .val{ color:var(--gold); }
.ppv-foot{ margin-top:30px; display:flex; align-items:center; gap:14px; }
.ppv-foot .qr{ flex:none; width:52px; height:52px; border:1px solid var(--line); border-radius:4px; display:flex; align-items:center; justify-content:center; font-family:'Fraunces',Georgia,serif; font-weight:600; color:var(--teal-deep); font-size:18px; background:var(--paper); }
.ppv-foot-text{ font-size:11.5px; line-height:1.5; color:var(--ink-soft); }
.ppv-foot-text a{ color:var(--teal-deep); text-decoration:none; border-bottom:1px solid var(--line); }
.ppv-skel{ height:12px; border-radius:3px; background:linear-gradient(90deg, var(--paper-deep) 25%, var(--line-soft) 50%, var(--paper-deep) 75%); background-size:200% 100%; animation:ppv-shimmer 1.2s infinite; }
@keyframes ppv-shimmer{ from{ background-position:200% 0; } to{ background-position:-200% 0; } }
.ppv-pulse{ animation:ppv-pulse 1.6s ease-in-out infinite; transform-origin:center; }
@keyframes ppv-pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.55; } }
@media (max-width:480px){ .ppv-card{ padding:32px 22px 28px; } .ppv-stamp{ width:64px; height:64px; } .ppv-stamp-text .h1{ font-size:19px; } }
@media print{ .ppv-page{ background:#fff; padding:0; display:block; } .ppv-page::before{ display:none; } .ppv-card{ box-shadow:none; } }
`;

function Seal({ tone, glyph }: { tone: 'teal' | 'red' | 'amber'; glyph: 'check' | 'ban' | 'warn' | 'dots' }) {
  const main = tone === 'teal' ? '#145C54' : tone === 'amber' ? '#A9822F' : '#B23A2E';
  const inner = glyph === 'check'
    ? <path d="M35 51 L45.5 61.5 L67 38" fill="none" stroke="#FCFAF3" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    : glyph === 'ban'
      ? <g stroke="#FCFAF3" strokeWidth="4.5" strokeLinecap="round"><line x1="36" y1="36" x2="64" y2="64" /><circle cx="50" cy="50" r="15" fill="none" stroke="#FCFAF3" strokeWidth="4.5" /></g>
      : glyph === 'warn'
        ? <text x="50" y="65" textAnchor="middle" fontFamily="Fraunces, Georgia, serif" fontWeight="700" fontSize="34" fill="#FCFAF3">!</text>
        : <g fill="#FCFAF3"><circle cx="40" cy="50" r="3.4" /><circle cx="50" cy="50" r="3.4" /><circle cx="60" cy="50" r="3.4" /></g>;
  return (
    <svg viewBox="0 0 100 100" role="img" aria-hidden="true">
      <circle cx="50" cy="50" r="47" fill="none" stroke={main} strokeWidth="1" />
      <circle cx="50" cy="50" r="40.5" fill="none" stroke={main} strokeWidth="1" />
      <g stroke={main} strokeWidth="1">
        <line x1="50" y1="3" x2="50" y2="9" />
        <line x1="50" y1="91" x2="50" y2="97" />
        <line x1="3" y1="50" x2="9" y2="50" />
        <line x1="91" y1="50" x2="97" y2="50" />
        <line x1="16.6" y1="16.6" x2="20.8" y2="20.8" />
        <line x1="79.2" y1="16.6" x2="83.4" y2="20.8" />
        <line x1="16.6" y1="83.4" x2="20.8" y2="79.2" />
        <line x1="79.2" y1="83.4" x2="83.4" y2="79.2" />
      </g>
      <circle cx="50" cy="50" r="32" fill={main} />
      {inner}
    </svg>
  );
}

/**
 * Generic public document verification page — no login required.
 * Route: /verify/:documentType/:documentNumber?t=<token>
 * InvoiceVerify renders this with a forced invoice type (compatibility).
 */
export const DocumentVerify: React.FC<{ forcedType?: string; forcedNumber?: string }> = ({
  forcedType,
  forcedNumber,
}) => {
  const params = useParams<{ documentType: string; documentNumber: string; invoiceNumber: string }>();
  const [search] = useSearchParams();
  const token = search.get('t') || '';
  const slug = forcedType || params.documentType || 'invoice';
  const number = forcedNumber || params.documentNumber || params.invoiceNumber || '';
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: 'loading' });
      const type: VerifiableDocumentType | null = forcedType === 'invoice'
        ? 'invoice'
        : documentTypeFromSlug(slug);
      if (!type || !number || !token) {
        setState({ kind: 'invalid' });
        return;
      }
      try {
        const docSlug = forcedType === 'invoice' ? 'invoice' : slug;
        const res = await fetch(
          `${API_BASE_URL}/public/documents/verify/${encodeURIComponent(docSlug)}/${encodeURIComponent(number)}?t=${encodeURIComponent(token)}`
        );
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'invalid' });
          return;
        }
        const data = (await res.json()) as VerificationData;
        if (!cancelled) {
          setState(
            TERMINAL_STATUSES.includes(String(data.status || '').toUpperCase())
              ? { kind: 'terminal', data }
              : { kind: 'verified', data }
          );
        }
      } catch {
        if (!cancelled) setState({ kind: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug, number, token, forcedType]);

  const typeTitle = TYPE_TITLES[forcedType === 'invoice' ? 'invoice' : slug] || 'Document';

  const shell = (body: React.ReactNode) => (
    <div className="ppv-page">
      <style>{REDESIGN_CSS}</style>
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
      <div className="sub">Document verification</div>
    </div>
  );

  const foot = (
    <div className="ppv-foot">
      <div className="qr" aria-hidden="true">✓</div>
      <div className="ppv-foot-text">
        This stub matches the QR on your printed document. Verified against Prime Printing records.{' '}
        <Link to="/portal/login">Customer portal sign-in</Link>
      </div>
    </div>
  );

  if (state.kind === 'loading') {
    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp ppv-pulse"><Seal tone="teal" glyph="dots" /></div>
          <div className="ppv-stamp-text">
            <div className="h1">Verifying document</div>
            <div className="p1">Checking Prime Printing records…</div>
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

  if (state.kind === 'invalid') {
    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp"><Seal tone="red" glyph="warn" /></div>
          <div className="ppv-stamp-text">
            <div className="h1">Document could not be verified</div>
            <div className="p1">The document number or verification code could not be verified against Prime Printing records.</div>
          </div>
        </div>
        <div className="ppv-foot">
          <div className="qr" aria-hidden="true">?</div>
          <div className="ppv-foot-text">
            Please check the QR code or link with the business that issued the document.{' '}
            <Link to="/portal/login">Customer portal sign-in</Link>
          </div>
        </div>
      </>
    );
  }

  if (state.kind === 'terminal') {
    const d = state.data;
    const docSlug = String(d.documentType || (forcedType === 'invoice' ? 'invoice' : slug));
    const model = stubModel(d, docSlug);
    const upperStatus = String(d.status || '').toUpperCase();
    const title = upperStatus === 'CANCELLED'
      ? 'Cancelled document'
      : upperStatus === 'SUPERSEDED'
        ? 'Superseded document'
        : 'Void document';
    const blurb = upperStatus === 'SUPERSEDED'
      ? `This ${model.docTypeLabel.toLowerCase()} was issued by Prime Printing but has subsequently been superseded by a newer statement. Only the latest statement is current.`
      : `This ${model.docTypeLabel.toLowerCase()} was issued by Prime Printing but has subsequently been ${upperStatus === 'CANCELLED' ? 'cancelled' : 'voided'}.`;
    return shell(
      <>
        {mark}
        <hr className="ppv-rule" />
        <div className="ppv-stamp-row">
          <div className="ppv-stamp"><Seal tone="red" glyph="ban" /></div>
          <div className="ppv-stamp-text">
            <div className="h1">{title}</div>
            <div className="p1">{blurb}</div>
          </div>
        </div>
        <div className="ppv-doctype">Document type <b>{model.docTypeLabel}</b></div>
        <div>
          {model.rows.slice(0, 3).map((r) => (
            <div className="ppv-row" key={r.label}>
              <span className="label">{r.label}</span><span className="fill" /><span className="value">{r.value}</span>
            </div>
          ))}
        </div>
        <div className="ppv-band red">
          <span className="lab">{model.statusLabel}</span>
          <span className="val">{model.statusValue}</span>
        </div>
        {foot}
      </>
    );
  }

  const d = state.data;
  const docSlug = String(d.documentType || (forcedType === 'invoice' ? 'invoice' : slug));
  const model = stubModel(d, docSlug);
  return shell(
    <>
      {mark}
      <hr className="ppv-rule" />
      <div className="ppv-stamp-row">
        <div className="ppv-stamp"><Seal tone="teal" glyph="check" /></div>
        <div className="ppv-stamp-text">
          <div className="h1">Verified document</div>
          <div className="p1">Checked against Prime Printing&apos;s records on {checkedOn()}</div>
        </div>
      </div>
      <div className="ppv-doctype">Document type <b>{model.docTypeLabel}</b></div>
      <div>
        {model.rows.map((r) => (
          <div className="ppv-row" key={r.label}>
            <span className="label">{r.label}</span><span className="fill" /><span className="value">{r.value}</span>
          </div>
        ))}
        {model.total && (
          <div className="ppv-row total">
            <span className="label">{model.total.label}</span><span className="fill" /><span className="value">{model.total.value}</span>
          </div>
        )}
      </div>
      <div className={`ppv-band ${model.statusTone}`}>
        <span className="lab">{model.statusLabel}</span>
        <span className="val">{model.statusValue}</span>
      </div>
      {foot}
      <p style={{ display: 'none' }} aria-hidden="true">{typeTitle}</p>
    </>
  );
};

export default DocumentVerify;

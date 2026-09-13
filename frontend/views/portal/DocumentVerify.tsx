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
  invoice: 'invoice',
  receipt: 'receipt',
  quotation: 'quotation',
  sales_order: 'sales order',
  purchase_order: 'purchase order',
  delivery_note: 'delivery note',
  supplier_payment: 'supplier payment',
  statement: 'statement',
};

const TERMINAL_STATUSES = ['VOID', 'CANCELLED', 'SUPERSEDED'];

const fmtMoney = (currency: string, n: number) =>
  `${currency} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const NUMBER_KEYS = [
  'invoiceNumber', 'receiptNumber', 'quotationNumber', 'orderNumber',
  'purchaseOrderNumber', 'deliveryNoteNumber', 'paymentNumber',
  'statementNumber',
];
const DATE_KEYS = [
  'invoiceDate', 'receiptDate', 'quotationDate', 'orderDate',
  'paymentDate', 'deliveryDate', 'creditNoteDate', 'debitNoteDate',
  'statementDate',
];

const SKIP_KEYS = new Set([
  'verified', 'documentType', 'companyName', ...NUMBER_KEYS, ...DATE_KEYS,
  'customerName', 'supplierName', 'status',
  'statementPeriodStart', 'statementPeriodEnd',
]);

function fieldRows(data: VerificationData): Array<[string, string]> {
  const numberKey = NUMBER_KEYS.find((k) => data[k] !== undefined);
  const dateKey = DATE_KEYS.find((k) => data[k] !== undefined);
  const party = data.customerName !== undefined ? 'Customer' : 'Supplier';
  const partyValue = data.customerName ?? data.supplierName ?? '';
  const rows: Array<[string, string]> = [];
  if (numberKey) rows.push(['Document Number', String(data[numberKey] ?? '')]);
  if (dateKey) rows.push(['Date', String(data[dateKey] ?? '')]);
  if (data.statementPeriodStart !== undefined || data.statementPeriodEnd !== undefined) {
    rows.push(['Statement Period', `${String(data.statementPeriodStart ?? '')} – ${String(data.statementPeriodEnd ?? '')}`]);
  }
  rows.push([party, String(partyValue)]);
  for (const [key, value] of Object.entries(data)) {
    if (SKIP_KEYS.has(key) || value === undefined || value === null || value === '') continue;
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    const shown = /amount|total|balance|subtotal|^tax$/i.test(key) && typeof value === 'number'
      ? fmtMoney(String(data.currency || 'MWK'), value)
      : String(value);
    rows.push([label, shown]);
  }
  rows.push(['Status', String(data.status ?? '')]);
  return rows;
}

const card: React.CSSProperties = {
  maxWidth: 520,
  margin: '48px auto',
  padding: '32px 28px',
  background: '#fff',
  borderRadius: 14,
  boxShadow: '0 12px 40px -12px rgba(15,61,46,.25)',
  border: '1px solid #e5e0d2',
  fontFamily: "'Space Grotesk', system-ui, sans-serif",
  color: '#1C2321',
};

const row: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 16,
  padding: '9px 0',
  borderBottom: '1px solid #f0ece0',
  fontSize: 14,
};

const label: React.CSSProperties = { color: '#726F63' };
const value: React.CSSProperties = { fontWeight: 600, textAlign: 'right' };

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

  const typeTitle = TYPE_TITLES[forcedType === 'invoice' ? 'invoice' : slug] || 'document';
  const head = (title: string, sub: string) => (
    <div style={{ textAlign: 'center', marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, color: '#1F5F53' }}>PRIME PRINTING</div>
      <h1 style={{ fontSize: 22, margin: '8px 0 4px' }}>{title}</h1>
      <p style={{ fontSize: 13, color: '#726F63', margin: 0 }}>{sub}</p>
    </div>
  );

  const shell = (body: React.ReactNode) => (
    <div style={{ minHeight: '100vh', background: '#EDE9DD', padding: 16 }}>
      <div style={card}>{body}</div>
    </div>
  );

  if (state.kind === 'loading') {
    return shell(head('Verifying document…', 'Checking Prime Printing records.'));
  }

  if (state.kind === 'invalid') {
    return shell(
      <>
        {head('⚠ Document could not be verified', 'The document number or verification code could not be verified against Prime Printing records.')}
        <p style={{ fontSize: 13, color: '#726F63', textAlign: 'center' }}>
          Please check the QR code or link with the business that issued the document.
        </p>
      </>
    );
  }

  if (state.kind === 'terminal') {
    const d = state.data;
    const upperStatus = String(d.status || '').toUpperCase();
    const cancelled = upperStatus === 'CANCELLED';
    const superseded = upperStatus === 'SUPERSEDED';
    return shell(
      <>
        {head(
          cancelled ? '⊘ Cancelled document' : superseded ? '⊘ Superseded document' : '⊘ Void document',
          superseded
            ? `This ${typeTitle} was issued by Prime Printing but has subsequently been superseded by a newer statement. Only the latest statement is current.`
            : `This ${typeTitle} was issued by Prime Printing but has subsequently been ${cancelled ? 'cancelled' : 'voided'}.`
        )}
        <div>
          {fieldRows(d).slice(0, 3).map(([k, v]) => (
            <div key={k} style={row}><span style={label}>{k}</span><span style={value}>{v}</span></div>
          ))}
        </div>
      </>
    );
  }

  const d = state.data;
  return shell(
    <>
      {head('✓ Verified document', 'Verified against Prime Printing records.')}
      <div style={{ textAlign: 'center', fontSize: 13, color: '#726F63', marginBottom: 8 }}>
        Document Type: <strong style={{ color: '#1C2321' }}>{typeTitle.replace(/^./, (c) => c.toUpperCase())}</strong>
      </div>
      <div>
        {fieldRows(d).map(([k, v], i, arr) => (
          <div key={k} style={i === arr.length - 1 ? { ...row, borderBottom: 'none' } : row}>
            <span style={label}>{k}</span><span style={value}>{v}</span>
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: '#726F63', textAlign: 'center', marginTop: 16 }}>
        Verified against Prime Printing records. <Link to="/portal/login">Customer portal sign-in</Link>
      </p>
    </>
  );
};

export default DocumentVerify;

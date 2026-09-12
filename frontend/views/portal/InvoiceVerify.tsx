import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams, Link } from 'react-router-dom';
import { API_BASE_URL } from '../../config/api.js';

interface VerificationData {
  verified: boolean;
  invoiceNumber: string;
  invoiceDate: string;
  companyName: string;
  customerName: string;
  currency: string;
  subtotal: number;
  tax: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  status: string;
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'verified'; data: VerificationData }
  | { kind: 'void'; data: VerificationData }
  | { kind: 'invalid' };

const fmt = (currency: string, n: number) =>
  `${currency} ${(Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

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
 * Public invoice verification page — no login required.
 * Route: /verify/invoice/:invoiceNumber?t=<token>
 */
export const InvoiceVerify: React.FC = () => {
  const { invoiceNumber } = useParams<{ invoiceNumber: string }>();
  const [search] = useSearchParams();
  const token = search.get('t') || '';
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState({ kind: 'loading' });
      if (!invoiceNumber || !token) {
        setState({ kind: 'invalid' });
        return;
      }
      try {
        const res = await fetch(
          `${API_BASE_URL}/public/invoices/verify/${encodeURIComponent(invoiceNumber)}?t=${encodeURIComponent(token)}`
        );
        if (!res.ok) {
          if (!cancelled) setState({ kind: 'invalid' });
          return;
        }
        const data = (await res.json()) as VerificationData;
        if (!cancelled) {
          setState(data.status === 'VOID' ? { kind: 'void', data } : { kind: 'verified', data });
        }
      } catch {
        if (!cancelled) setState({ kind: 'invalid' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [invoiceNumber, token]);

  const head = (title: string, sub: string) => (
    <div style={{ textAlign: 'center', marginBottom: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 2, color: '#1F5F53' }}>PRIME PRINTING</div>
      <h1 style={{ fontSize: 22, margin: '8px 0 4px' }}>{title}</h1>
      <p style={{ fontSize: 13, color: '#726F63', margin: 0 }}>{sub}</p>
    </div>
  );

  if (state.kind === 'loading') {
    return (
      <div style={{ minHeight: '100vh', background: '#EDE9DD', padding: 16 }}>
        <div style={card}>
          {head('Verifying invoice…', 'Checking Prime Printing records.')}
        </div>
      </div>
    );
  }

  if (state.kind === 'invalid') {
    return (
      <div style={{ minHeight: '100vh', background: '#EDE9DD', padding: 16 }}>
        <div style={card}>
          {head('⚠ Invoice could not be verified', 'The invoice number or verification code could not be verified against Prime Printing records.')}
          <p style={{ fontSize: 13, color: '#726F63', textAlign: 'center' }}>
            Please check the QR code or link with the business that issued the invoice.
          </p>
        </div>
      </div>
    );
  }

  const d = state.data;
  if (state.kind === 'void') {
    return (
      <div style={{ minHeight: '100vh', background: '#EDE9DD', padding: 16 }}>
        <div style={card}>
          {head('⊘ Void invoice', 'This invoice was issued by Prime Printing but has subsequently been voided.')}
          <div>
            <div style={row}><span style={label}>Invoice Number</span><span style={value}>{d.invoiceNumber}</span></div>
            <div style={{ ...row, borderBottom: 'none' }}><span style={label}>Invoice Date</span><span style={value}>{d.invoiceDate}</span></div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#EDE9DD', padding: 16 }}>
      <div style={card}>
        {head('✓ Verified invoice', 'Verified against Prime Printing records.')}
        <div>
          <div style={row}><span style={label}>Invoice Number</span><span style={value}>{d.invoiceNumber}</span></div>
          <div style={row}><span style={label}>Invoice Date</span><span style={value}>{d.invoiceDate}</span></div>
          <div style={row}><span style={label}>Customer</span><span style={value}>{d.customerName}</span></div>
          <div style={row}><span style={label}>Subtotal</span><span style={value}>{fmt(d.currency, d.subtotal)}</span></div>
          <div style={row}><span style={label}>Tax</span><span style={value}>{fmt(d.currency, d.tax)}</span></div>
          <div style={row}><span style={label}>Total</span><span style={value}>{fmt(d.currency, d.total)}</span></div>
          <div style={row}><span style={label}>Amount Paid</span><span style={value}>{fmt(d.currency, d.amountPaid)}</span></div>
          <div style={row}><span style={label}>Balance Due</span><span style={value}>{fmt(d.currency, d.balanceDue)}</span></div>
          <div style={{ ...row, borderBottom: 'none' }}><span style={label}>Status</span><span style={value}>{d.status}</span></div>
        </div>
        <p style={{ fontSize: 12, color: '#726F63', textAlign: 'center', marginTop: 16 }}>
          Verified against Prime Printing records. <Link to="/portal/login">Customer portal sign-in</Link>
        </p>
      </div>
    </div>
  );
};

export default InvoiceVerify;

import React, { useState } from 'react';
import { X, Phone, MapPin, KeyRound, RefreshCw, Copy, Check, Globe, Loader2, Wallet, ReceiptText } from 'lucide-react';
import { Customer } from '../../../types';
import { adminLifecycle, type PortalCredentials } from '../../../services/adminPortalClient';
import { getCustomerDisplayName, getCustomerContactName } from '../../../utils/customerDisplay';

interface CustomerCardProps {
  customer: Customer;
  balance?: number;
  onClose: () => void;
  onViewProfile?: (customer: Customer) => void;
  onEdit?: (customer: Customer) => void;
  onCreateInvoice?: (customer: Customer) => void;
  onCreateQuote?: (customer: Customer) => void;
  onStatement?: (customer: Customer) => void;
  onWhatsApp?: (customer: Customer) => void;
  onPortalUpdate?: (customer: Customer) => void;
}

const teal: Record<string, string> = { 50: '#eef7f6', 100: '#d3ece9', 200: '#a6d9d3', 300: '#72c0b7', 400: '#3fa294', 500: '#1f8577', 600: '#146b60', 700: '#0f544c', 800: '#0b3e39', 900: '#082e2a' };
const amber: Record<string, string> = { 100: '#fbead0', 300: '#eec27a', 500: '#d99a3f', 600: '#b97e2b' };
const paper = '#FEFDFB';
const ink = '#23282A';
const inkSoft = '#5c6567';
const hairline = '#e4ddd1';
const danger = '#b5493f';

export const CustomerCard: React.FC<CustomerCardProps> = ({
  customer, balance, onClose, onViewProfile, onEdit,
  onCreateInvoice, onCreateQuote, onStatement, onWhatsApp, onPortalUpdate,
}) => {
  const [portalCreds, setPortalCreds] = useState<PortalCredentials | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<'email' | 'password' | null>(null);

  const copyCredential = async (field: 'email' | 'password') => {
    if (!portalCreds) return;
    try {
      await navigator.clipboard.writeText(portalCreds[field]);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const applyPortalAccount = (account: { id: string; email: string; status?: string }, creds: PortalCredentials | null) => {
    if (creds) setPortalCreds(creds);
    onPortalUpdate?.({
      ...customer,
      portalUserId: account.id,
      portalEmail: account.email,
      portalStatus: account.status || 'active',
    });
  };

  const handleCreatePortal = async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError(null);
    try {
        const result = await adminLifecycle.users.autoCreate({
          customer_id: customer.id,
          name: customerDisplayName,
          email: customer.email,
          phone: customer.phone,
        });
      if (result?.user) {
        applyPortalAccount(
          { id: result.user.id, email: result.user.email, status: result.user.status },
          result.generated_password
            ? { email: result.user.email, password: result.generated_password }
            : null
        );
      }
    } catch (err: any) {
      setPortalError(err?.body?.error || err?.message || 'Failed to create portal account');
    } finally {
      setPortalBusy(false);
    }
  };

  const handleRegeneratePassword = async () => {
    if (portalBusy || !customer.portalUserId) return;
    setPortalBusy(true);
    setPortalError(null);
    try {
      const result = await adminLifecycle.users.regeneratePassword(customer.portalUserId as string, {
        customer_id: customer.id,
        name: customerDisplayName,
        email: customer.email,
        phone: customer.phone,
      });
      if (result.user_id && result.user_id !== customer.portalUserId) {
        applyPortalAccount(
          { id: result.user_id, email: customer.portalEmail || '', status: customer.portalStatus },
          { email: customer.portalEmail || '', password: result.generated_password }
        );
      } else {
        setPortalCreds({ email: customer.portalEmail || '', password: result.generated_password });
      }
    } catch (err: any) {
      setPortalError(err?.body?.error || err?.message || 'Failed to regenerate password');
    } finally {
      setPortalBusy(false);
    }
  };

  const portalActive = Boolean(customer.portalUserId) && customer.portalStatus !== 'disabled';

  const customerDisplayName = getCustomerDisplayName({ businessName: customer.businessName, companyName: customer.companyName, legacyCustomerName: customer.name });
  const customerContactName = getCustomerContactName({ contactName: customer.contactName });
  const outstanding = (balance ?? Number(customer.balance || 0)) || 0;
  const wallet = Number(customer.walletBalance || 0);
  const owing = outstanding > 0.5;
  const initials = ((customerDisplayName || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w.charAt(0)?.toUpperCase()).join('')) || '?';

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(15, 23, 42, 0.55)',
      backdropFilter: 'blur(3px)',
      padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
    }} onClick={onClose}>
      <div style={{
        width: 520, maxWidth: '100%',
        background: paper, borderRadius: 20,
        boxShadow: '0 32px 80px -20px rgba(15, 23, 42, .35), 0 4px 16px -4px rgba(15, 23, 42, .08)',
        border: `1px solid ${hairline}`,
        overflow: 'hidden', position: 'relative'
      }} onClick={(e) => e.stopPropagation()}>

        {/* Hero header */}
        <div style={{ background: `linear-gradient(135deg, ${teal[800]} 0%, ${teal[600]} 100%)`, padding: '14px 16px 12px', position: 'relative' }}>
          <button onClick={onClose}
            style={{ position: 'absolute', top: 16, right: 16, width: 30, height: 30, borderRadius: 9, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', cursor: 'pointer', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all .15s' }}
            onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.25)'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.12)'; }}>
            <X size={14} />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 54, height: 54, borderRadius: 14,
              background: 'rgba(255,255,255,0.15)',
              border: '2px solid rgba(255,255,255,0.3)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0, fontSize: 18, fontWeight: 700, color: '#fff', letterSpacing: -0.5,
              boxShadow: '0 4px 12px -3px rgba(0,0,0,.25)'
            }}>
              {initials}
            </div>
            <div style={{ flex: 1, minWidth: 0, paddingRight: 40 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', lineHeight: 1.25, marginBottom: 5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customerDisplayName}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', fontFamily: "'JetBrains Mono', monospace", letterSpacing: 0.04 }}>
                  {customer.id}
                </span>
                <span style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.35)' }} />
                <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.65)', letterSpacing: 0.04 }}>
                  {customer.segment || 'Individual'}
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10, fontWeight: 600, color: '#fff', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', padding: '2px 9px', borderRadius: 20 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: portalActive ? '#4ADE80' : 'rgba(255,255,255,0.5)' }} />
                  {customer.status || 'Active'}
                </span>
              </div>
            </div>
          </div>

          {(customer.phone || customer.address) && (
            <div style={{ display: 'flex', gap: 7, marginTop: 13, flexWrap: 'wrap' }}>
              {customer.phone && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'rgba(255,255,255,0.9)', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '4px 10px' }}>
                  <Phone size={12} style={{ color: '#fff' }} />
                  <span>{customer.phone}</span>
                </div>
              )}
              {customer.address && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'rgba(255,255,255,0.9)', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '4px 10px', overflow: 'hidden', maxWidth: '100%' }}>
                  <MapPin size={12} style={{ color: '#fff', flexShrink: 0 }} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{customer.address}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Body */}
        <div style={{ padding: '12px 16px 14px' }}>
          {/* Balance + Wallet metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div style={{ padding: '10px 12px', background: owing ? '#fef2f2' : '#ecfdf5', border: `1px solid ${owing ? '#fecaca' : '#bbf7d0'}`, borderRadius: 12, position: 'relative', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: inkSoft }}>Outstanding</div>
                <ReceiptText size={15} color={owing ? danger : '#15803d'} />
              </div>
              <div style={{ fontSize: 21, fontWeight: 800, color: owing ? danger : '#15803d', fontFamily: "'JetBrains Mono', monospace", lineHeight: 1, letterSpacing: -0.5 }}>
                {owing ? outstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '0.00'}
              </div>
              <div style={{ fontSize: 9.5, color: owing ? danger : '#15803d', marginTop: 4, fontWeight: 600, letterSpacing: 0.04 }}>{owing ? 'Balance due' : 'Fully paid'}</div>
            </div>
            <div style={{ padding: '10px 12px', background: teal[50], border: `1px solid ${teal[100]}`, borderRadius: 12, position: 'relative', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: inkSoft }}>Wallet</div>
                <Wallet size={15} color={teal[700]} />
              </div>
              <div style={{ fontSize: 21, fontWeight: 800, color: teal[700], fontFamily: "'JetBrains Mono', monospace", lineHeight: 1, letterSpacing: -0.5 }}>
                {wallet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </div>
              <div style={{ fontSize: 9.5, color: teal[600], marginTop: 4, fontWeight: 600, letterSpacing: 0.04 }}>Available credit</div>
            </div>
          </div>

          {/* Sub Accounts */}
          {customer.subAccounts && customer.subAccounts.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.1, textTransform: 'uppercase', color: inkSoft, marginBottom: 8 }}>
                Sub Accounts · {customer.subAccounts.length}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {customer.subAccounts.map((sub: any) => (
                  <div key={sub.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 11px', background: '#fafaf8', border: `1px solid ${hairline}`, borderRadius: 11 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                      <div style={{ width: 30, height: 30, borderRadius: 9, background: teal[50], border: `1px solid ${teal[100]}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: teal[700], flexShrink: 0 }}>
                        {sub.name?.charAt(0)?.toUpperCase() || '?'}
                      </div>
                      <span style={{ fontSize: 12.5, fontWeight: 600, color: ink, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sub.name}</span>
                    </div>
                    <span style={{ fontSize: 9, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: sub.status === 'Active' ? '#ecfdf5' : hairline, color: sub.status === 'Active' ? '#15803d' : inkSoft, textTransform: 'uppercase', letterSpacing: 0.04 }}>
                      {sub.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Customer Portal */}
          <div style={{ marginBottom: 10, padding: 11, border: `1px solid ${hairline}`, borderRadius: 12, background: '#fff' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.1, textTransform: 'uppercase', color: inkSoft }}>
                Customer Portal
              </div>
              {portalActive ? (
                <button onClick={handleRegeneratePassword} disabled={portalBusy}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 600, padding: '4px 10px', borderRadius: 8, cursor: 'pointer', background: teal[50], border: `1px solid ${teal[100]}`, color: teal[700], transition: 'all .15s', opacity: portalBusy ? 0.6 : 1 }}>
                  {portalBusy ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                  Rotate Password
                </button>
              ) : null}
            </div>

            {portalActive ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: '#f0fdf4', border: `1px solid #bbf7d0`, borderRadius: 11 }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: '#15803d', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <KeyRound size={15} color="#fff" />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 9.5, fontWeight: 700, color: '#fff', background: '#15803d', textTransform: 'uppercase', letterSpacing: 0.06, padding: '2px 8px', borderRadius: 20, marginBottom: 4 }}>Active</div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {customer.portalEmail}
                  </div>
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px', background: '#fafaf8', border: `1px dashed ${hairline}`, borderRadius: 11 }}>
                <div style={{ width: 34, height: 34, borderRadius: 10, background: paper, border: `1px solid ${hairline}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Globe size={15} color={inkSoft} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, color: ink, marginBottom: 2 }}>No portal account</div>
                  <div style={{ fontSize: 11, color: inkSoft }}>Create one so the customer can sign in to self-serve</div>
                </div>
                <button onClick={handleCreatePortal} disabled={portalBusy}
                  style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 700, padding: '8px 14px', borderRadius: 9, cursor: 'pointer', background: teal[600], border: 'none', color: '#fff', transition: 'all .15s', opacity: portalBusy ? 0.6 : 1 }}>
                  {portalBusy ? <Loader2 size={11} className="animate-spin" /> : <KeyRound size={11} />}
                  Create
                </button>
              </div>
            )}
            {portalError && (
              <p style={{ margin: '8px 0 0', fontSize: 10.5, color: danger, lineHeight: 1.5 }}>{portalError}</p>
            )}
          </div>

          {/* Quick Actions */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
            <button onClick={() => onCreateInvoice?.(customer)} title="New Invoice"
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 2px 7px', background: `linear-gradient(160deg, ${teal[600]}, ${teal[800]})`, border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 6px 14px -6px rgba(20,107,96,.5)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 10px 18px -6px rgba(20,107,96,.55)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 14px -6px rgba(20,107,96,.5)'; }}>
              <span style={{ width: 24, height: 24, borderRadius: 8, background: 'rgba(255,255,255,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              </span>
              Invoice
            </button>
            <button onClick={() => onCreateQuote?.(customer)} title="New Quote"
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 2px 7px', background: 'linear-gradient(160deg, #4f46e5, #3730a3)', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 6px 14px -6px rgba(79,70,229,.5)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 10px 18px -6px rgba(79,70,229,.55)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 14px -6px rgba(79,70,229,.5)'; }}>
              <span style={{ width: 24, height: 24, borderRadius: 8, background: 'rgba(255,255,255,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
              </span>
              Quote
            </button>
            <button onClick={() => onStatement?.(customer)} title="Statement"
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 2px 7px', background: `linear-gradient(160deg, ${amber[500]}, ${amber[600]})`, border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 6px 14px -6px rgba(217,154,63,.5)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 10px 18px -6px rgba(217,154,63,.55)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 14px -6px rgba(217,154,63,.5)'; }}>
              <span style={{ width: 24, height: 24, borderRadius: 8, background: 'rgba(255,255,255,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
              </span>
              Statement
            </button>
            <button onClick={() => onWhatsApp?.(customer)} title="WhatsApp"
              style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '8px 2px 7px', background: 'linear-gradient(160deg, #22c55e, #15803d)', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 6px 14px -6px rgba(34,197,94,.5)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-2px)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 10px 18px -6px rgba(34,197,94,.55)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 6px 14px -6px rgba(34,197,94,.5)'; }}>
              <span style={{ width: 24, height: 24, borderRadius: 8, background: 'rgba(255,255,255,0.16)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
              </span>
              Chat
            </button>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
            <button onClick={() => onViewProfile?.(customer)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px 6px', background: 'linear-gradient(135deg, #7c3aed, #6d28d9)', border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 4px 12px -4px rgba(124,58,237,.4)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              View Profile
            </button>
            <button onClick={() => onEdit?.(customer)}
              style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, padding: '11px 6px', background: `linear-gradient(135deg, ${amber[500]}, ${amber[600]})`, border: 'none', borderRadius: 10, cursor: 'pointer', fontSize: 11.5, fontWeight: 700, color: '#fff', transition: 'all .15s', boxShadow: '0 4px 12px -4px rgba(217,154,63,.45)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(-1px)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.transform = 'translateY(0)'; }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
              Edit Details
            </button>
          </div>
        </div>
      </div>

      {portalCreds && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.55)', backdropFilter: 'blur(3px)', padding: '40px 20px', fontFamily: "'Inter','DM Sans',sans-serif", fontSize: 13.5, color: ink,
        }} onClick={() => setPortalCreds(null)}>
          <div style={{
            width: '100%', maxWidth: 440, background: paper, borderRadius: 18,
            border: `1px solid ${hairline}`,
            boxShadow: '0 32px 80px -20px rgba(15, 23, 42, .35), 0 4px 16px -4px rgba(15, 23, 42, .08)',
            overflow: 'hidden', position: 'relative'
          }} onClick={(e) => e.stopPropagation()}>
            <div style={{ background: `linear-gradient(135deg, ${teal[800]} 0%, ${teal[600]} 100%)`, padding: '18px 24px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{
                  width: 42, height: 42, borderRadius: 11,
                  background: 'rgba(255,255,255,0.15)',
                  border: '1px solid rgba(255,255,255,0.25)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                }}>
                  <KeyRound size={17} color="#fff" />
                </div>
                <div>
                  <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#fff' }}>
                    {customer.portalUserId ? 'Password Updated' : 'Portal Credentials'}
                  </h3>
                  <p style={{ margin: '2px 0 0', fontSize: 11.5, color: 'rgba(255,255,255,0.75)', lineHeight: 1.4 }}>
                    {customer.portalUserId
                      ? 'A new password was generated. The old one no longer works.'
                      : 'Share with the customer. Password is shown only once.'}
                  </p>
                </div>
              </div>
            </div>
            <div style={{ padding: '14px 24px 18px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 14px', background: '#fafaf8', border: `1px solid ${hairline}`, borderRadius: 11 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: inkSoft, marginBottom: 2 }}>Portal Email</div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis' }}>{portalCreds.email}</div>
                </div>
                <button onClick={() => copyCredential('email')} title="Copy email"
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: `1px solid ${hairline}`, background: paper, color: inkSoft, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.color = teal[600]; (e.currentTarget as HTMLButtonElement).style.borderColor = teal[200]; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.color = inkSoft; (e.currentTarget as HTMLButtonElement).style.borderColor = hairline; }}>
                  {copiedField === 'email' ? <Check size={14} color={teal[600]} /> : <Copy size={14} />}
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '11px 14px', background: amber[100], border: `1px solid ${amber[300]}`, borderRadius: 11 }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.08, textTransform: 'uppercase', color: amber[600], marginBottom: 2 }}>
                    {customer.portalUserId ? 'New Password' : 'Temporary Password'}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: ink, fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis' }}>{portalCreds.password}</div>
                </div>
                <button onClick={() => copyCredential('password')} title="Copy password"
                  style={{ flexShrink: 0, width: 32, height: 32, borderRadius: 8, border: `1px solid ${amber[300]}`, background: paper, color: amber[600], cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all .15s' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = amber[100]; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = paper; }}>
                  {copiedField === 'password' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <p style={{ margin: '4px 0 0', fontSize: 10.5, color: inkSoft, lineHeight: 1.5 }}>
                The customer signs in at <b>#/portal/login</b> with the Email &amp; Password method.
              </p>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 24px', borderTop: `1px solid ${hairline}`, background: '#fafaf8' }}>
              <button onClick={() => setPortalCreds(null)}
                style={{ fontFamily: "'Inter', sans-serif", fontSize: 12.5, fontWeight: 600, padding: '8px 18px', borderRadius: 9, cursor: 'pointer', background: teal[600], border: 'none', color: '#fff', display: 'flex', alignItems: 'center', gap: 7, transition: 'all .15s' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[700]; }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = teal[600]; }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerCard;

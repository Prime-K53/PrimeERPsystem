import React, { useState, useRef, useEffect } from 'react';
import { X, MoreVertical, Loader2, Copy, Check, KeyRound, User, Pencil, ReceiptText, FileText, ScrollText, MessageCircle, Phone as PhoneIcon, Mail, LogOut } from 'lucide-react';
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

const CARD_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700&family=Space+Grotesk:wght@400;500;600;700&display=swap');

.cc-overlay{
  position:fixed; inset:0; z-index:9999;
  display:flex; align-items:center; justify-content:center;
  padding:48px 20px;
  background:rgba(28,35,33,0.45);
  backdrop-filter:blur(6px) saturate(1.1);
  -webkit-backdrop-filter:blur(6px) saturate(1.1);
  font-family:'Space Grotesk',sans-serif;
  color:#1C2321;
  animation:ccFadeIn .18s ease;
}
@keyframes ccFadeIn{from{opacity:0;} to{opacity:1;}}
.cc-card{
  width:420px; max-width:100%;
  max-height:calc(100vh - 96px);
  overflow-y:auto;
  background:#FBFAF6;
  border-radius:14px;
  overflow:hidden;
  box-shadow:0 1px 2px rgba(21,33,29,.06), 0 12px 32px -12px rgba(21,33,29,.28);
  scrollbar-width:thin;
}
.cc-card::-webkit-scrollbar{width:6px;}
.cc-card::-webkit-scrollbar-thumb{background:#DEDACB;border-radius:100px;}

/* ---------- header band ---------- */
.cc-header{
  position:relative;
  background:linear-gradient(155deg, #153F37, #1F5F53 130%);
  padding:24px 22px 20px;
  color:#F4F0E4;
  overflow:hidden;
}
.cc-header::before{
  content:"";
  position:absolute; inset:0;
  background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px);
  pointer-events:none;
}
.cc-header-top{
  position:relative;
  display:flex;
  align-items:flex-start;
  justify-content:space-between;
  gap:12px;
}
.cc-id-block{display:flex; align-items:center; gap:13px; min-width:0; flex:1;}
.cc-avatar{
  width:46px;height:46px; flex:none;
  border-radius:50%;
  background:#F4F0E4;
  color:#153F37;
  display:flex;align-items:center;justify-content:center;
  font-family:'Fraunces',serif;
  font-weight:700;
  font-size:16px;
  box-shadow:0 0 0 3px rgba(244,240,228,.22);
}
.cc-name-wrap{min-width:0; flex:1;}
.cc-name{
  font-family:'Fraunces',serif;
  font-weight:600;
  font-size:19px;
  line-height:1.22;
  margin:0 0 5px;
  letter-spacing:.1px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.cc-meta{
  font-size:12px;
  color:rgba(244,240,228,.72);
  display:flex; align-items:center; gap:7px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.cc-meta .cc-dot{opacity:.5;}
.cc-top-actions{position:relative; display:flex; align-items:center; gap:7px; flex:none;}
.cc-status-pill{
  flex:none;
  font-size:11px; font-weight:500;
  padding:5px 11px;
  border-radius:100px;
  white-space:nowrap;
  display:flex;align-items:center;gap:6px;
  background:rgba(244,240,228,.16);
  color:#F4F0E4;
  border:1px solid rgba(244,240,228,.2);
}
.cc-status-dot{
  width:6px;height:6px;border-radius:50%;
  background:#8FE3C8;
  box-shadow:0 0 0 3px rgba(143,227,200,.22);
  flex:none;
}
.cc-status-dot.off{background:rgba(244,240,228,.5); box-shadow:0 0 0 3px rgba(244,240,228,.18);}
.cc-icon-btn{
  flex:none;
  width:28px;height:28px;
  border-radius:8px;
  background:rgba(244,240,228,.16);
  border:1px solid rgba(244,240,228,.2);
  color:#F4F0E4;
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;
  transition:background .15s ease;
  padding:0;
}
.cc-icon-btn:hover{background:rgba(244,240,228,.30);}
.cc-menu-wrap{position:relative; flex:none;}
.cc-popup-menu{
  position:absolute;
  top:calc(100% + 8px);
  right:0;
  width:216px;
  background:#FBFAF6;
  border:1px solid #DEDACB;
  border-radius:12px;
  box-shadow:0 16px 40px -12px rgba(21,33,29,.32), 0 2px 8px rgba(21,33,29,.08);
  overflow:hidden;
  z-index:50;
  animation:ccPop .14s ease;
}
@keyframes ccPop{from{opacity:0; transform:translateY(-4px) scale(.98);} to{opacity:1; transform:none;}}
.cc-popup-menu button.cc-mi{
  display:flex; width:100%;
  align-items:center; gap:10px;
  padding:10px 14px;
  background:transparent;
  border:none;
  border-bottom:1px solid #E9E5D8;
  font-family:'Space Grotesk',sans-serif;
  font-size:12.5px; font-weight:500;
  color:#1C2321;
  cursor:pointer;
  text-align:left;
  transition:background .13s ease, color .13s ease;
}
.cc-popup-menu button.cc-mi:last-child{border-bottom:none;}
.cc-popup-menu button.cc-mi:hover{background:#E4EEEA; color:#1F5F53;}
.cc-popup-menu button.cc-mi.danger{color:#b5493f;}
.cc-popup-menu button.cc-mi.danger:hover{background:#FDECEA; color:#b5493f;}
.cc-popup-menu .cc-mi-hint{margin-left:auto; font-size:10.5px; color:#726F63;}
.cc-popup-menu .cc-sep{height:1px; background:#E9E5D8;}

.cc-contact-row{
  position:relative;
  display:flex; gap:20px;
  margin-top:18px;
  flex-wrap:wrap;
}
.cc-contact-item{
  display:flex; align-items:center; gap:7px;
  font-size:12.5px;
  color:rgba(244,240,228,.9);
  background:rgba(0,0,0,.12);
  padding:6px 10px 6px 8px;
  border-radius:8px;
  cursor:pointer;
  transition:background .15s ease;
  border:none;
  font-family:inherit;
  max-width:100%;
}
.cc-contact-item:hover{background:rgba(0,0,0,.22);}
.cc-contact-item.static{cursor:default;}
.cc-contact-item.static:hover{background:rgba(0,0,0,.12);}
.cc-contact-item svg{width:13px;height:13px; flex:none; opacity:.85;}
.cc-contact-item .cc-copied{font-size:10.5px; color:#8FE3C8; display:none;}
.cc-contact-item.cc-copied-state .cc-copied{display:inline;}
.cc-contact-item.cc-copied-state .cc-val{display:none;}
.cc-contact-item .cc-val{overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}

/* ---------- body ---------- */
.cc-stats{
  display:grid;
  grid-template-columns:1fr 1fr;
  border-bottom:1px solid #E9E5D8;
}
.cc-stat{padding:18px 22px 16px; position:relative;}
.cc-stat:first-child{border-right:1px solid #E9E5D8;}
.cc-stat .cc-top{display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;}
.cc-stat .cc-label{font-size:11px; color:#726F63;}
.cc-stat .cc-icon{width:14px;height:14px; color:#726F63; opacity:.7;}
.cc-stat .cc-amount{font-family:'Fraunces',serif; font-weight:600; font-size:23px; line-height:1.1; color:#1C2321;}
.cc-stat .cc-amount .cc-code{font-family:'Space Grotesk',sans-serif; font-size:11.5px; font-weight:500; color:#726F63; margin-right:4px; vertical-align:2px;}
.cc-stat.cc-due .cc-amount{color:#C0392B;}
.cc-stat.cc-due.cc-paid .cc-amount{color:#15803D;}
.cc-stat.cc-wallet .cc-amount{color:#15803D;}
.cc-stat .cc-caption{font-size:11px; color:#726F63; margin-top:6px;}
.cc-stat.cc-due .cc-caption{color:#C0392B;}
.cc-stat.cc-due.cc-paid .cc-caption{color:#15803D;}
.cc-stat.cc-wallet .cc-caption{color:#15803D;}
.cc-bar-track{margin-top:10px; height:4px; border-radius:100px; background:#E9E5D8; overflow:hidden;}
.cc-bar-fill{height:100%; border-radius:100px;}
.cc-stat.cc-due .cc-bar-fill{background:#C0392B;}
.cc-stat.cc-due.cc-paid .cc-bar-fill{background:#15803D;}
.cc-stat.cc-wallet .cc-amount .cc-code{color:#15803D;}
.cc-stat.cc-due .cc-amount .cc-code{color:#C0392B;}
.cc-stat.cc-due.cc-paid .cc-amount .cc-code{color:#15803D;}
.cc-stat.cc-wallet .cc-bar-fill{background:#15803D;}

/* ---------- sub accounts ---------- */
.cc-sub{padding:15px 22px; border-bottom:1px solid #E9E5D8;}
.cc-sub-title{font-size:11px; color:#726F63; margin-bottom:10px; letter-spacing:.02px;}
.cc-sub-row{
  display:flex; align-items:center; justify-content:space-between;
  padding:8px 11px; background:#F4F0E4;
  border:1px solid #E9E5D8; border-radius:9px;
  margin-bottom:6px;
}
.cc-sub-row:last-child{margin-bottom:0;}
.cc-sub-left{display:flex; align-items:center; gap:9px; min-width:0;}
.cc-sub-av{
  width:28px;height:28px; border-radius:50%;
  background:#E4EEEA; color:#1F5F53;
  display:flex;align-items:center;justify-content:center;
  font-family:'Fraunces',serif; font-weight:700; font-size:12px; flex:none;
}
.cc-sub-name{font-size:12.5px; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.cc-sub-pill{font-size:10px; font-weight:500; padding:4px 10px; border-radius:100px; background:#E4EEEA; color:#1F5F53; border:1px solid transparent; flex:none;}
.cc-sub-pill.off{background:#E9E5D8; color:#726F63;}

/* ---------- portal ---------- */
.cc-portal{
  display:flex; align-items:center; justify-content:space-between;
  padding:15px 22px; gap:12px;
  border-bottom:1px solid #E9E5D8;
}
.cc-portal .cc-who{display:flex;flex-direction:column;gap:3px;min-width:0; flex:1;}
.cc-portal .cc-who .cc-title{font-size:12.5px; font-weight:500; display:flex; align-items:center; gap:7px; flex-wrap:wrap;}
.cc-portal .cc-who .cc-email{font-size:12px; color:#726F63; overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.cc-portal .cc-status-pill{background:#E4EEEA;color:#1F5F53; border:1px solid transparent;}
.cc-portal .cc-status-pill .cc-status-dot{background:#1F5F53; box-shadow:0 0 0 3px rgba(31,95,83,.14);}
.cc-portal .cc-status-pill.off{background:#E9E5D8; color:#726F63;}
.cc-portal .cc-status-pill.off .cc-status-dot{background:#726F63; box-shadow:0 0 0 3px rgba(114,111,99,.16);}
.cc-rotate-btn{
  font-size:12px; font-weight:500; font-family:inherit;
  color:#1C2321; background:transparent;
  border:1px solid #DEDACB; border-radius:7px;
  padding:7px 11px; cursor:pointer;
  display:flex; align-items:center; gap:6px; flex:none;
  transition:border-color .15s ease, background .15s ease;
  white-space:nowrap;
}
.cc-rotate-btn svg{width:12px;height:12px;}
.cc-rotate-btn:hover:not(:disabled){border-color:#1C2321; background:#F4F0E4;}
.cc-rotate-btn:disabled{opacity:.6; cursor:default;}
.cc-spin{animation:ccSpin 1s linear infinite;}
@keyframes ccSpin{to{transform:rotate(360deg);}}
.cc-portal-err{padding:0 22px 12px; font-size:11px; color:#b5493f; line-height:1.5; margin:0;}

/* ---------- quick actions ---------- */
.cc-quick-actions{display:grid; grid-template-columns:repeat(4,1fr);}
.cc-quick-actions button{
  background:#FBFAF6;
  border:none; border-right:1px solid #E9E5D8;
  padding:14px 4px 13px;
  font-family:inherit; font-size:11.5px; font-weight:500; color:#1C2321;
  cursor:pointer;
  display:flex;flex-direction:column;align-items:center;gap:7px;
  transition:background .15s ease, color .15s ease;
}
.cc-quick-actions button:last-child{border-right:none;}
.cc-quick-actions button:hover{background:#E4EEEA; color:#1F5F53;}
.cc-quick-actions svg{width:16px;height:16px;}

/* ---------- footer ---------- */
.cc-footer{
  display:grid; grid-template-columns:1fr 1.2fr;
  gap:10px; padding:18px 22px 22px;
  border-top:1px solid #E9E5D8;
}
.cc-footer button{
  font-family:inherit; font-size:13px; font-weight:500;
  padding:11px; border-radius:9px; cursor:pointer;
  transition:transform .12s ease, background .15s ease, border-color .15s ease;
}
.cc-footer button:active{transform:scale(.98);}
.cc-btn-primary{background:#1C2321; color:#F4F0E4; border:1px solid #1C2321;}
.cc-btn-primary:hover{background:#000;}
.cc-btn-secondary{background:transparent; color:#1C2321; border:1px solid #DEDACB;}
.cc-btn-secondary:hover{border-color:#1C2321; background:#F4F0E4;}

/* ---------- credentials modal ---------- */
.cc-creds-overlay{
  position:fixed; inset:0; z-index:10000;
  display:flex; align-items:center; justify-content:center;
  background:rgba(28,35,33,0.45);
  backdrop-filter:blur(6px) saturate(1.1);
  -webkit-backdrop-filter:blur(6px) saturate(1.1);
  padding:40px 20px;
  font-family:'Space Grotesk',sans-serif;
  color:#1C2321;
}
.cc-creds-card{
  width:100%; max-width:420px;
  background:#FBFAF6; border-radius:14px;
  box-shadow:0 1px 2px rgba(21,33,29,.06), 0 12px 32px -12px rgba(21,33,29,.28);
  overflow:hidden;
}
.cc-creds-head{
  position:relative;
  background:linear-gradient(155deg, #153F37, #1F5F53 130%);
  padding:20px 22px 18px; color:#F4F0E4; overflow:hidden;
}
.cc-creds-head::before{
  content:""; position:absolute; inset:0;
  background-image:repeating-linear-gradient(115deg, rgba(255,255,255,.05) 0 2px, transparent 2px 26px);
  pointer-events:none;
}
.cc-creds-head h3{margin:0; font-family:'Fraunces',serif; font-size:17px; font-weight:600; position:relative;}
.cc-creds-head p{margin:4px 0 0; font-size:12px; color:rgba(244,240,228,.75); line-height:1.45; position:relative;}
.cc-creds-body{padding:16px 22px 18px; display:flex; flex-direction:column; gap:8px;}
.cc-cred-row{
  display:flex; align-items:center; justify-content:space-between; gap:10px;
  padding:11px 14px; background:#F4F0E4;
  border:1px solid #E9E5D8; border-radius:10px;
}
.cc-cred-row.amber{background:#FBF3E2; border-color:#EAD9B8;}
.cc-cred-label{font-size:10px; font-weight:600; letter-spacing:.06px; text-transform:uppercase; color:#726F63; margin-bottom:2px;}
.cc-cred-row.amber .cc-cred-label{color:#A8631E;}
.cc-cred-val{font-size:13px; font-weight:600; color:#1C2321; font-family:'Space Grotesk',monospace; overflow:hidden; text-overflow:ellipsis;}
.cc-copy-btn{
  flex:none; width:32px; height:32px; border-radius:8px;
  border:1px solid #DEDACB; background:#FBFAF6;
  color:#726F63; cursor:pointer;
  display:flex; align-items:center; justify-content:center;
  transition:all .15s;
}
.cc-copy-btn:hover{color:#1F5F53; border-color:#1F5F53;}
.cc-creds-hint{margin:4px 0 0; font-size:11px; color:#726F63; line-height:1.5;}
.cc-creds-foot{display:flex; justify-content:flex-end; padding:14px 22px; border-top:1px solid #E9E5D8; background:#F4F0E4;}
.cc-creds-foot button{
  font-family:inherit; font-size:12.5px; font-weight:500;
  padding:9px 20px; border-radius:9px; cursor:pointer;
  background:#1C2321; border:1px solid #1C2321; color:#F4F0E4;
}
.cc-creds-foot button:hover{background:#000;}
`;

const fmt = (n: number) =>
  (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const CustomerCard: React.FC<CustomerCardProps> = ({
  customer, balance, onClose, onViewProfile, onEdit,
  onCreateInvoice, onCreateQuote, onStatement, onWhatsApp, onPortalUpdate,
}) => {
  const [portalCreds, setPortalCreds] = useState<PortalCredentials | null>(null);
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const [copiedField, setCopiedField] = useState<'email' | 'password' | null>(null);
  const [phoneCopied, setPhoneCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const customerDisplayName = getCustomerDisplayName({ businessName: customer.businessName, companyName: customer.companyName, legacyCustomerName: customer.name });
  void getCustomerContactName({ contactName: customer.contactName });
  const outstanding = (balance ?? Number(customer.balance || customer.outstandingBalance || 0)) || 0;
  const wallet = Number(customer.walletBalance || 0);
  const owing = outstanding > 0.5;
  const currencyCode = (customer.currency as string) || 'MWK';
  const portalActive = Boolean(customer.portalUserId) && customer.portalStatus !== 'disabled';
  const portalEmail = customer.portalEmail || customer.email || '';
  const segmentLabel = customer.segment || (customer as any).customerType || 'School Account';

  const initials = ((customerDisplayName || '?').split(' ').filter(Boolean).slice(0, 2).map(w => w.charAt(0)?.toUpperCase()).join('')) || '?';

  const total = outstanding + wallet;
  const duePct = outstanding <= 0 ? 0 : total > 0 ? Math.min(100, Math.max(12, (outstanding / total) * 100)) : 88;
  const walletPct = wallet <= 0 ? (outstanding > 0 ? 4 : 0) : total > 0 ? Math.min(100, Math.max(8, (wallet / total) * 100)) : 4;

  // Close popup menu on outside click / Escape; close card on Escape
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (menuOpen) setMenuOpen(false);
        else if (!portalCreds) onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, portalCreds, onClose]);

  const copyCredential = async (field: 'email' | 'password') => {
    if (!portalCreds) return;
    try {
      await navigator.clipboard.writeText(portalCreds[field]);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const copyPhone = async () => {
    if (!customer.phone) return;
    try { await navigator.clipboard.writeText(customer.phone); } catch { /* noop */ }
    setPhoneCopied(true);
    setTimeout(() => setPhoneCopied(false), 1200);
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

  const runAndCloseMenu = (fn?: (c: Customer) => void) => () => {
    setMenuOpen(false);
    fn?.(customer);
  };

  const subAccounts: any[] = Array.isArray(customer.subAccounts) ? customer.subAccounts : [];

  return (
    <div className="cc-overlay" onClick={onClose}>
      <style>{CARD_CSS}</style>
      <div className="cc-card" onClick={(e) => e.stopPropagation()}>

        <div className="cc-header">
          <div className="cc-header-top">
            <div className="cc-id-block">
              <div className="cc-avatar">{initials}</div>
              <div className="cc-name-wrap">
                <h2 className="cc-name" title={customerDisplayName}>{customerDisplayName}</h2>
                <div className="cc-meta">
                  <span>{customer.id}</span><span className="cc-dot">·</span><span>{segmentLabel}</span>
                </div>
              </div>
            </div>
            <div className="cc-top-actions">
              <span className="cc-status-pill">
                <span className={`cc-status-dot${portalActive ? '' : ' off'}`} />
                {customer.status || 'Active'}
              </span>
              <div className="cc-menu-wrap" ref={menuRef}>
                <button
                  className="cc-icon-btn"
                  title="More actions"
                  aria-label="More actions"
                  onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v); }}
                >
                  <MoreVertical size={14} />
                </button>
                {menuOpen && (
                  <div className="cc-popup-menu" onClick={(e) => e.stopPropagation()}>
                    <button className="cc-mi" onClick={runAndCloseMenu(onViewProfile)}>
                      <User size={14} /> View profile
                    </button>
                    <button className="cc-mi" onClick={runAndCloseMenu(onEdit)}>
                      <Pencil size={14} /> Edit details
                    </button>
                    <div className="cc-sep" />
                    <button className="cc-mi" onClick={runAndCloseMenu(onCreateInvoice)}>
                      <ReceiptText size={14} /> New invoice
                    </button>
                    <button className="cc-mi" onClick={runAndCloseMenu(onCreateQuote)}>
                      <FileText size={14} /> New quote
                    </button>
                    <button className="cc-mi" onClick={runAndCloseMenu(onStatement)}>
                      <ScrollText size={14} /> Statement
                    </button>
                    <button className="cc-mi" onClick={runAndCloseMenu(onWhatsApp)}>
                      <MessageCircle size={14} /> Chat <span className="cc-mi-hint">WhatsApp</span>
                    </button>
                    <div className="cc-sep" />
                    {customer.phone && (
                      <button className="cc-mi" onClick={() => { copyPhone(); }}>
                        <PhoneIcon size={14} /> Copy phone
                      </button>
                    )}
                    {(portalEmail || customer.email) && (
                      <button
                        className="cc-mi"
                        onClick={() => {
                          const em = portalEmail || customer.email || '';
                          try { navigator.clipboard.writeText(em); } catch { /* noop */ }
                        }}
                      >
                        <Mail size={14} /> Copy email
                      </button>
                    )}
                    <button className="cc-mi danger" onClick={() => { setMenuOpen(false); onClose(); }}>
                      <LogOut size={14} /> Close card
                    </button>
                  </div>
                )}
              </div>
              <button className="cc-icon-btn" title="Close" aria-label="Close" onClick={onClose}>
                <X size={14} />
              </button>
            </div>
          </div>

          {(customer.phone || customer.address) && (
            <div className="cc-contact-row">
              {customer.phone && (
                <button
                  className={`cc-contact-item${phoneCopied ? ' cc-copied-state' : ''}`}
                  onClick={copyPhone}
                  title="Click to copy phone"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.12.86.34 1.7.65 2.5a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.58-1.22a2 2 0 0 1 2.11-.45c.8.31 1.64.53 2.5.65A2 2 0 0 1 22 16.92z" /></svg>
                  <span className="cc-val">{customer.phone}</span>
                  <span className="cc-copied">Copied</span>
                </button>
              )}
              {customer.address && (
                <div className="cc-contact-item static" title={customer.address}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 21s-7-6.1-9.3-10.2A5.5 5.5 0 0 1 12 4.6a5.5 5.5 0 0 1 9.3 6.2C19 14.9 12 21 12 21z" /></svg>
                  <span className="cc-val">{customer.address}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="cc-stats">
          <div className={`cc-stat cc-due${owing ? '' : ' cc-paid'}`}>
            <div className="cc-top">
              <span className="cc-label">Outstanding</span>
              <svg className="cc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 8v8M9 12h6" /><circle cx="12" cy="12" r="9" /></svg>
            </div>
            <div className="cc-amount"><span className="cc-code">{currencyCode}</span>{fmt(outstanding)}</div>
            <div className="cc-caption">{owing ? 'Balance due' : 'Fully paid'}</div>
            <div className="cc-bar-track"><div className="cc-bar-fill" style={{ width: `${duePct}%` }} /></div>
          </div>
          <div className="cc-stat cc-wallet">
            <div className="cc-top">
              <span className="cc-label">Wallet</span>
              <svg className="cc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M17 15h.01" /></svg>
            </div>
            <div className="cc-amount"><span className="cc-code">{currencyCode}</span>{fmt(wallet)}</div>
            <div className="cc-caption">Available credit</div>
            <div className="cc-bar-track"><div className="cc-bar-fill" style={{ width: `${walletPct}%` }} /></div>
          </div>
        </div>

        {subAccounts.length > 0 && (
          <div className="cc-sub">
            <div className="cc-sub-title">Sub Accounts · {subAccounts.length}</div>
            {subAccounts.map((sub: any) => {
              const nm = typeof sub === 'string' ? sub : (sub?.name || 'Sub account');
              const st = typeof sub === 'string' ? 'Active' : (sub?.status || 'Active');
              const key = typeof sub === 'string' ? sub : (sub?.id || nm);
              return (
                <div key={key} className="cc-sub-row">
                  <div className="cc-sub-left">
                    <div className="cc-sub-av">{(nm?.charAt(0)?.toUpperCase()) || '?'}</div>
                    <span className="cc-sub-name">{nm}</span>
                  </div>
                  <span className={`cc-sub-pill${st === 'Active' ? '' : ' off'}`}>{st}</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="cc-portal">
          <div className="cc-who">
            <div className="cc-title">
              Customer Portal
              <span className={`cc-status-pill${portalActive ? '' : ' off'}`}>
                <span className="cc-status-dot" />
                {portalActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="cc-email" title={portalActive ? portalEmail : undefined}>
              {portalActive ? portalEmail : 'No portal account yet'}
            </div>
          </div>
          {portalActive ? (
            <button className="cc-rotate-btn" onClick={handleRegeneratePassword} disabled={portalBusy}>
              {portalBusy
                ? <Loader2 size={12} className="cc-spin" />
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>}
              Rotate password
            </button>
          ) : (
            <button className="cc-rotate-btn" onClick={handleCreatePortal} disabled={portalBusy}>
              {portalBusy
                ? <Loader2 size={12} className="cc-spin" />
                : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>}
              Create account
            </button>
          )}
        </div>
        {portalError && <p className="cc-portal-err">{portalError}</p>}

        <div className="cc-quick-actions">
          <button onClick={() => onCreateInvoice?.(customer)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /><path d="M9 13h6M9 17h6" /></svg>
            Invoice
          </button>
          <button onClick={() => onCreateQuote?.(customer)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M6 2h9l5 5v15H6z" /><path d="M15 2v5h5" /><path d="M9 12h6M9 16h4" /></svg>
            Quote
          </button>
          <button onClick={() => onStatement?.(customer)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="4" y="3" width="16" height="18" rx="1" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>
            Statement
          </button>
          <button onClick={() => onWhatsApp?.(customer)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="M21 11.5a8.38 8.38 0 0 1-8.5 8.5 8.5 8.5 0 0 1-4-1L3 20l1-4.5A8.38 8.38 0 0 1 11.5 3 8.5 8.5 0 0 1 21 11.5z" /></svg>
            Chat
          </button>
        </div>

        <div className="cc-footer">
          <button className="cc-btn-secondary" onClick={() => onEdit?.(customer)}>Edit details</button>
          <button className="cc-btn-primary" onClick={() => onViewProfile?.(customer)}>View profile</button>
        </div>

      </div>

      {portalCreds && (
        <div className="cc-creds-overlay" onClick={() => setPortalCreds(null)}>
          <div className="cc-creds-card" onClick={(e) => e.stopPropagation()}>
            <div className="cc-creds-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'relative' }}>
                <div style={{
                  width: 42, height: 42, borderRadius: '50%',
                  background: '#F4F0E4', display: 'flex',
                  alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                }}>
                  <KeyRound size={17} color="#153F37" />
                </div>
                <div>
                  <h3>{customer.portalUserId ? 'Password Updated' : 'Portal Credentials'}</h3>
                  <p>
                    {customer.portalUserId
                      ? 'A new password was generated. The old one no longer works.'
                      : 'Share with the customer. Password is shown only once.'}
                  </p>
                </div>
              </div>
            </div>
            <div className="cc-creds-body">
              <div className="cc-cred-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cc-cred-label">Portal Email</div>
                  <div className="cc-cred-val">{portalCreds.email}</div>
                </div>
                <button className="cc-copy-btn" onClick={() => copyCredential('email')} title="Copy email">
                  {copiedField === 'email' ? <Check size={14} color="#1F5F53" /> : <Copy size={14} />}
                </button>
              </div>
              <div className="cc-cred-row amber">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="cc-cred-label">{customer.portalUserId ? 'New Password' : 'Temporary Password'}</div>
                  <div className="cc-cred-val">{portalCreds.password}</div>
                </div>
                <button className="cc-copy-btn" onClick={() => copyCredential('password')} title="Copy password">
                  {copiedField === 'password' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
              <p className="cc-creds-hint">
                The customer signs in at <b>#/portal/login</b> with the Email &amp; Password method.
              </p>
            </div>
            <div className="cc-creds-foot">
              <button onClick={() => setPortalCreds(null)}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CustomerCard;

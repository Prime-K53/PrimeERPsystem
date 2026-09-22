import React from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, BarChart3, FileText, KeyRound, Globe, Lock, Building2 } from 'lucide-react';

type Props = {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  variant?: 'default' | 'split-card';
  showBrand?: boolean;
  brandName?: React.ReactNode;
  brandTagline?: string;
  backLink?: { to: string; label: string; external?: boolean };
  wide?: boolean;
  formPanelClassName?: string;
};

const ERP_FEATURES = [
  { icon: FileText, label: 'Finance & Ledger', desc: 'Live balances, invoices and billing in one place.' },
  { icon: BarChart3, label: 'Sales & Inventory', desc: 'Stock, orders and dispatch updates as they happen.' },
  { icon: ShieldCheck, label: 'Secure by design', desc: 'Role-based access reviewed by your admin team.' },
];

const PORTAL_FEATURES = [
  { icon: FileText, label: 'Invoices & Billing', desc: 'Live balances straight from the ERP ledger.' },
  { icon: Globe, label: 'Order Tracking', desc: 'Real-time dispatch updates as they happen.' },
  { icon: KeyRound, label: 'Secure Payments', desc: 'Bank transfers verified by our finance team.' },
];

const SplitCardLayout: React.FC<Props> = ({ children, title, subtitle, showBrand = true, brandName, brandTagline, backLink, wide = false, formPanelClassName = 'bg-[#FDFDFF]' }) => {
  return (
    <div className="h-[100dvh] h-screen bg-[#101828] font-sans flex items-stretch lg:items-center justify-center p-3 sm:p-6 lg:p-10 relative overflow-hidden auth-split">
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 bg-[#101828]" />
        <div className="absolute -top-40 -right-40 w-[640px] h-[640px] rounded-full blur-[130px] opacity-60" style={{ background: 'radial-gradient(circle, rgba(37,99,235,.28), transparent 65%)' }} />
        <div className="absolute -bottom-48 -left-40 w-[560px] h-[560px] rounded-full blur-[130px] opacity-50" style={{ background: 'radial-gradient(circle, rgba(20,60,160,.35), transparent 65%)' }} />
        <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: 'radial-gradient(circle, #93c5fd 1px, transparent 1px)', backgroundSize: '28px 28px' }} />
      </div>
      <div className={`relative z-10 w-full ${wide ? 'max-w-[1160px]' : 'max-w-[1080px]'} h-full lg:h-auto lg:min-h-[520px] lg:max-h-[calc(100dvh-5rem)] my-0 lg:my-auto grid lg:grid-cols-2 rounded-[24px] sm:rounded-[28px] overflow-hidden shadow-[0_32px_90px_-20px_rgba(0,0,0,0.65)] border border-white/10 bg-white auth-split`}>
        <div className="relative hidden lg:flex flex-col justify-between overflow-y-auto p-12 xl:p-14 lg:min-h-0 lg:max-h-[calc(100dvh-5rem)] auth-scroll" style={{ background: 'linear-gradient(155deg, #1b3a9e 0%, #122a75 38%, #0a1c52 68%, #070f35 100%)' }}>
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
            <div className="absolute inset-0 opacity-[0.10]" style={{ backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)', backgroundSize: '22px 22px' }} />
            <div className="absolute -top-32 -right-24 w-[520px] h-[520px] rounded-full blur-[110px] opacity-60" style={{ background: 'radial-gradient(circle, rgba(96,165,250,.45), transparent 65%)' }} />
            <div className="absolute -bottom-44 -left-24 w-[480px] h-[480px] rounded-full blur-[120px] opacity-60" style={{ background: 'radial-gradient(circle, rgba(30,64,175,.55), transparent 65%)' }} />
          </div>
          <div className="relative z-10 flex items-center gap-3">
            <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white bg-white/10 border border-white/20 backdrop-blur-sm">
              <Building2 size={22} strokeWidth={2} />
            </div>
            <div className="text-white font-extrabold text-lg tracking-tight leading-none">
              {brandName ?? (<>Prime <span className="text-blue-300 font-extrabold">ERP</span></>)}
            </div>
          </div>
          <div className="relative z-10 max-w-md">
            <h2 className="text-[2.75rem] xl:text-5xl font-extrabold text-white tracking-tight leading-[1.05]">
              {title || (<>Your business,<br />in perfect sync.</>)}
            </h2>
            {subtitle && (<p className="mt-4 text-[15px] text-blue-100/75 leading-relaxed">{subtitle}</p>)}
            <div className="mt-10 flex flex-col gap-6">
              {ERP_FEATURES.map((feature) => (
                <div key={feature.label} className="flex items-start gap-4">
                  <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 bg-white/10 border border-white/20 backdrop-blur-sm">
                    <feature.icon size={19} className="text-white" />
                  </div>
                  <div className="min-w-0 pt-0.5">
                    <div className="text-[15px] font-bold text-white leading-tight">{feature.label}</div>
                    <div className="text-[13px] text-blue-100/65 mt-1 leading-snug">{feature.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="relative z-10 text-[12px] text-blue-100/50">© 2026 Prime ERP · Powered by PrimeERP</div>
        </div>
        <div className={`relative ${formPanelClassName} flex items-start justify-center p-6 sm:p-10 lg:p-12 h-full lg:h-auto lg:max-h-[calc(100dvh-5rem)] overflow-y-auto auth-scroll overscroll-contain`}>
          <div className={`w-full ${wide ? 'max-w-[480px]' : 'max-w-[420px]'} py-2 my-auto min-h-min`}>
            {showBrand && (
              <div className="flex items-center gap-3 mb-8">
                <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-600/25" style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8 100%)' }}>
                  <Lock size={20} />
                </div>
                <div>
                  <div className="font-extrabold text-[17px] tracking-tight text-slate-900 leading-none">
                    {brandName ?? (<>Prime <span className="text-blue-600">ERP</span></>)}
                  </div>
                  {brandTagline && (<div className="text-[12.5px] text-slate-500 mt-1">{brandTagline}</div>)}
                </div>
              </div>
            )}
            {children}
            {backLink && (
              <div className="mt-6 text-center">
                {backLink.external ? (
                  // Leaves this app entirely (its own deployment) — a full-page
                  // anchor keeps the SPA router out of the way.
                  <a
                    href={backLink.to}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] font-bold text-slate-500 hover:text-blue-600 transition-colors"
                    data-testid="auth-external-back-link"
                  >
                    {backLink.label}
                  </a>
                ) : (
                  <Link to={backLink.to} className="text-[13px] font-bold text-slate-500 hover:text-blue-600 transition-colors">
                    {backLink.label}
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};


const AuthLayout: React.FC<Props> = ({
  children,
  title,
  subtitle,
  variant = 'default',
  showBrand = true,
  brandName,
  brandTagline,
  backLink,
  wide = false,
  formPanelClassName,
}) => {
  if (variant === 'split-card') {
    return <SplitCardLayout
      title={title}
      subtitle={subtitle}
      showBrand={showBrand}
      brandName={brandName}
      brandTagline={brandTagline}
      backLink={backLink}
      wide={wide}
      formPanelClassName={formPanelClassName}
    >{children}</SplitCardLayout>;
  }

  return (
    <div className="min-h-[100dvh] min-h-screen bg-[#070F2E] font-sans flex flex-col lg:flex-row relative overflow-x-hidden">
      {/* ── Ambient backdrop ── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 bg-[#070F2E]" />
        <div className="absolute -top-48 -right-40 w-[640px] h-[640px] rounded-full blur-[80px] sm:blur-[140px] opacity-40 sm:opacity-60"
          style={{ background: 'radial-gradient(circle, rgba(37,99,235,.32), transparent 65%)' }} />
        <div className="absolute -bottom-52 -left-40 w-[560px] h-[560px] rounded-full blur-[80px] sm:blur-[130px] opacity-40 sm:opacity-50"
          style={{ background: 'radial-gradient(circle, rgba(217,154,63,.14), transparent 65%)' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[500px] rounded-full blur-[100px] sm:blur-[160px] opacity-30 sm:opacity-40"
          style={{ background: 'radial-gradient(ellipse, rgba(15,42,107,.65), transparent 70%)' }} />
        <div
          className="absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage: 'radial-gradient(circle, #93c5fd 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        {/* hairline top accent */}
        <div className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: 'linear-gradient(90deg, #1e3a8a, #3b82f6 35%, #d99a3f 75%, #f0b35c)' }} />
      </div>

      {/* ── Brand panel ── */}
      <div className="hidden lg:flex lg:w-[46%] xl:w-[50%] relative flex-col justify-between overflow-hidden border-r border-white/[0.07]"
          style={{ background: 'linear-gradient(160deg, #0f2a6b 0%, #0a1e4a 45%, #070F2E 100%)' }}>
          {/* panel texture */}
          <div
            className="absolute inset-0 opacity-[0.07]"
            style={{
              backgroundImage: 'radial-gradient(circle, #fff 1px, transparent 1px)',
              backgroundSize: '22px 22px',
            }}
            aria-hidden="true"
          />
          <div className="absolute -top-32 -right-24 w-[520px] h-[520px] rounded-full blur-[110px] opacity-60"
            style={{ background: 'radial-gradient(circle, rgba(59,130,246,.35), transparent 65%)' }} aria-hidden="true" />
          <div className="absolute -bottom-40 -left-24 w-[460px] h-[460px] rounded-full blur-[110px] opacity-50"
            style={{ background: 'radial-gradient(circle, rgba(217,154,63,.22), transparent 65%)' }} aria-hidden="true" />
          {/* oversized watermark */}
          <div className="absolute -bottom-10 -right-6 font-black tracking-tighter text-white/[0.04] select-none leading-none text-[11rem] xl:text-[13rem]" aria-hidden="true">
            P
          </div>

          <div className="relative z-10 p-12 xl:p-14">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-900/40 ring-1 ring-white/20"
                style={{ background: 'linear-gradient(135deg, #3b82f6, #1d4ed8 100%)' }}>
                <Building2 size={24} strokeWidth={2.25} />
              </div>
              <div>
                <div className="text-white font-extrabold text-xl tracking-tight leading-none">Prime ERP System</div>
              </div>
            </div>
          </div>

          <div className="relative z-10 px-12 xl:px-14 flex-1 flex flex-col justify-center max-w-xl">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.28em] text-blue-200/70">
              Secure workspace sign-in
            </p>
            <h2 className="mt-4 text-4xl xl:text-[2.9rem] font-extrabold text-white tracking-tight leading-[1.08]">
              {title || 'Your business,'}
              <br />
              {!title ? 'in perfect sync.' : ''}
            </h2>
            {subtitle && <p className="mt-4 text-[14.5px] text-blue-100/70 leading-relaxed max-w-md">{subtitle}</p>}

            <div className="mt-9 flex flex-col gap-4">
              {PORTAL_FEATURES.map((feature) => (
                <div
                  key={feature.label}
                  className="flex items-start gap-4 p-4 rounded-2xl bg-white/[0.08] border border-white/[0.12] backdrop-blur-sm"
                >
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 bg-white/10 border border-white/20">
                    <feature.icon size={18} className="text-white" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-white leading-tight">{feature.label}</div>
                    <div className="text-xs text-blue-100/60 mt-1 leading-snug">{feature.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="relative z-10 px-12 xl:px-14 pb-10 pt-6 flex items-center gap-2.5 text-xs text-blue-100/50">
            <span className="w-7 h-7 rounded-lg bg-white/[0.06] border border-white/10 flex items-center justify-center">
              <ShieldCheck size={14} className="text-blue-300" />
            </span>
            <span>Encrypted in transit &amp; at rest · Session auto-locks on inactivity</span>
            <span className="ml-auto inline-flex items-center gap-1">
              <Lock size={12} />
              v2.4
            </span>
          </div>
        </div>

      {/* ── Form side ── */}
      <div className="flex-1 flex items-start sm:items-center justify-center p-4 sm:p-6 lg:p-10 xl:p-14 relative z-10 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] overflow-y-auto auth-scroll">
        <div className="w-full max-w-[440px] my-auto py-4 sm:py-6">
          {children}
          <p className="mt-6 sm:mt-8 text-center text-[11px] leading-relaxed text-slate-500 px-2">
            Protected by Prime ERP Identity · <span className="text-slate-400">© 2026</span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthLayout;

import React from 'react';
import { Receipt, ShieldCheck, BarChart3, FileText, KeyRound, Globe, Lock, CheckCircle2 } from 'lucide-react';

type Props = {
  children: React.ReactNode;
  title?: string;
  subtitle?: string;
  showBrand?: boolean;
};

const FEATURES = [
  { icon: BarChart3, label: 'Financial Intelligence', desc: 'Live P&L, cash & VAT' },
  { icon: FileText, label: 'Smart Invoicing', desc: 'Quotes → orders → bills' },
  { icon: KeyRound, label: 'Role-Based Access', desc: 'Granular permissions' },
  { icon: Globe, label: 'Multi-Branch & Currency', desc: 'Built to scale' },
];

const AuthLayout: React.FC<Props> = ({ children, title, subtitle, showBrand = true }) => {
  return (
    <div className="min-h-screen bg-[#050D0C] font-sans flex relative overflow-hidden">
      {/* ── Ambient backdrop ── */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute inset-0 bg-[#050D0C]" />
        <div className="absolute -top-48 -right-40 w-[640px] h-[640px] rounded-full blur-[140px] opacity-60"
          style={{ background: 'radial-gradient(circle, rgba(31,133,119,.28), transparent 65%)' }} />
        <div className="absolute -bottom-52 -left-40 w-[560px] h-[560px] rounded-full blur-[130px] opacity-50"
          style={{ background: 'radial-gradient(circle, rgba(217,154,63,.16), transparent 65%)' }} />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[900px] h-[500px] rounded-full blur-[160px] opacity-40"
          style={{ background: 'radial-gradient(ellipse, rgba(11,62,57,.55), transparent 70%)' }} />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{
            backgroundImage: 'radial-gradient(circle, #5bbfaf 1px, transparent 1px)',
            backgroundSize: '28px 28px',
          }}
        />
        {/* hairline top accent */}
        <div className="absolute top-0 left-0 right-0 h-[3px]"
          style={{ background: 'linear-gradient(90deg, #146b60, #3fa294 35%, #d99a3f 75%, #f0b35c)' }} />
      </div>

      {showBrand && (
        <div className="hidden lg:flex lg:w-[46%] xl:w-[50%] relative flex-col justify-between overflow-hidden border-r border-white/[0.07]"
          style={{ background: 'linear-gradient(160deg, #0b3e39 0%, #062f2b 45%, #041e1b 100%)' }}>
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
            style={{ background: 'radial-gradient(circle, rgba(63,162,148,.35), transparent 65%)' }} aria-hidden="true" />
          <div className="absolute -bottom-40 -left-24 w-[460px] h-[460px] rounded-full blur-[110px] opacity-50"
            style={{ background: 'radial-gradient(circle, rgba(217,154,63,.28), transparent 65%)' }} aria-hidden="true" />
          {/* oversized watermark */}
          <div className="absolute -bottom-10 -right-6 font-black tracking-tighter text-white/[0.04] select-none leading-none text-[11rem] xl:text-[13rem]" aria-hidden="true">
            P
          </div>

          <div className="relative z-10 p-12 xl:p-14">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-amber-900/40 ring-1 ring-white/20"
                style={{ background: 'linear-gradient(135deg, #f0b35c 0%, #d99a3f 55%, #b97a1f 100%)' }}>
                <Receipt size={24} strokeWidth={2.25} />
              </div>
              <div>
                <div className="text-white font-extrabold text-xl tracking-tight leading-none">Prime ERP</div>
                <div className="mt-1.5 text-[10px] text-amber-200/90 uppercase tracking-[0.24em] font-bold">Enterprise Suite</div>
              </div>
              <span className="ml-auto hidden xl:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-400/10 border border-emerald-300/20 text-[10px] font-bold text-emerald-200 uppercase tracking-widest">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-300 animate-pulse" />
                All systems live
              </span>
            </div>
          </div>

          <div className="relative z-10 px-12 xl:px-14 flex-1 flex flex-col justify-center max-w-xl">
            <p className="text-[11px] font-extrabold uppercase tracking-[0.28em] text-teal-200/70">
              Secure workspace sign-in
            </p>
            <h2 className="mt-4 text-4xl xl:text-[2.9rem] font-extrabold text-white tracking-tight leading-[1.08]">
              {title || 'Run the whole business from one place.'}
            </h2>
            {subtitle && <p className="mt-4 text-[14.5px] text-teal-50/70 leading-relaxed max-w-md">{subtitle}</p>}

            <div className="mt-9 grid grid-cols-2 gap-3.5">
              {FEATURES.map((feature) => (
                <div
                  key={feature.label}
                  className="group flex items-start gap-3 p-4 rounded-2xl bg-white/[0.05] border border-white/[0.09] backdrop-blur-sm transition-colors hover:bg-white/[0.08] hover:border-teal-200/25"
                >
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 bg-teal-300/10 border border-teal-200/20">
                    <feature.icon size={17} className="text-amber-300" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-white leading-tight">{feature.label}</div>
                    <div className="text-xs text-teal-50/55 mt-1 leading-snug">{feature.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* proof strip */}
            <div className="mt-8 flex items-center gap-6 rounded-2xl border border-white/[0.08] bg-black/20 px-5 py-4 backdrop-blur-sm">
              {[
                { value: '99.98%', label: 'Uptime' },
                { value: '2FA + OTP', label: 'Secured' },
                { value: '24/7', label: 'Audit trail' },
              ].map((s, i) => (
                <div key={s.label} className={i > 0 ? 'pl-6 border-l border-white/10' : ''}>
                  <div className="text-white font-extrabold text-[15px] tracking-tight">{s.value}</div>
                  <div className="text-[10px] font-bold uppercase tracking-[0.16em] text-teal-100/50 mt-0.5">{s.label}</div>
                </div>
              ))}
              <div className="ml-auto hidden xl:flex items-center gap-2 text-xs text-teal-50/60">
                <CheckCircle2 size={14} className="text-emerald-300" />
                SOC2-ready controls
              </div>
            </div>
          </div>

          <div className="relative z-10 px-12 xl:px-14 pb-10 pt-6 flex items-center gap-2.5 text-xs text-teal-50/50">
            <span className="w-7 h-7 rounded-lg bg-white/[0.06] border border-white/10 flex items-center justify-center">
              <ShieldCheck size={14} className="text-emerald-300" />
            </span>
            <span>Encrypted in transit &amp; at rest · Session auto-locks on inactivity</span>
            <span className="ml-auto inline-flex items-center gap-1.5">
              <Lock size={12} />
              v2.4
            </span>
          </div>
        </div>
      )}

      {/* ── Form side ── */}
      <div className="flex-1 flex items-center justify-center p-5 sm:p-10 lg:p-14 relative z-10">
        <div className="w-full max-w-[440px] max-h-[calc(100vh-2.5rem)] overflow-y-auto custom-scrollbar">
          {showBrand && (
            <div className="lg:hidden flex items-center gap-3 mb-7">
              <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-amber-900/30 ring-1 ring-white/20"
                style={{ background: 'linear-gradient(135deg, #f0b35c, #d99a3f 60%, #b97a1f)' }}>
                <Receipt size={22} />
              </div>
              <div>
                <div className="text-slate-100 font-extrabold text-lg tracking-tight leading-none">Prime ERP</div>
                <div className="mt-1 text-[10px] text-amber-300/90 uppercase tracking-[0.2em] font-bold">Enterprise Suite</div>
              </div>
            </div>
          )}
          {children}
          <p className="mt-8 text-center text-[11px] text-slate-500">
            Protected by Prime ERP Identity · <span className="text-slate-400">© 2026</span>
          </p>
        </div>
      </div>
    </div>
  );
};

export default AuthLayout;

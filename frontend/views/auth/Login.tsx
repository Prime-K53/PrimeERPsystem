import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, KeyRound, AlertCircle, Fingerprint, Building2, Sparkles, Zap } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../../context/AuthContext';
import { loginWithApi, ApiError, StaffUserInfo } from '../../services/authApiClient';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { user: currentUser, loginWithApi: establishSession, login: legacyLogin } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaCode, setMfaCode] = useState('');

  // Already signed in — don't show the form again.
  useEffect(() => {
    if (currentUser) {
      navigate('/', { replace: true });
    }
  }, [currentUser, navigate]);

  // The button enables for any non-empty input; email *format* is validated
  // on submit so the user gets a visible message instead of a dead button.
  const canSubmit = useMemo(
    () => email.trim().length > 0 && password.length > 0 && !submitting,
    [email, password, submitting],
  );
  const canVerifyMfa = useMemo(
    () => mfaCode.trim().length === 6 && !submitting,
    [mfaCode, submitting],
  );

  const buildSessionUser = (staff: StaffUserInfo) => {
    const isAdmin =
      staff.role?.toLowerCase() === 'admin' ||
      staff.role === 'Company Admin' ||
      staff.role === 'Super Admin';
    return {
      id: staff.id,
      username: staff.username,
      fullName: staff.username?.includes('@') ? staff.username.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : staff.username,
      name: staff.username,
      email: staff.email,
      role: staff.role || 'Staff',
      status: 'Active',
      active: true,
      isSuperAdmin: isAdmin,
      securityLevel: 'Elevated',
      groupIds: isAdmin ? ['GRP-ADMIN'] : ['GRP-USER'],
      authMode: 'api',
    };
  };

  const establishApiSession = async (twoFactorCode?: string): Promise<string | null> => {
    try {
      const result = await loginWithApi({
        email: email.trim(),
        password,
        portal: 'admin',
        ...(twoFactorCode ? { two_factor_code: twoFactorCode } : {}),
      });

      if (result.requires_two_factor) {
        setMfaRequired(true);
        setMfaCode('');
        setError(null);
        return null;
      }

      const staff = result.user as StaffUserInfo;
      const token = result.token || '';
      const tokenExpiry = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      establishSession(buildSessionUser(staff), token, tokenExpiry, { email: email.trim(), password });
      setPassword('');
      setMfaCode('');
      navigate('/', { replace: true });
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        return err.body?.message || 'This account is not authorized to sign in here.';
      }
      if (err instanceof ApiError && err.status === 401 && (err.body?.requires_two_factor || (err.body as { requiresTwoFactor?: boolean })?.requiresTwoFactor)) {
        setMfaRequired(true);
        setMfaCode('');
        setError(null);
        return null;
      }
      if (err instanceof ApiError && (err.status === 401 || err.status === 400 || err.status === 0)) {
        return await tryLegacyLogin(email.trim(), password, twoFactorCode);
      }
      if (err instanceof TypeError) {
        return 'Cannot reach the server. Check your connection and try again.';
      }
      return await tryLegacyLogin(email.trim(), password, twoFactorCode);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mfaRequired) return;
    if (!EMAIL_PATTERN.test(email.trim())) {
      setFieldError('Enter a valid email address.');
      return;
    }
    if (!password) return;
    setFieldError(null);
    setSubmitting(true);
    setError(null);

    try {
      const message = await establishApiSession();
      if (message !== null) {
        setError(message);
        setPassword('');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canVerifyMfa) return;
    setSubmitting(true);
    setError(null);

    try {
      // The API gateway is the primary path (forwards the 2FA code); the
      // local legacy provider is the offline fallback.
      const message = await establishApiSession(mfaCode.trim());
      if (message !== null) {
        const legacyMessage = await tryLegacyLogin(email.trim(), password, mfaCode.trim());
        if (legacyMessage !== null) {
          setError(legacyMessage);
          setMfaCode('');
        }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const tryLegacyLogin = async (userName: string, userPassword: string, mfa?: string): Promise<string | null> => {
    try {
      const result = await legacyLogin(userName, userPassword, mfa);
      if (result === 'SUCCESS') {
        setPassword('');
        setMfaCode('');
        navigate('/', { replace: true });
        return null;
      }
      if (result === 'INVALID') {
        return 'Invalid credentials. Please check your email and password and try again.';
      }
      if (result === 'MFA_REQUIRED') {
        setMfaRequired(true);
        setMfaCode('');
        setError(null);
        return null;
      }
      if (result === 'EXPIRED') {
        return 'Your password has expired. Please contact an administrator to reset it.';
      }
      return 'Your session could not be established. Please sign in again.';
    } catch (legacyErr) {
      const legacyError = legacyErr as { userMessage?: string; message?: string };
      return legacyError.userMessage || legacyError.message || 'Login failed. Please try again.';
    }
  };

  const inputClass =
    'w-full h-[48px] sm:h-12 pl-11 pr-4 bg-[#0f1e3a]/70 border border-white/[0.12] rounded-xl text-[16px] sm:text-sm text-white placeholder:text-slate-500 outline-none transition-all duration-200 hover:border-white/20 hover:bg-[#142a4d]/80 focus:border-blue-400 focus:bg-[#13244e] focus:ring-4 focus:ring-blue-500/20 focus:placeholder:text-slate-400 disabled:opacity-60 backdrop-blur-sm caret-blue-300 selection:bg-blue-500/30 selection:text-white touch-manipulation';
  const errorId = 'login-error';
  const emailErrorId = 'login-email-error';

  return (
    <AuthLayout title="Command your operations with confidence." subtitle="Sign in with your administrator credentials to access live finance, inventory, sales and production." showBrand>
      {/* fix autofill/highlight — keeps dark bg + white text when Chrome yellow autofill or selection */}
      <style>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        input:-webkit-autofill:active {
          -webkit-text-fill-color: #ffffff !important;
          -webkit-box-shadow: 0 0 0px 1000px #13244e inset !important;
          box-shadow: 0 0 0px 1000px #13244e inset !important;
          transition: background-color 5000s ease-in-out 0s !important;
          caret-color: #ffffff;
        }
        input::selection {
          background-color: rgba(59,130,246,0.35);
          color: #ffffff;
        }
      `}</style>
      <div className="animate-slideUp">
        {/* ── Redesigned Welcome Header — bulletproof mobile ── */}
        <div className="mb-5 sm:mb-7 relative px-1 sm:px-0">
          {/* glows reduced on mobile for GPU */}
          <div className="absolute -top-8 -left-8 w-24 h-24 sm:w-32 sm:h-32 bg-blue-500/10 rounded-full blur-2xl sm:blur-3xl pointer-events-none" aria-hidden="true" />
          <div className="absolute -top-4 right-0 w-16 h-16 sm:w-20 sm:h-20 bg-indigo-500/10 rounded-full blur-xl sm:blur-2xl pointer-events-none" aria-hidden="true" />

          {/* Eyebrow — wraps on 320px, Online always visible but compact */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 pl-1 pr-3 py-1 rounded-full bg-gradient-to-r from-blue-600/20 to-indigo-600/20 border border-blue-400/20 backdrop-blur-sm shadow-[0_2px_12px_rgba(37,99,235,0.15)] max-w-full">
              <span className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-md ring-1 ring-white/15 shrink-0">
                <ShieldCheck size={12} className="text-white" strokeWidth={2.5} />
              </span>
              <span className="text-[10px] font-extrabold tracking-[0.14em] text-blue-100 uppercase truncate">Administrator Login</span>
            </span>
            <span className="inline-flex items-center gap-1.5 px-2 sm:px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-400/15 text-[10px] font-bold text-emerald-300 backdrop-blur-sm shrink-0">
              <span className="relative flex w-1.5 h-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40" />
                <span className="relative inline-flex rounded-full w-1.5 h-1.5 bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.7)]" />
              </span>
              Online
            </span>
          </div>

          {/* Heading — fluid clamp, no fixed 2.05rem that breaks 320px */}
          <div className="mt-4 sm:mt-5 relative">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="inline-flex items-center gap-1 text-[10px] sm:text-[11px] font-bold tracking-[0.18em] uppercase text-amber-300/90 shrink-0">
                <Sparkles size={11} className="text-amber-300" />
                Secure workspace
              </span>
              <span className="h-px flex-1 max-w-[60px] sm:max-w-[80px] bg-gradient-to-r from-amber-300/30 to-transparent" aria-hidden="true" />
            </div>
            <h1 className="text-[clamp(1.65rem,7vw,2.05rem)] font-black tracking-tight leading-[0.95] text-white break-words">
              Welcome{' '}
              <span className="relative inline-block">
                <span className="bg-gradient-to-r from-blue-300 via-indigo-300 to-blue-400 bg-clip-text text-transparent">back</span>
                {/* underline hidden on wrap to avoid mis-align */}
                <span className="hidden sm:block absolute -bottom-1 left-0 right-0 h-[3px] bg-gradient-to-r from-blue-500/0 via-blue-400/60 to-indigo-400/0 rounded-full blur-[0.5px]" aria-hidden="true" />
              </span>
              <span className="text-amber-300">.</span>
            </h1>
            <p className="mt-2.5 sm:mt-3 text-[13px] sm:text-[13.5px] leading-[1.6] sm:leading-[1.65] text-slate-400 max-w-full sm:max-w-[36ch]">
              {mfaRequired ? (
                <span className="flex items-start gap-2 text-left">
                  <span className="mt-0.5 w-5 h-5 rounded-full bg-amber-500/15 border border-amber-400/20 flex items-center justify-center shrink-0">
                    <Zap size={10} className="text-amber-300" />
                  </span>
                  <span className="flex-1 min-w-0">
                    Two-factor auth is on. Enter the <span className="text-slate-200 font-semibold">6-digit code</span> from your app.
                  </span>
                </span>
              ) : (
                <>
                  Enter your credentials to pick up <span className="text-slate-200 font-semibold decoration-blue-400/30 underline underline-offset-4">right where you left off</span>.
                </>
              )}
            </p>
          </div>
        </div>

          {error && (
            <div role="alert" id={errorId} className="mb-4 sm:mb-5 p-3 sm:p-3.5 bg-rose-500/10 border border-rose-400/25 rounded-2xl flex items-start gap-2.5 sm:gap-3 animate-shake break-words">
              <span className="w-8 h-8 rounded-xl bg-rose-500/15 border border-rose-400/20 flex items-center justify-center shrink-0">
                <AlertCircle size={15} className="text-rose-300" />
              </span>
              <div className="flex-1 min-w-0 pt-0.5 overflow-hidden">
                <p className="text-[11px] font-bold uppercase tracking-wider text-rose-200">Sign-in failed</p>
                <p className="mt-0.5 text-[12px] sm:text-[13px] text-rose-200/90 leading-relaxed break-words [overflow-wrap:anywhere]">{error}</p>
              </div>
            </div>
          )}

          {mfaRequired ? (
            <form onSubmit={handleMfaSubmit} className="space-y-4 sm:space-y-5" aria-describedby={error ? errorId : undefined}>
              <div>
                <label htmlFor="login-mfa-code" className="flex items-center gap-1.5 text-[12px] font-bold text-slate-200 uppercase tracking-wider mb-2">
                  <Fingerprint size={13} className="text-blue-400" />
                  Verification code <span className="text-rose-400">*</span>
                </label>
                <div className="relative group">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-300 transition-colors">
                    <KeyRound size={17} />
                  </div>
                  <input
                    id="login-mfa-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    enterKeyHint="done"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={`${inputClass} !pl-11 tracking-[0.28em] sm:tracking-[0.35em] font-mono text-center !text-[18px] sm:!text-base font-bold peer`}
                    placeholder="000000"
                    disabled={submitting}
                    autoFocus
                    required
                  />
                </div>
                {/* progress dots */}
                <div className="mt-3 flex items-center justify-center gap-1.5" aria-hidden="true">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <span
                      key={i}
                      className={`h-1.5 rounded-full transition-all duration-200 ${i < mfaCode.length ? 'w-6 bg-blue-400' : 'w-1.5 bg-white/15'}`}
                    />
                  ))}
                </div>
                <p className="text-[11.5px] text-slate-500 mt-2.5 text-center">Enter the 6-digit code from your authenticator app.</p>
              </div>

              <button
                type="submit"
                disabled={!canVerifyMfa}
                className="w-full h-[48px] sm:h-12 text-white rounded-xl font-bold text-[15px] sm:text-[13.5px] flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:brightness-110 enabled:hover:shadow-[0_10px_30px_-8px_rgba(37,99,235,0.6)] touch-manipulation select-none"
                style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.95) 0%, rgba(30,58,138,0.98) 100%)', boxShadow: '0 8px 24px -8px rgba(37,99,235,0.55), inset 0 1px 0 rgba(255,255,255,0.12)' }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <>
                    <span>Verify &amp; Sign In</span>
                    <ArrowRight size={16} />
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => { setMfaRequired(false); setMfaCode(''); setError(null); }}
                disabled={submitting}
                className="w-full text-center text-xs font-semibold text-slate-500 hover:text-blue-300 transition-colors disabled:opacity-60"
              >
                ← Back to email &amp; password
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 sm:space-y-5" noValidate aria-describedby={error ? errorId : undefined}>
              <div className="space-y-3.5 sm:space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-[12px] font-bold text-slate-200 uppercase tracking-wider mb-2">
                    Email <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative group">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-300 transition-colors">
                      <Mail size={17} />
                    </div>
                    <input
                      id="login-email"
                      type="email"
                      inputMode="email"
                      enterKeyHint="next"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (fieldError) setFieldError(null); }}
                      className={`${inputClass} peer ${fieldError ? '!border-rose-400/50 !bg-rose-500/5 focus:!border-rose-400 focus:!ring-rose-500/15' : ''}`}
                      placeholder="admin@company.com"
                      autoComplete="email"
                      disabled={submitting}
                      autoFocus
                      required
                      aria-invalid={Boolean(fieldError)}
                      aria-describedby={fieldError ? emailErrorId : undefined}
                    />
                  </div>
                  {fieldError && (
                    <p id={emailErrorId} role="alert" className="mt-2 text-[12px] font-medium text-rose-300 flex items-center gap-1.5">
                      <AlertCircle size={13} />
                      {fieldError}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex flex-wrap gap-2 justify-between items-center mb-2">
                    <label htmlFor="login-password" className="block text-[12px] font-bold text-slate-200 uppercase tracking-wider">
                      Password <span className="text-rose-400">*</span>
                    </label>
                    <Link to="/forgot-password" className="text-[11px] sm:text-[12px] font-bold text-blue-300 hover:text-blue-200 transition-colors shrink-0">
                      Forgot Password?
                    </Link>
                  </div>
                  <div className="relative group">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500 group-focus-within:text-blue-300 transition-colors">
                      <Lock size={17} />
                    </div>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      enterKeyHint="done"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-12 peer`}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      disabled={submitting}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-1 sm:right-1.5 top-1/2 -translate-y-1/2 w-10 h-10 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 active:text-slate-100 hover:bg-white/10 active:bg-white/15 transition-all touch-manipulation shrink-0"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={!canSubmit}
                className="group w-full h-[48px] sm:h-12 text-white rounded-xl font-bold text-[15px] sm:text-[13.5px] flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:brightness-110 enabled:hover:shadow-[0_10px_30px_-8px_rgba(37,99,235,0.6)] touch-manipulation select-none"
                style={{ background: 'linear-gradient(135deg, rgba(37,99,235,0.95) 0%, rgba(30,58,138,0.98) 100%)', boxShadow: '0 8px 24px -8px rgba(37,99,235,0.55), inset 0 1px 0 rgba(255,255,255,0.12)' }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Signing in securely...</span>
                  </>
                ) : (
                  <>
                    <span>Sign In</span>
                    <ArrowRight size={16} className="transition-transform group-enabled:group-hover:translate-x-0.5" />
                  </>
                )}
              </button>

              <div className="flex items-center gap-3 pt-1">
                <div className="h-px flex-1 bg-white/[0.08]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500 whitespace-nowrap">New here?</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>

              <Link
                to="/register-company"
                className="w-full h-[48px] sm:h-11 rounded-xl border border-white/[0.12] bg-white/[0.05] hover:bg-white/[0.09] hover:border-amber-300/30 text-slate-200 hover:text-white font-bold text-[14px] sm:text-[13px] flex items-center justify-center gap-2 transition-all touch-manipulation"
              >
                <Building2 size={15} className="text-amber-300" />
                Create new company
              </Link>
            </form>
          )}

        {/* ── Trust footer ── */}
        <div className="mt-6 sm:mt-5 flex flex-wrap items-center justify-center gap-3 sm:gap-4 text-[11px] font-semibold text-slate-500 px-2 text-center">
          <span className="inline-flex items-center gap-1.5">
            <Lock size={11} className="text-emerald-400/80" />
            256-bit encrypted
          </span>
          <span className="w-1 h-1 rounded-full bg-white/15" />
          <Link to="/portal/login" className="hover:text-blue-300 transition-colors">
            Customer portal →
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
};

export default Login;

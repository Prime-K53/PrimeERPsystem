import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, KeyRound, AlertCircle, Fingerprint, Building2 } from 'lucide-react';
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
    'w-full h-12 pl-11 pr-4 bg-white/[0.06] border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all hover:border-white/20 hover:bg-white/[0.08] focus:border-teal-300/60 focus:bg-white/[0.09] focus:ring-4 focus:ring-teal-500/15 disabled:opacity-60';
  const errorId = 'login-error';
  const emailErrorId = 'login-email-error';

  return (
    <AuthLayout title="Command your operations with confidence." subtitle="Sign in with your administrator credentials to access live finance, inventory, sales and production." showBrand>
      <div className="animate-slideUp">
        {/* ── Heading ── */}
        <div className="mb-6">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-teal-400/10 border border-teal-300/20 text-[10px] font-extrabold text-teal-200 uppercase tracking-[0.16em]">
              <ShieldCheck size={12} />
              Administrator Login
            </span>
            <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[10px] font-bold text-slate-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Online
            </span>
          </div>
          <h1 className="mt-4 text-[1.9rem] font-extrabold text-white tracking-tight leading-[1.1]">
            Welcome back
          </h1>
          <p className="mt-2 text-[13.5px] text-slate-400 leading-relaxed">
            {mfaRequired
              ? 'Two-factor authentication is on for this account. Enter the 6-digit code from your authenticator app.'
              : 'Enter your credentials to pick up right where you left off.'}
          </p>
        </div>

        {/* ── Card ── */}
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-6 sm:p-7 shadow-[0_24px_60px_-16px_rgba(0,0,0,0.6)] relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-teal-300/40 to-transparent" aria-hidden="true" />

          {error && (
            <div role="alert" id={errorId} className="mb-5 p-3.5 bg-rose-500/10 border border-rose-400/25 rounded-2xl flex items-start gap-3 animate-shake">
              <span className="w-8 h-8 rounded-xl bg-rose-500/15 border border-rose-400/20 flex items-center justify-center shrink-0">
                <AlertCircle size={15} className="text-rose-300" />
              </span>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-[11px] font-bold uppercase tracking-wider text-rose-200">Sign-in failed</p>
                <p className="mt-0.5 text-[13px] text-rose-200/90 leading-relaxed">{error}</p>
              </div>
            </div>
          )}

          {mfaRequired ? (
            <form onSubmit={handleMfaSubmit} className="space-y-5" aria-describedby={error ? errorId : undefined}>
              <div>
                <label htmlFor="login-mfa-code" className="flex items-center gap-1.5 text-[12px] font-bold text-slate-200 uppercase tracking-wider mb-2">
                  <Fingerprint size={13} className="text-teal-300" />
                  Verification code <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <KeyRound size={17} />
                  </div>
                  <input
                    id="login-mfa-code"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={mfaCode}
                    onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    className={`${inputClass} !pl-11 tracking-[0.35em] font-mono text-center !text-base font-bold`}
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
                      className={`h-1.5 rounded-full transition-all duration-200 ${i < mfaCode.length ? 'w-6 bg-teal-300' : 'w-1.5 bg-white/15'}`}
                    />
                  ))}
                </div>
                <p className="text-[11.5px] text-slate-500 mt-2.5 text-center">Enter the 6-digit code from your authenticator app.</p>
              </div>

              <button
                type="submit"
                disabled={!canVerifyMfa}
                className="w-full h-12 text-white rounded-xl font-bold text-[13.5px] flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:brightness-110 enabled:hover:shadow-[0_10px_30px_-8px_rgba(31,133,119,0.6)]"
                style={{ background: 'linear-gradient(135deg, #1f8577 0%, #0f544c 100%)', boxShadow: '0 8px 24px -8px rgba(31,133,119,0.55)' }}
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
                className="w-full text-center text-xs font-semibold text-slate-500 hover:text-teal-200 transition-colors disabled:opacity-60"
              >
                ← Back to email &amp; password
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-describedby={error ? errorId : undefined}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-[12px] font-bold text-slate-200 uppercase tracking-wider mb-2">
                    Email <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                      <Mail size={17} />
                    </div>
                    <input
                      id="login-email"
                      type="email"
                      value={email}
                      onChange={(e) => { setEmail(e.target.value); if (fieldError) setFieldError(null); }}
                      className={inputClass}
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
                  <div className="flex justify-between items-center mb-2">
                    <label htmlFor="login-password" className="block text-[12px] font-bold text-slate-200 uppercase tracking-wider">
                      Password <span className="text-rose-400">*</span>
                    </label>
                    <Link to="/forgot-password" className="text-[12px] font-bold text-teal-300 hover:text-teal-200 transition-colors">
                      Forgot Password?
                    </Link>
                  </div>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                      <Lock size={17} />
                    </div>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-12`}
                      placeholder="Enter your password"
                      autoComplete="current-password"
                      disabled={submitting}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg flex items-center justify-center text-slate-500 hover:text-slate-200 hover:bg-white/10 transition-all"
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
                className="group w-full h-12 text-white rounded-xl font-bold text-[13.5px] flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed enabled:hover:brightness-110 enabled:hover:shadow-[0_10px_30px_-8px_rgba(31,133,119,0.6)]"
                style={{ background: 'linear-gradient(135deg, #1f8577 0%, #0f544c 100%)', boxShadow: '0 8px 24px -8px rgba(31,133,119,0.55)' }}
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
                <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">New here?</span>
                <div className="h-px flex-1 bg-white/[0.08]" />
              </div>

              <Link
                to="/register-company"
                className="w-full h-11 rounded-xl border border-white/12 bg-white/[0.05] hover:bg-white/[0.09] hover:border-amber-300/30 text-slate-200 hover:text-white font-bold text-[13px] flex items-center justify-center gap-2 transition-all"
              >
                <Building2 size={15} className="text-amber-300" />
                Create new company
              </Link>
            </form>
          )}
        </div>

        {/* ── Trust footer ── */}
        <div className="mt-5 flex items-center justify-center gap-4 text-[11px] font-semibold text-slate-500">
          <span className="inline-flex items-center gap-1.5">
            <Lock size={11} className="text-emerald-400/80" />
            256-bit encrypted
          </span>
          <span className="w-1 h-1 rounded-full bg-white/15" />
          <Link to="/portal/login" className="hover:text-teal-200 transition-colors">
            Customer portal →
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
};

export default Login;

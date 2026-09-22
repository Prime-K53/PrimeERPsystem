import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Loader2, KeyRound, AlertCircle } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../../context/AuthContext';
import { loginWithApi, ApiError, StaffUserInfo } from '../../services/authApiClient';
import { resolveCustomerPortalLoginUrl } from '../../utils/portalLinks';

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
    'w-full h-[52px] pl-[52px] pr-4 bg-slate-50 border-[1.5px] border-slate-200 rounded-2xl text-[15px] sm:text-sm font-medium text-slate-900 placeholder:text-slate-400 placeholder:font-normal outline-none transition-all duration-200 shadow-[inset_0_1px_2px_rgba(15,23,42,0.05)] hover:bg-white hover:border-slate-300 focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/15 focus:shadow-[0_8px_24px_-12px_rgba(37,99,235,0.45)] disabled:opacity-60';
  const inputIconTileClass =
    'absolute left-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl bg-white border border-slate-200 shadow-sm flex items-center justify-center text-slate-400 transition-all duration-200 group-hover:border-slate-300 group-focus-within:bg-blue-600 group-focus-within:border-blue-600 group-focus-within:text-white group-focus-within:shadow-[0_6px_16px_-6px_rgba(37,99,235,0.6)]';
  const errorId = 'login-error';
  const emailErrorId = 'login-email-error';

  return (
    <AuthLayout
      variant="split-card"
      title="Your business, in perfect sync."
      brandTagline="Smart. Simple. Business Operations."
      formPanelClassName="bg-[#e9f7ef] sm:bg-[#FDFDFF]"
      backLink={{
        to: resolveCustomerPortalLoginUrl(),
        label: 'Customer portal →',
        external: true,
      }}
    >
      <style>{`
        input:-webkit-autofill,
        input:-webkit-autofill:hover,
        input:-webkit-autofill:focus,
        input:-webkit-autofill:active {
          -webkit-text-fill-color: #0f172a !important;
          -webkit-box-shadow: 0 0 0px 1000px #f8fafc inset !important;
          box-shadow: 0 0 0px 1000px #f8fafc inset !important;
          transition: background-color 5000s ease-in-out 0s !important;
          caret-color: #0f172a;
        }
      `}</style>
      <div className="animate-slideUp">
        {/* ── Heading (matches portal card) ── */}
        <div className="mb-6 sm:mb-7">
          {/* Mobile-only eyebrow badge */}
          <span className="sm:hidden inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-50 border border-blue-100 text-[10px] font-extrabold uppercase tracking-[0.14em] text-blue-700 mb-3">
            <Lock size={11} strokeWidth={2.5} />
            Secure sign-in
          </span>
          <h1 className="text-[26px] sm:text-[30px] font-extrabold tracking-tight leading-tight bg-gradient-to-r from-[#1d4ed8] via-[#2563eb] to-[#4f46e5] bg-clip-text text-transparent sm:bg-none sm:text-slate-900">
            {mfaRequired ? 'Check your authenticator' : 'Welcome Back'}
          </h1>
          {/* Mobile-only gradient accent bar */}
          <span aria-hidden="true" className="sm:hidden block h-1 w-14 mt-2.5 rounded-full" style={{ background: 'linear-gradient(90deg, #2563eb, #4f46e5 60%, #d99a3f)' }} />
          <p className="text-[13.5px] text-slate-500 mt-2 leading-relaxed">
            {mfaRequired
              ? 'Enter the 6-digit code from your authenticator app to finish signing in.'
              : 'Sign in to manage sales, inventory, procurement and finance — synchronized live with PrimeERP.'}
          </p>
        </div>

          {error && (
            <div role="alert" id={errorId} className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 animate-shake break-words">
              <span className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
                <AlertCircle size={15} className="text-rose-500" />
              </span>
              <div className="flex-1 min-w-0 pt-0.5 overflow-hidden">
                <p className="text-[11px] font-bold uppercase tracking-wider text-rose-600">Sign-in failed</p>
                <p className="mt-0.5 text-[12.5px] text-rose-600/90 leading-relaxed break-words [overflow-wrap:anywhere]">{error}</p>
              </div>
            </div>
          )}

          {mfaRequired ? (
            <form onSubmit={handleMfaSubmit} className="space-y-5" aria-describedby={error ? errorId : undefined}>
              <div>
                <label htmlFor="login-mfa-code" className="block text-[12px] font-bold text-slate-700 uppercase tracking-wider mb-2">
                  Verification code
                </label>
                <div className="relative group">
                  <div className={inputIconTileClass}>
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
                    className={`${inputClass} !pl-[52px] tracking-[0.3em] font-mono text-center !text-[17px] font-bold`}
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
                      className={`h-1.5 rounded-full transition-all duration-200 ${i < mfaCode.length ? 'w-6 bg-blue-600' : 'w-1.5 bg-slate-200'}`}
                    />
                  ))}
                </div>
                <p className="text-[12px] text-slate-500 mt-2.5 text-center">Enter the 6-digit code from your authenticator app.</p>
              </div>

              <button
                type="submit"
                disabled={!canVerifyMfa}
                className="w-full h-12 text-white text-[15px] font-bold rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]"
                style={{ background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', boxShadow: '0 10px 24px -10px rgba(29,78,216,0.55)' }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Verifying...</span>
                  </>
                ) : (
                  <span>Verify & Sign In</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => { setMfaRequired(false); setMfaCode(''); setError(null); }}
                disabled={submitting}
                className="w-full h-11 text-[13.5px] font-bold text-slate-500 hover:text-blue-600 rounded-xl border border-slate-200 bg-white hover:border-blue-300 transition-all disabled:opacity-50"
              >
                ← Back to email &amp; password
              </button>
            </form>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-describedby={error ? errorId : undefined}>
              <div className="space-y-4">
                <div>
                  <label htmlFor="login-email" className="block text-[12px] font-bold text-slate-700 uppercase tracking-wider mb-2">
                    Email Address
                  </label>
                  <div className="relative group">
                    <div className={inputIconTileClass}>
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
                      className={`${inputClass} ${fieldError ? '!border-rose-400 !bg-rose-50/50 focus:!border-rose-500 focus:!ring-rose-500/15' : ''}`}
                      placeholder="accounts@company.mw"
                      autoComplete="email"
                      disabled={submitting}
                      autoFocus
                      required
                      aria-invalid={Boolean(fieldError)}
                      aria-describedby={fieldError ? emailErrorId : undefined}
                    />
                  </div>
                  {fieldError && (
                    <p id={emailErrorId} role="alert" className="mt-2 text-[12px] font-medium text-rose-600 flex items-center gap-1.5">
                      <AlertCircle size={13} />
                      {fieldError}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex flex-wrap gap-2 justify-between items-center mb-2">
                    <label htmlFor="login-password" className="block text-[12px] font-bold text-slate-700 uppercase tracking-wider">
                      Password
                    </label>
                    <Link to="/forgot-password" className="text-[12px] font-bold text-slate-500 hover:text-blue-600 transition-colors shrink-0">
                      Forgot your password?
                    </Link>
                  </div>
                  <div className="relative group">
                    <div className={inputIconTileClass}>
                      <Lock size={17} />
                    </div>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      enterKeyHint="done"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-12`}
                      placeholder="••••••••••"
                      autoComplete="current-password"
                      disabled={submitting}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-xl flex items-center justify-center text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-all shrink-0"
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
                className="w-full h-12 text-white text-[15px] font-bold rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]"
                style={{ background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', boxShadow: '0 10px 24px -10px rgba(29,78,216,0.55)' }}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <span>Sign In</span>
                )}
              </button>

              <Link
                to="/register-company"
                className="flex items-center gap-3.5 p-4 rounded-2xl bg-amber-50/80 border border-amber-200/70 hover:border-amber-300 hover:bg-amber-50 transition-all group"
              >
                <span className="w-10 h-10 rounded-xl bg-white border border-amber-200 flex items-center justify-center shrink-0 shadow-sm">
                  <KeyRound size={17} className="text-amber-600" />
                </span>
                <span className="min-w-0 text-left">
                  <span className="block text-[13.5px] font-bold text-slate-900 leading-tight">Set up your workspace</span>
                  <span className="block text-[12px] text-slate-500 mt-0.5">First time here? Create your company</span>
                </span>
              </Link>
            </form>
          )}

        </div>
    </AuthLayout>
  );
};

export default Login;

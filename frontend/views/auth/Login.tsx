import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Eye, EyeOff, Loader2, KeyRound, AlertCircle, Building2 } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../../context/AuthContext';
import { loginWithApi, ApiError, StaffUserInfo } from '../../services/authApiClient';
import { resolveCustomerPortalLoginUrl } from '../../utils/portalLinks';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const Login: React.FC = () => {
  const navigate = useNavigate();
  const { user: currentUser, companyConfig, loginWithApi: establishSession, login: legacyLogin } = useAuth();
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
    'w-full h-[52px] sm:h-12 pl-4 sm:pl-11 pr-4 bg-white border-[1.5px] sm:border rounded-xl sm:rounded-lg text-[15px] sm:text-sm text-slate-900 placeholder:text-slate-400 placeholder:font-normal outline-none transition-colors duration-150 hover:border-slate-300 sm:hover:border-slate-400 focus:border-green-600 focus:ring-2 focus:ring-green-600/15 sm:focus:border-blue-600 sm:focus:ring-blue-600/15 disabled:opacity-60 disabled:bg-slate-50';
  const inputIconClass =
    'absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition-colors duration-150 group-focus-within:text-blue-600 hidden sm:flex';
  const companyLogoSrc = String(companyConfig?.logoBase64 || companyConfig?.logo || '').trim() || null;
  const errorId = 'login-error';
  const emailErrorId = 'login-email-error';

  return (
    <AuthLayout
      variant="split-card"
      title="Your business, in perfect sync."
      brandTagline="Smart. Simple. Business Operations."
      showBrand={false}
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
          -webkit-box-shadow: 0 0 0px 1000px #ffffff inset !important;
          box-shadow: 0 0 0px 1000px #ffffff inset !important;
          transition: background-color 5000s ease-in-out 0s !important;
          caret-color: #0f172a;
        }
      `}</style>
      <div className="animate-slideUp">
        {/* ── Desktop brand (unchanged) ── */}
        <div className="hidden sm:flex items-center gap-3 mb-8">
          <div className="w-11 h-11 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-blue-600/25" style={{ background: 'linear-gradient(135deg, #2563eb, #1d4ed8 100%)' }}>
            <Lock size={20} />
          </div>
          <div>
            <div className="font-extrabold text-[17px] tracking-tight text-slate-900 leading-none">
              <>Prime <span className="text-blue-600">ERP</span></>
            </div>
            <div className="text-[12.5px] text-slate-500 mt-1">Smart. Simple. Business Operations.</div>
          </div>
        </div>
        {/* ── Mobile logo (reference layout) ── */}
        <div className="sm:hidden flex flex-col items-center text-center mt-2 mb-7">
          {companyLogoSrc ? (
            <img
              src={companyLogoSrc}
              alt="Company logo"
              className="h-28 w-auto max-w-[320px] object-contain mix-blend-multiply"
            />
          ) : (
            <>
              <div className="w-28 h-28 rounded-[28px] flex items-center justify-center text-white shadow-md" style={{ background: 'linear-gradient(135deg, #16a34a, #15803d 100%)' }}>
                <Building2 size={52} />
              </div>
              <div className="mt-3">
                <div className="font-extrabold text-[24px] tracking-tight leading-none text-slate-900">
                  Prime <span className="text-green-600">ERP</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-1">Smart. Simple. Business Operations.</div>
              </div>
            </>
          )}
        </div>
        {/* ── Heading (matches portal card) ── */}
        <div className="mb-6 sm:mb-7">
          <h1 className="text-[30px] font-extrabold text-slate-900 tracking-tight leading-tight">
            {mfaRequired ? 'Check your authenticator' : 'Welcome Back'}
          </h1>
          <p className="text-[13.5px] text-slate-500 mt-2 leading-relaxed">
            {mfaRequired
              ? 'Enter the 6-digit code from your authenticator app to finish signing in.'
              : (<><span className="sm:hidden">To get started, please sign in using your username and password.</span><span className="hidden sm:inline">Sign in to manage sales, inventory, procurement and finance — synchronized live with PrimeERP.</span></>)}
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
                <label htmlFor="login-mfa-code" className="block text-[13px] font-semibold text-slate-800 mb-1.5">
                  Verification code
                </label>
                <div className="relative group">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition-colors duration-150 group-focus-within:text-blue-600 flex">
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
                    className={`${inputClass} !pl-11 tracking-[0.3em] font-mono text-center !text-[17px] font-bold`}
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
                  <label htmlFor="login-email" className="block text-[13px] font-semibold text-slate-800 mb-1.5">
                    <span className="sm:hidden">Email</span><span className="hidden sm:inline">Email Address</span>
                  </label>
                  <div className="relative group">
                    <div className={inputIconClass}>
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
                      className={`${inputClass} border-green-500 sm:border-slate-300 ${fieldError ? '!border-rose-400 !bg-rose-50/50 focus:!border-rose-500 focus:!ring-rose-500/15' : ''}`}
                      placeholder="Email address"
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
                  <div className="flex flex-wrap gap-2 justify-between items-center mb-1.5">
                    <label htmlFor="login-password" className="block text-[13px] font-semibold text-slate-800">
                      Password
                    </label>
                    <Link to="/forgot-password" className="hidden sm:inline text-[13px] font-semibold text-blue-700 hover:text-blue-800 transition-colors shrink-0">
                      Forgot your password?
                    </Link>
                  </div>
                  <div className="relative group">
                    <div className={inputIconClass}>
                      <Lock size={17} />
                    </div>
                    <input
                      id="login-password"
                      type={showPassword ? 'text' : 'password'}
                      enterKeyHint="done"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} border-slate-200 sm:border-slate-300 pr-12`}
                      placeholder="Password"
                      autoComplete="current-password"
                      disabled={submitting}
                      required
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-slate-700 hover:text-slate-900 hover:bg-slate-100 transition-colors shrink-0"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                  <div className="sm:hidden flex justify-end mt-2">
                    <Link to="/forgot-password" className="text-[13px] font-semibold text-amber-500 hover:text-amber-600 transition-colors">
                      Forget Password?
                    </Link>
                  </div>
                </div>
              </div>

              <button
                type="submit"
                disabled={!canSubmit}
                className="w-full h-[52px] sm:h-12 text-white text-[15px] font-bold rounded-full sm:rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed bg-black sm:bg-[linear-gradient(135deg,#2563eb_0%,#1d4ed8_100%)] sm:shadow-[0_10px_24px_-10px_rgba(29,78,216,0.55)] sm:hover:brightness-110 sm:hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]"
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Signing in...</span>
                  </>
                ) : (
                  <><span className="sm:hidden">Log in</span><span className="hidden sm:inline">Sign In</span></>
                )}
              </button>

              {/* ── Mobile-only social + signup (reference layout, Google is a placeholder) ── */}
              <div className="sm:hidden">
                <div className="flex items-center gap-3 text-[12.5px] text-slate-400">
                  <span className="flex-1 h-px bg-slate-200" aria-hidden="true" />
                  or continue with
                  <span className="flex-1 h-px bg-slate-200" aria-hidden="true" />
                </div>
                <button
                  type="button"
                  aria-disabled="true"
                  title="Google sign-in coming soon"
                  onClick={(e) => e.preventDefault()}
                  className="mt-3 w-full h-[52px] rounded-full bg-[#eef3fb] hover:bg-[#e4edfa] text-slate-800 text-[15px] font-semibold flex items-center justify-center gap-2.5 transition-colors cursor-pointer"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
                    <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.45c-.28 1.48-1.12 2.73-2.4 3.57v2.97h3.89c2.28-2.1 3.56-5.2 3.56-8.73z" />
                    <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.89-3.02c-1.08.72-2.46 1.15-4.05 1.15-3.11 0-5.75-2.1-6.69-4.93H1.29v3.1C3.26 21.3 7.31 24 12 24z" />
                    <path fill="#FBBC05" d="M5.31 14.29c-.24-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.61H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.39l4.02-3.1z" />
                    <path fill="#EA4335" d="M12 4.75c1.76 0 3.34.61 4.58 1.8l3.44-3.44C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.61l4.02 3.1c.94-2.83 3.58-4.96 6.69-4.96z" />
                  </svg>
                  Log in with Google
                </button>
                <p className="mt-6 text-center text-[13.5px] text-slate-500">
                  Are you new user?{' '}
                  <Link to="/register-company" className="font-bold text-green-600 hover:text-green-700 transition-colors">
                    Sign up
                  </Link>
                </p>
              </div>

              <Link
                to="/register-company"
                className="hidden sm:flex items-center gap-3.5 p-4 rounded-2xl bg-amber-50/80 border border-amber-200/70 hover:border-amber-300 hover:bg-amber-50 transition-all group"
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

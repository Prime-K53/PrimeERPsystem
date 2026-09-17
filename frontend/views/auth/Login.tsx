import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ShieldCheck, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, KeyRound, AlertCircle } from 'lucide-react';
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
    'w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60';
  const errorId = 'login-error';
  const emailErrorId = 'login-email-error';

  return (
    <AuthLayout title="Administrator Login" subtitle="Sign in with your administrator credentials to access the Prime ERP dashboard." showBrand>
      <div>
        <div className="mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[11px] font-bold text-indigo-300 uppercase tracking-wider">
            <ShieldCheck size={12} />
            Administrator Login
          </span>
          <h1 className="mt-4 text-[1.65rem] font-bold text-slate-100 tracking-tight leading-snug">
            Welcome back
          </h1>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            {mfaRequired
              ? 'Two-factor authentication is enabled for this account. Enter the 6-digit code from your authenticator app.'
              : 'Enter your credentials to continue where you left off.'}
          </p>
        </div>

        {error && (
          <div role="alert" id={errorId} className="mb-5 p-3.5 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start gap-3">
            <div className="w-5 h-5 rounded-full bg-rose-500/20 flex items-center justify-center shrink-0 mt-0.5">
              <div className="w-2 h-2 rounded-full bg-rose-400" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-rose-300 leading-relaxed">{error}</p>
            </div>
          </div>
        )}

        {mfaRequired ? (
          <form onSubmit={handleMfaSubmit} className="space-y-5" aria-describedby={error ? errorId : undefined}>
            <div>
              <label htmlFor="login-mfa-code" className="block text-[13px] font-semibold text-slate-300 mb-1.5">
                Verification code <span className="text-rose-400">*</span>
              </label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                  <KeyRound size={16} />
                </div>
                <input
                  id="login-mfa-code"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={mfaCode}
                  onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className={`${inputClass} tracking-[0.25em] font-mono text-center`}
                  placeholder="000000"
                  disabled={submitting}
                  autoFocus
                  required
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">Enter the 6-digit code from your authenticator app.</p>
            </div>

            <button
              type="submit"
              disabled={!canVerifyMfa}
              className="w-full py-2.5 bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-500/30 disabled:cursor-not-allowed text-white rounded-xl font-semibold text-[13px] flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200 active:scale-[0.99]"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
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
              className="w-full text-center text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-60"
            >
              Back to email &amp; password
            </button>
          </form>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5" noValidate aria-describedby={error ? errorId : undefined}>
            <div className="space-y-4">
              <div>
                <label htmlFor="login-email" className="block text-[13px] font-semibold text-slate-300 mb-1.5">
                  Email <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <Mail size={16} />
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
                  <p id={emailErrorId} role="alert" className="mt-1.5 text-[11px] text-rose-300 flex items-center gap-1">
                    <AlertCircle size={12} />
                    {fieldError}
                  </p>
                )}
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label htmlFor="login-password" className="block text-[13px] font-semibold text-slate-300">
                    Password <span className="text-rose-400">*</span>
                  </label>
                  <Link to="/forgot-password" className="text-[11px] font-semibold text-indigo-300 hover:text-indigo-200 transition-colors">
                    Forgot Password?
                  </Link>
                </div>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <Lock size={16} />
                  </div>
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={`${inputClass} pr-11`}
                    placeholder="Enter your password"
                    autoComplete="current-password"
                    disabled={submitting}
                    required
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
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
              className="w-full py-2.5 bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-500/30 disabled:cursor-not-allowed text-white rounded-xl font-semibold text-[13px] flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200 active:scale-[0.99]"
            >
              {submitting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <span>Signing in...</span>
                </>
              ) : (
                <>
                  <span>Sign In</span>
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>
        )}
      </div>
    </AuthLayout>
  );
};

export default Login;

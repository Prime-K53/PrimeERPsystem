import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, UserRound, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../../context/AuthContext';
import { registerCompany, ApiError } from '../../services/authApiClient';

const SUPABASE_ENABLED = Boolean(
  import.meta.env.VITE_SUPABASE_URL &&
  import.meta.env.VITE_SUPABASE_ANON_KEY &&
  import.meta.env.VITE_SUPABASE_URL !== 'https://placeholder.supabase.co'
);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CreateCompany: React.FC = () => {
  const navigate = useNavigate();
  const { user: currentUser, companyConfig, completeSetup, validatePasswordStrength, signUpSupabase } = useAuth();

  const [companyName, setCompanyName] = useState('');
  const [companyEmail, setCompanyEmail] = useState('');
  const [companyPhone, setCompanyPhone] = useState('');
  const [addressLine1, setAddressLine1] = useState('');
  const [city, setCity] = useState('');
  const [country, setCountry] = useState('');
  const [currencySymbol, setCurrencySymbol] = useState('K');

  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [adminEmail, setAdminEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Already signed in — a company already exists for this session.
  useEffect(() => {
    if (currentUser) {
      navigate('/', { replace: true });
    }
  }, [currentUser, navigate]);

  const passwordValidation = useMemo(
    () => validatePasswordStrength(password),
    [password, validatePasswordStrength]
  );

  const canSubmit = useMemo(
    () =>
      companyName.trim().length >= 2 &&
      fullName.trim().length >= 2 &&
      username.trim().length >= 3 &&
      adminEmail.trim().length > 0 &&
      password.length >= 6 &&
      confirmPassword.length > 0 &&
      !submitting,
    [companyName, fullName, username, adminEmail, password, confirmPassword, submitting]
  );

  const validate = (): string | null => {
    if (companyName.trim().length < 2) return 'Company name must be at least 2 characters.';
    if (companyEmail.trim() && !EMAIL_PATTERN.test(companyEmail.trim())) {
      return 'Enter a valid company email address (or leave it blank).';
    }
    if (fullName.trim().length < 2) return 'Enter the administrator full name.';
    if (username.trim().length < 3) return 'Username must be at least 3 characters.';
    if (!EMAIL_PATTERN.test(adminEmail.trim())) return 'Enter a valid administrator email address.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    if (password !== confirmPassword) return "Passwords don't match.";
    if (!passwordValidation.valid) return passwordValidation.errors[0] || 'Password does not meet the required complexity.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      setFieldError(validationError);
      return;
    }
    setFieldError(null);
    setSubmitting(true);
    setError(null);

    const payload = {
      companyName: companyName.trim(),
      companyEmail: companyEmail.trim() || undefined,
      companyPhone: companyPhone.trim() || undefined,
      addressLine1: addressLine1.trim() || undefined,
      city: city.trim() || undefined,
      country: country.trim() || undefined,
      currencySymbol: currencySymbol.trim() || 'K',
      adminFullName: fullName.trim(),
      adminUsername: username.trim(),
      adminEmail: adminEmail.trim(),
      adminPassword: password,
    };

    try {
      // 1. Server-side workspace record (best-effort when the API is
      // reachable). A 409/400 here is authoritative — surface it and stop.
      // A network failure is non-fatal: fall through to the local/cloud
      // setup path so offline-first signup still works.
      let backendReachable = true;
      try {
        await registerCompany(payload);
      } catch (backendErr) {
        if (backendErr instanceof ApiError && (backendErr.status === 409 || backendErr.status === 400)) {
          throw new Error(backendErr.message);
        }
        if (backendErr instanceof ApiError && backendErr.status === 0) {
          backendReachable = false;
        } else if (backendErr instanceof TypeError) {
          backendReachable = false;
        } else if (backendErr instanceof Error && /failed to fetch|network|load failed/i.test(backendErr.message)) {
          backendReachable = false;
        } else if (backendErr instanceof ApiError && backendErr.status >= 500) {
          // Server error persisting the workspace record — the Supabase /
          // local path below still provisions the company, so don't block.
          backendReachable = false;
        } else {
          throw backendErr;
        }
      }
      void backendReachable;

      // 2. Cloud identity (Supabase). Creates the auth user and session that
      // completeSetup requires.
      if (SUPABASE_ENABLED) {
        const signUpResult = await signUpSupabase(adminEmail.trim(), password, {
          username: username.trim(),
          full_name: fullName.trim(),
          role: 'Admin',
          is_super_admin: true,
          group_ids: ['GRP-ADMIN'],
          company_name: companyName.trim(),
        });
        if (!signUpResult.success) {
          throw new Error(signUpResult.error || 'Cloud account creation failed.');
        }
      }

      // 3. Local workspace: company config, admin profile, seed data.
      await completeSetup(
        {
          ...companyConfig,
          companyName: companyName.trim(),
          email: (companyEmail.trim() || adminEmail.trim()) as string,
          phone: companyPhone.trim() || (companyConfig as { phone?: string }).phone || '',
          addressLine1: addressLine1.trim() || (companyConfig as { addressLine1?: string }).addressLine1 || '',
          city: city.trim() || (companyConfig as { city?: string }).city || '',
          country: country.trim() || (companyConfig as { country?: string }).country || '',
          currencySymbol: currencySymbol.trim() || 'K',
        } as typeof companyConfig,
        {
          id: '',
          username: username.trim(),
          fullName: fullName.trim(),
          name: fullName.trim(),
          email: adminEmail.trim(),
          password,
          role: 'Admin',
          status: 'Active',
          active: true,
          isSuperAdmin: true,
          mfaEnabled: false,
          groupIds: ['GRP-ADMIN'],
        } as Parameters<typeof completeSetup>[1]
      );

      // 4. Best-effort initial financial year (mirrors SetupWizard).
      try {
        const { api } = await import('../../services/api');
        const now = new Date();
        const fyId = `FY-${now.getFullYear()}`;
        await api.system.createFinancialYear({
          id: fyId,
          name: `${now.getFullYear()}/${String(now.getFullYear() + 1).slice(2)}`,
          code: `FY${now.getFullYear()}`,
          start_date: `${now.getFullYear()}-01-01`,
          end_date: `${now.getFullYear()}-12-31`,
          is_default: true,
          is_active: true,
          status: 'Active',
          is_closed: false,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // Non-fatal — the workspace is usable without it.
      }

      setPassword('');
      setConfirmPassword('');
      navigate('/', { replace: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Company registration failed. Please try again.';
      setError(message);
      setPassword('');
      setConfirmPassword('');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full pl-10 pr-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60';
  const labelClass = 'block text-[13px] font-semibold text-slate-300 mb-1.5';
  const errorId = 'create-company-error';
  const fieldErrorId = 'create-company-field-error';

  return (
    <AuthLayout title="Create your company" subtitle="Set up a new company workspace and its administrator account." showBrand>
      <div>
        <div className="mb-8">
          <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-[11px] font-bold text-indigo-300 uppercase tracking-wider">
            <Building2 size={12} />
            New Company
          </span>
          <h1 className="mt-4 text-[1.65rem] font-bold text-slate-100 tracking-tight leading-snug">
            Create new company
          </h1>
          <p className="mt-2 text-sm text-slate-400 leading-relaxed">
            Enter your company details and an administrator account to get started.
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

        {fieldError && (
          <div role="alert" id={fieldErrorId} className="mb-5 p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl flex items-start gap-3">
            <AlertCircle size={16} className="text-amber-300 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-200 leading-relaxed">{fieldError}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-7" noValidate aria-describedby={error ? errorId : undefined}>
          <section aria-label="Company details">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.15em] mb-4 flex items-center gap-2">
              <Building2 size={13} />
              Company details
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="create-company-name" className={labelClass}>
                  Company name <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <Building2 size={16} />
                  </div>
                  <input
                    id="create-company-name"
                    type="text"
                    value={companyName}
                    onChange={(e) => setCompanyName(e.target.value)}
                    className={inputClass}
                    placeholder="Acme Corporation"
                    autoComplete="organization"
                    disabled={submitting}
                    autoFocus
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-company-email" className={labelClass}>
                    Company email
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                      <Mail size={16} />
                    </div>
                    <input
                      id="create-company-email"
                      type="email"
                      value={companyEmail}
                      onChange={(e) => setCompanyEmail(e.target.value)}
                      className={inputClass}
                      placeholder="contact@company.com"
                      autoComplete="email"
                      disabled={submitting}
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="create-company-phone" className={labelClass}>
                    Phone
                  </label>
                  <input
                    id="create-company-phone"
                    type="tel"
                    value={companyPhone}
                    onChange={(e) => setCompanyPhone(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60"
                    placeholder="+265 884 528 222"
                    autoComplete="tel"
                    disabled={submitting}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="create-company-address" className={labelClass}>
                  Address
                </label>
                <input
                  id="create-company-address"
                  type="text"
                  value={addressLine1}
                  onChange={(e) => setAddressLine1(e.target.value)}
                  className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60"
                  placeholder="123 Business Way"
                  autoComplete="street-address"
                  disabled={submitting}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="create-company-city" className={labelClass}>
                    City
                  </label>
                  <input
                    id="create-company-city"
                    type="text"
                    value={city}
                    onChange={(e) => setCity(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60"
                    placeholder="Lilongwe"
                    autoComplete="address-level2"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label htmlFor="create-company-country" className={labelClass}>
                    Country
                  </label>
                  <input
                    id="create-company-country"
                    type="text"
                    value={country}
                    onChange={(e) => setCountry(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white placeholder:text-slate-500 outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60"
                    placeholder="Malawi"
                    autoComplete="country-name"
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label htmlFor="create-company-currency" className={labelClass}>
                    Currency
                  </label>
                  <select
                    id="create-company-currency"
                    value={currencySymbol}
                    onChange={(e) => setCurrencySymbol(e.target.value)}
                    className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl text-sm text-white outline-none transition-all focus:border-indigo-400/60 focus:ring-2 focus:ring-indigo-500/30 disabled:opacity-60 [&>option]:text-slate-900"
                    disabled={submitting}
                  >
                    <option value="K">K - Kwacha</option>
                    <option value="MWK">MWK - Malawi</option>
                    <option value="$">$ - US Dollar</option>
                    <option value="£">£ - Pound</option>
                    <option value="€">€ - Euro</option>
                  </select>
                </div>
              </div>
            </div>
          </section>

          <section aria-label="Administrator account">
            <h2 className="text-[11px] font-bold text-slate-400 uppercase tracking-[0.15em] mb-4 flex items-center gap-2">
              <UserRound size={13} />
              Administrator account
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="create-company-fullname" className={labelClass}>
                  Full name <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <UserRound size={16} />
                  </div>
                  <input
                    id="create-company-fullname"
                    type="text"
                    value={fullName}
                    onChange={(e) => setFullName(e.target.value)}
                    className={inputClass}
                    placeholder="John Doe"
                    autoComplete="name"
                    disabled={submitting}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="create-company-username" className={labelClass}>
                  Username <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <UserRound size={16} />
                  </div>
                  <input
                    id="create-company-username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className={inputClass}
                    placeholder="admin_prime"
                    autoComplete="username"
                    disabled={submitting}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="create-company-admin-email" className={labelClass}>
                  Email <span className="text-rose-400">*</span>
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                    <Mail size={16} />
                  </div>
                  <input
                    id="create-company-admin-email"
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    className={inputClass}
                    placeholder="admin@company.com"
                    autoComplete="email"
                    disabled={submitting}
                    required
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="create-company-password" className={labelClass}>
                    Password <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                      <Lock size={16} />
                    </div>
                    <input
                      id="create-company-password"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={`${inputClass} pr-11`}
                      placeholder="Minimum 6 characters"
                      autoComplete="new-password"
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
                <div>
                  <label htmlFor="create-company-confirm-password" className={labelClass}>
                    Confirm password <span className="text-rose-400">*</span>
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-500">
                      <Lock size={16} />
                    </div>
                    <input
                      id="create-company-confirm-password"
                      type={showPassword ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className={inputClass}
                      placeholder="Repeat password"
                      autoComplete="new-password"
                      disabled={submitting}
                      required
                    />
                  </div>
                </div>
              </div>

              {password && !passwordValidation.valid && (
                <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
                  <AlertCircle size={12} />
                  {passwordValidation.errors[0] || 'Basic password strength'}
                </p>
              )}
            </div>
          </section>

          <button
            type="submit"
            disabled={!canSubmit}
            className="w-full py-2.5 bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-500/30 disabled:cursor-not-allowed text-white rounded-xl font-semibold text-[13px] flex items-center justify-center gap-2 shadow-sm hover:shadow-md transition-all duration-200 active:scale-[0.99]"
          >
            {submitting ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Creating company...</span>
              </>
            ) : (
              <>
                <CheckCircle2 size={16} />
                <span>Create Company &amp; Continue</span>
                <ArrowRight size={16} />
              </>
            )}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-white/10 text-center">
          <Link
            to="/login"
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-slate-200 transition-colors"
          >
            <ArrowLeft size={13} />
            Back to sign in
          </Link>
        </div>
      </div>
    </AuthLayout>
  );
};

export default CreateCompany;

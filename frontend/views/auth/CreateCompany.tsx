import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, UserRound, Mail, Lock, Eye, EyeOff, Loader2, AlertCircle } from 'lucide-react';
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

  const [wizardStep, setWizardStep] = useState<0 | 1 | 2>(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Already signed in — a company already exists for this session.
  useEffect(() => {
    if (currentUser) {
      navigate('/', { replace: true });
    }
  }, [currentUser, navigate]);

  // Each wizard step is a fresh panel — scroll the form column back to the top
  // (the scroll container lives in AuthLayout's split-card shell).
  const stepRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scroller = stepRef.current?.closest('.auth-scroll') as HTMLElement | null;
    if (!scroller) return;
    // Element.scrollTo is missing in jsdom and some embedded webviews.
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      scroller.scrollTop = 0;
    }
  }, [wizardStep]);

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

  const validateCompanyStep = (): string | null => {
    if (companyName.trim().length < 2) return 'Company name must be at least 2 characters.';
    if (companyEmail.trim() && !EMAIL_PATTERN.test(companyEmail.trim())) {
      return 'Enter a valid company email address (or leave it blank).';
    }
    return null;
  };

  const validateAdminStep = (): string | null => {
    if (fullName.trim().length < 2) return 'Enter the administrator full name.';
    if (username.trim().length < 3) return 'Username must be at least 3 characters.';
    if (!EMAIL_PATTERN.test(adminEmail.trim())) return 'Enter a valid administrator email address.';
    if (password.length < 6) return 'Password must be at least 6 characters.';
    if (password !== confirmPassword) return "Passwords don't match.";
    if (!passwordValidation.valid) return passwordValidation.errors[0] || 'Password does not meet the required complexity.';
    return null;
  };

  const canContinueCompany = useMemo(
    () => companyName.trim().length >= 2 && (!companyEmail.trim() || EMAIL_PATTERN.test(companyEmail.trim())) && !submitting,
    [companyName, companyEmail, submitting],
  );

  const canContinueAdmin = useMemo(
    () =>
      fullName.trim().length >= 2 &&
      username.trim().length >= 3 &&
      adminEmail.trim().length > 0 &&
      password.length >= 6 &&
      confirmPassword.length > 0 &&
      !submitting,
    [fullName, username, adminEmail, password, confirmPassword, submitting],
  );

  const goToNextStep = () => {
    const err = wizardStep === 0 ? validateCompanyStep() : validateAdminStep();
    if (err) {
      setFieldError(err);
      return;
    }
    setFieldError(null);
    setError(null);
    setWizardStep((s) => (s === 0 ? 1 : 2) as 0 | 1 | 2);
  };

  const goToPrevStep = () => {
    setFieldError(null);
    setError(null);
    setWizardStep((s) => (s === 2 ? 1 : 0) as 0 | 1 | 2);
  };

  const validate = (): string | null => {
    return validateCompanyStep() ?? validateAdminStep();
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
    'w-full h-11 pl-10 pr-4 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all duration-200 hover:border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60';
  const plainInputClass =
    'w-full h-11 px-4 bg-white border border-slate-200 rounded-xl text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all duration-200 hover:border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60';
  const labelClass = 'block text-[12px] font-bold text-slate-700 uppercase tracking-wider mb-2';
  const sectionTitleClass = 'text-[11px] font-bold text-slate-500 uppercase tracking-[0.15em] mb-4 flex items-center gap-2';
  const primaryBtn = "w-full h-12 text-white text-[15px] font-bold rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]";
  const primaryBtnStyle = { background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', boxShadow: '0 10px 24px -10px rgba(29,78,216,0.55)' } as React.CSSProperties;
  const errorId = 'create-company-error';
  const fieldErrorId = 'create-company-field-error';

  return (
    <AuthLayout
      variant="split-card"
      wide
      title="Your business, in perfect sync."
      brandTagline="Smart. Simple. Business Operations."
      backLink={{ to: '/login', label: '← Back to sign in' }}
    >
      <div className="animate-slideUp" ref={stepRef}>
        <div className="mb-6">
          <h1 className="text-[30px] font-extrabold text-slate-900 tracking-tight leading-tight">
            Create new company
          </h1>
          <p className="mt-2 text-[13.5px] text-slate-500 leading-relaxed">
            {wizardStep === 0 && 'Step 1 of 3 — Tell us about your company.'}
            {wizardStep === 1 && 'Step 2 of 3 — Create your administrator account.'}
            {wizardStep === 2 && 'Step 3 of 3 — Review everything, then create your workspace.'}
          </p>
        </div>

        {/* ── Wizard stepper ── */}
        <ol className="mb-6 flex items-center gap-1.5" aria-label="Signup progress">
          {['Company', 'Admin', 'Review'].map((label, i) => {
            const done = i < wizardStep;
            const active = i === wizardStep;
            return (
              <li key={label} className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={() => { if (!submitting && i < wizardStep) setWizardStep(i as 0 | 1 | 2); }}
                  disabled={submitting || i >= wizardStep}
                  className={`w-full text-left rounded-xl px-2.5 py-2 border transition-all ${active ? 'bg-blue-50 border-blue-200' : done ? 'bg-slate-50 border-slate-200' : 'bg-white border-slate-200 opacity-70'} ${i < wizardStep ? 'cursor-pointer hover:border-blue-300' : 'cursor-default'}`}
                  aria-current={active ? 'step' : undefined}
                >
                  <span className="flex items-center gap-2">
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-extrabold shrink-0 ${done ? 'bg-emerald-500 text-white' : active ? 'text-white' : 'bg-slate-200 text-slate-500'}`} style={active ? { background: 'linear-gradient(135deg, #2563eb, #1d4ed8)' } : undefined}>
                      {done ? '✓' : i + 1}
                    </span>
                    <span className={`text-[12px] font-bold truncate ${active ? 'text-blue-700' : 'text-slate-500'}`}>{label}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {error && (
          <div role="alert" id={errorId} className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 animate-shake">
            <span className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
              <AlertCircle size={15} className="text-rose-500" />
            </span>
            <p className="text-[12.5px] text-rose-600/90 leading-relaxed pt-1.5">{error}</p>
          </div>
        )}

        {fieldError && (
          <div role="alert" id={fieldErrorId} className="mb-5 p-3.5 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5">
            <span className="w-8 h-8 rounded-lg bg-amber-100 flex items-center justify-center shrink-0">
              <AlertCircle size={15} className="text-amber-600" />
            </span>
            <p className="text-[12.5px] text-amber-700 leading-relaxed pt-1.5">{fieldError}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-7" noValidate aria-describedby={error ? errorId : undefined}>
          {wizardStep === 0 && (
          <section aria-label="Company details">
            <h2 className={sectionTitleClass}>
              <Building2 size={13} className="text-blue-600" />
              Company details
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="create-company-name" className={labelClass}>
                  Company name
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                    className={plainInputClass}
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
                  className={plainInputClass}
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
                    className={plainInputClass}
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
                    className={plainInputClass}
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
                    className={plainInputClass}
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
          )}

          {wizardStep === 1 && (
          <section aria-label="Administrator account">
            <h2 className={sectionTitleClass}>
              <UserRound size={13} className="text-blue-600" />
              Administrator account
            </h2>
            <div className="space-y-4">
              <div>
                <label htmlFor="create-company-fullname" className={labelClass}>
                  Full name
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                  Username
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                  Email Address
                </label>
                <div className="relative">
                  <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                    Password
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-9 h-9 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-all"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <div>
                  <label htmlFor="create-company-confirm-password" className={labelClass}>
                    Confirm Password
                  </label>
                  <div className="relative">
                    <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
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
                <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                  <AlertCircle size={12} />
                  {passwordValidation.errors[0] || 'Basic password strength'}
                </p>
              )}
            </div>
          </section>
          )}

          {wizardStep === 2 && (
          <section aria-label="Review details">
            <h2 className={sectionTitleClass}>
              <Building2 size={13} className="text-blue-600" />
              Review &amp; confirm
            </h2>
            <div className="rounded-2xl border border-slate-200 bg-slate-50/60 divide-y divide-slate-200 overflow-hidden">
              <div className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Company</p>
                  <p className="mt-1 text-[14px] font-bold text-slate-900 truncate">{companyName.trim() || '—'}</p>
                  <p className="mt-0.5 text-[12.5px] text-slate-500 truncate">
                    {[companyEmail.trim(), companyPhone.trim()].filter(Boolean).join(' · ') || 'No contact email/phone'}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-slate-500 truncate">
                    {[addressLine1.trim(), city.trim(), country.trim()].filter(Boolean).join(', ') || 'No address yet'} · {currencySymbol.trim() || 'K'}
                  </p>
                </div>
                <button type="button" onClick={() => setWizardStep(0)} disabled={submitting} className="text-[12px] font-bold text-blue-600 hover:text-blue-700 shrink-0 disabled:opacity-50">Edit</button>
              </div>
              <div className="p-4 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">Administrator</p>
                  <p className="mt-1 text-[14px] font-bold text-slate-900 truncate">{fullName.trim() || '—'}</p>
                  <p className="mt-0.5 text-[12.5px] text-slate-500 truncate">
                    {[`@${username.trim() || '—'}`, adminEmail.trim()].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <button type="button" onClick={() => setWizardStep(1)} disabled={submitting} className="text-[12px] font-bold text-blue-600 hover:text-blue-700 shrink-0 disabled:opacity-50">Edit</button>
              </div>
            </div>
            <p className="mt-3 text-[12px] text-slate-500 leading-relaxed">
              Creating your workspace provisions the company profile, administrator account and starter data.
            </p>
          </section>
          )}

          <div className="flex items-center gap-3">
            {wizardStep > 0 && (
              <button
                type="button"
                onClick={goToPrevStep}
                disabled={submitting}
                className="h-12 px-5 rounded-xl border border-slate-200 bg-white text-[14px] font-bold text-slate-600 hover:text-blue-600 hover:border-blue-300 transition-all disabled:opacity-50 shrink-0"
              >
                ← Back
              </button>
            )}
            {wizardStep < 2 ? (
              <button
                type="button"
                onClick={goToNextStep}
                disabled={wizardStep === 0 ? !canContinueCompany : !canContinueAdmin}
                className={`${primaryBtn} flex-1`}
                style={primaryBtnStyle}
              >
                <span>Continue →</span>
              </button>
            ) : (
              <button
                type="submit"
                disabled={!canSubmit}
                className={`${primaryBtn} flex-1`}
                style={primaryBtnStyle}
              >
                {submitting ? (
                  <>
                    <Loader2 size={17} className="animate-spin" />
                    <span>Creating company...</span>
                  </>
                ) : (
                  <span>Create Company &amp; Continue</span>
                )}
              </button>
            )}
          </div>
        </form>
      </div>
    </AuthLayout>
  );
};

export default CreateCompany;

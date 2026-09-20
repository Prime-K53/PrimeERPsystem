import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Mail, Loader2, AlertCircle, CheckCircle2, Key, Eye, EyeOff } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { useAuth } from '../../context/AuthContext';

const ForgotPassword: React.FC = () => {
  const { sendPasswordResetOtp, verifyResetOtp, updatePasswordAfterReset } = useAuth();
  const [step, setStep] = useState<'email' | 'otp' | 'password' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [otpCode, setOtpCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);

  useEffect(() => {
    if (resendCooldown > 0) {
      const t = setInterval(() => setResendCooldown(c => Math.max(0, c - 1)), 1000);
      return () => clearInterval(t);
    }
  }, [resendCooldown]);

  const handleSendOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendPasswordResetOtp(email.trim());
      if (result.success) {
        setStep('otp');
        setResendCooldown(60);
      } else {
        setError(result.error || 'Failed to send reset code.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send reset code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyOtp = async () => {
    if (otpCode.trim().length !== 6) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await verifyResetOtp(email.trim(), otpCode.trim());
      if (result.success) {
        setStep('password');
      } else {
        setError(result.error || 'Invalid or expired code.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (resendCooldown > 0) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await sendPasswordResetOtp(email.trim());
      if (result.success) {
        setResendCooldown(60);
      } else {
        setError(result.error || 'Failed to resend code.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await updatePasswordAfterReset(newPassword);
      if (result.success) {
        setStep('done');
      } else {
        setError(result.error || 'Failed to update password.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = "w-full h-12 pl-11 pr-4 bg-white border border-slate-200 rounded-xl text-[15px] sm:text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all duration-200 hover:border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60";
  const primaryBtn = "w-full h-12 text-white text-[15px] font-bold rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]";
  const primaryBtnStyle = { background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', boxShadow: '0 10px 24px -10px rgba(29,78,216,0.55)' } as React.CSSProperties;
  const labelClass = "block text-[12px] font-bold text-slate-700 uppercase tracking-wider mb-2";

  const stepMeta = {
    email: { title: 'Forgot Password?', desc: 'Enter your email address to receive a verification code.' },
    otp: { title: 'Enter Verification Code', desc: `Enter the 6-digit code sent to ${email || 'your email'}.` },
    password: { title: 'Create New Password', desc: 'Choose a strong password for your account.' },
    done: { title: 'Password Reset Complete', desc: 'Your password has been reset successfully.' },
  }[step];

  return (
    <AuthLayout
      variant="split-card"
      title="Your business, in perfect sync."
      brandTagline="Smart. Simple. Business Operations."
      backLink={{ to: '/login', label: '← Back to sign in' }}
    >
      <div className="animate-slideUp">
        <div className="mb-6 sm:mb-7">
          <h1 className="text-[30px] font-extrabold text-slate-900 tracking-tight leading-tight">{stepMeta.title}</h1>
          <p className="text-[13.5px] text-slate-500 mt-2 leading-relaxed">{stepMeta.desc}</p>
        </div>

      {error && (
        <div className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 animate-shake break-words">
          <span className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
            <AlertCircle size={15} className="text-rose-500" />
          </span>
          <p className="text-[12.5px] text-rose-600/90 leading-relaxed pt-1.5">{error}</p>
        </div>
      )}

      {step === 'email' && (
        <form onSubmit={handleSendOtp} className="space-y-5">
          <div>
            <label className={labelClass}>
              Email Address
            </label>
            <div className="relative">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Mail size={17} />
              </div>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={inputClass}
                placeholder="accounts@company.mw"
                autoComplete="email"
                autoFocus
                disabled={submitting}
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={!email.trim() || submitting}
            className={primaryBtn}
            style={primaryBtnStyle}
          >
            {submitting ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                <span>Sending...</span>
              </>
            ) : (
              <span>Send Reset Code</span>
            )}
          </button>
        </form>
      )}

      {step === 'otp' && (
        <div className="space-y-5">
          <div>
            <label className={labelClass}>
              Verification Code
            </label>
            <div className="relative">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Key size={17} />
              </div>
              <input
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${inputClass} tracking-[0.3em] font-mono text-center !text-[17px] font-bold`}
                inputMode="numeric"
                placeholder="000000"
                disabled={submitting}
                autoFocus
              />
            </div>
            <p className="text-[12px] text-slate-500 mt-2.5 text-center">Enter the 6-digit code sent to your email.</p>
          </div>

          <button
            type="button"
            onClick={handleVerifyOtp}
            disabled={otpCode.trim().length !== 6 || submitting}
            className={primaryBtn}
            style={primaryBtnStyle}
          >
            {submitting ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                <span>Verifying...</span>
              </>
            ) : (
              <span>Verify Code</span>
            )}
          </button>

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={handleResend}
              disabled={submitting || resendCooldown > 0}
              className="text-[12.5px] font-bold text-blue-600 hover:text-blue-700 transition-colors disabled:text-slate-400 disabled:cursor-not-allowed"
            >
              {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend Code'}
            </button>
            <button
              type="button"
              onClick={() => setStep('email')}
              className="text-[12.5px] font-bold text-slate-500 hover:text-blue-600 transition-colors"
            >
              ← Back
            </button>
          </div>
        </div>
      )}

      {step === 'password' && (
        <form onSubmit={handleUpdatePassword} className="space-y-5">
          <div>
            <label className={labelClass}>
              New Password
            </label>
            <div className="relative">
              <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                <Key size={17} />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className={`${inputClass} !pl-11 pr-12`}
                placeholder="Minimum 6 characters"
                autoComplete="new-password"
                autoFocus
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
            <label className={labelClass}>
              Confirm Password
            </label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full h-12 px-4 bg-white border border-slate-200 rounded-xl text-[15px] sm:text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all duration-200 hover:border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60"
              placeholder="Repeat new password"
              autoComplete="new-password"
              disabled={submitting}
              required
            />
          </div>

          <button
            type="submit"
            disabled={!newPassword || !confirmPassword || submitting}
            className={primaryBtn}
            style={primaryBtnStyle}
          >
            {submitting ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                <span>Updating...</span>
              </>
            ) : (
              <span>Update Password</span>
            )}
          </button>
        </form>
      )}

      {step === 'done' && (
        <div className="space-y-5">
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-white border border-emerald-200 mx-auto flex items-center justify-center mb-4 shadow-sm">
              <CheckCircle2 size={28} className="text-emerald-500" />
            </div>
            <p className="text-[13.5px] text-slate-600 leading-relaxed">
              Your password has been reset successfully. You can now sign in with your new password.
            </p>
          </div>
          <Link
            to="/login"
            className={`${primaryBtn} no-underline`}
            style={primaryBtnStyle}
          >
            Sign In
          </Link>
        </div>
      )}
      </div>
    </AuthLayout>
  );
};

export default ForgotPassword;

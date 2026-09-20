import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Lock, Loader2, AlertCircle, CheckCircle2, Key } from 'lucide-react';
import AuthLayout from './AuthLayout';
import { dbService } from '../../services/db';

const ResetPassword: React.FC = () => {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionReady, setSessionReady] = useState(true);

  useEffect(() => {
    setSessionReady(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const sessionUser = sessionStorage.getItem('nexus_user');
      if (!sessionUser) throw new Error('No active session.');
      const user = JSON.parse(sessionUser);
      const users = await dbService.getAll<any>('users');
      const updated = users.map((u: any) =>
        u.id === user.id ? { ...u, password } : u
      );
      await dbService.bulkPut('users', updated);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reset password.');
    } finally {
      setSubmitting(false);
    }
  };

  const inputClass = "w-full h-12 pl-11 pr-4 bg-white border border-slate-200 rounded-xl text-[15px] sm:text-sm text-slate-900 placeholder:text-slate-400 outline-none transition-all duration-200 hover:border-slate-300 focus:border-blue-500 focus:ring-4 focus:ring-blue-500/10 disabled:opacity-60";
  const primaryBtn = "w-full h-12 text-white text-[15px] font-bold rounded-xl flex items-center justify-center gap-2 transition-all duration-200 active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed hover:brightness-110 hover:shadow-[0_10px_28px_-8px_rgba(29,78,216,0.55)]";
  const primaryBtnStyle = { background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)', boxShadow: '0 10px 24px -10px rgba(29,78,216,0.55)' } as React.CSSProperties;
  const labelClass = "block text-[12px] font-bold text-slate-700 uppercase tracking-wider mb-2";

  return (
    <AuthLayout
      variant="split-card"
      title="Your business, in perfect sync."
      brandTagline="Smart. Simple. Business Operations."
      backLink={{ to: '/login', label: '← Back to sign in' }}
    >
      <div className="animate-slideUp">
        <div className="mb-6 sm:mb-7">
          <h1 className="text-[30px] font-extrabold text-slate-900 tracking-tight leading-tight">
            {success ? 'Password Reset Complete' : 'Set New Password'}
          </h1>
          <p className="text-[13.5px] text-slate-500 mt-2 leading-relaxed">
            {success
              ? 'Your password has been updated successfully.'
              : sessionReady
                ? 'Choose a strong password for your account.'
                : 'Verifying your reset link...'}
          </p>
        </div>

      {error && (
        <div className="mb-5 p-3.5 bg-rose-50 border border-rose-200 rounded-xl flex items-start gap-2.5 animate-shake">
          <span className="w-8 h-8 rounded-lg bg-rose-100 flex items-center justify-center shrink-0">
            <AlertCircle size={15} className="text-rose-500" />
          </span>
          <p className="text-[12.5px] text-rose-600/90 leading-relaxed pt-1.5">{error}</p>
        </div>
      )}

      {success ? (
        <div className="space-y-5">
          <div className="bg-emerald-50 border border-emerald-200 rounded-2xl p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-white border border-emerald-200 mx-auto flex items-center justify-center mb-4 shadow-sm">
              <CheckCircle2 size={28} className="text-emerald-500" />
            </div>
            <p className="text-[13.5px] text-slate-600 leading-relaxed">
              Your password has been reset. You can now sign in with your new password.
            </p>
          </div>
          <Link to="/login" className={`${primaryBtn} no-underline`} style={primaryBtnStyle}>
            <span>Sign In</span>
          </Link>
        </div>
      ) : !sessionReady ? (
        <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 text-center">
          <Loader2 size={24} className="animate-spin text-blue-500 mx-auto mb-3" />
          <p className="text-[13px] text-slate-500">Verifying your reset link...</p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              <Key size={15} className="text-blue-600" />
              <h3 className="text-[13px] font-bold text-slate-800">New Password</h3>
            </div>

            <div>
              <label className={labelClass}>
                New Password
              </label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                  <Lock size={17} />
                </div>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  placeholder="Minimum 6 characters"
                  autoComplete="new-password"
                  autoFocus
                  disabled={submitting}
                  required
                  minLength={6}
                />
              </div>
            </div>

            <div>
              <label className={labelClass}>
                Confirm Password
              </label>
              <div className="relative">
                <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400">
                  <Lock size={17} />
                </div>
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className={inputClass}
                  placeholder="Repeat new password"
                  autoComplete="new-password"
                  disabled={submitting}
                  required
                />
              </div>
            </div>
          </div>

          <button
            type="submit"
            disabled={!password || !confirmPassword || submitting}
            className={primaryBtn}
            style={primaryBtnStyle}
          >
            {submitting ? (
              <>
                <Loader2 size={17} className="animate-spin" />
                <span>Resetting...</span>
              </>
            ) : (
              <span>Reset Password</span>
            )}
          </button>
        </form>
      )}
      </div>
    </AuthLayout>
  );
};

export default ResetPassword;

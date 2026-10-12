import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { apiErrorMessage } from '../api/client.js';
import { canAccess } from '../utils/permissions.js';
import { allowedRolesForPath, LANDING_PATHS } from '../routes/access.js';
import FormField from '../components/FormField.jsx';
import useDocumentTitle from '../hooks/useDocumentTitle.js';

/**
 * Login — POST /api/auth/login/, store JWTs, then continue to the
 * originally requested route when the role may open it — otherwise to the
 * role's landing page (LANDING_PATHS). The `from` capture exists for deep
 * links (e.g. a logged-out user opening /sales/5), but a role-capped route
 * must not be honored: RequireAuth records `/dashboard` when a session dies
 * there, and a cashier signing in then would be bounced straight back into a
 * 403. Role gates decide the destination, not the previous URL.
 */
export default function LoginPage() {
  useDocumentTitle('Sign in');
  const { user, userLoading, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  // True once a submit starts. Suppresses the "already authenticated, bounce
  // to /" branch below: that branch is for visitors who land on /login while
  // signed in, and must not also fire in the middle of a fresh login — it
  // would race `navigate(next)` and hijack the role-aware destination.
  const [justLoggedIn, setJustLoggedIn] = useState(false);

  const from = (location.state && location.state.from && location.state.from.pathname) || '/';

  if (!justLoggedIn && !userLoading && user) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      setJustLoggedIn(true);
      const user = await login(username.trim(), password);
      const next =
        from === '/' || canAccess(allowedRolesForPath(from), user && user.role)
          ? from
          : LANDING_PATHS[user && user.role] || '/';
      navigate(next, { replace: true });
    } catch (err) {
      setError(apiErrorMessage(err, 'Sign in failed. Check your username and password.'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-surface lg:grid lg:grid-cols-2">
      {/* Brand panel */}
      <div className="relative hidden overflow-hidden bg-sidebar lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div
          className="pointer-events-none absolute -right-32 -top-32 size-96 rounded-full bg-brand-600/25 blur-3xl"
          aria-hidden="true"
        />
        <div
          className="pointer-events-none absolute -bottom-40 -left-24 size-[28rem] rounded-full bg-brand-800/40 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative flex items-center gap-3">
          <span className="flex size-11 items-center justify-center rounded-xl bg-brand-600 shadow-lg shadow-brand-900/40">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="size-6 text-white" fill="currentColor" aria-hidden="true">
              <path d="M18.4 4 8 18.2h6.1L12.25 28 24 13.4h-6.6L18.4 4z" />
            </svg>
          </span>
          <div>
            <p className="text-lg font-extrabold text-white">YourShop</p>
            <p className="text-xs font-medium text-sidebar-muted">Electric and kitchen appliances</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <h1 className="text-4xl font-extrabold leading-tight tracking-tight text-white">
            Run every branch from one counter.
          </h1>
          <p className="mt-4 text-base leading-relaxed text-sidebar-muted">
            Point-of-sale, FIFO stock, installment tracking, supplier purchase orders and
            financial reports — scoped to your business and your role.
          </p>
          <ul className="mt-8 space-y-3 text-sm font-semibold text-slate-200">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-300" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              FIFO cost lots with auditable profit per sale
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-300" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              Weekly and monthly installment plans collected at the counter
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-500/20 text-brand-300" aria-hidden="true">
                <svg xmlns="http://www.w3.org/2000/svg" className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </span>
              Branch-wise sales, P&amp;L, balance sheet and cash-flow forecasts
            </li>
          </ul>
        </div>

        <p className="relative text-xs text-sidebar-muted/80">
          Staff access only. Customers do not sign in here.
        </p>
      </div>

      {/* Form panel */}
      <div className="flex min-h-screen items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-600">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="size-5 text-white" fill="currentColor" aria-hidden="true">
                <path d="M18.4 4 8 18.2h6.1L12.25 28 24 13.4h-6.6L18.4 4z" />
              </svg>
            </span>
            <div>
              <p className="font-extrabold text-slate-900">YourShop</p>
              <p className="text-xs text-slate-500">Shop management</p>
            </div>
          </div>

          <div className="card p-6 sm:p-8">
            <h2 className="text-xl font-extrabold tracking-tight text-slate-900">Welcome back</h2>
            <p className="mt-1 text-sm text-slate-500">
              Sign in with the account your administrator created for you.
            </p>

            <form className="mt-6 space-y-4" onSubmit={handleSubmit} noValidate>
              {error ? (
                <div
                  className="rounded-control border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm font-medium text-rose-700"
                  role="alert"
                >
                  {error}
                </div>
              ) : null}

              <FormField label="Username" required>
                <input
                  className="input"
                  type="text"
                  name="username"
                  autoComplete="username"
                  required
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="e.g. amal.cashier"
                />
              </FormField>

              <FormField label="Password" required>
                <input
                  className="input"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="Your password"
                />
              </FormField>

              <button type="submit" className="btn-primary w-full" disabled={submitting}>
                {submitting ? 'Signing in...' : 'Sign in'}
              </button>
            </form>
          </div>

          <p className="mt-6 text-center text-xs text-slate-400">
            Multi-tenant appliance shop management — data stays isolated to your business.
          </p>
        </div>
      </div>
    </div>
  );
}

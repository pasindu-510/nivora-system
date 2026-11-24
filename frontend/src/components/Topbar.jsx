import { useAuth } from '../context/AuthContext.jsx';
import { useConnectionState } from '../hooks/useConnectionState.js';
import { roleLabel } from '../utils/permissions.js';
import { initials } from '../utils/format.js';

/**
 * Topbar — mobile menu trigger, connection indicator, user chip + logo above navigation.
 */
export default function Topbar({ onMenuClick }) {
  const { user, logout } = useAuth();
  const { status } = useConnectionState();

  const displayName = (user && (user.full_name || user.username)) || 'Signed in';
  const role = user && user.role;
  const businessName = user && user.business_name;
  // /api/auth/me/ carries the resolved media URL; fall back to the legacy
  // nested shape for wrapped payloads.
  const logoUrl =
    (user && user.business_logo) ||
    (user && user.business && user.business.logo ? `/media/${user.business.logo.name}` : null);

  async function handleLogout() {
    logout();
  }

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/85 backdrop-blur">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6 lg:px-8">
        <button
          type="button"
          className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 lg:hidden"
          onClick={onMenuClick}
          aria-label="Open menu"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
          </svg>
        </button>

        {/* Business logo above navigation panel - per business */}
        {businessName && logoUrl && (
          <div className="flex h-10 items-center justify-center sm:hidden">
            <img
              src={logoUrl}
              alt={businessName}
              className="h-6 w-auto max-w-full"
              style={{ maxHeight: '40px', objectFit: 'contain' }}
            />
          </div>
        )}

        <div className="hidden items-center gap-2 text-sm text-slate-500 sm:flex">
          {status === 'online' ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              <span className="size-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Online
            </span>
          ) : status === 'offline' ? (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-50 px-2.5 py-1 text-xs font-semibold text-rose-700">
              <span className="size-1.5 rounded-full bg-rose-500" aria-hidden="true" />
              Offline
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">
              <span className="size-1.5 rounded-full animate-pulse bg-slate-400" aria-hidden="true" />
              Checking…
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Compact connection dot on phones (the labelled pill is sm+) */}
          <span
            className={`size-2.5 rounded-full sm:hidden ${
              status === 'online' ? 'bg-emerald-500' : status === 'offline' ? 'bg-rose-500' : 'animate-pulse bg-slate-400'
            }`}
            role="status"
            aria-label={status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking connection'}
            title={status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking…'}
          />

          {/* Business logo in the top-right area (sm+; phones show it on the left) */}
          {businessName && logoUrl && (
            <img
              src={logoUrl}
              alt={businessName}
              className="mr-2 hidden h-6 w-auto align-middle sm:inline-block"
              style={{ maxHeight: '40px', objectFit: 'contain' }}
            />
          )}

          <div className="flex items-center gap-3 rounded-full border border-slate-200 bg-white py-1 pl-1 pr-4">
            <span className="flex size-8 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
              {initials(displayName)}
            </span>
            <div className="hidden text-left leading-tight sm:block">
              <p className="max-w-[10rem] truncate text-sm font-bold text-slate-800">{displayName}</p>
              <p className="text-[11px] font-medium text-slate-500">{roleLabel(role)}</p>
            </div>
          </div>

          <button type="button" className="btn-secondary" onClick={handleLogout} title="Sign out">
            <svg xmlns="http://www.w3.org/2000/svg" className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3 0l3-3m0 0l-3-3m3 3H9" />
            </svg>
            <span className="hidden sm:inline">Sign out</span>
          </button>
        </div>
      </div>
    </header>
  );
}

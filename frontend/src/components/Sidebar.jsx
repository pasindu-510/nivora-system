import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { filterMenu, roleLabel } from '../utils/permissions.js';
import { activeMenuPath, menuGroups } from '../routes/menu.js';
import Icon from './Icon.jsx';

/**
 * Sidebar — role-aware navigation (spec 7.2 menu filtering).
 * Off-canvas on small screens (tablets), fixed rail on lg+.
 */
export default function Sidebar({ open, onClose, role, businessName, businessLogo }) {
  const { user } = useAuth();
  const installmentsOn = user?.business_installments_enabled !== false;
  const groups = filterMenu(menuGroups, role).map((group) => ({
    ...group,
    items: group.items.filter((item) => installmentsOn || !item.needsInstallments),
  }));
  // Resolved once so nested routes highlight exactly one, most-specific item.
  const { pathname } = useLocation();
  const activePath = activeMenuPath(groups, pathname);

  return (
    <>
      {/* Mobile backdrop */}
      {open ? (
        <div
          className="fixed inset-0 z-40 bg-slate-950/50 backdrop-blur-[1px] lg:hidden"
          onClick={onClose}
          aria-hidden="true"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-sidebar text-white transition-transform duration-200 ease-out lg:translate-x-0 ${
          open ? 'translate-x-0 shadow-pop' : '-translate-x-full'
        }`}
        aria-label="Main navigation"
      >
        {/* Brand — the logged-in business's logo + name */}
        <div className="flex items-center gap-3 border-b border-white/10 px-5 py-5">
          {businessLogo ? (
            <img
              src={businessLogo}
              alt={businessName || 'Business logo'}
              className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white/10 object-contain p-1 shadow-md"
            />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-600 font-extrabold text-white shadow-md">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" className="size-6" fill="currentColor" aria-hidden="true">
                <path d="M18.4 4 8 18.2h6.1L12.8 28 24 13.4h-6.6L18.4 4z" />
              </svg>
            </span>
          )}
          <div className="min-w-0">
            <p className="truncate text-base font-extrabold tracking-tight">
              {businessName || 'YourShop'}
            </p>
            <p className="truncate text-xs text-sidebar-muted">
              Appliance shop management
            </p>
          </div>
          <button
            type="button"
            className="ml-auto rounded-lg p-1.5 text-sidebar-muted hover:bg-sidebar-hover hover:text-white lg:hidden"
            onClick={onClose}
            aria-label="Close menu"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-5 scrollbar-sidebar">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="px-3 text-[11px] font-bold uppercase tracking-[0.12em] text-sidebar-muted/70">
                {group.label}
              </p>
              <ul className="mt-2 space-y-1">
                {group.items.map((item) => {
                  const isActive = activePath === item.to;
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        onClick={onClose}
                        aria-current={isActive ? 'page' : undefined}
                        className={`group flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                          isActive
                            ? 'bg-brand-600 text-white shadow-sm'
                            : 'text-sidebar-muted hover:bg-sidebar-hover hover:text-white'
                        }`}
                      >
                        <Icon name={item.icon} className="size-5 shrink-0" />
                        <span className="truncate">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}

        </nav>

        {/* Role chip */}
        <div className="border-t border-white/10 px-5 py-4">
          <span className="badge bg-white/10 text-white">{roleLabel(role)}</span>
        </div>
      </aside>
    </>
  );
}

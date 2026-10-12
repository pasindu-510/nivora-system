import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';

/**
 * Authenticated app shell: role-aware sidebar + topbar + routed content.
 * Sidebar collapses into an off-canvas drawer below lg (tablet cashiers).
 */
export default function AppLayout() {
  const { user } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Flat /auth/me/ carries business_name/business_logo; legacy wrapped
  // payloads nest them under `business`.
  const businessName =
    (user && user.business_name) ||
    (user && user.business && user.business.name) ||
    null;
  const businessLogo =
    (user && user.business_logo) ||
    (user && user.business && user.business.logo
      ? `/media/${user.business.logo.name}`
      : null);

  return (
    <div className="min-h-screen bg-surface">
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        role={user && user.role}
        businessName={businessName}
        businessLogo={businessLogo}
      />

      <div className="lg:pl-72">
        <Topbar onMenuClick={() => setSidebarOpen(true)} />
        <main className="mx-auto w-full max-w-screen-2xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

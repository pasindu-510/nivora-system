import { useAuth } from '../context/AuthContext.jsx';
import { canAccess } from '../utils/permissions.js';
import ForbiddenPage from '../pages/ForbiddenPage.jsx';

/**
 * Authorization gate: renders a 403 page when the current role is outside
 * the route's allow-list. Used inside the authenticated layout so the
 * sidebar/topbar stay visible.
 */
export default function RoleGuard({ roles, children }) {
  const { user } = useAuth();

  if (!canAccess(roles, user && user.role)) {
    return <ForbiddenPage />;
  }

  return children;
}

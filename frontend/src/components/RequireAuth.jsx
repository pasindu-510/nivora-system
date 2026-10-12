import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import FullPageLoader from './FullPageLoader.jsx';

/**
 * Authentication gate (spec 7.2 role gating).
 * - resolving session -> full-page loader
 * - no session        -> redirect to /login (remembers origin)
 * - session           -> render children
 */
export default function RequireAuth({ children }) {
  const { user, userLoading } = useAuth();
  const location = useLocation();

  if (userLoading) {
    return <FullPageLoader label="Restoring your session" />;
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}

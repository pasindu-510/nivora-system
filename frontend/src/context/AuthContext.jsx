import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clearTokens, getAccessToken, setTokens } from '../api/client.js';
import { authApi } from '../api/endpoints.js';
import { qk } from '../api/queryKeys.js';

const AuthContext = createContext(null);

/** /api/auth/me/ may return the user directly or wrapped as { user, business, branch }. */
function unwrapUser(payload) {
  if (!payload) return null;
  if (payload.user && typeof payload.user === 'object') {
    return {
      ...payload.user,
      business: payload.business ?? payload.user.business ?? null,
      branch: payload.branch ?? payload.user.branch ?? null,
    };
  }
  return payload;
}

export function AuthProvider({ children }) {
  const queryClient = useQueryClient();
  const [hasToken, setHasToken] = useState(() => Boolean(getAccessToken()));

  const meQuery = useQuery({
    queryKey: qk.auth.me,
    queryFn: async () => {
      const response = await authApi.me();
      return unwrapUser(response.data);
    },
    enabled: hasToken,
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  // The API client fires this when refresh fails; sync context state so the
  // route guard can redirect to /login.
  useEffect(() => {
    const onForcedLogout = () => {
      setHasToken(false);
      queryClient.removeQueries({ queryKey: qk.auth.me });
    };
    window.addEventListener('auth:logout', onForcedLogout);
    return () => window.removeEventListener('auth:logout', onForcedLogout);
  }, [queryClient]);

  const login = useCallback(
    async (username, password) => {
      const response = await authApi.login(username, password);
      const { access, refresh } = response.data || {};
      if (!access) {
        throw new Error('Login response did not include an access token.');
      }
      // An expired session skips logout(), so drop anything cached for the
      // previous account (possibly another business) before using the new one.
      queryClient.clear();
      setTokens({ access, refresh });
      setHasToken(true);
      // Resolve the profile before returning so callers (e.g. the login page)
      // can decide the destination from the actual role. Shares the provider's
      // in-flight me query, so no second network call.
      const user = await queryClient.fetchQuery({
        queryKey: qk.auth.me,
        queryFn: async () => unwrapUser((await authApi.me()).data),
        retry: false,
      });
      return user;
    },
    [queryClient]
  );

  const logout = useCallback(() => {
    clearTokens();
    setHasToken(false);
    // Drop every cached query so the next user never sees stale data.
    queryClient.clear();
  }, [queryClient]);

  const refreshUser = useCallback(() => {
    return queryClient.invalidateQueries({ queryKey: qk.auth.me });
  }, [queryClient]);

  const value = useMemo(() => {
    const user = hasToken ? meQuery.data ?? null : null;
    // Only "initializing" when we hold a token but have not resolved /me yet.
    const initializing = hasToken && meQuery.isPending;
    return {
      user,
      userLoading: initializing,
      isAuthenticated: Boolean(user),
      login,
      logout,
      refreshUser,
    };
  }, [hasToken, meQuery.data, meQuery.isPending, login, logout, refreshUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used inside <AuthProvider>');
  }
  return context;
}

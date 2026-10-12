import axios from 'axios';

/**
 * Axios API client.
 *
 * - Base URL comes from `VITE_API_URL` (spec 2.2: https://api.yourshop.lk/api).
 * - Access/refresh JWTs are kept in localStorage (spec 7.2: acceptable for v1;
 *   httpOnly cookie can be adopted later without changing call sites).
 * - On 401 the client refreshes once via `POST /api/auth/refresh/` and retries
 *   the original request; concurrent 401s share a single refresh promise.
 * - If refresh fails, tokens are cleared and an `auth:logout` event fires so
 *   AuthContext can redirect to /login.
 */

export const API_BASE_URL = (import.meta.env.VITE_API_URL || 'https://api.yourshop.lk/api').replace(/\/+$/, '');

const ACCESS_TOKEN_KEY = 'yourshop.access';
const REFRESH_TOKEN_KEY = 'yourshop.refresh';

const hasStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export function getAccessToken() {
  return hasStorage() ? window.localStorage.getItem(ACCESS_TOKEN_KEY) : null;
}

export function getRefreshToken() {
  return hasStorage() ? window.localStorage.getItem(REFRESH_TOKEN_KEY) : null;
}

/** @param {{ access?: string|null, refresh?: string|null }} tokens */
export function setTokens({ access, refresh }) {
  if (!hasStorage()) return;
  if (access) window.localStorage.setItem(ACCESS_TOKEN_KEY, access);
  if (refresh) window.localStorage.setItem(REFRESH_TOKEN_KEY, refresh);
}

export function clearTokens() {
  if (!hasStorage()) return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

export function forceLogout() {
  clearTokens();
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('auth:logout'));
  }
}

export const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 20000,
});

// Attach bearer token to every outgoing request.
api.interceptors.request.use((config) => {
  const token = getAccessToken();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshPromise = null;

async function refreshAccessToken() {
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token');
  }
  // Plain axios (not `api`) so the refresh call never re-enters this flow.
  const response = await axios.post(`${API_BASE_URL}/auth/refresh/`, { refresh: refreshToken });
  const data = response.data || {};
  setTokens({ access: data.access, refresh: data.refresh || refreshToken });
  return data.access;
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    const status = error.response ? error.response.status : null;
    const url = (original && original.url) || '';
    const isAuthCall = /\/auth\/(login|refresh)\/?$/.test(url);

    if (status === 401 && original && !original._retry && !isAuthCall) {
      original._retry = true;
      try {
        if (!refreshPromise) {
          refreshPromise = refreshAccessToken().finally(() => {
            refreshPromise = null;
          });
        }
        const newAccess = await refreshPromise;
        original.headers = original.headers || {};
        original.headers.Authorization = `Bearer ${newAccess}`;
        return api(original);
      } catch (refreshError) {
        forceLogout();
        return Promise.reject(refreshError);
      }
    }

    return Promise.reject(error);
  }
);

/** Extract a human-readable error message from an API error response. */
export function apiErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  const data = error && error.response && error.response.data;
  if (!data) return error && error.message === 'Network Error' ? 'Cannot reach the server. Check your connection.' : fallback;
  if (typeof data === 'string') return data;
  if (data.detail) return data.detail;
  if (data.non_field_errors && data.non_field_errors.length) return data.non_field_errors.join(' ');
  const firstKey = Object.keys(data)[0];
  if (firstKey) {
    const value = data[firstKey];
    if (Array.isArray(value)) return `${firstKey}: ${value.join(' ')}`;
    if (typeof value === 'string') return `${firstKey}: ${value}`;
  }
  return fallback;
}

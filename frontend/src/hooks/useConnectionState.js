import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE_URL } from '../api/client.js';

/**
 * Connection state hook — the offline-detection foundation (spec offline-sync
 * Phase 0, `GET /api/health/` probe).
 *
 * Three layers, from fastest-but-weakest to authoritative:
 *
 * 1. `navigator.onLine` + `window` online/offline events — instant device-level
 *    signal, but it only proves the *machine* has a network interface, not
 *    that the host is reachable.
 * 2. Heartbeat fetch to `${API_BASE_URL}/health/` with a short timeout — the
 *    source of truth: only a 200 from the actual host means ONLINE.
 * 3. A small state machine (`checking | online | offline`) driven by boot
 *    probe + a steady 30s poll (paused while the tab is hidden) + the browser
 *    events above. A single slow/failed probe does not flip to offline — it
 *    takes two failures in a row (shared hosting can be slow; blueprint B-25). `checkNow()`
 *    re-probes immediately (used on `online` events and manual retry).
 *
 * The probe deliberately uses raw `fetch` — never the axios `api` instance —
 * so it carries no auth header and can never trip the 401-refresh/logout
 * interceptor. A health probe must be silent and side-effect-free.
 *
 * @param {{ intervalMs?: number, timeoutMs?: number }} [options]
 * @returns {{ status: 'checking'|'online'|'offline', isOnline: boolean,
 *   isOffline: boolean, lastCheckedAt: number|null, checkNow: () => Promise<void> }}
 */
export function useConnectionState({ intervalMs = 30000, timeoutMs = 8000, failuresBeforeOffline = 2 } = {}) {
  const [status, setStatus] = useState('checking');
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const probingRef = useRef(false);
  const failuresRef = useRef(0);

  const probe = useCallback(async () => {
    if (probingRef.current) return;

    // Layer 1 — device has no network interface at all: skip the request.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('offline');
      setLastCheckedAt(Date.now());
      return;
    }

    // Layer 2 — host reachability is the truth. AbortSignal.timeout guards
    // against a dead IP that hangs instead of refusing.
    probingRef.current = true;
    try {
      const response = await fetch(`${API_BASE_URL}/health/`, {
        signal: AbortSignal.timeout(timeoutMs),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`health ${response.status}`);
      failuresRef.current = 0;
      setStatus('online');
    } catch {
      failuresRef.current += 1;
      // Before the first success, one failure is enough to leave `checking`.
      setStatus((current) =>
        current === 'checking' || failuresRef.current >= failuresBeforeOffline ? 'offline' : current,
      );
    } finally {
      probingRef.current = false;
      setLastCheckedAt(Date.now());
    }
  }, [timeoutMs, failuresBeforeOffline]);

  useEffect(() => {
    // Boot check, then Layer 3 — steady-state heartbeat.
    probe();
    // Hidden tabs skip the heartbeat so many open tabs don't load the host.
    const interval = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      probe();
    }, intervalMs);
    const handleVisibility = () => {
      if (!document.hidden) probe();
    };
    document.addEventListener('visibilitychange', handleVisibility);

    // Browser events give instant transitions; on reconnect we re-probe
    // immediately instead of waiting for the next interval tick.
    const handleOnline = () => {
      probe();
    };
    const handleOffline = () => {
      failuresRef.current = failuresBeforeOffline;
      setStatus('offline');
      setLastCheckedAt(Date.now());
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibility);
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [probe, intervalMs, failuresBeforeOffline]);

  return {
    status,
    isOnline: status === 'online',
    isOffline: status === 'offline',
    lastCheckedAt,
    checkNow: probe,
  };
}

export default useConnectionState;
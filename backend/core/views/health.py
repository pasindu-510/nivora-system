"""Liveness endpoint for offline-mode detection.

``GET /api/health/`` is the probe the frontend heartbeat poll uses to decide
whether the host is reachable (online) or not (offline). It must be:

- **unauthenticated** — the cashier device may have no valid session when it
  boots (or the session may be expired), so the probe cannot require JWT;
- **DB-free** — a database outage should not masquerade as "host offline".
  The probe only proves the HTTP server answered, which is exactly the
  reachability question the connection state machine asks.
"""
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.views import APIView


class HealthView(APIView):
    """Public heartbeat: 200 {"status": "ok"} with no auth and no DB access."""

    permission_classes = (AllowAny,)

    def get(self, request):
        return Response({'status': 'ok'})
"""TenantMiddleware: resolve the current business (tenant) per request.

JWT tokens arrive in the Authorization header, so session authentication
has already run by the time this middleware executes. We authenticate the
Bearer token here and attach the user's business as ``request.tenant`` so
downstream code (viewsets, services) can rely on a single resolution point.
An invalid/expired token yields ``None`` here; DRF produces the proper 401
response during view dispatch.
"""
from rest_framework_simplejwt.authentication import JWTAuthentication
from rest_framework_simplejwt.exceptions import AuthenticationFailed


class TenantMiddleware:
    """Resolve the current business from the authenticated JWT user."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.tenant = self._resolve_business(request)
        return self.get_response(request)

    @staticmethod
    def _resolve_business(request):
        """Return the Business for the Bearer-token user, or None."""
        header = request.META.get('HTTP_AUTHORIZATION', '')
        if not header.lower().startswith('bearer '):
            return None
        try:
            user, _token = JWTAuthentication().authenticate(request)
        except AuthenticationFailed:
            return None
        if user is None:
            return None
        return user.business

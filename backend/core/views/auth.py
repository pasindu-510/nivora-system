"""Authentication endpoints (spec section 6.1).

- ``POST /api/auth/login/`` — JWT access + refresh via username/password.
- ``POST /api/auth/refresh/`` — refresh access token.
- ``GET  /api/auth/me/`` — current user profile (with business info).
"""
from rest_framework import status
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import RefreshToken
from rest_framework_simplejwt.views import TokenRefreshView

from .auth_serializers import LoginRequestSerializer
from ..serializers import UserSerializer


class LoginView(APIView):
    """Exchange credentials for JWT tokens (spec 6.1)."""

    permission_classes = (AllowAny,)

    def post(self, request):
        ser = LoginRequestSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        user = ser.validated_data['user']
        refresh = RefreshToken.for_user(user)
        return Response(
            {
                'access': str(refresh.access_token),
                'refresh': str(refresh),
                'user': UserSerializer(user).data,
            },
            status=status.HTTP_200_OK,
        )


class RefreshView(TokenRefreshView):
    """Refresh the access token using a valid refresh token."""


class MeView(APIView):
    """Current user profile (spec 6.1)."""

    permission_classes = (IsAuthenticated,)

    def get(self, request):
        return Response(UserSerializer(request.user).data)
"""Login request serialization (local, avoids circular imports)."""
from django.contrib.auth import authenticate
from rest_framework import serializers


class LoginRequestSerializer(serializers.Serializer):
    """Validate username/password and return the authenticated user."""

    username = serializers.CharField()
    password = serializers.CharField(write_only=True, trim_whitespace=False)

    def validate(self, attrs):
        user = authenticate(
            username=attrs['username'], password=attrs['password']
        )
        if user is None or not user.is_active:
            raise serializers.ValidationError(
                'Invalid credentials or inactive account.',
                code='authentication',
            )
        attrs['user'] = user
        return attrs
"""Tenant-scoped viewset base and queryset helpers (spec section 3.1).

``TenantModelViewSet`` scopes every queryset to the current user's
business and auto-assigns ``business`` on create. Super admins have no
business, so tenant endpoints return an empty set for them (their
management surface is Django Admin).
"""
from django.db.models import ProtectedError
from rest_framework import status
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from rest_framework.viewsets import ModelViewSet

from .models import RoleConstants


class TenantModelViewSet(ModelViewSet):
    """Base viewset: business-scoped queries and automatic business create."""

    #: 400 message when a delete hits on_delete=PROTECT (override per view).
    protected_delete_message = (
        'This record is still used by other records and cannot be deleted. '
        'Deactivate it instead.'
    )

    def get_tenant(self):
        """Return the business for this request, or None."""
        user = self.request.user
        if user and user.is_authenticated and user.role in RoleConstants.BUSINESS_ROLES:
            return user.business
        return None

    def get_queryset(self):
        """Only rows belonging to the current user's business."""
        return self.queryset.for_business(self.get_tenant())

    def perform_create(self, serializer):
        """Auto-assign the current business on create."""
        tenant = self.get_tenant()
        if tenant is None:
            raise PermissionDenied('No business scope for this request.')
        serializer.save(business=tenant)

    def destroy(self, request, *args, **kwargs):
        """A row still referenced by others (on_delete=PROTECT) answers 400
        with a readable message instead of a 500 (see protected_delete_message)."""
        try:
            return super().destroy(request, *args, **kwargs)
        except ProtectedError:
            return Response(
                {'detail': self.protected_delete_message},
                status=status.HTTP_400_BAD_REQUEST,
            )

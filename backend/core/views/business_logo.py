"""Business logo upload endpoint (business_admin only).

POST /api/business/logo/
  Accepts multipart/form-data with a field named ``logo`` containing an image file.
  The file is stored under ``media/business_logos/`` and assigned to the caller's
  ``Business.logo`` (replacing any previous file). The response returns the
  relative storage path (``filename``) and the public URL (``url``).

GET /api/business/logo/
  Returns ``{ url, filename }`` for the current logo, or ``{ none: true }``
  when the business has no logo yet.

Security:
  - Only ``IsBusinessAdminOrReadOnly`` backs the view; POST/PUT/PATCH/DELETE
    require role ``business_admin`` (the caller's own business is used), while
    GET is open to any authenticated user.
"""

import os
import uuid

from rest_framework import status
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.views import APIView

from django.conf import settings
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

from ..models import RoleConstants

# Accepted image content types; anything else is rejected with a 400.
ALLOWED_CONTENT_TYPES = {'image/jpeg', 'image/png', 'image/gif', 'image/webp'}


def _store_logo(uploaded_file):
    """Validate and store the uploaded image under MEDIA_ROOT/business_logos/.

    Returns the relative storage path (e.g. ``business_logos/abc_xyz.jpg``) that
    can be assigned straight to ``Business.logo``. Raises ValueError when the
    content type is not an allowed image.
    """
    if uploaded_file.content_type not in ALLOWED_CONTENT_TYPES:
        raise ValueError('Only JPEG, PNG, GIF and WebP images are allowed.')

    ext = os.path.splitext(uploaded_file.name)[1] or '.jpg'
    safe_name = f"{uuid.uuid4().hex[:12]}{ext}"
    return default_storage.save(
        os.path.join('business_logos', safe_name),
        ContentFile(uploaded_file.read()),
    )


def _logo_url(filename):
    """Absolute-ish media URL for a stored filename (e.g. ``/media/...``)."""
    return f"{settings.MEDIA_URL.rstrip('/')}/{filename}"


class IsBusinessAdminOrReadOnly(BasePermission):
    """Allow write only for business admins; GET for any authenticated user."""

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated and user.is_active):
            return False
        if request.method in ('POST', 'PUT', 'PATCH', 'DELETE'):
            return user.role == RoleConstants.BUSINESS_ADMIN
        return True


class BusinessLogoView(APIView):
    """Handle business logo uploads via POST /api/business/logo/."""

    permission_classes = [IsBusinessAdminOrReadOnly]

    def post(self, request, *args, **kwargs):
        """Upload and persist a new business logo.

        Expected payload: multipart/form-data with a field named ``logo``.
        """
        uploaded_file = request.FILES.get('logo')
        if not uploaded_file:
            return Response(
                {'detail': 'No logo file provided.'},
                status=status.HTTP_400_BAD_REQUEST,
            )

        try:
            stored_path = _store_logo(uploaded_file)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        business = request.user.business
        old_name = business.logo.name if business.logo else None
        business.logo.name = stored_path
        business.save(update_fields=['logo', 'updated_at'])

        # Drop the superseded file so uploads do not accumulate on disk.
        if old_name and old_name != stored_path:
            default_storage.delete(old_name)

        return Response(
            {'filename': stored_path, 'url': _logo_url(stored_path)},
            status=status.HTTP_201_CREATED,
        )

    def get(self, request, *args, **kwargs):
        """Return the current business logo URL, if any.

        Returns ``{ url, filename }`` or ``{ none: true }`` when unset.
        """
        business = getattr(request.user, 'business', None)
        if not business or not business.logo:
            return Response({'none': True}, status=status.HTTP_200_OK)

        return Response(
            {'url': _logo_url(business.logo.name), 'filename': business.logo.name},
            status=status.HTTP_200_OK,
        )
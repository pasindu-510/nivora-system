"""Business logo upload endpoint (business_admin only).

POST /api/business/logo/
  Accepts multipart/form-data with a field named ``logo`` containing an image file.
  The file is stored under ``media/business_logos/`` and assigned to the caller's
  ``Business.logo`` (replacing any previous file). The response returns the
  relative storage path (``filename``) and the public URL (``url``).

DELETE /api/business/logo/
  Removes the current logo (204).

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
from io import BytesIO

from PIL import Image

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
# Pillow format name -> extension we write to disk (never the client's).
FORMAT_EXTENSIONS = {'JPEG': '.jpg', 'PNG': '.png', 'GIF': '.gif', 'WEBP': '.webp'}
MAX_LOGO_BYTES = 2 * 1024 * 1024


def _store_logo(uploaded_file):
    """Validate and store the uploaded image under MEDIA_ROOT/business_logos/.

    Returns the relative storage path (e.g. ``business_logos/abc_xyz.png``) that
    can be assigned straight to ``Business.logo``. Raises ValueError when the
    file is not a real JPEG/PNG/GIF/WebP image.

    Security: the client-supplied content type and filename are NOT trusted.
    The bytes are decoded with Pillow and the stored extension is derived from
    the detected image format, so a file such as ``shell.php`` sent as
    ``image/png`` can never be written with an executable extension into the
    web-served media directory.
    """
    if uploaded_file.content_type not in ALLOWED_CONTENT_TYPES:
        raise ValueError('Only JPEG, PNG, GIF and WebP images are allowed.')
    if uploaded_file.size and uploaded_file.size > MAX_LOGO_BYTES:
        raise ValueError('Logo must be 2 MB or smaller.')

    data = uploaded_file.read()
    try:
        with Image.open(BytesIO(data)) as img:
            detected = img.format
            img.verify()
    except Exception:
        raise ValueError('Only JPEG, PNG, GIF and WebP images are allowed.')
    ext = FORMAT_EXTENSIONS.get(detected)
    if ext is None:
        raise ValueError('Only JPEG, PNG, GIF and WebP images are allowed.')

    safe_name = f"{uuid.uuid4().hex[:12]}{ext}"
    return default_storage.save(
        os.path.join('business_logos', safe_name),
        ContentFile(data),
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

    def delete(self, request, *args, **kwargs):
        """Remove the current logo and its file. Safe to call when none is set."""
        business = request.user.business
        if business.logo:
            old_name = business.logo.name
            business.logo = None
            business.save(update_fields=['logo', 'updated_at'])
            default_storage.delete(old_name)
        return Response(status=status.HTTP_204_NO_CONTENT)

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
"""Private file storage for sensitive uploads (customer ID-card photos).

Files live under settings.PRIVATE_MEDIA_ROOT, outside the public web root, and
have no public URL. The API serves them through a signed, expiring link
(see CustomerViewSet.id_card_photo and blueprint B-24).
"""
import os

from django.conf import settings
from django.core import signing
from django.core.files.storage import FileSystemStorage

SIGNING_SALT = 'customer-id-card-photo'


class PrivateMediaStorage(FileSystemStorage):
    """FileSystemStorage rooted at PRIVATE_MEDIA_ROOT, read on every access
    (so override_settings in tests and env changes take effect)."""

    def __init__(self):
        super().__init__(base_url=None)

    @property
    def base_location(self):
        return str(settings.PRIVATE_MEDIA_ROOT)

    @property
    def location(self):
        return os.path.abspath(self.base_location)

    def url(self, name):  # pragma: no cover - deliberately unsupported
        raise ValueError('Private files have no public URL; use a signed API link.')


_private_storage = PrivateMediaStorage()


def private_storage():
    """Callable used as `storage=` on model fields (keeps migrations stable)."""
    return _private_storage


def sign_customer_photo(customer):
    """Token binding a customer id to its current photo file name."""
    return signing.TimestampSigner(salt=SIGNING_SALT).sign(
        f'{customer.pk}:{customer.id_card_photo.name}'
    )


def check_customer_photo_token(customer, token):
    """True when `token` was issued for this customer's current photo and is
    not older than PRIVATE_MEDIA_URL_MAX_AGE."""
    try:
        value = signing.TimestampSigner(salt=SIGNING_SALT).unsign(
            token, max_age=settings.PRIVATE_MEDIA_URL_MAX_AGE
        )
    except signing.BadSignature:
        return False
    return value == f'{customer.pk}:{customer.id_card_photo.name}'

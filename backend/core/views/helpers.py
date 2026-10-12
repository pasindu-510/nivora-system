"""Shared helpers for viewsets."""


class TenantlessViewSetMixin:
    """Adjust ``get_queryset`` to accept business-scoping attempts.

    ``TenantModelViewSet.get_queryset`` expects a ``for_business`` manager;
    branches also live under a business, so this mixin simply keeps the
    default behaviour but lets the base class delegate to
    ``Branch.objects.for_business(...)``.  Branch already inherits
    ``BusinessModel`` which provides ``for_business``.
    """
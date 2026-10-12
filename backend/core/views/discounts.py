"""Seasonal discount endpoints (spec 6.10, manager+)."""
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import filters

from ..models import SeasonalDiscount
from ..permissions import IsManagerOrAbove
from ..serializers import SeasonalDiscountSerializer
from ..viewsets import TenantModelViewSet


class SeasonalDiscountViewSet(TenantModelViewSet):
    """Business-scoped seasonal discount CRUD (manager+)."""

    queryset = SeasonalDiscount.objects.select_related('business').all()
    serializer_class = SeasonalDiscountSerializer
    permission_classes = [IsManagerOrAbove]
    filter_backends = [DjangoFilterBackend, filters.OrderingFilter]
    filterset_fields = ['scope', 'is_active', 'start_date', 'end_date']
    ordering_fields = ['start_date', 'end_date']